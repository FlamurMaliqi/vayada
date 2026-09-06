import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { syncOfferReadModel } from "./routes/marketplaceAdmin.js";

import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "77777777-7777-4777-8777-777777777971";
const propertyId = "77777777-7777-4777-8777-777777777972";
const completeOfferId = "77777777-7777-4777-8777-777777777973";

describe.skipIf(!TEST_DATABASE_URL)("adaptive marketplace offer selection", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgSharedHotelSetupStatusRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await cleanup();
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES (
         $1::uuid,
         'hotel_group',
         'Adaptive Offer Selection Test',
         'adaptive-offer-selection-test',
         'active'
       )`,
      [organizationId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (
         id,
         public_id,
         display_name,
         property_type,
         default_locale,
         supported_locales,
         profile_status
       )
       VALUES (
         $1::uuid,
         'prop_adaptive_offer_selection_972',
         'Adaptive Offer Selection Hotel',
         'hotel',
         'en',
         ARRAY['en']::text[],
         'complete'
       )`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO marketplace.marketplace_hotel_profiles (
         property_id,
         organization_id,
         marketplace_profile_status,
         profile_complete
       )
       VALUES ($1::uuid, $2::uuid, 'verified', TRUE)`,
      [propertyId, organizationId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (
         property_id,
         public_id,
         display_name,
         canonical_slug,
         default_locale,
         supported_locales,
         profile_status,
         projected_at
       )
       VALUES (
         $1::uuid,
         'prop_adaptive_offer_selection_972',
         'Adaptive Offer Selection Hotel',
         'adaptive-offer-selection-hotel',
         'en',
         ARRAY['en']::text[],
         'complete',
         now() - interval '30 minutes'
       )`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO marketplace.marketplace_offers (
         id,
         property_id,
         organization_id,
         title,
         offer_status,
         created_at,
         updated_at
       )
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'Complete older offer', 'verified',
          now() - interval '3 days', now() - interval '20 minutes'),
         ('77777777-7777-4777-8777-777777777974', $2::uuid, $3::uuid,
          'Later draft', 'draft', now() - interval '2 days', now() - interval '2 minutes'),
         ('77777777-7777-4777-8777-777777777975', $2::uuid, $3::uuid,
          'Later rejected', 'rejected', now() - interval '1 day', now() - interval '1 minute'),
         ('77777777-7777-4777-8777-777777777976', $2::uuid, $3::uuid,
          'Newest archived', 'archived', now(), now())`,
      [completeOfferId, propertyId, organizationId],
    );
    await client.query(
      `INSERT INTO marketplace.offer_deliverables (
         id,
         offer_id,
         property_id,
         organization_id,
         platform,
         deliverable_type,
         updated_at
       )
       VALUES (
         '77777777-7777-4777-8777-777777777977',
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'instagram',
         'reel',
         now() - interval '20 minutes'
       )`,
      [completeOfferId, propertyId, organizationId],
    );
    await client.query(
      `INSERT INTO marketplace.offer_compensation_options (
         id,
         offer_id,
         property_id,
         organization_id,
         compensation_type,
         paid_max_amount,
         currency,
         updated_at
       )
       VALUES (
         '77777777-7777-4777-8777-777777777978',
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'paid',
         100,
         'EUR',
         now() - interval '20 minutes'
       )`,
      [completeOfferId, propertyId, organizationId],
    );
    await client.query(
      `INSERT INTO marketplace.offer_creator_requirements (
         id,
         offer_id,
         property_id,
         organization_id,
         platforms,
         updated_at
       )
       VALUES (
         '77777777-7777-4777-8777-777777777979',
         $1::uuid,
         $2::uuid,
         $3::uuid,
         ARRAY['instagram']::text[],
         now() - interval '20 minutes'
       )`,
      [completeOfferId, propertyId, organizationId],
    );
    await client.query(
      `INSERT INTO marketplace.marketplace_offer_read_model (
         offer_id,
         property_id,
         public_id,
         canonical_slug,
         display_name,
         offer_title,
         visibility_status,
         projected_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         'offer_adaptive_complete_973',
         'adaptive-offer-selection-hotel',
         'Adaptive Offer Selection Hotel',
         'Complete older offer',
         'public',
         now()
       )`,
      [completeOfferId, propertyId],
    );
  });

  afterAll(async () => {
    await repository.close?.();
    await cleanup();
    await client.end();
  });

  it("keeps the best nonarchived readiness instead of regressing to the latest offer", async () => {
    await expect(readCreatorOfferReadiness()).resolves.toBe("complete");

    await client.query(
      `UPDATE marketplace.marketplace_offers
         SET offer_status = 'archived', updated_at = now()
         WHERE id = $1::uuid`,
      [completeOfferId],
    );

    await expect(readCreatorOfferReadiness()).resolves.toBe("actionable");
  }, 20_000);

  it("projects locality without copying catalog coordinates into marketplace offers", async () => {
    await client.query(
      `UPDATE hotel_catalog.property_public_profile_read_model
       SET location = $2::jsonb WHERE property_id = $1::uuid`,
      [propertyId, JSON.stringify({ countryCode: "DE", city: "Berlin",
        geo: { latitude: 52.52, longitude: 13.41 }, mapDisplayMode: "approximate" })],
    );
    await syncOfferReadModel(client, completeOfferId, "initialize", { catalogAlreadyProjected: true });
    const result = await client.query(
      `SELECT location FROM marketplace.marketplace_offer_read_model WHERE offer_id = $1::uuid`,
      [completeOfferId],
    );
    expect(result.rows[0]?.location).toEqual({ countryCode: "DE", city: "Berlin" });
  });

  async function readCreatorOfferReadiness(): Promise<string | undefined> {
    const result = await repository.getHotelSetupStatus({
      organizationId,
      propertyIds: [propertyId],
    });
    return result.properties[0]?.taskFacts.creator_offer.readiness;
  }

  async function cleanup(): Promise<void> {
    await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
    await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
  }
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
