import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PlatformMediaSessionRecord } from "../routes/platformMedia.js";
import { PlatformMediaProfileRevisionConflictError } from "../routes/platformMedia.js";
import { createPgPlatformMediaRepository } from "./platformMediaRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const userId = "96969696-9696-4696-8696-969696969601";
const organizationId = "96969696-9696-4696-8696-969696969602";
const propertyId = "96969696-9696-4696-8696-969696969603";
const initialSessionId = "96969696-9696-4696-8696-969696969604";
const staleSessionId = "96969696-9696-4696-8696-969696969605";

describe.skipIf(!TEST_DATABASE_URL)("property hero media profile revision CAS", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgPlatformMediaRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    publicCdnBaseUrl: "https://cdn.example.test",
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await cleanup();
    await client.query(
      `INSERT INTO identity.users (id, email, name)
       VALUES ($1::uuid, 'platform-media-cas@example.test', 'Platform Media CAS')`,
      [userId],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES ($1::uuid, 'hotel_group', 'Platform Media CAS', 'platform-media-cas')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'platform-media-cas', 'Platform Media CAS')`,
      [propertyId],
    );
  });

  afterAll(async () => {
    await cleanup();
    await repository.close?.();
    await client.end();
  });

  it("preserves the current hero and rolls back all media rows when finalization is stale", async () => {
    const initialSession = await createSession(initialSessionId, 1);
    const initialMediaId = initialSession.files[0]!.mediaId;
    await repository.completeUploadSession(completionInput(initialSession, "initial"));

    await expect(readPropertyRevision()).resolves.toBe(2);
    const staleSession = await createSession(staleSessionId, 2);
    const staleMediaId = staleSession.files[0]!.mediaId;
    await client.query(
      `UPDATE hotel_catalog.properties
       SET profile_revision = profile_revision + 1
       WHERE id = $1::uuid`,
      [propertyId],
    );

    await expect(
      repository.completeUploadSession(completionInput(staleSession, "stale")),
    ).rejects.toMatchObject({
      name: PlatformMediaProfileRevisionConflictError.name,
      code: "profile_revision_conflict",
      currentRevision: 3,
    });

    await expect(readPropertyRevision()).resolves.toBe(3);
    await expect(
      client.query<{ mediaId: string }>(
        `SELECT platform_media_object_id::text AS "mediaId"
         FROM hotel_catalog.property_media
         WHERE property_id = $1::uuid
           AND media_type = 'hero_image'
           AND public_approved = TRUE`,
        [propertyId],
      ),
    ).resolves.toMatchObject({ rows: [{ mediaId: initialMediaId }] });
    await expect(
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM platform.media_objects
         WHERE id = $1::uuid`,
        [staleMediaId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      client.query<{ status: string; expectedRevision: string }>(
        `SELECT session_status AS status,
                completion_metadata -> 'session' ->> 'expectedProfileRevision'
                  AS "expectedRevision"
         FROM platform.media_upload_sessions
         WHERE id = $1::uuid`,
        [staleSessionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "signed", expectedRevision: "2" }],
    });
  });

  async function createSession(
    sessionId: string,
    expectedProfileRevision: number,
  ): Promise<PlatformMediaSessionRecord> {
    return repository.createUploadSession({
      sessionId,
      uploadSessionKey: `media.profile-revision:${sessionId}`,
      stagingPrefix: `staging/${sessionId}`,
      context: {
        actor: { internalUserId: userId },
        selectedOrganization: { organizationId },
      } as never,
      request: {
        purpose: "property.hero_image",
        visibility: "public",
        expectedProfileRevision,
        resource: {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: propertyId,
        },
        files: [
          {
            clientFileId: "hero",
            filename: "hero.jpg",
            contentType: "image/jpeg",
            sizeBytes: 1024,
          },
        ],
      },
      policy: {
        purpose: "property.hero_image",
        autoApprovePublicOnFinalize: true,
      } as never,
      target: {
        resourceProduct: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        propertyId,
      },
      uploadTargets: [
        {
          uploadTargetId: `${sessionId}-target`,
          clientFileId: "hero",
          method: "PUT",
          uploadUrl: "https://s3.example.test/signed",
          headers: { "content-type": "image/jpeg" },
          stagingKey: `staging/${sessionId}/hero.jpg`,
          expiresAt: "2026-07-27T12:15:00.000Z",
        },
      ],
      now: "2026-07-27T12:00:00.000Z",
      expiresAt: "2026-07-27T12:15:00.000Z",
      auditEvent: {
        action: "platform_media.upload_session.created",
        auditKey: `media.profile-revision.created:${sessionId}`,
        actorUserId: userId,
        organizationId,
        targetType: "media_upload_session",
        targetId: sessionId,
        requestId: `request-created-${sessionId}`,
        metadata: { purpose: "property.hero_image" },
      },
    });
  }

  function completionInput(session: PlatformMediaSessionRecord, label: string) {
    const mediaId = session.files[0]!.mediaId;
    const storageKey = `public/properties/platform-media-cas/${mediaId}/original_safe/${label}.webp`;
    return {
      session,
      files: [
        {
          sessionFile: session.files[0]!,
          uploadTarget: session.uploadTargets[0]!,
          inspection: {
            contentType: "image/webp",
            sizeBytes: 900,
            checksumSha256: "a".repeat(64),
            widthPx: 1200,
            heightPx: 800,
          },
        },
      ],
      variantSets: [
        [
          {
            variantName: "original_safe" as const,
            visibility: "public" as const,
            storageKey,
            contentType: "image/webp",
            widthPx: 1200,
            heightPx: 800,
            sizeBytes: 900,
            checksumSha256: "b".repeat(64),
            publicCdnUrl: `https://cdn.example.test/${storageKey.slice("public/".length)}`,
          },
        ],
      ],
      bucketName: "vayada-test-media",
      now: "2026-07-27T12:01:00.000Z",
      auditEvent: {
        action: "platform_media.upload_session.finalized" as const,
        auditKey: `media.profile-revision.finalized:${session.sessionId}`,
        actorUserId: userId,
        organizationId,
        targetType: "media_object" as const,
        targetId: mediaId,
        requestId: `request-finalized-${session.sessionId}`,
        metadata: { purpose: "property.hero_image" },
      },
    };
  }

  async function readPropertyRevision(): Promise<number> {
    const result = await client.query<{ profileRevision: string }>(
      `SELECT profile_revision::text AS "profileRevision"
       FROM hotel_catalog.properties
       WHERE id = $1::uuid`,
      [propertyId],
    );
    return Number(result.rows[0]?.profileRevision);
  }

  async function cleanup(): Promise<void> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM platform.product_audit_events WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await client.query("DELETE FROM hotel_catalog.property_media WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await client.query(
        "DELETE FROM platform.media_upload_sessions WHERE owner_organization_id = $1::uuid",
        [organizationId],
      );
      await client.query(
        "DELETE FROM platform.media_objects WHERE owner_organization_id = $1::uuid",
        [organizationId],
      );
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
        organizationId,
      ]);
      await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [userId]);
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
