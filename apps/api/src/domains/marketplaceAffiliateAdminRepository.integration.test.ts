import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgMarketplaceAffiliateAdminRepository } from "./marketplaceAffiliateAdminRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = randomUUID();
const otherPropertyId = randomUUID();
const affiliateId = `affiliate-${randomUUID()}`;

describe.skipIf(!TEST_DATABASE_URL)("Marketplace affiliate admin PostgreSQL repository", () => {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgMarketplaceAffiliateAdminRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });

  beforeAll(async () => {
    const databaseName = new URL(TEST_DATABASE_URL!).pathname;
    if (!/(test|verify)/i.test(databaseName)) throw new Error("Refusing non-test database");
    await admin.connect();
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'VAY-1278 Affiliate Hotel'),
              ($3::uuid, $4, 'VAY-1278 Other Hotel')`,
      [propertyId, `prop-${propertyId}`, otherPropertyId, `prop-${otherPropertyId}`],
    );
    await admin.query(
      `INSERT INTO marketplace.property_affiliates (
         property_id, affiliate_id, referral_code, display_name, contact_email,
         affiliate_type, lifecycle_status, application_source
       ) VALUES ($1::uuid, $2, $3, 'Ada Affiliate', 'ada@example.test',
         'creator', 'pending', 'public_registration')`,
      [propertyId, affiliateId, `ref-${affiliateId}`],
    );
  });

  afterAll(async () => {
    await repository.close?.();
    await admin.end();
  });

  it("reads only the requested property scope for Finance continuity", async () => {
    await expect(repository.getAffiliate(propertyId, affiliateId)).resolves.toMatchObject({
      contractVersion: "marketplace-affiliate-admin.v1",
      affiliateId,
      propertyId,
      lifecycleStatus: "pending",
    });
    await expect(repository.getAffiliate(otherPropertyId, affiliateId)).resolves.toBeNull();
  });
});
