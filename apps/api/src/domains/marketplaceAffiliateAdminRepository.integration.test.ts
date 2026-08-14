import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgMarketplaceAffiliateAdminRepository } from "./marketplaceAffiliateAdminRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = randomUUID();
const propertyId = randomUUID();
const otherPropertyId = randomUUID();
const affiliateId = `affiliate-${randomUUID()}`;
const occurredAt = "2026-08-13T20:00:00.000Z";

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
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-1278 Test Actor', 'active')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
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

  it("lists and reads only the requested property scope", async () => {
    await expect(
      repository.listAffiliates({ propertyId, search: "ADA", limit: 20, offset: 0 }),
    ).resolves.toMatchObject({
      total: 1,
      affiliates: [
        {
          contractVersion: "marketplace-affiliate-admin.v1",
          affiliateId,
          propertyId,
          lifecycleStatus: "pending",
        },
      ],
    });
    await expect(repository.getAffiliate(otherPropertyId, affiliateId)).resolves.toBeNull();
  });

  it("applies, audits, replays, and rejects conflicting lifecycle commands", async () => {
    const command = {
      propertyId,
      affiliateId,
      commandId: `command-${randomUUID()}`,
      idempotencyKey: `key-${randomUUID()}`,
      action: "approve" as const,
      actorUserId,
      occurredAt,
    };
    const applied = await repository.applyLifecycle(command);
    expect(applied).toMatchObject({
      outcome: "applied",
      commandId: command.commandId,
      affiliate: { lifecycleStatus: "approved" },
    });
    await expect(repository.applyLifecycle(command)).resolves.toMatchObject({
      outcome: "replayed",
      affiliate: { lifecycleStatus: "approved" },
    });
    await expect(repository.applyLifecycle({ ...command, action: "suspend" })).resolves.toEqual({
      outcome: "idempotency_conflict",
    });
    await expect(
      repository.applyLifecycle({
        ...command,
        commandId: `invalid-${randomUUID()}`,
        idempotencyKey: `invalid-${randomUUID()}`,
        action: "restore",
      }),
    ).resolves.toEqual({ outcome: "invalid_transition", currentStatus: "approved" });

    const evidence = await admin.query<{ lifecycle: string; audit: string }>(
      `SELECT
         (SELECT count(*)::text FROM marketplace.affiliate_lifecycle_changes
          WHERE property_id = $1::uuid AND affiliate_id = $2) AS lifecycle,
         (SELECT count(*)::text FROM platform.product_audit_events
          WHERE property_id = $1::uuid AND target_resource_id = $2
            AND action = 'marketplace.affiliate.approve') AS audit`,
      [propertyId, affiliateId],
    );
    expect(evidence.rows[0]).toEqual({ lifecycle: "1", audit: "1" });
  });
});
