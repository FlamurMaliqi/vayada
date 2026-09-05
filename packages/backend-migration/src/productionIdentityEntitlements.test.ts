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

  it.each([
    ["2026-01-15T00:00:00.000Z", UPDATED],
    [UPDATED, UPDATED],
    ["2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
  ])(
    "lets a source access-ending state close active target access from %s",
    (targetUpdatedAt, expectedUpdatedAt) => {
      const archivedResource = {
        ...resource("marketplace", "hotel_profile"),
        status: "archived" as const,
      };
      const source = planIdentityEntitlements([], [archivedResource]);
      const target: ExistingEntitlement = {
        ...source.entitlements[0]!,
        status: "active",
        updatedAt: targetUpdatedAt,
      };

      const plan = planIdentityEntitlements([], [archivedResource], [target]);

      expect(plan.blockers).toEqual([]);
      expect(plan.entitlements[0]).toMatchObject({
        status: "expired",
        updatedAt: expectedUpdatedAt,
      });
    },
  );

  it.each(["2026-01-15T00:00:00.000Z", UPDATED, "2026-03-01T00:00:00.000Z"])(
    "does not reactivate target access ending at %s",
    (targetUpdatedAt) => {
      const activeResource = resource("marketplace", "hotel_profile");
      const source = planIdentityEntitlements([], [activeResource]);
      const target: ExistingEntitlement = {
        ...source.entitlements[0]!,
        status: "suspended",
        updatedAt: targetUpdatedAt,
      };

      const plan = planIdentityEntitlements([], [activeResource], [target]);

      expect(plan.blockers).toEqual([]);
      expect(plan.entitlements).toEqual([target]);
    },
  );

  it.each(["2026-01-15T00:00:00.000Z", UPDATED, "2026-03-01T00:00:00.000Z"])(
    "preserves an existing access-ending representation from %s",
    (targetUpdatedAt) => {
      const archivedResource = {
        ...resource("marketplace", "hotel_profile"),
        status: "archived" as const,
      };
      const source = planIdentityEntitlements([], [archivedResource]);
      const target: ExistingEntitlement = {
        ...source.entitlements[0]!,
        status: "suspended",
        updatedAt: targetUpdatedAt,
      };

      const plan = planIdentityEntitlements([], [archivedResource], [target]);

      expect(plan.blockers).toEqual([]);
      expect(plan.entitlements).toEqual([target]);
    },
  );

  it("still blocks conflicting access-ending entitlement details", () => {
    const archivedResource = {
      ...resource("marketplace", "hotel_profile"),
      status: "archived" as const,
    };
    const source = planIdentityEntitlements([], [archivedResource]);
    const target: ExistingEntitlement = {
      ...source.entitlements[0]!,
      status: "suspended",
      metadata: { source: "unrelated_target" },
    };

    const plan = planIdentityEntitlements([], [archivedResource], [target]);

    expect(plan.blockers.map((row) => row.code)).toContain("ENTITLEMENT_STATE_CONFLICT");
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
      [{ ...equivalent, metadata: { ...equivalent.metadata, unexpected: true } }],
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
