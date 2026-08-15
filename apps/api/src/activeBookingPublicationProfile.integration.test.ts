import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import pg, { type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createActiveBookingPublicationProfileRepository } from "./routes/activeBookingPublicationProfile.js";
import type { PublicHotelProfileReadPool } from "./routes/aiHotels.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const userId = "85858585-8585-4585-8585-858585858501";
const propertyA = "85858585-8585-4585-8585-858585858502";
const propertyB = "85858585-8585-4585-8585-858585858503";
const revisionA = "85858585-8585-4585-8585-858585858504";
const revisionB = "85858585-8585-4585-8585-858585858505";
const inactiveRevision = "85858585-8585-4585-8585-858585858506";
const hostname = "book.alpenrose.example";
const fixture = PUBLIC_BOOKABILITY_FIXTURES.find(({ caseId }) => caseId === "custom_domain")!;

describe.skipIf(!TEST_DATABASE_URL)("active Booking publication reads in PostgreSQL", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const pool: PublicHotelProfileReadPool = {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      return (await admin.query(text, values as unknown[])) as { rows: T[] };
    },
    async end() {},
  };
  const repository = createActiveBookingPublicationProfileRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool,
  });

  beforeAll(async () => {
    assertTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'active-profile@example.test', 'Active Profile Test', 'active')`,
      [userId],
    );
    await seedProperty(propertyA, revisionA, "hotel-alpenrose");
    await seedProperty(propertyB, revisionB, "hotel-alpenrose-next");
    await seedRevision(propertyA, inactiveRevision, "inactive-alpenrose", 2, false);
    await seedRedirect(propertyA, "former-alpenrose", "hotel-alpenrose");
  });

  afterAll(async () => {
    await admin.query("ROLLBACK");
    await admin.end();
  });

  it("stops serving a revoked domain and follows a verified reassignment", async () => {
    await assignDomain(propertyA);
    await expect(repository.findProfileByCustomDomain?.(hostname)).resolves.toMatchObject({
      hotel: { propertyId: propertyA },
    });

    await admin.query("DELETE FROM hotel_catalog.property_domains WHERE hostname = $1", [hostname]);
    await expect(repository.findProfileByCustomDomain?.(hostname)).resolves.toBeNull();

    await assignDomain(propertyB);
    await expect(repository.findProfileByCustomDomain?.(hostname)).resolves.toMatchObject({
      hotel: { propertyId: propertyB },
    });
  });

  it("resolves Catalog redirects only through the pointed active revision", async () => {
    await expect(repository.findProfileBySlug("former-alpenrose")).resolves.toMatchObject({
      hotel: { propertyId: propertyA, slug: "hotel-alpenrose" },
    });
    await expect(repository.findProfileBySlug("inactive-alpenrose")).resolves.toBeNull();
  });

  async function seedProperty(propertyId: string, revisionId: string, slug: string): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, $3)`,
      [propertyId, slug, `Active ${slug}`],
    );
    await seedRevision(propertyId, revisionId, slug, 1, true);
  }

  async function seedRevision(
    propertyId: string,
    revisionId: string,
    slug: string,
    revisionNumber: number,
    active: boolean,
  ): Promise<void> {
    const profile = structuredClone(fixture.profile);
    profile.hotel.propertyId = propertyId;
    profile.hotel.slug = slug;
    profile.hotel.name = `Active ${slug}`;
    const sourceManifest = {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [{ owner: "hotel_catalog", entityId: propertyId, revision: String(revisionNumber) }],
    };
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'onboarding-product-readiness.v1',
         $4::jsonb, $5, $6, 'booking', 'ready', $7::jsonb, $8::uuid
       )`,
      [
        revisionId,
        propertyId,
        revisionNumber,
        JSON.stringify(sourceManifest),
        `sha256:${"1".repeat(64)}`,
        `sha256:${"2".repeat(64)}`,
        JSON.stringify({ contractVersion: "booking-public-content.v1", profile }),
        userId,
      ],
    );
    if (active) {
      await admin.query(
        `INSERT INTO distribution.active_public_booking_revision
           (property_id, content_revision_id, activated_by_user_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [propertyId, revisionId, userId],
      );
    }
  }

  async function seedRedirect(propertyId: string, redirect: string, canonical: string) {
    await admin.query(
      `WITH target AS (
         INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
         VALUES ($1::uuid, $2, 'canonical', 'active')
         RETURNING id
       )
       INSERT INTO hotel_catalog.property_slugs
         (property_id, slug, purpose, status, redirects_to_id)
       SELECT $1::uuid, $3, 'redirect', 'redirected', id FROM target`,
      [propertyId, canonical, redirect],
    );
  }

  async function assignDomain(propertyId: string): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.property_domains
         (property_id, hostname, verification_status, canonical_when_verified, verified_at)
       VALUES ($1::uuid, $2, 'verified', TRUE, now())`,
      [propertyId, hostname],
    );
  }
});

function assertTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1);
  if (!database.toLowerCase().includes("test")) {
    throw new Error("Active publication integration tests require a test database");
  }
}
