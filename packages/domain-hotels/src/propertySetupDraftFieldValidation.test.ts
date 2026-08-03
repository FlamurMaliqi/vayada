import { describe, expect, it } from "vitest";

import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  type PropertySetupFieldId,
} from "./propertySetupDraft.js";
import { isPropertySetupDraftFieldValue } from "./propertySetupDraftFieldValidation.js";

const MEDIA_ID = "media_01K4M6R9Q3X2Y7Z8";

const VALID_VALUES = {
  "profile.default_locale": "de-DE",
  "profile.short_description": "A calm city hotel.",
  "profile.hero_image": MEDIA_ID,
  "profile.gallery_images": [MEDIA_ID],
  "profile.amenities": ["wifi"],
  "marketplace.preferences.compensation_types": ["free_stay"],
  "marketplace.preferences.content_platforms": ["instagram"],
  "marketplace.preferences.content_types": ["short_form_video"],
  "marketplace.preferences.availability": { mode: "selected_months", months: [6, 7] },
  "booking.primary_color": "#4F46E5",
  "booking.font_pairing": "high-end-serif",
  "room.name": { room_1: "Deluxe Double Room" },
  "room.category": { room_1: "deluxe" },
  "room.max_occupancy": { room_1: 2 },
  "room.max_adults": { room_1: 2 },
  "room.max_children": { room_1: 1 },
  "room.beds": { room_1: [{ type: "king", quantity: 1 }] },
  "room.bedrooms": { room_1: 1 },
  "room.bathrooms": { room_1: 1 },
  "room.bathroom_type": { room_1: "private" },
  "room.size": { room_1: { value: 28.5, unit: "sqm" } },
  "room.description": { room_1: "A quiet room with a courtyard view." },
  "room.unit_count": { room_1: 12 },
  "room.images": { room_1: [MEDIA_ID] },
  "room.amenities": {
    room_1: { keys: ["air_conditioning"], reviewedEmpty: false },
  },
  "rate.currency": "EUR",
  "rate.base_nightly_rate": { room_1: "160.00" },
  "rate.free_cancellation_deadline_days": 7,
  "rate.non_refundable_enabled": true,
  "rate.non_refundable_discount": 10,
  "rate.seasons": [
    {
      id: "summer",
      name: "Summer",
      startMonthDay: "06-01",
      endMonthDay: "08-31",
    },
  ],
  "rate.seasonal_prices": { summer: { room_1: "190.00" } },
  "rate.weekend_days": ["friday", "saturday"],
  "rate.weekend_surcharge": { room_1: "15.00" },
  "rate.occupancy_prices": {
    room_1: { includedGuests: 2, additionalGuestAmount: "30.00" },
  },
  "rate.mandatory_charges_acknowledged": true,
  "rate.operating_periods": {
    mode: "recurring",
    periods: [{ startMonthDay: "04-01", endMonthDay: "10-31" }],
  },
  "rate.minimum_stay": 1,
  "rate.initial_availability": { limits: { room_1: 12 }, confirmed: true },
  "guest.default_language": "de-DE",
  "guest.children_enabled": true,
  "guest.adult_age_threshold": 18,
  "guest.phone_required": true,
  "guest.arrival_time_enabled": false,
  "guest.special_requests_enabled": true,
  "policy.check_in_time": "15:00",
  "policy.check_out_time": "11:00",
  "policy.cancellation_bundle_confirmation": true,
  "payment.accepted_methods": ["pay_at_hotel", "online_card"],
} satisfies Record<PropertySetupFieldId, unknown>;

describe("property setup draft field validation", () => {
  it("accepts one bounded value for every registered field", () => {
    const registeredFields = PROPERTY_SETUP_STEP_DEFINITIONS.flatMap(({ fields }) => fields);

    expect(Object.keys(VALID_VALUES).sort()).toEqual([...registeredFields].sort());
    for (const [field, value] of Object.entries(VALID_VALUES)) {
      expect(isPropertySetupDraftFieldValue(field as PropertySetupFieldId, value), field).toBe(
        true,
      );
    }
  });

  it("allows every field to remain explicitly unanswered", () => {
    for (const field of Object.keys(VALID_VALUES) as PropertySetupFieldId[]) {
      expect(isPropertySetupDraftFieldValue(field, null), field).toBe(true);
    }
  });

  it.each(["unknown.field", "__proto__", "constructor", "toString"])(
    "rejects the unregistered field name %s",
    (field) => {
      expect(isPropertySetupDraftFieldValue(field as PropertySetupFieldId, null)).toBe(false);
    },
  );

  it.each([
    ["marketplace.preferences.availability", { mode: "selected_months", months: [] }],
    ["room.name", { "room:1": null }],
    ["room.beds", { "room:1": [{ type: null }] }],
    ["rate.base_nightly_rate", { "room:1": "1234567890123.45" }],
    ["rate.seasons", [{ id: "season:summer" }]],
    ["rate.seasonal_prices", { "season:summer": { "room:1": null } }],
    ["rate.operating_periods", { mode: "recurring", periods: [] }],
    ["rate.initial_availability", { confirmed: null }],
    ["rate.initial_availability", { limits: { "room:1": null } }],
  ] as const)("preserves incomplete %s composite values", (field, value) => {
    expect(isPropertySetupDraftFieldValue(field, value)).toBe(true);
  });

  it.each([
    ["profile.default_locale", "not a language"],
    ["profile.short_description", "x".repeat(2_001)],
    ["profile.gallery_images", ["https://signed.example/hotel.jpg"]],
    ["profile.amenities", ["wifi", "wifi"]],
    ["marketplace.preferences.compensation_types", ["room_and_board"]],
    ["marketplace.preferences.availability", { mode: "year_round", months: [1] }],
    ["booking.font_pairing", "comic-sans"],
    ["room.beds", { room_1: [{ type: "king", quantity: 1, provider_secret: "secret" }] }],
    ["room.size", { room_1: 28.5 }],
    ["room.size", { room_1: { value: 28.5, unit: "sqft" } }],
    ["room.unit_count", { room_1: 0 }],
    ["room.unit_count", { room_1: 501 }],
    ["room.images", { room_1: ["https://signed.example/room.jpg"] }],
    ["room.amenities", { room_1: ["air_conditioning"] }],
    ["room.amenities", { room_1: { keys: ["air_conditioning"], reviewedEmpty: true } }],
    ["rate.base_nightly_rate", { room_1: 160 }],
    ["rate.base_nightly_rate", { room_1: "0.00" }],
    ["rate.base_nightly_rate", { room_1: "12345678901234.56" }],
    [
      "rate.seasons",
      [{ name: "Summer", startMonthDay: "06-01", endMonthDay: "08-31", access_granted: true }],
    ],
    ["rate.seasons", [{ startMonthDay: "2026-06-01" }]],
    ["rate.seasons", [{ startMonthDay: "02-29" }]],
    ["rate.seasons", [{ startMonthDay: "04-31" }]],
    ["rate.weekend_days", ["friday", "friday"]],
    [
      "rate.operating_periods",
      {
        mode: "year_round",
        periods: [{ startMonthDay: "04-01", endMonthDay: "10-31" }],
      },
    ],
    ["rate.minimum_stay", 0],
    ["rate.minimum_stay", 367],
    ["rate.initial_availability", { room_1: 12 }],
    ["guest.default_language", "not a language"],
    ["policy.check_in_time", "25:00"],
    ["payment.accepted_methods", ["bank_transfer"]],
  ] as const)("rejects malformed %s draft values", (field, value) => {
    expect(isPropertySetupDraftFieldValue(field, value)).toBe(false);
  });
});
