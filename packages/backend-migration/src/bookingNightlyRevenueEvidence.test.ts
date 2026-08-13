import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0073_booking_nightly_revenue_evidence.sql"),
  "utf8",
);
const adjustmentMigrations = await Promise.all(
  [
    "0074_booking_nightly_revenue_adjustment_index.sql",
    "0075_booking_nightly_revenue_adjustments.sql",
    "0076_validate_booking_nightly_revenue_adjustments.sql",
    "0077_booking_nightly_revenue_date_changes.sql",
    "0082_booking_nightly_revenue_stay_corrections.sql",
    "0083_validate_booking_nightly_revenue_stay_corrections.sql",
  ].map((file) => readFile(join(import.meta.dirname, "../migrations", file), "utf8")),
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";
const ROOM_TYPE_A = "30000000-0000-4000-8000-000000000001";
const ROOM_TYPE_B = "30000000-0000-4000-8000-000000000002";

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
        currency CHAR(3) NOT NULL, check_in DATE NOT NULL DEFAULT '2026-09-01',
        check_out DATE NOT NULL DEFAULT '2026-09-03', UNIQUE (id, property_id));
    `);
    await client.query(migration);
    for (const migrationSql of adjustmentMigrations)
      for (const statement of migrationSql.split("-- vayada:next-statement"))
        await client.query(statement);
  });

  afterAll(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
    } finally {
      await client.end();
    }
  });

  const createBooking = async (property = PROPERTY_A, currency = "EUR", room = ROOM_TYPE_A) => {
    const id = await client.query<{ id: string }>(
      "INSERT INTO booking.guest_bookings (property_id, currency) VALUES ($1, $2) RETURNING id",
      [property, currency],
    );
    await client.query(
      "INSERT INTO booking.nightly_revenue_room_scopes VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [property, room],
    );
    return id.rows[0]!.id;
  };
  const insertEvidence = (
    booking: string,
    overrides: Record<string, string | number | null | undefined> = {},
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
      recognizedOn: "2026-09-02",
      revision: 2,
      corrects: exact,
    });
    const missing = (
      await insertEvidence(booking, {
        amount: null,
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
      { code: "55000" },
    );
  });

  it("rejects fabricated missing facts and malformed economic events", async () => {
    const booking = await createBooking();
    await rejects(insertEvidence(booking, { quality: "missing" }), {
      constraint: "chk_booking_nightly_revenue_evidence_quality",
    });
    for (const overrides of [
      { event: "refund", amount: "-10" },
      { event: "retained_charge", lifecycle: "canceled", occupied: 0, recognizedOn: "2026-08-31" },
      { lifecycle: "canceled", revision: 2 },
    ])
      await rejects(insertEvidence(booking, overrides), {
        constraint: "chk_booking_nightly_revenue_evidence_event",
      });
    for (const amount of ["NaN", "Infinity", "-Infinity"]) {
      await expect(insertEvidence(booking, { amount, revision: 3 })).rejects.toBeDefined();
    }
    await rejects(insertEvidence(booking, { stayDate: "infinity", recognizedOn: "infinity" }), {
      constraint: "chk_booking_nightly_revenue_evidence_dates",
    });
    await rejects(insertEvidence(booking, { stayDate: "2026-09-04", recognizedOn: "2026-09-04" }), {
      constraint: "chk_booking_nightly_revenue_evidence_booking_stay",
    });
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
    const other = await createBooking(PROPERTY_B, "EUR", ROOM_TYPE_B);
    await rejects(
      insertEvidence(booking, {
        roomType: ROOM_TYPE_B,
        revision: 2,
        stayDate: "2026-09-02",
        recognizedOn: "2026-09-02",
      }),
      { code: "23503" },
    );
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
      { recognizedOn: "2026-08-31" },
    ])
      await rejects(insertEvidence(booking, { ...correction, ...overrides }), { code: "23514" });
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

  it("toggles current-tip occupancy without rewriting prior evidence", async () => {
    const booking = await createBooking();
    const original = (await insertEvidence(booking)).rows[0]!.id as string;
    const adjustment = {
      event: "occupancy_adjustment",
      lifecycle: "corrected",
      corrects: original,
    };
    for (const overrides of [
      { occupied: 1, revision: 2 },
      { amount: "-100", occupied: -1, revision: 2 },
    ])
      await rejects(insertEvidence(booking, { ...adjustment, ...overrides }), {
        constraint: "chk_booking_nightly_revenue_evidence_occupancy_transition",
      });
    const removed = (
      await insertEvidence(booking, {
        ...adjustment,
        amount: "-120",
        occupied: -1,
        recognizedOn: "2026-09-02",
        revision: 2,
      })
    ).rows[0]!.id as string;
    await rejects(
      insertEvidence(booking, { ...adjustment, amount: "-120", occupied: -1, revision: 3 }),
      { constraint: "chk_booking_nightly_revenue_evidence_occupancy_transition" },
    );
    const readded = (
      await insertEvidence(booking, {
        event: "occupancy_adjustment",
        lifecycle: "corrected",
        amount: "125",
        occupied: 1,
        recognizedOn: "2026-09-03",
        revision: 3,
        corrects: removed,
      })
    ).rows[0]!.id as string;
    await rejects(
      insertEvidence(booking, {
        ...adjustment,
        amount: "-125",
        occupied: -1,
        recognizedOn: "2026-09-02",
        revision: 4,
        corrects: readded,
      }),
      { code: "23514" },
    );
    await insertEvidence(booking, {
      ...adjustment,
      lifecycle: "canceled",
      amount: "-125",
      occupied: -1,
      recognizedOn: "2026-09-04",
      revision: 4,
      corrects: readded,
    });
    const aggregate = await client.query(
      `SELECT SUM(gross_room_amount)::TEXT AS amount, SUM(occupied_room_nights)::INT AS occupied,
              COUNT(*)::INT AS revisions
         FROM booking.finance_nightly_revenue_evidence WHERE guest_booking_id = $1`,
      [booking],
    );
    expect(aggregate.rows[0]).toEqual({ amount: "0.0000", occupied: 0, revisions: 4 });
  });

  it("adds corrected stay dates and changes room type only when re-adding occupancy", async () => {
    const booking = await createBooking();
    await client.query("INSERT INTO booking.nightly_revenue_room_scopes VALUES ($1,$2)", [
      PROPERTY_A,
      ROOM_TYPE_B,
    ]);
    const original = (await insertEvidence(booking)).rows[0]!.id as string;
    await rejects(
      insertEvidence(booking, {
        roomType: ROOM_TYPE_B,
        amount: "-120",
        occupied: -1,
        event: "occupancy_adjustment",
        lifecycle: "corrected",
        revision: 2,
        corrects: original,
      }),
      { code: "23514" },
    );
    const removed = (
      await insertEvidence(booking, {
        amount: "-120",
        occupied: -1,
        event: "occupancy_adjustment",
        lifecycle: "corrected",
        revision: 2,
        corrects: original,
      })
    ).rows[0]!.id as string;
    await insertEvidence(booking, {
      roomType: ROOM_TYPE_B,
      source: "manual",
      amount: "120",
      occupied: 1,
      event: "occupancy_adjustment",
      lifecycle: "corrected",
      recognizedOn: "2026-09-02",
      revision: 3,
      corrects: removed,
    });
    await client.query("UPDATE booking.guest_bookings SET check_out='2026-09-05' WHERE id=$1", [
      booking,
    ]);
    await rejects(
      insertEvidence(booking, {
        stayDate: "2026-09-04",
        recognizedOn: "2026-09-04",
        occupied: 1,
        event: "occupancy_adjustment",
        lifecycle: "corrected",
        revision: 4,
      }),
      { constraint: "chk_booking_nightly_revenue_evidence_event" },
    );
    await insertEvidence(booking, {
      roomType: ROOM_TYPE_B,
      source: "manual",
      stayDate: "2026-09-04",
      recognizedOn: "2026-09-04",
      amount: "80",
      occupied: 1,
      event: "occupancy_adjustment",
      lifecycle: "corrected",
      revision: 4,
      corrects: null,
    });
  });

  it("serializes concurrent mixed removals against one tip", async () => {
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
});
