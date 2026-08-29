import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0119_finance_online_card_execution_evidence.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe("Finance online-card execution evidence migration contract", () => {
  it("binds one secret-safe ONB-25A result to an exact account capability revision", () => {
    expect(migration).toContain("finance-online-card-execution-evidence.v1");
    expect(migration).toContain("test_suite = 'onb-25a'");
    expect(migration).toContain("provider_capability_revision");
    expect(migration).toContain("property_readiness_revision");
    expect(migration).toContain("SET card_capability_revision = 1");
    expect(migration).toContain("provider_account_id NOT LIKE 'settings-choice:%'");
    expect(migration).toContain("trg_finance_provider_account_readiness_revision");
    expect(migration).toContain("trg_finance_payment_settings_online_card_readiness_revision");
    expect(migration).toContain("BEFORE UPDATE OF provider_account_id, account_scope, provider");
    expect(migration).toContain("onboarding_status");
    expect(migration).toContain("cardPaymentsStatus");
    expect(migration).toContain("evidence_fingerprint_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("FOREIGN KEY (provider_account_id, property_id)");
    expect(migration).toContain("WHERE revoked_at IS NULL");
    expect(migration).not.toMatch(/payment_intent|client_secret|provider_secret/i);
  });

  it("defines one Finance-owned release predicate with every canonical Stripe gate", () => {
    for (const gate of [
      "account.status = 'active'",
      "account.account_scope = 'property'",
      "account.onboarding_status = 'completed'",
      "account.charges_enabled",
      "account.payouts_enabled",
      "account.account_metadata ->> 'detailsSubmitted' = 'true'",
      "account.account_metadata ->> 'cardPaymentsStatus' = 'active'",
      "account.capabilities @> ARRAY['card_payments']::TEXT[]",
      "evidence.provider_capability_revision = account.card_capability_revision",
      "evidence.property_readiness_revision = settings.online_card_readiness_revision",
      "upper(trim(settings.default_currency)) NOT IN ('BHD', 'JOD', 'KWD', 'OMR', 'TND')",
    ]) {
      expect(migration).toContain(gate);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Finance online-card execution evidence PostgreSQL", () => {
  const client = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const userId = randomUUID();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const otherPropertyId = randomUUID();
  const providerAccountId = randomUUID();
  const unsupportedProviderAccountId = randomUUID();

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users (id, email, name)
       VALUES ($1::uuid, $2, 'VAY-1345 evidence reviewer')`,
      [userId, `${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES ($1::uuid, 'platform', 'VAY-1345 Platform', $2)`,
      [organizationId, `vay-1345-${organizationId}`],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'VAY-1345 Hotel'),
              ($3::uuid, $4, 'VAY-1345 Other Hotel')`,
      [propertyId, `vay-1345-${propertyId}`, otherPropertyId, `vay-1345-${otherPropertyId}`],
    );
    await client.query(
      `INSERT INTO pms.property_pricing_settings
         (property_id, currency, pricing_currency_revision)
       VALUES ($1::uuid, 'EUR', 1)`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO pms.property_pricing_settings
         (property_id, currency, pricing_currency_revision)
       VALUES ($1::uuid, 'KWD', 1)`,
      [otherPropertyId],
    );
    await client.query(
      `INSERT INTO finance.payment_provider_accounts (
         id, property_id, account_scope, provider, provider_account_id,
         status, onboarding_status, charges_enabled, payouts_enabled,
         capabilities, account_metadata, card_capability_revision
       ) VALUES (
         $1::uuid, $2::uuid, 'property', 'stripe', $3,
         'active', 'completed', TRUE, TRUE, ARRAY['card_payments'],
         '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}'::jsonb, 4
       )`,
      [providerAccountId, propertyId, `acct-vay-1345-${providerAccountId}`],
    );
    await client.query(
      `INSERT INTO finance.payment_provider_accounts (
         id, property_id, account_scope, provider, provider_account_id,
         status, onboarding_status, charges_enabled, payouts_enabled,
         capabilities, account_metadata, card_capability_revision
       ) VALUES (
         $1::uuid, $2::uuid, 'property', 'stripe', $3,
         'active', 'completed', TRUE, TRUE, ARRAY['card_payments'],
         '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}'::jsonb, 4
       )`,
      [
        unsupportedProviderAccountId,
        otherPropertyId,
        `acct-vay-1345-${unsupportedProviderAccountId}`,
      ],
    );
    await client.query(
      `INSERT INTO finance.payment_settings (
         property_id, provider_account_id, payments_enabled, accepted_methods,
         default_currency, payment_readiness_contract_version,
         payment_methods_revision, source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, TRUE, ARRAY['card'], 'EUR',
         'finance-payment-readiness.v1', 1, 1
       )`,
      [propertyId, providerAccountId],
    );
    await client.query(
      `INSERT INTO finance.payment_settings (
         property_id, provider_account_id, payments_enabled, accepted_methods,
         default_currency, payment_readiness_contract_version,
         payment_methods_revision, source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, TRUE, ARRAY['card'], 'KWD',
         'finance-payment-readiness.v1', 1, 1
       )`,
      [otherPropertyId, unsupportedProviderAccountId],
    );
  });

  afterAll(async () => {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  it("gains readiness and fails closed for unsupported currency, rebinding, and revocation", async () => {
    const evidenceId = randomUUID();
    await client.query(
      `INSERT INTO finance.online_card_execution_evidence (
         id, property_id, provider_account_id, contract_version, test_suite,
         provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
         executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'finance-online-card-execution-evidence.v1', 'onb-25a', 4, 1, $4,
         '2026-08-28T10:00:00Z', '2026-08-28T10:05:00Z', $5::uuid, $6::uuid
       )`,
      [evidenceId, propertyId, providerAccountId, "a".repeat(64), organizationId, userId],
    );
    await expect(readiness()).resolves.toBe(true);
    await client.query(
      `UPDATE finance.payment_settings
       SET accepted_methods = ARRAY['pay_at_property']
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    await expect(readiness()).resolves.toBe(false);
    await client.query(
      `UPDATE finance.payment_settings
       SET accepted_methods = ARRAY['card']
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    await expect(readiness()).resolves.toBe(false);
    const propertyRevision = await client.query<{ revision: string }>(
      `SELECT online_card_readiness_revision::text AS revision
       FROM finance.payment_settings WHERE property_id = $1::uuid`,
      [propertyId],
    );
    expect(propertyRevision.rows[0]?.revision).toBe("3");
    await client.query(
      `INSERT INTO finance.online_card_execution_evidence (
         property_id, provider_account_id, contract_version, test_suite,
         provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
         executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, 'finance-online-card-execution-evidence.v1', 'onb-25a',
         4, 1, $3, '2026-08-28T10:00:00Z', '2026-08-28T10:05:00Z', $4::uuid, $5::uuid
       )`,
      [otherPropertyId, unsupportedProviderAccountId, "f".repeat(64), organizationId, userId],
    );
    await expect(readiness(otherPropertyId)).resolves.toBe(false);

    await client.query(
      `UPDATE finance.payment_provider_accounts
       SET provider_account_id = $2 WHERE id = $1::uuid`,
      [providerAccountId, `acct-vay-1345-rebound-${providerAccountId}`],
    );
    const rebound = await client.query<{ revision: string }>(
      `SELECT card_capability_revision::text AS revision
       FROM finance.payment_provider_accounts WHERE id = $1::uuid`,
      [providerAccountId],
    );
    expect(rebound.rows[0]?.revision).toBe("5");
    await expect(readiness()).resolves.toBe(false);

    await client.query(
      `UPDATE finance.online_card_execution_evidence
       SET revoked_at = '2026-08-28T10:06:00Z', updated_at = '2026-08-28T10:06:00Z'
       WHERE id = $1::uuid`,
      [evidenceId],
    );
    const replacementEvidenceId = randomUUID();
    await client.query(
      `INSERT INTO finance.online_card_execution_evidence (
         id, property_id, provider_account_id, contract_version, test_suite,
         provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
         executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         'finance-online-card-execution-evidence.v1', 'onb-25a', 5, 3, $4,
         '2026-08-28T10:07:00Z', '2026-08-28T10:08:00Z', $5::uuid, $6::uuid
       )`,
      [
        replacementEvidenceId,
        propertyId,
        providerAccountId,
        "d".repeat(64),
        organizationId,
        userId,
      ],
    );
    await expect(readiness()).resolves.toBe(true);
    await client.query(
      `UPDATE finance.online_card_execution_evidence
       SET revoked_at = '2026-08-28T10:09:00Z', updated_at = '2026-08-28T10:09:00Z'
       WHERE id = $1::uuid`,
      [replacementEvidenceId],
    );
    await expect(readiness()).resolves.toBe(false);

    await client.query("SAVEPOINT immutable_evidence");
    await expect(
      client.query(
        `UPDATE finance.online_card_execution_evidence
         SET evidence_fingerprint_hash = $2 WHERE id = $1::uuid`,
        [evidenceId, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await client.query("ROLLBACK TO SAVEPOINT immutable_evidence");
  });

  it("rejects cross-property evidence at the database boundary", async () => {
    await client.query("SAVEPOINT cross_property_evidence");
    await expect(
      client.query(
        `INSERT INTO finance.online_card_execution_evidence (
           property_id, provider_account_id, contract_version, test_suite,
           provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
           executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
         ) VALUES (
           $1::uuid, $2::uuid, 'finance-online-card-execution-evidence.v1', 'onb-25a',
           4, 1, $3, now(), now(), $4::uuid, $5::uuid
         )`,
        [otherPropertyId, providerAccountId, "c".repeat(64), organizationId, userId],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_finance_online_card_execution_evidence_account",
    });
    await client.query("ROLLBACK TO SAVEPOINT cross_property_evidence");
  });

  async function readiness(readinessPropertyId = propertyId): Promise<boolean> {
    const result = await client.query<{ ready: boolean }>(
      `SELECT online_card_ready AS ready
       FROM finance.online_card_readiness WHERE property_id = $1::uuid`,
      [readinessPropertyId],
    );
    return result.rows[0]?.ready ?? false;
  }
});
