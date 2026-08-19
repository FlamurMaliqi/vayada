import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// prettier-ignore
import { FinanceOtaCommissionEvidenceScopeError, appendExternalNightlyRevenueEconomics, captureFinanceOtaCommissionEvidence, type FinancePropertyTimezoneEvidence } from "./financeOtaCommissionEvidence.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "43000000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "43000000-0000-4000-8000-000000000002";
const ROOM = "43000000-0000-4000-8000-000000000003";
// prettier-ignore
const TIMEZONE: FinancePropertyTimezoneEvidence = { source: { ownerDomain: "hotel_catalog",
  entityType: "property_profile", entityId: PROPERTY, revision: "profile:1" }, timeZone: "Europe/Berlin" };
const BOOKINGS = {
  ota: "43000000-0000-4000-8000-000000000004",
  missingRule: "43000000-0000-4000-8000-000000000005",
  direct: "43000000-0000-4000-8000-000000000006",
  unknown: "43000000-0000-4000-8000-000000000007",
  clf: "43000000-0000-4000-8000-000000000008",
};
// prettier-ignore
const migration = (name: string) => readFile(
  join(import.meta.dirname, "../../../../packages/backend-migration/migrations", name), "utf8");

// prettier-ignore
describe.skipIf(!TEST_DATABASE_URL)("Finance OTA commission evidence (PostgreSQL)", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  beforeAll(async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(TEST_DATABASE_URL!).pathname)) throw new Error("Refusing non-test database");
    await client.connect();
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DROP SCHEMA IF EXISTS booking CASCADE; DROP SCHEMA IF EXISTS finance CASCADE;
      CREATE SCHEMA booking; CREATE SCHEMA finance;
      CREATE TABLE booking.guest_bookings (
        id UUID PRIMARY KEY, property_id UUID NOT NULL, currency CHAR(3) NOT NULL,
        source_system TEXT NOT NULL, source_booking_id TEXT, lifecycle_status TEXT NOT NULL DEFAULT 'confirmed',
        check_in DATE NOT NULL DEFAULT '2026-09-01', check_out DATE NOT NULL DEFAULT '2027-01-02',
        total_amount NUMERIC NOT NULL DEFAULT 100, room_count INTEGER NOT NULL DEFAULT 1, UNIQUE (id, property_id));
      CREATE TABLE finance.commission_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), property_id UUID, organization_id UUID,
        rule_scope TEXT NOT NULL, product TEXT NOT NULL, commission_type TEXT NOT NULL,
        percentage_rate NUMERIC(7,4), fixed_amount NUMERIC, currency CHAR(3), status TEXT DEFAULT 'active',
        starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ, source_system TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now());`);
    for (const name of ["0073_booking_nightly_revenue_evidence.sql", "0079_booking_finance_attribution.sql", "0095_finance_ota_commission_rules.sql"])
      await client.query(await migration(name));
    const snapshotMigration = await migration("0096_finance_ota_commission_evidence.sql");
    await client.query("BEGIN"); await client.query(snapshotMigration); await client.query("ROLLBACK");
    expect((await client.query("SELECT to_regclass('finance.ota_commission_evidence') AS name")).rows[0])
      .toEqual({ name: null });
    await client.query(snapshotMigration);
    await client.query(
      `WITH room_scope AS (INSERT INTO booking.nightly_revenue_room_scopes VALUES ($6,$7))
       INSERT INTO booking.guest_bookings
         (id, property_id, currency, source_system, source_booking_id, booking_channel, direct_booking_source)
       VALUES ($1::uuid,$6,'EUR','pms',$1::text,'booking_com',NULL),
         ($2::uuid,$6,'EUR','pms',$2::text,'airbnb',NULL),
         ($3::uuid,$6,'EUR','pms',$3::text,'direct','booking_engine'),
         ($4::uuid,$6,'EUR','pms',$4::text,'unknown',NULL),
         ($5::uuid,$6,'CLF','pms',$5::text,'booking_com',NULL)`,
      [...Object.values(BOOKINGS), PROPERTY, ROOM]);
    await client.query(
      `INSERT INTO finance.commission_rules
         (property_id, rule_scope, product, commission_type, percentage_rate, starts_at,
          ends_at, source_system, ota_channel, revision)
       VALUES ($1,'property','pms','percentage',15.25,'2026-01-01','2026-08-31T23:00Z','finance','booking_com',1),
         ($1,'property','pms','percentage',99,'2026-08-31T23:00Z',NULL,'finance','booking_com',2)`,
      [PROPERTY]);
  });
  // prettier-ignore
  afterAll(async () => { await client.query("DROP SCHEMA IF EXISTS booking CASCADE; DROP SCHEMA IF EXISTS finance CASCADE"); await client.end(); });

  const evidence = async (input: { booking: string; stay: string; amount: string | null;
    source?: "ota" | "manual"; event?: "room_night" | "room_night_reversal" | "correction";
    corrects?: string | null; timezone?: FinancePropertyTimezoneEvidence }) => {
    const reversal = input.event === "room_night_reversal";
    const correction = input.event === "correction";
    await client.query("BEGIN");
    try {
      const result = await appendExternalNightlyRevenueEconomics(client, {
        propertyId: PROPERTY, guestBookingId: input.booking, sourceKind: input.source ?? "ota",
        sourceBookingReference: input.booking, idempotencyKey: crypto.randomUUID(), lines: [{
          roomTypeId: ROOM, stayDate: input.stay, recognizedOn: input.stay,
          grossRoomAmount: input.amount, occupiedRoomNights: reversal ? -1 : correction ? 0 : 1,
          economicEvent: input.event ?? "room_night",
          lifecycleState: reversal ? "canceled" : correction ? "corrected" : "completed",
          evidenceQuality: input.amount === null ? "missing" : "exact", linePosition: 1,
          correctsEvidenceId: input.corrects ?? null }],
      }, input.timezone ?? TIMEZONE);
      await client.query("COMMIT"); return result.evidenceIds[0]!;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  };
  // prettier-ignore
  const capture = (bookingRevenueEvidenceId: string, propertyId = PROPERTY, propertyTimezone = TIMEZONE) => captureFinanceOtaCommissionEvidence(client, { propertyId, bookingRevenueEvidenceId, propertyTimezone });

  it("snapshots rules, explicit gaps, corrections, replay, scope, and a safe projection", async () => {
    const exact = await evidence({ booking: BOOKINGS.ota, stay: "2026-09-01", amount: "100.03" });
    const missingGross = await evidence({ booking: BOOKINGS.ota, stay: "2026-09-02", amount: null });
    const missingRule = await evidence({ booking: BOOKINGS.missingRule, stay: "2026-09-01", amount: "80" });
    const direct = await evidence({ booking: BOOKINGS.direct, stay: "2026-09-01", amount: "70", source: "manual" });
    const unknown = await evidence({ booking: BOOKINGS.unknown, stay: "2026-09-01", amount: "60" });
    await expect(evidence({ booking: BOOKINGS.ota, stay: "2026-12-31", amount: "1",
      timezone: { ...TIMEZONE, source: { ...TIMEZONE.source, entityId: OTHER_PROPERTY } } }))
      .rejects.toBeInstanceOf(FinanceOtaCommissionEvidenceScopeError);
    expect((await client.query("SELECT count(*)::int AS count FROM booking.nightly_revenue_evidence WHERE stay_date='2026-12-31'")).rows[0])
      .toEqual({ count: 0 });
    await expect(evidence({ booking: BOOKINGS.clf, stay: "2026-09-01", amount: "1",
      timezone: { ...TIMEZONE, timeZone: "US/Eastern" } }))
      .rejects.toBeInstanceOf(FinanceOtaCommissionEvidenceScopeError);
    // prettier-ignore
    expect((await client.query(`SELECT (SELECT count(*)::int FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1) AS "bookingCount", (SELECT count(*)::int FROM finance.ota_commission_evidence WHERE guest_booking_id=$1) AS "financeCount"`, [BOOKINGS.clf])).rows[0]).toEqual({ bookingCount: 0, financeCount: 0 });
    const applied = await capture(exact);
    expect(applied).toMatchObject({ outcome: "replayed", evidence: {
      evidenceState: "applied", percentageRate: "15.2500", commissionAmount: "15.2500" } });
    expect((await capture(exact, PROPERTY, { ...TIMEZONE, timeZone: "US/Eastern" })).outcome)
      .toBe("replayed");
    await expect(capture(exact, OTHER_PROPERTY))
      .rejects.toBeInstanceOf(FinanceOtaCommissionEvidenceScopeError);
    expect((await capture(missingGross)).evidence)
      .toMatchObject({ evidenceState: "missing_gross", percentageRate: "99.0000", commissionAmount: null });
    expect((await capture(missingRule)).evidence)
      .toMatchObject({ evidenceState: "missing_rule", commissionRuleId: null });
    for (const id of [direct, unknown])
      expect(await capture(id))
        .toEqual({ outcome: "ineligible", reason: "not_ota" });
    await client.query("UPDATE finance.commission_rules SET percentage_rate = 99");
    expect((await capture(exact)).evidence)
      .toMatchObject({ percentageRate: "15.2500", commissionAmount: "15.2500" });
    const reversal = await evidence({ booking: BOOKINGS.ota, stay: "2026-09-01", amount: "-100.03",
      event: "room_night_reversal", corrects: exact });
    const reversed = await capture(reversal);
    const appliedId = "evidence" in applied ? applied.evidence!.snapshotId : "";
    expect(reversed.evidence).toMatchObject({ percentageRate: "15.2500", commissionAmount: "-15.2500",
      correctsCommissionEvidenceId: appliedId });
    const correction = await evidence({ booking: BOOKINGS.ota, stay: "2026-09-01", amount: "10",
      event: "correction", corrects: exact });
    expect((await capture(correction)).evidence)
      .toMatchObject({ percentageRate: "15.2500", commissionAmount: "1.5300",
        correctsCommissionEvidenceId: appliedId });
    const clf = await evidence({ booking: BOOKINGS.clf, stay: "2026-09-01", amount: "100.03" });
    expect((await capture(clf)).evidence)
      .toMatchObject({ currency: "CLF", commissionAmount: "99.0297" });
    await client.query("ALTER TABLE finance.commission_rules DROP CONSTRAINT ex_finance_ota_commission_rules_window");
    await client.query(`INSERT INTO finance.commission_rules
      (property_id, rule_scope, product, commission_type, percentage_rate, starts_at, source_system, ota_channel)
      VALUES ($1,'property','pms','percentage',20,'2026-01-01','finance','booking_com')`, [PROPERTY]);
    const ambiguous = await evidence({ booking: BOOKINGS.ota, stay: "2026-10-01", amount: "50" });
    expect((await capture(ambiguous)).evidence)
      .toMatchObject({ evidenceState: "ambiguous_rule", commissionAmount: null });
    const projection = await client.query("SELECT * FROM finance.ota_commission_reporting_evidence");
    expect(projection.fields.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["source_booking_id", "booking_metadata"]));
    await expect(client.query("UPDATE finance.ota_commission_evidence SET commission_amount = 0"))
      .rejects.toMatchObject({ code: "55000" });
    expect(projection.rows).toHaveLength(7);
  });
});
