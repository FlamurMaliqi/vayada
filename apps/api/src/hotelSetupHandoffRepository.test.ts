import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPgHotelSetupHandoffRepository,
  type HotelSetupHandoffBinding,
  type HotelSetupHandoffRepository,
} from "./domains/hotelSetupHandoffRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("hotel setup handoff PostgreSQL repository", () => {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const membershipId = randomUUID();
  const propertyId = randomUUID();
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  let now = new Date("2026-07-26T18:00:00.000Z");
  let codeSequence = 1;
  let repository!: HotelSetupHandoffRepository;

  const binding: HotelSetupHandoffBinding = {
    internalUserId: userId,
    providerSessionId: "session-pg-owner",
    organizationId,
    membershipId,
  };

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await client.connect();
    await client.query(
      `INSERT INTO identity.users (id, email, status)
       VALUES ($1::uuid, $2, 'active')`,
      [userId, `${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Handoff Repository Test', $2, 'active')`,
      [organizationId, `handoff-test-${organizationId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (
         id, organization_id, user_id, status, role_key
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', 'hotel_owner')`,
      [membershipId, organizationId, userId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'Handoff Repository Test')`,
      [propertyId, `handoff-test-${propertyId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id,
         product,
         resource_type,
         resource_id,
         relationship,
         status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    repository = createPgHotelSetupHandoffRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => now,
      generateCode: () => Buffer.alloc(32, codeSequence++).toString("base64url"),
    });
  });

  afterAll(async () => {
    await repository?.close();
    await client.query(
      "DELETE FROM hotel_catalog.setup_handoffs WHERE organization_id = $1::uuid",
      [organizationId],
    );
    await client.query(
      "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
      [organizationId],
    );
    await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
    await client.query("DELETE FROM identity.organization_memberships WHERE id = $1::uuid", [
      membershipId,
    ]);
    await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
    await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [userId]);
    await client.end();
  });

  it("stores only the digest and atomically consumes one race winner", async () => {
    const issued = await repository.issue({
      binding,
      propertyId,
      taskId: "rooms_rates_availability",
      issuedPlanRevision: "tracks:1|rooms_rates_availability:rooms-r1:fresh",
      destinationRouteKey: "pms.rooms_rates_availability",
      returnUrl: `https://marketplace.vayada.com/setup?propertyId=${propertyId}`,
    });
    const persisted = await client.query<{ digest: string; persisted: Record<string, unknown> }>(
      `SELECT
         encode(code_sha256, 'hex') AS digest,
         to_jsonb(handoff) AS persisted
       FROM hotel_catalog.setup_handoffs handoff
       WHERE organization_id = $1::uuid`,
      [organizationId],
    );
    expect(persisted.rows[0]!.digest).toBe(createHash("sha256").update(issued.code).digest("hex"));
    expect(JSON.stringify(persisted.rows[0]!.persisted)).not.toContain(issued.code);

    const active = await repository.findActive(issued.code);
    expect(active).not.toBeNull();
    const [left, right] = await Promise.all([
      repository.consume({ id: active!.id, code: issued.code, binding }),
      repository.consume({ id: active!.id, code: issued.code, binding }),
    ]);
    expect([left, right].filter(Boolean)).toHaveLength(1);
    const winner = left ?? right;
    expect(winner?.access.permissions).toContain("hotel_catalog.setup.read");
    expect(winner?.access.linkedResources).toContainEqual({
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      relationship: "owner",
      status: "active",
    });
    await expect(repository.findActive(issued.code)).resolves.toBeNull();
  });

  it("revalidates current access before consuming and rejects expiry", async () => {
    const issued = await repository.issue({
      binding,
      propertyId,
      taskId: "payment",
      issuedPlanRevision: "tracks:1|payment:payment-r1:fresh",
      destinationRouteKey: "finance.payment",
      returnUrl: `https://marketplace.vayada.com/setup?propertyId=${propertyId}`,
    });
    const active = (await repository.findActive(issued.code))!;
    await expect(
      repository.consume({
        id: active.id,
        code: issued.code,
        binding: { ...binding, organizationId: randomUUID() },
      }),
    ).resolves.toBeNull();

    await client.query(
      "UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = $1::uuid",
      [membershipId],
    );
    await expect(
      repository.consume({ id: active.id, code: issued.code, binding }),
    ).resolves.toBeNull();
    await expect(repository.findActive(issued.code)).resolves.not.toBeNull();
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active' WHERE id = $1::uuid",
      [membershipId],
    );
    await expect(
      repository.consume({ id: active.id, code: issued.code, binding }),
    ).resolves.not.toBeNull();

    const expiring = await repository.issue({
      binding,
      propertyId,
      taskId: "payment",
      issuedPlanRevision: "tracks:1|payment:payment-r1:fresh",
      destinationRouteKey: "finance.payment",
      returnUrl: `https://marketplace.vayada.com/setup?propertyId=${propertyId}`,
    });
    now = new Date(expiring.expiresAt);
    await expect(repository.findActive(expiring.code)).resolves.toBeNull();
  });
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
