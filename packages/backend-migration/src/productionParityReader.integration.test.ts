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
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
const PROPERTY_ID = "13590000-0000-4000-8000-000000000001";
const PROPERTY_MEDIA_ID = "13590000-0000-4000-8000-000000000002";
const MEDIA_OBJECT_ID = "13590000-0000-4000-8000-000000000003";

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
           (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1, 'test', 'parity/canonical.jpg', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 'canonical-hero', TRUE)`,
        [MEDIA_OBJECT_ID, PROPERTY_ID],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', 'parity/canonical.jpg', 'image/jpeg',
                 'https://cdn.example.test/parity/canonical.jpg')`,
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
  };
}

async function cleanup(client: pg.Client): Promise<void> {
  await client.query("DELETE FROM hotel_catalog.property_media WHERE property_id = $1", [
    PROPERTY_ID,
  ]);
  await client.query("DELETE FROM platform.media_objects WHERE id = $1", [MEDIA_OBJECT_ID]);
  await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [PROPERTY_ID]);
}
