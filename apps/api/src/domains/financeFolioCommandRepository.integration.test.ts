import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinanceFolioCommandRepository,
  type CreateFinanceFolioCommand,
} from "./financeFolioCommandRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "11321000-0000-4000-8000-000000000001";
const ORGANIZATION = "11321000-0000-4000-8000-000000000002";
const PROPERTY = "11321000-0000-4000-8000-000000000003";
const OTHER_PROPERTY = "11321000-0000-4000-8000-000000000004";
const BOOKING = "11321000-0000-4000-8000-000000000005";
const ROOM_TYPE = "11321000-0000-4000-8000-000000000006";
const EVIDENCE = "11321000-0000-4000-8000-000000000007";
const FOLIO = "11321000-0000-4000-8000-000000000008";
const PAYMENT = "11321000-0000-4000-8000-000000000012";
const REVISION_2 = "11321000-0000-4000-8000-000000000009";
const REVISION_3 = "11321000-0000-4000-8000-000000000010";
const REVISION_4 = "11321000-0000-4000-8000-000000000011";
const EMPTY_FOLIO = "11321000-0000-4000-8000-000000000013";
const EMPTY_READY = "11321000-0000-4000-8000-000000000014";
const CODEC_FAILURE = "11321000-0000-4000-8000-000000000015";
const PAYMENT_LOCK_FOLIO = "11321000-0000-4000-8000-000000000016";
const SCOPES = `'${PROPERTY}','${OTHER_PROPERTY}'`;

if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL Finance folio command repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const recipients = new Map<string, { name: string; email: string | null }>();
  let fingerprintVersion = "v1";
  const repository = createPgFinanceFolioCommandRepository({
    connectionString: URL ?? "postgresql://disabled",
    recipientEncoder: {
      async encode(input) {
        recipients.set(`${input.folioId}:${input.revision}`, input.recipient);
        return {
          ciphertext: Buffer.alloc(32, input.revision),
          encryptionScheme: "envelope_aead_v1",
          keyVersion: "kms-encryption-v1",
          fingerprint: createHash("sha256")
            .update(JSON.stringify([fingerprintVersion, input.recipient]))
            .digest("hex"),
          fingerprintKeyVersion: `kms-fingerprint-${fingerprintVersion}`,
        };
      },
    },
    recipientDecoder: {
      async decode(input) {
        const recipient = recipients.get(`${input.folioId}:${input.revision}`);
        if (!recipient) throw new Error("missing test recipient");
        return recipient;
      },
    },
  });

  beforeAll(async () => admin.connect());
  beforeEach(async () => {
    fingerprintVersion = "v1";
    recipients.clear();
    await cleanup();
    await admin.query(`
      INSERT INTO identity.users(id,email,name,status)
      VALUES ('${ACTOR}','folio-command@example.test','Folio command','active');
      INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
        ('${PROPERTY}','folio-command','Folio command'),
        ('${OTHER_PROPERTY}','folio-command-other','Folio command other');
      INSERT INTO pms.property_pricing_settings(property_id,currency)
      VALUES ('${PROPERTY}','EUR'),('${OTHER_PROPERTY}','USD');
      INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency,total_amount)
      VALUES ('${BOOKING}','${PROPERTY}','folio-command-booking','confirmed','2026-08-01','2026-08-03','EUR',12);
      INSERT INTO booking.nightly_revenue_room_scopes(property_id,room_type_id)
      VALUES ('${PROPERTY}','${ROOM_TYPE}');
      INSERT INTO booking.nightly_revenue_evidence
        (id,property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,
         gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,
         evidence_quality,source_revision,command_key)
      VALUES ('${EVIDENCE}','${PROPERTY}','${BOOKING}','${ROOM_TYPE}','2026-08-01','2026-08-01',
        'EUR',12,1,'room_night','confirmed','direct','exact',1,'folio-command-evidence');
      INSERT INTO finance.payments(id,property_id,guest_booking_id,payment_kind,status,amount,currency)
      VALUES ('${PAYMENT}','${PROPERTY}','${BOOKING}','full','paid',12,'EUR');
    `);
  });
  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("appends draft corrections and ready/archive revisions with audit and replay evidence", async () => {
    const created = command(FOLIO, "create");
    await expect(repository.create(created)).resolves.toEqual({
      status: "created",
      folioId: FOLIO,
      revision: 1,
    });
    const corrected = {
      ...command(REVISION_2, "correct"),
      folioId: FOLIO,
      expectedRevision: 1,
      recipient: { name: "Ada Byron", email: null },
    };
    await expect(repository.correct(corrected)).resolves.toEqual({
      status: "updated",
      folioId: FOLIO,
      revision: 2,
    });
    const { bookingId: _changedBooking, ...withoutBooking } = corrected;
    await expect(repository.correct(withoutBooking)).resolves.toEqual({
      status: "conflict",
      reason: "idempotency_key_reused",
    });
    await expect(
      repository.ready({
        ...transition(REVISION_3, "ready", 2),
        folioId: FOLIO,
      }),
    ).resolves.toEqual({ status: "updated", folioId: FOLIO, revision: 3 });
    await expect(
      repository.ready({ ...transition(REVISION_3, "ready", 999), folioId: FOLIO }),
    ).resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    await expect(
      repository.archive({
        ...transition(REVISION_4, "archive", 3),
        folioId: FOLIO,
      }),
    ).resolves.toEqual({ status: "updated", folioId: FOLIO, revision: 4 });

    await admin.query(`UPDATE finance.payments SET status='failed' WHERE id='${PAYMENT}'`);
    fingerprintVersion = "v2";
    await expect(repository.create(created)).resolves.toEqual({
      status: "replayed",
      folioId: FOLIO,
      revision: 1,
    });
    const evidence = await admin.query<{
      revisions: number;
      lines: number;
      audits: number;
      plaintext: number;
    }>(`SELECT
      (SELECT count(*)::int FROM finance.folio_revisions WHERE folio_id='${FOLIO}') AS revisions,
      (SELECT count(*)::int FROM finance.folio_lines WHERE folio_id='${FOLIO}') AS lines,
      (SELECT count(*)::int FROM platform.product_audit_events
        WHERE property_id='${PROPERTY}' AND target_resource_type='folio') AS audits,
      (SELECT count(*)::int FROM platform.idempotency_keys
        WHERE property_id='${PROPERTY}' AND idempotency_metadata::text LIKE '%Ada%') AS plaintext`);
    expect(evidence.rows[0]).toEqual({ revisions: 4, lines: 4, audits: 4, plaintext: 0 });
    await expect(
      admin.query(`UPDATE finance.folio_revisions SET state='draft' WHERE id='${REVISION_3}'`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects changed idempotency reuse, stale revisions, and cross-property evidence without residue", async () => {
    const first = command(FOLIO, "same");
    await repository.create(first);
    await expect(
      repository.create({
        ...first,
        recipient: { name: "Changed", email: "changed@example.test" },
      }),
    ).resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    await expect(
      repository.ready({ ...transition(REVISION_2, "stale", 2), folioId: FOLIO }),
    ).resolves.toEqual({ status: "conflict", reason: "revision_conflict" });
    await expect(
      repository.create({ ...command(REVISION_3, "other", OTHER_PROPERTY), bookingId: BOOKING }),
    ).resolves.toEqual({ status: "invalid_evidence" });
    const residue = await admin.query<{ count: number }>(
      `SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1`,
      [OTHER_PROPERTY],
    );
    expect(residue.rows[0]?.count).toBe(0);

    const duplicatePayment = command(REVISION_4, "duplicate-payment");
    await expect(
      repository.create({
        ...duplicatePayment,
        paymentRefs: [...duplicatePayment.paymentRefs, ...duplicatePayment.paymentRefs],
      }),
    ).rejects.toThrow("folio command failed contract validation");
  });

  it("rejects empty ready state and rolls back a codec failure", async () => {
    const { bookingId: _bookingId, ...base } = command(EMPTY_FOLIO, "empty");
    await repository.create({ ...base, lines: [], paymentRefs: [] });
    await expect(
      repository.ready({ ...transition(EMPTY_READY, "empty-ready", 1), folioId: EMPTY_FOLIO }),
    ).resolves.toEqual({ status: "invalid_evidence" });
    const failing = createPgFinanceFolioCommandRepository({
      connectionString: URL!,
      recipientEncoder: {
        async encode() {
          throw new Error("kms unavailable");
        },
      },
      recipientDecoder: {
        async decode() {
          throw new Error("not called");
        },
      },
    });
    await expect(failing.create(command(CODEC_FAILURE, "codec"))).rejects.toThrow(
      "kms unavailable",
    );
    await failing.close();
    const residue = await admin.query<{ folios: number; keys: number }>(`SELECT
      (SELECT count(*)::int FROM finance.folios WHERE id='${CODEC_FAILURE}') AS folios,
      (SELECT count(*)::int FROM platform.idempotency_keys
       WHERE property_id='${PROPERTY}' AND correlation_id='correlation-finance.folio.codec') AS keys`);
    expect(residue.rows[0]).toEqual({ folios: 0, keys: 0 });
  });

  it("locks mutable payment evidence until the folio snapshot commits", async () => {
    const locking = createPgFinanceFolioCommandRepository({
      connectionString: URL!,
      recipientEncoder: {
        async encode(input) {
          return {
            ciphertext: Buffer.alloc(32, input.revision),
            encryptionScheme: "envelope_aead_v1",
            keyVersion: "kms-encryption-v1",
            fingerprint: createHash("sha256").update(JSON.stringify(input.recipient)).digest("hex"),
            fingerprintKeyVersion: "kms-fingerprint-v1",
          };
        },
      },
      recipientDecoder: {
        async decode() {
          throw new Error("not called");
        },
      },
    });
    const blocker = new pg.Client({ connectionString: URL! });
    const contender = new pg.Client({ connectionString: URL! });
    try {
      await blocker.connect();
      await contender.connect();
      await admin.query(`DROP TRIGGER IF EXISTS test_folio_payment_lock_gate ON finance.folios;
        CREATE OR REPLACE FUNCTION finance.test_folio_payment_lock_gate()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          PERFORM pg_advisory_xact_lock(1132); RETURN NEW;
        END $$;
        CREATE TRIGGER test_folio_payment_lock_gate BEFORE INSERT ON finance.folios
        FOR EACH ROW WHEN (NEW.id='${PAYMENT_LOCK_FOLIO}'::uuid)
        EXECUTE FUNCTION finance.test_folio_payment_lock_gate()`);
      await blocker.query("SELECT pg_advisory_lock(1132)");
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout='100ms'");
      const pending = locking.create(command(PAYMENT_LOCK_FOLIO, "payment-lock"));
      await waitForAdvisoryWait();
      await expect(
        contender.query("UPDATE finance.payments SET status='failed' WHERE id=$1::uuid", [PAYMENT]),
      ).rejects.toMatchObject({ code: "55P03" });
      await contender.query("ROLLBACK");
      await blocker.query("SELECT pg_advisory_unlock(1132)");
      await expect(pending).resolves.toEqual({
        status: "created",
        folioId: PAYMENT_LOCK_FOLIO,
        revision: 1,
      });
    } finally {
      await blocker.query("SELECT pg_advisory_unlock(1132)").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      await admin
        .query(
          `DROP TRIGGER IF EXISTS test_folio_payment_lock_gate ON finance.folios;
          DROP FUNCTION IF EXISTS finance.test_folio_payment_lock_gate()`,
        )
        .catch(() => undefined);
      await blocker.end().catch(() => undefined);
      await contender.end().catch(() => undefined);
      await locking.close();
    }
  });

  async function waitForAdvisoryWait() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waiting = await admin.query(
        "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted=false AND objid=1132",
      );
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("folio write did not reach the payment snapshot boundary");
  }

  function command(
    commandId: string,
    key: string,
    propertyId = PROPERTY,
  ): CreateFinanceFolioCommand {
    return {
      commandId,
      idempotencyKey: `folio-${key}`,
      propertyId,
      bookingId: BOOKING,
      recipient: { name: "Ada Lovelace", email: "ada@example.test" },
      serviceFrom: "2026-08-01",
      serviceTo: "2026-08-02",
      lines: [
        {
          position: 1,
          kind: "room",
          description: "Room night",
          quantity: "1.0000",
          unitAmount: { amount: "12.0000", currency: propertyId === PROPERTY ? "EUR" : "USD" },
          serviceOn: "2026-08-01",
          source: { type: "booking.nightly_revenue", id: EVIDENCE, revision: 1 },
        },
      ],
      paymentRefs: [
        {
          paymentId: PAYMENT,
          amount: { amount: "12.0000", currency: propertyId === PROPERTY ? "EUR" : "USD" },
        },
      ],
      audit: audit(`finance.folio.${key}`),
    };
  }
  function transition(commandId: string, key: string, expectedRevision: number) {
    return {
      commandId,
      idempotencyKey: `folio-${key}`,
      propertyId: PROPERTY,
      expectedRevision,
      audit: audit(`finance.folio.${key}`),
    };
  }
  function audit(reason: string) {
    return {
      actor: { kind: "user" as const, userId: ACTOR, organizationId: ORGANIZATION },
      requestId: `request-${reason}`,
      correlationId: `correlation-${reason}`,
      reason,
      requestedAt: "2026-08-31T00:00:00.000Z",
    };
  }
  async function cleanup() {
    await admin.query(`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM platform.product_audit_events WHERE property_id IN (${SCOPES});
      DELETE FROM platform.idempotency_keys WHERE property_id IN (${SCOPES});
      DELETE FROM finance.folio_payment_references WHERE property_id IN (${SCOPES});
      DELETE FROM finance.folio_lines WHERE property_id IN (${SCOPES});
      DELETE FROM finance.folio_revisions WHERE property_id IN (${SCOPES});
      DELETE FROM finance.folios WHERE property_id IN (${SCOPES});
      DELETE FROM finance.payments WHERE property_id IN (${SCOPES});
      DELETE FROM booking.nightly_revenue_evidence WHERE property_id IN (${SCOPES});
      DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id IN (${SCOPES});
      DELETE FROM booking.guest_bookings WHERE property_id IN (${SCOPES});
      DELETE FROM pms.property_pricing_settings WHERE property_id IN (${SCOPES});
      DELETE FROM hotel_catalog.properties WHERE id IN (${SCOPES});
      DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`);
  }
});
