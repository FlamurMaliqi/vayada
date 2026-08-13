import type { ProductReadinessHash, SourceManifestHash } from "@vayada/domain-hotels";

import {
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
  PUBLIC_BOOKABILITY_VISIBILITY,
  assertPublicBookabilityPublicSafe,
  type PublicBookabilityProfileProjection,
} from "./index.js";

export const BOOKING_PUBLIC_CONTENT_CONTRACT_VERSION = "booking-public-content.v1" as const;
export type BookingPublicPaymentMethod = "card" | "pay_at_property";
type BookingPublicFinanceEvidence = Readonly<{
  defaultCurrency: string;
  supportedCurrencies: readonly string[];
  onlinePayment: boolean;
  payAtProperty: boolean;
  readyPaymentMethods: readonly BookingPublicPaymentMethod[];
}>;

export type BookingPublicRate = Readonly<{
  ratePlanId: string;
  currency: string;
  baseNightlyAmount: string;
  refundable: boolean;
  cancellation?: string | null;
  paymentTiming: "pay_at_property" | "prepay_full";
}>;

export type BookingPublicRoom = Readonly<{
  roomTypeId: string;
  name: string;
  maxAdults: number;
  maxChildren: number;
  images: readonly { url: string; alt?: string | null }[];
  amenities: readonly string[];
  rates: readonly BookingPublicRate[];
}>;

export type BookingPublicCalendarSnapshot = Readonly<{
  sourceRevision: string;
  materializedRevision: string;
  currentLocalDate: string;
  coverageFrom: string;
  coverageThrough: string;
  materializedThrough: string;
  expectedDayCount: number;
  materializedDayCount: number;
  gapCount: number;
  roomTypeIds: readonly string[];
  observedAt: string;
}>;

export type BookingPublicContent = Readonly<{
  contractVersion: typeof BOOKING_PUBLIC_CONTENT_CONTRACT_VERSION;
  profile: PublicBookabilityProfileProjection;
  rooms: readonly BookingPublicRoom[];
  calendar: BookingPublicCalendarSnapshot;
  payments: Readonly<{ readyMethods: readonly BookingPublicPaymentMethod[] }>;
}>;

export type BookingPublicContentBuild = Readonly<{
  sourceManifestHash: SourceManifestHash;
  readinessHash: ProductReadinessHash;
  publicContent: BookingPublicContent;
}>;

export function buildBookingPublicContent(input: {
  sourceManifestHash: SourceManifestHash;
  readinessHash: ProductReadinessHash;
  profile: PublicBookabilityProfileProjection;
  rooms: readonly BookingPublicRoom[];
  calendar: BookingPublicCalendarSnapshot;
  finance: BookingPublicFinanceEvidence;
}): BookingPublicContentBuild | null {
  if (!validHash(input.sourceManifestHash) || !validHash(input.readinessHash)) return null;
  const readyMethods = [
    ...new Set(
      input.finance.readyPaymentMethods.filter(
        (method) => method === "card" || method === "pay_at_property",
      ),
    ),
  ].sort();
  const rooms = sanitizeRooms(input.rooms, input.finance, readyMethods);
  const calendar = sanitizeCalendar(
    input.calendar,
    rooms,
    input.profile.generatedAt,
    input.profile.hotel.timezone,
  );
  if (
    !rooms ||
    !calendar ||
    !validProfile(input.profile, input.finance) ||
    readyMethods.includes("card") !== input.finance.onlinePayment ||
    readyMethods.includes("pay_at_property") !== input.finance.payAtProperty
  )
    return null;

  const publicContent = deepFreeze({
    contractVersion: BOOKING_PUBLIC_CONTENT_CONTRACT_VERSION,
    profile: structuredClone(input.profile),
    rooms,
    calendar,
    payments: { readyMethods },
  });
  assertPublicBookabilityPublicSafe(publicContent);
  return deepFreeze({
    sourceManifestHash: input.sourceManifestHash,
    readinessHash: input.readinessHash,
    publicContent,
  });
}

function validProfile(
  profile: PublicBookabilityProfileProjection,
  finance: BookingPublicFinanceEvidence,
): boolean {
  const generated = Date.parse(profile.generatedAt);
  const sources = profile.freshness.sources;
  return (
    profile.contractVersion === PUBLIC_BOOKABILITY_CONTRACT_VERSION &&
    profile.publicVisibility === PUBLIC_BOOKABILITY_VISIBILITY &&
    [
      profile.hotel.propertyId,
      profile.hotel.slug,
      profile.hotel.name,
      profile.hotel.timezone,
    ].every(nonEmpty) &&
    profile.hotel.trust.profileComplete &&
    profile.hotel.trust.profileVerified &&
    profile.hotel.trust.bookabilityStatus === "bookable" &&
    profile.hotel.trust.reasonCodes.length === 0 &&
    profile.freshness.status === "fresh" &&
    profile.freshness.generatedAt === profile.generatedAt &&
    sameOwners(profile.dataSources, PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS) &&
    sameOwners(
      sources.map(({ owner }) => owner),
      PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS,
    ) &&
    sources.every(
      ({ status, lastUpdatedAt }) =>
        status === "fresh" && validInstant(lastUpdatedAt) && Date.parse(lastUpdatedAt) <= generated,
    ) &&
    profile.hotel.capabilities.onlinePayment === finance.onlinePayment &&
    profile.hotel.capabilities.payAtProperty === finance.payAtProperty &&
    profile.hotel.defaultCurrency === finance.defaultCurrency &&
    sameOwners(profile.hotel.supportedCurrencies, finance.supportedCurrencies) &&
    sameOwners(
      profile.hotel.supportedQuoteParameters.supportedCurrencies,
      finance.supportedCurrencies,
    )
  );
}

function sameOwners(left: readonly string[], right: readonly string[]): boolean {
  return (
    new Set(left).size === left.length &&
    [...left].sort().join("\0") === [...right].sort().join("\0")
  );
}

function sanitizeRooms(
  input: readonly BookingPublicRoom[],
  finance: BookingPublicFinanceEvidence,
  readyMethods: readonly string[],
): readonly BookingPublicRoom[] | null {
  const roomIds = new Set<string>();
  const rooms = input.map((room) => {
    if (!nonEmpty(room.roomTypeId) || !nonEmpty(room.name) || roomIds.has(room.roomTypeId))
      return null;
    roomIds.add(room.roomTypeId);
    const rateIds = new Set<string>();
    const rates = room.rates.map((rate) => {
      const method = rate.paymentTiming === "prepay_full" ? "card" : "pay_at_property";
      if (
        !nonEmpty(rate.ratePlanId) ||
        rateIds.has(rate.ratePlanId) ||
        !/^\d+\.\d{2}$/.test(rate.baseNightlyAmount) ||
        Number(rate.baseNightlyAmount) < 0 ||
        rate.currency !== finance.defaultCurrency ||
        !finance.supportedCurrencies.includes(rate.currency) ||
        !readyMethods.includes(method)
      )
        return null;
      rateIds.add(rate.ratePlanId);
      return {
        ratePlanId: rate.ratePlanId,
        currency: rate.currency,
        baseNightlyAmount: rate.baseNightlyAmount,
        refundable: rate.refundable,
        ...(rate.cancellation === undefined ? {} : { cancellation: rate.cancellation }),
        paymentTiming: rate.paymentTiming,
      };
    });
    if (
      rates.length === 0 ||
      rates.some((rate) => !rate) ||
      !Number.isInteger(room.maxAdults) ||
      room.maxAdults < 1 ||
      !Number.isInteger(room.maxChildren) ||
      room.maxChildren < 0
    )
      return null;
    return {
      roomTypeId: room.roomTypeId,
      name: room.name,
      maxAdults: room.maxAdults,
      maxChildren: room.maxChildren,
      images: room.images.map(({ url, alt }) => ({ url, ...(alt === undefined ? {} : { alt }) })),
      amenities: [...room.amenities],
      rates: rates as BookingPublicRate[],
    };
  });
  return rooms.length > 0 && !rooms.some((room) => !room) ? (rooms as BookingPublicRoom[]) : null;
}

function sanitizeCalendar(
  value: BookingPublicCalendarSnapshot,
  rooms: readonly BookingPublicRoom[] | null,
  generatedAt: string,
  timezone: string,
): BookingPublicCalendarSnapshot | null {
  if (!rooms) return null;
  const roomTypeIds = [...new Set(value.roomTypeIds)].sort();
  const expectedRooms = rooms.map(({ roomTypeId }) => roomTypeId).sort();
  if (
    !validInstant(generatedAt) ||
    value.currentLocalDate !== localDateAt(generatedAt, timezone) ||
    !nonEmpty(value.sourceRevision) ||
    value.sourceRevision !== value.materializedRevision ||
    value.currentLocalDate !== value.coverageFrom ||
    value.coverageThrough !== value.materializedThrough ||
    inclusiveDays(value.coverageFrom, value.coverageThrough) !== 366 ||
    value.expectedDayCount !== 366 ||
    value.materializedDayCount !== 366 ||
    value.gapCount !== 0 ||
    JSON.stringify(roomTypeIds) !== JSON.stringify(expectedRooms) ||
    !validInstant(value.observedAt) ||
    Date.parse(value.observedAt) > Date.parse(generatedAt)
  )
    return null;
  return {
    sourceRevision: value.sourceRevision,
    materializedRevision: value.materializedRevision,
    currentLocalDate: value.currentLocalDate,
    coverageFrom: value.coverageFrom,
    coverageThrough: value.coverageThrough,
    materializedThrough: value.materializedThrough,
    expectedDayCount: value.expectedDayCount,
    materializedDayCount: value.materializedDayCount,
    gapCount: value.gapCount,
    roomTypeIds,
    observedAt: value.observedAt,
  };
}

function localDateAt(instant: string, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((value) => value.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return null;
  }
}

function inclusiveDays(from: string, through: string): number {
  if (!validDate(from) || !validDate(through)) return 0;
  return (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validHash(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
