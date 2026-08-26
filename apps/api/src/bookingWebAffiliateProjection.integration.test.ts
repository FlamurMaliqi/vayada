import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgBookingWebAffiliateRepository } from "./routes/bookingWebAffiliate.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const propertyId = randomUUID();
const slug = `vay-1278-${randomUUID()}`;

describe.skipIf(!TEST_DATABASE_URL)("Booking Web affiliate admin projection", () => {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  const repository = createPgBookingWebAffiliateRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    pool,
    now: () => new Date("2026-08-13T20:00:00.000Z"),
  });

  beforeAll(async () => {
    if (!/(test|verify)/i.test(new URL(TEST_DATABASE_URL!).pathname)) {
      throw new Error("Refusing non-test database");
    }
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'VAY-1278 Projection Hotel')`,
      [propertyId, `prop-${propertyId}`],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, $2, 'canonical', 'active')`,
      [propertyId, slug],
    );
  });

  afterAll(async () => pool.end());

  it("round-trips public registration into the canonical admin projection", async () => {
    const registration = await repository.register(slug, {
      fullName: "Ada Affiliate",
      email: "Ada@example.test",
      socialMedia: "@ada",
      userType: "creator",
    });
    const result = await pool.query(
      `SELECT affiliate_id AS "affiliateId", referral_code AS "referralCode",
              display_name AS "displayName", contact_email AS "contactEmail",
              affiliate_type AS "affiliateType", lifecycle_status AS "lifecycleStatus"
       FROM marketplace.property_affiliates
       WHERE property_id = $1::uuid AND affiliate_id = $2`,
      [propertyId, registration.id],
    );
    expect(result.rows[0]).toEqual({
      affiliateId: registration.id,
      referralCode: registration.referralCode,
      displayName: "Ada Affiliate",
      contactEmail: "ada@example.test",
      affiliateType: "creator",
      lifecycleStatus: "pending",
    });
  });

  it("does not let repeated public registration rewrite an administered profile", async () => {
    const registration = await repository.register(slug, {
      fullName: "Secure Affiliate",
      email: "security@example.test",
      userType: "creator",
    });
    await pool.query(
      `UPDATE marketplace.property_affiliates SET lifecycle_status = 'approved'
       WHERE property_id = $1::uuid AND affiliate_id = $2`,
      [propertyId, registration.id],
    );
    await repository.register(slug, {
      fullName: "Ada Updated",
      email: "security@example.test",
      userType: "creator",
    });
    const result = await pool.query(
      `SELECT display_name AS "displayName", lifecycle_status AS "lifecycleStatus"
       FROM marketplace.property_affiliates
       WHERE property_id = $1::uuid AND affiliate_id = $2`,
      [propertyId, registration.id],
    );
    const eventCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.domain_events
       WHERE resource_id = $1 AND event_type = 'marketplace.affiliate.public_registered'`,
      [registration.id],
    );
    expect(result.rows[0]).toEqual({
      displayName: "Secure Affiliate",
      lifecycleStatus: "approved",
    });
    expect(eventCount.rows[0]?.count).toBe("1");
  });
});
