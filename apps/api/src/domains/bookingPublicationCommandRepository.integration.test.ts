import { createProductReadinessResult } from "@vayada/domain-hotels";
import type {
  ReadyBookingPublicationEvidence,
  RequestBookingPublicationCommand,
} from "@vayada/domain-booking";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgBookingPublicationCommandRepository,
  type BookingPublicationCommandPool,
} from "./bookingPublicationCommandRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "74747474-7474-4747-8747-747474747401";
const organizationId = "74747474-7474-4747-8747-747474747402";
const propertyId = "74747474-7474-4747-8747-747474747403";
const activeRevisionId = "74747474-7474-4747-8747-747474747404";
const resultRevisionId = "74747474-7474-4747-8747-747474747405";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Booking publication command safety", () => {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgBookingPublicationCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date("2026-08-02T13:00:00.000Z"),
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
    await repository.close?.();
    await cleanup();
    await admin.end();
  });

  it("atomically accepts once and exactly replays without duplicate durable work", async () => {
    const request = await command("accept-once");
    const accepted = await repository.requestPublication(request);
    expect(accepted).toMatchObject({ ok: true, operation: { status: "pending", propertyId } });

    await expect(
      repository.requestPublication({
        ...request,
        audit: {
          requestId: "retry-request",
          correlationId: "retry-correlation",
          source: "retry-client",
        },
      }),
    ).resolves.toEqual(accepted);
    await expect(counts()).resolves.toEqual({
      attempts: "1",
      audits: "1",
      domainEvents: "1",
      idempotencyKeys: "1",
      outboxEvents: "1",
    });

    await expect(
      admin.query(
        `SELECT organization_id, property_id
         FROM platform.idempotency_keys
         WHERE operation = 'booking.publication.request'`,
      ),
    ).resolves.toMatchObject({ rows: [{ organization_id: null, property_id: propertyId }] });
  });

  it("rejects reuse with changed input or expected revision", async () => {
    const request = await command("changed-input");
    await expect(repository.requestPublication(request)).resolves.toMatchObject({ ok: true });
    await expect(
      repository.requestPublication({
        ...request,
        expectedActiveContentRevisionId: activeRevisionId,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(counts()).resolves.toMatchObject({ attempts: "1", outboxEvents: "1" });
  });

  it("does not let stale expected content overwrite the active pointer", async () => {
    await seedContentRevision(activeRevisionId, 1, true);
    await expect(repository.requestPublication(await command("stale-pointer"))).resolves.toEqual({
      ok: false,
      error: {
        code: "active_content_revision_conflict",
        currentActiveContentRevisionId: activeRevisionId,
      },
    });
    await expect(counts()).resolves.toEqual({
      attempts: "0",
      audits: "1",
      domainEvents: "0",
      idempotencyKeys: "1",
      outboxEvents: "0",
    });
  });

  it("serializes simultaneous requests so only one open attempt exists", async () => {
    const [first, second] = await Promise.all([
      repository.requestPublication(await command("concurrent-first")),
      repository.requestPublication(await command("concurrent-second")),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "publication_in_progress" } },
    ]);
    await expect(counts()).resolves.toMatchObject({
      attempts: "1",
      domainEvents: "1",
      outboxEvents: "1",
    });
  });

  it("rolls domain, idempotency, and audit state back when required outbox insertion fails", async () => {
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const failingRepository = createPgBookingPublicationCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: failOutboxPool(pool),
      now: () => new Date("2026-08-02T13:00:00.000Z"),
    });
    try {
      await expect(
        failingRepository.requestPublication(await command("outbox-failure")),
      ).rejects.toThrow("injected outbox failure");
      await expect(counts()).resolves.toEqual({
        attempts: "0",
        audits: "0",
        domainEvents: "0",
        idempotencyKeys: "0",
        outboxEvents: "0",
      });
    } finally {
      await pool.end();
    }
  });

  it("denies revoked scope without creating command state", async () => {
    await admin.query(
      `UPDATE identity.organization_memberships
       SET status = 'suspended'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, actorUserId],
    );
    await expect(repository.requestPublication(await command("revoked"))).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(counts()).resolves.toEqual({
      attempts: "0",
      audits: "0",
      domainEvents: "0",
      idempotencyKeys: "0",
      outboxEvents: "0",
    });
  });

  it("re-authorizes an exact retry before returning its stored result", async () => {
    const request = await command("revoked-retry");
    await expect(repository.requestPublication(request)).resolves.toMatchObject({ ok: true });
    await admin.query(
      `UPDATE identity.organization_memberships
       SET status = 'suspended'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, actorUserId],
    );

    await expect(repository.requestPublication(request)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(counts()).resolves.toEqual({
      attempts: "1",
      audits: "1",
      domainEvents: "1",
      idempotencyKeys: "1",
      outboxEvents: "1",
    });
  });

  it("returns only safe authorized status and never treats unknown as success", async () => {
    const accepted = await repository.requestPublication(await command("status"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    const statusInput = {
      actorUserId,
      organizationId,
      propertyId,
      operationId: accepted.operation.operationId,
    };

    await admin.query(
      `UPDATE booking.booking_publication_attempts
       SET status = 'unknown', failure_code = 'external_result_unconfirmed', updated_at = now()
       WHERE id = $1::uuid`,
      [accepted.operation.operationId],
    );
    await expect(repository.getPublicationStatus(statusInput)).resolves.toMatchObject({
      operationId: accepted.operation.operationId,
      propertyId,
      status: "unknown",
      resultContentRevisionId: null,
      completedAt: null,
      failureCode: "external_result_unconfirmed",
    });
    await expect(
      repository.getPublicationStatus({ ...statusInput, organizationId: crypto.randomUUID() }),
    ).resolves.toBeNull();
    await expect(
      admin.query(
        `UPDATE booking.booking_publication_attempts
         SET status = 'succeeded', failure_code = NULL, completed_at = now()
         WHERE id = $1::uuid`,
        [accepted.operation.operationId],
      ),
    ).rejects.toThrow();

    await seedContentRevision(resultRevisionId, 2, false);
    await admin.query(
      `UPDATE booking.booking_publication_attempts
       SET status = 'succeeded', failure_code = NULL,
           result_content_revision_id = $2::uuid, completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [accepted.operation.operationId, resultRevisionId],
    );
    await expect(repository.getPublicationStatus(statusInput)).resolves.toMatchObject({
      status: "succeeded",
      resultContentRevisionId: resultRevisionId,
      failureCode: null,
      completedAt: expect.any(String),
    });
  });

  async function counts() {
    const result = await admin.query<{
      attempts: string;
      audits: string;
      domainEvents: string;
      idempotencyKeys: string;
      outboxEvents: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM booking.booking_publication_attempts
          WHERE property_id = $1::uuid) AS attempts,
         (SELECT count(*)::text FROM platform.product_audit_events
          WHERE property_id = $1::uuid AND product = 'booking'
            AND action LIKE 'booking.publication.request.%') AS audits,
         (SELECT count(*)::text FROM platform.domain_events
          WHERE property_id = $1::uuid AND event_type = 'booking.publication.requested') AS "domainEvents",
         (SELECT count(*)::text FROM platform.idempotency_keys
          WHERE property_id = $1::uuid AND operation = 'booking.publication.request') AS "idempotencyKeys",
         (SELECT count(*)::text FROM platform.outbox_events
          WHERE property_id = $1::uuid AND event_type = 'booking.publication.requested') AS "outboxEvents"`,
      [propertyId],
    );
    return result.rows[0]!;
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("DELETE FROM booking.booking_publication_attempts WHERE property_id = $1", [
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
      await admin.query(
        "DELETE FROM distribution.active_public_booking_revision WHERE property_id = $1",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM distribution.public_booking_content_revisions WHERE property_id = $1",
        [propertyId],
      );
      await admin.query("DELETE FROM identity.product_entitlements WHERE organization_id = $1", [
        organizationId,
      ]);
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
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
       VALUES ($1::uuid, 'booking-publication@example.test', 'Booking Publisher', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Publication Hotel', 'publication-hotel', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'publication-hotel', 'Publication Hotel')`,
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

  async function seedContentRevision(
    revisionId: string,
    revisionNumber: number,
    active: boolean,
  ): Promise<void> {
    const readiness = await readinessEvidence();
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7,
         'booking', 'ready', '{}'::jsonb, $8::uuid
       )`,
      [
        revisionId,
        propertyId,
        revisionNumber,
        readiness.contractVersion,
        JSON.stringify(readiness.sourceManifest),
        readiness.sourceManifestHash,
        readiness.readinessHash,
        actorUserId,
      ],
    );
    if (active) {
      await admin.query(
        `INSERT INTO distribution.active_public_booking_revision
           (property_id, content_revision_id, activated_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [propertyId, revisionId, actorUserId],
      );
    }
  }
});

async function command(idempotencyKey: string): Promise<RequestBookingPublicationCommand> {
  return {
    organizationId,
    propertyId,
    actorUserId,
    idempotencyKey,
    expectedActiveContentRevisionId: null,
    readiness: await readinessEvidence(),
    audit: {
      requestId: `request-${idempotencyKey}`,
      correlationId: `correlation-${idempotencyKey}`,
      source: "integration-test",
    },
  };
}

async function readinessEvidence(): Promise<ReadyBookingPublicationEvidence> {
  const readiness = await createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "booking",
    status: "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [
        {
          ownerDomain: "booking",
          entityType: "booking_settings",
          entityId: propertyId,
          revision: "booking-settings:4",
        },
      ],
    },
    groups: [
      {
        groupId: "booking.guest_experience",
        status: "ready",
        steps: [
          {
            owningStepId: "guest_experience",
            status: "ready",
            entities: [
              {
                source: {
                  ownerDomain: "booking",
                  entityType: "booking_settings",
                  entityId: propertyId,
                  revision: "booking-settings:4",
                },
                status: "ready",
                blockers: [],
              },
            ],
          },
        ],
      },
    ],
    evaluatedAt: "2026-08-02T12:00:00.000Z",
  });
  return readiness as ReadyBookingPublicationEvidence;
}

function failOutboxPool(pool: pg.Pool): BookingPublicationCommandPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
          if (text.includes("INSERT INTO platform.outbox_events")) {
            throw new Error("injected outbox failure");
          }
          return client.query<T>(text, values as unknown[]);
        },
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
