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
import {
  createPgBookingPublicationAttemptStatusRepository,
  type BookingPublicationAttemptStatusPort,
} from "./bookingPublicationAttemptStatusRepository.js";
import { createBookingPublicationProjector } from "./bookingPublicationProjector.js";
import type { BookingPublicationProjectorPool } from "./bookingPublicationProjector.js";
import {
  createPgDistributionBookingPublicationProjection,
  type DistributionBookingPublicationPool,
} from "./distributionBookingPublicationProjection.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "74747474-7474-4747-8747-747474747401";
const organizationId = "74747474-7474-4747-8747-747474747402";
const secondOrganizationId = "74747474-7474-4747-8747-747474747406";
const propertyId = "74747474-7474-4747-8747-747474747403";
const activeRevisionId = "74747474-7474-4747-8747-747474747404";
const resultRevisionId = "74747474-7474-4747-8747-747474747405";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Booking publication command safety", () => {
  let currentReadinessRevision = "booking-settings:4";
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const distributionPublication = createPgDistributionBookingPublicationProjection({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const attemptStatus = createPgBookingPublicationAttemptStatusRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const projector = createBookingPublicationProjector({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    projection: distributionPublication,
    attempts: attemptStatus,
    readiness: {
      getBookingReadiness: async () => readinessEvidence(currentReadinessRevision),
    },
    now: () => new Date("2026-08-02T13:01:00.000Z"),
  });
  const repository = createPgBookingPublicationCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date("2026-08-02T13:00:00.000Z"),
    activeContent: distributionPublication,
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    currentReadinessRevision = "booking-settings:4";
    await cleanup();
    await seedAuthorizedScope();
  });

  afterAll(async () => {
    await repository.close?.();
    await projector.close?.();
    await attemptStatus.close?.();
    await distributionPublication.close?.();
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

  it("rejects the same scoped key when verified readiness identity changes", async () => {
    const request = await command("changed-readiness");
    await expect(repository.requestPublication(request)).resolves.toMatchObject({ ok: true });
    await expect(
      repository.requestPublication({
        ...request,
        readiness: await readinessEvidence("booking-settings:5"),
      }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(counts()).resolves.toMatchObject({ attempts: "1", outboxEvents: "1" });
  });

  it("scopes a reused raw key to the authorized organization and property", async () => {
    const first = await repository.requestPublication(await command("organization-scope"));
    if (!first.ok) throw new Error("Expected first organization publication request");
    await admin.query(
      `UPDATE booking.booking_publication_attempts
       SET status = 'failed', failure_code = 'projection_failed',
           completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [first.operation.operationId],
    );
    await seedSecondAuthorizedScope();
    await expect(
      repository.requestPublication(
        await command("organization-scope", { organizationId: secondOrganizationId }),
      ),
    ).resolves.toMatchObject({ ok: true, operation: { status: "pending" } });
    await expect(counts()).resolves.toMatchObject({
      attempts: "2",
      idempotencyKeys: "2",
      outboxEvents: "2",
    });
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
      activeContent: { getActive: async () => null },
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
         SET failure_code = 'raw_provider_error_with_secrets'
         WHERE id = $1::uuid`,
        [accepted.operation.operationId],
      ),
    ).rejects.toThrow();
    await expect(
      admin.query(
        `UPDATE booking.booking_publication_attempts
         SET status = 'succeeded', failure_code = NULL, completed_at = now()
         WHERE id = $1::uuid`,
        [accepted.operation.operationId],
      ),
    ).rejects.toThrow();

    await seedContentRevision(resultRevisionId, 2, false);
    await expect(
      admin.query(
        `UPDATE booking.booking_publication_attempts
         SET status = 'succeeded', failure_code = NULL,
             result_content_revision_id = $2::uuid, completed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [accepted.operation.operationId, resultRevisionId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await admin.query(
      `INSERT INTO distribution.active_public_booking_revision
         (property_id, content_revision_id, activated_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [propertyId, resultRevisionId, actorUserId],
    );
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

  it("projects the required outbox intent and reports success only after CAS activation", async () => {
    await seedPublicBookabilityProfile();
    const accepted = await repository.requestPublication(await command("project-success"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      exhausted: 0,
    });
    await expect(
      repository.getPublicationStatus({
        actorUserId,
        organizationId,
        propertyId,
        operationId: accepted.operation.operationId,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      resultContentRevisionId: accepted.operation.operationId,
      failureCode: null,
      completedAt: "2026-08-02T13:01:00.000Z",
    });
    await expect(
      admin.query(
        `SELECT active.content_revision_id::text AS "activeRevisionId",
                outbox.status AS "outboxStatus",
                revision.public_content AS "publicContent"
         FROM distribution.active_public_booking_revision active
         JOIN distribution.public_booking_content_revisions revision
           ON revision.id = active.content_revision_id
         JOIN platform.outbox_events outbox
           ON outbox.resource_id = active.content_revision_id::text
          AND outbox.event_type = 'booking.publication.requested'
         WHERE active.property_id = $1::uuid`,
        [propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          activeRevisionId: accepted.operation.operationId,
          outboxStatus: "published",
          publicContent: {
            contractVersion: "booking-public-content.v1",
            profile: { publicId: "publication-hotel" },
            roomOffers: [],
          },
        },
      ],
    });
    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
    });
  });

  it("does not let the projector overwrite a pointer that changed after acceptance", async () => {
    const accepted = await repository.requestPublication(await command("projector-stale-pointer"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    await seedContentRevision(activeRevisionId, 1, true);

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      exhausted: 0,
    });
    await expect(
      repository.getPublicationStatus({
        actorUserId,
        organizationId,
        propertyId,
        operationId: accepted.operation.operationId,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      resultContentRevisionId: null,
      failureCode: "source_content_changed",
    });
    await expect(distributionPublication.getActive(propertyId)).resolves.toMatchObject({
      revisionId: activeRevisionId,
    });
  });

  it("rejects owner-source drift that occurs after command acceptance", async () => {
    await seedPublicBookabilityProfile();
    const accepted = await repository.requestPublication(await command("projector-source-drift"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    currentReadinessRevision = "booking-settings:5";

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      exhausted: 0,
    });
    await expect(distributionPublication.getActive(propertyId)).resolves.toBeNull();
    await expect(
      repository.getPublicationStatus({
        actorUserId,
        organizationId,
        propertyId,
        operationId: accepted.operation.operationId,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "source_content_changed",
      resultContentRevisionId: null,
    });
  });

  it("retries status terminalization without failing an already-active revision", async () => {
    await seedPublicBookabilityProfile();
    const accepted = await repository.requestPublication(await command("status-write-retry"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    const statusFailure = createBookingPublicationProjector({
      connectionString: TEST_DATABASE_URL!,
      projection: distributionPublication,
      attempts: failSucceeded(attemptStatus),
      readiness: { getBookingReadiness: async () => readinessEvidence() },
      now: () => new Date("2026-08-02T13:01:00.000Z"),
    });
    try {
      await expect(statusFailure.projectPending({ propertyId })).resolves.toEqual({
        processed: 1,
        succeeded: 0,
        failed: 1,
        exhausted: 0,
      });
      await expect(distributionPublication.getActive(propertyId)).resolves.toMatchObject({
        revisionId: accepted.operation.operationId,
      });
      await expect(
        repository.getPublicationStatus({
          actorUserId,
          organizationId,
          propertyId,
          operationId: accepted.operation.operationId,
        }),
      ).resolves.toMatchObject({ status: "pending", resultContentRevisionId: null });

      currentReadinessRevision = "booking-settings:5";
      await expect(projector.projectPending({ propertyId })).resolves.toEqual({
        processed: 1,
        succeeded: 1,
        failed: 0,
        exhausted: 0,
      });
      await expect(
        repository.getPublicationStatus({
          actorUserId,
          organizationId,
          propertyId,
          operationId: accepted.operation.operationId,
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
        resultContentRevisionId: accepted.operation.operationId,
      });
    } finally {
      await statusFailure.close?.();
    }
  });

  it("reconciles an active revision before recovering an expired final lease", async () => {
    await seedPublicBookabilityProfile();
    const request = await command("expired-active-lease");
    const accepted = await repository.requestPublication(request);
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    await expect(
      admin.query(
        `SELECT expected_property_lifecycle_revision AS revision
         FROM booking.booking_publication_attempts WHERE id = $1::uuid`,
        [accepted.operation.operationId],
      ),
    ).resolves.toMatchObject({ rows: [{ revision: "1" }] });
    await admin.query(
      `UPDATE platform.outbox_events
       SET status = 'leased', attempts_count = 1, max_attempts = 1,
           leased_until = '2026-08-02T13:01:30.000Z'::timestamptz,
           outbox_metadata = jsonb_set(
             outbox_metadata,
             '{bookingPublicationProjection}',
             jsonb_build_object('leaseToken', 'direct-activation'),
             true
           )
       WHERE resource_id = $1
         AND event_type = 'booking.publication.requested'`,
      [accepted.operation.operationId],
    );
    await distributionPublication.projectPublication({
      operationId: accepted.operation.operationId,
      outboxEventId: await outboxEventId(accepted.operation.operationId),
      outboxLeaseToken: "direct-activation",
      propertyId,
      expectedActiveRevisionId: null,
      expectedPropertyLifecycleRevision: 1,
      requestedByUserId: actorUserId,
      readiness: request.readiness,
      projectedAt: new Date("2026-08-02T13:00:30.000Z"),
    });
    await admin.query(
      `UPDATE platform.outbox_events
       SET status = 'leased', attempts_count = 1, max_attempts = 1,
           leased_until = '2026-08-02T13:00:59.000Z'::timestamptz,
           outbox_metadata = jsonb_set(
             outbox_metadata,
             '{bookingPublicationProjection}',
             jsonb_build_object('leaseToken', 'crashed-worker'),
             true
           )
       WHERE resource_id = $1
         AND event_type = 'booking.publication.requested'`,
      [accepted.operation.operationId],
    );

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
      exhausted: 0,
    });
    await expect(
      admin.query(
        `SELECT attempt.status AS "attemptStatus", outbox.status AS "outboxStatus",
                (SELECT count(*)::int FROM platform.dead_letter_events dead
                 WHERE dead.outbox_event_id = outbox.id) AS "deadLetters"
         FROM booking.booking_publication_attempts attempt
         JOIN platform.outbox_events outbox ON outbox.id = attempt.outbox_event_id
         WHERE attempt.id = $1::uuid`,
        [accepted.operation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ attemptStatus: "succeeded", outboxStatus: "published", deadLetters: 0 }],
    });
  });

  it("does not reactivate public Booking content after property retirement", async () => {
    await seedPublicBookabilityProfile();
    const accepted = await repository.requestPublication(await command("retired-before-project"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    await admin.query(
      `UPDATE hotel_catalog.properties
       SET lifecycle_status = 'retired', profile_status = 'disabled',
           retired_at = '2026-08-02T13:00:15.000Z'::timestamptz,
           retired_by_user_id = $2::uuid
       WHERE id = $1::uuid`,
      [propertyId, actorUserId],
    );

    await expect(projector.projectPending({ propertyId })).resolves.toMatchObject({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });
    await expect(distributionPublication.getActive(propertyId)).resolves.toBeNull();
  });

  it("fences a queued publication across retirement recovery", async () => {
    await seedPublicBookabilityProfile();
    const accepted = await repository.requestPublication(await command("recovered-before-project"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    await admin.query(
      `UPDATE hotel_catalog.properties
       SET lifecycle_revision = 3, lifecycle_status = 'active', profile_status = 'complete'
       WHERE id = $1::uuid`,
      [propertyId],
    );

    await expect(projector.projectPending({ propertyId })).resolves.toMatchObject({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });
    await expect(distributionPublication.getActive(propertyId)).resolves.toBeNull();
  });

  it("uses lifecycle lock order when publication races a suspension", async () => {
    const lifecycle = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await lifecycle.connect();
    try {
      await lifecycle.query("BEGIN");
      await lifecycle.query(
        `SELECT pg_advisory_xact_lock(
           hashtext('booking.publication'), hashtext($1::uuid::text)
         )`,
        [propertyId],
      );
      await lifecycle.query(
        `UPDATE hotel_catalog.properties
         SET lifecycle_status = 'suspended', lifecycle_revision = lifecycle_revision + 1,
             pre_hold_profile_status = profile_status, profile_status = 'disabled'
         WHERE id = $1::uuid`,
        [propertyId],
      );
      const publication = repository.requestPublication(await command("suspension-race"));
      await lifecycle.query("COMMIT");

      await expect(publication).resolves.toMatchObject({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
    } finally {
      await lifecycle.query("ROLLBACK").catch(() => undefined);
      await lifecycle.end();
    }
  });

  it("fences a paused activation against lease recovery and source drift", async () => {
    await seedPublicBookabilityProfile();
    const accepted = await repository.requestPublication(await command("lease-fence-race"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    const projectionPool = new pg.Pool({ connectionString: TEST_DATABASE_URL!, max: 1 });
    const workerPool = new pg.Pool({ connectionString: TEST_DATABASE_URL!, max: 1 });
    const projectionEntered = deferred<void>();
    const releaseProjection = deferred<void>();
    const recoveryStarted = deferred<void>();
    const pausedProjection = createPgDistributionBookingPublicationProjection({
      connectionString: TEST_DATABASE_URL!,
      pool: pauseBeforeProjectionCommitPool(projectionPool, projectionEntered, releaseProjection),
    });
    const firstWorker = createBookingPublicationProjector({
      connectionString: TEST_DATABASE_URL!,
      projection: pausedProjection,
      attempts: failSucceeded(attemptStatus),
      readiness: { getBookingReadiness: async () => readinessEvidence() },
      leaseDurationMs: 1,
      now: () => new Date("2026-08-02T13:01:00.000Z"),
    });
    const replacementWorker = createBookingPublicationProjector({
      connectionString: TEST_DATABASE_URL!,
      pool: signalLeaseRecoveryPool(workerPool, recoveryStarted),
      projection: distributionPublication,
      attempts: attemptStatus,
      readiness: {
        getBookingReadiness: async () => readinessEvidence(currentReadinessRevision),
      },
      now: () => new Date("2026-08-02T13:01:00.002Z"),
    });
    try {
      const first = firstWorker.projectPending({ propertyId });
      await projectionEntered.promise;
      currentReadinessRevision = "booking-settings:5";
      const replacement = replacementWorker.projectPending({ propertyId });
      await recoveryStarted.promise;
      releaseProjection.resolve();
      await Promise.allSettled([first, replacement]);

      await expect(
        repository.getPublicationStatus({
          actorUserId,
          organizationId,
          propertyId,
          operationId: accepted.operation.operationId,
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
        resultContentRevisionId: accepted.operation.operationId,
        failureCode: null,
      });
      await expect(
        admin.query(
          `SELECT outbox.status AS "outboxStatus",
                  (SELECT count(*)::int FROM platform.dead_letter_events dead
                   WHERE dead.outbox_event_id = outbox.id) AS "deadLetters"
           FROM platform.outbox_events outbox
           WHERE outbox.resource_id = $1`,
          [accepted.operation.operationId],
        ),
      ).resolves.toMatchObject({
        rows: [{ outboxStatus: "published", deadLetters: 0 }],
      });
    } finally {
      releaseProjection.resolve();
      await firstWorker.close?.();
      await replacementWorker.close?.();
      await pausedProjection.close?.();
      await projectionPool.end();
      await workerPool.end();
    }
  });

  it("rolls exhausted outbox and dead-letter state back when attempt failure cannot commit", async () => {
    const accepted = await repository.requestPublication(await command("atomic-exhaustion"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    await admin.query(
      `UPDATE platform.outbox_events
       SET max_attempts = 1
       WHERE resource_id = $1
         AND event_type = 'booking.publication.requested'`,
      [accepted.operation.operationId],
    );
    const failingStatus = createBookingPublicationProjector({
      connectionString: TEST_DATABASE_URL!,
      projection: distributionPublication,
      attempts: failTransactionFailure(attemptStatus),
      readiness: { getBookingReadiness: async () => readinessEvidence() },
      now: () => new Date("2026-08-02T13:01:00.000Z"),
    });
    try {
      await expect(failingStatus.projectPending({ propertyId })).rejects.toThrow(
        "injected terminal status failure",
      );
      await expect(
        admin.query(
          `SELECT attempt.status AS "attemptStatus", outbox.status AS "outboxStatus",
                  (SELECT count(*)::int FROM platform.dead_letter_events dead
                   WHERE dead.outbox_event_id = outbox.id) AS "deadLetters"
           FROM booking.booking_publication_attempts attempt
           JOIN platform.outbox_events outbox ON outbox.id = attempt.outbox_event_id
           WHERE attempt.id = $1::uuid`,
          [accepted.operation.operationId],
        ),
      ).resolves.toMatchObject({
        rows: [{ attemptStatus: "pending", outboxStatus: "leased", deadLetters: 0 }],
      });
    } finally {
      await failingStatus.close?.();
    }
  });

  it("exhausts unavailable public projection safely without reporting success", async () => {
    const accepted = await repository.requestPublication(await command("projector-unavailable"));
    if (!accepted.ok) throw new Error("Expected accepted publication request");
    await admin.query(
      `UPDATE platform.outbox_events
       SET max_attempts = 1
       WHERE resource_id = $1
         AND event_type = 'booking.publication.requested'`,
      [accepted.operation.operationId],
    );

    await expect(projector.projectPending({ propertyId })).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
      exhausted: 1,
    });
    await expect(
      repository.getPublicationStatus({
        actorUserId,
        organizationId,
        propertyId,
        operationId: accepted.operation.operationId,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      resultContentRevisionId: null,
      failureCode: "projection_failed",
    });
    await expect(
      admin.query(
        `SELECT outbox.status AS "outboxStatus",
                dead_letter.reason_code AS "reasonCode"
         FROM platform.outbox_events outbox
         LEFT JOIN platform.dead_letter_events dead_letter
           ON dead_letter.outbox_event_id = outbox.id
         WHERE outbox.resource_id = $1`,
        [accepted.operation.operationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ outboxStatus: "failed", reasonCode: "max_attempts_exhausted" }],
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

  async function outboxEventId(operationId: string): Promise<string> {
    const result = await admin.query<{ id: string }>(
      `SELECT id::text AS id
       FROM platform.outbox_events
       WHERE resource_id = $1
         AND event_type = 'booking.publication.requested'`,
      [operationId],
    );
    if (!result.rows[0]) throw new Error("Expected Booking publication outbox event");
    return result.rows[0].id;
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
      await admin.query("DELETE FROM platform.dead_letter_events WHERE property_id = $1", [
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
      await admin.query(
        "DELETE FROM distribution.public_room_offer_snapshots WHERE property_id = $1",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1",
        [propertyId],
      );
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
       VALUES ($1::uuid, 'booking-publication@example.test', 'Booking Publisher', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Publication Hotel', 'publication-hotel', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (
         id, public_id, display_name, profile_status, lifecycle_status
       ) VALUES ($1::uuid, 'publication-hotel', 'Publication Hotel', 'complete', 'active')`,
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

  async function seedSecondAuthorizedScope(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Next Publication Hotel', 'next-publication-hotel', 'active')`,
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
       VALUES ($1::uuid, 'booking', 'booking_hotel', $2::uuid::text, 'owner', 'active')`,
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

  async function seedPublicBookabilityProfile(): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (
         property_id, public_id, display_name, canonical_slug,
         default_locale, supported_locales, profile_status
       ) VALUES (
         $1::uuid, 'publication-hotel', 'Publication Hotel', 'publication-hotel',
         'en', ARRAY['en'], 'complete'
       )`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles (
         property_id, public_id, canonical_slug, canonical_url, booking_base_url,
         timezone, default_locale, supported_locales,
         default_currency, supported_currencies,
         profile_status, freshness_status
       ) VALUES (
         $1::uuid, 'publication-hotel', 'publication-hotel',
         'https://booking.example.test/publication-hotel',
         'https://booking.example.test', 'Europe/Berlin', 'en', ARRAY['en'],
         'EUR', ARRAY['EUR'], 'public', 'fresh'
       )`,
      [propertyId],
    );
  }
});

async function command(
  idempotencyKey: string,
  options: { organizationId?: string } = {},
): Promise<RequestBookingPublicationCommand> {
  return {
    organizationId: options.organizationId ?? organizationId,
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

async function readinessEvidence(
  revision = "booking-settings:4",
): Promise<ReadyBookingPublicationEvidence> {
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
          revision,
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
                  revision,
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

function failSucceeded(
  delegate: BookingPublicationAttemptStatusPort,
): BookingPublicationAttemptStatusPort {
  return {
    async markSucceeded() {
      throw new Error("injected success status failure");
    },
    markSucceededInTransaction: (transaction, input) =>
      delegate.markSucceededInTransaction(transaction, input),
    markFailed: (input) => delegate.markFailed(input),
    markFailedInTransaction: (transaction, input) =>
      delegate.markFailedInTransaction(transaction, input),
  };
}

function failTransactionFailure(
  delegate: BookingPublicationAttemptStatusPort,
): BookingPublicationAttemptStatusPort {
  return {
    markSucceeded: (input) => delegate.markSucceeded(input),
    markSucceededInTransaction: (transaction, input) =>
      delegate.markSucceededInTransaction(transaction, input),
    markFailed: (input) => delegate.markFailed(input),
    async markFailedInTransaction() {
      throw new Error("injected terminal status failure");
    },
  };
}

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value): void;
};

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((fulfilled) => {
    resolve = fulfilled;
  });
  return { promise, resolve };
}

function pauseBeforeProjectionCommitPool(
  pool: pg.Pool,
  entered: Deferred<void>,
  resume: Deferred<void>,
): DistributionBookingPublicationPool {
  return {
    async connect() {
      const client = await pool.connect();
      let activationWritten = false;
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
          if (text.includes("INSERT INTO distribution.active_public_booking_revision")) {
            activationWritten = true;
          }
          if (text === "COMMIT" && activationWritten) {
            entered.resolve();
            await resume.promise;
          }
          return client.query<T>(text, values as unknown[]);
        },
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

function signalLeaseRecoveryPool(
  pool: pg.Pool,
  recoveryStarted: Deferred<void>,
): BookingPublicationProjectorPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
          if (
            text.includes("UPDATE platform.outbox_events") &&
            text.includes("lease_expired_requeued")
          ) {
            recoveryStarted.resolve();
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
