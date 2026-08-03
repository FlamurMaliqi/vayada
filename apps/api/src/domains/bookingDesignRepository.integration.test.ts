import type { UpsertBookingDesignCommand } from "@vayada/domain-booking";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgBookingDesignRepository,
  type BookingDesignRepositoryPool,
} from "./bookingDesignRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "a1000000-0000-4000-8000-000000000001";
const organizationId = "a1000000-0000-4000-8000-000000000002";
const propertyId = "a1000000-0000-4000-8000-000000000003";
const secondOrganizationId = "a1000000-0000-4000-8000-000000000004";
const acceptedAt = "2026-08-03T20:00:00.000Z";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Booking design repository", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createPgBookingDesignRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 6,
    now: () => new Date(acceptedAt),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedScope();
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("atomically creates, updates, and reads only the private current revision", async () => {
    await expect(
      repository.upsertDesign(command("create", 0, "#4F46E5", "high-end-serif")),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "created",
      design: {
        contractVersion: "booking-design.v1",
        propertyId,
        revision: 1,
        choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
        createdAt: acceptedAt,
      },
    });
    await expect(
      repository.upsertDesign(command("update", 1, "#0077B6", "modern-minimalist")),
    ).resolves.toMatchObject({
      ok: true,
      outcome: "updated",
      design: {
        revision: 2,
        choices: { primaryColor: "#0077B6", fontPairing: "modern-minimalist" },
      },
    });
    await expect(repository.getCurrentDesign({ organizationId, propertyId })).resolves.toEqual({
      contractVersion: "booking-design.v1",
      propertyId,
      revision: 2,
      choices: { primaryColor: "#0077B6", fontPairing: "modern-minimalist" },
      createdAt: acceptedAt,
    });

    const durable = await admin.query<{
      revisionNumber: number;
      domainEventKey: string;
      domainEventType: string;
      eventPayload: unknown;
      destination: string;
      outboxKey: string;
      outboxEventType: string;
      outboxPayload: unknown;
      action: string;
      idempotencyOrganizationId: string | null;
      idempotencyPropertyId: string;
      activePublicRevision: string;
    }>(
      `SELECT revision.revision_number AS "revisionNumber",
              event.event_key AS "domainEventKey", event.event_type AS "domainEventType",
              event.payload AS "eventPayload", outbox.destination,
              outbox.outbox_key AS "outboxKey", outbox.event_type AS "outboxEventType",
              outbox.payload AS "outboxPayload", audit.action,
              idempotency.organization_id::text AS "idempotencyOrganizationId",
              idempotency.property_id::text AS "idempotencyPropertyId",
              (SELECT count(*)::text FROM distribution.active_public_booking_revision
               WHERE property_id = $1::uuid) AS "activePublicRevision"
       FROM booking.booking_design_revisions revision
       JOIN platform.domain_events event ON event.id = revision.domain_event_id
       JOIN platform.outbox_events outbox ON outbox.id = revision.outbox_event_id
       JOIN platform.product_audit_events audit ON audit.domain_event_id = event.id
       JOIN platform.idempotency_keys idempotency ON idempotency.id = revision.idempotency_key_id
       WHERE revision.property_id = $1::uuid
       ORDER BY revision.revision_number`,
      [propertyId],
    );
    expect(durable.rows).toEqual([
      {
        revisionNumber: 1,
        domainEventKey: `booking.design.property.${propertyId}.revision.1.changed.v1`,
        domainEventType: "booking.design.changed",
        eventPayload: {
          contractVersion: "booking-design.v1",
          eventType: "booking.design.changed",
          propertyId,
          designRevision: 1,
          outcome: "created",
        },
        destination: "booking.launch-readiness",
        outboxKey: `booking.design.property.${propertyId}.revision.1.launch-readiness.v1`,
        outboxEventType: "booking.design.changed",
        outboxPayload: {
          contractVersion: "booking-design.v1",
          eventType: "booking.design.changed",
          propertyId,
          designRevision: 1,
          outcome: "created",
        },
        action: "booking.design.created",
        idempotencyOrganizationId: null,
        idempotencyPropertyId: propertyId,
        activePublicRevision: "0",
      },
      {
        revisionNumber: 2,
        domainEventKey: `booking.design.property.${propertyId}.revision.2.changed.v1`,
        domainEventType: "booking.design.changed",
        eventPayload: {
          contractVersion: "booking-design.v1",
          eventType: "booking.design.changed",
          propertyId,
          designRevision: 2,
          outcome: "updated",
        },
        destination: "booking.launch-readiness",
        outboxKey: `booking.design.property.${propertyId}.revision.2.launch-readiness.v1`,
        outboxEventType: "booking.design.changed",
        outboxPayload: {
          contractVersion: "booking-design.v1",
          eventType: "booking.design.changed",
          propertyId,
          designRevision: 2,
          outcome: "updated",
        },
        action: "booking.design.updated",
        idempotencyOrganizationId: null,
        idempotencyPropertyId: propertyId,
        activePublicRevision: "0",
      },
    ]);
  });

  it("re-authorizes and exactly replays without duplicate audit or emission", async () => {
    const first = await repository.upsertDesign(
      command("exact-replay", 0, "#2D6A4F", "grand-classic"),
    );
    expect(first).toMatchObject({ ok: true, outcome: "created" });
    await expect(
      repository.upsertDesign({
        ...command("exact-replay", 0, "#2D6A4F", "grand-classic"),
        organizationId: organizationId.toUpperCase(),
        propertyId: propertyId.toUpperCase(),
        audit: { requestId: "retry", correlationId: "retry", source: "retry" },
      }),
    ).resolves.toMatchObject({ ok: true, outcome: "idempotent_replay", design: { revision: 1 } });
    await expect(counts()).resolves.toEqual({
      audits: "1",
      domainEvents: "1",
      idempotencyKeys: "1",
      outboxEvents: "1",
      revisions: "1",
    });

    await admin.query(
      `UPDATE identity.organization_memberships SET status = 'suspended'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, actorUserId],
    );
    await expect(
      repository.upsertDesign(command("exact-replay", 0, "#2D6A4F", "grand-classic")),
    ).resolves.toEqual({ ok: false, error: { code: "setup_scope_unavailable" } });
    await expect(counts()).resolves.toMatchObject({ revisions: "1", audits: "1" });
  });

  it("returns changed-key conflict before stale revision and safely replays stale results", async () => {
    await repository.upsertDesign(command("shared-key", 0, "#4F46E5", "high-end-serif"));
    await expect(
      repository.upsertDesign(command("shared-key", 0, "#7B2D8E", "imperial-serif")),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });

    const stale = command("stale-key", 0, "#7B2D8E", "imperial-serif");
    const conflict = {
      ok: false as const,
      error: { code: "design_revision_conflict" as const, currentRevision: 1 },
    };
    await expect(repository.upsertDesign(stale)).resolves.toEqual(conflict);
    await expect(repository.upsertDesign(stale)).resolves.toEqual(conflict);
    await expect(counts()).resolves.toEqual({
      audits: "2",
      domainEvents: "1",
      idempotencyKeys: "2",
      outboxEvents: "1",
      revisions: "1",
    });
  });

  it("serializes different-key writers against one property revision", async () => {
    const [first, second] = await Promise.all([
      repository.upsertDesign(command("concurrent-a", 0, "#4F46E5", "high-end-serif")),
      repository.upsertDesign(command("concurrent-b", 0, "#2D3436", "italiana-serif")),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "design_revision_conflict", currentRevision: 1 } },
    ]);
    await expect(counts()).resolves.toMatchObject({
      revisions: "1",
      domainEvents: "1",
      outboxEvents: "1",
      idempotencyKeys: "2",
    });
  });

  it("keeps revision identity property-global across authorized organizations", async () => {
    await repository.upsertDesign(command("first-owner", 0, "#4F46E5", "high-end-serif"));
    await seedSecondAuthorizedScope();
    await expect(
      repository.upsertDesign(
        command("next-operator", 1, "#2D3436", "italiana-serif", secondOrganizationId),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "updated", design: { revision: 2 } });

    await expect(
      admin.query(
        `SELECT revision.organization_id::text AS "organizationId",
                revision.revision_number AS "revisionNumber",
                current.organization_id::text AS "currentOrganizationId"
         FROM booking.booking_design_revisions revision
         LEFT JOIN booking.current_working_design_revisions current
           ON current.revision_id = revision.id
         WHERE revision.property_id = $1::uuid
         ORDER BY revision.revision_number`,
        [propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { organizationId, revisionNumber: 1, currentOrganizationId: null },
        {
          organizationId: secondOrganizationId,
          revisionNumber: 2,
          currentOrganizationId: secondOrganizationId,
        },
      ],
    });
    await expect(
      repository.getCurrentDesign({ organizationId: secondOrganizationId, propertyId }),
    ).resolves.toMatchObject({ revision: 2 });
    await expect(repository.getCurrentDesign({ organizationId, propertyId })).resolves.toBeNull();
  });

  it("serializes the same concurrent key into one creation and one exact replay", async () => {
    const request = command("concurrent-replay", 0, "#4F46E5", "high-end-serif");
    const results = await Promise.all([
      repository.upsertDesign(request),
      repository.upsertDesign({
        ...request,
        audit: { requestId: "concurrent-retry", source: "retry" },
      }),
    ]);
    expect(
      results.map((result) => (result.ok ? result.outcome : result.error.code)).sort(),
    ).toEqual(["created", "idempotent_replay"]);
    await expect(counts()).resolves.toEqual({
      audits: "1",
      domainEvents: "1",
      idempotencyKeys: "1",
      outboxEvents: "1",
      revisions: "1",
    });
  });

  it("rolls back idempotency, event, revision, pointer, and audit if outbox is unavailable", async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const failing = createPgBookingDesignRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: failOutboxPool(pool),
      now: () => new Date(acceptedAt),
    });
    try {
      await expect(
        failing.upsertDesign(command("outbox-failure", 0, "#4F46E5", "high-end-serif")),
      ).rejects.toThrow("injected design outbox failure");
      await expect(counts()).resolves.toEqual({
        audits: "0",
        domainEvents: "0",
        idempotencyKeys: "0",
        outboxEvents: "0",
        revisions: "0",
      });
      await expect(repository.getCurrentDesign({ organizationId, propertyId })).resolves.toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("denies unauthorized writes and cross-organization private reads", async () => {
    await admin.query(
      `UPDATE identity.organization_memberships SET status = 'suspended'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, actorUserId],
    );
    await expect(
      repository.upsertDesign(command("denied", 0, "#4F46E5", "high-end-serif")),
    ).resolves.toEqual({ ok: false, error: { code: "setup_scope_unavailable" } });
    await expect(counts()).resolves.toEqual({
      audits: "0",
      domainEvents: "0",
      idempotencyKeys: "0",
      outboxEvents: "0",
      revisions: "0",
    });

    await admin.query(
      `UPDATE identity.organization_memberships SET status = 'active'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, actorUserId],
    );
    await repository.upsertDesign(command("private-read", 0, "#4F46E5", "high-end-serif"));
    await expect(
      repository.getCurrentDesign({ organizationId: crypto.randomUUID(), propertyId }),
    ).resolves.toBeNull();
  });

  async function counts() {
    const result = await admin.query<{
      audits: string;
      domainEvents: string;
      idempotencyKeys: string;
      outboxEvents: string;
      revisions: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM booking.booking_design_revisions
          WHERE property_id = $1::uuid) AS revisions,
         (SELECT count(*)::text FROM platform.product_audit_events
          WHERE property_id = $1::uuid AND action LIKE 'booking.design.%') AS audits,
         (SELECT count(*)::text FROM platform.domain_events
          WHERE property_id = $1::uuid AND event_type = 'booking.design.changed') AS "domainEvents",
         (SELECT count(*)::text FROM platform.idempotency_keys
          WHERE property_id = $1::uuid AND operation = 'booking.design.upsert') AS "idempotencyKeys",
         (SELECT count(*)::text FROM platform.outbox_events
          WHERE property_id = $1::uuid AND event_type = 'booking.design.changed') AS "outboxEvents"`,
      [propertyId],
    );
    return result.rows[0]!;
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        "DELETE FROM booking.current_working_design_revisions WHERE property_id = $1",
        [propertyId],
      );
      await admin.query("DELETE FROM booking.booking_design_revisions WHERE property_id = $1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.product_audit_events WHERE property_id = $1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.outbox_events WHERE property_id = $1", [propertyId]);
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = $1", [propertyId]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM identity.product_entitlements WHERE organization_id = $1", [
        organizationId,
      ]);
      await admin.query("DELETE FROM identity.product_entitlements WHERE organization_id = $1", [
        secondOrganizationId,
      ]);
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1",
        [secondOrganizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1",
        [secondOrganizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1", [secondOrganizationId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1", [actorUserId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function seedAuthorizedScope(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'booking-design@example.test', 'Booking Designer', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Design Hotel', 'design-hotel', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'design-hotel', 'Design Hotel')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key)
       VALUES ($1::uuid, $2::uuid, 'active', 'owner')`,
      [organizationId, actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'booking', 'booking_hotel', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'booking', 'booking-engine', 'active',
               'booking', 'booking_hotel', $2::uuid::text)`,
      [organizationId, propertyId],
    );
  }

  async function seedSecondAuthorizedScope(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Next Design Operator', 'next-design-operator', 'active')`,
      [secondOrganizationId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key)
       VALUES ($1::uuid, $2::uuid, 'active', 'owner')`,
      [secondOrganizationId, actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'booking', 'booking_hotel', $2::uuid::text, 'operator', 'active')`,
      [secondOrganizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'booking', 'booking-engine', 'active',
               'booking', 'booking_hotel', $2::uuid::text)`,
      [secondOrganizationId, propertyId],
    );
  }
});

function command(
  idempotencyKey: string,
  expectedRevision: number,
  primaryColor: UpsertBookingDesignCommand["choices"]["primaryColor"],
  fontPairing: UpsertBookingDesignCommand["choices"]["fontPairing"],
  commandOrganizationId = organizationId,
): UpsertBookingDesignCommand {
  return {
    organizationId: commandOrganizationId,
    propertyId,
    actorUserId,
    idempotencyKey,
    expectedRevision,
    choices: { primaryColor, fontPairing },
    audit: {
      requestId: `request-${idempotencyKey}`,
      correlationId: `correlation-${idempotencyKey}`,
      source: "integration-test",
    },
  };
}

function failOutboxPool(pool: pg.Pool): BookingDesignRepositoryPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query<Row extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">> {
          if (text.includes("INSERT INTO platform.outbox_events")) {
            throw new Error("injected design outbox failure");
          }
          return client.query<Row>(text, values as unknown[]);
        },
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

function assertSafeTestDatabase(url: string): void {
  const parsed = new URL(url);
  if (!/test/i.test(parsed.pathname) || !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("Refusing to run Booking design integration tests against a non-test database");
  }
}
