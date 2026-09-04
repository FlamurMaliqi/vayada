import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readProductionFinanceTargetState } from "./productionFinanceTargetReader.js";
import type {
  FinanceTargetRecord,
  ProductionFinancePrerequisites,
} from "./productionFinanceTypes.js";
import {
  writeProductionFinanceDispositions,
  writeProductionFinanceRecords,
} from "./productionFinanceWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const ID = "fa000000-0000-4000-8000-000000000001";
const ORGANIZATION = "fa000000-0000-4000-8000-000000000002";
const PROPERTY = "fa000000-0000-4000-8000-000000000003";
const BILLING = "fa000000-0000-4000-8000-000000000004";
const RUN = "vay1351-0123456789abcdef01234567";

describe.skipIf(!URL)("production Finance target IO (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("writes and rereads Finance rows using the migrated target schema", async () => {
    await client.query("BEGIN");
    try {
      const candidate = providerAccount();
      await expect(writeProductionFinanceRecords(client, [candidate])).resolves.toEqual({
        payment_provider_accounts: 1,
      });
      const prerequisites: ProductionFinancePrerequisites = {
        propertyLinks: [],
        resourceLinks: [],
        guestBookings: [],
        userIds: [],
      };
      const target = await readProductionFinanceTargetState(client, [candidate], prerequisites);
      expect(target.blockers).toEqual([]);
      expect(target.records).toHaveLength(1);
      expect(target.records[0]).toMatchObject({
        targetTable: "payment_provider_accounts",
        targetId: ID,
        row: { accountScope: "migration", provider: "manual", status: "disabled" },
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("blocks Stripe accounts quarantined by a compensation claim before writing", async () => {
    await client.query("BEGIN");
    try {
      const providerAccountId = "acct_quarantined_exact";
      await client.query(
        `INSERT INTO finance.stripe_provider_account_compensation_claims (provider_account_id)
         VALUES ($1)`,
        [providerAccountId],
      );
      const candidate = providerAccount();
      candidate.row = {
        ...candidate.row,
        accountScope: "property",
        provider: "stripe",
        providerAccountId,
      };
      const prerequisites: ProductionFinancePrerequisites = {
        propertyLinks: [],
        resourceLinks: [],
        guestBookings: [],
        userIds: [],
      };

      const target = await readProductionFinanceTargetState(client, [candidate], prerequisites);

      expect(target.blockers).toContainEqual({
        code: "QUARANTINED_STRIPE_PROVIDER_ACCOUNT",
        source: "finance.stripe_provider_account_compensation_claims",
        sourceId: providerAccountId,
        message: "Stripe provider account has a compensation claim and cannot be migrated",
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("lets the Finance trigger own the canonical Identity entitlement link", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'hotel_group', 'Migration trigger test', 'migration-trigger-test')`,
        [ORGANIZATION],
      );
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'migration-trigger-test', 'Migration trigger test')`,
        [PROPERTY],
      );
      const candidate = billingEntitlement();

      await expect(writeProductionFinanceRecords(client, [candidate])).resolves.toEqual({
        billing_entitlements: 1,
      });
      const linked = await client.query<{ billingId: string; identityId: string }>(
        `SELECT billing.identity_entitlement_id::text AS "billingId", identity.id::text AS "identityId"
           FROM finance.billing_entitlements billing
           JOIN identity.product_entitlements identity
             ON identity.id = billing.identity_entitlement_id
          WHERE billing.id = $1
            AND identity.organization_id = $2
            AND identity.product = 'booking'
            AND identity.entitlement_key = 'direct-booking-finance'
            AND identity.resource_product = 'pms'
            AND identity.resource_type = 'pms_property'
            AND identity.resource_id = $3`,
        [BILLING, ORGANIZATION, PROPERTY],
      );

      expect(candidate.row).not.toHaveProperty("identityEntitlementId");
      expect(linked.rows).toHaveLength(1);
      expect(linked.rows[0]!.billingId).toBe(linked.rows[0]!.identityId);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("retries immutable hash-only Finance dispositions and rejects mutation", async () => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO platform.source_extraction_runs
           (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
         VALUES ($1, 'local', $2, 'completed', now(), 1)
         ON CONFLICT (run_id) DO NOTHING`,
        [RUN, "a".repeat(40)],
      );
      const dispositions = [
        {
          sourceDatabase: "booking" as const,
          sourceTable: "booking_hotels",
          sourceId: ID,
          sourceField: "payout_destination",
          sourceValueSha256: "b".repeat(64),
          reasonCode: "SENSITIVE_PAYOUT_DESTINATION_REENTRY_REQUIRED" as const,
          disposition: "target_reentry_required" as const,
          targetTable: "payout_settings",
          targetId: ID,
        },
      ];

      expect(await writeProductionFinanceDispositions(client, dispositions, RUN)).toBe(1);
      expect(await writeProductionFinanceDispositions(client, dispositions, RUN)).toBe(1);
      await expect(writeProductionFinanceDispositions(client, [], RUN)).rejects.toThrow(
        "Finance disposition replay mismatch",
      );

      await client.query("SAVEPOINT immutable_finance_disposition");
      await expect(
        client.query(
          `UPDATE platform.production_finance_migration_dispositions
              SET source_value_sha256 = $1
            WHERE source_run_id = $2`,
          ["c".repeat(64), RUN],
        ),
      ).rejects.toThrow("immutable");
      await client.query("ROLLBACK TO SAVEPOINT immutable_finance_disposition");

      await client.query("SAVEPOINT untruncatable_finance_disposition");
      await expect(
        client.query("TRUNCATE platform.production_finance_migration_dispositions"),
      ).rejects.toThrow("immutable");
      await client.query("ROLLBACK TO SAVEPOINT untruncatable_finance_disposition");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

function providerAccount(): FinanceTargetRecord {
  const at = "2026-08-30T01:02:03.000Z";
  return {
    targetProduct: "finance",
    targetTable: "payment_provider_accounts",
    targetId: ID,
    sourceDatabase: "pms",
    sourceTable: "hotel_payment_settings",
    sourceId: ID,
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: at,
    mutable: true,
    row: {
      id: ID,
      propertyId: null,
      organizationId: null,
      accountScope: "migration",
      provider: "manual",
      providerAccountId: null,
      status: "disabled",
      onboardingStatus: "not_started",
      chargesEnabled: false,
      payoutsEnabled: false,
      defaultCurrency: "EUR",
      capabilities: [],
      accountMetadata: { integration: true },
      sensitiveConfigRef: null,
      createdAt: at,
      updatedAt: at,
    },
  };
}

function billingEntitlement(): FinanceTargetRecord {
  const at = "2026-08-30T01:02:03.000Z";
  return {
    targetProduct: "finance",
    targetTable: "billing_entitlements",
    targetId: BILLING,
    sourceDatabase: "booking",
    sourceTable: "booking_hotels",
    sourceId: ID,
    sourceChecksum: "b".repeat(64),
    sourceUpdatedAt: at,
    mutable: true,
    row: {
      id: BILLING,
      organizationId: ORGANIZATION,
      propertyId: PROPERTY,
      product: "booking",
      entitlementKey: "direct-booking-finance",
      billingStatus: "suspended",
      planKey: "commission",
      seatCount: null,
      billingProvider: "manual",
      billingCustomerRef: null,
      billingSubscriptionRef: null,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      startsAt: at,
      expiresAt: null,
      sourceSystem: "booking",
      sourceEntitlementId: `billing:${ID}`,
      entitlementMetadata: { source: "migration-test" },
      createdAt: at,
      updatedAt: at,
      checkoutSessionRef: null,
      providerSubscriptionStatus: null,
      billingPeriodStartAt: null,
      billingPeriodEndAt: null,
      cancelAtPeriodEnd: false,
      billingAmountMinor: null,
      billingCurrency: null,
      activeRoomCount: null,
      lastProviderEventCreatedAt: null,
      lastProviderEventId: null,
    },
  };
}
