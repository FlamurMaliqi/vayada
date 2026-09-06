import { randomUUID } from "node:crypto";
import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgPmsModuleActivationRepository } from "./routes/pmsModuleActivations.js";
import { createPgBookingWebAffiliateHotelResolver } from "./routes/bookingWebAffiliate.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
describe.skipIf(!databaseUrl)("Feature Hub data preservation", () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  const propertyId = randomUUID();
  const organizationId = randomUUID();
  const slug = `vay851-${propertyId}`;
  const context = {
    actor: { internalUserId: randomUUID() },
    selectedOrganization: { organizationId },
  } as RequestContext;
  const repository = createPgPmsModuleActivationRepository({
    connectionString: databaseUrl ?? "postgresql://test-disabled",
    pool: client,
  });
  const resolver = createPgBookingWebAffiliateHotelResolver({
    connectionString: databaseUrl ?? "postgresql://test-disabled",
    pool: client,
  });
  beforeAll(async () => {
    if (!/(test|verify)/i.test(new URL(databaseUrl!).pathname))
      throw new Error("Refusing non-test database");
    await client.connect();
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES ($1, 'hotel_group', 'Toggle test', $2, 'active')`,
      [organizationId, slug],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1, $2, 'Toggle test')`,
      [propertyId, slug],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status) VALUES ($1, $2, 'canonical', 'active')`,
      [propertyId, slug],
    );
    await client.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (property_id, public_id, display_name, canonical_slug, default_locale, supported_locales, profile_status) VALUES ($1, $2, 'Toggle test', $2, 'en', ARRAY['en'], 'complete')`,
      [propertyId, slug],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status) VALUES ($1, 'pms', 'pms_property', $2, 'owner', 'active'), ($1, 'booking', 'booking_hotel', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id, starts_at)
       VALUES ($1, 'pms', 'module:affiliates', 'active', 'pms', 'pms_property', $2, now())`,
      [organizationId, propertyId],
    );
    await client.query(
      `INSERT INTO marketplace.property_affiliates (property_id, affiliate_id, referral_code, display_name, contact_email, lifecycle_status, application_source) VALUES ($1, 'existing-partner', 'retained-code', 'Existing Partner', 'partner@example.test', 'approved', 'public_registration')`,
      [propertyId],
    );
  });
  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });
  it("reads existing activation and public affiliate capability without changing partner history", async () => {
    const snapshot = () =>
      client.query(`SELECT * FROM marketplace.property_affiliates WHERE property_id = $1`, [
        propertyId,
      ]);
    const before = (await snapshot()).rows;
    expect((await repository.list(context, propertyId))[0].isActive).toBe(true);
    expect(await resolver.findProfileBySlug(slug)).toMatchObject({
      hotel: { capabilities: { referralCodes: true } },
    });
    expect((await snapshot()).rows).toEqual(before);
  });
});
