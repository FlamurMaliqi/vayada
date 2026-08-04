import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0058_pms_mandatory_charge_confirmations.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_PROPERTY_ID = "30000000-0000-4000-8000-000000000002";
type EvidenceIds = Readonly<{
  idempotencyId: string;
  domainEventId: string;
  outboxEventId: string;
  auditEventId: string;
}>;
const EVIDENCE_1 = {
  idempotencyId: "70000000-0000-4000-8000-000000000001",
  domainEventId: "80000000-0000-4000-8000-000000000001",
  outboxEventId: "90000000-0000-4000-8000-000000000001",
  auditEventId: "a0000000-0000-4000-8000-000000000001",
} as const satisfies EvidenceIds;
const EVIDENCE_2 = {
  idempotencyId: "70000000-0000-4000-8000-000000000002",
  domainEventId: "80000000-0000-4000-8000-000000000002",
  outboxEventId: "90000000-0000-4000-8000-000000000002",
  auditEventId: "a0000000-0000-4000-8000-000000000002",
} as const satisfies EvidenceIds;
const OTHER_EVIDENCE = {
  idempotencyId: "70000000-0000-4000-8000-000000000003",
  domainEventId: "80000000-0000-4000-8000-000000000003",
  outboxEventId: "90000000-0000-4000-8000-000000000003",
  auditEventId: "a0000000-0000-4000-8000-000000000003",
} as const satisfies EvidenceIds;

describe("PMS mandatory-charge confirmation migration contract", () => {
  it("stores only append-only scoped evidence with the exact contract", () => {
    expect(migration).toContain("CREATE TABLE pms.mandatory_charge_confirmation_revisions");
    expect(migration).toContain("'pms-mandatory-charge-confirmation.v1'");
    expect(migration).toContain("pricing_source_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("pricing_currency_revision BETWEEN 1 AND 2147483647");
    expect(migration).toContain("optional_pricing_aggregate_revision BETWEEN 0");
    expect(migration.match(/platform\.prevent_append_only_mutation\(\)/g)).toHaveLength(2);
    expect(migration).not.toMatch(/\bJSONB\b|amount|cancellation|occupancy|idempotency_key_hash/i);
  });

  it("binds accepted evidence to platform idempotency, event, outbox, and audit rows", () => {
    expect(migration).toContain("FOREIGN KEY (idempotency_key_id, scope_key)");
    expect(migration).toContain("FOREIGN KEY (domain_event_id, property_id)");
    expect(migration).toContain("FOREIGN KEY (outbox_event_id, domain_event_id)");
    expect(migration).toContain("FOREIGN KEY (outbox_event_id, scope_key)");
    expect(migration).toContain("FOREIGN KEY (audit_event_id)");
    expect(migration).not.toMatch(/REFERENCES\s+(?:booking|finance|identity|hotel_catalog)\./i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "PMS mandatory-charge confirmation migration (PostgreSQL)",
  () => {
    let client: pg.Client;

    beforeEach(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await createPredecessorSchema(client);
      await client.query(migration);
      await seedPlatformEvidence(client, PROPERTY_ID, EVIDENCE_1);
      await seedPlatformEvidence(client, PROPERTY_ID, EVIDENCE_2);
      await seedPlatformEvidence(client, OTHER_PROPERTY_ID, OTHER_EVIDENCE);
    });

    afterEach(async () => {
      try {
        await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
        await client.query("DROP SCHEMA IF EXISTS platform CASCADE");
      } finally {
        await client.end();
      }
    });

    it("persists immutable revisions and reads the latest exact organization/property evidence", async () => {
      await insertConfirmation(client, { evidence: EVIDENCE_1 });
      await insertConfirmation(client, {
        evidence: EVIDENCE_2,
        confirmationRevision: 2,
        fingerprint: "b".repeat(64),
        pricingCurrencyRevision: 3,
        optionalPricingAggregateRevision: 4,
        confirmedAt: "2026-08-04T12:00:00.000Z",
      });

      const result = await client.query(
        `SELECT organization_id::text AS "organizationId",
              property_id::text AS "propertyId",
              confirmation_revision AS "confirmationRevision",
              pricing_source_fingerprint AS "pricingSourceFingerprint",
              confirmed_at AS "confirmedAt"
       FROM pms.mandatory_charge_confirmation_revisions
       WHERE organization_id = $1::uuid AND property_id = $2::uuid
       ORDER BY confirmation_revision DESC LIMIT 1`,
        [ORGANIZATION_ID, PROPERTY_ID],
      );
      expect(result.rows[0]).toMatchObject({
        organizationId: ORGANIZATION_ID,
        propertyId: PROPERTY_ID,
        confirmationRevision: 2,
        pricingSourceFingerprint: "b".repeat(64),
      });
      expect(new Date(result.rows[0].confirmedAt).toISOString()).toBe("2026-08-04T12:00:00.000Z");
    });

    it("rejects malformed contracts, fingerprints, and revision bounds", async () => {
      for (const override of [
        { contractVersion: "lookalike.v1" },
        { fingerprint: "A".repeat(64) },
        { fingerprint: "a".repeat(63) },
        { confirmationRevision: 0 },
        { pricingCurrencyRevision: 0 },
        { optionalPricingAggregateRevision: -1 },
        { confirmedAt: "infinity" },
      ]) {
        await expect(
          insertConfirmation(client, { evidence: EVIDENCE_1, ...override }),
        ).rejects.toMatchObject({
          code: "23514",
        });
      }
    });

    it("rejects cross-property platform evidence", async () => {
      await expect(insertConfirmation(client, { evidence: OTHER_EVIDENCE })).rejects.toMatchObject({
        code: "23503",
        constraint: "fk_pms_mandatory_charge_confirmation_idempotency_scope",
      });
    });

    it("rejects update, delete, and truncate", async () => {
      await insertConfirmation(client, { evidence: EVIDENCE_1 });
      await expect(
        client.query(
          "UPDATE pms.mandatory_charge_confirmation_revisions SET confirmed_at = confirmed_at",
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        client.query("DELETE FROM pms.mandatory_charge_confirmation_revisions"),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        client.query("TRUNCATE pms.mandatory_charge_confirmation_revisions"),
      ).rejects.toMatchObject({ code: "55000" });
    });
  },
);

async function createPredecessorSchema(client: pg.Client): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS pms CASCADE;
    DROP SCHEMA IF EXISTS platform CASCADE;
    CREATE SCHEMA pms;
    CREATE SCHEMA platform;

    CREATE FUNCTION platform.tenant_scope_key(
      tenant_scope TEXT, organization_id UUID, property_id UUID
    ) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
      SELECT CASE
        WHEN tenant_scope = 'property' THEN 'property:' || property_id::TEXT
        ELSE tenant_scope
      END;
    $$;
    CREATE FUNCTION platform.prevent_append_only_mutation()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'append-only' USING ERRCODE = '55000';
    END;
    $$;
    CREATE TABLE platform.idempotency_keys (
      id UUID PRIMARY KEY, scope_key TEXT NOT NULL, UNIQUE (id, scope_key)
    );
    CREATE TABLE platform.domain_events (
      id UUID PRIMARY KEY, property_id UUID NOT NULL, UNIQUE (id, property_id)
    );
    CREATE TABLE platform.outbox_events (
      id UUID PRIMARY KEY, domain_event_id UUID NOT NULL, scope_key TEXT NOT NULL,
      UNIQUE (id, domain_event_id), UNIQUE (id, scope_key)
    );
    CREATE TABLE platform.product_audit_events (id UUID PRIMARY KEY);
  `);
}

async function seedPlatformEvidence(
  client: pg.Client,
  propertyId: string,
  evidence: EvidenceIds,
): Promise<void> {
  const scopeKey = `property:${propertyId}`;
  await client.query(
    "INSERT INTO platform.idempotency_keys (id, scope_key) VALUES ($1::uuid, $2)",
    [evidence.idempotencyId, scopeKey],
  );
  await client.query(
    "INSERT INTO platform.domain_events (id, property_id) VALUES ($1::uuid, $2::uuid)",
    [evidence.domainEventId, propertyId],
  );
  await client.query(
    `INSERT INTO platform.outbox_events (id, domain_event_id, scope_key)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [evidence.outboxEventId, evidence.domainEventId, scopeKey],
  );
  await client.query("INSERT INTO platform.product_audit_events (id) VALUES ($1::uuid)", [
    evidence.auditEventId,
  ]);
}

async function insertConfirmation(
  client: pg.Client,
  override: Partial<{
    evidence: EvidenceIds;
    contractVersion: string;
    confirmationRevision: number;
    fingerprint: string;
    pricingCurrencyRevision: number;
    optionalPricingAggregateRevision: number;
    confirmedAt: string;
  }> = {},
): Promise<void> {
  const evidence = override.evidence ?? EVIDENCE_1;
  await client.query(
    `INSERT INTO pms.mandatory_charge_confirmation_revisions (
       organization_id, property_id, confirmation_revision, contract_version,
       pricing_source_fingerprint, pricing_currency_revision,
       optional_pricing_aggregate_revision, idempotency_key_id,
       domain_event_id, outbox_event_id, audit_event_id, confirmed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
       $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::timestamptz
     )`,
    [
      ORGANIZATION_ID,
      PROPERTY_ID,
      override.confirmationRevision ?? 1,
      override.contractVersion ?? "pms-mandatory-charge-confirmation.v1",
      override.fingerprint ?? "a".repeat(64),
      override.pricingCurrencyRevision ?? 2,
      override.optionalPricingAggregateRevision ?? 0,
      evidence.idempotencyId,
      evidence.domainEventId,
      evidence.outboxEventId,
      evidence.auditEventId,
      override.confirmedAt ?? "2026-08-04T11:00:00.000Z",
    ],
  );
}
