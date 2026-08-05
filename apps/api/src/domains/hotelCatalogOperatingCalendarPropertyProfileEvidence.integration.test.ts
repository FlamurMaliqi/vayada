import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort,
  type HotelCatalogOperatingCalendarPropertyProfileEvidenceClient,
  type HotelCatalogOperatingCalendarPropertyProfileEvidencePool,
} from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "a4000000-0000-4000-8000-000000000011";

describe.skipIf(!TEST_DATABASE_URL)(
  "PostgreSQL Hotel Catalog operating-calendar property-profile evidence",
  () => {
    const admin = new pg.Client({
      connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    });
    const writer = new pg.Client({
      connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    });
    const trackingPool = createTrackingPool(
      TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    );
    const port = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
      pool: trackingPool,
    });

    beforeAll(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      await admin.connect();
      await writer.connect();
    });

    beforeEach(async () => {
      await cleanup();
      await seedProperty();
      trackingPool.releases.mockClear();
    });

    afterAll(async () => {
      await cleanup();
      await port.close();
      await trackingPool.endUnderlying();
      await writer.end();
      await admin.end();
    });

    it("holds one stable owner pair while the canonical profile writer waits", async () => {
      const writerPid = await backendPid(writer);
      let pendingWrite: Promise<QueryResult<{ propertyId: string }>> | undefined;

      const first = await port.runWithPropertyProfileEvidence(
        { propertyId, expectedProfileRevision: 7 },
        async (evidence) => {
          expect(evidence).toEqual({
            status: "available",
            evidence: {
              source: {
                ownerDomain: "hotel_catalog",
                entityType: "property_profile",
                entityId: propertyId,
                revision: "profile:7",
              },
              timeZone: "Europe/Berlin",
            },
          });
          pendingWrite = writeCanonicalProfile(8, "Asia/Kolkata");
          await waitForLockWaiter(admin, writerPid);
          await expect(currentProfilePair(admin)).resolves.toEqual({
            profileRevision: "7",
            timeZone: "Europe/Berlin",
          });
          return evidence;
        },
      );

      expect(first.status).toBe("available");
      await expect(pendingWrite).resolves.toMatchObject({
        rows: [{ propertyId }],
        rowCount: 1,
      });
      expect(trackingPool.releases).toHaveBeenCalledTimes(1);

      await expect(
        port.runWithPropertyProfileEvidence(
          { propertyId, expectedProfileRevision: 7 },
          async (evidence) => evidence,
        ),
      ).resolves.toEqual({
        status: "available",
        evidence: {
          source: {
            ownerDomain: "hotel_catalog",
            entityType: "property_profile",
            entityId: propertyId,
            revision: "profile:8",
          },
          timeZone: "Asia/Kolkata",
        },
      });
    });

    it("rolls back and releases after callback rejection without replacing the error", async () => {
      const failure = new Error("PMS transaction rejected owner evidence");

      await expect(
        port.runWithPropertyProfileEvidence({ propertyId, expectedProfileRevision: 7 }, async () =>
          Promise.reject(failure),
        ),
      ).rejects.toBe(failure);
      expect(trackingPool.releases).toHaveBeenCalledOnce();

      await writer.query("SET lock_timeout = '500ms'");
      await expect(writeCanonicalProfile(8, "America/Nuuk")).resolves.toMatchObject({
        rows: [{ propertyId }],
        rowCount: 1,
      });
      await expect(currentProfilePair(admin)).resolves.toEqual({
        profileRevision: "8",
        timeZone: "America/Nuuk",
      });
    });

    async function seedProperty(): Promise<void> {
      await admin.query(
        `INSERT INTO hotel_catalog.properties (
           id, public_id, display_name, profile_revision
         ) VALUES ($1::uuid, 'vay1071-owner-evidence', 'Owner Evidence Hotel', 7)`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
         VALUES ($1::uuid, 'Europe/Berlin')`,
        [propertyId],
      );
    }

    async function cleanup(): Promise<void> {
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
    }

    function writeCanonicalProfile(
      nextRevision: number,
      timeZone: string,
    ): Promise<QueryResult<{ propertyId: string }>> {
      return writer.query<{ propertyId: string }>(
        `WITH updated_property AS (
           UPDATE hotel_catalog.properties property
           SET profile_revision = $2, updated_at = now()
           WHERE property.id = $1::uuid
             AND property.profile_revision = $2 - 1
           RETURNING property.id AS property_id
         ),
         written_property AS (
           SELECT * FROM updated_property
         ),
         upserted_location AS (
           INSERT INTO hotel_catalog.property_locations (property_id, timezone, updated_at)
           SELECT property_id, $3, now() FROM written_property
           ON CONFLICT (property_id) DO UPDATE
           SET timezone = EXCLUDED.timezone, updated_at = EXCLUDED.updated_at
           RETURNING property_id
         )
         SELECT property_id::text AS "propertyId" FROM upserted_location`,
        [propertyId, nextRevision, timeZone],
      );
    }
  },
);

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]!.pid;
}

async function currentProfilePair(client: pg.Client) {
  const result = await client.query<{ profileRevision: string; timeZone: string }>(
    `SELECT property.profile_revision::text AS "profileRevision",
            location.timezone AS "timeZone"
     FROM hotel_catalog.properties property
     JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     WHERE property.id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0];
}

async function waitForLockWaiter(observer: pg.Client, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting
       FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the canonical profile writer to block");
}

function createTrackingPool(connectionString: string) {
  const underlying = new pg.Pool({ connectionString, max: 2 });
  const releases = vi.fn<() => void>();
  return {
    releases,
    async connect() {
      const client = await underlying.connect();
      return trackingClient(client, releases);
    },
    async end() {
      // The injected pool remains caller-owned.
    },
    async endUnderlying() {
      await underlying.end();
    },
  } satisfies HotelCatalogOperatingCalendarPropertyProfileEvidencePool & {
    releases: Mock<() => void>;
    endUnderlying(): Promise<void>;
  };
}

function trackingClient(
  client: PoolClient,
  releases: Mock<() => void>,
): HotelCatalogOperatingCalendarPropertyProfileEvidenceClient {
  return {
    query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]) {
      return client.query<T>(text, values as unknown[]);
    },
    release() {
      releases();
      client.release();
    },
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
