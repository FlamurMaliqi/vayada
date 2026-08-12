import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExternalRevenueEvidenceConflictError,
  ExternalRevenueEvidenceScopeError,
  appendExternalNightlyRevenueEvidence,
  type AppendExternalRevenueEvidenceCommand,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "42000000-0000-4000-8000-000000000001";
const OTA_BOOKING = "42000000-0000-4000-8000-000000000002";
const MANUAL_BOOKING = "42000000-0000-4000-8000-000000000003";
const ROOM_TYPE = "42000000-0000-4000-8000-000000000004";
const migration = (name: string) =>
  readFile(
    join(import.meta.dirname, "../../../../packages/backend-migration/migrations", name),
    "utf8",
  );

describe.skipIf(!TEST_DATABASE_URL)("external nightly revenue evidence (PostgreSQL)", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const roomNight = (
    stayDate: string,
    linePosition: number,
    grossRoomAmount: string | null,
    evidenceQuality: "exact" | "inferred" | "missing",
  ): ExternalRevenueEvidenceLine => ({
    roomTypeId: evidenceQuality === "missing" ? null : ROOM_TYPE,
    stayDate,
    recognizedOn: stayDate,
    grossRoomAmount,
    occupiedRoomNights: 1,
    economicEvent: "room_night",
    lifecycleState: "confirmed",
    evidenceQuality,
    linePosition,
  });
  const command = (
    overrides: Partial<AppendExternalRevenueEvidenceCommand> = {},
  ): AppendExternalRevenueEvidenceCommand => ({
    propertyId: PROPERTY,
    guestBookingId: OTA_BOOKING,
    sourceKind: "ota",
    sourceBookingReference: "channex:booking-7",
    idempotencyKey: "channex:booking-7:revision-1",
    lines: [
      roomNight("2026-09-01", 1, "100", "exact"),
      roomNight("2026-09-01", 2, "50", "inferred"),
      roomNight("2026-09-02", 1, null, "missing"),
    ],
    ...overrides,
  });

  beforeAll(async () => {
    const database = new URL(TEST_DATABASE_URL!).pathname;
    if (!/test/i.test(database)) throw new Error(`Refusing non-test database ${database}`);
    await client.connect();
    const [schema, adjustments] = await Promise.all([
      migration("0071_booking_nightly_revenue_evidence.sql"),
      migration("0072_booking_nightly_revenue_adjustments.sql"),
    ]);
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; DROP SCHEMA IF EXISTS booking CASCADE;
      CREATE SCHEMA booking; CREATE TABLE booking.guest_bookings (
        id uuid PRIMARY KEY, property_id uuid NOT NULL, currency char(3) NOT NULL,
        source_system text NOT NULL, source_booking_id text,
        UNIQUE (id, property_id), UNIQUE (source_system, source_booking_id));`);
    await client.query(schema);
    await client.query(adjustments);
    await client.query(
      `INSERT INTO booking.guest_bookings VALUES
       ($1, $3, 'EUR', 'pms', 'channex:booking-7'), ($2, $3, 'EUR', 'pms', 'manual:booking-8')`,
      [OTA_BOOKING, MANUAL_BOOKING, PROPERTY],
    );
  });
  afterAll(async () => {
    await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
    await client.end();
  });

  it("appends explicit qualities and lifecycle evidence with scoped replay", async () => {
    const first = await appendExternalNightlyRevenueEvidence(client, command());
    expect(first).toMatchObject({ outcome: "appended", sourceRevision: 1 });
    const [exact, ...rest] = command().lines;
    const reordered = Object.assign(Object.fromEntries(Object.entries(exact!).reverse()), {
      providerPayload: { secret: "not-booking-evidence" },
    }) as unknown as ExternalRevenueEvidenceLine;
    expect(
      await appendExternalNightlyRevenueEvidence(client, command({ lines: [reordered, ...rest] })),
    ).toMatchObject({
      outcome: "replayed",
      evidenceIds: first.evidenceIds,
    });
    await expect(
      appendExternalNightlyRevenueEvidence(
        client,
        command({ lines: [roomNight("2026-09-01", 1, "101", "exact")] }),
      ),
    ).rejects.toBeInstanceOf(ExternalRevenueEvidenceConflictError);
    await expect(
      appendExternalNightlyRevenueEvidence(client, command({ sourceBookingReference: "wrong" })),
    ).rejects.toBeInstanceOf(ExternalRevenueEvidenceScopeError);

    const rows = await client.query(
      `SELECT gross_room_amount::text AS amount, evidence_quality AS quality
       FROM booking.nightly_revenue_evidence ORDER BY stay_date, line_position`,
    );
    expect(rows.rows).toEqual([
      { amount: "100.0000", quality: "exact" },
      { amount: "50.0000", quality: "inferred" },
      { amount: null, quality: "missing" },
    ]);
  });

  it("accepts the maximum manual-booking room-night set", async () => {
    const start = Date.parse("2028-01-01T00:00:00Z");
    const lines = Array.from({ length: 20 * 370 }, (_, index) =>
      roomNight(
        new Date(start + Math.floor(index / 20) * 86_400_000).toISOString().slice(0, 10),
        (index % 20) + 1,
        "1",
        "exact",
      ),
    );
    await expect(
      appendExternalNightlyRevenueEvidence(client, command({ lines: lines.slice(0, 1_001) })),
    ).rejects.toThrow("External evidence lines are malformed");
    const result = await appendExternalNightlyRevenueEvidence(
      client,
      command({
        guestBookingId: MANUAL_BOOKING,
        sourceKind: "manual",
        sourceBookingReference: "manual:booking-8",
        idempotencyKey: "manual:booking-8:maximum-stay",
        lines,
      }),
    );
    expect(result.evidenceIds).toHaveLength(20 * 370);
  });

  it("serializes a reused key across different bookings", async () => {
    const peer = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await peer.connect();
    const peerPid = (await peer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!
      .pid;
    try {
      await client.query("BEGIN");
      await appendExternalNightlyRevenueEvidence(
        client,
        command({
          idempotencyKey: "shared-key",
          lines: [roomNight("2026-11-01", 1, "90", "exact")],
        }),
      );
      await peer.query("BEGIN");
      const conflict = appendExternalNightlyRevenueEvidence(
        peer,
        command({
          guestBookingId: MANUAL_BOOKING,
          sourceBookingReference: "manual:booking-8",
          idempotencyKey: "shared-key",
          lines: [roomNight("2026-11-01", 1, "91", "exact")],
        }),
      );
      await expect
        .poll(async () =>
          Number(
            (await client.query("SELECT cardinality(pg_blocking_pids($1)) AS count", [peerPid]))
              .rows[0]?.count,
          ),
        )
        .toBeGreaterThan(0);
      await client.query("COMMIT");
      await expect(conflict).rejects.toBeInstanceOf(ExternalRevenueEvidenceConflictError);
    } finally {
      await client.query("ROLLBACK");
      await peer.query("ROLLBACK");
      await peer.end();
    }
  });
});
