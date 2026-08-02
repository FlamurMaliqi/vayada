import { describe, expect, it } from "vitest";

import {
  BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE,
  type BookingLaunchOwnerEvidence,
  type BookingLaunchOwnerEvidenceResult,
  type BookingLaunchReadinessEntityContribution,
  type BookingLaunchReadinessGroupId,
  type BookingLaunchReadinessPortKey,
  type BookingLaunchSourceBinding,
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
};

describe("Booking launch readiness safety", () => {
  it("returns generic failures for unavailable, malformed, and throwing owners", async () => {
    const unavailable = await provider(readyEvidence(), {
      finance: { outcome: "unavailable", port: "finance", errorSource: "provider" },
    }).getBookingReadiness({ organizationId, propertyId });
    const wrongProperty = readyEvidence();
    wrongProperty.booking.propertyId = "different-property";
    const malformed = await provider(wrongProperty).getBookingReadiness({
      organizationId,
      propertyId,
    });
    const throwing = await provider(
      readyEvidence(),
      {},
      "database password=hunter2",
    ).getBookingReadiness({ organizationId, propertyId });

    expect(unavailable).toMatchObject({
      outcome: "provider_failure",
      error: { errorSource: "provider", code: "booking_readiness_owner_unavailable" },
    });
    expect(malformed).toMatchObject({
      outcome: "provider_failure",
      error: { code: "booking_readiness_evidence_invalid" },
    });
    expect(throwing).toMatchObject({
      outcome: "provider_failure",
      error: { errorSource: "system", code: "booking_readiness_owner_unavailable" },
    });
    expect(JSON.stringify(throwing)).not.toContain("hunter2");
  });

  it.each([
    null,
    { outcome: "unexpected", port: "finance" },
    {
      outcome: "unavailable",
      port: "finance",
      errorSource: "postgres_connection_string=password-hunter2",
    },
    { outcome: "evidence", port: "finance", sources: null, entities: [] },
  ])("fails closed for an untrusted resolved owner result", async (value) => {
    const result = await provider(readyEvidence(), {
      finance: value as BookingLaunchOwnerEvidenceResult<"finance">,
    }).getBookingReadiness({ organizationId, propertyId });

    expect(result).toMatchObject({
      outcome: "provider_failure",
      error: { errorSource: "provider", code: "booking_readiness_evidence_invalid" },
    });
    expect(JSON.stringify(result)).not.toContain("password-hunter2");
  });

  it("freezes a separate authorized request snapshot for every owner", async () => {
    const ownerEvidence = readyEvidence();
    const seen: string[] = [];
    let mutationSucceeded = true;
    const record = (request: { organizationId: string }) => seen.push(request.organizationId);
    const result = await createBookingLaunchReadinessProvider({
      catalog: {
        bookingLaunchEvidencePort: "catalog",
        async getBookingLaunchEvidence(request) {
          record(request);
          mutationSucceeded = Reflect.set(request, "organizationId", "other-organization");
          return structuredClone(ownerEvidence.catalog);
        },
      },
      booking: recordingPort("booking", ownerEvidence.booking, record),
      pms: recordingPort("pms", ownerEvidence.pms, record),
      finance: recordingPort("finance", ownerEvidence.finance, record),
      now: fixedNow,
    }).getBookingReadiness({ organizationId, propertyId });

    expect(mutationSucceeded).toBe(false);
    expect(seen).toEqual([organizationId, organizationId, organizationId, organizationId]);
    expect(result).toMatchObject({ outcome: "evaluated", propertyId, status: "ready" });
  });

  it("sanitizes extra source fields before public output and hashing", async () => {
    const baseline = await provider(readyEvidence()).getBookingReadiness({
      organizationId,
      propertyId,
    });
    const evidence = readyEvidence();
    const privateRoom = { ...evidence.pms.sources[0]!, privateDetail: "password=hunter2" };
    evidence.pms.sources[0] = privateRoom;
    evidence.pms.entities[0] = { ...evidence.pms.entities[0]!, source: privateRoom };
    const sanitized = await provider(evidence).getBookingReadiness({ organizationId, propertyId });

    expect(sanitized).toMatchObject({ outcome: "evaluated", status: "ready" });
    expect(JSON.stringify(sanitized)).not.toContain("hunter2");
    if (baseline.outcome !== "evaluated" || sanitized.outcome !== "evaluated") return;
    expect(sanitized.sourceManifestHash).toBe(baseline.sourceManifestHash);
    expect(sanitized.readinessHash).toBe(baseline.readinessHash);
  });

  it("fails closed for missing groups, wrong domains, and reserved provenance", async () => {
    const missing = readyEvidence();
    missing.pms.entities = missing.pms.entities.filter(
      ({ groupId }) => groupId !== "booking.calendar",
    );
    const wrongDomain = readyEvidence();
    wrongDomain.finance.sources[0] = {
      ...wrongDomain.finance.sources[0]!,
      ownerDomain: "pms",
    } as unknown as (typeof wrongDomain.finance.sources)[number];
    const reservedProducer = readyEvidence();
    const reservedDesign = {
      ...sources.design,
      entityType: BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE,
    };
    reservedProducer.booking.sources[0] = reservedDesign;
    reservedProducer.booking.entities[0] = {
      ...reservedProducer.booking.entities[0]!,
      source: reservedDesign,
    };
    const reservedBinding = readyEvidence();
    reservedBinding.pms.entities[2] = {
      ...reservedBinding.pms.entities[2]!,
      bindings: [
        binding(
          source(
            "booking",
            BOOKING_LAUNCH_DERIVED_BINDING_SOURCE_ENTITY_TYPE,
            "derived-source",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
          "calendar_dependency_invalid",
        ),
      ],
    };

    for (const evidence of [missing, wrongDomain, reservedProducer, reservedBinding]) {
      await expect(
        provider(evidence).getBookingReadiness({ organizationId, propertyId }),
      ).resolves.toMatchObject({
        outcome: "provider_failure",
        error: { code: "booking_readiness_evidence_invalid" },
      });
    }
  });

  it("sorts otherwise identical system blockers by error source", async () => {
    const first = readyEvidence();
    const blockers = ["system", "provider"].map((errorSource) => ({
      scope: "launch_configuration" as const,
      kind: "system_error" as const,
      errorSource: errorSource as "system" | "provider",
      code: "owner_unavailable",
    }));
    first.finance.entities[0] = { ...first.finance.entities[0]!, blockers };
    const second = readyEvidence();
    second.finance.entities[0] = {
      ...second.finance.entities[0]!,
      blockers: [...blockers].reverse(),
    };
    const [left, right] = await Promise.all(
      [first, second].map((evidence) =>
        provider(evidence).getBookingReadiness({ organizationId, propertyId }),
      ),
    );

    expect(left).toMatchObject({ outcome: "evaluated", status: "error" });
    expect(right).toMatchObject({ outcome: "evaluated", status: "error" });
    if (left.outcome !== "evaluated" || right.outcome !== "evaluated") return;
    expect(right.sourceManifestHash).toBe(left.sourceManifestHash);
    expect(right.readinessHash).toBe(left.readinessHash);
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

type OwnerOverrides = {
  catalog?: BookingLaunchOwnerEvidenceResult<"catalog">;
  booking?: BookingLaunchOwnerEvidenceResult<"booking">;
  pms?: BookingLaunchOwnerEvidenceResult<"pms">;
  finance?: BookingLaunchOwnerEvidenceResult<"finance">;
};

function provider(
  ownerEvidence: ReturnType<typeof readyEvidence>,
  overrides: OwnerOverrides = {},
  throwingMessage?: string,
) {
  const port = <Port extends BookingLaunchReadinessPortKey>(
    portKey: Port,
    result: BookingLaunchOwnerEvidenceResult<Port>,
    shouldThrow = false,
  ) => ({
    bookingLaunchEvidencePort: portKey,
    async getBookingLaunchEvidence() {
      if (shouldThrow) throw new Error(throwingMessage);
      return structuredClone(result);
    },
  });
  return createBookingLaunchReadinessProvider({
    catalog: port("catalog", overrides.catalog ?? ownerEvidence.catalog),
    booking: port("booking", overrides.booking ?? ownerEvidence.booking, Boolean(throwingMessage)),
    pms: port("pms", overrides.pms ?? ownerEvidence.pms),
    finance: port(
      "finance",
      Object.hasOwn(overrides, "finance") ? overrides.finance! : ownerEvidence.finance,
    ),
    now: fixedNow,
  });
}

function recordingPort<Port extends "booking" | "pms" | "finance">(
  port: Port,
  result: BookingLaunchOwnerEvidenceResult<Port>,
  record: (request: { organizationId: string }) => void,
) {
  return {
    bookingLaunchEvidencePort: port,
    async getBookingLaunchEvidence(request: { organizationId: string }) {
      record(request);
      return structuredClone(result);
    },
  };
}

function fixedNow() {
  return new Date("2026-08-02T12:00:00.000Z");
}
