import { PUBLIC_BOOKABILITY_FIXTURES } from "./fixtures.js";
import {
  buildBookingPublicContent,
  parseBookingPublicContent,
  type BookingPublicRoom,
} from "./bookingPublication.js";
import { describe, expect, it } from "vitest";

const hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const;

describe("Booking public content", () => {
  it("allowlists immutable room facts and binds both evidence hashes", () => {
    const room = rooms()[0] as BookingPublicRoom & { wholesaleCost: string };
    room.wholesaleCost = "20.00";
    const result = build({ rooms: [room] });
    expect(result).toMatchObject({ sourceManifestHash: hash, readinessHash: hash });
    expect(result?.publicContent.rooms[0]).toMatchObject({
      roomTypeId: "room-deluxe",
      rates: [{ baseNightlyAmount: "125.00" }],
    });
    expect(result?.publicContent.calendar).toMatchObject({
      sourceRevision: "calendar-r1",
      materializedDayCount: 366,
    });
    expect(result?.publicContent.payments.readyMethods).toEqual(["card", "pay_at_property"]);
    expect(result?.publicContent.rooms[0]).not.toHaveProperty("wholesaleCost");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("omits rates whose payment method is not ready", () => {
    const publicProfile = profile();
    publicProfile.hotel.capabilities.onlinePayment = false;
    const room = rooms()[0]!;
    const result = build({
      profile: publicProfile,
      rooms: [
        {
          ...room,
          rates: [
            ...room.rates,
            {
              ratePlanId: "nonref",
              currency: "EUR",
              baseNightlyAmount: "100.00",
              refundable: false,
              paymentTiming: "prepay_full",
            },
          ],
        },
      ],
      finance: {
        ...finance(),
        onlinePayment: false,
        readyPaymentMethods: ["pay_at_property"],
      },
    });

    expect(result?.publicContent.rooms[0]?.rates).toEqual(room.rates);
  });

  it("parses only the complete exact stored content contract", () => {
    const content = build()?.publicContent;
    expect(parseBookingPublicContent(content)).toEqual(content);
    expect(parseBookingPublicContent({ ...content, rooms: undefined })).toBeNull();
    expect(parseBookingPublicContent({ ...content, privateNotes: "secret" })).toBeNull();

    const poisoned = structuredClone(content!);
    (poisoned.rooms[0]!.rates[0] as { paymentTiming: string }).paymentTiming = "bank_transfer";
    expect(parseBookingPublicContent(poisoned)).toBeNull();
  });

  // prettier-ignore
  it("scales calendar evidence across rooms", () => expect(build({ rooms: [rooms()[0]!, { ...rooms()[0]!, roomTypeId: "room-suite" }], calendar: { ...calendar(), roomTypeIds: ["room-deluxe", "room-suite"], expectedDayCount: 732, materializedDayCount: 732 } })).not.toBeNull());

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
    ["room", () => ({ rooms: [{ ...rooms()[0]!, images: [] }] })],
    ["currencies", () => ({ finance: { ...finance(), supportedCurrencies: ["EUR", "EUR"] } })],
    ["Finance mismatch", () => ({ finance: { ...finance(), onlinePayment: false } })],
    ["payment", () => ({ finance: { ...finance(), readyPaymentMethods: [] } })],
    [
      "payment timing",
      () => {
        const value = rooms();
        (value[0]!.rates[0] as { paymentTiming: string }).paymentTiming = "bank_transfer";
        return { rooms: value };
      },
    ],
    [
      "public contact",
      () =>
        changeProfile((value) =>
          value.hotel.publicContacts.push({ type: "email", value: "not-an-email" }),
        ),
    ],
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

const profile = () => structuredClone(PUBLIC_BOOKABILITY_FIXTURES[0]!.profile);

function changeProfile(change: (value: ReturnType<typeof profile>) => void) {
  const value = profile();
  change(value);
  return { profile: value };
}

// prettier-ignore
const rooms = (): BookingPublicRoom[] => [{ roomTypeId: "room-deluxe", name: "Deluxe room", description: "A bright room with a private bathroom.", category: "deluxe", occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 }, beds: [{ type: "king", quantity: 1 }], bedrooms: 1, bathrooms: 1, bathroomType: "private", size: { value: 32, unit: "sqm" }, images: [{ url: "https://cdn.example/room.jpg", alt: "Deluxe room" }], amenities: ["wifi"], rates: [{ ratePlanId: "r1", currency: "EUR", baseNightlyAmount: "125.00", refundable: true, paymentTiming: "pay_at_property" }] }];

// prettier-ignore
const calendar = () => ({ sourceRevision: "calendar-r1", materializedRevision: "calendar-r1", currentLocalDate: "2026-06-06", coverageFrom: "2026-06-06", coverageThrough: "2027-06-06", materializedThrough: "2027-06-06", expectedDayCount: 366, materializedDayCount: 366, gapCount: 0, roomTypeIds: ["room-deluxe"], observedAt: "2026-06-06T11:00:00.000Z" });

// prettier-ignore
const finance = () => ({ defaultCurrency: "EUR", supportedCurrencies: ["EUR"], onlinePayment: true, payAtProperty: true, readyPaymentMethods: ["card", "pay_at_property"] as const });
