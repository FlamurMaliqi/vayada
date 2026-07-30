import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
  PROPERTY_SETUP_COMPLETED_RETENTION_DAYS,
  PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION,
  PROPERTY_SETUP_STEP_DEFINITIONS,
  buildPropertySetupDraftProgress,
  getActivePropertySetupStepIds,
  type PropertySetupBaseRevisionKey,
  type PropertySetupBaseRevisions,
  type PropertySetupDraftPayload,
  type SavePropertySetupDraftError,
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
    expectTypeOf<SavePropertySetupDraftReceipt>().not.toHaveProperty("payload");
    expectTypeOf<SavePropertySetupDraftReceipt>().not.toHaveProperty("baseRevisions");
    expectTypeOf<SavePropertySetupDraftResult>().toMatchTypeOf<
      { ok: true; receipt: SavePropertySetupDraftReceipt } | { ok: false; error: { code: string } }
    >();
    expectTypeOf<
      Extract<
        SavePropertySetupDraftError,
        { code: "base_revision_conflict" }
      >["conflictingBaseRevisionKeys"]
    >().toEqualTypeOf<PropertySetupBaseRevisionKey[]>();
    expectTypeOf<
      Extract<
        SavePropertySetupDraftError,
        { code: "base_revision_unavailable" }
      >["unavailableBaseRevisionKeys"]
    >().toEqualTypeOf<PropertySetupBaseRevisionKey[]>();
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

  it("excludes hidden-track completion from active progress", () => {
    const completedStepIds = ["present_hotel", "booking_design"] as const;

    expect(
      buildPropertySetupDraftProgress(["creator_marketplace"], completedStepIds, [
        "marketplace_preferences",
        "booking_design",
      ]),
    ).toEqual({
      complete: 1,
      total: 3,
      steps: [
        { stepId: "present_hotel", position: 1, state: "complete" },
        { stepId: "marketplace_preferences", position: 2, state: "in_progress" },
        { stepId: "review", position: 3, state: "not_started" },
      ],
    });
  });

  it("restores retained draft progress when a hidden track is reselected", () => {
    const draftStepIds = ["marketplace_preferences", "booking_design"] as const;
    const combined = buildPropertySetupDraftProgress(
      ["creator_marketplace", "hotel_operations"],
      [],
      draftStepIds,
    );
    const marketplaceOnly = buildPropertySetupDraftProgress(
      ["creator_marketplace"],
      [],
      draftStepIds,
    );
    const combinedAgain = buildPropertySetupDraftProgress(
      ["creator_marketplace", "hotel_operations"],
      [],
      draftStepIds,
    );

    expect(marketplaceOnly.steps.map(({ stepId }) => stepId)).not.toContain("booking_design");
    expect(combined.steps.find(({ stepId }) => stepId === "booking_design")?.state).toBe(
      "in_progress",
    );
    expect(combinedAgain).toEqual(combined);
  });
});
