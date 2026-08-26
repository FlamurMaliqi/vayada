"use client";

import { useCallback, useEffect, useState } from "react";
import PromoCodesTab, {
  type PromoCodeFormValues,
  type PromoRoomType,
} from "@/components/booking-flow/PromoCodesTab";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { getBookingLocalizationSettings } from "@/services/api/bookingLocalizationSettingsClient";
import {
  createBookingPromoCode,
  deleteBookingPromoCode,
  listBookingPromoCodes,
  updateBookingPromoCode,
  type BookingPromoCode,
  type CreateBookingPromoCodeBody,
} from "@/services/api/bookingPromoCodesClient";
import { apiClient } from "@/services/api/client";
import { settingsService } from "@/services/settings";

type RoomTypesResponse = {
  items: PromoRoomType[];
};

function toPromoCodeBody(values: PromoCodeFormValues): CreateBookingPromoCodeBody {
  return {
    code: values.code,
    discountType: values.discountType,
    discountValue: values.discountValue,
    minBookingValue: values.minBookingValue || null,
    applicableRoomIds: values.applicableRoomIds.length ? values.applicableRoomIds : null,
    validFrom: values.validFrom || null,
    validUntil: values.validUntil || null,
    stayDateFrom: values.stayDateFrom || null,
    stayDateUntil: values.stayDateUntil || null,
    isActive: values.isActive,
    maxUses: Number(values.maxUses),
  };
}

export default function PromoCodesPage() {
  const [hotelId, setHotelId] = useState<string | null>(null);
  const [promoCodes, setPromoCodes] = useState<BookingPromoCode[]>([]);
  const [roomTypes, setRoomTypes] = useState<PromoRoomType[]>([]);
  const [propertyCurrency, setPropertyCurrency] = useState("EUR");
  const [propertyTimeZone, setPropertyTimeZone] = useState("Etc/UTC");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const selectedHotelId = getSelectedBookingHotelId();
    if (!selectedHotelId) {
      setError("Select a property before managing promo codes.");
      setLoading(false);
      return;
    }
    setHotelId(selectedHotelId);
    setLoading(true);
    setError(null);
    try {
      const [promos, localization, propertyLink, propertySettings] = await Promise.all([
        listBookingPromoCodes({ hotelId: selectedHotelId }),
        getBookingLocalizationSettings({ hotelId: selectedHotelId }),
        getBookingHotelPropertyLink({ hotelId: selectedHotelId }),
        settingsService.getPropertySettings(selectedHotelId),
      ]);
      const roomTypeResponse = await apiClient.get<RoomTypesResponse>(
        `/api/pms/properties/${encodeURIComponent(propertyLink.propertyId)}/room-types`,
      );
      setPromoCodes(promos);
      setPropertyCurrency(localization.defaultCurrency);
      setPropertyTimeZone(propertySettings.time_zone || "Etc/UTC");
      setRoomTypes(roomTypeResponse.items.filter((room) => room.roomTypeId && room.name));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Promo codes are unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const requireHotelId = () => {
    if (!hotelId) throw new Error("Select a property before managing promo codes.");
    return hotelId;
  };

  const createPromo = async (values: PromoCodeFormValues) => {
    const promo = await createBookingPromoCode({
      hotelId: requireHotelId(),
      body: toPromoCodeBody(values),
    });
    setPromoCodes((current) => [...current, promo]);
  };

  const updatePromo = async (promoCodeId: string, values: PromoCodeFormValues) => {
    const promo = await updateBookingPromoCode({
      hotelId: requireHotelId(),
      promoCodeId,
      body: toPromoCodeBody(values),
    });
    setPromoCodes((current) =>
      current.map((item) => (item.promoCodeId === promoCodeId ? promo : item)),
    );
  };

  const deletePromo = async (promoCodeId: string) => {
    await deleteBookingPromoCode({ hotelId: requireHotelId(), promoCodeId });
    setPromoCodes((current) => current.filter((item) => item.promoCodeId !== promoCodeId));
  };

  const togglePromo = async (promo: BookingPromoCode) => {
    const updated = await updateBookingPromoCode({
      hotelId: requireHotelId(),
      promoCodeId: promo.promoCodeId,
      body: { isActive: !promo.isActive },
    });
    setPromoCodes((current) =>
      current.map((item) => (item.promoCodeId === promo.promoCodeId ? updated : item)),
    );
  };

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center p-8">
        <div
          aria-label="Loading promo codes"
          className="h-7 w-7 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900"
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-7xl p-6 lg:p-8">
        <div className="rounded-xl border border-red-200 bg-white p-6">
          <h1 className="text-lg font-semibold text-gray-950">Promo codes unavailable</h1>
          <p className="mt-2 text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-4 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <PromoCodesTab
        promoCodes={promoCodes}
        propertyCurrency={propertyCurrency}
        propertyTimeZone={propertyTimeZone}
        roomTypes={roomTypes}
        onCreatePromoCode={createPromo}
        onUpdatePromoCode={updatePromo}
        onDeletePromoCode={deletePromo}
        onTogglePromoCode={togglePromo}
      />
    </div>
  );
}
