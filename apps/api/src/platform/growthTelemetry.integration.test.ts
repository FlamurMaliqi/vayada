import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGrowthTelemetry } from "./growthTelemetry.js";

// Requires an empty test database; all fixture DDL/data is rolled back.
const url = process.env["GROWTH_TEST_DATABASE_URL"];
describe.skipIf(!url)("Platform growth PostgreSQL aggregates", () => {
  const pool = new pg.Client({ connectionString: url });
  beforeAll(async () => {
    await pool.connect();
    await pool.query("BEGIN");
    await pool.query(`CREATE SCHEMA hotel_catalog; CREATE SCHEMA platform; CREATE SCHEMA booking;
      CREATE TABLE hotel_catalog.properties (id text PRIMARY KEY);
      CREATE TABLE hotel_catalog.property_slugs (property_id text, slug text);
      CREATE TABLE platform.domain_events (id serial, property_id text, resource_id text, tenant_scope text,
        source_system text DEFAULT 'distribution', event_type text DEFAULT 'booking_web.page_visit',
        resource_product text DEFAULT 'distribution', resource_type text DEFAULT 'booking_web_hotel',
        event_status text DEFAULT 'recorded', event_metadata jsonb DEFAULT '{}', payload jsonb DEFAULT '{}',
        occurred_at timestamptz DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE booking.guest_bookings (id serial, property_id text, created_at timestamptz DEFAULT CURRENT_TIMESTAMP, booking_metadata jsonb DEFAULT '{}');
      INSERT INTO hotel_catalog.properties VALUES ('a'), ('b'), ('empty');
      INSERT INTO hotel_catalog.property_slugs VALUES ('a','old-a'),('a','shared'),('b','shared');
      INSERT INTO platform.domain_events (property_id, tenant_scope) VALUES ('a','property'),('b','property'),('b','property');
      INSERT INTO platform.domain_events (resource_id, tenant_scope) VALUES ('old-a','external'),('shared','external');
      INSERT INTO platform.domain_events (property_id, tenant_scope, event_metadata) VALUES ('a','property','{"trafficClass":"bot"}'),('a','property','{"trafficClass":"test"}');
      INSERT INTO platform.domain_events (property_id, tenant_scope, occurred_at) VALUES ('a','property',CURRENT_TIMESTAMP + INTERVAL '1 day');
      INSERT INTO booking.guest_bookings (property_id) VALUES ('a'),('b'),('b');
      INSERT INTO booking.guest_bookings (property_id, booking_metadata) VALUES ('a','{"operationalEvidence":{"isTestBooking":true}}');`);
  });
  afterAll(async () => {
    await pool.query("ROLLBACK");
    await pool.end();
  });
  it.each(["daily", "weekly", "monthly"] as const)(
    "zero-fills and isolates %s buckets",
    async (granularity) => {
      const read = (propertyIds: string[], excludeTestData = true) =>
        readGrowthTelemetry(pool, { propertyIds, granularity, excludeTestData });
      const totals = (data: Awaited<ReturnType<typeof read>>) => [
        data.pageViews.reduce((n, p) => n + p.value, 0),
        data.bookingRequests.reduce((n, p) => n + p.value, 0),
      ];
      expect(totals(await read(["a"]))).toEqual([2, 1]);
      expect(totals(await read(["b"]))).toEqual([2, 2]);
      expect(totals(await read(["a", "b"]))).toEqual([4, 3]);
      expect(totals(await read(["a"], false))).toEqual([3, 2]);
      for (const ids of [[], ["empty"], ["missing"]]) {
        const data = await read(ids);
        expect(data.pageViews).toHaveLength(granularity === "daily" ? 30 : 12);
        expect(data.bookingRequests).toHaveLength(data.pageViews.length);
        expect(totals(data)).toEqual([0, 0]);
      }
    },
  );
  it("keeps UTC day boundaries in a non-UTC database session", async () => {
    await pool.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
    await pool.query(`INSERT INTO platform.domain_events (property_id, tenant_scope, occurred_at)
      VALUES ('b', 'property', (date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 second') AT TIME ZONE 'UTC')`);
    const data = await readGrowthTelemetry(pool, {
      propertyIds: ["b"],
      granularity: "daily",
      excludeTestData: true,
    });
    expect(data.pageViews.at(-2)?.value).toBe(1);
    expect(data.pageViews.at(-1)?.value).toBe(2);
  });
});
