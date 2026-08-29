import { describe, expect, it } from "vitest";

import {
  combinedResourceStatus,
  mergePlannedOrganizations,
  oldest,
  organizationCandidates,
  organizationStatus,
  selectTargetOrSourceOrganization,
} from "./productionIdentityOwnershipPolicy.js";
import type {
  ExistingOwnershipState,
  PlannedOrganization,
} from "./productionIdentityOwnershipSource.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

describe("production ownership freshness policy", () => {
  it("keeps all scalar fields from the coherent fresher organization row", () => {
    const older = organization({
      name: "Target name",
      slug: "target-name",
      status: "suspended",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    const newer = organization({
      name: "New source name",
      slug: "new-source-name",
      status: "active",
      createdAt: "2026-01-15T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    expect(mergePlannedOrganizations(older, newer)).toEqual({
      ...newer,
      createdAt: older.createdAt,
    });
  });

  it("fails closed when equally fresh groups disagree on scalar identity", () => {
    const left = organization({ name: "One" });
    const equivalent = { ...left, updatedAt: "2026-02-01T00:00:00+00:00" };
    expect(mergePlannedOrganizations(left, equivalent)).toEqual(
      mergePlannedOrganizations(equivalent, left),
    );
    expect(mergePlannedOrganizations(left, equivalent)?.updatedAt).toBe("2026-02-01T00:00:00.000Z");
    const right = { ...equivalent, name: "Two" };
    expect(mergePlannedOrganizations(left, right)).toBeNull();
    expect(mergePlannedOrganizations(right, left)).toBeNull();
  });

  it("fails closed when equal-instant target and source state disagree", () => {
    const source = organization({ name: "Source" });
    const target = { ...source, name: "Target", updatedAt: "2026-02-01T00:00:00+00:00" };
    expect(selectTargetOrSourceOrganization(target, source)).toBeNull();
  });

  it("orders timestamp offsets by instant rather than text", () => {
    expect(oldest(["2026-01-01T01:00:00+02:00", "2025-12-31T23:30:00Z"])).toBe(
      "2025-12-31T23:00:00.000Z",
    );
  });

  it("maps stale user states consistently through organization resources", () => {
    expect(organizationStatus("deleted")).toBe("archived");
    expect(combinedResourceStatus("active", "suspended")).toBe("suspended");
    expect(combinedResourceStatus("archived", "active")).toBe("archived");
  });

  it("does not treat delegated membership as ownership evidence", () => {
    const existing: ExistingOwnershipState = {
      organizations: [
        {
          id: ORG_ID,
          kind: "hotel_group",
          name: "Group",
          slug: "group",
          status: "active",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      memberships: [
        {
          organizationId: ORG_ID,
          userId: "user",
          status: "active",
          roleKey: "hotel_owner",
          propertyAccessMode: "all",
          accessOrigin: "external_owner",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      resourceLinks: [],
    };
    expect(organizationCandidates("user", "hotel_group", [], existing)).toEqual(new Set());
    existing.memberships[0]!.accessOrigin = "agency";
    existing.memberships[0]!.roleKey = "front_desk";
    expect(organizationCandidates("user", "hotel_group", [], existing)).toEqual(new Set());
    existing.memberships[0]!.roleKey = "hotel_owner";
    expect(organizationCandidates("user", "hotel_group", [], existing)).toEqual(new Set([ORG_ID]));
  });
});

function organization(overrides: Partial<PlannedOrganization>): PlannedOrganization {
  return {
    id: ORG_ID,
    kind: "hotel_group",
    name: "Hotel group",
    slug: "hotel-group",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}
