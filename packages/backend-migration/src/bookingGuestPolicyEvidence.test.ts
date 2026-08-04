import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0059_booking_guest_policy_evidence.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const NOW = "2026-08-04T12:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

describe("Booking guest-policy evidence migration contract", () => {
  it("owns one private working revision, exact confirmation, and projection receipt chain", () => {
    for (const table of [
      "booking.guest_policy_revisions",
      "booking.current_working_guest_policy_revisions",
      "booking.booking_policy_confirmations",
      "booking.guest_policy_projection_receipts",
    ])
      expect(migration).toContain(`CREATE TABLE ${table}`);
    expect(migration).toContain("contract_version = 'booking-guest-policy.v1'");
    expect(migration).toContain("CHECK (NOT guest_count_enabled)");
    expect(migration).toContain("confirmation_basis = 'unchanged_policy_bundle'");
    expect(migration).toContain("outcome = 'source_revision_conflict'");
    expect(migration).toContain(
      "observed_catalog_profile_revision <> catalog_profile_source_revision",
    );
    expect(migration.match(/platform\.prevent_append_only_mutation\(\)/g)).toHaveLength(6);
  });

  it("binds the accepted command atomically to scoped platform evidence without owner-table FKs", () => {
    expect(migration).toContain("FOREIGN KEY (idempotency_key_id, scope_key)");
    expect(migration).toContain("FOREIGN KEY (domain_event_id, property_id)");
    expect(migration).toContain("FOREIGN KEY (outbox_event_id, domain_event_id)");
    expect(migration).toContain("FOREIGN KEY (outbox_event_id, scope_key)");
    expect(migration).toContain("FOREIGN KEY (audit_event_id)");
    expect(migration).not.toMatch(/REFERENCES\s+(?:hotel_catalog|pms|finance|identity)\./i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Booking guest-policy evidence migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await createPredecessorSchema(client);
    await client.query(migration);
    await seedPlatformEvidence(client, 1);
    await seedPlatformEvidence(client, 2);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
      await client.query("DROP SCHEMA IF EXISTS platform CASCADE");
    } finally {
      await client.end();
    }
  });

  it("persists the exact current revision, explicit confirmation, and applied receipt", async () => {
    await insertRevision(client, 1);
    await insertConfirmation(client, { revision: 1, confirmationRevision: 1 });
    await insertCurrent(client, 1);
    await insertReceipt(client, { revision: 1 });

    const current = await client.query(
      `SELECT revision.guest_policy_revision AS "guestPolicyRevision",
              revision.default_guest_language AS "defaultGuestLanguage",
              revision.pricing_currency AS "pricingCurrency",
              confirmation.confirmation_basis AS "confirmationBasis",
              receipt.outcome AS "projectionOutcome"
       FROM booking.current_working_guest_policy_revisions current_revision
       JOIN booking.guest_policy_revisions revision
         ON revision.revision_id = current_revision.revision_id
       LEFT JOIN booking.booking_policy_confirmations confirmation
         ON confirmation.guest_policy_revision_id = revision.revision_id
       LEFT JOIN booking.guest_policy_projection_receipts receipt
         ON receipt.guest_policy_revision_id = revision.revision_id
       WHERE current_revision.property_id = $1::uuid`,
      [PROPERTY_ID],
    );
    expect(current.rows[0]).toEqual({
      guestPolicyRevision: 1,
      defaultGuestLanguage: "en",
      pricingCurrency: "EUR",
      confirmationBasis: "explicit",
      projectionOutcome: "applied",
    });
  });

  it("carries confirmation across an optional-only change without creating a projection receipt", async () => {
    await insertRevision(client, 1);
    await insertConfirmation(client, { revision: 1, confirmationRevision: 1 });
    await insertRevision(client, 2, { phoneRequired: false });
    await insertConfirmation(client, {
      revision: 2,
      confirmationRevision: 2,
      basis: "unchanged_policy_bundle",
      basedOnConfirmationId: id("b", 1),
      basedOnConfirmationRevision: 1,
    });
    await insertCurrent(client, 2);

    const result = await client.query(
      `SELECT revision.phone_required AS "phoneRequired",
              confirmation.confirmation_basis AS "basis",
              receipt.receipt_id AS "receiptId"
       FROM booking.current_working_guest_policy_revisions current_revision
       JOIN booking.guest_policy_revisions revision
         ON revision.revision_id = current_revision.revision_id
       JOIN booking.booking_policy_confirmations confirmation
         ON confirmation.guest_policy_revision_id = revision.revision_id
       LEFT JOIN booking.guest_policy_projection_receipts receipt
         ON receipt.guest_policy_revision_id = revision.revision_id
       WHERE current_revision.property_id = $1::uuid`,
      [PROPERTY_ID],
    );
    expect(result.rows[0]).toEqual({
      phoneRequired: false,
      basis: "unchanged_policy_bundle",
      receiptId: null,
    });
  });

  it("rejects malformed language, child, guest-count, hash, and structured evidence", async () => {
    for (const override of [
      { language: "it" },
      { adultAgeThreshold: null },
      { guestCountEnabled: true },
      { sourceFingerprint: `sha256:${"A".repeat(64)}` },
      { sourceBindings: {} },
      { policyBundle: [] },
    ])
      await expect(insertRevision(client, 1, override)).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects confirmations, pointers, and receipts that do not match the exact revision", async () => {
    await insertRevision(client, 1);
    await expect(
      insertConfirmation(client, { revision: 1, confirmationRevision: 1, bundleHash: HASH_B }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_policy_confirmation_exact_guest_revision",
    });
    await expect(insertCurrent(client, 1)).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_current_guest_policy_exact_confirmation",
    });
    await insertConfirmation(client, { revision: 1, confirmationRevision: 1 });
    await expect(insertCurrent(client, 1, id("4", 2))).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_current_guest_policy_exact_revision",
    });
    await expect(
      insertReceipt(client, { revision: 1, sourceFingerprint: HASH_B }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_guest_policy_projection_exact_revision",
    });
    await expect(
      insertReceipt(client, { revision: 1, catalogProfileSourceRevision: "profile:9" }),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "fk_booking_guest_policy_projection_exact_revision",
    });
  });

  it("rejects a carried confirmation that cites itself instead of earlier review evidence", async () => {
    await insertRevision(client, 1);
    await insertRevision(client, 2);
    await expect(
      insertConfirmation(client, {
        revision: 2,
        confirmationRevision: 2,
        basis: "unchanged_policy_bundle",
        basedOnConfirmationId: id("b", 2),
        basedOnConfirmationRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects update, delete, and truncate across every evidence ledger", async () => {
    await insertRevision(client, 1);
    await insertConfirmation(client, { revision: 1, confirmationRevision: 1 });
    await insertReceipt(client, { revision: 1 });
    for (const statement of [
      "UPDATE booking.guest_policy_revisions SET phone_required = phone_required",
      "DELETE FROM booking.booking_policy_confirmations",
      "TRUNCATE booking.guest_policy_projection_receipts",
    ])
      await expect(client.query(statement)).rejects.toMatchObject({ code: "55000" });
  });
});

async function createPredecessorSchema(client: pg.Client): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS booking CASCADE;
    DROP SCHEMA IF EXISTS platform CASCADE;
    CREATE SCHEMA booking;
    CREATE SCHEMA platform;
    CREATE FUNCTION platform.tenant_scope_key(
      tenant_scope TEXT, organization_id UUID, property_id UUID
    ) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
      SELECT CASE WHEN tenant_scope = 'property' THEN 'property:' || property_id::TEXT ELSE tenant_scope END;
    $$;
    CREATE FUNCTION platform.prevent_append_only_mutation()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'append-only' USING ERRCODE = '55000'; END;
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

async function seedPlatformEvidence(client: pg.Client, suffix: number): Promise<void> {
  const scope = `property:${PROPERTY_ID}`;
  await client.query("INSERT INTO platform.idempotency_keys VALUES ($1::uuid, $2)", [
    id("7", suffix),
    scope,
  ]);
  await client.query("INSERT INTO platform.domain_events VALUES ($1::uuid, $2::uuid)", [
    id("8", suffix),
    PROPERTY_ID,
  ]);
  await client.query("INSERT INTO platform.outbox_events VALUES ($1::uuid, $2::uuid, $3)", [
    id("9", suffix),
    id("8", suffix),
    scope,
  ]);
  await client.query("INSERT INTO platform.product_audit_events VALUES ($1::uuid)", [
    id("a", suffix),
  ]);
}

async function insertRevision(
  client: pg.Client,
  revision: number,
  override: Partial<{
    language: string;
    adultAgeThreshold: number | null;
    phoneRequired: boolean;
    guestCountEnabled: boolean;
    sourceFingerprint: string;
    sourceBindings: unknown;
    policyBundle: unknown;
  }> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO booking.guest_policy_revisions (
       revision_id, organization_id, property_id, guest_policy_revision, contract_version,
       default_guest_language, children_enabled, adult_age_threshold, phone_required,
       arrival_time_enabled, special_requests_enabled, guest_count_enabled,
       check_in_time, check_out_time, pricing_currency, property_time_zone,
       catalog_profile_source_revision,
       pricing_source_fingerprint, mandatory_charge_confirmation_revision,
       source_bindings, source_fingerprint, policy_bundle, bundle_hash,
       idempotency_key_id, domain_event_id, outbox_event_id, audit_event_id, accepted_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 'booking-guest-policy.v1',
       $5, TRUE, $6, $7, FALSE, TRUE, $8,
       '15:00', '11:00', 'EUR', 'Europe/Berlin', 'profile:8', $9, 6,
       $10::jsonb, $11, $12::jsonb, $13,
       $14::uuid, $15::uuid, $16::uuid, $17::uuid, $18::timestamptz
     )`,
    [
      id("4", revision),
      ORGANIZATION_ID,
      PROPERTY_ID,
      revision,
      override.language ?? "en",
      override.adultAgeThreshold === undefined ? 18 : override.adultAgeThreshold,
      override.phoneRequired ?? true,
      override.guestCountEnabled ?? false,
      "c".repeat(64),
      JSON.stringify(override.sourceBindings ?? []),
      override.sourceFingerprint ?? HASH_A,
      JSON.stringify(override.policyBundle ?? { rates: [] }),
      HASH_A,
      id("7", revision),
      id("8", revision),
      id("9", revision),
      id("a", revision),
      NOW,
    ],
  );
}

async function insertCurrent(client: pg.Client, revision: number, revisionId = id("4", revision)) {
  await client.query(
    `INSERT INTO booking.current_working_guest_policy_revisions
       (property_id, organization_id, revision_id, guest_policy_revision,
        confirmation_id, confirmation_revision, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $4, $6::timestamptz)
     ON CONFLICT (property_id) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       revision_id = EXCLUDED.revision_id,
       guest_policy_revision = EXCLUDED.guest_policy_revision,
       confirmation_id = EXCLUDED.confirmation_id,
       confirmation_revision = EXCLUDED.confirmation_revision,
       updated_at = EXCLUDED.updated_at`,
    [PROPERTY_ID, ORGANIZATION_ID, revisionId, revision, id("b", revision), NOW],
  );
}

async function insertConfirmation(
  client: pg.Client,
  input: {
    revision: number;
    confirmationRevision: number;
    basis?: "explicit" | "unchanged_policy_bundle";
    basedOnConfirmationId?: string;
    basedOnConfirmationRevision?: number;
    bundleHash?: string;
  },
) {
  await client.query(
    `INSERT INTO booking.booking_policy_confirmations (
       confirmation_id, organization_id, property_id, confirmation_revision,
       guest_policy_revision_id, guest_policy_revision, bundle_hash, source_fingerprint,
       confirmation_basis, based_on_confirmation_id, based_on_confirmation_revision,
       reviewed_at, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8,
       $9, $10::uuid, $11, $12, $12
     )`,
    [
      id("b", input.confirmationRevision),
      ORGANIZATION_ID,
      PROPERTY_ID,
      input.confirmationRevision,
      id("4", input.revision),
      input.revision,
      input.bundleHash ?? HASH_A,
      HASH_A,
      input.basis ?? "explicit",
      input.basedOnConfirmationId ?? null,
      input.basedOnConfirmationRevision ?? null,
      NOW,
    ],
  );
}

async function insertReceipt(
  client: pg.Client,
  input: {
    revision: number;
    sourceFingerprint?: string;
    catalogProfileSourceRevision?: string;
  },
) {
  await client.query(
    `INSERT INTO booking.guest_policy_projection_receipts (
       receipt_id, organization_id, property_id, guest_policy_revision_id,
       guest_policy_revision, source_outbox_event_id, bundle_hash, source_fingerprint,
       catalog_profile_source_revision, outcome, catalog_policy_projection_revision,
       observed_catalog_profile_revision, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7, $8,
       $9, 'applied', 1, NULL, $10::timestamptz
     )`,
    [
      id("c", input.revision),
      ORGANIZATION_ID,
      PROPERTY_ID,
      id("4", input.revision),
      input.revision,
      id("9", input.revision),
      HASH_A,
      input.sourceFingerprint ?? HASH_A,
      input.catalogProfileSourceRevision ?? "profile:8",
      NOW,
    ],
  );
}

function id(prefix: string, suffix: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}
