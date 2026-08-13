import type { FinanceManualBookingSettlementCommand } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFinanceManualBookingSettlementPort,
  financeManualBookingSettlementTransaction,
  type FinanceManualBookingSettlementTransaction,
} from "./financeManualBookingSettlement.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const ORGANIZATION_ID = "15300000-0000-4000-8000-000000000001";
const USER_ID = "15300000-0000-4000-8000-000000000002";
const PROPERTY_ID = "15300000-0000-4000-8000-000000000003";
const BOOKING_ID = "15300000-0000-4000-8000-000000000004";
const HISTORICAL_BOOKING_ID = "15300000-0000-4000-8000-000000000005";
const CREATION_EVIDENCE_ID = "15300000-0000-4000-8000-000000000006";

describe.skipIf(!TEST_DATABASE_URL)("Finance manual booking settlement PostgreSQL port", () => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const port = createFinanceManualBookingSettlementPort();
  let client: pg.PoolClient;
  let transaction: FinanceManualBookingSettlementTransaction;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users (id, email)
       VALUES ($1::uuid, 'vay-1253@example.test')`,
      [USER_ID],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1253', 'vay-1253', 'active')`,
      [ORGANIZATION_ID],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay-1253', 'VAY-1253')`,
      [PROPERTY_ID],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings (
         id, property_id, public_reference, source_system, source_booking_id,
         lifecycle_status, payment_status, check_in, check_out, currency,
         total_amount, balance_amount, expected_payment_method, booking_metadata
       ) VALUES (
         $1::uuid, $2::uuid, 'VAY-1253-HISTORICAL', 'pms', 'vay-1253-historical',
         'confirmed', 'unpaid', '2026-09-01', '2026-09-03', 'EUR', 125.50, 125.50,
         'cash', '{"contractVersion":"pms-manual-booking.v1"}'::jsonb
       )`,
      [HISTORICAL_BOOKING_ID, PROPERTY_ID],
    );
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO booking.guest_bookings (
         id, property_id, public_reference, source_system, source_booking_id,
         lifecycle_status, payment_status, check_in, check_out, currency,
         total_amount, balance_amount, expected_payment_method, booking_metadata
       ) VALUES ($1::uuid, $2::uuid, 'VAY-1253-BOOKING', 'pms', 'vay-1253-command-current',
         'confirmed', 'unpaid', '2026-09-01', '2026-09-03', 'EUR', 125.50, 125.50,
         'cash', '{"contractVersion":"pms-manual-booking.v1"}'::jsonb)`,
      [BOOKING_ID, PROPERTY_ID],
    );
    await client.query(
      `INSERT INTO platform.idempotency_keys (
         id, operation_scope, operation, key_hash, request_fingerprint_hash,
         tenant_scope, property_id, correlation_id, expires_at, idempotency_metadata
       ) VALUES (
         $1::uuid, 'pms', 'pms.manual_booking.create', repeat('a', 64), repeat('b', 64),
         'property', $2::uuid, 'vay-1253', now() + interval '1 day',
         '{"contractVersion":"pms-manual-booking.v1","commandId":"vay-1253-command-current"}'::jsonb
       )`,
      [CREATION_EVIDENCE_ID, PROPERTY_ID],
    );
    transaction = await financeManualBookingSettlementTransaction(client);
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.query("DELETE FROM booking.guest_bookings WHERE id = $1::uuid", [
      HISTORICAL_BOOKING_ID,
    ]);
    await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [PROPERTY_ID]);
    await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [ORGANIZATION_ID]);
    await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [USER_ID]);
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query("SAVEPOINT test_case");
  });

  afterEach(async () => {
    await client.query("ROLLBACK TO SAVEPOINT test_case");
  });

  it("writes one provider-free manual paid fact and exactly replays it", async () => {
    const input = {
      transaction,
      bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
      command: command("create-and-replay"),
    };
    const created = await port.settleFull(input);
    await expect(
      port.settleFull({
        transaction,
        bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
        command: {
          ...input.command,
          audit: {
            ...input.command.audit,
            requestId: "retry-request",
            requestedAt: "2026-08-12T09:05:00.000Z",
          },
        },
      }),
    ).resolves.toEqual(created);
    await client.query(
      `UPDATE booking.guest_bookings
       SET lifecycle_status = 'canceled', total_amount = 130.00, balance_amount = 130.00
       WHERE id = $1::uuid`,
      [BOOKING_ID],
    );
    await expect(port.settleFull(input)).resolves.toEqual(created);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM finance.payments WHERE source_payment_id = $1",
          [input.command.payload.sourceReference],
        )
      ).rows[0]?.count,
    ).toBe(1);

    const payment = await client.query(
      `SELECT payment_kind AS "paymentKind", payment_method AS "paymentMethod",
              status, amount::text, net_amount::text AS "netAmount", currency,
              source_system AS "sourceSystem", provider_account_id AS "providerAccountId",
              provider_transaction_id AS "providerTransactionId",
              provider_payment_intent_id AS "providerPaymentIntentId",
              payment_metadata->>'operatorReference' AS "operatorReference"
       FROM finance.payments WHERE id = $1::uuid`,
      [created.paymentEvidenceId],
    );
    expect(payment.rows[0]).toEqual({
      paymentKind: "manual",
      paymentMethod: "cash",
      status: "paid",
      amount: "125.50",
      netAmount: "125.50",
      currency: "EUR",
      sourceSystem: "pms",
      providerAccountId: null,
      providerTransactionId: null,
      providerPaymentIntentId: null,
      operatorReference: "receipt 42",
    });
  });

  it("rejects reuse with changed facts or a changed key", async () => {
    const original = command("conflict");
    await port.settleFull({
      transaction,
      bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
      command: original,
    });
    await expect(
      port.settleFull({
        transaction,
        bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
        command: { ...original, payload: { ...original.payload, paymentMethod: "other" } },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      port.settleFull({
        transaction,
        bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
        command: { ...original, idempotencyKey: "changed-key" },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects false totals, currencies, properties, and duplicate creation keys", async () => {
    const cases = [
      { amount: "1.00" },
      { currency: "USD" },
      { paymentMethod: "bank_transfer" },
    ] as const;
    for (const [index, change] of cases.entries()) {
      await expect(
        port.settleFull({
          transaction,
          bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
          command: {
            ...command(`authoritative-${index}`),
            payload: { ...command(`authoritative-${index}`).payload, ...change },
          },
        }),
      ).rejects.toMatchObject({
        code: ["non_full_settlement", "cross_currency", "invalid_command"][index],
      });
    }
    await expect(
      port.settleFull({
        transaction,
        bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
        command: { ...command("wrong-property"), propertyId: USER_ID },
      }),
    ).rejects.toMatchObject({ code: "cross_property" });

    const original = command("one-per-booking");
    await port.settleFull({
      transaction,
      bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
      command: original,
    });
    await expect(
      port.settleFull({
        transaction,
        bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
        command: command("second-key-and-source"),
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rolls its payment back with the caller transaction", async () => {
    await client.query("SAVEPOINT caller_transaction");
    const created = await port.settleFull({
      transaction,
      bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
      command: command("caller-rollback"),
    });
    await client.query("ROLLBACK TO SAVEPOINT caller_transaction");
    expect(
      (
        await client.query("SELECT count(*)::int AS count FROM finance.payments WHERE id = $1", [
          created.paymentEvidenceId,
        ])
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("requires an open caller transaction and current-transaction booking", async () => {
    const outside = await pool.connect();
    try {
      const unscoped = await financeManualBookingSettlementTransaction(outside);
      await expect(
        port.settleFull({
          transaction: unscoped,
          bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
          command: command("no-begin"),
        }),
      ).rejects.toMatchObject({ code: "invalid_command" });
    } finally {
      outside.release();
    }
    const historical = command("historical");
    historical.payload.booking.guestBookingId = HISTORICAL_BOOKING_ID;
    historical.payload.sourceReference = "pms-manual-booking:vay-1253-historical";
    await client.query(
      `UPDATE booking.guest_bookings
       SET created_at = transaction_timestamp(), updated_at = now()
       WHERE id = $1::uuid`,
      [HISTORICAL_BOOKING_ID],
    );
    await expect(
      port.settleFull({
        transaction,
        bookingCreationEvidenceId: CREATION_EVIDENCE_ID,
        command: historical,
      }),
    ).rejects.toMatchObject({ code: "invalid_command" });
  });
});

function command(suffix: string): FinanceManualBookingSettlementCommand {
  return {
    commandType: "finance.manual_booking.settle_full",
    commandId: `manual-booking-${suffix}`,
    idempotencyKey: `manual-booking-key-${suffix}`,
    propertyId: PROPERTY_ID,
    audit: {
      actor: { kind: "user", userId: USER_ID, organizationId: ORGANIZATION_ID },
      requestId: `request-${suffix}`,
      reason: "Manual booking paid at creation",
      requestedAt: "2026-08-12T09:00:00.000Z",
    },
    payload: {
      booking: {
        guestBookingId: BOOKING_ID,
      },
      amount: "125.50",
      currency: "EUR",
      paymentMethod: "cash",
      sourceReference: "pms-manual-booking:vay-1253-command-current",
      operatorReference: "receipt 42",
      acceptedAt: "2026-08-12T09:00:00.000Z",
    },
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
