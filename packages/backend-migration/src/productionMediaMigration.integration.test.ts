import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deterministicUuid } from "./productionBookingValues.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  runProductionMediaMigration,
  type ProductionMediaMigrationConfig,
} from "./productionMediaMigration.js";
import type { ProductionMediaReference } from "./productionMediaPlan.js";
import {
  ProductionMediaSourceError,
  type ImportedProductionMedia,
} from "./productionMediaStorage.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = "vay1351-105500000000000000000001";
const HOTEL = "10550000-0000-4000-a000-000000000021";
const PROPERTY = "10550000-0000-4000-a000-000000000022";
const ORGANIZATION = "10550000-0000-4000-a000-000000000023";
const CREATOR = "10550000-0000-4000-a000-000000000024";
const CREATOR_USER = "10550000-0000-4000-a000-000000000025";
const HOTEL_USER = "10550000-0000-4000-a000-000000000026";
const CREATOR_ORGANIZATION = "10550000-0000-4000-a000-000000000027";
const COLLABORATION = "10550000-0000-4000-a000-000000000028";
const MESSAGE = "10550000-0000-4000-a000-000000000029";
const ADDON = "10550000-0000-4000-a000-000000000030";

describe.skipIf(!URL)("production media migration (PostgreSQL)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
    await seed(client);
  });

  afterAll(async () => {
    await client.query(
      `ALTER TABLE platform.production_media_migration_quarantines
       DISABLE TRIGGER trg_production_media_migration_quarantines_immutable`,
    );
    await client.query(
      "DELETE FROM platform.production_media_migration_quarantines WHERE source_run_id=$1",
      [RUN],
    );
    await client.query(
      `ALTER TABLE platform.production_media_migration_quarantines
       ENABLE TRIGGER trg_production_media_migration_quarantines_immutable`,
    );
    await client.query(
      "DELETE FROM platform.production_media_migration_runs WHERE source_run_id=$1",
      [RUN],
    );
    await client.query(
      "DELETE FROM platform.media_objects WHERE source_metadata ->> 'migrationRunId'=$1",
      [RUN],
    );
    await client.query(
      "DELETE FROM identity.organization_resource_links WHERE organization_id=ANY($1::uuid[])",
      [[ORGANIZATION, CREATOR_ORGANIZATION]],
    );
    await client.query("DELETE FROM hotel_catalog.property_source_links WHERE property_id=$1", [
      PROPERTY,
    ]);
    await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [PROPERTY]);
    await client.query("DELETE FROM identity.organizations WHERE id=ANY($1::uuid[])", [
      [ORGANIZATION, CREATOR_ORGANIZATION],
    ]);
    await client.query("DELETE FROM platform.source_extraction_runs WHERE run_id=$1", [RUN]);
    await client.end();
  });

  it("records a missing object, resumes it, and never uploads the completed item twice", async () => {
    let failGallery = true;
    let quarantinedValue = "http://legacy-media-test.s3.amazonaws.com/addons/stale.jpg";
    const importedIds: string[] = [];
    const storage = {
      importReference: vi.fn(async (reference: ProductionMediaReference) => {
        if (reference.sourceRowId.endsWith(":images:1") && failGallery)
          throw new ProductionMediaSourceError("SOURCE_MISSING", "not found");
        importedIds.push(reference.mediaObjectId);
        return imported(reference);
      }),
    };
    const services = {
      readSnapshot: vi.fn(async () => ({
        completedAt: "2026-08-30T00:00:00.000Z",
        rows: sourceRows(quarantinedValue),
      })),
      storage,
    };

    const first = await runProductionMediaMigration(config(), services);
    expect(first.blockers.map((blocker) => blocker.code)).toEqual(["MEDIA_SOURCE_MISSING"]);
    expect(first).toMatchObject({
      applied: false,
      counts: { completed: 2, missing: 1, quarantined: 1 },
      quarantines: [
        expect.objectContaining({
          sourceRowId: `${ADDON}:image`,
          reasonCode: "INVALID_HTTPS_URL",
        }),
      ],
    });
    expect(importedIds).toHaveLength(2);

    failGallery = false;
    const resumed = await runProductionMediaMigration(config(), services);
    expect(resumed).toMatchObject({
      applied: true,
      counts: { completed: 3, missing: 0, corrupt: 0, failed: 0, quarantined: 1 },
      blockers: [],
    });
    expect(importedIds).toHaveLength(3);
    expect(new Set(importedIds).size).toBe(3);

    const evidence = await client.query<{
      status: string;
      planned: number;
      completed: number;
      quarantined: number;
      quarantineRows: number;
      quarantineRedacted: boolean;
      objects: number;
      variants: number;
      chatOwner: string;
      chatRetainedUntil: string;
      chatMigrationCase: string;
    }>(
      `SELECT run.status,
              run.planned_count AS planned,
              run.completed_count AS completed,
              run.quarantined_count AS quarantined,
              (SELECT count(*)::int FROM platform.production_media_migration_quarantines
                WHERE source_run_id=$1) AS "quarantineRows",
              (SELECT bool_and(source_value_sha256 ~ '^[0-9a-f]{64}$'
                               AND length(source_field) > 0
                               AND length(reason_code) > 0)
                 FROM platform.production_media_migration_quarantines
                WHERE source_run_id=$1) AS "quarantineRedacted",
              (SELECT count(*)::int FROM platform.media_objects
                WHERE source_metadata ->> 'migrationRunId'=$1) AS objects,
              (SELECT count(*)::int FROM platform.media_variants variant
                JOIN platform.media_objects media ON media.id=variant.media_object_id
               WHERE media.source_metadata ->> 'migrationRunId'=$1) AS variants,
              (SELECT owner_organization_id::text FROM platform.media_objects
                WHERE source_metadata ->> 'migrationRunId'=$1
                  AND purpose='marketplace.collaboration_chat.attachment') AS "chatOwner",
              (SELECT retained_until::text FROM platform.media_objects
                WHERE source_metadata ->> 'migrationRunId'=$1
                  AND purpose='marketplace.collaboration_chat.attachment') AS "chatRetainedUntil",
              (SELECT source_metadata ->> 'migrationCase' FROM platform.media_objects
                WHERE source_metadata ->> 'migrationRunId'=$1
                  AND purpose='marketplace.collaboration_chat.attachment') AS "chatMigrationCase"
         FROM platform.production_media_migration_runs run
        WHERE run.source_run_id=$1`,
      [RUN],
    );
    expect(evidence.rows[0]).toEqual({
      status: "completed",
      planned: 3,
      completed: 3,
      quarantined: 1,
      quarantineRows: 1,
      quarantineRedacted: true,
      objects: 3,
      variants: 9,
      chatOwner: CREATOR_ORGANIZATION,
      chatRetainedUntil: "2028-08-01 00:00:00+00",
      chatMigrationCase: "media-url-migration",
    });

    await expect(
      client.query(
        `UPDATE platform.production_media_migration_quarantines
            SET source_value_sha256=$2
          WHERE source_run_id=$1`,
        [RUN, "b".repeat(64)],
      ),
    ).rejects.toThrow("quarantine evidence is immutable");
    await expect(
      client.query(
        "DELETE FROM platform.production_media_migration_quarantines WHERE source_run_id=$1",
        [RUN],
      ),
    ).rejects.toThrow("quarantine evidence is immutable");
    await expect(
      client.query("TRUNCATE platform.production_media_migration_quarantines"),
    ).rejects.toThrow("quarantine evidence is immutable");
    await expect(
      client.query("DELETE FROM platform.production_media_migration_runs WHERE source_run_id=$1", [
        RUN,
      ]),
    ).rejects.toThrow("violates foreign key constraint");

    quarantinedValue = "ftp://legacy-media-test/addons/different-stale.jpg";
    await expect(runProductionMediaMigration(config(), services)).rejects.toThrow(
      "different immutable inputs",
    );
  });
});

function config(): ProductionMediaMigrationConfig {
  return {
    connectionString: URL!,
    sourceRunId: RUN,
    mode: "apply",
    targetBucket: "platform-media-test",
    cdnBaseUrl: "https://media.example.test",
    allowedLegacyBuckets: ["legacy-media-test"],
    legacyPmsBucket: "legacy-media-test",
  };
}

function sourceRows(quarantinedValue: string): IdentitySourceRow[] {
  return [
    {
      sourceDatabase: "booking",
      sourceTable: "booking_hotels",
      rowOrdinal: 1,
      data: {
        id: HOTEL,
        hero_image: "https://legacy-media-test.s3.amazonaws.com/hotels/hero.jpg",
        images: ["https://legacy-media-test.s3.amazonaws.com/hotels/gallery.jpg"],
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      },
    },
    {
      sourceDatabase: "booking",
      sourceTable: "booking_addons",
      rowOrdinal: 2,
      data: {
        id: ADDON,
        hotel_id: HOTEL,
        image: quarantinedValue,
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      },
    },
    {
      sourceDatabase: "marketplace",
      sourceTable: "hotel_profiles",
      rowOrdinal: 3,
      data: { id: HOTEL, user_id: HOTEL_USER },
    },
    {
      sourceDatabase: "marketplace",
      sourceTable: "creators",
      rowOrdinal: 4,
      data: { id: CREATOR, user_id: CREATOR_USER },
    },
    {
      sourceDatabase: "marketplace",
      sourceTable: "collaborations",
      rowOrdinal: 5,
      data: { id: COLLABORATION, hotel_id: HOTEL, creator_id: CREATOR },
    },
    {
      sourceDatabase: "marketplace",
      sourceTable: "chat_messages",
      rowOrdinal: 6,
      data: {
        id: MESSAGE,
        collaboration_id: COLLABORATION,
        sender_id: CREATOR_USER,
        message_type: "image",
        content: "https://legacy-media-test.s3.amazonaws.com/chat/private.jpg",
        metadata: {},
        created_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      },
    },
  ];
}

function imported(reference: ProductionMediaReference): ImportedProductionMedia {
  const names =
    reference.visibility === "private"
      ? (["provider_original"] as const)
      : (["original_safe", "large", "thumbnail", "blur_preview"] as const);
  const variants = names.map((variantName) => {
    const checksumSha256 = digest(`${reference.mediaObjectId}:${variantName}`);
    const storageKey = `${reference.visibility}/media/${reference.mediaObjectId}/${variantName}/sha256-${checksumSha256}.webp`;
    return {
      id: deterministicUuid("test", reference.mediaObjectId, variantName),
      mediaObjectId: reference.mediaObjectId,
      variantName,
      visibility: reference.visibility,
      storageKey,
      contentType: "image/webp",
      widthPx: 100,
      heightPx: 80,
      sizeBytes: 80,
      checksumSha256,
      publicCdnUrl:
        reference.visibility === "public"
          ? `https://media.example.test/${storageKey.slice("public/".length)}`
          : null,
    };
  });
  const original = variants[0];
  return {
    reference,
    bucket: "platform-media-test",
    storageKey: original.storageKey,
    contentType: original.contentType,
    sizeBytes: original.sizeBytes,
    checksumSha256: original.checksumSha256,
    sourceSizeBytes: 100,
    sourceChecksumSha256: digest(reference.sourceUrl),
    widthPx: original.widthPx,
    heightPx: original.heightPx,
    variants,
  };
}

async function seed(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
     VALUES ($1, 'local', $2, 'completed', now(), 1)`,
    [RUN, "a".repeat(40)],
  );
  await client.query(
    `INSERT INTO identity.organizations(id, kind, name, slug)
     VALUES ($1, 'hotel_group', 'VAY-1055 integration', 'vay-1055-integration'),
            ($2, 'creator_workspace', 'VAY-1055 creator', 'vay-1055-creator')`,
    [ORGANIZATION, CREATOR_ORGANIZATION],
  );
  await client.query(
    `INSERT INTO hotel_catalog.properties(id, public_id, display_name)
     VALUES ($1, 'vay-1055-integration', 'VAY-1055 integration')`,
    [PROPERTY],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
     VALUES ($1, 'marketplace', 'hotel_profiles', $2, 'profile_input', $3::jsonb)`,
    [PROPERTY, HOTEL, JSON.stringify({ migrationRunId: RUN })],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
     VALUES ($1, 'booking', 'booking_hotels', $2, 'canonical_input', $3::jsonb)`,
    [PROPERTY, HOTEL, JSON.stringify({ migrationRunId: RUN })],
  );
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship)
     VALUES ($1, 'booking', 'booking_hotel', $3, 'owner'),
            ($1, 'marketplace', 'hotel_profile', $3, 'owner'),
            ($2, 'marketplace', 'creator_profile', $4, 'owner')`,
    [ORGANIZATION, CREATOR_ORGANIZATION, HOTEL, CREATOR],
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
