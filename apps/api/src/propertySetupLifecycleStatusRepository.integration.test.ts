import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgBookingSetupLifecycleStatusRepository } from "./domains/bookingSetupLifecycleStatusRepository.js";
import { createPgMarketplaceSetupLifecycleStatusRepository } from "./domains/marketplaceSetupLifecycleStatusRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "14900000-0000-4000-8000-000000000001";
const propertyId = "14900000-0000-4000-8000-000000000002";
const actorUserId = "14900000-0000-4000-8000-000000000003";
const submissionRevisionId = "14900000-0000-4000-8000-000000000004";
const bookingRevisionId = "14900000-0000-4000-8000-000000000005";

describe.skipIf(!TEST_DATABASE_URL)("Review lifecycle PostgreSQL adapters", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const marketplace = createPgMarketplaceSetupLifecycleStatusRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool: client,
  });
  const booking = createPgBookingSetupLifecycleStatusRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool: client,
  });
  const scope = { organizationId, propertyId, actorUserId };

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay-1049-review@example.test', 'VAY-1049 Review', 'active')`,
      [actorUserId],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1049 Lifecycle Test', 'vay-1049-lifecycle-test', 'active')`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key, access_origin
       ) VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner', 'agency')`,
      [organizationId, actorUserId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (
         id, public_id, display_name, profile_status
       ) VALUES ($1::uuid, 'prop_vay_1049_lifecycle_test', 'VAY-1049 Lifecycle Hotel', 'complete')`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO marketplace.marketplace_hotel_profiles (
         property_id, organization_id, marketplace_profile_status, profile_complete
       ) VALUES ($1::uuid, $2::uuid, 'verified', TRUE)`,
      [propertyId, organizationId],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       ) VALUES
         ($1::uuid, 'marketplace', 'hotel_profile', $2::text, 'owner', 'active'),
         ($1::uuid, 'marketplace', 'hotel_profile', $2::text, 'operator', 'active'),
         ($1::uuid, 'booking', 'booking_hotel', $2::text, 'owner', 'active'),
         ($1::uuid, 'booking', 'booking_hotel', $2::text, 'operator', 'active')`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id
       ) VALUES
         ($1::uuid, 'marketplace', 'marketplace-hotel-profile', 'active',
          'marketplace', 'hotel_profile', $2::text),
         ($1::uuid, 'booking', 'booking-engine', 'active',
          'booking', 'booking_hotel', $2::text)`,
      [organizationId, propertyId],
    );
  });

  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("reads authorized not-started lifecycle state without setup or readiness proxies", async () => {
    await expect(marketplace.getMarketplaceSetupLifecycleStatus(scope)).resolves.toMatchObject({
      ...scope,
      product: "marketplace",
      phase: "not_started",
    });
    await expect(booking.getBookingSetupLifecycleStatus(scope)).resolves.toMatchObject({
      ...scope,
      product: "booking",
      phase: "not_started",
    });
  });

  it("reads Marketplace moderation and activation from its lifecycle tables", async () => {
    await client.query(
      `INSERT INTO marketplace.hotel_submission_revisions (
         id, property_id, organization_id, revision_number,
         readiness_contract_version, source_manifest, source_manifest_hash,
         readiness_hash, readiness_product, readiness_status,
         submission_snapshot, submitted_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 1,
         'onboarding-product-readiness.v1', $4::jsonb, $5, $5,
         'marketplace', 'ready', '{}'::jsonb, $6::uuid
       )`,
      [
        submissionRevisionId,
        propertyId,
        organizationId,
        sourceManifest(),
        `sha256:${"1".repeat(64)}`,
        actorUserId,
      ],
    );
    await client.query(
      `INSERT INTO marketplace.hotel_submission_moderation (
         submission_revision_id, property_id, status
       ) VALUES ($1::uuid, $2::uuid, 'pending')`,
      [submissionRevisionId, propertyId],
    );
    const pending = await marketplace.getMarketplaceSetupLifecycleStatus(scope);
    expect(pending).toMatchObject({ phase: "pending_review" });

    await client.query(
      `UPDATE marketplace.hotel_submission_moderation
       SET status = 'approved', decided_by_user_id = $3::uuid,
           decided_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE submission_revision_id = $1::uuid AND property_id = $2::uuid`,
      [submissionRevisionId, propertyId, actorUserId],
    );
    await client.query(
      `INSERT INTO marketplace.active_hotel_submission_revisions (
         property_id, submission_revision_id, activated_by_user_id,
         status_changed_by_user_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid)`,
      [propertyId, submissionRevisionId, actorUserId],
    );
    const published = await marketplace.getMarketplaceSetupLifecycleStatus(scope);
    expect(published).toMatchObject({ phase: "published" });
    expect(published.sourceRevision).not.toBe(pending.sourceRevision);
  });

  it("reads Booking publication only from the active Distribution pointer", async () => {
    await client.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, 1, 'onboarding-product-readiness.v1',
         $3::jsonb, $4, $4, 'booking', 'ready', '{}'::jsonb, $5::uuid
       )`,
      [bookingRevisionId, propertyId, sourceManifest(), `sha256:${"2".repeat(64)}`, actorUserId],
    );
    await client.query(
      `INSERT INTO distribution.active_public_booking_revision (
         property_id, content_revision_id, activated_by_user_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [propertyId, bookingRevisionId, actorUserId],
    );
    await expect(booking.getBookingSetupLifecycleStatus(scope)).resolves.toMatchObject({
      phase: "published",
      sourceRevision: expect.stringMatching(/^booking-review:sha256:[0-9a-f]{64}$/),
    });
  });

  it("rejects an actor without the authorized membership boundary", async () => {
    const unauthorized = { ...scope, actorUserId: "14900000-0000-4000-8000-000000000099" };
    await expect(marketplace.getMarketplaceSetupLifecycleStatus(unauthorized)).rejects.toThrow(
      "scope is unavailable",
    );
    await expect(booking.getBookingSetupLifecycleStatus(unauthorized)).rejects.toThrow(
      "scope is unavailable",
    );
  });

  it("rejects suspended entitlements and inactive resource relationships", async () => {
    await client.query(
      `UPDATE identity.product_entitlements
       SET status = 'suspended'
       WHERE organization_id = $1::uuid
         AND product = 'marketplace'
         AND entitlement_key = 'marketplace-hotel-profile'`,
      [organizationId],
    );
    await expect(marketplace.getMarketplaceSetupLifecycleStatus(scope)).rejects.toThrow(
      "scope is unavailable",
    );

    await client.query(
      `UPDATE identity.organization_resource_links
       SET status = 'suspended'
       WHERE organization_id = $1::uuid
         AND product = 'booking'
         AND resource_type = 'booking_hotel'
         AND resource_id = $2::text`,
      [organizationId, propertyId],
    );
    await expect(booking.getBookingSetupLifecycleStatus(scope)).rejects.toThrow(
      "scope is unavailable",
    );
  });
});

function sourceManifest(): string {
  return JSON.stringify({
    contractVersion: "onboarding-source-manifest.v1",
    propertyId,
    sources: [
      {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: propertyId,
        revision: "profile-r1",
      },
    ],
  });
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
