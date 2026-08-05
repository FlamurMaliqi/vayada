import { describe, expect, it } from "vitest";

import type {
  BookingLaunchOwnerEvidence,
  BookingLaunchOwnerEvidenceResult,
  BookingLaunchReadinessEntityContribution,
  BookingLaunchReadinessGroupId,
  BookingLaunchReadinessPortKey,
  BookingLaunchSourceBinding,
} from "./bookingLaunchEvidence.js";
import { createBookingLaunchReadinessProvider } from "./bookingLaunchReadiness.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "20000000-0000-4000-8000-000000000002";
const sources = {
  profile: source("hotel_catalog", "property_profile", propertyId, "profile:7"),
  design: source("booking", "design_revision", propertyId, "design:3"),
  guest: source("booking", "guest_policy_confirmation", propertyId, "guest:4"),
  room: source("pms", "room_snapshot", "room-a", "room:5"),
  pricing: source("pms", "pricing_snapshot", propertyId, "pricing:8"),
  calendar: source("pms", "calendar_snapshot", propertyId, "calendar:9"),
  payments: source("finance", "payment_launch_gate", propertyId, "payments:4"),
  payAtProperty: source(
    "finance",
    "payment_method_readiness",
    `${propertyId}:pay_at_property`,
    "method:2",
  ),
  pendingCard: source(
    "finance",
    "payment_method_readiness",
    `${propertyId}:card`,
    "method:pending:1",
  ),
};

describe("Booking launch readiness behavior", () => {
  it("turns a stale cross-owner binding into an owning-step blocker", async () => {
    const evidence = readyEvidence();
    evidence.pms.sources = evidence.pms.sources.map((item) =>
      item.entityType === sources.pricing.entityType ? { ...item, revision: "pricing:9" } : item,
    );
    evidence.pms.entities = evidence.pms.entities.map((item) =>
      item.groupId === "booking.pricing"
        ? { ...item, source: { ...item.source, revision: "pricing:9" } }
        : item,
    );

    const result = await provider(evidence).getBookingReadiness({ organizationId, propertyId });

    expect(result).toMatchObject({ outcome: "evaluated", status: "blocked" });
    if (result.outcome !== "evaluated") return;
    expect(
      result.groups.find(({ groupId }) => groupId === "booking.guest_experience"),
    ).toMatchObject({
      status: "blocked",
      steps: [
        {
          owningStepId: "guest_experience",
          entities: [
            {
              blockers: [
                expect.objectContaining({
                  code: "pricing_confirmation_stale",
                  groupId: "booking.guest_experience",
                  owningStepId: "guest_experience",
                }),
              ],
            },
          ],
        },
      ],
    });
  });

  it("uses composer-owned public copy for explicit owner blockers", async () => {
    const evidence = readyEvidence();
    const privateOwnerText = "database password=hunter2";
    evidence.pms.entities = evidence.pms.entities.map((item) =>
      item.groupId === "booking.rooms"
        ? {
            ...item,
            blockers: [
              {
                scope: "launch_configuration" as const,
                kind: "user_fixable" as const,
                code: "room_photo_missing",
                safeMessage: privateOwnerText,
              },
            ],
          }
        : item,
    );

    const result = await provider(evidence).getBookingReadiness({ organizationId, propertyId });

    expect(result).toMatchObject({ outcome: "evaluated", status: "blocked" });
    if (result.outcome !== "evaluated") return;
    expect(result.groups.find(({ groupId }) => groupId === "booking.rooms")).toMatchObject({
      steps: [
        {
          owningStepId: "rooms",
          entities: [
            {
              blockers: [
                {
                  kind: "user_fixable",
                  code: "room_photo_missing",
                  message: "Review this setup step before publishing.",
                  product: "booking",
                  groupId: "booking.rooms",
                  owningStepId: "rooms",
                  source: sources.room,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(privateOwnerText);
  });

  it.each([
    ["external_pending", "selected_payment_pending", "pending"],
    ["user_fixable", "ready_payment_method_missing", "blocked"],
  ] as const)("rolls a %s payment gate up as %s", async (kind, code, expectedStatus) => {
    const evidence = readyEvidence();
    evidence.finance.entities[0] = {
      ...evidence.finance.entities[0]!,
      blockers: [{ scope: "launch_configuration", kind, code }],
    };

    const result = await provider(evidence).getBookingReadiness({ organizationId, propertyId });

    expect(result).toMatchObject({ outcome: "evaluated", status: expectedStatus });
    if (result.outcome !== "evaluated") return;
    expect(result.groups.find(({ groupId }) => groupId === "booking.payments")?.status).toBe(
      expectedStatus,
    );
  });

  it("keeps an optional pending card, sold-out state, and recommendations non-blocking", async () => {
    const evidence = readyEvidence();
    evidence.pms.entities = evidence.pms.entities.map((item) =>
      item.groupId === "booking.calendar"
        ? {
            ...item,
            advisories: [
              { scope: "temporary_availability" as const, code: "sold_out" },
              {
                scope: "recommendation" as const,
                code: "UNTRUSTED_RECOMMENDATION_FORMAT",
                safeMessage: `Not public ${"x".repeat(600)}`,
              },
            ],
          }
        : item,
    );

    const result = await provider(evidence).getBookingReadiness({ organizationId, propertyId });

    expect(result).toMatchObject({ outcome: "evaluated", status: "ready" });
    if (result.outcome !== "evaluated") return;
    expect(
      result.sourceManifest.sources.filter(
        ({ entityType }) => entityType === "payment_method_readiness",
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("sold_out");
    expect(JSON.stringify(result)).not.toContain("UNTRUSTED_RECOMMENDATION_FORMAT");
    expect(JSON.stringify(result)).not.toContain("optional_card_verification_pending");
  });
});

function readyEvidence() {
  return {
    catalog: evidence(
      "catalog",
      [sources.profile],
      [entity("booking.hotel_profile", sources.profile)],
    ),
    booking: evidence(
      "booking",
      [sources.design, sources.guest],
      [
        entity("booking.page_style", sources.design, [
          binding(sources.profile, "design_source_stale"),
        ]),
        entity("booking.guest_experience", sources.guest, [
          binding(sources.pricing, "pricing_confirmation_stale"),
        ]),
      ],
    ),
    pms: evidence(
      "pms",
      [sources.room, sources.pricing, sources.calendar],
      [
        entity("booking.rooms", sources.room),
        entity("booking.pricing", sources.pricing),
        entity("booking.calendar", sources.calendar),
      ],
    ),
    finance: evidence(
      "finance",
      [sources.payments, sources.payAtProperty, sources.pendingCard],
      [
        {
          ...entity("booking.payments", sources.payments, [
            binding(sources.pricing, "payment_currency_stale"),
          ]),
          advisories: [
            {
              scope: "optional_external_pending",
              code: "optional_card_verification_pending",
            },
          ],
        },
      ],
    ),
  };
}

function evidence<Port extends BookingLaunchReadinessPortKey>(
  port: Port,
  ownerSources: BookingLaunchOwnerEvidence<Port>["sources"],
  entities: BookingLaunchOwnerEvidence<Port>["entities"],
) {
  return {
    outcome: "evidence" as const,
    port,
    organizationId,
    propertyId,
    sources: structuredClone(ownerSources) as Array<(typeof ownerSources)[number]>,
    entities: structuredClone(entities) as Array<(typeof entities)[number]>,
  };
}

function entity<Group extends BookingLaunchReadinessGroupId>(
  groupId: Group,
  ownerSource: Extract<BookingLaunchReadinessEntityContribution, { groupId: Group }>["source"],
  bindings: readonly BookingLaunchSourceBinding[] = [],
): Extract<BookingLaunchReadinessEntityContribution, { groupId: Group }> {
  const steps = {
    "booking.hotel_profile": "present_hotel",
    "booking.page_style": "booking_design",
    "booking.rooms": "rooms",
    "booking.pricing": "pricing",
    "booking.calendar": "calendar",
    "booking.guest_experience": "guest_experience",
    "booking.payments": "payments",
  } as const;
  return {
    groupId,
    owningStepId: steps[groupId],
    source: ownerSource,
    blockers: [],
    bindings,
  } as unknown as Extract<BookingLaunchReadinessEntityContribution, { groupId: Group }>;
}

function binding(expectedSource: BookingLaunchSourceBinding["expectedSource"], code: string) {
  return {
    expectedSource,
    mismatchBlocker: {
      scope: "launch_configuration" as const,
      kind: "user_fixable" as const,
      code,
    },
  };
}

function source<OwnerDomain extends "hotel_catalog" | "booking" | "pms" | "finance">(
  ownerDomain: OwnerDomain,
  entityType: string,
  entityId: string,
  revision: string,
) {
  return { ownerDomain, entityType, entityId, revision } as const;
}

function provider(ownerEvidence: ReturnType<typeof readyEvidence>) {
  const port = <Port extends BookingLaunchReadinessPortKey>(
    portKey: Port,
    result: BookingLaunchOwnerEvidenceResult<Port>,
  ) => ({
    bookingLaunchEvidencePort: portKey,
    async getBookingLaunchEvidence() {
      return structuredClone(result);
    },
  });
  return createBookingLaunchReadinessProvider({
    catalog: port("catalog", ownerEvidence.catalog),
    booking: port("booking", ownerEvidence.booking),
    pms: port("pms", ownerEvidence.pms),
    finance: port("finance", ownerEvidence.finance),
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
}
