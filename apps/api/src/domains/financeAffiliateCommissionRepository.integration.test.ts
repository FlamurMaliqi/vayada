import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgFinanceAffiliateCommissionRepository } from "./financeAffiliateCommissionRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = randomUUID();
const organizationId = randomUUID();
const propertyId = randomUUID();
const concurrentDefaultPropertyId = randomUUID();
const concurrentOverridePropertyId = randomUUID();
const affiliateId = `affiliate-${randomUUID()}`;
const concurrentAffiliateId = `affiliate-${randomUUID()}`;
const occurredAt = "2026-08-13T21:00:00.000Z";

describe.skipIf(!TEST_DATABASE_URL)("Finance affiliate commission PostgreSQL repository", () => {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgFinanceAffiliateCommissionRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });

  beforeAll(async () => {
    if (!/(test|verify)/i.test(new URL(TEST_DATABASE_URL!).pathname)) {
      throw new Error("Refusing non-test database");
    }
    await admin.connect();
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1278 Finance Org', $2, 'active')`,
      [organizationId, `vay-1278-${organizationId}`],
    );
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-1278 Finance Actor', 'active')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'VAY-1278 Commission Hotel'),
              ($3::uuid, $4, 'VAY-1278 Concurrent Default Hotel'),
              ($5::uuid, $6, 'VAY-1278 Concurrent Override Hotel')`,
      [
        propertyId,
        `prop-${propertyId}`,
        concurrentDefaultPropertyId,
        `prop-${concurrentDefaultPropertyId}`,
        concurrentOverridePropertyId,
        `prop-${concurrentOverridePropertyId}`,
      ],
    );
    await admin.query(
      `INSERT INTO marketplace.property_affiliates (
         property_id, affiliate_id, referral_code, affiliate_type,
         lifecycle_status, application_source
       ) VALUES ($1::uuid, $2, $3, 'creator', 'approved', 'collaboration')`,
      [propertyId, affiliateId, `ref-${affiliateId}`],
    );
    await admin.query(
      `INSERT INTO marketplace.property_affiliates (
         property_id, affiliate_id, referral_code, affiliate_type,
         lifecycle_status, application_source
       ) VALUES ($1::uuid, $2, $3, 'creator', 'approved', 'collaboration')`,
      [concurrentOverridePropertyId, concurrentAffiliateId, `ref-${concurrentAffiliateId}`],
    );
    await admin.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, property_id, product, entitlement_key, billing_status,
         plan_key, billing_provider, source_system
       ) VALUES ($1::uuid, $2::uuid, 'booking', 'direct-booking-finance',
         'active', 'commission', 'none', 'finance')`,
      [organizationId, propertyId],
    );
  });

  afterAll(async () => {
    await repository.close?.();
    await admin.end();
  });

  it("round-trips the property default with exact replay and conflict evidence", async () => {
    await expect(repository.getCommission(propertyId)).resolves.toMatchObject({
      defaultPercentageRate: "0",
      overridePercentageRate: null,
      effectivePercentageRate: "0",
    });
    const command = commissionCommand(null, "7.5", "default");
    const applied = await repository.setCommission(command);
    expect(applied).toMatchObject({
      outcome: "applied",
      commission: { defaultPercentageRate: "7.5", effectivePercentageRate: "7.5" },
    });
    await expect(repository.setCommission(command)).resolves.toMatchObject({
      outcome: "replayed",
      commission: { defaultPercentageRate: "7.5" },
    });
    await expect(repository.setCommission({ ...command, percentageRate: "8" })).resolves.toEqual({
      outcome: "idempotency_conflict",
    });
  });

  it("applies and clears an affiliate override without changing the default", async () => {
    await expect(
      repository.setCommission(commissionCommand(affiliateId, "12", "override")),
    ).resolves.toMatchObject({
      outcome: "applied",
      commission: {
        defaultPercentageRate: "7.5",
        overridePercentageRate: "12",
        effectivePercentageRate: "12",
      },
    });
    await expect(
      repository.setCommission(commissionCommand(affiliateId, null, "clear")),
    ).resolves.toMatchObject({
      outcome: "applied",
      commission: {
        defaultPercentageRate: "7.5",
        overridePercentageRate: null,
        effectivePercentageRate: "7.5",
      },
    });

    const evidence = await admin.query<{ changes: string; audits: string; keys: string }>(
      `SELECT
         (SELECT count(*)::text FROM finance.commission_rate_changes change
          JOIN finance.commission_rules rule ON rule.id = change.commission_rule_id
          WHERE rule.property_id = $1::uuid) AS changes,
         (SELECT count(*)::text FROM platform.product_audit_events
          WHERE product = 'finance' AND property_id = $1::uuid
            AND target_resource_type = 'affiliate_commission') AS audits,
         (SELECT count(*)::text FROM platform.idempotency_keys
          WHERE operation_scope = 'finance' AND operation = 'affiliate_commission.update'
            AND property_id = $1::uuid) AS keys`,
      [propertyId],
    );
    expect(evidence.rows[0]).toEqual({ changes: "3", audits: "3", keys: "3" });
  });

  it("rejects clearing the required property default before persistence", async () => {
    await expect(
      repository.setCommission(commissionCommand(null, null, "invalid")),
    ).rejects.toThrow("cannot be cleared");
  });

  it("reads Booking Finance access from the Finance-owned entitlement store", async () => {
    await expect(repository.getBookingFinanceAccess(propertyId, organizationId)).resolves.toBe(
      "active",
    );
    await expect(
      repository.getBookingFinanceAccess(concurrentDefaultPropertyId, organizationId),
    ).resolves.toBe("missing");
  });

  it("serializes concurrent first writes for defaults and overrides", async () => {
    const [firstDefault, secondDefault] = await Promise.all([
      repository.setCommission(
        commissionCommandFor(concurrentDefaultPropertyId, null, "5", "race-default-a"),
      ),
      repository.setCommission(
        commissionCommandFor(concurrentDefaultPropertyId, null, "6", "race-default-b"),
      ),
    ]);
    const [firstOverride, secondOverride] = await Promise.all([
      repository.setCommission(
        commissionCommandFor(
          concurrentOverridePropertyId,
          concurrentAffiliateId,
          "9",
          "race-override-a",
        ),
      ),
      repository.setCommission(
        commissionCommandFor(
          concurrentOverridePropertyId,
          concurrentAffiliateId,
          "10",
          "race-override-b",
        ),
      ),
    ]);

    expect([firstDefault.outcome, secondDefault.outcome]).toEqual(["applied", "applied"]);
    expect([firstOverride.outcome, secondOverride.outcome]).toEqual(["applied", "applied"]);
  });
});

function commissionCommand(
  targetAffiliateId: string | null,
  percentageRate: string | null,
  suffix: string,
) {
  return commissionCommandFor(propertyId, targetAffiliateId, percentageRate, suffix);
}

function commissionCommandFor(
  targetPropertyId: string,
  targetAffiliateId: string | null,
  percentageRate: string | null,
  suffix: string,
) {
  return {
    propertyId: targetPropertyId,
    affiliateId: targetAffiliateId,
    commandId: `command-${suffix}-${randomUUID()}`,
    idempotencyKey: `key-${suffix}-${randomUUID()}`,
    percentageRate,
    actorUserId,
    occurredAt,
  };
}
