import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { readProductionIdentityTargetState } from "./productionIdentityTargetReader.js";

const USER = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const OTHER_EVENT = "33333333-3333-4333-8333-333333333333";
const CREATED = "2026-01-01T00:00:00.000Z";

describe("production identity target reader", () => {
  it("loads every freshness/provenance field and scopes append-only audit collisions", async () => {
    const fixture = new TargetFixture();
    const sourceRows = [login(EVENT), login(EVENT), login("not-a-uuid")];

    const state = await readProductionIdentityTargetState(fixture as never, sourceRows);

    expect(state.users).toHaveLength(1);
    expect(state.workosIdentities).toHaveLength(1);
    expect(state.ownership.memberships[0]).toMatchObject({
      status: "suspended",
      roleKey: "hotel_owner",
      accessOrigin: "external_owner",
      updatedAt: CREATED,
    });
    expect(state.ownership.resourceLinks[0]).toMatchObject({ status: "suspended" });
    expect(state.entitlements[0]).toMatchObject({
      status: "suspended",
      metadata: { source: "target" },
    });
    expect(state.privacy.cookieConsents[0]).toMatchObject({ necessary: false });
    expect(state.auditEvents).toEqual([
      expect.objectContaining({ product: "identity", auditKey: `legacy-auth-login:${EVENT}` }),
      { id: OTHER_EVENT, product: "booking", auditKey: "booking:event" },
    ]);
    const auditCall = fixture.calls.find((call) => call.sql.includes("product_audit_events"))!;
    expect(auditCall.values).toEqual([[`legacy-auth-login:${EVENT}`], [EVENT]]);
    expect(
      fixture.calls.find((call) => call.sql.includes("organization_memberships"))?.sql,
    ).toContain("access_origin");
  });
});

class TargetFixture {
  calls: Array<{ sql: string; values?: unknown[] }> = [];
  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    const rows = response(sql);
    return { rows: rows as T[] };
  }
}

function response(sql: string): unknown[] {
  if (sql.includes("FROM identity.user_consent_status")) return [];
  if (sql.includes("FROM identity.cookie_consents"))
    return [
      {
        id: EVENT,
        visitorId: "v",
        userId: USER,
        necessary: false,
        functional: false,
        analytics: false,
        marketing: false,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ];
  if (sql.includes("FROM identity.consent_history")) return [];
  if (sql.includes("FROM identity.gdpr_requests")) return [];
  if (sql.includes("FROM identity.external_identities"))
    return [{ userId: USER, providerUserId: "user_workos_verified" }];
  if (sql.includes("FROM identity.organization_memberships"))
    return [
      {
        organizationId: EVENT,
        userId: USER,
        status: "suspended",
        roleKey: "hotel_owner",
        propertyAccessMode: "all",
        accessOrigin: "external_owner",
        updatedAt: CREATED,
      },
    ];
  if (sql.includes("FROM identity.organization_resource_links"))
    return [
      {
        organizationId: EVENT,
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: EVENT,
        relationship: "owner",
        status: "suspended",
        updatedAt: CREATED,
      },
    ];
  if (sql.includes("FROM identity.organizations"))
    return [
      {
        id: EVENT,
        kind: "hotel_group",
        name: "Target",
        slug: "target",
        status: "suspended",
        updatedAt: CREATED,
      },
    ];
  if (sql.includes("FROM identity.product_entitlements"))
    return [
      {
        organizationId: EVENT,
        product: "booking",
        entitlementKey: "booking-engine",
        status: "suspended",
        resourceProduct: "booking",
        resourceType: "booking_hotel",
        resourceId: EVENT,
        startsAt: null,
        expiresAt: null,
        metadata: { source: "target" },
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ];
  if (sql.includes("FROM platform.product_audit_events"))
    return [audit("identity", EVENT), audit("booking", OTHER_EVENT)];
  if (sql.includes("FROM identity.users"))
    return [
      {
        id: USER,
        email: "owner@example.com",
        name: "Owner",
        status: "suspended",
        updatedAt: CREATED,
      },
    ];
  return [];
}

function audit(product: string, id: string) {
  return {
    id,
    auditKey: product === "identity" ? `legacy-auth-login:${EVENT}` : "booking:event",
    product,
    action: "auth.login.succeeded",
    actionVersion: 1,
    occurredAt: CREATED,
    recordedAt: CREATED,
    tenantScope: "migration",
    organizationId: null,
    propertyId: null,
    actorType: "user",
    actorUserId: USER,
    targetResourceProduct: "identity",
    targetResourceType: "user",
    targetResourceId: USER,
    secondaryResourceProduct: null,
    secondaryResourceType: null,
    secondaryResourceId: null,
    domainEventId: null,
    externalWebhookEventId: null,
    jobId: null,
    idempotencyKeyId: null,
    correlationId: null,
    causationId: null,
    redactedPayload: {},
    privatePayload: {},
    auditMetadata: { source: "auth.login_audit_log" },
    retentionClass: "security",
    privacyScope: "restricted",
    aiVisible: false,
  };
}
function login(id: string): IdentitySourceRow {
  return { sourceDatabase: "auth", sourceTable: "login_audit_log", rowOrdinal: 1, data: { id } };
}
