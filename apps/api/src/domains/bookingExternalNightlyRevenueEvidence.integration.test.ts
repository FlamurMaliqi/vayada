import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ExternalRevenueEvidenceScopeError,
  appendExternalNightlyRevenueEvidence,
  type AppendExternalRevenueEvidenceCommand,
  type ExternalRevenueEvidenceLine,
} from "./bookingExternalNightlyRevenueEvidence.js";
const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = randomUUID(),
  OTA_BOOKING = randomUUID(),
  DIRECT_BOOKING = randomUUID(),
  ROOM_TYPE = randomUUID();
const OTHER_PROPERTY = randomUUID(),
  OTHER_ROOM_TYPE = randomUUID();
const OTA_REFERENCE = `external:${randomUUID()}`;

describe.skipIf(!DATABASE_URL)("external nightly revenue evidence (PostgreSQL)", () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  const peers: pg.Client[] = [];
  const line = (
    stayDate: string,
    grossRoomAmount: string | null,
    evidenceQuality: "exact" | "inferred" | "missing",
    overrides: Partial<ExternalRevenueEvidenceLine> = {},
  ): ExternalRevenueEvidenceLine => ({
    roomTypeId: ROOM_TYPE,
    stayDate,
    recognizedOn: stayDate,
    grossRoomAmount,
    occupiedRoomNights: 1,
    economicEvent: "room_night",
    lifecycleState: "confirmed",
    evidenceQuality,
    linePosition: 1,
    ...overrides,
  });
  const command = (
    overrides: Partial<AppendExternalRevenueEvidenceCommand> = {},
  ): AppendExternalRevenueEvidenceCommand => ({
    propertyId: PROPERTY,
    guestBookingId: OTA_BOOKING,
    sourceKind: "ota",
    sourceBookingReference: OTA_REFERENCE,
    idempotencyKey: "external-revision-1",
    lines: [
      line("2026-09-01", "100", "exact"),
      line("2026-09-01", "50", "inferred", { linePosition: 2 }),
      line("2026-09-02", null, "missing"),
    ],
    ...overrides,
  });
  const append = (overrides: Partial<AppendExternalRevenueEvidenceCommand> = {}, db = client) =>
    appendExternalNightlyRevenueEvidence(db, command(overrides));
  beforeAll(async () => {
    if (!/test/i.test(new URL(DATABASE_URL!).pathname)) throw new Error("Refusing non-test DB");
    await client.connect();
    await client.query(
      "INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1,$1::uuid::text,'Revenue test'),($2,$2::uuid::text,'Other')",
      [PROPERTY, OTHER_PROPERTY],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
       (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,
        check_in,check_out,room_count,currency,total_amount,balance_amount)
       VALUES ($1,$3,$1::uuid::text,'pms',$4,'confirmed','unpaid','2026-09-01','2026-12-01',2,'EUR',0,0),
         ($2,$3,$2::uuid::text,'booking',NULL,'confirmed','unpaid','2026-09-01','2026-12-01',1,'EUR',0,0)`,
      [OTA_BOOKING, DIRECT_BOOKING, PROPERTY, OTA_REFERENCE],
    );
    const roomScopes = [PROPERTY, ROOM_TYPE, OTHER_PROPERTY, OTHER_ROOM_TYPE];
    await client.query(
      "INSERT INTO booking.nightly_revenue_room_scopes (property_id,room_type_id) VALUES ($1,$2),($3,$4)",
      roomScopes,
    );
  });
  beforeEach(() => client.query("BEGIN"));
  afterEach(async () => {
    await client.query("ROLLBACK");
    for (const peer of peers.splice(0)) await peer.query("ROLLBACK").finally(() => peer.end());
  });
  afterAll(async () => {
    await client.query("SET session_replication_role=replica");
    const properties = [[PROPERTY, OTHER_PROPERTY]];
    await client.query(
      `WITH evidence AS (DELETE FROM booking.nightly_revenue_evidence WHERE property_id=ANY($1::uuid[])),
       rooms AS (DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id=ANY($1::uuid[])),
       bookings AS (DELETE FROM booking.guest_bookings WHERE property_id=ANY($1::uuid[]))
       DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])`,
      properties,
    );
    await client.query("SET session_replication_role=origin");
    await client.end();
  });

  it("preserves explicit quality, private scope, and strict replay", async () => {
    const first = await append();
    expect(await append()).toEqual({ ...first, outcome: "replayed" });
    await expect(append({ sourceKind: "manual" })).rejects.toMatchObject({
      code: "external_evidence_idempotency_conflict",
    });
    for (const overrides of [
      { propertyId: randomUUID() },
      { sourceBookingReference: "wrong" },
      { guestBookingId: DIRECT_BOOKING },
      { lines: [line("2026-09-01", "1", "exact", { roomTypeId: OTHER_ROOM_TYPE })] },
      { lines: [line("2026-09-01", "1", "exact", { linePosition: 3 })] },
    ])
      await expect(append(overrides)).rejects.toBeInstanceOf(ExternalRevenueEvidenceScopeError);
    for (const lines of [
      [null],
      [line("2026-02-30", "1", "exact")],
      [{ ...line("2026-09-01", "1", "exact"), stayDate: 123 }],
      [{ ...line("2026-09-01", "1", "exact"), grossRoomAmount: 123 }],
    ])
      await expect(append({ lines } as never)).rejects.toThrow();
    const evidence = await client.query<{ ok: boolean }>(
      `SELECT string_agg(COALESCE(gross_room_amount::text,'null')||':'||evidence_quality,',' ORDER BY stay_date,gross_room_amount DESC NULLS LAST) =
       '100.0000:exact,50.0000:inferred,null:missing' AND bool_and(to_jsonb(evidence)::text NOT LIKE '%'||$2||'%') ok
       FROM booking.finance_nightly_revenue_evidence evidence WHERE guest_booking_id=$1`,
      [OTA_BOOKING, OTA_REFERENCE],
    );
    expect(evidence.rows[0]!.ok).toBe(true);
  });

  it("serializes manual revisions and appends adjustment history", async () => {
    const first = new pg.Client({ connectionString: DATABASE_URL });
    const second = new pg.Client({ connectionString: DATABASE_URL });
    peers.push(first, second);
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([first.query("BEGIN"), second.query("BEGIN")]);
    const secondPid = (await second.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const manual = (db: pg.Client, idempotencyKey: string, lines: ExternalRevenueEvidenceLine[]) =>
      append({ sourceKind: "manual", idempotencyKey, lines }, db);
    const event = (
      amount: string,
      economicEvent: ExternalRevenueEvidenceLine["economicEvent"],
      lifecycleState: ExternalRevenueEvidenceLine["lifecycleState"],
      correctsEvidenceId?: string,
    ) =>
      line("2026-10-01", amount, "exact", {
        recognizedOn: "2026-10-06",
        occupiedRoomNights: economicEvent === "occupancy_adjustment" ? -1 : 0,
        economicEvent,
        lifecycleState,
        correctsEvidenceId,
      });
    const base = await manual(first, "manual-base", [line("2026-10-01", "80", "exact")]);
    const pending = manual(second, "manual-cancel", [
      event("-80", "occupancy_adjustment", "canceled", base.evidenceIds[0]),
    ]);
    const blocked = () =>
      client
        .query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='transactionid'",
          [secondPid],
        )
        .then(({ rowCount }) => rowCount);
    await expect.poll(blocked).toBe(1);
    await first.query("COMMIT");
    expect((await pending).sourceRevision).toBe(2);
    await second.query("COMMIT");
    const retainedId = (
      await manual(client, "manual-retained", [event("20", "retained_charge", "canceled")])
    ).evidenceIds[0]!;
    await manual(client, "manual-adjust", [
      event("-20", "refund", "refunded", retainedId),
      event("5", "correction", "corrected", retainedId),
    ]);
    const events = await client.query<{ value: string }>(
      "SELECT string_agg(economic_event,',' ORDER BY source_revision,economic_event) value FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
      [OTA_BOOKING],
    );
    expect(events.rows[0]!.value).toBe(
      "room_night,occupancy_adjustment,retained_charge,correction,refund",
    );
  });
});
