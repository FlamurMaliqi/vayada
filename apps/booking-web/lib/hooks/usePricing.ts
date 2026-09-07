"use client";

import { useEffect, useMemo, useState } from "react";
import { useAddons, useHotel, useRooms, useSlug } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { calculateNights } from "@/lib/utils";
import {
  calculatePromoDiscount,
  getFlexibleNightlyRates,
  getNonRefundableNightlyRates,
  groupNightlyRates,
  hasVariableNightlyRates,
} from "@/lib/constants/booking";
import { resolveCheckoutRoom } from "@/lib/roomSelection";
import { useRoomSelectionQuote } from "./useRoomSelectionQuote";
import { hotelService } from "@/services/api/hotel";

export interface PromoDiscount {
  type: string;
  /** The raw discount value as returned by the backend (in hotel currency for fixed, percent for percentage). */
  value: number;
  /** The discount applied to the current subtotal, already in the displayed currency. */
  amount: number;
}

export interface PricingInputs {
  roomId: string;
  checkIn: string;
  checkOut: string;
  rateType: string;
  roomsParam: number;
  adults: number;
  children: number;
  selectedAddonIds: string[];
  addonQuantities: Record<string, number>;
  addonPackageQuantities?: Record<string, number>;
  /** ISO dates per addon for perNight charges. Empty/missing → all stay dates. */
  addonDates?: Record<string, string[]>;
  promoCode: string;
}

// Cache promo lookups across pages so navigating book → payment doesn't re-hit
// the backend with the same code (and ensures both pages agree on the result).
const promoCache = new Map<
  string,
  Promise<{
    valid: boolean;
    discountType?: string;
    discountValue?: number;
    currency?: string;
    message?: string;
  }>
>();

function fetchPromo(
  slug: string,
  code: string,
  context: { checkIn: string; roomTypeId: string; bookingTotal: number },
) {
  const key = `${slug}:${code}:${context.checkIn}:${context.roomTypeId}:${context.bookingTotal}`;
  let p = promoCache.get(key);
  if (!p) {
    p = hotelService
      .validatePromoCode(slug, code, context)
      .catch(() => ({ valid: false, message: "Promo code validation is unavailable." }));
    promoCache.set(key, p);
  }
  return p;
}

export function usePricing({
  roomId,
  checkIn,
  checkOut,
  rateType,
  roomsParam,
  adults,
  children,
  selectedAddonIds,
  addonQuantities,
  addonPackageQuantities = {},
  addonDates,
  promoCode,
}: PricingInputs) {
  const { hotel } = useHotel();
  const { rooms } = useRooms();
  const { addons } = useAddons();
  const { slug } = useSlug();
  const { convertAndRound } = useCurrency();

  const [, expireSelection] = useState(0);
  const selectedExpiry = rooms.find((candidate) => candidate.id === roomId)?.combination?.expiresAt;
  useEffect(() => {
    if (!selectedExpiry) return;
    const timer = setTimeout(
      () => expireSelection((value) => value + 1),
      Math.max(0, Math.min(2_147_483_647, Date.parse(selectedExpiry) - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [selectedExpiry]);
  const room = resolveCheckoutRoom(rooms, roomId, {
    checkIn,
    checkOut,
    adults,
    children,
    rooms: roomsParam,
  });
  const selectionPricing = useRoomSelectionQuote(
    slug,
    room?.combination
      ? {
          roomSelection: room.combination.roomSelection,
          roomTypeId: room.combination.roomSelection.lines[0].roomTypeId,
          guestFirstName: "",
          guestLastName: "",
          guestEmail: "",
          guestPhone: "",
          checkIn,
          checkOut,
          adults,
          children,
          numberOfRooms: roomsParam,
          paymentMethod: room.ratePaymentMethods?.flexible?.[0],
          addonIds: selectedAddonIds,
          addonQuantities,
          addonPackageQuantities,
          addonDates,
          promoCode: promoCode || undefined,
        }
      : null,
  );

  const nights = calculateNights(checkIn, checkOut);
  const roomCurrency = room?.currency || hotel?.currency || "EUR";
  const hasMismatchedNightlyRates =
    Array.isArray(room?.nightlyRates) && room.nightlyRates.length !== nights;
  const quoteReady = Boolean(
    room && checkIn && checkOut && nights > 0 && !hasMismatchedNightlyRates,
  );

  const nightlyRatesBase =
    rateType === "nonrefundable"
      ? getNonRefundableNightlyRates(room, nights)
      : getFlexibleNightlyRates(room, nights);
  // Each nightly line is rounded in the displayed currency before summing so
  // the itemized rows and totals stay arithmetically consistent.
  const nightlyRates = nightlyRatesBase.map((rate) => convertAndRound(rate, roomCurrency));
  const nightlyRate =
    nightlyRates.length > 0
      ? Math.round(
          (nightlyRates.reduce((sum, rate) => sum + rate, 0) / nightlyRates.length) * 100,
        ) / 100
      : 0;
  const roomTotal = nightlyRates.reduce((sum, rate) => sum + rate, 0) * roomsParam;
  const rateLineItems = groupNightlyRates(nightlyRates);
  const variableNightlyRates = hasVariableNightlyRates(nightlyRates);

  // Sum addon line totals in the displayed currency. Each line is rounded
  // first so its shown price matches its contribution.
  // price = unit × people × days × items, mirroring the backend in
  // pms-backend/app/services/booking_service._compute_addon_total.
  const selectedKey = selectedAddonIds.join(",");
  const quantitiesKey = JSON.stringify([addonQuantities, addonPackageQuantities]);
  const datesKey = JSON.stringify(addonDates ?? {});
  const addonTotals = useMemo(() => {
    let displayTotal = 0;
    let propertyTotal = 0;
    for (const addon of addons) {
      if (!selectedAddonIds.includes(addon.id)) continue;
      const count = addonQuantities[addon.id];
      const dates = addonDates?.[addon.id];
      const people = addon.perPerson
        ? Math.max(1, Math.min(count ?? Math.max(1, adults), Math.max(1, adults)))
        : 1;
      const days = addon.perNight
        ? Math.max(
            1,
            Math.min(dates?.length ?? (addon.perPerson ? nights : (count ?? nights)), nights),
          )
        : 1;
      const items = !addon.perPerson && !addon.perNight ? Math.max(1, count ?? 1) : 1;
      const lineTotal =
        addon.price * people * days * items * (addonPackageQuantities[addon.id] ?? 1);
      propertyTotal += lineTotal;
      displayTotal += convertAndRound(lineTotal, roomCurrency);
    }
    return { displayTotal, propertyTotal };
    // selectedKey/quantitiesKey/datesKey are stable identity proxies for the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addons, selectedKey, quantitiesKey, datesKey, nights, adults, convertAndRound]);
  const addonTotal = addonTotals.displayTotal;
  const propertyBookingTotal =
    nightlyRatesBase.reduce((sum, rate) => sum + rate, 0) * roomsParam + addonTotals.propertyTotal;

  const [promoDiscount, setPromoDiscount] = useState<PromoDiscount | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  useEffect(() => {
    if (!promoCode || !slug || !room || room.combination) {
      setPromoDiscount(null);
      setPromoError(null);
      return;
    }
    let cancelled = false;
    const subtotal = roomTotal + addonTotal;
    fetchPromo(slug, promoCode, {
      checkIn,
      roomTypeId: roomId,
      bookingTotal: propertyBookingTotal,
    }).then((res) => {
      if (cancelled) return;
      if (!res.valid || !res.discountType || res.discountValue == null) {
        setPromoDiscount(null);
        setPromoError(res.message ?? "Invalid promo code.");
        return;
      }
      setPromoError(null);
      // Fixed-amount promos are stored in the hotel's base currency; convert to
      // the displayed currency so the discount matches the shown subtotal.
      const value =
        res.discountType === "fixed"
          ? convertAndRound(res.discountValue, res.currency ?? roomCurrency)
          : res.discountValue;
      const amount = calculatePromoDiscount(subtotal, res.discountType, value);
      setPromoDiscount({ type: res.discountType, value: res.discountValue, amount });
    });
    return () => {
      cancelled = true;
    };
  }, [
    promoCode,
    slug,
    roomTotal,
    addonTotal,
    propertyBookingTotal,
    roomCurrency,
    convertAndRound,
    checkIn,
    roomId,
    room?.combination,
  ]);

  const automatic = rateType === "nonrefundable" ? room?.nonRefundablePromotion : room?.promotion;
  const automaticAmount = automatic
    ? convertAndRound(automatic.discountAmount * roomsParam, roomCurrency)
    : 0;
  const promotion =
    automatic && automaticAmount > (promoDiscount?.amount ?? 0)
      ? { ...automatic, discountAmount: automaticAmount }
      : null;
  const winningCode = promotion ? null : promoDiscount;
  const discountAmount = winningCode?.amount ?? 0;
  const grandTotal = roomTotal + addonTotal - discountAmount - (promotion?.discountAmount ?? 0);

  const authoritative = selectionPricing?.quote;
  const combinedTotal = authoritative
    ? convertAndRound(authoritative.totalAmount, authoritative.currency)
    : 0;
  const combinedAddon = authoritative
    ? convertAndRound(authoritative.addonTotal, authoritative.currency)
    : 0;
  const combinedDiscount = authoritative
    ? convertAndRound(authoritative.promoDiscount, authoritative.currency)
    : 0;
  const combinedPromotion = authoritative
    ? convertAndRound(authoritative.promotionDiscount ?? 0, authoritative.currency)
    : 0;
  const pricing = {
    room,
    nights,
    roomCurrency,
    quoteReady,
    nightlyRates,
    nightlyRate,
    rateLineItems,
    variableNightlyRates,
    roomTotal,
    addonTotal,
    promoDiscount: winningCode,
    promotion,
    promoError,
    discountAmount,
    grandTotal,
  };
  return room?.combination
    ? {
        ...pricing,
        quoteReady:
          quoteReady &&
          Boolean(authoritative && Date.parse(authoritative.expiresAt ?? "") > Date.now()),
        roomTotal: combinedTotal - combinedAddon + combinedDiscount + combinedPromotion,
        addonTotal: combinedAddon,
        grandTotal: combinedTotal,
        discountAmount: combinedDiscount,
        promoDiscount: combinedDiscount
          ? { type: "fixed", value: combinedDiscount, amount: combinedDiscount }
          : null,
        promotion: authoritative?.promotion
          ? { ...authoritative.promotion, discountAmount: combinedPromotion }
          : null,
        promoError: selectionPricing?.error ?? null,
        nightlyRate:
          (combinedTotal - combinedAddon + combinedDiscount + combinedPromotion) /
          Math.max(1, nights * roomsParam),
        variableNightlyRates: false,
        rateLineItems: [],
        selectedRoomLines: authoritative?.roomLines ?? room.combination.roomLines,
      }
    : { ...pricing, selectedRoomLines: undefined };
}
