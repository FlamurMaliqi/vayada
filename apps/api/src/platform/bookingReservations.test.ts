import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createTargetBookingReservationsReadRepository } from "./bookingReservations.js";

type TargetRepositoryConfig = Parameters<typeof createTargetBookingReservationsReadRepository>[0];
type BookingReservationsReadPool = NonNullable<TargetRepositoryConfig["pool"]>;

type CapturedQuery = {
  text: string;
  values?: readonly unknown[];
};

const defaultFilters = {
  limit: 50,
  offset: 0,
};

function createHarness(total = "0") {
  const queries: CapturedQuery[] = [];
  let closed = false;
  const pool: BookingReservationsReadPool = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<Pick<QueryResult<T>, "rows">> {
      queries.push({ text, values });
      return {
        rows: (text.includes("SELECT COUNT(*)::text AS total")
          ? [{ total }]
          : []) as unknown as T[],
      };
    },
    async end() {
      closed = true;
    },
  };

  return {
    queries,
    repository: createTargetBookingReservationsReadRepository({
      connectionString: "postgresql://target-db",
      pool,
    }),
    wasClosed: () => closed,
  };
}

function expectCanonicalFirstScope(text: string) {
  expect(text).toContain("SELECT property.id AS property_id, 0 AS precedence");
  expect(text).toContain("FROM hotel_catalog.properties property");
  expect(text).toContain("WHERE property.id::text = $1");
  expect(text).toContain("SELECT source.property_id, 1 AS precedence");
  expect(text).toContain("source.source_table = 'booking_hotels'");
  expect(text).toContain("source.source_id = $1");
  expect(text).toContain("ORDER BY precedence");
  expect(text).not.toContain("$1::uuid");
}

describe("target Booking reservations property scope", () => {
  it("prefers an exact canonical property UUID in both list and count reads", async () => {
    const propertyId = "7a9333c2-f275-4571-8078-6a334e0fc28d";
    const harness = createHarness("0");

    await expect(
      harness.repository.listReservationsByHotelId(propertyId, defaultFilters),
    ).resolves.toEqual({ reservations: [], total: 0 });

    expect(harness.queries).toHaveLength(2);
    for (const query of harness.queries) {
      expectCanonicalFirstScope(query.text);
      expect(query.values?.[0]).toBe(propertyId);
    }
  });

  it("falls back to an active legacy booking hotel source link", async () => {
    const legacyHotelId = "booking_hotel_alpenrose";
    const harness = createHarness("0");

    await harness.repository.listReservationsByHotelId(legacyHotelId, defaultFilters);

    expect(harness.queries).toHaveLength(2);
    for (const query of harness.queries) {
      expectCanonicalFirstScope(query.text);
      expect(query.text).toContain("source.source_system = 'booking'");
      expect(query.text).toContain("source.relationship = 'canonical_input'");
      expect(query.text).toContain("source.status = 'active'");
      expect(query.values?.[0]).toBe(legacyHotelId);
    }
  });

  it("returns an empty result without querying for an empty property identifier", async () => {
    const harness = createHarness("9");

    await expect(
      harness.repository.listReservationsByHotelId("   ", defaultFilters),
    ).resolves.toEqual({ reservations: [], total: 0 });
    expect(harness.queries).toEqual([]);
  });

  it("keeps non-UUID legacy identifiers safe from UUID casts", async () => {
    const harness = createHarness("0");

    await expect(
      harness.repository.listReservationsByHotelId("not-a-uuid", defaultFilters),
    ).resolves.toEqual({ reservations: [], total: 0 });

    expect(harness.queries).toHaveLength(2);
    for (const query of harness.queries) {
      expect(query.text).toContain("property.id::text = $1");
      expect(query.text).not.toContain("$1::uuid");
      expect(query.values?.[0]).toBe("not-a-uuid");
    }
  });

  it("uses the same property and filter scope for page and count queries", async () => {
    const propertyId = "7a9333c2-f275-4571-8078-6a334e0fc28d";
    const harness = createHarness("12");

    const result = await harness.repository.listReservationsByHotelId(propertyId, {
      status: "confirmed",
      search: "Ada",
      limit: 25,
      offset: 5,
    });

    expect(result).toEqual({ reservations: [], total: 12 });
    const [listQuery, countQuery] = harness.queries;
    expect(listQuery).toBeDefined();
    expect(countQuery).toBeDefined();
    if (!listQuery || !countQuery) return;

    const listCte = listQuery.text.slice(0, listQuery.text.indexOf("\n           SELECT"));
    const countCte = countQuery.text.slice(0, countQuery.text.indexOf("\n           SELECT"));
    expect(listCte).toBe(countCte);
    expect(listQuery.values?.slice(0, -2)).toEqual(countQuery.values);
    expect(countQuery.values).toEqual([propertyId, "confirmed", "%Ada%"]);
    expect(listQuery.values).toEqual([propertyId, "confirmed", "%Ada%", 25, 5]);
    expect(listQuery.text).toContain("entitlement_key = 'direct-booking-finance'");
    expect(listQuery.text).toContain("COUNT(*) = 1");
    expect(listQuery.text).toContain("contact_event.actor_type = 'property_user'");

    await harness.repository.close?.();
    expect(harness.wasClosed()).toBe(true);
  });

  it("reads stay dates as date-only text so local time zones cannot shift them", async () => {
    const harness = createHarness("0");

    await harness.repository.listReservationsByHotelId(
      "7a9333c2-f275-4571-8078-6a334e0fc28d",
      defaultFilters,
    );

    const listQuery = harness.queries.find(
      (query) => !query.text.includes("SELECT COUNT(*)::text AS total"),
    );
    expect(listQuery?.text).toContain('booking.check_in::text AS "checkIn"');
    expect(listQuery?.text).toContain('booking.check_out::text AS "checkOut"');
    expect(listQuery?.text).toContain('AS "guestContactAccepted"');
    expect(listQuery?.text).toContain("contact_event.actor_type = 'property_user'");
  });
});
