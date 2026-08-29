import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { HIDDEN_GUEST_CONTACT } from "../domains/bookingGuestContactAccess.js";
import { createTargetBookingReservationsReadRepository } from "./bookingReservations.js";

type TargetRepositoryConfig = Parameters<typeof createTargetBookingReservationsReadRepository>[0];
type BookingReservationsReadPool = NonNullable<TargetRepositoryConfig["pool"]>;

type CapturedQuery = {
  text: string;
  values?: readonly unknown[];
};

const defaultFilters = {
  canReadGuestContact: true,
  limit: 50,
  offset: 0,
};

function createHarness(total = "0", resolvedPropertyId?: string) {
  const queries: CapturedQuery[] = [];
  let closed = false;
  const pool: BookingReservationsReadPool = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<Pick<QueryResult<T>, "rows">> {
      queries.push({ text, values });
      return {
        rows: (text.includes('SELECT property_id::text AS "propertyId" FROM scoped_property')
          ? resolvedPropertyId
            ? [{ propertyId: resolvedPropertyId }]
            : []
          : text.includes("SELECT COUNT(*)::text AS total")
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

function expectUnambiguousAliasScope(text: string) {
  expect(text).toContain("SELECT property.id AS property_id");
  expect(text).toContain("FROM hotel_catalog.properties property");
  expect(text).toContain("WHERE property.id::text = $1");
  expect(text).toContain("UNION\n    SELECT source.property_id");
  expect(text).toContain("source.source_table = 'booking_hotels'");
  expect(text).toContain("source.source_id = $1");
  expect(text).toContain("HAVING COUNT(*) = 1");
  expect(text).not.toContain("LIMIT 1");
  expect(text).not.toContain("$1::uuid");
}

function expectExactCanonicalScope(text: string) {
  expect(text).toContain("booking.property_id = $1::uuid");
  expect(text).not.toContain("scoped_property");
  expect(text).not.toContain("property_source_links");
}

describe("target Booking reservations property scope", () => {
  it("prefers an exact canonical property UUID in both list and count reads", async () => {
    const propertyId = "7a9333c2-f275-4571-8078-6a334e0fc28d";
    const harness = createHarness("0");

    await expect(
      harness.repository.listReservationsByPropertyId(propertyId, defaultFilters),
    ).resolves.toEqual({ reservations: [], total: 0 });

    expect(harness.queries).toHaveLength(2);
    for (const query of harness.queries) {
      expectExactCanonicalScope(query.text);
      expect(query.values?.[0]).toBe(propertyId);
    }
  });

  it("resolves a legacy alias once before reading the authorized canonical property", async () => {
    const legacyHotelId = "booking_hotel_alpenrose";
    const propertyId = "7a9333c2-f275-4571-8078-6a334e0fc28d";
    const harness = createHarness("0", propertyId);

    await expect(harness.repository.resolveCanonicalPropertyId(legacyHotelId)).resolves.toBe(
      propertyId,
    );
    await harness.repository.listReservationsByPropertyId(propertyId, defaultFilters);

    expect(harness.queries).toHaveLength(3);
    expectUnambiguousAliasScope(harness.queries[0]!.text);
    expect(harness.queries[0]!.text).toContain("source.source_system = 'booking'");
    expect(harness.queries[0]!.text).toContain("source.relationship = 'canonical_input'");
    expect(harness.queries[0]!.text).toContain("source.status = 'active'");
    expect(harness.queries[0]!.values?.[0]).toBe(legacyHotelId);
    for (const query of harness.queries.slice(1)) {
      expect(query.values?.[0]).toBe(propertyId);
      expectExactCanonicalScope(query.text);
    }
  });

  it("returns an empty result without querying for an empty property identifier", async () => {
    const harness = createHarness("9");

    await expect(
      harness.repository.listReservationsByPropertyId("   ", defaultFilters),
    ).resolves.toEqual({ reservations: [], total: 0 });
    expect(harness.queries).toEqual([]);
  });

  it("keeps non-UUID legacy identifiers safe from UUID casts", async () => {
    const harness = createHarness("0");

    await expect(harness.repository.resolveCanonicalPropertyId("not-a-uuid")).resolves.toBeNull();

    expect(harness.queries).toHaveLength(1);
    for (const query of harness.queries) {
      expect(query.text).toContain("property.id::text = $1");
      expect(query.text).not.toContain("$1::uuid");
      expect(query.values?.[0]).toBe("not-a-uuid");
    }
  });

  it("uses the same property and filter scope for page and count queries", async () => {
    const propertyId = "7a9333c2-f275-4571-8078-6a334e0fc28d";
    const harness = createHarness("12");

    const result = await harness.repository.listReservationsByPropertyId(propertyId, {
      status: "confirmed",
      search: "Ada",
      canReadGuestContact: true,
      limit: 25,
      offset: 5,
    });

    expect(result).toEqual({ reservations: [], total: 12 });
    const [listQuery, countQuery] = harness.queries;
    expect(listQuery).toBeDefined();
    expect(countQuery).toBeDefined();
    if (!listQuery || !countQuery) return;

    for (const query of [listQuery, countQuery]) expectExactCanonicalScope(query.text);
    expect(listQuery.values?.slice(0, -2)).toEqual(countQuery.values);
    expect(countQuery.values).toEqual([propertyId, "confirmed", "%Ada%"]);
    expect(listQuery.values).toEqual([propertyId, "confirmed", "%Ada%", 25, 5]);
    expect(listQuery.text).toContain("entitlement_key = 'direct-booking-finance'");
    expect(listQuery.text).toContain("COUNT(*) = 1");
    expect(listQuery.text).toContain("'guest_booking.accepted'");
    expect(listQuery.text).not.toContain("contact_event.actor_type = 'property_user'");

    await harness.repository.close?.();
    expect(harness.wasClosed()).toBe(true);
  });

  it("gates guest-contact reads and search before applying plan rules", async () => {
    const propertyId = "7a9333c2-f275-4571-8078-6a334e0fc28d";
    const queries: CapturedQuery[] = [];
    let plan: "fixed" | "commission" = "fixed";
    const pool: BookingReservationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<Pick<QueryResult<T>, "rows">> {
        queries.push({ text, values });
        if (text.includes("SELECT plan_key AS plan")) {
          return { rows: [{ plan }] as unknown as T[] };
        }
        if (text.includes("SELECT COUNT(*)::text AS total")) {
          return { rows: [{ total: "1" }] as unknown as T[] };
        }
        return {
          rows: [
            {
              id: "reservation-1",
              propertyId,
              guestEmail: "guest@example.com",
              guestPhone: "+4912345",
              guestContactAccepted: false,
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetBookingReservationsReadRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const deniedByPermission = await repository.listReservationsByPropertyId(propertyId, {
      search: "guest@example.com",
      canReadGuestContact: false,
      limit: 50,
      offset: 0,
    });

    expect(deniedByPermission.reservations[0]).toMatchObject({
      guestEmail: HIDDEN_GUEST_CONTACT,
      guestPhone: HIDDEN_GUEST_CONTACT,
    });
    for (const query of queries.slice(0, 2)) {
      expect(query.text).not.toContain("SELECT guest.*");
      expect(query.text).not.toContain("guest.email");
      expect(query.text).not.toContain("guest.phone");
      expect(query.text).not.toContain("booker.email");
      expect(query.text).not.toContain("booker.phone");
    }

    queries.length = 0;
    plan = "commission";
    const deniedByPlan = await repository.listReservationsByPropertyId(propertyId, {
      search: "guest@example.com",
      canReadGuestContact: true,
      limit: 50,
      offset: 0,
    });

    expect(deniedByPlan.reservations[0]).toMatchObject({
      guestEmail: HIDDEN_GUEST_CONTACT,
      guestPhone: HIDDEN_GUEST_CONTACT,
    });
    expect(queries[0]?.text).toContain("COALESCE(booker.email, '')");
    expect(queries[0]?.text).toContain("guest.email, guest.phone");
    expect(queries[0]?.text).toContain("guest.email ILIKE");
  });

  it("reads stay dates as date-only text so local time zones cannot shift them", async () => {
    const harness = createHarness("0");

    await harness.repository.listReservationsByPropertyId(
      "7a9333c2-f275-4571-8078-6a334e0fc28d",
      defaultFilters,
    );

    const listQuery = harness.queries.find(
      (query) => !query.text.includes("SELECT COUNT(*)::text AS total"),
    );
    expect(listQuery?.text).toContain('booking.check_in::text AS "checkIn"');
    expect(listQuery?.text).toContain('booking.check_out::text AS "checkOut"');
    expect(listQuery?.text).toContain('AS "guestContactAccepted"');
    expect(listQuery?.text).toContain("'guest_booking.accepted'");
    expect(listQuery?.text).not.toContain("contact_event.actor_type = 'property_user'");
  });
});
