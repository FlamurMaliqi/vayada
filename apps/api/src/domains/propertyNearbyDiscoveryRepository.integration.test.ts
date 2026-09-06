import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createPgPropertyNearbyDiscoveryRepository } from "./propertyNearbyDiscoveryRepository.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("nearby discovery PostgreSQL leases", () => {
  const admin = new pg.Client({ connectionString: url });
  const repository = createPgPropertyNearbyDiscoveryRepository(url ?? "postgresql://disabled");
  const scope = { organizationId: randomUUID(), propertyId: randomUUID() };
  const otherPropertyId = randomUUID();
  const result = {
    status: "ready" as const,
    places: [{ placeId: "beach", category: "nature" as const, latitude: 1, longitude: 2 }],
  };
  const age = () =>
    admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET retry_after=now()-interval '1 second' WHERE property_id=$1",
      [scope.propertyId],
    );
  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Test database required");
    await admin.connect();
    await admin.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES ($1,'hotel_group','Nearby test',$1::uuid::text)",
      [scope.organizationId],
    );
    for (const id of [scope.propertyId, otherPropertyId]) {
      await admin.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1,$1::uuid::text,'Nearby test')",
        [id],
      );
      await admin.query(
        "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES ($1,'hotel_catalog','property',$2,'owner','active')",
        [scope.organizationId, id],
      );
      await admin.query(
        "INSERT INTO hotel_catalog.property_locations(property_id,latitude,longitude,geo_public,map_display_mode) VALUES ($1,-1.125,1.005,true,'approximate')",
        [id],
      );
    }
  });
  afterAll(async () => {
    await repository.close();
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role=replica");
    for (const table of ["property_nearby_discovery", "property_locations"])
      await admin.query(`DELETE FROM hotel_catalog.${table} WHERE property_id=ANY($1::uuid[])`, [
        [scope.propertyId, otherPropertyId],
      ]);
    await admin.query("DELETE FROM identity.organization_resource_links WHERE organization_id=$1", [
      scope.organizationId,
    ]);
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
      [scope.propertyId, otherPropertyId],
    ]);
    await admin.query("DELETE FROM identity.organizations WHERE id=$1", [scope.organizationId]);
    await admin.query("COMMIT");
    await admin.end();
  });
  it("grants only one concurrent claim and persists IDs without coordinates", async () => {
    const claims = await Promise.all([repository.claim(scope, 1), repository.claim(scope, 1)]);
    const claim = claims.find((c) => c.status === "claimed");
    expect(claims.filter((c) => c.status === "claimed")).toHaveLength(1);
    expect(claims).toContainEqual(
      expect.objectContaining({
        status: "state",
        state: expect.objectContaining({ status: "refreshing" }),
      }),
    );
    if (!claim || claim.status !== "claimed") throw new Error("Claim required");
    expect(claim.origin).toEqual({ latitude: -1.13, longitude: 1.01 });
    expect(await repository.complete(scope, claim.token, 1, result)).toMatchObject({
      status: "ready",
      places: [{ placeId: "beach", category: "nature" }],
    });
    const stored = await admin.query(
      "SELECT places FROM hotel_catalog.property_nearby_discovery WHERE property_id=$1",
      [scope.propertyId],
    );
    expect(stored.rows[0].places).toEqual([{ placeId: "beach", category: "nature" }]);
    expect(await repository.claim(scope, 1)).toMatchObject({
      status: "state",
      state: { status: "ready" },
    });
    expect(await repository.claim(scope, 1, true)).toMatchObject({ status: "cooldown" });
  });
  it("isolates properties, organizations and stale profile revisions", async () => {
    expect(await repository.read({ ...scope, propertyId: otherPropertyId })).toMatchObject({
      status: "stale",
      places: [],
    });
    const other = { ...scope, organizationId: randomUUID() };
    expect(await repository.read(other)).toBeNull();
    expect(await repository.claim(other, 1)).toEqual({ status: "missing_property_resource_link" });
    expect(await repository.claim(scope, 0)).toEqual({ status: "revision_conflict" });
    await age();
    const claim = await repository.claim(scope, 1, true);
    if (claim.status !== "claimed") throw new Error("Claim required");
    await admin.query("UPDATE hotel_catalog.properties SET profile_revision=2 WHERE id=$1", [
      scope.propertyId,
    ]);
    expect(await repository.complete(scope, claim.token, 1, result)).toMatchObject({
      status: "stale",
      places: [],
    });
    expect(await repository.claim(scope, 2)).toMatchObject({ status: "cooldown" });
  });
  it("discards expired leases and prevents older completions from overwriting new work", async () => {
    await age();
    const first = await repository.claim(scope, 2);
    if (first.status !== "claimed") throw new Error("Claim required");
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET lease_expires_at=now()-interval '1 second' WHERE property_id=$1",
      [scope.propertyId],
    );
    expect(await repository.complete(scope, first.token, 2, result)).toMatchObject({
      status: "stale",
      places: [],
    });
    await age();
    const second = await repository.claim(scope, 2);
    if (second.status !== "claimed") throw new Error("Claim required");
    expect(await repository.complete(scope, first.token, 2, result)).toMatchObject({
      status: "refreshing",
      places: [],
    });
    expect(
      await repository.complete(scope, second.token, 2, { status: "quota_exhausted", places: [] }),
    ).toMatchObject({ status: "quota_exhausted", places: [] });
    expect(await repository.claim(scope, 2)).toMatchObject({ status: "cooldown" });
  });
  it("keeps the hourly explicit-refresh cap after failure and abandoned work", async () => {
    const resetExplicit = () =>
      admin.query(
        "UPDATE hotel_catalog.property_nearby_discovery SET explicit_refresh_after=NULL WHERE property_id=$1",
        [scope.propertyId],
      );
    await age();
    await resetExplicit();
    const failed = await repository.claim(scope, 2, true);
    if (failed.status !== "claimed") throw new Error("Claim required");
    await repository.complete(scope, failed.token, 2, { status: "timeout", places: [] });
    await age();
    expect(await repository.claim(scope, 2, true)).toMatchObject({ status: "cooldown" });
    await resetExplicit();
    const abandoned = await repository.claim(scope, 2, true);
    if (abandoned.status !== "claimed") throw new Error("Claim required");
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET lease_expires_at=now()-interval '1 second' WHERE property_id=$1",
      [scope.propertyId],
    );
    await age();
    expect(await repository.claim(scope, 2, true)).toMatchObject({ status: "cooldown" });
  });
  it("expires snapshots, suppresses private locations and respects revoked links", async () => {
    await age();
    const claim = await repository.claim(scope, 2);
    if (claim.status !== "claimed") throw new Error("Claim required");
    await repository.complete(scope, claim.token, 2, result);
    await admin.query(
      "UPDATE hotel_catalog.property_nearby_discovery SET valid_until=now()-interval '1 second' WHERE property_id=$1",
      [scope.propertyId],
    );
    expect(await repository.read(scope)).toMatchObject({ status: "stale", places: [] });
    await admin.query(
      "UPDATE hotel_catalog.property_locations SET geo_public=false WHERE property_id=$1",
      [scope.propertyId],
    );
    expect(await repository.claim(scope, 2)).toMatchObject({
      status: "state",
      state: { status: "location_required", places: [] },
    });
    await admin.query(
      "UPDATE identity.organization_resource_links SET status='archived' WHERE organization_id=$1",
      [scope.organizationId],
    );
    expect(await repository.complete(scope, claim.token, 2, result)).toBeNull();
    expect(await repository.read(scope)).toBeNull();
  });
});
