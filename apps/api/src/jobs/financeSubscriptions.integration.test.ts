import type { StripeSubscriptionSnapshot } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinanceSubscriptionWebhookStore,
  type FinanceSubscriptionWebhookPayload,
} from "./financeSubscriptions.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationA = "f2000000-0000-4000-8000-000000001120";
const organizationB = "f2000000-0000-4000-8000-000000001121";
const propertyId = "f3000000-0000-4000-8000-000000001120";

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
       VALUES ($1::uuid, 'vay-1120-integration-property', 'VAY-1120 Integration Property')`,
      [propertyId],
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
  });

  async function cleanup() {
    await pool.query(
      `DELETE FROM finance.billing_entitlements
       WHERE property_id = $1::uuid OR organization_id = ANY($2::uuid[])`,
      [propertyId, [organizationA, organizationB]],
    );
    await pool.query(`DELETE FROM hotel_catalog.properties WHERE id = $1::uuid`, [propertyId]);
    await pool.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
      [organizationA, organizationB],
    ]);
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
