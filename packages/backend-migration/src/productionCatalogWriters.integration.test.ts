import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeProductionCatalogContent } from "./productionCatalogContentWriter.js";
import { writeProductionCatalogCore } from "./productionCatalogCoreWriter.js";
import { writeProductionCatalogPresentation } from "./productionCatalogPresentationWriter.js";
import { rebuildProductionCatalogPublicProjection } from "./productionCatalogPublicProjection.js";
import type { ReconciledCatalogWrites } from "./productionCatalogReconciliation.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13540000-0000-4000-8000-000000000001";
const SLUG = "13540000-0000-4000-8000-000000000002";
const DOMAIN = "13540000-0000-4000-8000-000000000003";
const MEDIA_OBJECT = "13540000-0000-4000-8000-000000000004";
const MEDIA_ASSIGNMENT = "13540000-0000-4000-8000-000000000005";
const UPDATED = "2026-08-02T00:00:00Z";

describe.skipIf(!URL)("production catalog writers (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("writes the real target schema without exposing legacy-private fields", async () => {
    await client.query("BEGIN");
    try {
      const writes = fixtureWrites();
      expect(
        await writeProductionCatalogCore(
          client,
          writes,
          [
            {
              propertyId: PROPERTY,
              sourceSystem: "booking",
              sourceTable: "booking_hotels",
              sourceId: PROPERTY,
              relationship: "canonical_input",
            },
          ],
          "vay1351-0123456789abcdef01234567",
        ),
      ).toMatchObject({
        properties: 1,
        sourceLinks: 1,
        slugs: 1,
        locations: 1,
      });
      expect(await writeProductionCatalogContent(client, writes)).toMatchObject({
        profiles: 1,
        amenities: 1,
        contacts: 1,
        policies: 1,
      });
      await client.query(
        `INSERT INTO platform.media_objects
           (id, bucket, storage_key, visibility, purpose, property_id, resource_product,
            resource_type, lifecycle_status, source_system, source_table, source_row_id,
            public_approved)
         VALUES ($1, 'test', 'safe/original.jpg', 'public', 'property.hero_image', $2,
                 'hotel_catalog', 'property', 'active', 'booking', 'booking_hotels',
                 $3, TRUE)`,
        [MEDIA_OBJECT, PROPERTY, `${PROPERTY}:hero_image`],
      );
      await client.query(
        `INSERT INTO platform.media_variants
           (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
         VALUES ($1, 'original_safe', 'public', 'safe/original.jpg', 'image/jpeg',
                 'https://cdn.example.test/safe.jpg')`,
        [MEDIA_OBJECT],
      );
      expect(await writeProductionCatalogPresentation(client, writes)).toEqual({
        domains: 1,
        media: 1,
      });
      expect(await rebuildProductionCatalogPublicProjection(client, [PROPERTY], "run")).toBe(1);

      const stored = await client.query(
        `SELECT location, media, amenities, public_contacts AS "publicContacts"
         FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1`,
        [PROPERTY],
      );
      expect(stored.rows[0]).toMatchObject({
        location: { countryCode: "AT", city: "Vienna", timezone: "Europe/Vienna" },
        media: [{ url: "https://cdn.example.test/safe.jpg", platformMediaObjectId: MEDIA_OBJECT }],
        amenities: [],
        publicContacts: [],
      });
      expect(JSON.stringify(stored.rows[0])).not.toContain("PRIVATE RAW LOCATION");
      expect(JSON.stringify(stored.rows[0])).not.toContain("Private street");
      const assignment = await client.query(
        `SELECT url, public_approved AS "publicApproved"
         FROM hotel_catalog.property_media WHERE id = $1`,
        [MEDIA_ASSIGNMENT],
      );
      expect(assignment.rows[0]).toEqual({
        url: `platform-media:${MEDIA_OBJECT}`,
        publicApproved: true,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

function fixtureWrites(): ReconciledCatalogWrites {
  return {
    properties: [
      {
        id: PROPERTY,
        publicId: "catalog-integration",
        displayName: "Hotel",
        propertyType: "hotel",
        category: null,
        starRating: 4,
        defaultLocale: "en",
        supportedLocales: ["en"],
        profileStatus: "complete",
        completenessReasons: [],
        createdAt: UPDATED,
        updatedAt: UPDATED,
      },
    ],
    slugs: [
      {
        id: SLUG,
        propertyId: PROPERTY,
        slug: "catalog-integration",
        purpose: "canonical",
        status: "active",
        redirectsToId: null,
        updatedAt: UPDATED,
      },
    ],
    domains: [
      {
        id: DOMAIN,
        propertyId: PROPERTY,
        hostname: "catalog.example.test",
        verificationStatus: "pending",
        canonicalWhenVerified: false,
        verifiedAt: null,
        updatedAt: UPDATED,
      },
    ],
    locations: [
      {
        propertyId: PROPERTY,
        countryCode: "AT",
        region: null,
        city: "Vienna",
        streetAddress: "Private street",
        postalCode: "1010",
        rawMarketplaceLocation: "PRIVATE RAW LOCATION",
        latitude: null,
        longitude: null,
        timezone: "Europe/Vienna",
        sourceConfidence: "high",
        migrationNotes: null,
        updatedAt: UPDATED,
      },
    ],
    profiles: [
      {
        propertyId: PROPERTY,
        locale: "en",
        shortDescription: null,
        longDescription: "Public hotel description",
        sourceConfidence: "high",
        updatedAt: UPDATED,
      },
    ],
    amenities: [
      {
        propertyId: PROPERTY,
        amenityKey: "wifi",
        label: "Wi-Fi",
        sourceSystem: "booking",
        publicSafe: false,
        updatedAt: UPDATED,
      },
    ],
    contacts: [
      {
        propertyId: PROPERTY,
        channelType: "phone",
        value: "+431234",
        purpose: "general",
        isPublic: false,
        sourceSystem: "booking",
        updatedAt: UPDATED,
      },
    ],
    policies: [
      {
        propertyId: PROPERTY,
        checkInTime: "15:00",
        checkOutTime: "11:00",
        cancellationSummary: "Private terms",
        paymentPolicySummary: null,
        updatedAt: UPDATED,
      },
    ],
    media: [
      {
        id: MEDIA_ASSIGNMENT,
        propertyId: PROPERTY,
        platformMediaObjectId: MEDIA_OBJECT,
        mediaType: "hero_image",
        sortOrder: 0,
        sourceSystem: "booking",
        publicApproved: true,
        updatedAt: UPDATED,
      },
    ],
  };
}
