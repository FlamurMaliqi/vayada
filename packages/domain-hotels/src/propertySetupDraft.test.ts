import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
  PROPERTY_SETUP_COMPLETED_RETENTION_DAYS,
  PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION,
  PROPERTY_SETUP_STEP_DEFINITIONS,
  getActivePropertySetupStepIds,
  type PropertySetupBaseRevisions,
  type PropertySetupDraftPayload,
  type JsonValue,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftResult,
} from "./propertySetupDraft.js";

describe("property setup draft contract", () => {
  it("defines the approved retention, PII posture, and nine stable steps", () => {
    expect(PROPERTY_SETUP_ACTIVE_RETENTION_DAYS).toBe(90);
    expect(PROPERTY_SETUP_COMPLETED_RETENTION_DAYS).toBe(30);
    expect(PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION).toBe("potential_incidental_pii");
    expect(PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId }) => stepId)).toEqual([
      "present_hotel",
      "marketplace_preferences",
      "booking_design",
      "rooms",
      "pricing",
      "calendar",
      "guest_experience",
      "payments",
      "review",
    ]);
    expect(
      PROPERTY_SETUP_STEP_DEFINITIONS.find(({ stepId }) => stepId === "present_hotel"),
    ).toMatchObject({
      permission: "hotel_catalog.setup.manage",
      fields: [
        "profile.default_locale",
        "profile.short_description",
        "profile.hero_image",
        "profile.gallery_images",
        "profile.amenities",
      ],
    });
    expect(
      PROPERTY_SETUP_STEP_DEFINITIONS.find(({ stepId }) => stepId === "payments"),
    ).toMatchObject({
      permission: "booking.settings.manage",
      fields: ["payment.accepted_methods"],
    });
    expect(
      PROPERTY_SETUP_STEP_DEFINITIONS.find(({ stepId }) => stepId === "guest_experience")?.fields,
    ).toContain("policy.cancellation_bundle_confirmation");

    const fields = PROPERTY_SETUP_STEP_DEFINITIONS.flatMap(({ fields }) => fields);
    expect(new Set(fields).size).toBe(fields.length);
    for (const { baseRevisionKeys } of PROPERTY_SETUP_STEP_DEFINITIONS) {
      expect(new Set(baseRevisionKeys).size).toBe(baseRevisionKeys.length);
    }
    expect(
      Object.fromEntries(
        PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId, baseRevisionKeys }) => [
          stepId,
          baseRevisionKeys.join("|"),
        ]),
      ),
    ).toEqual({
      present_hotel: "hotel_catalog.profile|hotel_catalog.media|hotel_catalog.amenities",
      marketplace_preferences: "marketplace.collaboration_preferences",
      booking_design: "booking.design|hotel_catalog.profile|hotel_catalog.media",
      rooms: "pms.room_types|pms.room_units|pms.room_media",
      pricing: "pms.pricing_settings|pms.rate_plans|pms.rate_rules",
      calendar: "pms.operating_calendar|pms.inventory|pms.room_types|hotel_catalog.location",
      guest_experience:
        "booking.guest_experience|pms.pricing_settings|pms.rate_plans|pms.room_types|hotel_catalog.location|hotel_catalog.policy",
      payments: "finance.payment_methods|pms.pricing_settings",
      review: "",
    });
    expectTypeOf<PropertySetupDraftPayload<"review">>().toEqualTypeOf<
      Readonly<Record<string, never>>
    >();
    expectTypeOf<PropertySetupBaseRevisions<"review">>().toEqualTypeOf<
      Readonly<Record<string, never>>
    >();
    expectTypeOf<PropertySetupDraftPayload<"present_hotel">>()
      .toHaveProperty("profile.default_locale")
      .toEqualTypeOf<JsonValue | undefined>();
    expectTypeOf<SavePropertySetupDraftReceipt>().not.toHaveProperty("payload");
    expectTypeOf<SavePropertySetupDraftReceipt>().not.toHaveProperty("baseRevisions");
    expectTypeOf<SavePropertySetupDraftResult>().toMatchTypeOf<
      { ok: true; receipt: SavePropertySetupDraftReceipt } | { ok: false; error: { code: string } }
    >();
  });

  it.each([
    [[], []],
    [["creator_marketplace"], ["present_hotel", "marketplace_preferences", "review"]],
    [
      ["hotel_operations"],
      [
        "present_hotel",
        "booking_design",
        "rooms",
        "pricing",
        "calendar",
        "guest_experience",
        "payments",
        "review",
      ],
    ],
    [
      ["hotel_operations", "creator_marketplace"],
      [
        "present_hotel",
        "marketplace_preferences",
        "booking_design",
        "rooms",
        "pricing",
        "calendar",
        "guest_experience",
        "payments",
        "review",
      ],
    ],
  ] as const)("returns contiguous active steps for tracks %j", (tracks, expected) => {
    expect(getActivePropertySetupStepIds(tracks)).toEqual(expected);
  });
});
