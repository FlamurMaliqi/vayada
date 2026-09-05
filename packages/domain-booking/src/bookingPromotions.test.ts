import { describe, expect, it } from "vitest";
import {
  bestBookingPromotion,
  bookingPromotionsFromSettings,
  parseBookingPromotions,
  type BookingPromotion,
} from "./bookingPromotions.js";
const roomTypeId = "11111111-1111-4111-8111-111111111111";
const otherRoom = "22222222-2222-4222-8222-222222222222";
const promotion = (overrides: Partial<BookingPromotion> = {}): BookingPromotion => ({
  type: "LAST_MINUTE",
  active: true,
  roomTypeIds: [],
  discountPercent: 10,
  threshold: 5,
  freeNights: 0,
  weekdays: [],
  tiers: [],
  ...overrides,
});
const input = {
  roomTypeId,
  today: "2026-09-05",
  roomTotal: 300,
  roomCount: 1,
  nights: [
    { stayDate: "2026-09-06", grossRoomAmount: "100" },
    { stayDate: "2026-09-07", grossRoomAmount: "200" },
  ],
};
const quote = (promotions: BookingPromotion[], overrides = {}) =>
  bestBookingPromotion({ ...input, settings: { promotions }, ...overrides });

describe("automatic booking promotions", () => {
  it("preserves existing last-minute tiers and their inclusive boundaries", () => {
    const settings = {
      enabled: true,
      stackWithPromo: true,
      tiers: [
        { daysBeforeMin: 0, daysBeforeMax: 1, discountPercent: 25 },
        { daysBeforeMin: 2, daysBeforeMax: null, discountPercent: 5 },
      ],
    };
    expect(bookingPromotionsFromSettings(settings)[0]?.tiers).toEqual(settings.tiers);
    expect(bestBookingPromotion({ ...input, settings })?.discountAmount).toBe(75);
    expect(bestBookingPromotion({ ...input, settings, today: "2026-09-04" })?.discountAmount).toBe(
      15,
    );
    expect(bookingPromotionsFromSettings({ ...settings, enabled: false })).toEqual([]);
    expect(bookingPromotionsFromSettings({ ...settings, promotions: [] })).toEqual([]);
  });
  it("preserves all previously accepted tier windows, count and percentage precision", () => {
    const tiers = Array.from({ length: 101 }, (_, index) => ({
      daysBeforeMin: index * 50,
      daysBeforeMax: index * 50 + 49,
      discountPercent: 33.333,
    }));
    expect(bookingPromotionsFromSettings({ enabled: true, tiers })[0]?.tiers).toEqual(tiers);
    expect(
      bestBookingPromotion({ ...input, roomTotal: 10000, settings: { enabled: true, tiers } })
        ?.discountAmount,
    ).toBe(3333.3);
  });

  it("enforces unique types, strict parameters and valid room identifiers", () => {
    expect(parseBookingPromotions([promotion(), promotion()])).toBeNull();
    for (const invalid of [
      { discountPercent: 101 },
      { discountPercent: NaN },
      { threshold: -1 },
      { roomTypeIds: ["invalid"] },
      { active: "yes" },
      { surprise: true },
    ])
      expect(parseBookingPromotions([{ ...promotion(), ...invalid }])).toBeNull();
    expect(parseBookingPromotions([promotion({ type: "MIDWEEK" })])).toBeNull();
    expect(
      parseBookingPromotions([
        promotion({ type: "EXTENDED_STAY", freeNights: 5, discountPercent: 0, threshold: 5 }),
      ]),
    ).toBeNull();
  });
  it("keeps paused configuration and applies room targeting", () => {
    const paused = promotion({ active: false });
    expect(parseBookingPromotions([paused])).toEqual([paused]);
    expect(quote([paused])).toBeNull();
    expect(quote([promotion({ roomTypeIds: [otherRoom] })])).toBeNull();
    expect(quote([promotion({ roomTypeIds: [roomTypeId] })])?.discountAmount).toBe(30);
  });
  it("chooses the highest single offer and includes threshold boundaries", () => {
    const early = promotion({ type: "EARLY_BIRD", threshold: 1, discountPercent: 20 });
    expect(quote([promotion(), early])).toMatchObject({ name: "Early bird", discountAmount: 60 });
    expect(quote([early], { today: "2026-09-06" })).toBeNull();
    expect(quote([promotion({ threshold: 0 })])).toBeNull();
    expect(quote([promotion()], { today: "2026-09-07" })).toBeNull();
  });
  it("discounts only occupied selected weekdays and scales room counts", () => {
    const midweek = promotion({ type: "MIDWEEK", weekdays: [0], discountPercent: 25 });
    expect(quote([midweek])?.discountAmount).toBe(25);
    expect(quote([midweek], { roomCount: 2, roomTotal: 600 })?.discountAmount).toBe(50);
    expect(quote([promotion({ type: "MIDWEEK", weekdays: [2] })])).toBeNull();
  });
  it("gives the cheapest free nights once per stay, with minimum length", () => {
    const extended = promotion({
      type: "EXTENDED_STAY",
      threshold: 2,
      freeNights: 1,
      discountPercent: 0,
    });
    expect(quote([extended])?.discountAmount).toBe(100);
    expect(quote([extended], { roomCount: 3, roomTotal: 900 })?.discountAmount).toBe(300);
    expect(quote([{ ...extended, threshold: 3 }])).toBeNull();
    expect(
      quote([promotion({ type: "EXTENDED_STAY", threshold: 2, discountPercent: 15 })])
        ?.discountAmount,
    ).toBe(45);
  });
  it("rounds money half-up and never discounts beyond the room basis", () => {
    expect(quote([promotion({ discountPercent: 25 })], { roomTotal: 0.06 })?.discountAmount).toBe(
      0.02,
    );
    expect(
      quote([promotion({ type: "MIDWEEK", weekdays: [0], discountPercent: 100 })], {
        roomTotal: 30,
      })?.discountAmount,
    ).toBe(30);
  });
});
