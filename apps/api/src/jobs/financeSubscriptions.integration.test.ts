import { readFile } from "node:fs/promises";

import type { StripeSubscriptionSnapshot } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinanceSubscriptionWebhookStore,
  type FinanceSubscriptionWebhookPayload,
} from "./financeSubscriptions.js";
import { readPropertyPlan } from "../domains/propertyPlanReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationA = "f2000000-0000-4000-8000-000000001120";
const organizationB = "f2000000-0000-4000-8000-000000001121";
const propertyId = "f3000000-0000-4000-8000-000000001120";
const propertyB = "f3000000-0000-4000-8000-000000001121";
const entitlementMigration = await readFile(
  new URL(
    "../../../../packages/backend-migration/migrations/0089_direct_booking_finance_entitlements.sql",
    import.meta.url,
  ),
  "utf8",
);

describe.skipIf(!TEST_DATABASE_URL)("Finance subscription webhook PostgreSQL scoping", () => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 2,
  });
  const store = createPgFinanceSubscriptionWebhookStore(pool);

  beforeAll(() => assertSafeTestDatabase(TEST_DATABASE_URL!));

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
         ($1::uuid, 'hotel_group', 'VAY-1120 Integration A', 'vay-1120-integration-a', 'active'),
         ($2::uuid, 'hotel_group', 'VAY-1120 Integration B', 'vay-1120-integration-b', 'active')`,
      [organizationA, organizationB],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay-1120-integration-property', 'VAY-1120 Integration Property'),
              ($2::uuid, 'vay-1296-integration-property-b', 'VAY-1296 Integration Property B')`,
      [propertyId, propertyB],
    );
    await pool.query(
      `INSERT INTO finance.billing_entitlements
         (organization_id, property_id, product, entitlement_key, billing_status,
          plan_key, billing_provider, checkout_session_ref, source_system)
       VALUES
         ($1::uuid, $3::uuid, 'booking', 'direct-booking-finance', 'active',
          'commission', 'stripe', 'cs_vay1120_a', 'finance'),
         ($2::uuid, $3::uuid, 'booking', 'direct-booking-finance', 'active',
          'commission', 'stripe', 'cs_vay1120_b', 'finance'),
         ($1::uuid, $3::uuid, 'pms', 'unrelated-finance-entitlement', 'active',
          'commission', 'stripe', 'cs_vay1120_unrelated', 'finance')`,
      [organizationA, organizationB, propertyId],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("links only the exact organization, product, entitlement key, and Checkout session", async () => {
    const payload = checkoutPayload();
    await expect(store.findEntitlement(payload)).resolves.toMatchObject({
      organizationId: organizationA,
      propertyId,
      checkoutSessionRef: "cs_vay1120_a",
    });

    await expect(
      store.recordCheckoutCompleted({
        payload,
        snapshot: subscriptionSnapshot(),
        activeRoomCount: 3,
      }),
    ).resolves.toMatchObject({
      organizationId: organizationA,
      subscriptionRef: "sub_vay1120_a",
    });

    await expect(
      store.applySubscriptionSnapshot({
        payload: {
          ...payload,
          eventType: "invoice.paid",
          rawEventId: "evt_vay1120_paid_a",
          eventCreated: payload.eventCreated + 1,
          objectId: "in_vay1120_a",
          checkoutSessionId: null,
        },
        snapshot: subscriptionSnapshot(),
        transition: "paid",
        activeRoomCount: 3,
      }),
    ).resolves.toMatchObject({
      organizationId: organizationA,
      planKey: "fixed",
      subscriptionRef: "sub_vay1120_a",
    });

    const rows = await pool.query<{
      organizationId: string;
      product: string;
      entitlementKey: string;
      subscriptionRef: string | null;
      planKey: string | null;
    }>(
      `SELECT organization_id::text AS "organizationId", product,
         entitlement_key AS "entitlementKey", billing_subscription_ref AS "subscriptionRef",
         plan_key AS "planKey"
       FROM finance.billing_entitlements
       WHERE property_id = $1::uuid
       ORDER BY organization_id, product`,
      [propertyId],
    );
    expect(rows.rows).toEqual([
      {
        organizationId: organizationA,
        product: "booking",
        entitlementKey: "direct-booking-finance",
        planKey: "fixed",
        subscriptionRef: "sub_vay1120_a",
      },
      {
        organizationId: organizationA,
        product: "pms",
        entitlementKey: "unrelated-finance-entitlement",
        planKey: "commission",
        subscriptionRef: null,
      },
      {
        organizationId: organizationB,
        product: "booking",
        entitlementKey: "direct-booking-finance",
        planKey: "commission",
        subscriptionRef: null,
      },
    ]);

    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      organizationId: organizationA,
      status: "active",
      resourceProduct: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
    });
  });

  it("projects Finance billing lifecycle state into one linked Identity entitlement", async () => {
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "active",
    });

    await setBillingStatus("past_due");
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "suspended",
    });

    await pool.query(
      `INSERT INTO finance.billing_entitlements
         (organization_id, property_id, product, entitlement_key, billing_status,
          plan_key, billing_provider, source_system, updated_at)
       VALUES ($1::uuid, $2::uuid, 'booking', 'direct-booking-finance',
         'active', 'commission', 'none', 'finance', now())
       ON CONFLICT (organization_id, product, entitlement_key, (COALESCE(property_id::text, '')))
       DO UPDATE SET updated_at = EXCLUDED.updated_at`,
      [organizationA, propertyId],
    );
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      status: "suspended",
    });

    await setBillingStatus("active", "2026-08-12T12:00:00.000Z");
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "expired",
    });

    await setBillingStatus("canceled");
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      status: "expired",
    });

    await setBillingStatus("active");
    const active = await readIdentityEntitlement(organizationA);
    expect(active).toMatchObject({ billingLinked: true, status: "active", expiresAt: null });
    expect(active?.count).toBe(1);

    const unrelated = await pool.query<{ identityEntitlementId: string | null }>(
      `SELECT identity_entitlement_id::text AS "identityEntitlementId"
       FROM finance.billing_entitlements
       WHERE organization_id = $1::uuid AND product = 'pms'`,
      [organizationA],
    );
    expect(unrelated.rows[0]?.identityEntitlementId).toBeNull();
  });

  it("rejects reparenting and expires authorization when its Finance fact is deleted", async () => {
    await expect(
      pool.query(
        `UPDATE finance.billing_entitlements SET property_id = $3::uuid
         WHERE organization_id = $1::uuid AND property_id = $2::uuid
           AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
        [organizationA, propertyId, propertyB],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_finance_direct_booking_entitlement_scope_immutable",
    });
    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      organizationId: organizationA,
      resourceId: propertyId,
      status: "active",
    });
    await expect(readIdentityEntitlement(organizationA, propertyB)).resolves.toBeNull();

    await pool.query(
      `DELETE FROM finance.billing_entitlements
       WHERE organization_id = $1::uuid AND property_id = $2::uuid
         AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
      [organizationB, propertyId],
    );
    await expect(readIdentityEntitlement(organizationB)).resolves.toMatchObject({
      billingLinked: false,
      organizationId: organizationB,
      status: "expired",
    });
  });

  it("backfills an existing unlinked Finance entitlement when the migration runs", async () => {
    await pool.query(
      `DELETE FROM identity.product_entitlements
       WHERE organization_id = $1::uuid
         AND product = 'booking'
         AND entitlement_key = 'direct-booking-finance'`,
      [organizationA],
    );
    await expect(readIdentityEntitlement(organizationA)).resolves.toBeNull();

    await pool.query(entitlementMigration);

    await expect(readIdentityEntitlement(organizationA)).resolves.toMatchObject({
      billingLinked: true,
      count: 1,
      status: "active",
    });
  });

  it("exposes the active subscription entitlement through property feature limits", async () => {
    await pool.query(
      `DELETE FROM finance.billing_entitlements
       WHERE property_id = $1::uuid
         AND organization_id = $2::uuid
         AND entitlement_key = 'direct-booking-finance'`,
      [propertyId, organizationB],
    );
    await pool.query(
      `UPDATE finance.billing_entitlements
       SET plan_key = 'fixed'
       WHERE property_id = $1::uuid
         AND organization_id = $2::uuid
         AND entitlement_key = 'direct-booking-finance'`,
      [propertyId, organizationA],
    );

    await expect(readPropertyPlan(pool, propertyId)).resolves.toMatchObject({
      propertyId,
      plan: "fixed",
      limits: {
        maxRoomPhotosPerType: 15,
        maxAddons: 9,
        guestContactAccess: "always",
      },
    });
  });

  async function cleanup() {
    await pool.query(
      `DELETE FROM finance.billing_entitlements
       WHERE property_id = $1::uuid OR organization_id = ANY($2::uuid[])`,
      [propertyId, [organizationA, organizationB]],
    );
    await pool.query(
      `DELETE FROM identity.product_entitlements
       WHERE organization_id = ANY($1::uuid[])
         AND product = 'booking'
         AND entitlement_key = 'direct-booking-finance'`,
      [[organizationA, organizationB]],
    );
    await pool.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
      [propertyId, propertyB],
    ]);
    await pool.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
      [organizationA, organizationB],
    ]);
  }

  async function readIdentityEntitlement(organizationId: string, scopedPropertyId = propertyId) {
    const result = await pool.query<{
      billingLinked: boolean;
      count: number;
      expiresAt: string | null;
      organizationId: string;
      resourceId: string;
      resourceProduct: string;
      resourceType: string;
      status: string;
    }>(
      `SELECT EXISTS (
           SELECT 1 FROM finance.billing_entitlements billing
           WHERE billing.identity_entitlement_id = identity.id
         ) AS "billingLinked", count(*) OVER ()::int AS count,
         identity.organization_id::text AS "organizationId", identity.expires_at::text AS "expiresAt",
         identity.resource_id AS "resourceId", identity.resource_product AS "resourceProduct",
         identity.resource_type AS "resourceType", identity.status
       FROM identity.product_entitlements identity
       WHERE identity.organization_id = $1::uuid AND identity.product = 'booking'
         AND identity.entitlement_key = 'direct-booking-finance'
         AND identity.resource_product = 'pms' AND identity.resource_type = 'pms_property'
         AND identity.resource_id = $2`,
      [organizationId, scopedPropertyId],
    );
    return result.rows[0] ?? null;
  }

  async function setBillingStatus(status: string, expiresAt: string | null = null): Promise<void> {
    await pool.query(
      `UPDATE finance.billing_entitlements
       SET billing_status = $3, expires_at = $4::timestamptz
       WHERE organization_id = $1::uuid AND property_id = $2::uuid
         AND product = 'booking' AND entitlement_key = 'direct-booking-finance'`,
      [organizationA, propertyId, status, expiresAt],
    );
  }
});

function checkoutPayload(): FinanceSubscriptionWebhookPayload {
  return {
    provider: "stripe",
    eventType: "checkout.session.completed",
    rawEventId: "evt_vay1120_checkout_a",
    eventCreated: 1_786_363_200,
    objectId: "cs_vay1120_a",
    subscriptionId: "sub_vay1120_a",
    checkoutSessionId: "cs_vay1120_a",
    propertyId,
    organizationId: organizationA,
    customerId: "cus_vay1120_a",
  };
}

function subscriptionSnapshot(): StripeSubscriptionSnapshot {
  return {
    subscriptionId: "sub_vay1120_a",
    customerId: "cus_vay1120_a",
    status: "active",
    propertyId,
    organizationId: organizationA,
    fixedPlanVerified: true,
    currentPeriodStart: "2026-08-11T12:00:00.000Z",
    currentPeriodEnd: "2026-09-10T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    subscriptionItemId: "si_vay1120_a",
  };
}

function assertSafeTestDatabase(connectionString: string): void {
  const parsed = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Finance subscription integration tests require a local PostgreSQL database");
  }
  const databaseName = parsed.pathname.slice(1).toLowerCase();
  if (!databaseName.includes("test")) {
    throw new Error("Finance subscription integration database name must identify a test database");
  }
}
