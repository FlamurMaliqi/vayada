import { describe, expect, it } from "vitest";

import type { IdentitySourceRow, PlannedIdentityUser } from "./productionIdentityDisposition.js";
import { planIdentityOwnership } from "./productionIdentityOwnership.js";
import type { ExistingOwnershipState } from "./productionIdentityOwnershipSource.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_TIME = "2026-02-01T00:00:00.000Z";
const TARGET_TIME = "2026-03-01T00:00:00.000Z";

describe("production identity ownership planning", () => {
  it("reuses one resolved organization and preserves all newer target states", () => {
    const first = planIdentityOwnership([bookingOwner()], [hotelUser()], existingState());
    expect(first.blockers).toEqual([]);
    expect(first.organizations[0]).toMatchObject({
      id: ORG_ID,
      status: "suspended",
      name: "Current group",
    });
    expect(first.memberships[0]).toMatchObject({
      status: "inactive",
      roleKey: "front_desk",
      accessOrigin: "external_owner",
    });
    expect(first.resourceLinks[0]).toMatchObject({ relationship: "operator", status: "archived" });
  });

  it("blocks older delegated provenance and conflicting resource relationships", () => {
    const plan = planIdentityOwnership(
      [bookingOwner()],
      [hotelUser()],
      existingState("2026-01-01T00:00:00.000Z"),
    );
    expect(plan.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MEMBERSHIP_PROVENANCE_CONFLICT", "RESOURCE_RELATIONSHIP_CONFLICT"]),
    );
  });

  it("blocks membership and resource state disagreement at equal freshness", () => {
    const existing = equalTimeState();
    const plan = planIdentityOwnership([bookingOwner()], [hotelUser()], existing);

    expect(plan.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MEMBERSHIP_STATE_CONFLICT", "RESOURCE_STATE_CONFLICT"]),
    );
  });

  it("does not let unrelated resource freshness reactivate access", () => {
    const user = { ...hotelUser(), updatedAt: "2026-01-01T00:00:00.000Z" };
    const owner = bookingOwner();
    owner.data["updated_at"] = "2026-03-01T00:00:00.000Z";
    const existing = existingState("2026-02-01T00:00:00.000Z");
    existing.memberships[0] = {
      ...existing.memberships[0]!,
      roleKey: "hotel_owner",
      propertyAccessMode: "all",
      accessOrigin: "agency",
    };
    existing.resourceLinks[0] = {
      ...existing.resourceLinks[0]!,
      relationship: "owner",
      status: "active",
    };

    const plan = planIdentityOwnership([owner], [user], existing);

    expect(plan.blockers).toEqual([]);
    expect(plan.organizations[0]).toMatchObject({
      name: "Current group",
      status: "suspended",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(plan.memberships[0]).toMatchObject({
      status: "inactive",
      updatedAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("blocks ambiguous tenants, orphan owners, and owner type mismatches", () => {
    const ambiguous = existingState();
    const otherOrganization = { ...ambiguous.organizations[0]!, id: RESOURCE_ID };
    ambiguous.organizations.push(otherOrganization);
    ambiguous.resourceLinks.push({ ...ambiguous.resourceLinks[0]!, organizationId: RESOURCE_ID });
    const orphan = bookingOwner();
    orphan.data["user_id"] = ORG_ID;
    const wrongType = { ...hotelUser(), type: "creator" } as PlannedIdentityUser;
    const codes = [
      ...planIdentityOwnership([bookingOwner()], [hotelUser()], ambiguous).blockers,
      ...planIdentityOwnership([orphan], [hotelUser()]).blockers,
      ...planIdentityOwnership([bookingOwner()], [wrongType]).blockers,
    ].map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining(["AMBIGUOUS_OWNER", "ORPHAN_PRODUCT_USER", "OWNER_TYPE_MISMATCH"]),
    );
  });

  it("adds a separate platform membership for superadmins", () => {
    const superadmin = {
      ...hotelUser(),
      status: "suspended",
      isSuperadmin: true,
    } as PlannedIdentityUser;
    const plan = planIdentityOwnership([], [superadmin]);
    expect(plan.blockers).toEqual([]);
    expect(plan.memberships[0]).toMatchObject({
      roleKey: "platform_admin",
      accessOrigin: "agency",
    });
  });

  it("generates a stable graph independent of source row order", () => {
    const booking = bookingOwner();
    const pms = {
      ...bookingOwner(),
      sourceDatabase: "pms",
      sourceTable: "hotels",
      data: { ...booking.data, id: ORG_ID },
    } as IdentitySourceRow;
    const first = planIdentityOwnership([booking, pms], [hotelUser()]);
    expect(planIdentityOwnership([pms, booking], [hotelUser()])).toEqual(first);
    expect(first.organizations[0]?.id).toBe("dcaad57f-4290-5899-ba7b-786d4a38e4bb");
  });
});

function existingState(updatedAt = TARGET_TIME): ExistingOwnershipState {
  return {
    organizations: [
      {
        id: ORG_ID,
        kind: "hotel_group",
        name: "Current group",
        slug: "current-group",
        status: "suspended",
        updatedAt,
      },
    ],
    memberships: [
      {
        organizationId: ORG_ID,
        userId: USER_ID,
        status: "inactive",
        roleKey: "front_desk",
        propertyAccessMode: "assigned",
        accessOrigin: "external_owner",
        updatedAt,
      },
    ],
    resourceLinks: [
      {
        organizationId: ORG_ID,
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: RESOURCE_ID,
        relationship: "operator",
        status: "archived",
        updatedAt,
      },
    ],
  };
}

function equalTimeState(): ExistingOwnershipState {
  return {
    organizations: [
      {
        id: ORG_ID,
        kind: "hotel_group",
        name: "Legacy Hotel",
        slug: `legacy-hotel-group-${USER_ID}`,
        status: "active",
        updatedAt: "2026-02-01T00:00:00+00:00",
      },
    ],
    memberships: [
      {
        organizationId: ORG_ID,
        userId: USER_ID,
        status: "inactive",
        roleKey: "front_desk",
        propertyAccessMode: "assigned",
        accessOrigin: "agency",
        updatedAt: "2026-02-01T00:00:00+00:00",
      },
    ],
    resourceLinks: [
      {
        organizationId: ORG_ID,
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: RESOURCE_ID,
        relationship: "owner",
        status: "archived",
        updatedAt: "2026-02-01T00:00:00+00:00",
      },
    ],
  };
}

function hotelUser(): PlannedIdentityUser {
  return {
    id: USER_ID,
    email: "owner@example.com",
    name: "Legacy Owner",
    type: "hotel",
    status: "active",
    isSuperadmin: false,
    createdAt: SOURCE_TIME,
    updatedAt: SOURCE_TIME,
  } as PlannedIdentityUser;
}

function bookingOwner(): IdentitySourceRow {
  return {
    sourceDatabase: "booking",
    sourceTable: "booking_hotels",
    rowOrdinal: 1,
    data: {
      id: RESOURCE_ID,
      user_id: USER_ID,
      name: "Legacy Hotel",
      platform_status: "live",
      created_at: SOURCE_TIME,
      updated_at: SOURCE_TIME,
    },
  };
}
