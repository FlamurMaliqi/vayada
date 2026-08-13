import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPlatformPropertyLifecycleCommandRepository } from "./platformPropertyLifecycleCommandRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = "88888888-8888-4888-8888-888888888801";
const actorUserId = "88888888-8888-4888-8888-888888888802";
const organizationId = "88888888-8888-4888-8888-888888888803";
const membershipId = "88888888-8888-4888-8888-888888888804";
const resourceLinkId = "88888888-8888-4888-8888-888888888805";

describe.skipIf(!TEST_DATABASE_URL)("platform property lifecycle PostgreSQL commands", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgPlatformPropertyLifecycleCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await cleanup();
    await client.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'platform-lifecycle@example.test', 'Lifecycle Admin', 'active')`,
      [actorUserId],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'platform', 'Vayada Lifecycle Test', 'vayada-lifecycle-test', 'active')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (
         id, organization_id, user_id, status, role_key
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', 'platform_admin')`,
      [membershipId, organizationId, actorUserId],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         id, organization_id, product, resource_type, resource_id, relationship, status
       ) VALUES ($1::uuid, $2::uuid, 'platform', 'platform', 'vayada', 'operator', 'active')`,
      [resourceLinkId, organizationId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (
         id, public_id, display_name, profile_status, lifecycle_status, lifecycle_revision
       ) VALUES ($1::uuid, 'prop_lifecycle_integration', 'Lifecycle Integration Hotel',
         'complete', 'active', 1)`,
      [propertyId],
    );
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await client.end();
  });

  beforeEach(async () => {
    await client.query("DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid", [
      propertyId,
    ]);
    await client.query("DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [
      propertyId,
    ]);
    await client.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
      propertyId,
    ]);
    await client.query(
      `UPDATE hotel_catalog.properties
       SET lifecycle_status = 'active', lifecycle_revision = 1,
           profile_status = 'complete', pre_hold_profile_status = NULL,
           retired_at = NULL, retired_by_user_id = NULL
       WHERE id = $1::uuid`,
      [propertyId],
    );
  });

  it("waits for an in-flight Booking writer and then blocks retirement on its draft", async () => {
    const booking = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await booking.connect();
    try {
      await booking.query("BEGIN");
      await booking.query(
        `SELECT id FROM hotel_catalog.properties
         WHERE id = $1::uuid AND lifecycle_status = 'active' FOR SHARE`,
        [propertyId],
      );
      const retirement = repository.retire({
        propertyId,
        expectedLifecycleRevision: 1,
        reason: "Concurrent retirement review",
        idempotencyKey: "platform-lifecycle-booking-race",
        audit: {
          actorUserId,
          organizationId,
          requestId: "req-booking-race",
          correlationId: "corr-booking-race",
          requestedAt: "2026-08-13T11:59:59.000Z",
        },
      });
      await booking.query(
        `INSERT INTO booking.guest_bookings (
           property_id, public_reference, lifecycle_status, payment_status,
           check_in, check_out, currency
         ) VALUES ($1::uuid, 'LIFECYCLE-RACE-DRAFT', 'draft', 'unpaid',
           '2026-09-01', '2026-09-02', 'EUR')`,
        [propertyId],
      );
      await booking.query("COMMIT");

      await expect(retirement).rejects.toMatchObject({
        code: "retirement_blocked",
        impact: { blockers: [{ code: "active_bookings", count: 1 }] },
      });
    } finally {
      await booking.query("ROLLBACK").catch(() => undefined);
      await booking.end();
    }
  });

  it("serializes concurrent retirement retries and preserves an auditable result", async () => {
    const command = {
      propertyId,
      expectedLifecycleRevision: 1,
      reason: "Integration retirement review",
      idempotencyKey: "platform-lifecycle-retire-integration",
      audit: {
        actorUserId,
        organizationId,
        requestId: "req-lifecycle-integration",
        correlationId: "corr-lifecycle-integration",
        requestedAt: "2026-08-13T11:59:59.000Z",
      },
    };
    const [first, replay] = await Promise.all([
      repository.retire(command),
      repository.retire(command),
    ]);
    expect(first).toEqual({
      contractVersion: "platform-property-lifecycle.v1",
      propertyId,
      lifecycleStatus: "retired",
      lifecycleRevision: 2,
    });
    expect(replay).toEqual(first);

    await expect(
      client.query(
        `SELECT property.lifecycle_status AS status,
                property.lifecycle_revision AS revision,
                property.profile_status AS profile_status,
                property.retired_by_user_id::text AS retired_by,
                (SELECT count(*)::int FROM platform.idempotency_keys key
                 WHERE key.property_id = property.id
                   AND key.operation = 'platform.property.lifecycle.retire') AS idempotency_count,
                (SELECT count(*)::int FROM platform.product_audit_events audit
                 WHERE audit.property_id = property.id
                   AND audit.action = 'platform.property.lifecycle.retire') AS audit_count
         FROM hotel_catalog.properties property WHERE property.id = $1::uuid`,
        [propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "retired",
          revision: "2",
          profile_status: "disabled",
          retired_by: actorUserId,
          idempotency_count: 1,
          audit_count: 1,
        },
      ],
    });
  });

  async function cleanup() {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await client.query("DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await client.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await client.query("DELETE FROM identity.organization_resource_links WHERE id = $1::uuid", [
        resourceLinkId,
      ]);
      await client.query("DELETE FROM identity.organization_memberships WHERE id = $1::uuid", [
        membershipId,
      ]);
      await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
        organizationId,
      ]);
      await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
