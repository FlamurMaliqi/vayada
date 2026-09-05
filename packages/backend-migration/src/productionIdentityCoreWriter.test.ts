import { describe, expect, it } from "vitest";

import {
  type CoreIdentityWritePlan,
  writeProductionIdentityCore,
} from "./productionIdentityCoreWriter.js";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-01-01T00:00:00.000Z";

describe("production identity core writer", () => {
  it("refuses blockers before issuing writes", async () => {
    const client = new RecordingClient();
    const plan = emptyPlan();
    plan.blockers.push({ code: "STALE", source: "identity.users", sourceId: USER, message: "x" });

    await expect(writeProductionIdentityCore(client as never, plan)).rejects.toThrow(
      "Refusing to write a blocked identity plan",
    );
    expect(client.calls).toEqual([]);
  });

  it("writes dependency order with strict freshness guards and explicit provenance", async () => {
    const client = new RecordingClient();
    const plan = populatedPlan();

    await writeProductionIdentityCore(client as never, plan);

    expect(client.calls.map((call) => table(call.sql))).toEqual([
      "identity.users",
      "identity.organizations",
      "identity.organization_memberships",
      "identity.organization_resource_links",
      "identity.product_entitlements",
    ]);
    expect(
      client.calls.every((call) => call.sql.includes("updated_at < EXCLUDED.updated_at")),
    ).toBe(true);
    expect(client.calls.every((call) => !call.sql.includes("updated_at <="))).toBe(true);
    const membershipSql = client.calls[2]!.sql;
    expect(membershipSql).toContain("access_origin");
    expect(membershipSql).not.toContain("access_origin = EXCLUDED.access_origin");
    const entitlementSql = client.calls[4]!.sql;
    expect(entitlementSql).toContain("identity.product_entitlements.status = 'active'");
    expect(entitlementSql).toContain("EXCLUDED.status IN ('suspended', 'expired')");
    expect(JSON.parse(client.calls[0]!.values[0] as string)).toEqual(plan.users);
  });

  it("skips empty table batches", async () => {
    const client = new RecordingClient();
    await writeProductionIdentityCore(client as never, emptyPlan());
    expect(client.calls).toEqual([]);
  });
});

class RecordingClient {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  async query(sql: string, values: unknown[]): Promise<{ rows: never[] }> {
    this.calls.push({ sql, values });
    return { rows: [] };
  }
}

function emptyPlan(): CoreIdentityWritePlan {
  return {
    users: [],
    organizations: [],
    memberships: [],
    resourceLinks: [],
    entitlements: [],
    blockers: [],
  };
}

function populatedPlan(): CoreIdentityWritePlan {
  return {
    ...emptyPlan(),
    users: [
      {
        id: USER,
        email: "owner@example.com",
        name: "Owner",
        sourceStatus: "verified",
        status: "active",
        type: "hotel",
        emailVerified: true,
        isSuperadmin: false,
        disposition: "migrate",
        createdAt: CREATED,
        updatedAt: CREATED,
        termsAcceptedAt: null,
        termsVersion: null,
        privacyAcceptedAt: null,
        privacyVersion: null,
        marketingConsent: false,
        marketingConsentAt: null,
      },
    ],
    organizations: [
      {
        id: ORG,
        kind: "hotel_group",
        name: "Hotel",
        slug: "hotel",
        status: "active",
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    memberships: [
      {
        organizationId: ORG,
        userId: USER,
        status: "active",
        roleKey: "hotel_owner",
        propertyAccessMode: "all",
        accessOrigin: "agency",
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    resourceLinks: [
      {
        organizationId: ORG,
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: ORG,
        relationship: "owner",
        status: "active",
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    entitlements: [
      {
        organizationId: ORG,
        product: "booking",
        entitlementKey: "booking-engine",
        status: "active",
        resourceProduct: "booking",
        resourceType: "booking_hotel",
        resourceId: ORG,
        startsAt: null,
        expiresAt: null,
        metadata: { source: "legacy_ownership" },
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
  };
}

function table(sql: string): string {
  return /INSERT INTO ([a-z_.]+)/.exec(sql)?.[1] ?? "";
}
