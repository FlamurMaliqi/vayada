import {
  createHotelMediaResolutionPort,
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
} from "@vayada/domain-hotels";
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import { createPgHotelMediaResolutionPort } from "../platform/hotelMediaResolver.js";
import { PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE } from "../platform/publicBookabilityPublication.js";
import { syncPropertyOfferReadModels } from "../routes/marketplaceAdmin.js";
import { createPgS3PropertyMediaCommandRepository } from "./propertyMediaCommandRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const userId = "68686868-6868-4686-8686-686868686801";
const organizationId = "68686868-6868-4686-8686-686868686802";
const propertyId = "68686868-6868-4686-8686-686868686803";
const mediaId = "68686868-6868-4686-8686-686868686804";
const previousMediaId = "68686868-6868-4686-8686-686868686805";
const publicationQueue = "hotel-catalog.property-media";
const publicationJobType = "hotel-catalog.property-media.publish";
const serving: PlatformMediaServingConfig = {
  bucketName: "vayada-media-test",
  cdnBaseUrl: "https://cdn.example.test",
  cdnOriginHost: "vayada-media-test.s3.example.test",
  publicPathPrefix: "media",
  publicCacheControl: "public, max-age=31536000, immutable",
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
};

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL property media publication saga", () => {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const copyToPublic = vi.fn(
    async (_input: { publicStorageKey: string }): Promise<void> => undefined,
  );
  const deletePublic = vi.fn(
    async (_input: { publicStorageKey: string }): Promise<void> => undefined,
  );
  const repository = createPgS3PropertyMediaCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    serving,
    max: 6,
    publisher: { copyToPublic, deletePublic },
    syncReadModels: syncPropertyOfferReadModels,
  });
  const mediaResolver = createPgHotelMediaResolutionPort({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    serving,
    max: 2,
  });
  const mediaResolutionPort = createHotelMediaResolutionPort(mediaResolver);

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedFixture();
    copyToPublic.mockReset();
    copyToPublic.mockImplementation(async () => undefined);
    deletePublic.mockReset();
    deletePublic.mockImplementation(async () => undefined);
  });

  afterAll(async () => {
    await repository.close();
    await mediaResolver.close?.();
    await cleanup();
    await admin.end();
  });

  it("durably publishes, projects, replays, and removes reusable property media", async () => {
    const command = presentationCommand("integration-presentation-1");
    let inspectedCommittedCas = false;
    copyToPublic.mockImplementation(async ({ publicStorageKey }) => {
      expect(publicStorageKey).toMatch(
        /^public\/media\/[0-9a-f-]+\/[a-z_]+\/publication-[0-9a-f-]{36}\.webp$/,
      );
      if (inspectedCommittedCas) return;
      inspectedCommittedCas = true;
      await expect(readPropertyRevision()).resolves.toBe(2);
      await expect(readPendingAssignmentCount()).resolves.toBe(2);
      await expect(readMediaState(mediaId)).resolves.toMatchObject({
        visibility: "private",
        publicApproved: false,
        publicVariantCount: "0",
      });
    });

    await expect(repository.replacePresentation(command)).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", profileRevision: 3 },
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    expect(inspectedCommittedCas).toBe(true);
    expect(deletePublic).not.toHaveBeenCalled();
    await expect(readProjectionMedia()).resolves.toMatchObject([
      { platformMediaObjectId: mediaId, type: "hero_image", sortOrder: 0 },
      { platformMediaObjectId: mediaId, type: "gallery_image", sortOrder: 1 },
    ]);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "succeeded", attemptsCount: "1", idempotencyStatus: "completed" },
    ]);
    await expect(readAttemptRows()).resolves.toEqual([
      { attemptNumber: 1, status: "succeeded", errorType: null, retryAt: null },
    ]);
    await expect(readDeadLetterRows()).resolves.toEqual([]);
    await expect(
      mediaResolutionPort.resolvePublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [mediaId],
      }),
    ).resolves.toMatchObject({
      ok: true,
      batch: {
        media: [
          {
            mediaObjectId: mediaId,
            publicVariants: expect.arrayContaining([
              expect.objectContaining({ variantName: "original_safe" }),
            ]),
          },
        ],
      },
    });

    await expect(repository.replacePresentation(command)).resolves.toMatchObject({
      ok: true,
      response: { outcome: "idempotent_replay", profileRevision: 3 },
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    await expect(readPublicationRows()).resolves.toHaveLength(1);

    await expect(
      repository.replacePresentation({
        ...command,
        idempotencyKey: "integration-presentation-remove",
        audit: {
          ...command.audit,
          requestId: "request-integration-presentation-remove",
        },
        expectedProfileRevision: 3,
        assignments: [],
      }),
    ).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", profileRevision: 4, presentationAssignments: [] },
    });

    await expect(readProjectionMedia()).resolves.toEqual([]);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "succeeded", attemptsCount: "1", idempotencyStatus: "completed" },
    ]);
    await expect(
      admin.query<{
        visibility: string;
        lifecycleStatus: string;
        publicApproved: boolean;
        revision: string;
        assignmentCount: string;
      }>(
        `SELECT
           media.visibility,
           media.lifecycle_status AS "lifecycleStatus",
           media.public_approved AS "publicApproved",
           property.profile_revision::text AS revision,
           (SELECT count(*)::text FROM hotel_catalog.property_media assignment
            WHERE assignment.property_id = property.id) AS "assignmentCount"
         FROM platform.media_objects media
         JOIN hotel_catalog.properties property ON property.id = media.property_id
         WHERE media.id = $1::uuid`,
        [mediaId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          visibility: "public",
          lifecycleStatus: "active",
          publicApproved: true,
          revision: "4",
          assignmentCount: "0",
        },
      ],
    });
    const variants = await admin.query<{
      visibility: string;
      storageKey: string;
      publicUrl: string;
    }>(
      `SELECT visibility, storage_key AS "storageKey", public_cdn_url AS "publicUrl"
       FROM platform.media_variants
       WHERE media_object_id = $1::uuid`,
      [mediaId],
    );
    expect(variants.rows).toHaveLength(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    expect(
      variants.rows.every(
        ({ visibility, storageKey, publicUrl }) =>
          visibility === "public" &&
          storageKey.startsWith("public/media/") &&
          publicUrl.startsWith("https://cdn.example.test/media/"),
      ),
    ).toBe(true);

    await expect(
      repository.replacePresentation({
        ...command,
        idempotencyKey: "integration-presentation-reassign",
        audit: {
          ...command.audit,
          requestId: "request-integration-presentation-reassign",
        },
        expectedProfileRevision: 4,
      }),
    ).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", profileRevision: 5 },
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    await expect(readProjectionMedia()).resolves.toMatchObject([
      { platformMediaObjectId: mediaId, type: "hero_image", sortOrder: 0 },
      { platformMediaObjectId: mediaId, type: "gallery_image", sortOrder: 1 },
    ]);
  });

  it("keeps private state through backoff and resumes from the durable publication job", async () => {
    const command = presentationCommand("integration-copy-recovery");
    copyToPublic.mockRejectedValueOnce(new Error("S3 copy failed"));

    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    expect(deletePublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);

    await expect(readMediaState(mediaId)).resolves.toMatchObject({
      visibility: "private",
      lifecycleStatus: "staged",
      publicApproved: false,
      storageKey: expect.stringMatching(/^private\/media\//),
      privateVariantCount: "4",
      publicVariantCount: "0",
    });
    await expect(readAssignments()).resolves.toEqual([
      {
        mediaObjectId: previousMediaId,
        mediaType: "hero_image",
        altText: "Existing cover",
        sortOrder: 0,
      },
    ]);
    await expect(readAttemptRows()).resolves.toMatchObject([
      {
        attemptNumber: 1,
        status: "failed",
        errorType: "property_media_publication_retryable",
        retryAt: expect.any(Date),
      },
    ]);
    await expect(readProjectionMedia()).resolves.toMatchObject([
      { platformMediaObjectId: previousMediaId, type: "hero_image", sortOrder: 0 },
    ]);
    await expect(readPropertyRevision()).resolves.toBe(2);
    await expect(readPendingAssignmentCount()).resolves.toBe(2);
    await expect(readPublicationRows()).resolves.toMatchObject([
      {
        jobStatus: "pending",
        attemptsCount: "1",
        lockedBy: null,
        idempotencyStatus: "in_progress",
        publicationStatus: "pending",
        jobId: expect.any(String),
        idempotencyJobId: expect.any(String),
        lastError: "S3 copy failed",
      },
    ]);
    const pending = await readPublicationRows();
    expect(pending[0]?.idempotencyJobId).toBe(pending[0]?.jobId);

    await expect(
      repository.replacePresentation({
        ...command,
        idempotencyKey: "integration-copy-competing",
        audit: { ...command.audit, requestId: "request-integration-copy-competing" },
        expectedProfileRevision: 2,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "command_in_progress" } });
    await expect(readIdempotencyCount()).resolves.toBe(1);

    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "pending", attemptsCount: "1", idempotencyStatus: "in_progress" },
    ]);

    await admin.query(
      `UPDATE platform.jobs
       SET run_after = now() - interval '1 second'
       WHERE queue_name = $1
         AND job_type = $2
         AND property_id = $3::uuid`,
      [publicationQueue, publicationJobType, propertyId],
    );
    await expect(repository.runPublicationBatch()).resolves.toEqual({
      processed: 1,
      deferred: 0,
      deadLettered: 0,
    });
    await expect(repository.replacePresentation(command)).resolves.toMatchObject({
      ok: true,
      response: { outcome: "idempotent_replay", profileRevision: 3 },
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length * 2);
    await expect(readMediaState(mediaId)).resolves.toMatchObject({
      visibility: "public",
      lifecycleStatus: "active",
      publicApproved: true,
      storageKey: expect.stringMatching(/^public\/media\//),
      privateVariantCount: "0",
      publicVariantCount: "4",
    });
    await expect(readAssignments()).resolves.toMatchObject([
      { mediaObjectId: mediaId, mediaType: "hero_image", sortOrder: 0 },
      { mediaObjectId: mediaId, mediaType: "gallery_image", sortOrder: 1 },
    ]);
    await expect(readProjectionMedia()).resolves.toMatchObject([
      { platformMediaObjectId: mediaId, type: "hero_image", sortOrder: 0 },
      { platformMediaObjectId: mediaId, type: "gallery_image", sortOrder: 1 },
    ]);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "succeeded", attemptsCount: "2", idempotencyStatus: "completed" },
    ]);
    await expect(readAttemptRows()).resolves.toMatchObject([
      { attemptNumber: 1, status: "failed" },
      { attemptNumber: 2, status: "succeeded", retryAt: null },
    ]);
    await expect(readPropertyRevision()).resolves.toBe(3);
    await expect(readPendingAssignmentCount()).resolves.toBe(0);
  });

  it("dead-letters a corrupted job while completing its idempotent failure", async () => {
    const command = presentationCommand("integration-invalid-payload");
    copyToPublic.mockRejectedValueOnce(new Error("S3 copy failed"));

    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    await admin.query(
      `UPDATE platform.jobs
       SET payload = '{}'::jsonb, run_after = now() - interval '1 second'
       WHERE queue_name = $1
         AND job_type = $2
         AND property_id = $3::uuid`,
      [publicationQueue, publicationJobType, propertyId],
    );

    await expect(repository.runPublicationBatch()).resolves.toEqual({
      processed: 0,
      deferred: 0,
      deadLettered: 1,
    });
    expect(deletePublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length * 2);
    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "media_publication_failed" },
    });
    await expect(readPublicationRows()).resolves.toMatchObject([
      {
        jobStatus: "dead_lettered",
        attemptsCount: "2",
        idempotencyStatus: "completed",
        lastError: "Invalid property media publication envelope",
      },
    ]);
    await expect(readAttemptRows()).resolves.toMatchObject([
      { attemptNumber: 1, status: "failed" },
      { attemptNumber: 2, status: "failed", errorType: "invalid_publication_envelope" },
    ]);
    await expect(readDeadLetterRows()).resolves.toEqual([
      {
        reasonCode: "non_retryable_error",
        replayEligible: "false",
        attemptCount: "2",
      },
    ]);
    await expect(readPropertyRevision()).resolves.toBe(3);
    await expect(readPendingAssignmentCount()).resolves.toBe(0);
    await expect(readMediaState(mediaId)).resolves.toMatchObject({
      visibility: "private",
      lifecycleStatus: "staged",
      publicApproved: false,
    });
    await expect(readAssignments()).resolves.toEqual([
      expect.objectContaining({ mediaObjectId: previousMediaId, mediaType: "hero_image" }),
    ]);
    await expect(
      admin.query<{ actorType: string; reason: string }>(
        `SELECT actor_type AS "actorType",
                audit_metadata ->> 'reason' AS reason
         FROM platform.product_audit_events
         WHERE property_id = $1::uuid
           AND action = 'property.media.command.rejected'
           AND actor_type = 'system'`,
        [propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [{ actorType: "system", reason: "invalid_publication_envelope" }],
    });
  });

  it("finishes durable public-object cleanup before retrying publication", async () => {
    const command = presentationCommand("integration-durable-cleanup");
    copyToPublic.mockRejectedValueOnce(new Error("S3 copy failed"));
    for (let index = 0; index < PROPERTY_MEDIA_PUBLIC_VARIANTS.length; index += 1) {
      deletePublic.mockRejectedValueOnce(new Error("S3 delete failed"));
    }

    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    expect(deletePublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "pending", attemptsCount: "1", cleanupRequired: "true" },
    ]);

    await makePublicationDue();
    await expect(repository.runPublicationBatch({ limit: 1 })).resolves.toEqual({
      processed: 0,
      deferred: 1,
      deadLettered: 0,
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    expect(deletePublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length * 2);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "pending", attemptsCount: "1", cleanupRequired: "false" },
    ]);
    await expect(readAttemptRows()).resolves.toMatchObject([
      { attemptNumber: 1, status: "failed" },
    ]);

    await makePublicationDue();
    await expect(repository.runPublicationBatch({ limit: 1 })).resolves.toEqual({
      processed: 1,
      deferred: 0,
      deadLettered: 0,
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length * 2);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "succeeded", attemptsCount: "2", idempotencyStatus: "completed" },
    ]);
    await expect(readAttemptRows()).resolves.toMatchObject([
      { attemptNumber: 1, status: "failed" },
      { attemptNumber: 2, status: "succeeded" },
    ]);
  });

  it("dead-letters a publication whose idempotency fence disappears", async () => {
    const command = presentationCommand("integration-missing-fence");
    copyToPublic.mockRejectedValueOnce(new Error("S3 copy failed"));
    for (let index = 0; index < PROPERTY_MEDIA_PUBLIC_VARIANTS.length; index += 1) {
      deletePublic.mockRejectedValueOnce(new Error("S3 delete failed"));
    }

    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    await admin.query(
      `UPDATE platform.idempotency_keys
       SET idempotency_metadata = '{}'::jsonb
       WHERE property_id = $1::uuid
         AND operation = $2`,
      [propertyId, "hotel_catalog.property_media.presentation.replace"],
    );
    await makePublicationDue();

    await expect(repository.runPublicationBatch({ limit: 1 })).resolves.toEqual({
      processed: 0,
      deferred: 0,
      deadLettered: 1,
    });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    expect(deletePublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length * 2);
    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "media_publication_failed" },
    });
    await expect(readPublicationRows()).resolves.toMatchObject([
      {
        jobStatus: "dead_lettered",
        attemptsCount: "2",
        lastError: "Property media publication lost its idempotency fence",
        idempotencyStatus: "completed",
        cleanupRequired: "true",
      },
    ]);
    await expect(readAttemptRows()).resolves.toMatchObject([
      { attemptNumber: 1, status: "failed" },
      {
        attemptNumber: 2,
        status: "failed",
        errorType: "missing_publication_idempotency_fence",
      },
    ]);
    await expect(readPendingAssignmentCount()).resolves.toBe(0);
  });

  it("times out and cleans a running publication whose idempotency fence disappears", async () => {
    const command = presentationCommand("integration-running-missing-fence");
    const publicObjects = new Set<string>();
    let releaseCopies!: () => void;
    const copiesReleased = new Promise<void>((resolve) => {
      releaseCopies = resolve;
    });
    copyToPublic.mockImplementation(async ({ publicStorageKey }) => {
      await copiesReleased;
      publicObjects.add(publicStorageKey);
    });
    deletePublic.mockImplementation(async ({ publicStorageKey }) => {
      publicObjects.delete(publicStorageKey);
    });

    const staleWorker = repository.replacePresentation(command);
    await waitForPublicationStatus("running");
    await admin.query(
      `UPDATE platform.idempotency_keys
       SET idempotency_metadata = '{}'::jsonb
       WHERE property_id = $1::uuid
         AND operation = $2`,
      [propertyId, "hotel_catalog.property_media.presentation.replace"],
    );
    await admin.query(
      `UPDATE platform.jobs
       SET locked_at = now() - interval '16 minutes'
       WHERE queue_name = $1
         AND job_type = $2
         AND property_id = $3::uuid`,
      [publicationQueue, publicationJobType, propertyId],
    );

    await expect(repository.runPublicationBatch({ limit: 1 })).resolves.toEqual({
      processed: 0,
      deferred: 0,
      deadLettered: 1,
    });
    await expect(readAttemptRows()).resolves.toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        status: "timed_out",
        errorType: "property_media_publication_lease_expired",
      }),
      expect.objectContaining({
        attemptNumber: 2,
        status: "failed",
        errorType: "missing_publication_idempotency_fence",
      }),
    ]);

    releaseCopies();
    await expect(staleWorker).resolves.toEqual({
      ok: false,
      error: { code: "media_publication_failed" },
    });
    expect(publicObjects).toEqual(new Set());
    expect(deletePublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length * 2);
    await expect(readPendingAssignmentCount()).resolves.toBe(0);
  });

  it("cleans an expired final attempt before dead-lettering and fences the stale worker", async () => {
    const command = presentationCommand("integration-expired-final-attempt");
    const publicObjects = new Set<string>();
    deletePublic.mockImplementation(async ({ publicStorageKey }) => {
      publicObjects.delete(publicStorageKey);
    });
    copyToPublic.mockRejectedValueOnce(new Error("S3 copy failed"));
    await expect(repository.replacePresentation(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    await admin.query(
      `UPDATE platform.jobs
       SET attempts_count = max_attempts - 1,
           run_after = now() - interval '1 second'
       WHERE queue_name = $1
         AND job_type = $2
         AND property_id = $3::uuid`,
      [publicationQueue, publicationJobType, propertyId],
    );

    let releaseCopies!: () => void;
    const copiesReleased = new Promise<void>((resolve) => {
      releaseCopies = resolve;
    });
    copyToPublic.mockImplementation(async ({ publicStorageKey }) => {
      await copiesReleased;
      publicObjects.add(publicStorageKey);
    });
    const staleWorker = repository.runPublicationBatch({ limit: 1 });
    await waitForPublicationStatus("running");
    await admin.query(
      `UPDATE platform.jobs
       SET locked_at = now() - interval '16 minutes'
       WHERE queue_name = $1
         AND job_type = $2
         AND property_id = $3::uuid`,
      [publicationQueue, publicationJobType, propertyId],
    );
    const deletesBeforeRecovery = deletePublic.mock.calls.length;

    await expect(repository.runPublicationBatch({ limit: 1 })).resolves.toEqual({
      processed: 0,
      deferred: 0,
      deadLettered: 1,
    });
    expect(deletePublic).toHaveBeenCalledTimes(
      deletesBeforeRecovery + PROPERTY_MEDIA_PUBLIC_VARIANTS.length,
    );
    await expect(readAttemptRows()).resolves.toEqual([
      expect.objectContaining({ attemptNumber: 1, status: "failed" }),
      expect.objectContaining({
        attemptNumber: 8,
        status: "timed_out",
        errorType: "property_media_publication_lease_expired",
      }),
    ]);

    releaseCopies();
    await expect(staleWorker).resolves.toEqual({ processed: 0, deferred: 0, deadLettered: 0 });
    expect(deletePublic).toHaveBeenCalledTimes(
      deletesBeforeRecovery + PROPERTY_MEDIA_PUBLIC_VARIANTS.length * 2,
    );
    expect(publicObjects).toEqual(new Set());
    await expect(readPublicationRows()).resolves.toMatchObject([
      {
        jobStatus: "dead_lettered",
        attemptsCount: "8",
        idempotencyStatus: "completed",
        cleanupRequired: "true",
        cleanupPassesRemaining: "3",
      },
    ]);
    await expect(readPendingAssignmentCount()).resolves.toBe(0);

    const copiedKeys = copyToPublic.mock.calls
      .slice(-PROPERTY_MEDIA_PUBLIC_VARIANTS.length)
      .map(([input]) => input.publicStorageKey);
    for (let pass = 2; pass >= 0; pass -= 1) {
      copiedKeys.forEach((key) => publicObjects.add(key));
      await makePublicationDue();
      await expect(repository.runPublicationBatch({ limit: 1 })).resolves.toEqual({
        processed: 0,
        deferred: 0,
        deadLettered: 0,
      });
      expect(publicObjects).toEqual(new Set());
      await expect(readPublicationRows()).resolves.toMatchObject([
        {
          cleanupRequired: pass > 0 ? "true" : "false",
          cleanupPassesRemaining: String(pass),
        },
      ]);
    }
  });

  it("fences simultaneous same-key and competing-key commands while publication is running", async () => {
    const command = presentationCommand("integration-running-fence");
    let releaseCopies!: () => void;
    const copiesReleased = new Promise<void>((resolve) => {
      releaseCopies = resolve;
    });
    copyToPublic.mockImplementation(() => copiesReleased);

    const first = repository.replacePresentation(command);
    let sameKey;
    let competingKey;
    try {
      await waitForPublicationStatus("running");
      [sameKey, competingKey] = await Promise.all([
        repository.replacePresentation(command),
        repository.replacePresentation({
          ...command,
          idempotencyKey: "integration-running-competing",
          audit: { ...command.audit, requestId: "request-integration-running-competing" },
          expectedProfileRevision: 2,
        }),
      ]);
    } finally {
      releaseCopies();
    }

    await expect(first).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", profileRevision: 3 },
    });
    expect(sameKey).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(competingKey).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(copyToPublic).toHaveBeenCalledTimes(PROPERTY_MEDIA_PUBLIC_VARIANTS.length);
    await expect(readIdempotencyCount()).resolves.toBe(1);
    await expect(readPropertyRevision()).resolves.toBe(3);
    await expect(readPublicationRows()).resolves.toMatchObject([
      { jobStatus: "succeeded", attemptsCount: "1", idempotencyStatus: "completed" },
    ]);
  });

  async function seedFixture(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name)
       VALUES ($1::uuid, 'property-media-command@example.test', 'Property Media Command')`,
      [userId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES ($1::uuid, 'hotel_group', 'Property Media Command', 'property-media-command')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'property-media-command', 'Property Media Command')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, 'property-media-command', 'canonical', 'active')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await insertMediaObject(mediaId, "private");
    await insertMediaObject(previousMediaId, "public");
    await admin.query(
      `INSERT INTO hotel_catalog.property_media (
         property_id, media_type, url, alt_text, sort_order, source_system,
         public_approved, rights_metadata, platform_media_object_id
       ) VALUES (
         $1::uuid, 'hero_image', $2, 'Existing cover', 0, 'platform', TRUE,
         jsonb_build_object('platformMediaObjectId', $3::text), $3::uuid
       )`,
      [propertyId, publicUrl(previousMediaId, "original_safe"), previousMediaId],
    );
    await admin.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [propertyId]);
  }

  async function insertMediaObject(
    objectId: string,
    visibility: "private" | "public",
  ): Promise<void> {
    const originalSafe = variantFixture(objectId, "original_safe", visibility);
    await admin.query(
      `INSERT INTO platform.media_objects (
         id, bucket, storage_key, storage_kind, visibility, purpose,
         owner_organization_id, property_id, resource_product, resource_type,
         resource_id, lifecycle_status, content_type, width_px, height_px,
         size_bytes, checksum_sha256, public_approved, created_by_user_id
       ) VALUES (
         $1::uuid, $2, $3, 'vayada_managed', $4, 'property.gallery_image',
         $5::uuid, $6::uuid, 'hotel_catalog', 'property', $6,
         $7, $8, $9, $10, $11, $12, $13, $14::uuid
       )`,
      [
        objectId,
        serving.bucketName,
        originalSafe.storageKey,
        visibility,
        organizationId,
        propertyId,
        visibility === "private" ? "staged" : "active",
        originalSafe.contentType,
        originalSafe.widthPx,
        originalSafe.heightPx,
        originalSafe.sizeBytes,
        originalSafe.checksumSha256,
        visibility === "public",
        userId,
      ],
    );
    for (const variantName of PROPERTY_MEDIA_PUBLIC_VARIANTS) {
      const variant = variantFixture(objectId, variantName, visibility);
      await admin.query(
        `INSERT INTO platform.media_variants (
           media_object_id, variant_name, visibility, storage_key, content_type,
           width_px, height_px, size_bytes, checksum_sha256, public_cdn_url
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          objectId,
          variant.variantName,
          visibility,
          variant.storageKey,
          variant.contentType,
          variant.widthPx,
          variant.heightPx,
          variant.sizeBytes,
          variant.checksumSha256,
          variant.publicCdnUrl,
        ],
      );
    }
  }

  async function readProjectionMedia(): Promise<
    Array<{ platformMediaObjectId: string; type: string; sortOrder: number }>
  > {
    const result = await admin.query<{
      media: Array<{ platformMediaObjectId: string; type: string; sortOrder: number }>;
    }>(
      `SELECT media
       FROM hotel_catalog.property_public_profile_read_model
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0]?.media ?? [];
  }

  async function readAssignments(): Promise<
    Array<{
      mediaObjectId: string;
      mediaType: string;
      altText: string | null;
      sortOrder: number;
    }>
  > {
    const result = await admin.query<{
      mediaObjectId: string;
      mediaType: string;
      altText: string | null;
      sortOrder: number;
    }>(
      `SELECT platform_media_object_id::text AS "mediaObjectId",
              media_type AS "mediaType", alt_text AS "altText", sort_order AS "sortOrder"
       FROM hotel_catalog.property_media
       WHERE property_id = $1::uuid
         AND public_approved = TRUE
       ORDER BY CASE media_type WHEN 'logo' THEN 0 WHEN 'hero_image' THEN 1 ELSE 2 END,
                sort_order, id`,
      [propertyId],
    );
    return result.rows;
  }

  async function readPendingAssignmentCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM hotel_catalog.property_media
       WHERE property_id = $1::uuid
         AND source_system = 'platform'
         AND public_approved = FALSE
         AND rights_metadata ->> 'publicationState' = 'pending'`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function readMediaState(objectId: string) {
    const result = await admin.query<{
      visibility: string;
      lifecycleStatus: string;
      publicApproved: boolean;
      storageKey: string;
      privateVariantCount: string;
      publicVariantCount: string;
    }>(
      `SELECT media.visibility,
              media.lifecycle_status AS "lifecycleStatus",
              media.public_approved AS "publicApproved",
              media.storage_key AS "storageKey",
              count(*) FILTER (WHERE variant.visibility = 'private')::text AS "privateVariantCount",
              count(*) FILTER (WHERE variant.visibility = 'public')::text AS "publicVariantCount"
       FROM platform.media_objects media
       JOIN platform.media_variants variant ON variant.media_object_id = media.id
       WHERE media.id = $1::uuid
       GROUP BY media.id`,
      [objectId],
    );
    return result.rows[0];
  }

  async function readPublicationRows() {
    const result = await admin.query<{
      jobId: string;
      jobStatus: string;
      attemptsCount: string;
      lockedBy: string | null;
      lastError: string | null;
      cleanupRequired: string | null;
      cleanupPassesRemaining: string | null;
      idempotencyStatus: string;
      publicationStatus: string | null;
      idempotencyJobId: string | null;
    }>(
      `SELECT job.id::text AS "jobId",
              job.status AS "jobStatus",
              job.attempts_count::text AS "attemptsCount",
              job.locked_by AS "lockedBy",
              job.job_metadata ->> 'lastError' AS "lastError",
              job.job_metadata ->> 'cleanupRequired' AS "cleanupRequired",
              job.job_metadata ->> 'cleanupPassesRemaining' AS "cleanupPassesRemaining",
              idempotency.status AS "idempotencyStatus",
              idempotency.idempotency_metadata #>> '{publication,status}' AS "publicationStatus",
              idempotency.idempotency_metadata #>> '{publication,jobId}' AS "idempotencyJobId"
       FROM platform.jobs job
       JOIN platform.idempotency_keys idempotency
         ON idempotency.property_id = job.property_id
        AND idempotency.key_hash = job.idempotency_key_hash
       WHERE job.queue_name = $1
         AND job.job_type = $2
         AND job.property_id = $3::uuid
       ORDER BY job.created_at, job.id`,
      [publicationQueue, publicationJobType, propertyId],
    );
    return result.rows;
  }

  async function readAttemptRows() {
    const result = await admin.query<{
      attemptNumber: number;
      status: string;
      errorType: string | null;
      retryAt: Date | null;
    }>(
      `SELECT attempt.attempt_number AS "attemptNumber",
              attempt.status,
              attempt.error_type AS "errorType",
              attempt.retry_after AS "retryAt"
       FROM platform.job_attempts attempt
       JOIN platform.jobs job ON job.id = attempt.job_id
       WHERE job.queue_name = $1
         AND job.job_type = $2
         AND job.property_id = $3::uuid
       ORDER BY attempt.attempt_number`,
      [publicationQueue, publicationJobType, propertyId],
    );
    return result.rows;
  }

  async function readDeadLetterRows() {
    const result = await admin.query<{
      reasonCode: string;
      replayEligible: string;
      attemptCount: string;
    }>(
      `SELECT dead_letter.reason_code AS "reasonCode",
              dead_letter.failure_payload ->> 'replayEligible' AS "replayEligible",
              dead_letter.failure_payload ->> 'attemptCount' AS "attemptCount"
       FROM platform.dead_letter_events dead_letter
       JOIN platform.jobs job ON job.id = dead_letter.job_id
       WHERE job.queue_name = $1
         AND job.job_type = $2
         AND job.property_id = $3::uuid
       ORDER BY dead_letter.created_at, dead_letter.id`,
      [publicationQueue, publicationJobType, propertyId],
    );
    return result.rows;
  }

  async function readIdempotencyCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM platform.idempotency_keys
       WHERE operation_scope = 'hotel_catalog'
         AND property_id = $1::uuid`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function makePublicationDue(): Promise<void> {
    await admin.query(
      `UPDATE platform.jobs
       SET run_after = now() - interval '1 second'
       WHERE queue_name = $1
         AND job_type = $2
         AND property_id = $3::uuid`,
      [publicationQueue, publicationJobType, propertyId],
    );
  }

  async function readPropertyRevision(): Promise<number> {
    const result = await admin.query<{ revision: string }>(
      `SELECT profile_revision::text AS revision
       FROM hotel_catalog.properties
       WHERE id = $1::uuid`,
      [propertyId],
    );
    return Number(result.rows[0]?.revision ?? 0);
  }

  async function waitForPublicationStatus(expected: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await readPublicationRows();
      if (rows[0]?.jobStatus === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Property media publication did not reach ${expected}`);
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `DELETE FROM platform.dead_letter_events
         WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = $1::uuid)
            OR requeued_job_id IN (SELECT id FROM platform.jobs WHERE property_id = $1::uuid)`,
        [propertyId],
      );
      await admin.query(
        `DELETE FROM platform.job_attempts
         WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = $1::uuid)`,
        [propertyId],
      );
      await admin.query("DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.jobs WHERE property_id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM hotel_catalog.property_media WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        "DELETE FROM platform.media_variants WHERE media_object_id = ANY($1::uuid[])",
        [[mediaId, previousMediaId]],
      );
      await admin.query("DELETE FROM platform.media_objects WHERE id = ANY($1::uuid[])", [
        [mediaId, previousMediaId],
      ]);
      await admin.query(
        `DELETE FROM identity.organization_resource_links
         WHERE organization_id = $1::uuid AND resource_id = $2`,
        [organizationId, propertyId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [userId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function presentationCommand(idempotencyKey: string) {
  return {
    organizationId,
    propertyId,
    actorUserId: userId,
    idempotencyKey,
    audit: {
      requestId: `request-${idempotencyKey}`,
      correlationId: `correlation-${idempotencyKey}`,
      source: "api" as const,
      receivedAt: "2026-08-01T12:00:00.000Z",
    },
    expectedProfileRevision: 1,
    assignments: [
      { mediaObjectId: mediaId, role: "cover" as const, altText: null, sortOrder: 0 },
      { mediaObjectId: mediaId, role: "gallery" as const, altText: "Lobby", sortOrder: 1 },
    ],
  };
}

function variantFixture(
  objectId: string,
  variantName: (typeof PROPERTY_MEDIA_PUBLIC_VARIANTS)[number],
  visibility: "private" | "public",
) {
  const dimensions = {
    original_safe: { widthPx: 1200, heightPx: 800, sizeBytes: 900 },
    large: { widthPx: 1080, heightPx: 720, sizeBytes: 800 },
    thumbnail: { widthPx: 270, heightPx: 180, sizeBytes: 300 },
    blur_preview: { widthPx: 27, heightPx: 18, sizeBytes: 50 },
  } as const;
  const checksumSha256 = variantChecksum(objectId, variantName);
  return {
    variantName,
    visibility,
    storageKey: `${visibility}/media/${objectId}/${variantName}/sha256-${checksumSha256}.webp`,
    contentType: "image/webp",
    ...dimensions[variantName],
    checksumSha256,
    publicCdnUrl: visibility === "public" ? publicUrl(objectId, variantName) : null,
  };
}

function publicUrl(
  objectId: string,
  variantName: (typeof PROPERTY_MEDIA_PUBLIC_VARIANTS)[number],
): string {
  return `${serving.cdnBaseUrl}/media/${objectId}/${variantName}/sha256-${variantChecksum(
    objectId,
    variantName,
  )}.webp`;
}

function variantChecksum(objectId: string, variantName: string): string {
  return createHash("sha256").update(`${objectId}:${variantName}`).digest("hex");
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
