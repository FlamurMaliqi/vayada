import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  planIdentityEntitlements,
  type ExistingEntitlement,
} from "./productionIdentityEntitlements.js";
import type { PlannedResourceLink } from "./productionIdentityOwnershipSource.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HOTEL_ID = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-01-01T00:00:00.000Z";
const UPDATED = "2026-02-01T00:00:00.000Z";

describe("production identity entitlements", () => {
  it("derives product and PMS module entitlements from accepted resources", () => {
    const plan = planIdentityEntitlements(
      [moduleRow()],
      [
        resource("booking", "booking_hotel"),
        resource("marketplace", "hotel_profile"),
        resource("pms", "pms_hotel"),
      ],
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.entitlements.map((row) => row.entitlementKey).sort()).toEqual([
      "booking-engine",
      "marketplace-hotel-profile",
      "pms-core",
    ]);
  });

  it("preserves complete newer target entitlement state", () => {
    const source = planIdentityEntitlements([moduleRow()], [resource("pms", "pms_hotel")]);
    const target: ExistingEntitlement = {
      ...source.entitlements[0]!,
      status: "suspended",
      startsAt: null,
      metadata: { source: "target", reviewed: true },
      updatedAt: "2026-03-01T00:00:00.000Z",
    };

    const plan = planIdentityEntitlements([moduleRow()], [resource("pms", "pms_hotel")], [target]);

    expect(plan.blockers).toEqual([]);
    expect(plan.entitlements).toEqual([target]);
  });

  it("does not let newer access-ending state lose to a stale target", () => {
    const januaryModule = moduleRow({ updated_at: "2026-01-15T00:00:00.000Z" });
    const archivedResource = {
      ...resource("pms", "pms_hotel"),
      status: "archived" as const,
      updatedAt: "2026-03-01T00:00:00.000Z",
    };
    const retiredModule = moduleRow({
      is_active: false,
      deactivated_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-01-15T00:00:00.000Z",
    });
    const scenarios = [
      (existing: ExistingEntitlement[] = []) =>
        planIdentityEntitlements([januaryModule], [archivedResource], existing),
      (existing: ExistingEntitlement[] = []) =>
        planIdentityEntitlements([retiredModule], [resource("pms", "pms_hotel")], existing),
    ];
    for (const scenario of scenarios) {
      const source = scenario();
      const staleTarget = {
        ...source.entitlements[0]!,
        status: "active" as const,
        expiresAt: null,
        updatedAt: "2026-02-01T00:00:00.000Z",
      };
      const plan = scenario([staleTarget]);
      expect(plan.blockers).toEqual([]);
      expect(plan.entitlements[0]?.status).toBe("expired");
      expect(plan.entitlements[0]?.updatedAt).toBe("2026-03-01T00:00:00.000Z");
    }
  });

  it("blocks orphan and contradictory module activation state", () => {
    const contradictory = moduleRow({ deactivated_at: UPDATED });
    const orphan = moduleRow({ hotel_id: "33333333-3333-4333-8333-333333333333" });
    const plan = planIdentityEntitlements([contradictory, orphan], [resource("pms", "pms_hotel")]);

    expect(plan.entitlements).toEqual([]);
    expect(plan.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining(["INVALID_SOURCE_ROW", "ORPHAN_ENTITLEMENT"]),
    );
  });

  it("canonicalizes equal-time timestamps and JSON but blocks genuine disagreement", () => {
    const source = planIdentityEntitlements([moduleRow()], [resource("pms", "pms_hotel")]);
    const equivalent: ExistingEntitlement = {
      ...source.entitlements[0]!,
      startsAt: "2026-01-01T00:00:00+00:00",
      metadata: { moduleId: "pms-core", source: "pms.property_module_activations" },
      updatedAt: "2026-02-01T00:00:00+00:00",
    };
    const accepted = planIdentityEntitlements(
      [moduleRow()],
      [resource("pms", "pms_hotel")],
      [equivalent],
    );
    expect(accepted.blockers).toEqual([]);
    expect(accepted.entitlements[0]?.updatedAt).toBe(UPDATED);
    const rejected = planIdentityEntitlements(
      [moduleRow()],
      [resource("pms", "pms_hotel")],
      [{ ...equivalent, status: "expired" }],
    );
    expect(rejected.blockers.map((row) => row.code)).toContain("ENTITLEMENT_STATE_CONFLICT");
  });
});

function resource(product: string, resourceType: string): PlannedResourceLink {
  return {
    organizationId: ORG_ID,
    product,
    resourceType,
    resourceId: HOTEL_ID,
    relationship: product === "pms" ? "operator" : "owner",
    status: "active",
    createdAt: CREATED,
    updatedAt: UPDATED,
  };
}

function moduleRow(overrides: Record<string, unknown> = {}): IdentitySourceRow {
  return {
    sourceDatabase: "pms",
    sourceTable: "property_module_activations",
    rowOrdinal: 1,
    data: {
      hotel_id: HOTEL_ID,
      module_id: "pms-core",
      is_active: true,
      activated_at: CREATED,
      deactivated_at: null,
      updated_at: UPDATED,
      ...overrides,
    },
  };
}
