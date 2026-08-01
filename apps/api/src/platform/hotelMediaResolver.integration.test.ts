import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import pg, { type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPgHotelMediaResolutionPort,
  type PgHotelMediaResolverConfig,
} from "./hotelMediaResolver.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "71717171-7171-4717-8717-717171717101";
const otherOrganizationId = "71717171-7171-4717-8717-717171717102";
const propertyId = "71717171-7171-4717-8717-717171717103";
const otherPropertyId = "71717171-7171-4717-8717-717171717104";
const roomTypeId = "71717171-7171-4717-8717-717171717105";
const mediaObjectId = "71717171-7171-7000-8717-717171717106";
const storageKey = `public/media/${mediaObjectId}/original_safe/v1.webp`;
const roomMediaObjectId = "71717171-7171-8000-9717-717171717107";
const roomStorageKey = `public/media/${roomMediaObjectId}/original_safe/v1.webp`;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL hotel media resolver", () => {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
    await cleanup();
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES
         ($1::uuid, 'hotel_group', 'Resolver tenant', 'resolver-tenant'),
         ($2::uuid, 'hotel_group', 'Other resolver tenant', 'other-resolver-tenant')`,
      [organizationId, otherOrganizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES
         ($1::uuid, 'resolver-property', 'Resolver Property'),
         ($2::uuid, 'other-resolver-property', 'Other Resolver Property')`,
      [propertyId, otherPropertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (id, property_id, name, currency)
       VALUES ($1::uuid, $2::uuid, 'Resolver Room', 'EUR')`,
      [roomTypeId, propertyId],
    );
    await admin.query(
      `INSERT INTO platform.media_objects
         (id, bucket, storage_key, storage_kind, visibility, purpose,
          owner_organization_id, property_id, resource_product, resource_type,
          resource_id, lifecycle_status, content_type, public_approved)
       VALUES
         ($1::uuid, 'vayada-media-test', $2, 'vayada_managed', 'public',
          'property.gallery_image', $3::uuid, $4::uuid, 'hotel_catalog',
          'property', $4, 'active', 'image/webp', TRUE)`,
      [mediaObjectId, storageKey, organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO platform.media_objects
         (id, bucket, storage_key, storage_kind, visibility, purpose,
          owner_organization_id, property_id, resource_product, resource_type,
          resource_id, lifecycle_status, content_type, public_approved)
       VALUES
         ($1::uuid, 'vayada-media-test', $2, 'vayada_managed', 'public',
          'pms.room_type.media', $3::uuid, $4::uuid, 'pms',
          'room_type', $5, 'active', 'image/webp', TRUE)`,
      [roomMediaObjectId, roomStorageKey, organizationId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO platform.media_variants
         (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
       VALUES ($1::uuid, 'original_safe', 'public', $2, 'image/webp', $3)`,
      [mediaObjectId, storageKey, `https://cdn.example.test/${storageKey.slice("public/".length)}`],
    );
    await admin.query(
      `INSERT INTO platform.media_variants
         (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
       VALUES ($1::uuid, 'original_safe', 'public', $2, 'image/webp', $3)`,
      [
        roomMediaObjectId,
        roomStorageKey,
        `https://cdn.example.test/${roomStorageKey.slice("public/".length)}`,
      ],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    await admin.end();
  });

  it("resolves a v7 object through the opaque property and room trust boundary", async () => {
    const adapter = resolverFor(pool);
    const port = createHotelMediaResolutionPort(adapter);
    for (const [target, requestedMediaObjectId, purpose] of [
      [{ kind: "property" as const, propertyId }, mediaObjectId, "property.gallery_image"],
      [
        { kind: "room_type" as const, propertyId, roomTypeId },
        roomMediaObjectId,
        "pms.room_type.media",
      ],
    ] as const) {
      const result = await port.resolvePublicMedia({
        ownerOrganizationId: organizationId,
        target,
        mediaObjectIds: [requestedMediaObjectId],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.batch.media[0]).toMatchObject({
          mediaObjectId: requestedMediaObjectId,
          ownerOrganizationId: organizationId,
          propertyId,
          purpose,
        });
      }
    }
  });

  it("fails closed across tenant, property, and room membership boundaries", async () => {
    const adapter = resolverFor(pool);
    for (const input of [
      {
        ownerOrganizationId: otherOrganizationId,
        target: { kind: "property" as const, propertyId },
      },
      {
        ownerOrganizationId: organizationId,
        target: { kind: "property" as const, propertyId: otherPropertyId },
      },
      {
        ownerOrganizationId: organizationId,
        target: { kind: "room_type" as const, propertyId: otherPropertyId, roomTypeId },
      },
    ]) {
      await expect(
        adapter.loadPublicMedia({ ...input, mediaObjectIds: [mediaObjectId] }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "media_not_authorized", mediaObjectIds: [mediaObjectId] },
      });
    }
  });

  it("rechecks authorization in the media query after mid-call revocation", async () => {
    let revokeAfterTarget = true;
    const revokingPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        const result = await pool.query<T>(text, [...values]);
        if (revokeAfterTarget && text.includes("hotel_media_target_resolution")) {
          revokeAfterTarget = false;
          await admin.query(
            `UPDATE identity.organization_resource_links
             SET status = 'suspended'
             WHERE organization_id = $1::uuid
               AND product = 'hotel_catalog'
               AND resource_type = 'property'
               AND resource_id = $2`,
            [organizationId, propertyId],
          );
        }
        return result;
      },
      async end() {},
    };
    const adapter = resolverFor(revokingPool);
    await expect(
      adapter.loadPublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [mediaObjectId],
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_authorized", mediaObjectIds: [mediaObjectId] },
    });
    await admin.query(
      `UPDATE identity.organization_resource_links
       SET status = 'active'
       WHERE organization_id = $1::uuid
         AND product = 'hotel_catalog'
         AND resource_type = 'property'
         AND resource_id = $2`,
      [organizationId, propertyId],
    );
  });

  function resolverFor(queryPool: NonNullable<PgHotelMediaResolverConfig["pool"]>) {
    return createPgHotelMediaResolutionPort({
      connectionString: TEST_DATABASE_URL!,
      serving: {
        bucketName: "vayada-media-test",
        cdnBaseUrl: "https://cdn.example.test",
        publicPathPrefix: "media",
      },
      pool: queryPool,
    });
  }

  async function cleanup(): Promise<void> {
    await admin.query("DELETE FROM platform.media_objects WHERE id IN ($1::uuid, $2::uuid)", [
      mediaObjectId,
      roomMediaObjectId,
    ]);
    await admin.query("DELETE FROM pms.room_types WHERE id = $1::uuid", [roomTypeId]);
    await admin.query(
      `DELETE FROM identity.organization_resource_links
       WHERE organization_id IN ($1::uuid, $2::uuid)
         AND resource_id IN ($3, $4)`,
      [organizationId, otherOrganizationId, propertyId, otherPropertyId],
    );
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id IN ($1::uuid, $2::uuid)", [
      propertyId,
      otherPropertyId,
    ]);
    await admin.query("DELETE FROM identity.organizations WHERE id IN ($1::uuid, $2::uuid)", [
      organizationId,
      otherOrganizationId,
    ]);
  }
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
