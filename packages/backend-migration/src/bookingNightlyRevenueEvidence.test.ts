import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0069_booking_nightly_revenue_evidence.sql"),
  "utf8",
);
const adjustments = await readFile(
  join(import.meta.dirname, "../migrations/0070_booking_nightly_revenue_adjustments.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
const ROOM_TYPE_A = "30000000-0000-4000-8000-000000000001";

describe("Booking nightly revenue evidence migration contract", () => {
  it("exposes a Finance-safe view without mutable pricing or source payloads", () => {
    expect(migration).toContain("booking.finance_nightly_revenue_evidence");
    expect(migration).not.toMatch(/rate_plan|booking_metadata|source_payload|JSONB/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Booking nightly revenue evidence (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP SCHEMA IF EXISTS booking CASCADE; CREATE SCHEMA booking;
      CREATE TABLE booking.guest_bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID NOT NULL,
        currency CHAR(3) NOT NULL, UNIQUE (id, property_id));
    `);
    await client.query(migration);
    await client.query(adjustments);
  });

  afterAll(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
    } finally {
      await client.end();
    }
  });

  const createBooking = async (property = PROPERTY_A, currency = "EUR") =>
    (
      await client.query<{ id: string }>(
        "INSERT INTO booking.guest_bookings (property_id, currency) VALUES ($1, $2) RETURNING id",
        [property, currency],
      )
    ).rows[0]!.id;
  const insertEvidence = (
    booking: string,
    overrides: Partial<{
      id: string;
      property: string;
      roomType: string | null;
      stayDate: string;
      recognizedOn: string;
      currency: string;
      amount: string | null;
      occupied: number;
      event: string;
      lifecycle: string;
      source: string;
      quality: string;
      revision: number;
      corrects: string | null;
      key: string;
    }> = {},
    executor: pg.Client = client,
  ) => {
    const values = {
      id: crypto.randomUUID(),
      property: PROPERTY_A,
      roomType: ROOM_TYPE_A,
      stayDate: "2026-09-01",
      recognizedOn: "2026-09-01",
      currency: "EUR",
      amount: "120.00",
      occupied: 1,
      event: "room_night",
      lifecycle: "completed",
      source: "direct",
      quality: "exact",
      revision: 1,
      corrects: null,
      key: crypto.randomUUID(),
      ...overrides,
    };
    return executor.query(
      `INSERT INTO booking.nightly_revenue_evidence
       (id, property_id, guest_booking_id, room_type_id, stay_date, recognized_on,
        currency, gross_room_amount, occupied_room_nights, economic_event, lifecycle_state,
        source_kind, evidence_quality, source_revision, corrects_evidence_id, command_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        values.id,
        values.property,
        booking,
        values.roomType,
        values.stayDate,
        values.recognizedOn,
        values.currency,
        values.amount,
        values.occupied,
        values.event,
        values.lifecycle,
        values.source,
        values.quality,
        values.revision,
        values.corrects,
        values.key,
      ],
    );
  };
  const rejects = (query: Promise<unknown>, expected: { code?: string; constraint?: string }) =>
    expect(query).rejects.toMatchObject(expected);

  it("reverses zero and missing room nights without rewriting evidence", async () => {
    const booking = await createBooking();
    const exact = (await insertEvidence(booking, { amount: "0" })).rows[0]!.id as string;
    await insertEvidence(booking, {
      event: "room_night_reversal",
      lifecycle: "canceled",
      amount: "0",
      occupied: -1,
      revision: 2,
      corrects: exact,
    });
    const missing = (
      await insertEvidence(booking, {
        amount: null,
        roomType: ROOM_TYPE_A,
        quality: "missing",
        revision: 3,
        stayDate: "2026-09-02",
        recognizedOn: "2026-09-02",
      })
    ).rows[0]!.id as string;
    const missingReversal = {
      event: "room_night_reversal",
      lifecycle: "no_show",
      amount: null,
      occupied: -1,
      quality: "missing",
      revision: 4,
      corrects: missing,
      stayDate: "2026-09-02",
      recognizedOn: "2026-09-02",
    };
    await rejects(insertEvidence(booking, { ...missingReversal, roomType: null }), {
      code: "23514",
    });
    await insertEvidence(booking, { ...missingReversal, roomType: ROOM_TYPE_A });
    const visible = await client.query(
      `SELECT SUM(occupied_room_nights)::INT AS occupied, SUM(gross_room_amount)::TEXT AS amount,
         COUNT(*) FILTER (WHERE economic_event = 'room_night_reversal')::INT AS reversals
       FROM booking.finance_nightly_revenue_evidence WHERE guest_booking_id = $1`,
      [booking],
    );
    expect(visible.rows[0]).toEqual({ occupied: 0, amount: "0.0000", reversals: 2 });
    await rejects(
      client.query(
        "UPDATE booking.nightly_revenue_evidence SET gross_room_amount = 1 WHERE id = $1",
        [exact],
      ),
      { code: "23514" },
    );
    await rejects(
      client.query("DELETE FROM booking.nightly_revenue_evidence WHERE id = $1", [exact]),
      { code: "23514" },
    );
    await rejects(client.query("TRUNCATE booking.nightly_revenue_evidence"), { code: "23514" });
  });

  it("rejects fabricated missing facts and malformed economic events", async () => {
    const booking = await createBooking();
    await rejects(insertEvidence(booking, { quality: "missing" }), {
      constraint: "chk_booking_nightly_revenue_evidence_quality",
    });
    for (const overrides of [
      { event: "refund", amount: "-10" },
      { lifecycle: "canceled", revision: 2 },
    ])
      await rejects(insertEvidence(booking, overrides), {
        constraint: "chk_booking_nightly_revenue_evidence_event",
      });
    for (const amount of ["NaN", "Infinity", "-Infinity"]) {
      await expect(insertEvidence(booking, { amount, revision: 3 })).rejects.toBeDefined();
    }
  });

  it("supports exact date-change occupancy adjustments", async () => {
    const booking = await createBooking();
    const original = (await insertEvidence(booking)).rows[0]!.id as string;
    const adjustment = {
      event: "occupancy_adjustment",
      lifecycle: "corrected",
      corrects: original,
    };
    await rejects(insertEvidence(booking, { ...adjustment, occupied: 1, revision: 2 }), {
      code: "23514",
    });
    await rejects(
      insertEvidence(booking, { ...adjustment, amount: "-100", occupied: -1, revision: 2 }),
      { code: "23514" },
    );
    const removed = (
      await insertEvidence(booking, {
        ...adjustment,
        amount: "-120",
        occupied: -1,
        revision: 2,
      })
    ).rows[0]!.id as string;
    await rejects(
      insertEvidence(booking, { ...adjustment, amount: "-120", occupied: -1, revision: 3 }),
      { code: "23514" },
    );
    await rejects(
      insertEvidence(booking, {
        event: "room_night_reversal",
        lifecycle: "canceled",
        amount: "-120",
        occupied: -1,
        revision: 3,
        corrects: original,
      }),
      { code: "23514" },
    );
    const readded = (
      await insertEvidence(booking, {
        event: "occupancy_adjustment",
        lifecycle: "corrected",
        amount: "120",
        occupied: 1,
        revision: 3,
        corrects: removed,
      })
    ).rows[0]!.id as string;
    await rejects(
      insertEvidence(booking, {
        ...adjustment,
        lifecycle: "canceled",
        amount: "-120",
        occupied: -1,
        recognizedOn: "2026-09-10",
        revision: 4,
        corrects: readded,
      }),
      { constraint: "chk_booking_nightly_revenue_evidence_event" },
    );
    const canceled = (
      await insertEvidence(booking, {
        ...adjustment,
        lifecycle: "canceled",
        amount: "-120",
        occupied: -1,
        revision: 4,
        corrects: readded,
      })
    ).rows[0]!.id as string;
    await rejects(
      insertEvidence(booking, {
        ...adjustment,
        lifecycle: "canceled",
        amount: "120",
        occupied: 1,
        revision: 5,
        corrects: canceled,
      }),
      { constraint: "chk_booking_nightly_revenue_evidence_event" },
    );
    const aggregate = await client.query(
      `SELECT SUM(gross_room_amount)::TEXT AS amount, SUM(occupied_room_nights)::INT AS occupied
       FROM booking.finance_nightly_revenue_evidence WHERE guest_booking_id = $1`,
      [booking],
    );
    expect(aggregate.rows[0]).toEqual({ amount: "0.0000", occupied: 0 });
  });

  it("rejects concurrent mixed occupancy changes against one tip", async () => {
    const booking = await createBooking();
    const original = (await insertEvidence(booking)).rows[0]!.id as string;
    const peer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await peer.connect();
    const peerPid = (await peer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
      .pid;
    try {
      await client.query("BEGIN");
      await insertEvidence(booking, {
        event: "occupancy_adjustment",
        lifecycle: "corrected",
        amount: "-120",
        occupied: -1,
        revision: 2,
        corrects: original,
      });
      await peer.query("BEGIN");
      const collision = insertEvidence(
        booking,
        {
          event: "room_night_reversal",
          lifecycle: "canceled",
          amount: "-120",
          occupied: -1,
          revision: 2,
          corrects: original,
        },
        peer,
      );
      await expect
        .poll(async () => {
          const result = await client.query<{ blockers: number }>(
            "SELECT cardinality(pg_blocking_pids($1)) AS blockers",
            [peerPid],
          );
          return result.rows[0]?.blockers ?? 0;
        })
        .toBeGreaterThan(0);
      await client.query("COMMIT");
      await rejects(collision, { code: "23505" });
    } finally {
      await client.query("ROLLBACK");
      await peer.query("ROLLBACK");
      await peer.end();
    }
  });

  it("stores exact refund and correction links without rewriting history", async () => {
    const booking = await createBooking();
    const original = (await insertEvidence(booking)).rows[0]!.id as string;
    await insertEvidence(booking, {
      event: "refund",
      lifecycle: "refunded",
      amount: "-20",
      occupied: 0,
      recognizedOn: "2026-09-10",
      revision: 2,
      corrects: original,
    });
  });

  it("rejects wrong-booking and inexact correction targets", async () => {
    const booking = await createBooking();
    const original = (await insertEvidence(booking)).rows[0]!.id as string;
    const correction = {
      event: "correction",
      lifecycle: "corrected",
      amount: "-5",
      occupied: 0,
      revision: 2,
      corrects: original,
    };
    const other = await createBooking(PROPERTY_B);
    await rejects(
      insertEvidence(other, {
        ...correction,
        property: PROPERTY_B,
      }),
      { code: "23503" },
    );
    for (const overrides of [
      { stayDate: "2026-09-02" },
      { roomType: crypto.randomUUID() },
      { revision: 1 },
    ])
      await rejects(insertEvidence(booking, { ...correction, ...overrides }), { code: "23514" });
    const first = crypto.randomUUID(),
      second = crypto.randomUUID();
    await rejects(
      client.query(
        `INSERT INTO booking.nightly_revenue_evidence (id, property_id, guest_booking_id, room_type_id, stay_date, recognized_on, currency, gross_room_amount, occupied_room_nights, economic_event, lifecycle_state, source_kind, evidence_quality, source_revision, corrects_evidence_id, command_key)
       SELECT v.id, $3, $4, $5, DATE '2026-09-01', DATE '2026-09-10', 'EUR', -5, 0, 'correction', 'corrected', 'direct', 'exact', v.revision, v.corrects, v.id::TEXT FROM (VALUES ($1::UUID, $2::UUID, 2), ($2::UUID, $1::UUID, 3)) v(id, corrects, revision)`,
        [first, second, PROPERTY_A, booking, ROOM_TYPE_A],
      ),
      { code: "23503" },
    );
  });

  it("deduplicates source lines and command replays", async () => {
    const booking = await createBooking();
    const key = crypto.randomUUID();
    await insertEvidence(booking, { key });
    await rejects(insertEvidence(booking, { revision: 2, key }), {
      constraint: "uq_booking_nightly_revenue_evidence_command",
    });
    await rejects(insertEvidence(booking), {
      constraint: "uq_booking_nightly_revenue_evidence_source_line",
    });
    await rejects(insertEvidence(booking, { revision: 2 }), {
      constraint: "uq_booking_nightly_revenue_evidence_base_room_night",
    });
  });
});
