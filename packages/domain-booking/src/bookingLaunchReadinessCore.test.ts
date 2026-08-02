import { describe, expect, it } from "vitest";

import type {
  BookingLaunchOwnerEvidence,
  BookingLaunchReadinessEntityContribution,
  BookingLaunchReadinessGroupId,
  BookingLaunchReadinessPortKey,
  BookingLaunchSourceBinding,
} from "./bookingLaunchEvidence.js";
import { createBookingLaunchReadinessProvider } from "./bookingLaunchReadiness.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "20000000-0000-4000-8000-000000000002";
const now = () => new Date("2026-08-02T12:00:00.000Z");

const sources = {
  profile: source("hotel_catalog", "property_profile", propertyId, "profile:7"),
  design: source("booking", "design_revision", propertyId, "design:3"),
  guest: source("booking", "guest_policy_confirmation", propertyId, "guest:4"),
  room: source("pms", "room_snapshot", "room-a", "room:5"),
  pricing: source("pms", "pricing_snapshot", propertyId, "pricing:8"),
  calendar: source("pms", "calendar_snapshot", propertyId, "calendar:9"),
  payments: source("finance", "payment_launch_gate", propertyId, "payments:4"),
};

describe("Booking launch readiness core composition", () => {
  it("returns all seven ready groups with order-independent identities", async () => {
    const original = await provider(readyEvidence()).getBookingReadiness({
      organizationId,
      propertyId,
    });
    const reorderedEvidence = readyEvidence();
    reorderedEvidence.pms.sources.reverse();
    reorderedEvidence.pms.entities.reverse();
    const reordered = await provider(reorderedEvidence).getBookingReadiness({
      organizationId,
      propertyId,
    });

    expect(original).toMatchObject({ outcome: "evaluated", product: "booking", status: "ready" });
    expect(reordered).toMatchObject({ outcome: "evaluated", status: "ready" });
    if (original.outcome !== "evaluated" || reordered.outcome !== "evaluated") return;
    expect(original.groups).toHaveLength(7);
    expect(reordered.sourceManifestHash).toBe(original.sourceManifestHash);
    expect(reordered.readinessHash).toBe(original.readinessHash);
  });

  it("changes identity for either an owner revision or a matched dependency change", async () => {
    const originalEvidence = readyEvidence();
    const revisedEvidence = readyEvidence();
    const nextPricing = { ...sources.pricing, revision: "pricing:9" };
    revisedEvidence.pms.sources = revisedEvidence.pms.sources.map((item) =>
      item.entityType === sources.pricing.entityType ? nextPricing : item,
    );
    revisedEvidence.pms.entities = revisedEvidence.pms.entities.map((item) =>
      item.groupId === "booking.pricing" ? { ...item, source: nextPricing } : item,
    );

    const reboundEvidence = readyEvidence();
    reboundEvidence.booking.entities = reboundEvidence.booking.entities.map((item) =>
      item.groupId === "booking.page_style"
        ? { ...item, bindings: [binding(sources.room, "design_source_stale")] }
        : item,
    );
    const [original, revised, rebound] = await Promise.all(
      [originalEvidence, revisedEvidence, reboundEvidence].map((evidence) =>
        provider(evidence).getBookingReadiness({ organizationId, propertyId }),
      ),
    );

    expect(original).toMatchObject({ outcome: "evaluated", status: "ready" });
    expect(revised).toMatchObject({ outcome: "evaluated", status: "ready" });
    expect(rebound).toMatchObject({ outcome: "evaluated", status: "ready" });
    if (
      original.outcome !== "evaluated" ||
      revised.outcome !== "evaluated" ||
      rebound.outcome !== "evaluated"
    )
      return;
    expect(revised.sourceManifestHash).not.toBe(original.sourceManifestHash);
    expect(revised.readinessHash).not.toBe(original.readinessHash);
    expect(rebound.sourceManifestHash).not.toBe(original.sourceManifestHash);
    expect(rebound.readinessHash).not.toBe(original.readinessHash);
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
        entity("booking.guest_experience", sources.guest),
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
      [sources.payments],
      [entity("booking.payments", sources.payments)],
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
    result: BookingLaunchOwnerEvidence<Port>,
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
    now,
  });
}
