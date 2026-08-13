import { PUBLIC_BOOKABILITY_FIXTURES } from "./fixtures.js";
import {
  buildBookingPublicContent,
  type BookingPublicCalendarSnapshot,
  type BookingPublicRoom,
} from "./bookingPublication.js";
import { describe, expect, it } from "vitest";

const generatedAt = "2026-06-06T11:00:00.000Z";
const hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const;

describe("Booking public content", () => {
  it("allowlists immutable room facts and binds both evidence hashes", () => {
    const room = rooms()[0] as BookingPublicRoom & { wholesaleCost: string };
    room.wholesaleCost = "20.00";
    const result = build({ rooms: [room] });
    expect(result).toMatchObject({
      sourceManifestHash: hash,
      readinessHash: hash,
      publicContent: {
        rooms: [{ roomTypeId: "room-deluxe", rates: [{ baseNightlyAmount: "125.00" }] }],
        calendar: { sourceRevision: "calendar-r1", materializedDayCount: 366 },
        payments: { readyMethods: ["card", "pay_at_property"] },
      },
    });
    expect(result?.publicContent.rooms[0]).not.toHaveProperty("wholesaleCost");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    [
      "rate",
      () => {
        const value = rooms();
        (value[0]!.rates[0] as { currency: string }).currency = "USD";
        return { rooms: value };
      },
    ],
    ["calendar", () => ({ calendar: { ...calendar(), currentLocalDate: "2025-06-06" } })],
    ["stale", () => changeProfile((value) => (value.freshness.status = "stale"))],
    ["freshness provenance", () => changeProfile((value) => (value.freshness.sources = []))],
    ["trust", () => changeProfile((value) => (value.hotel.trust.profileVerified = false))],
    ["Finance mismatch", () => ({ finance: { ...finance(), onlinePayment: false } })],
    ["payment", () => ({ finance: { ...finance(), readyPaymentMethods: [] } })],
  ] as const)("rejects incomplete %s evidence", (_case, override) => {
    expect(build(override())).toBeNull();
  });
});

function build(overrides: Record<string, unknown> = {}) {
  return buildBookingPublicContent({
    sourceManifestHash: hash,
    readinessHash: hash,
    profile: profile(),
    rooms: rooms(),
    calendar: calendar(),
    finance: finance(),
    ...overrides,
  });
}

function profile() {
  return structuredClone(PUBLIC_BOOKABILITY_FIXTURES[0]!.profile);
}

function changeProfile(change: (value: ReturnType<typeof profile>) => void) {
  const value = profile();
  change(value);
  return { profile: value };
}

function rooms(): BookingPublicRoom[] {
  // prettier-ignore
  return [{ roomTypeId: "room-deluxe", name: "Deluxe room", maxAdults: 2, maxChildren: 1, images: [], amenities: ["wifi"], rates: [{ ratePlanId: "r1", currency: "EUR", baseNightlyAmount: "125.00", refundable: true, paymentTiming: "pay_at_property" }] }];
}

function calendar(): BookingPublicCalendarSnapshot {
  // prettier-ignore
  return { sourceRevision: "calendar-r1", materializedRevision: "calendar-r1", currentLocalDate: "2026-06-06", coverageFrom: "2026-06-06", coverageThrough: "2027-06-06", materializedThrough: "2027-06-06", expectedDayCount: 366, materializedDayCount: 366, gapCount: 0, roomTypeIds: ["room-deluxe"], observedAt: generatedAt };
}

function finance() {
  // prettier-ignore
  return { defaultCurrency: "EUR", supportedCurrencies: ["EUR"], onlinePayment: true, payAtProperty: true, readyPaymentMethods: ["card", "pay_at_property"] as const };
}
