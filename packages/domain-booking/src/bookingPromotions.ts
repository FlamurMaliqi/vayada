import { roundBookingPriceDecimalToMinorUnits } from "./bookingPriceCalculation.js";

export const BOOKING_PROMOTION_NAMES = {
  LAST_MINUTE: "Last minute escape",
  EARLY_BIRD: "Early bird",
  EXTENDED_STAY: "Extended stay",
  MIDWEEK: "Midweek getaway",
} as const;
export type BookingPromotion = {
  type: keyof typeof BOOKING_PROMOTION_NAMES;
  active: boolean;
  roomTypeIds: string[];
  discountPercent: number;
  threshold: number;
  freeNights: number;
  weekdays: number[];
  tiers: { daysBeforeMin: number; daysBeforeMax: number | null; discountPercent: number }[];
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const percent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;

/** Strict shared write boundary; invalid persisted promotions fail closed. */
export function parseBookingPromotions(value: unknown): BookingPromotion[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  const types = new Set<string>();
  for (const item of value) {
    const p = record(item);
    if (
      !p ||
      Object.keys(p).some(
        (key) =>
          ![
            "type",
            "active",
            "roomTypeIds",
            "discountPercent",
            "threshold",
            "freeNights",
            "weekdays",
            "tiers",
          ].includes(key),
      ) ||
      typeof p.type !== "string" ||
      !Object.hasOwn(BOOKING_PROMOTION_NAMES, p.type) ||
      types.has(p.type) ||
      typeof p.active !== "boolean" ||
      !Array.isArray(p.roomTypeIds) ||
      p.roomTypeIds.length > 1000 ||
      !p.roomTypeIds.every(
        (id) =>
          typeof id === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
      ) ||
      new Set(p.roomTypeIds).size !== p.roomTypeIds.length ||
      !integer(p.threshold, 0, 3650) ||
      !integer(p.freeNights, 0, 365) ||
      !Array.isArray(p.weekdays) ||
      !p.weekdays.every((day) => integer(day, 0, 6)) ||
      new Set(p.weekdays).size !== p.weekdays.length ||
      !Array.isArray(p.tiers)
    )
      return null;
    types.add(p.type);
    if (p.type === "EXTENDED_STAY" && (p.threshold < 1 || p.freeNights >= p.threshold)) return null;
    if (p.type !== "EXTENDED_STAY" && p.freeNights !== 0) return null;
    if (p.freeNights === 0 ? !percent(p.discountPercent) : p.discountPercent !== 0) return null;
    if (p.type === "MIDWEEK" ? p.weekdays.length === 0 : p.weekdays.length !== 0) return null;
    if (p.type !== "LAST_MINUTE" && p.tiers.length !== 0) return null;
    let previousMax = -1;
    for (const tier of [...p.tiers].sort(
      (a, b) => Number(a?.daysBeforeMin) - Number(b?.daysBeforeMin),
    )) {
      const t = record(tier);
      if (
        !t ||
        Object.keys(t).some(
          (key) => !["daysBeforeMin", "daysBeforeMax", "discountPercent"].includes(key),
        ) ||
        !integer(t.daysBeforeMin, 0, Number.MAX_SAFE_INTEGER) ||
        !percent(t.discountPercent) ||
        (t.daysBeforeMax !== null &&
          !integer(t.daysBeforeMax, t.daysBeforeMin, Number.MAX_SAFE_INTEGER)) ||
        t.daysBeforeMin <= previousMax
      )
        return null;
      previousMax = t.daysBeforeMax === null ? Infinity : Number(t.daysBeforeMax);
    }
  }
  return structuredClone(value) as BookingPromotion[];
}

export function bookingPromotionsFromSettings(value: unknown): BookingPromotion[] {
  const settings = record(value);
  if (!settings) return [];
  if (settings.promotions !== undefined) return parseBookingPromotions(settings.promotions) ?? [];
  if (settings.enabled !== true || !Array.isArray(settings.tiers) || !settings.tiers.length)
    return [];
  return (
    parseBookingPromotions([
      {
        type: "LAST_MINUTE",
        active: true,
        roomTypeIds: [],
        discountPercent: 10,
        threshold: 5,
        freeNights: 0,
        weekdays: [],
        tiers: settings.tiers,
      },
    ]) ?? []
  );
}

export type BookingPromotionDiscount = {
  type: BookingPromotion["type"];
  name: string;
  discountPercent: number;
  discountAmount: number;
};

/** Calendar dates are supplied by the caller in the property's timezone. */
export function bestBookingPromotion(input: {
  settings: unknown;
  roomTypeId: string;
  today: string;
  nights: { stayDate: string; grossRoomAmount: string }[];
  roomTotal: number;
  roomCount: number;
}): BookingPromotionDiscount | null {
  const promotions = bookingPromotionsFromSettings(input.settings);
  if (!promotions.some((p) => p.active)) return null;
  const nights = input.nights.map((night) => {
    const cents = roundBookingPriceDecimalToMinorUnits(String(night.grossRoomAmount));
    if (cents === null) throw new TypeError("Invalid promotion nightly amount");
    return { ...night, cents: BigInt(cents) * BigInt(input.roomCount) };
  });
  if (!nights.length) return null;
  const leadDays = (Date.parse(nights[0]!.stayDate) - Date.parse(input.today)) / 86400000;
  if (!Number.isInteger(leadDays) || leadDays < 0) return null;
  const roomCents = roundBookingPriceDecimalToMinorUnits(String(input.roomTotal));
  if (roomCents === null) throw new TypeError("Invalid promotion room total");
  let best: BookingPromotionDiscount | null = null;
  for (const promo of promotions) {
    if (
      !promo.active ||
      (promo.roomTypeIds.length && !promo.roomTypeIds.includes(input.roomTypeId))
    )
      continue;
    let discountPercent = promo.discountPercent;
    if (promo.type === "LAST_MINUTE") {
      if (promo.tiers.length) {
        const tier = promo.tiers.find(
          (t) =>
            leadDays >= t.daysBeforeMin &&
            (t.daysBeforeMax === null || leadDays <= t.daysBeforeMax),
        );
        if (!tier) continue;
        discountPercent = tier.discountPercent;
      } else if (leadDays > promo.threshold) continue;
    }
    if (promo.type === "EARLY_BIRD" && leadDays < promo.threshold) continue;
    if (promo.type === "EXTENDED_STAY" && nights.length < promo.threshold) continue;
    const eligible =
      promo.type === "MIDWEEK"
        ? nights.filter((n) =>
            promo.weekdays.includes(new Date(n.stayDate + "T00:00:00Z").getUTCDay()),
          )
        : nights;
    let cents: bigint;
    if (promo.freeNights) {
      cents = [...eligible]
        .sort((a, b) => (a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0))
        .slice(0, promo.freeNights)
        .reduce((sum, night) => sum + night.cents, 0n);
    } else {
      const basis =
        promo.type === "MIDWEEK"
          ? eligible.reduce((sum, night) => sum + night.cents, 0n)
          : BigInt(roomCents);
      const [mantissa, exponent = "0"] = String(discountPercent).split("e");
      const [whole, fraction = ""] = mantissa!.split(".");
      const numerator = BigInt(whole! + fraction);
      const denominator = 100n * 10n ** BigInt(fraction.length - Number(exponent));
      cents = (basis * numerator + denominator / 2n) / denominator;
    }
    if (cents > BigInt(roomCents)) cents = BigInt(roomCents);
    const discountAmount = Number(cents) / 100;
    if (discountAmount > (best?.discountAmount ?? 0))
      best = {
        type: promo.type,
        name: BOOKING_PROMOTION_NAMES[promo.type],
        discountPercent,
        discountAmount,
      };
  }
  return best;
}
