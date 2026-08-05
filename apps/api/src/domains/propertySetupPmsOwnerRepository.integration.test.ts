import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPropertySetupPmsOwnerRepository } from "./propertySetupPmsOwnerRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "19400000-0000-4000-8000-000000000001";
const propertyId = "19400000-0000-4000-8000-000000000002";
const roomTypeId = "19400000-0000-4000-8000-000000000003";
const roomUnitId = "19400000-0000-4000-8000-000000000004";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL property setup PMS owner state", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createPgPropertySetupPmsOwnerRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("reads current canonical revisions and fails closed after PMS scope revocation", async () => {
    await expect(repository.getRoomOwnerSnapshot({ organizationId, propertyId })).resolves.toEqual({
      organizationId,
      propertyId,
      rooms: [
        expect.objectContaining({
          roomTypeId,
          roomFactsRevision: 2,
          roomUnitsRevision: 3,
          activeUnitCount: 1,
          roomMediaRevision: 4,
          mediaAssignmentCount: 0,
          roomAmenitiesRevision: 2,
          amenitiesReviewed: true,
        }),
      ],
    });
    await expect(
      repository.getInventoryOwnerSnapshot({ organizationId, propertyId }),
    ).resolves.toBeNull();

    await admin.query(
      `UPDATE identity.organization_resource_links
          SET status = 'suspended'
        WHERE organization_id = $1::uuid
          AND product = 'pms'
          AND resource_type = 'pms_property'
          AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );
    await expect(repository.getRoomOwnerSnapshot({ organizationId, propertyId })).rejects.toThrow(
      "scope is unavailable",
    );
  });

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1049 PMS Owner', 'vay1049-pms-owner', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1049-pms-owner', 'VAY-1049 PMS Owner')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, source_system, name, description, category,
         occupancy_limits, room_attributes, amenities_snapshot, active,
         room_facts_revision, room_units_revision, room_media_revision,
         room_amenities_revision, room_amenities_reviewed_at
       ) VALUES (
         $1::uuid, $2::uuid, 'pms', 'Garden Suite', 'A quiet garden suite.', 'suite',
         '{"total":3,"adults":2,"children":1}'::jsonb,
         '{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,"bathroomType":"private","size":{"value":30,"unit":"sqm"}}'::jsonb,
         '[]'::jsonb, TRUE, 2, 3, 4, 2, now()
       )`,
      [roomTypeId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.rooms (
         id, property_id, room_type_id, source_system, room_number, status,
         operational_label_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'pms', NULL, 'available', 'unverified')`,
      [roomUnitId, propertyId, roomTypeId],
    );
  }

  async function cleanup(): Promise<void> {
    if (!TEST_DATABASE_URL) return;
    await admin.query("BEGIN");
    try {
      await admin.query("DELETE FROM pms.rooms WHERE property_id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]);
      await admin.query(
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        [organizationId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
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
