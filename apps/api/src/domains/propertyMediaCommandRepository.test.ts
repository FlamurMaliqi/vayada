import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import {
  createPgS3PropertyMediaCommandRepository,
  type PropertyMediaVariantPublisher,
} from "./propertyMediaCommandRepository.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actorUserId = "22222222-2222-4222-8222-222222222222";
const mediaId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const galleryMediaId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const idempotencyId = "33333333-3333-4333-8333-333333333333";
const publicationJobId = "44444444-4444-4444-8444-444444444444";
const serving: PlatformMediaServingConfig = {
  bucketName: "vayada-media",
  cdnBaseUrl: "https://cdn.vayada.example",
  cdnOriginHost: "vayada-media.s3.example",
  publicPathPrefix: "media",
  publicCacheControl: "public, max-age=31536000, immutable",
  privateDownloadTtlSeconds: 300,
  privateDownloadMaxTtlSeconds: 900,
};

describe("property media command repository", () => {
  it("publishes only a hero upload for the unique current owner and preserves gallery media", async () => {
    const hero = mediaRow("private", mediaId, "property.hero_image");
    const gallery = mediaRow("public", galleryMediaId, "property.gallery_image");
    const harness = fakeDatabase({
      media: [hero, gallery],
      assignments: [assignment(galleryMediaId, "gallery_image", "Pool", 0)],
    });
    const repository = createRepository(harness, fakePublisher());
    const command = {
      ...platformAdminCommand("admin-hero"),
      expectedProfileRevision: 1,
      mediaObjectId: mediaId,
    };

    const result = await repository.replacePlatformAdminHero(command);

    expect(result).toMatchObject({
      ok: true,
      response: {
        profileRevision: 3,
        presentationAssignments: [
          { mediaObjectId: mediaId, role: "cover", sortOrder: 0 },
          { mediaObjectId: galleryMediaId, role: "gallery", sortOrder: 1 },
        ],
      },
    });
    expect(harness.state.assignments).toEqual([
      assignment(galleryMediaId, "gallery_image", "Pool", 0),
      assignment(mediaId, "hero_image", null, 0),
    ]);
    expect(harness.sql()).toContain("owner.relationship = 'owner'");
    harness.state.assignments[0]!.altText = "Pool changed elsewhere";
    await expect(repository.replacePlatformAdminHero(command)).resolves.toMatchObject({
      ok: true,
      response: { outcome: "idempotent_replay" },
    });
  });

  it("clears only the hero and leaves the persisted gallery order unchanged", async () => {
    const harness = fakeDatabase({
      assignments: [
        assignment(mediaId, "hero_image", null, 0),
        assignment(galleryMediaId, "gallery_image", "Pool", 1),
      ],
    });
    const repository = createRepository(harness, fakePublisher());

    const result = await repository.replacePlatformAdminHero({
      ...platformAdminCommand("clear-admin-hero"),
      expectedProfileRevision: 1,
      mediaObjectId: null,
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        profileRevision: 2,
        presentationAssignments: [{ mediaObjectId: galleryMediaId, role: "gallery", sortOrder: 0 }],
      },
    });
    expect(harness.state.assignments).toEqual([
      assignment(galleryMediaId, "gallery_image", "Pool", 1),
    ]);
  });

  it("rejects a non-hero media purpose from the Platform Admin hero command", async () => {
    const harness = fakeDatabase({ media: [mediaRow("private")] });
    const publisher = fakePublisher();
    const repository = createRepository(harness, publisher);

    const result = await repository.replacePlatformAdminHero({
      ...platformAdminCommand("admin-gallery-as-hero"),
      expectedProfileRevision: 1,
      mediaObjectId: mediaId,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "media_not_found", mediaObjectIds: [mediaId] },
    });
    expect(publisher.copyToPublic).not.toHaveBeenCalled();
    expect(harness.state.assignments).toEqual([]);
  });

  it("stops publication when the unique property owner changes after command acceptance", async () => {
    const harness = fakeDatabase({
      media: [mediaRow("private", mediaId, "property.hero_image")],
      ownerOrganizationIdsByLock: [[organizationId], ["77777777-7777-4777-8777-777777777777"]],
    });
    const publisher = fakePublisher();
    const repository = createRepository(harness, publisher);

    const result = await repository.replacePlatformAdminHero({
      ...platformAdminCommand("owner-change"),
      expectedProfileRevision: 1,
      mediaObjectId: mediaId,
    });

    expect(result).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(publisher.copyToPublic).not.toHaveBeenCalled();
    expect(harness.state.assignments).toEqual([]);
  });

  it("accepts, publishes, and finalizes one asset in multiple presentation roles", async () => {
    const harness = fakeDatabase({ media: [mediaRow("private")] });
    const publisher = fakePublisher();
    vi.mocked(publisher.copyToPublic).mockImplementation(async () => {
      expect(harness.state.profileRevision).toBe(2);
      expect(harness.state.pendingAssignments).toHaveLength(2);
      expect(harness.state.media[0]?.visibility).toBe("private");
    });
    const repository = createRepository(harness, publisher);

    const result = await repository.replacePresentation({
      ...baseCommand("presentation-command"),
      expectedProfileRevision: 1,
      assignments: [
        { mediaObjectId: mediaId, role: "cover", altText: null, sortOrder: 0 },
        { mediaObjectId: mediaId, role: "gallery", altText: "Lobby", sortOrder: 1 },
      ],
    });

    expect(result).toEqual({
      ok: true,
      response: {
        outcome: "updated",
        profileRevision: 3,
        logoAssignment: null,
        presentationAssignments: [
          { mediaObjectId: mediaId, role: "cover", altText: null, sortOrder: 0 },
          { mediaObjectId: mediaId, role: "gallery", altText: "Lobby", sortOrder: 1 },
        ],
      },
    });
    expect(publisher.copyToPublic).toHaveBeenCalledTimes(4);
    expect(publisher.copyToPublic).toHaveBeenCalledWith(
      expect.objectContaining({
        privateStorageKey: expect.stringMatching(/^private\/media\//),
        publicStorageKey: expect.stringMatching(/^public\/media\//),
      }),
    );
    expect(harness.state.jobs).toHaveLength(1);
    expect(harness.state.jobs[0]).toMatchObject({
      id: publicationJobId,
      status: "succeeded",
      attemptsCount: 1,
    });
    expect(harness.state.media[0]).toMatchObject({
      visibility: "public",
      lifecycleStatus: "active",
      publicApproved: true,
    });
    expect(harness.state.assignments).toEqual([
      { mediaObjectId: mediaId, mediaType: "hero_image", altText: null, sortOrder: 0 },
      { mediaObjectId: mediaId, mediaType: "gallery_image", altText: "Lobby", sortOrder: 1 },
    ]);
    expect(harness.state.profileRevision).toBe(3);
    expect(harness.sql()).toContain("INSERT INTO platform.jobs");
    expect(harness.sql()).toContain("FOR UPDATE OF job, idempotency");
    expect(harness.sql().indexOf("INSERT INTO platform.jobs")).toBeLessThan(
      harness.sql().indexOf("UPDATE platform.media_objects"),
    );
    expect(
      harness.commands.filter((command) => command === "COMMIT").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps old assignments and registry private when copying fails", async () => {
    const oldAssignment: AssignmentState = {
      mediaObjectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      mediaType: "logo",
      altText: "Old logo",
      sortOrder: 0,
    };
    const harness = fakeDatabase({
      media: [mediaRow("private")],
      assignments: [oldAssignment],
    });
    const publisher: PropertyMediaVariantPublisher = {
      copyToPublic: vi.fn(async ({ privateStorageKey }) => {
        if (privateStorageKey.includes("/large/")) throw new Error("S3 copy failed");
      }),
      deletePublic: vi.fn(async () => undefined),
    };
    const repository = createRepository(harness, publisher);

    const result = await repository.assignLogo({
      ...baseCommand("copy-failure"),
      expectedProfileRevision: 1,
      assignment: { mediaObjectId: mediaId, role: "logo", altText: null, sortOrder: 0 },
    });

    expect(result).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(publisher.copyToPublic).toHaveBeenCalledTimes(4);
    expect(harness.state.assignments).toEqual([oldAssignment]);
    expect(harness.state.pendingAssignments).toEqual([
      { mediaObjectId: mediaId, mediaType: "logo", altText: null, sortOrder: 0 },
    ]);
    expect(harness.state.profileRevision).toBe(2);
    expect(harness.state.media[0]).toMatchObject({
      visibility: "private",
      lifecycleStatus: "staged",
      publicApproved: false,
    });
    expect(
      harness.state.media[0]!.variants.every(({ visibility }) => visibility === "private"),
    ).toBe(true);
    expect(harness.state.jobs[0]).toMatchObject({ status: "pending", attemptsCount: 1 });
    expect(harness.assignmentMutationCount()).toBe(1);
    expect(harness.registryMutationCount()).toBe(0);
    expect(harness.sql()).toContain("media.public_approved = FALSE");
  });

  it("respects retry backoff before resuming the same pending publication", async () => {
    const harness = fakeDatabase({ media: [mediaRow("private")] });
    const publisher: PropertyMediaVariantPublisher = {
      copyToPublic: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient S3 failure"))
        .mockResolvedValue(undefined),
      deletePublic: vi.fn(async () => undefined),
    };
    let clock = new Date("2026-08-01T12:00:00.000Z");
    const repository = createRepository(harness, publisher, { now: () => clock });
    const command = {
      ...baseCommand("resume-logo"),
      expectedProfileRevision: 1,
      assignment: {
        mediaObjectId: mediaId,
        role: "logo" as const,
        altText: "Hotel logo",
        sortOrder: 0 as const,
      },
    };

    const first = await repository.assignLogo(command);
    const second = await repository.assignLogo(command);

    expect(first).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(second).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(harness.state.jobs[0]).toMatchObject({ status: "pending", attemptsCount: 1 });
    expect(publisher.copyToPublic).toHaveBeenCalledTimes(4);

    clock = new Date(clock.getTime() + 30_000);
    await expect(repository.runPublicationBatch()).resolves.toEqual({
      processed: 1,
      deferred: 0,
      deadLettered: 0,
    });
    const replay = await repository.assignLogo(command);

    expect(replay).toMatchObject({
      ok: true,
      response: { outcome: "idempotent_replay", profileRevision: 3 },
    });
    expect(harness.state.jobs).toHaveLength(1);
    expect(harness.state.idempotency).toHaveLength(1);
    expect(harness.state.jobs[0]).toMatchObject({ status: "succeeded", attemptsCount: 2 });
    expect(harness.state.assignments).toEqual([
      { mediaObjectId: mediaId, mediaType: "logo", altText: "Hotel logo", sortOrder: 0 },
    ]);
    expect(harness.state.pendingAssignments).toEqual([]);
    expect(publisher.copyToPublic).toHaveBeenCalledTimes(8);
  });

  it("uses the active property job as a fence against a competing key", async () => {
    const harness = fakeDatabase({ media: [mediaRow("private")] });
    const publisher: PropertyMediaVariantPublisher = {
      copyToPublic: vi.fn(async () => {
        throw new Error("S3 unavailable");
      }),
      deletePublic: vi.fn(async () => undefined),
    };
    const repository = createRepository(harness, publisher);

    const first = await repository.assignLogo({
      ...baseCommand("first-key"),
      expectedProfileRevision: 1,
      assignment: { mediaObjectId: mediaId, role: "logo", altText: null, sortOrder: 0 },
    });
    const copyCountAfterFirst = vi.mocked(publisher.copyToPublic).mock.calls.length;
    const competing = await repository.assignLogo({
      ...baseCommand("competing-key"),
      expectedProfileRevision: 2,
      assignment: { mediaObjectId: mediaId, role: "logo", altText: "Other", sortOrder: 0 },
    });

    expect(first).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(competing).toEqual({ ok: false, error: { code: "command_in_progress" } });
    expect(publisher.copyToPublic).toHaveBeenCalledTimes(copyCountAfterFirst);
    expect(harness.state.jobs).toHaveLength(1);
    expect(harness.state.idempotency).toHaveLength(1);
    expect(harness.state.assignments).toEqual([]);
  });

  it("rejects an object whose mirrored original-safe metadata changed", async () => {
    const mismatched = mediaRow("private");
    mismatched.checksumSha256 = "b".repeat(64);
    const harness = fakeDatabase({ media: [mismatched] });
    const publisher = fakePublisher();
    const repository = createRepository(harness, publisher);

    const result = await repository.assignLogo({
      ...baseCommand("mirror-mismatch"),
      expectedProfileRevision: 1,
      assignment: { mediaObjectId: mediaId, role: "logo", altText: null, sortOrder: 0 },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "media_not_ready", mediaObjectIds: [mediaId] },
    });
    expect(publisher.copyToPublic).not.toHaveBeenCalled();
    expect(harness.state.jobs).toEqual([]);
    expect(harness.registryMutationCount()).toBe(0);
  });

  it("makes a cross-property media id indistinguishable from a missing id", async () => {
    const harness = fakeDatabase({
      media: [{ ...mediaRow("private"), propertyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }],
    });
    const publisher = fakePublisher();
    const repository = createRepository(harness, publisher);

    const result = await repository.assignLogo({
      ...baseCommand("cross-property"),
      expectedProfileRevision: 1,
      assignment: { mediaObjectId: mediaId, role: "logo", altText: null, sortOrder: 0 },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "media_not_found", mediaObjectIds: [mediaId] },
    });
    expect(publisher.copyToPublic).not.toHaveBeenCalled();
    expect(harness.state.jobs).toEqual([]);
    expect(harness.registryMutationCount()).toBe(0);
  });

  it("replays a completed command without copying or mutating again", async () => {
    const harness = fakeDatabase({ media: [mediaRow("private")] });
    const publisher = fakePublisher();
    const repository = createRepository(harness, publisher);
    const command = {
      ...baseCommand("replay-logo"),
      expectedProfileRevision: 1,
      assignment: {
        mediaObjectId: mediaId,
        role: "logo" as const,
        altText: null,
        sortOrder: 0 as const,
      },
    };

    const first = await repository.assignLogo(command);
    const mutationsAfterFirst = {
      assignment: harness.assignmentMutationCount(),
      registry: harness.registryMutationCount(),
      queries: harness.queries.length,
    };
    const second = await repository.assignLogo(command);

    expect(first).toMatchObject({ ok: true, response: { outcome: "updated" } });
    expect(second).toMatchObject({ ok: true, response: { outcome: "idempotent_replay" } });
    expect(publisher.copyToPublic).toHaveBeenCalledTimes(4);
    expect(harness.assignmentMutationCount()).toBe(mutationsAfterFirst.assignment);
    expect(harness.registryMutationCount()).toBe(mutationsAfterFirst.registry);
    expect(harness.queries.slice(mutationsAfterFirst.queries)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^INSERT INTO platform\.jobs/),
        expect.stringMatching(/^DELETE FROM hotel_catalog\.property_media/),
        expect.stringMatching(/^UPDATE platform\.media_objects/),
      ]),
    );
  });

  it("checks the expected revision before resolving media or creating a job", async () => {
    const harness = fakeDatabase({ profileRevision: 4, media: [mediaRow("private")] });
    const publisher = fakePublisher();
    const repository = createRepository(harness, publisher);

    const result = await repository.assignLogo({
      ...baseCommand("stale-logo-command"),
      expectedProfileRevision: 3,
      assignment: { mediaObjectId: mediaId, role: "logo", altText: null, sortOrder: 0 },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "profile_revision_conflict", currentRevision: 4 },
    });
    expect(publisher.copyToPublic).not.toHaveBeenCalled();
    expect(harness.sql()).not.toContain("FROM platform.media_objects media");
    expect(harness.state.jobs).toEqual([]);
  });

  it("does not copy an already-public canonical asset", async () => {
    const harness = fakeDatabase({ media: [mediaRow("public")] });
    const publisher = fakePublisher();
    const repository = createRepository(harness, publisher);

    const result = await repository.assignLogo({
      ...baseCommand("public-logo"),
      expectedProfileRevision: 1,
      assignment: { mediaObjectId: mediaId, role: "logo", altText: "Logo", sortOrder: 0 },
    });

    expect(result.ok).toBe(true);
    expect(publisher.copyToPublic).not.toHaveBeenCalled();
    expect(harness.registryMutationCount()).toBe(0);
    expect(harness.state.assignments).toHaveLength(1);
    expect(harness.state.jobs).toEqual([]);
    expect(harness.state.profileRevision).toBe(2);
  });
});

function createRepository(
  harness: ReturnType<typeof fakeDatabase>,
  publisher: PropertyMediaVariantPublisher,
  options: { now?: () => Date } = {},
) {
  return createPgS3PropertyMediaCommandRepository({
    connectionString: "postgresql://target-db",
    serving,
    pool: harness.pool,
    publisher,
    now: options.now ?? (() => new Date("2026-08-01T12:00:00.000Z")),
    randomId: () => "55555555-5555-4555-8555-555555555555",
    syncReadModels: vi.fn(async () => undefined),
  });
}

function baseCommand(idempotencyKey: string) {
  return {
    organizationId,
    propertyId,
    actorUserId,
    idempotencyKey,
    audit: {
      requestId: `request-${idempotencyKey}`,
      correlationId: `correlation-${idempotencyKey}`,
      source: "web" as const,
      receivedAt: "2026-08-01T12:00:00.000Z",
    },
  };
}

function platformAdminCommand(idempotencyKey: string) {
  const { organizationId: _organizationId, ...command } = baseCommand(idempotencyKey);
  return command;
}

function fakePublisher(): PropertyMediaVariantPublisher {
  return {
    copyToPublic: vi.fn(async () => undefined),
    deletePublic: vi.fn(async () => undefined),
  };
}

type MediaState = ReturnType<typeof mediaRow>;

function mediaRow(
  visibility: "private" | "public",
  objectId = mediaId,
  purpose = "property.gallery_image",
) {
  const checksumSha256 = "a".repeat(64);
  const variants = ["blur_preview", "large", "original_safe", "thumbnail"].map((variantName) => {
    const objectName =
      visibility === "private"
        ? `sha256-${checksumSha256}.webp`
        : "publication-55555555-5555-4555-8555-555555555555.webp";
    const storageKey = `${visibility}/media/${objectId}/${variantName}/${objectName}`;
    return {
      variantName,
      visibility,
      storageKey,
      contentType: "image/webp",
      widthPx: 1,
      heightPx: 1,
      sizeBytes: 1,
      checksumSha256,
      publicUrl:
        visibility === "public"
          ? `https://cdn.vayada.example/${storageKey.slice("public/".length)}`
          : null,
    };
  });
  return {
    mediaObjectId: objectId,
    bucket: serving.bucketName,
    storageKey: variants.find(({ variantName }) => variantName === "original_safe")!.storageKey,
    storageKind: "vayada_managed",
    visibility,
    purpose,
    ownerOrganizationId: organizationId,
    propertyId,
    lifecycleStatus: visibility === "private" ? "staged" : "active",
    publicApproved: visibility === "public",
    contentType: "image/webp",
    widthPx: 1,
    heightPx: 1,
    sizeBytes: 1,
    checksumSha256,
    variants,
  };
}

type AssignmentState = {
  mediaObjectId: string;
  mediaType: "hero_image" | "gallery_image" | "logo";
  altText: string | null;
  sortOrder: number;
};

function assignment(
  mediaObjectId: string,
  mediaType: AssignmentState["mediaType"],
  altText: string | null,
  sortOrder: number,
): AssignmentState {
  return { mediaObjectId, mediaType, altText, sortOrder };
}

type IdempotencyState = {
  id: string;
  operation: string;
  keyHash: string;
  requestFingerprintHash: string;
  propertyId: string;
  status: "in_progress" | "completed";
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  metadata: Record<string, unknown>;
};

type JobState = {
  id: string;
  jobKey: string;
  queueName: string;
  jobType: string;
  keyHash: string;
  propertyId: string;
  status: "pending" | "running" | "succeeded" | "dead_lettered";
  attemptsCount: number;
  maxAttempts: number;
  lockedAt: string | null;
  lockedBy: string | null;
  runAfter: string;
  cleanupRequired: boolean;
  cleanupKeys: string[];
  payload: unknown;
};

type FakeState = {
  profileRevision: number;
  assignments: AssignmentState[];
  pendingAssignments: AssignmentState[];
  media: MediaState[];
  idempotency: IdempotencyState[];
  jobs: JobState[];
};

function fakeDatabase(options: {
  profileRevision?: number;
  media?: MediaState[];
  assignments?: AssignmentState[];
  ownerOrganizationIdsByLock?: string[][];
}) {
  const state: FakeState = {
    profileRevision: options.profileRevision ?? 1,
    assignments: structuredClone(options.assignments ?? []),
    pendingAssignments: [],
    media: structuredClone(options.media ?? []),
    idempotency: [],
    jobs: [],
  };
  const commands: string[] = [];
  const queries: string[] = [];
  let transactionSnapshot: FakeState | null = null;
  let assignmentMutations = 0;
  let registryMutations = 0;
  let platformAdminLockCount = 0;

  const client = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (normalized === "BEGIN") {
        if (transactionSnapshot) throw new Error("Nested fake transaction");
        transactionSnapshot = structuredClone(state);
        commands.push(normalized);
        return result<T>([]);
      }
      if (normalized === "COMMIT") {
        transactionSnapshot = null;
        commands.push(normalized);
        return result<T>([]);
      }
      if (normalized === "ROLLBACK") {
        if (transactionSnapshot) restoreState(state, transactionSnapshot);
        transactionSnapshot = null;
        commands.push(normalized);
        return result<T>([]);
      }
      queries.push(normalized);

      if (
        normalized.startsWith("SELECT idempotency.id") &&
        normalized.includes("idempotency.id = $1::uuid")
      ) {
        const row = state.idempotency.find(
          (item) =>
            item.id === String(values[0]) &&
            item.operation === String(values[1]) &&
            item.propertyId === String(values[2]) &&
            item.status === "in_progress" &&
            item.requestFingerprintHash === String(values[3]) &&
            item.keyHash === String(values[4]) &&
            isRecord(item.metadata.publication) &&
            item.metadata.publication.jobId === String(values[5]),
        );
        return result<T>(row ? [{ id: row.id }] : []);
      }

      if (
        normalized.includes('owner.organization_id::text AS "ownerOrganizationId"') &&
        normalized.includes("FOR UPDATE OF property")
      ) {
        const owners = options.ownerOrganizationIdsByLock?.[platformAdminLockCount++] ?? [
          organizationId,
        ];
        return result<T>(
          owners.map((ownerOrganizationId) => ({
            profileRevision: state.profileRevision,
            ownerOrganizationId,
          })),
        );
      }

      if (
        normalized.includes("FROM hotel_catalog.properties property") &&
        normalized.includes("FOR UPDATE OF property")
      ) {
        return result<T>([{ profileRevision: state.profileRevision }]);
      }

      if (
        normalized.includes("FROM platform.idempotency_keys") &&
        normalized.includes("FOR UPDATE")
      ) {
        const operation = String(values[0]);
        const keyHash = String(values[1]);
        const commandPropertyId = String(values[2]);
        const row = state.idempotency.find(
          (item) =>
            item.operation === operation &&
            item.keyHash === keyHash &&
            item.propertyId === commandPropertyId,
        );
        return result<T>(
          row
            ? [
                {
                  id: row.id,
                  status: row.status,
                  requestFingerprintHash: row.requestFingerprintHash,
                  responseStatusCode: row.responseStatusCode,
                  responseBodyHash: row.responseBodyHash,
                  metadata: row.metadata,
                },
              ]
            : [],
        );
      }

      if (normalized.startsWith("INSERT INTO platform.idempotency_keys")) {
        const [operation, keyHash, fingerprint, commandPropertyId] = values.map(String);
        const conflict = state.idempotency.some(
          (item) =>
            item.operation === operation &&
            item.keyHash === keyHash &&
            item.propertyId === commandPropertyId,
        );
        if (conflict) return result<T>([], 0);
        state.idempotency.push({
          id: idempotencyId,
          operation,
          keyHash,
          requestFingerprintHash: fingerprint,
          propertyId: commandPropertyId,
          status: "in_progress",
          responseStatusCode: null,
          responseBodyHash: null,
          metadata: {},
        });
        return result<T>([{ id: idempotencyId }], 1);
      }

      if (normalized.startsWith("UPDATE platform.idempotency_keys")) {
        const row = state.idempotency.find(({ id }) => id === String(values[0]));
        if (!row || row.status !== "in_progress") return result<T>([], 0);
        if (normalized.includes("SET status = 'completed'")) {
          row.status = "completed";
          row.responseStatusCode = Number(values[1]);
          row.responseBodyHash = String(values[2]);
          row.metadata = { result: JSON.parse(String(values[4])) };
        } else if (normalized.includes("'publication', jsonb_build_object")) {
          row.metadata = {
            publication: {
              jobId: String(values[1]),
              acceptedProfileRevision: Number(values[2]),
              status: "pending",
            },
          };
        } else if (normalized.includes("'{publication,status}'")) {
          const publication = isRecord(row.metadata.publication)
            ? { ...row.metadata.publication }
            : {};
          publication.status = normalized.includes("'\"running\"'::jsonb") ? "running" : "pending";
          row.metadata = { publication };
        }
        return result<T>([], 1);
      }

      if (normalized.startsWith("INSERT INTO platform.job_attempts")) {
        return result<T>([{ id: "66666666-6666-4666-8666-666666666666" }], 1);
      }
      if (normalized.startsWith("UPDATE platform.job_attempts")) {
        return result<T>([{ id: "66666666-6666-4666-8666-666666666666" }], 1);
      }
      if (normalized.startsWith("INSERT INTO platform.dead_letter_events")) {
        return result<T>([], 1);
      }

      if (
        normalized.startsWith("SELECT job.id::text AS id") &&
        normalized.includes("job.status IN ('pending', 'running')")
      ) {
        const commandPropertyId = String(values.at(-1));
        const job = state.jobs.find(
          (item) =>
            item.queueName === "hotel-catalog.property-media" &&
            item.jobType === "hotel-catalog.property-media.publish" &&
            item.propertyId === commandPropertyId &&
            (item.status === "pending" || item.status === "running"),
        );
        return result<T>(job ? [{ id: job.id }] : []);
      }

      if (normalized.startsWith("INSERT INTO platform.jobs")) {
        const [jobKey, queueName, jobType, maxAttempts, commandPropertyId] = values;
        if (state.jobs.some((item) => item.queueName === queueName && item.jobKey === jobKey)) {
          return result<T>([], 0);
        }
        state.jobs.push({
          id: publicationJobId,
          jobKey: String(jobKey),
          queueName: String(queueName),
          jobType: String(jobType),
          keyHash: String(values[6]),
          propertyId: String(commandPropertyId),
          status: "pending",
          attemptsCount: 0,
          maxAttempts: Number(maxAttempts),
          lockedAt: null,
          lockedBy: null,
          runAfter: "2026-08-01T12:00:00.000Z",
          cleanupRequired: false,
          cleanupKeys: JSON.parse(String(values[8])) as string[],
          payload: JSON.parse(String(values[7])),
        });
        return result<T>([{ id: publicationJobId }], 1);
      }

      if (
        normalized.startsWith("SELECT job.id::text AS id,") &&
        normalized.includes('job.attempts_count AS "attemptsCount"') &&
        normalized.includes("FROM platform.jobs job")
      ) {
        const requestedJobId = values[2] === null ? null : String(values[2]);
        const force = values[3] === true;
        const now = Date.parse(String(values[4]));
        const leaseCutoff = Date.parse(String(values[5]));
        const job = state.jobs.find((item) => {
          if (item.queueName !== String(values[0]) || item.jobType !== String(values[1]))
            return false;
          if (requestedJobId && item.id !== requestedJobId) return false;
          if (item.status === "pending") return force || Date.parse(item.runAfter) <= now;
          return item.status === "running" && Date.parse(item.lockedAt ?? "") <= leaseCutoff;
        });
        return result<T>(
          job
            ? [
                {
                  id: job.id,
                  jobKey: job.jobKey,
                  status: job.status,
                  attemptsCount: job.attemptsCount,
                  maxAttempts: job.maxAttempts,
                  lockedAt: job.lockedAt,
                  lockedBy: job.lockedBy,
                  propertyId: job.propertyId,
                  keyHash: job.keyHash,
                  tenantScope: "property",
                  resourceProduct: "hotel_catalog",
                  resourceType: "property_media_assignment",
                  resourceId: job.propertyId,
                  cleanupRequired: job.cleanupRequired,
                  cleanupKeys: job.cleanupKeys,
                  payload: job.payload,
                },
              ]
            : [],
        );
      }

      if (normalized.startsWith("SELECT job.payload FROM platform.jobs job")) {
        const job = state.jobs.find(
          (item) =>
            item.id === String(values[0]) &&
            item.status === "running" &&
            item.lockedBy === String(values[1]),
        );
        const idempotency = state.idempotency.find(
          (item) =>
            item.id === String(values[4]) &&
            item.status === "in_progress" &&
            item.operation === String(values[5]) &&
            item.propertyId === String(values[6]) &&
            item.requestFingerprintHash === String(values[7]) &&
            item.keyHash === String(values[8]) &&
            isRecord(item.metadata.publication) &&
            item.metadata.publication.jobId === job?.id,
        );
        return result<T>(job && idempotency ? [{ payload: job.payload }] : []);
      }

      if (
        normalized.startsWith("SELECT job.id::text AS id,") &&
        normalized.includes("cleanupPassesRemaining")
      ) {
        return result<T>([]);
      }

      if (normalized.startsWith('SELECT job.status AS "jobStatus"')) {
        const job = state.jobs.find(({ id }) => id === String(values[0]));
        const idempotency = state.idempotency.find(({ id }) => id === String(values[1]));
        return result<T>(
          job && idempotency
            ? [{ jobStatus: job.status, idempotencyStatus: idempotency.status }]
            : [],
        );
      }

      if (normalized.startsWith("UPDATE platform.jobs")) {
        const job = state.jobs.find(({ id }) => id === String(values[0]));
        if (!job) return result<T>([], 0);
        if (normalized.includes("SET status = 'running'")) {
          job.status = "running";
          job.attemptsCount = Number(values[2]);
          job.lockedAt = String(values[3]);
          job.lockedBy = String(values[1]);
        } else if (normalized.includes("SET status = 'pending'")) {
          if (job.status !== "running" || job.lockedBy !== String(values[1])) {
            return result<T>([], 0);
          }
          job.status = "pending";
          job.runAfter = String(values[3]);
          job.cleanupRequired = values[5] === true;
          job.lockedAt = null;
          job.lockedBy = null;
        } else if (normalized.includes("SET status = 'succeeded'")) {
          if (job.status !== "running" || job.lockedBy !== String(values[1])) {
            return result<T>([], 0);
          }
          job.status = "succeeded";
          job.lockedAt = null;
          job.lockedBy = null;
        } else if (normalized.includes("SET status = 'dead_lettered'")) {
          job.status = "dead_lettered";
          job.lockedAt = null;
          job.lockedBy = null;
        }
        return result<T>([], 1);
      }

      if (normalized.startsWith("WITH completeness AS")) {
        if (values[1] === true) state.profileRevision += 1;
        return result<T>([], 1);
      }
      if (normalized.startsWith('SELECT profile_revision AS "profileRevision"')) {
        return result<T>([{ profileRevision: state.profileRevision }]);
      }
      if (
        normalized.includes("FROM hotel_catalog.property_media media") &&
        normalized.includes("media.public_approved = FALSE")
      ) {
        return result<T>(structuredClone(state.pendingAssignments));
      }
      if (normalized.includes("FROM hotel_catalog.property_media media")) {
        return result<T>(structuredClone(state.assignments));
      }

      if (
        normalized.startsWith('SELECT media.id::text AS "mediaObjectId"') &&
        normalized.includes("FOR UPDATE OF media")
      ) {
        const requestedIds = values[0] as string[];
        const allowedPurposes = values[3] as string[];
        const rows = state.media
          .filter(
            (item) =>
              requestedIds.includes(item.mediaObjectId) &&
              item.ownerOrganizationId === values[1] &&
              item.propertyId === values[2] &&
              allowedPurposes.includes(item.purpose),
          )
          .map(({ mediaObjectId }) => ({ mediaObjectId }));
        return result<T>(rows);
      }
      if (normalized.startsWith("SELECT variant.id")) return result<T>([]);
      if (normalized.includes("FROM platform.media_objects media")) {
        const requestedIds = values[0] as string[];
        return result<T>(
          structuredClone(
            state.media.filter(
              (item) =>
                requestedIds.includes(item.mediaObjectId) &&
                item.ownerOrganizationId === values[1] &&
                item.propertyId === values[2],
            ),
          ),
        );
      }

      if (normalized.startsWith("UPDATE platform.media_objects")) {
        const media = state.media.find(({ mediaObjectId }) => mediaObjectId === String(values[0]));
        if (
          !media ||
          media.visibility !== "private" ||
          media.lifecycleStatus !== "staged" ||
          media.publicApproved
        ) {
          return result<T>([], 0);
        }
        media.visibility = "public";
        media.storageKey = String(values[1]);
        media.lifecycleStatus = "active";
        media.publicApproved = true;
        registryMutations += 1;
        return result<T>([{ id: media.mediaObjectId }], 1);
      }
      if (normalized.startsWith("UPDATE platform.media_variants")) {
        const media = state.media.find(({ mediaObjectId }) => mediaObjectId === String(values[0]));
        const variant = media?.variants.find(
          ({ variantName }) => variantName === String(values[1]),
        );
        if (!variant || variant.visibility !== "private") return result<T>([], 0);
        variant.visibility = "public";
        variant.storageKey = String(values[2]);
        variant.publicUrl = String(values[3]);
        registryMutations += 1;
        return result<T>([], 1);
      }
      if (normalized.startsWith("DELETE FROM hotel_catalog.property_media")) {
        if (normalized.includes("rights_metadata ->> 'publicationJobId'")) {
          const removed = state.pendingAssignments.length;
          state.pendingAssignments = [];
          assignmentMutations += removed > 0 ? 1 : 0;
          return result<T>([], removed);
        }
        const affected = values[1] as string[];
        if (normalized.includes("public_approved = FALSE")) {
          state.pendingAssignments = state.pendingAssignments.filter(
            ({ mediaType }) => !affected.includes(mediaType),
          );
          return result<T>([], 1);
        }
        state.assignments = state.assignments.filter(
          ({ mediaType }) => !affected.includes(mediaType),
        );
        state.pendingAssignments = state.pendingAssignments.filter(
          ({ mediaType }) => !affected.includes(mediaType),
        );
        assignmentMutations += 1;
        return result<T>([], 1);
      }
      if (normalized.startsWith("INSERT INTO hotel_catalog.property_media")) {
        const payload = JSON.parse(String(values[1])) as Array<Record<string, unknown>>;
        const assignments = payload.map((item) => ({
          mediaObjectId: String(item.platform_media_object_id),
          mediaType: item.media_type as AssignmentState["mediaType"],
          altText: item.alt_text === null ? null : String(item.alt_text),
          sortOrder: Number(item.sort_order),
        }));
        if (normalized.includes("'platform', FALSE")) {
          state.pendingAssignments.push(...assignments);
        } else {
          state.assignments.push(...assignments);
        }
        assignmentMutations += 1;
        return result<T>([], payload.length);
      }
      if (normalized.startsWith("INSERT INTO platform.product_audit_events")) {
        return result<T>([], 1);
      }
      throw new Error(`Unexpected SQL in property media test: ${normalized}`);
    },
    release() {},
  };

  return {
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
    state,
    commands,
    queries,
    sql: () => queries.join("\n"),
    assignmentMutationCount: () => assignmentMutations,
    registryMutationCount: () => registryMutations,
  };
}

function restoreState(target: FakeState, snapshot: FakeState) {
  target.profileRevision = snapshot.profileRevision;
  target.assignments = snapshot.assignments;
  target.pendingAssignments = snapshot.pendingAssignments;
  target.media = snapshot.media;
  target.idempotency = snapshot.idempotency;
  target.jobs = snapshot.jobs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function result<T extends QueryResultRow>(rows: object[], rowCount = rows.length) {
  return { rows: rows as T[], rowCount };
}
