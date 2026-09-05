import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readProductionParityEvidence,
  withProductionParityTargetWriteFreeze,
  type ProductionParityConfig,
} from "./productionParity.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN_ID = `vay1351-${"9".repeat(24)}`;
const STALE_RUN_ID = `vay1351-${"8".repeat(24)}`;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const PROPERTY_ID = "13590000-0000-4000-8000-000000000001";
const PROPERTY_MEDIA_ID = "13590000-0000-4000-8000-000000000002";
const MEDIA_OBJECT_ID = "13590000-0000-4000-8000-000000000003";
const ADDON_ID = "13590000-0000-4000-8000-000000000004";
const OTHER_MEDIA_OBJECT_ID = "13590000-0000-4000-8000-000000000005";
const CREATOR_ORGANIZATION_ID = "13590000-0000-4000-8000-000000000006";
const HOTEL_ORGANIZATION_ID = "13590000-0000-4000-8000-000000000007";
const CREATOR_PROFILE_ID = "13590000-0000-4000-8000-000000000008";
const LISTING_ID = "13590000-0000-4000-8000-000000000009";
const COLLABORATION_ID = "13590000-0000-4000-8000-000000000010";
const MESSAGE_ID = "13590000-0000-4000-8000-000000000011";
const ROOM_TYPE_ID = "13590000-0000-4000-8000-000000000012";
const ROOM_MEDIA_OBJECT_ID = "13590000-0000-4000-8000-000000000013";

describe.skipIf(!URL)("production parity evidence reader (PostgreSQL)", () => {
  beforeEach(async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await cleanup(client);
    } finally {
      await client.end();
    }
  });

  it("reads the migrated extraction, ledger, PII, media, and provenance contracts", async () => {
    assertSafeTestDatabase(URL!);
    const evidence = await readProductionParityEvidence(config());

    expect(evidence.extraction).toBeNull();
    expect(evidence.sources).toEqual([]);
    expect(evidence.migrationLedger.length).toBeGreaterThan(100);
    expect(evidence.missingMigrationVersions).toEqual([]);
    expect(evidence.piiExposureCount).toBe(0);
    expect(evidence.rawLegacyMediaReferenceCount).toBe(0);
    expect(evidence.staleProvenanceCount).toBeGreaterThanOrEqual(0);
  });

  it("detects an orphan raw media URL that is absent from the canonical registry", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-orphan-media', 'Parity orphan media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO booking.booking_settings (property_id, hero_image_url)
         VALUES ($1, 'https://legacy.example.test/orphan.jpg')`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects normalized sensitive keys in nested public JSON", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-sensitive-json', 'Parity sensitive JSON')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
           (property_id, public_id, display_name, canonical_slug, default_locale,
            supported_locales, profile_status, descriptions)
         VALUES ($1, 'parity-sensitive-json', 'Parity sensitive JSON',
                 'parity-sensitive-json', 'en', ARRAY['en'], 'complete',
                 '{"room_summary":{"guestEmail":"opaque-private-reference"}}'::jsonb)`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.piiExposureCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("reuses the canonical public-exposure policy for non-email PII", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-private-ip', 'Parity private IP')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
           (property_id, public_id, display_name, canonical_slug, default_locale,
            supported_locales, profile_status, descriptions)
         VALUES ($1, 'parity-private-ip', 'Parity private IP', 'parity-private-ip',
                 'en', ARRAY['en'], 'complete',
                 '{"room_summary":{"ipAddress":"203.0.113.1"}}'::jsonb)`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.piiExposureCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects stale active Catalog source-link provenance", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-stale-catalog-link', 'Parity stale Catalog link')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_source_links
           (property_id, source_system, source_table, source_id, relationship, metadata)
         VALUES ($1::uuid, 'booking', 'booking_hotels', $1::uuid::text, 'canonical_input',
                 jsonb_build_object('migrationRunId', 'vay1351-000000000000000000000000'))`,
        [PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.staleProvenanceCount).toBeGreaterThanOrEqual(1);

      await client.query(
        `UPDATE hotel_catalog.property_source_links
            SET status = 'superseded'
          WHERE property_id = $1`,
        [PROPERTY_ID],
      );
      const dispositioned = await readProductionParityEvidence(config());
      expect(dispositioned.staleProvenanceCount).toBe(0);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects a raw canonical-catalog media assignment directly", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-raw-property-media', 'Parity raw property media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_media
           (id, property_id, media_type, url, source_system)
         VALUES ($1, $2, 'hero_image', 'https://legacy.example.test/raw-catalog.jpg', 'booking')`,
        [PROPERTY_MEDIA_ID, PROPERTY_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("accepts a canonical platform-media catalog assignment with an approved active variant", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-canonical-property-media', 'Parity canonical property media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1::uuid, 'platform-media-test',
                 'public/media/' || $1::uuid::text || '/original_safe/canonical.jpg',
                 'vayada_managed', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 'canonical-hero', TRUE)`,
        [MEDIA_OBJECT_ID, PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1::uuid, 'original_safe', 'public',
                 'public/media/' || $1::uuid::text || '/original_safe/canonical.jpg', 'image/jpeg',
                 'https://media.example.test/media/' || $1::uuid::text || '/original_safe/canonical.jpg')`,
        [MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_media
           (id, property_id, media_type, url, source_system, public_approved,
            platform_media_object_id)
         VALUES ($1, $2, 'hero_image', $3, 'platform', TRUE, $4)`,
        [PROPERTY_MEDIA_ID, PROPERTY_ID, `platform-media:${MEDIA_OBJECT_ID}`, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBe(0);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("accepts canonical private Catalog and PMS assignments without exposing legacy URLs", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await insertPrivateAssignments(client);

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBe(0);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  const invalidPrivateAssignments: Array<[string, PrivateAssignmentOptions, number]> = [
    ["stale migration provenance", { migrationRunId: STALE_RUN_ID }, 2],
    ["no completed migration ledger", { ledger: false }, 2],
    ["a completed ledger from another run", { ledgerRunId: STALE_RUN_ID }, 2],
    ["wrong private variant", { variantName: "thumbnail" }, 2],
    ["a Catalog object carrying the PMS purpose", { catalogPurpose: "pms.room_type.media" }, 1],
    ["a PMS object bound to another room", { roomResourceId: PROPERTY_ID }, 1],
    ["missing object checksum evidence", { integrity: "missing_catalog_checksum" }, 1],
    ["mismatched variant checksum evidence", { integrity: "mismatched_room_checksum" }, 1],
    ["a malformed Catalog content type", { catalogContentType: "not-a-mime" }, 1],
    ["a non-image PMS content type", { roomContentType: "text/plain" }, 1],
  ];

  it.each(invalidPrivateAssignments)(
    "rejects private assignments with %s",
    async (_case, options, expected) => {
      assertSafeTestDatabase(URL!);
      const client = new pg.Client({ connectionString: URL });
      await client.connect();
      try {
        await insertPrivateAssignments(client, options);

        const evidence = await readProductionParityEvidence(config());

        expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(expected);
      } finally {
        await cleanup(client);
        await client.end();
      }
    },
  );

  it.each([
    [
      "virtual-hosted S3",
      "platform-media-test",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://platform-media-test.s3.amazonaws.com/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "regional virtual-hosted S3",
      "platform-media-test",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://platform-media-test.s3.us-east-1.amazonaws.com/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "regional path-style S3",
      "platform-media-test",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://s3.us-east-1.amazonaws.com/platform-media-test/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "wrong managed bucket",
      "wrong-media-bucket",
      `public/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://media.example.test/media/${MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
    [
      "cross-object storage path",
      "platform-media-test",
      `public/media/${OTHER_MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
      `https://media.example.test/media/${OTHER_MEDIA_OBJECT_ID}/original_safe/raw.jpg`,
    ],
  ])("rejects a %s public media variant", async (_case, bucket, storageKey, publicUrl) => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-unmanaged-media', 'Parity unmanaged media')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
            resource_product, resource_type, lifecycle_status, public_approved)
         VALUES ($1, $2, $4, 'vayada_managed', 'public', 'property.hero_image', $3,
                 'hotel_catalog', 'property', 'active', TRUE)`,
        [MEDIA_OBJECT_ID, bucket, PROPERTY_ID, storageKey],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', $2, 'image/jpeg', $3)`,
        [MEDIA_OBJECT_ID, storageKey, publicUrl],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_media
           (id, property_id, media_type, url, source_system, public_approved,
            platform_media_object_id)
         VALUES ($1, $2, 'hero_image', $3, 'platform', TRUE, $4)`,
        [PROPERTY_MEDIA_ID, PROPERTY_ID, `platform-media:${MEDIA_OBJECT_ID}`, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("detects Booking media assignments bound to the wrong purpose", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-invalid-booking-logo', 'Parity invalid Booking logo')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1, 'test', 'parity/wrong-logo.jpg', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 'wrong-booking-logo', TRUE)`,
        [MEDIA_OBJECT_ID, PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', 'parity/wrong-logo.jpg', 'image/jpeg',
                 'https://cdn.example.test/parity/wrong-logo.jpg')`,
        [MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO booking.booking_settings (property_id, header_logo_media_object_id)
         VALUES ($1, $2)`,
        [PROPERTY_ID, MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO booking.addon_definitions
           (id, property_id, source_system, name, pricing_model, currency, metadata)
         VALUES ($1, $2, 'booking', 'Wrong media', 'per_stay', 'EUR',
                 jsonb_build_object(
                   'mediaObjectId', $3::text,
                   'imageUrl', 'https://cdn.example.test/parity/wrong-logo.jpg'
                 ))`,
        [ADDON_ID, PROPERTY_ID, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("rejects a Booking add-on that points at a thumbnail instead of original_safe", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-addon-thumbnail', 'Parity add-on thumbnail')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
            resource_product, resource_type, resource_id, lifecycle_status, public_approved)
         VALUES ($1, 'platform-media-test',
                 'public/media/' || $1::uuid::text || '/original_safe/original.webp',
                 'vayada_managed', 'public', 'booking.addon.image', $2::uuid, 'booking',
                 'booking_hotel', $2::uuid::text, 'active', TRUE)`,
        [MEDIA_OBJECT_ID, PROPERTY_ID],
      );
      const thumbnailUrl = `https://media.example.test/media/${MEDIA_OBJECT_ID}/thumbnail/thumbnail.webp`;
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'thumbnail', 'public',
                 'public/media/' || $1::uuid::text || '/thumbnail/thumbnail.webp',
                 'image/webp', $2)`,
        [MEDIA_OBJECT_ID, thumbnailUrl],
      );
      await client.query(
        `INSERT INTO booking.addon_definitions
           (id, property_id, source_system, name, pricing_model, currency, metadata)
         VALUES ($1, $2, 'booking', 'Thumbnail add-on', 'per_stay', 'EUR',
                 jsonb_build_object('mediaObjectId', $3::text, 'imageUrl', $4::text))`,
        [ADDON_ID, PROPERTY_ID, MEDIA_OBJECT_ID, thumbnailUrl],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("rejects migrated Marketplace chat media without runtime migration evidence", async () => {
    assertSafeTestDatabase(URL!);
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES
           ($1, 'creator_workspace', 'Parity creator', 'parity-creator'),
           ($2, 'hotel_group', 'Parity hotel', 'parity-hotel')`,
        [CREATOR_ORGANIZATION_ID, HOTEL_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-private-chat', 'Parity private chat')`,
        [PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO marketplace.creator_profiles (id, organization_id)
         VALUES ($1, $2)`,
        [CREATOR_PROFILE_ID, CREATOR_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles (property_id, organization_id)
         VALUES ($1, $2)`,
        [PROPERTY_ID, HOTEL_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_offers
           (id, property_id, organization_id, title)
         VALUES ($1, $2, $3, 'Parity listing')`,
        [LISTING_ID, PROPERTY_ID, HOTEL_ORGANIZATION_ID],
      );
      await client.query(
        `INSERT INTO marketplace.collaborations
           (id, creator_profile_id, creator_organization_id, property_id,
            hotel_organization_id, offer_id, initiator_type)
         VALUES ($1, $2, $3, $4, $5, $6, 'hotel')`,
        [
          COLLABORATION_ID,
          CREATOR_PROFILE_ID,
          CREATOR_ORGANIZATION_ID,
          PROPERTY_ID,
          HOTEL_ORGANIZATION_ID,
          LISTING_ID,
        ],
      );
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, storage_kind, visibility, purpose,
            owner_organization_id, property_id, resource_product, resource_type,
            resource_id, lifecycle_status, source_metadata, public_approved, retained_until)
         VALUES ($1::uuid, 'platform-media-test',
                 'private/media/' || $1::uuid::text || '/provider_original/chat.webp',
                 'vayada_managed', 'private', 'marketplace.collaboration_chat.attachment',
                 $2, $3, 'marketplace', 'collaboration_chat_message', $4::text,
                 'active', '{}'::jsonb, FALSE, now() + interval '1 year')`,
        [MEDIA_OBJECT_ID, CREATOR_ORGANIZATION_ID, PROPERTY_ID, MESSAGE_ID],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type)
         VALUES ($1::uuid, 'provider_original', 'private',
                 'private/media/' || $1::uuid::text || '/provider_original/chat.webp', 'image/webp')`,
        [MEDIA_OBJECT_ID],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_chat_messages
           (id, collaboration_id, property_id, sender_type, message_type, body, message_metadata)
         VALUES ($1, $2, $3, 'creator', 'image', '[image attachment migrated]',
                 jsonb_build_object(
                   'mediaObjectId', $4::text,
                   'attachmentSource', 'platform_media_migration'
                 ))`,
        [MESSAGE_ID, COLLABORATION_ID, PROPERTY_ID, MEDIA_OBJECT_ID],
      );

      const evidence = await readProductionParityEvidence(config());

      expect(evidence.rawLegacyMediaReferenceCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(client);
      await client.end();
    }
  });

  it("holds a write freeze across the complete parity callback", async () => {
    assertSafeTestDatabase(URL!);
    const setup = new pg.Client({ connectionString: URL });
    await setup.connect();
    try {
      await setup.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, 'parity-write-freeze', 'Parity write freeze')`,
        [PROPERTY_ID],
      );

      await expect(
        withProductionParityTargetWriteFreeze(config(), async () => {
          const competing = new pg.Client({ connectionString: URL });
          await competing.connect();
          try {
            await competing.query("SET lock_timeout = '100ms'");
            await expect(
              competing.query(
                "UPDATE hotel_catalog.properties SET display_name = 'Changed' WHERE id = $1",
                [PROPERTY_ID],
              ),
            ).rejects.toMatchObject({ code: "55P03" });
          } finally {
            await competing.end();
          }
          return true;
        }),
      ).resolves.toBe(true);
    } finally {
      await cleanup(setup);
      await setup.end();
    }
  });
});

function config(): ProductionParityConfig {
  return {
    connectionString: URL!,
    sourceRunId: RUN_ID,
    sourceTags: {
      auth: "fixture:auth",
      booking: "fixture:booking",
      marketplace: "fixture:marketplace",
      pms: "fixture:pms",
    },
    sourceEnvironment: "local",
    environment: "local",
    applicationRelease: "a".repeat(40),
    operator: "integration-test",
    warningBudget: 0,
    migrationsDir: MIGRATIONS_DIR,
    targetMediaBucket: "platform-media-test",
    mediaCdnBaseUrl: "https://media.example.test",
  };
}

async function cleanup(client: pg.Client): Promise<void> {
  await client.query("DELETE FROM booking.booking_settings WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM booking.addon_definitions WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM pms.room_type_media WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM pms.room_types WHERE property_id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM hotel_catalog.property_media WHERE property_id = $1", [
    PROPERTY_ID,
  ]);
  await client.query(
    "DELETE FROM platform.production_media_migration_runs WHERE source_run_id = ANY($1::text[])",
    [[RUN_ID, STALE_RUN_ID]],
  );
  await client.query("DELETE FROM platform.media_objects WHERE id = ANY($1::uuid[])", [
    [MEDIA_OBJECT_ID, ROOM_MEDIA_OBJECT_ID],
  ]);
  await client.query("DELETE FROM platform.source_extraction_runs WHERE run_id = ANY($1::text[])", [
    [RUN_ID, STALE_RUN_ID],
  ]);
  await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [PROPERTY_ID]);
  await client.query("DELETE FROM marketplace.creator_profiles WHERE id = $1", [
    CREATOR_PROFILE_ID,
  ]);
  await client.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
    [CREATOR_ORGANIZATION_ID, HOTEL_ORGANIZATION_ID],
  ]);
}

type PrivateAssignmentOptions = {
  migrationRunId?: string;
  variantName?: string;
  catalogPurpose?: string;
  roomResourceId?: string;
  catalogContentType?: string;
  roomContentType?: string;
  ledger?: boolean;
  ledgerRunId?: string;
  integrity?: "missing_catalog_checksum" | "mismatched_room_checksum";
};

async function insertPrivateAssignments(
  client: pg.Client,
  options: PrivateAssignmentOptions = {},
): Promise<void> {
  const migrationRunId = options.migrationRunId ?? RUN_ID;
  const variantName = options.variantName ?? "provider_original";
  const catalogContentType = options.catalogContentType ?? "image/webp";
  const roomContentType = options.roomContentType ?? "image/webp";
  const catalogChecksum = "a".repeat(64);
  const roomChecksum = "b".repeat(64);
  const catalogStorageKey = `private/media/${MEDIA_OBJECT_ID}/provider_original/sha256-${catalogChecksum}.webp`;
  const roomStorageKey = `private/media/${ROOM_MEDIA_OBJECT_ID}/provider_original/sha256-${roomChecksum}.webp`;
  await client.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1, 'parity-private-property-media', 'Parity private property media')`,
    [PROPERTY_ID],
  );
  await client.query(
    `INSERT INTO pms.room_types (id, property_id, name, base_rate_amount, currency)
     VALUES ($1, $2, 'Parity private room', 0, 'EUR')`,
    [ROOM_TYPE_ID, PROPERTY_ID],
  );
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
        resource_product, resource_type, resource_id, lifecycle_status, source_system,
        source_table, source_row_id, source_metadata, public_approved, content_type,
        size_bytes, checksum_sha256)
     VALUES
       ($1::uuid, 'platform-media-test', $2, 'vayada_managed', 'private', $3, $4,
        'hotel_catalog', 'property', $4::uuid::text, 'active', 'marketplace',
        'hotel_profiles', 'private-hero', jsonb_build_object('migrationRunId', $5::text),
        FALSE, $11, 123, $6),
       ($7::uuid, 'platform-media-test', $8, 'vayada_managed', 'private',
        'pms.room_type.media', $4, 'pms', 'room_type', $9::uuid::text, 'active', 'pms',
        'room_types', 'private-room', jsonb_build_object('migrationRunId', $5::text),
        FALSE, $12, 456, $10)`,
    [
      MEDIA_OBJECT_ID,
      catalogStorageKey,
      options.catalogPurpose ?? "property.hero_image",
      PROPERTY_ID,
      migrationRunId,
      options.integrity === "missing_catalog_checksum" ? null : catalogChecksum,
      ROOM_MEDIA_OBJECT_ID,
      roomStorageKey,
      options.roomResourceId ?? ROOM_TYPE_ID,
      roomChecksum,
      catalogContentType,
      roomContentType,
    ],
  );
  await client.query(
    `INSERT INTO platform.media_variants
       (media_object_id, variant_name, visibility, storage_key, content_type,
        size_bytes, checksum_sha256)
     VALUES
       ($1::uuid, $2, 'private', $3, $8, 123, $4),
       ($5::uuid, $2, 'private', $6, $9, 456, $7)`,
    [
      MEDIA_OBJECT_ID,
      variantName,
      catalogStorageKey,
      catalogChecksum,
      ROOM_MEDIA_OBJECT_ID,
      roomStorageKey,
      options.integrity === "mismatched_room_checksum" ? "c".repeat(64) : roomChecksum,
      catalogContentType,
      roomContentType,
    ],
  );
  if (options.ledger !== false)
    await insertPrivateMediaLedger(client, {
      sourceRunId: options.ledgerRunId ?? migrationRunId,
      catalogPurpose: options.catalogPurpose ?? "property.hero_image",
      catalogChecksum,
      roomChecksum,
    });
  await client.query(
    `INSERT INTO hotel_catalog.property_media
       (id, property_id, media_type, url, source_system, public_approved,
        platform_media_object_id)
     VALUES ($1, $2, 'hero_image', $3, 'platform', FALSE, $4)`,
    [PROPERTY_MEDIA_ID, PROPERTY_ID, `platform-media:${MEDIA_OBJECT_ID}`, MEDIA_OBJECT_ID],
  );
  await client.query(
    `INSERT INTO pms.room_type_media
       (property_id, room_type_id, platform_media_object_id, sort_order)
     VALUES ($1, $2, $3, 0)`,
    [PROPERTY_ID, ROOM_TYPE_ID, ROOM_MEDIA_OBJECT_ID],
  );
}

async function insertPrivateMediaLedger(
  client: pg.Client,
  input: {
    sourceRunId: string;
    catalogPurpose: string;
    catalogChecksum: string;
    roomChecksum: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
     VALUES ($1, 'local', $2, 'completed', now(), 1)`,
    [input.sourceRunId, "1".repeat(40)],
  );
  await client.query(
    `INSERT INTO platform.production_media_migration_runs
       (source_run_id, inventory_sha256, config_sha256, status, planned_count,
        completed_count, report_checksum_sha256, completed_at)
     VALUES ($1, $2, $3, 'completed', 2, 2, $4, now())`,
    [input.sourceRunId, "2".repeat(64), "3".repeat(64), "4".repeat(64)],
  );
  await client.query(
    `INSERT INTO platform.production_media_migration_items
       (source_run_id, source_system, source_table, source_row_id, purpose,
        source_field, source_url, source_updated_at, source_reference_sha256,
        media_object_id, item_status, content_checksum_sha256, size_bytes,
        evidence, completed_at)
     VALUES
       ($1, 'marketplace', 'hotel_profiles', 'private-hero', $2, 'hero_image',
        'https://legacy.example.test/private-hero.webp', $3, $4, $5, 'completed',
        $6, 123, '{}'::jsonb, now()),
       ($1, 'pms', 'room_types', 'private-room', 'pms.room_type.media', 'media',
        'https://legacy.example.test/private-room.webp', $3, $7, $8, 'completed',
        $9, 456, '{}'::jsonb, now())`,
    [
      input.sourceRunId,
      input.catalogPurpose,
      "2026-01-01T00:00:00.000Z",
      "5".repeat(64),
      MEDIA_OBJECT_ID,
      input.catalogChecksum,
      "6".repeat(64),
      ROOM_MEDIA_OBJECT_ID,
      input.roomChecksum,
    ],
  );
}
