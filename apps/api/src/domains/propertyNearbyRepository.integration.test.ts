import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createPgPropertyNearbyRepository } from "./propertyNearbyRepository.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("nearby curation PostgreSQL transactions", () => {
  const admin = new pg.Client({ connectionString: url });
  const repository = createPgPropertyNearbyRepository(url ?? "postgresql://disabled");
  const organizationId = randomUUID(),
    propertyId = randomUUID(),
    actorUserId = randomUUID();
  const scope = { organizationId, propertyId, actorUserId, requestId: randomUUID() };
  const customPlace = {
    id: randomUUID(),
    name: "Our beach",
    category: "nature",
    address: null,
    latitude: 0,
    longitude: 0,
    favorite: true,
    hidden: false,
    note: "Quiet at sunrise",
  };
  const write = (expectedCurationRevision = 0, expectedProfileRevision = 1) => ({
    schemaVersion: 1,
    expectedCurationRevision,
    expectedProfileRevision,
    choices: [],
    customPlaces: [customPlace],
  });
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Test database required");
    await admin.connect();
    await admin.query(
      `INSERT INTO identity.organizations(id, kind, name, slug) VALUES ($1::uuid,'hotel_group','Nearby test',$1::uuid::text)`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO identity.users(id, email, name) VALUES ($1,$2,'Nearby tester')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1,$2,'Nearby test')`,
      [propertyId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
      (organization_id,product,resource_type,resource_id,relationship,status)
      VALUES ($1,'hotel_catalog','property',$2,'owner','active')`,
      [organizationId, propertyId],
    );
  });
  afterAll(async () => {
    await repository.close();
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("DELETE FROM hotel_catalog.property_nearby_discovery WHERE property_id=$1", [
      propertyId,
    ]);
    await admin.query("DELETE FROM hotel_catalog.property_nearby_curation WHERE property_id=$1", [
      propertyId,
    ]);
    await admin.query("DELETE FROM platform.product_audit_events WHERE organization_id=$1", [
      organizationId,
    ]);
    await admin.query("DELETE FROM identity.organization_resource_links WHERE organization_id=$1", [
      organizationId,
    ]);
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    await admin.query("DELETE FROM identity.organizations WHERE id=$1", [organizationId]);
    await admin.query("DELETE FROM identity.users WHERE id=$1", [actorUserId]);
    await admin.query("COMMIT");
    await admin.end();
  });
  it("starts empty, permits only one concurrent initial save, and round-trips hotel content", async () => {
    expect(await repository.read(scope)).toMatchObject({
      curationRevision: 0,
      choices: [],
      customPlaces: [],
    });
    const results = await Promise.all([
      repository.save(scope, write()),
      repository.save(scope, write()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, code: "revision_conflict" });
    expect(await repository.read(scope)).toMatchObject({
      curationRevision: 1,
      savedProfileRevision: 1,
      customPlaces: [customPlace],
    });
    const audit = await admin.query(
      "SELECT redacted_payload FROM platform.product_audit_events WHERE organization_id=$1",
      [organizationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(customPlace.note);
  });
  it("denies another organization and unregistered IDs without altering existing choices", async () => {
    const other = { ...scope, organizationId: randomUUID() };
    expect(await repository.read(other)).toBeNull();
    expect(await repository.save(other, write(1))).toEqual({
      ok: false,
      code: "missing_property_resource_link",
    });
    expect(
      await repository.save(scope, {
        ...write(1),
        choices: [
          {
            placeId: "invented",
            category: "food",
            hidden: true,
            favorite: false,
            added: false,
            note: null,
          },
        ],
      }),
    ).toEqual({ ok: false, code: "unknown_place" });
    expect(await repository.read(scope)).toMatchObject({
      curationRevision: 1,
      customPlaces: [customPlace],
    });
  });
  it("rejects an old profile revision and retains choices for explicit reconfirmation", async () => {
    await admin.query("UPDATE hotel_catalog.properties SET profile_revision=2 WHERE id=$1", [
      propertyId,
    ]);
    expect(await repository.save(scope, write(1))).toEqual({
      ok: false,
      code: "revision_conflict",
    });
    expect(await repository.read(scope)).toMatchObject({
      profileRevision: 2,
      savedProfileRevision: 1,
    });
    expect(await repository.save(scope, write(1, 2))).toMatchObject({
      ok: true,
      state: { curationRevision: 2, savedProfileRevision: 2 },
    });
  });
  it("rolls back the content write when the required audit fails", async () => {
    const before = await repository.read(scope);
    await expect(
      repository.save(
        { ...scope, actorUserId: randomUUID() },
        { ...write(2, 2), customPlaces: [] },
      ),
    ).rejects.toThrow();
    expect(await repository.read(scope)).toEqual(before);
  });
  it("replaces the complete curation atomically and respects revoked links", async () => {
    const choice = {
      placeId: "verified",
      category: "nature",
      hidden: true,
      favorite: false,
      added: false,
      note: null,
    };
    await admin.query(
      `INSERT INTO hotel_catalog.property_nearby_discovery
      (property_id,profile_revision,policy_version,status,places,valid_until,retry_after)
      VALUES ($1,2,'nearby-v1','ready',$2::jsonb,now()-interval '1 second',now())`,
      [propertyId, JSON.stringify([{ placeId: "verified", category: "nature" }])],
    );
    const registered = { ...write(2, 2), customPlaces: [], choices: [choice] };
    expect(await repository.save(scope, registered)).toEqual({ ok: false, code: "unknown_place" });
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET valid_until=now()+interval '1 hour',profile_revision=1 WHERE property_id=$1",
      [propertyId],
    );
    expect(await repository.save(scope, registered)).toEqual({ ok: false, code: "unknown_place" });
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET profile_revision=2,policy_version='old' WHERE property_id=$1",
      [propertyId],
    );
    expect(await repository.save(scope, registered)).toEqual({ ok: false, code: "unknown_place" });
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET policy_version='nearby-v1' WHERE property_id=$1",
      [propertyId],
    );
    expect(await repository.save(scope, registered)).toMatchObject({
      ok: true,
      state: { curationRevision: 3, customPlaces: [], choices: [choice] },
    });
    await admin.query(
      "UPDATE identity.organization_resource_links SET status='archived' WHERE organization_id=$1",
      [organizationId],
    );
    expect(await repository.read(scope)).toBeNull();
    expect(await repository.save(scope, write(3, 2))).toEqual({
      ok: false,
      code: "missing_property_resource_link",
    });
  });
});
