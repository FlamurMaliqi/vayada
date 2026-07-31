import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createPgHotelSetupTrackCommandRepository,
  parseStoredHotelSetupTrackCommandResult,
  type HotelSetupTrackCommand,
  type HotelSetupTrackCommandRepository,
} from "./domains/hotelSetupTrackCommandRepository.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const occurredAt = "2026-07-26T16:00:00.000Z";

describe("stored hotel setup track command results", () => {
  it("accepts complete success and conflict results", () => {
    expect(
      parseStoredHotelSetupTrackCommandResult({
        ok: true,
        response: {
          trackRevision: 1,
          selectedTracks: ["hotel_operations"],
          tracks: [
            {
              track: "hotel_operations",
              provisioning: "active",
              components: [
                { product: "pms", access: "active" },
                { product: "booking", access: "active" },
              ],
              allowedActions: ["manage_service"],
            },
            {
              track: "creator_marketplace",
              provisioning: "not_selected",
              components: [{ product: "marketplace", access: "absent" }],
              allowedActions: ["add"],
            },
          ],
        },
      }),
    ).not.toBeNull();
    expect(
      parseStoredHotelSetupTrackCommandResult({
        ok: false,
        error: { code: "track_revision_conflict", currentRevision: 1 },
      }),
    ).not.toBeNull();
  });

  it.each([
    {},
    { ok: true, response: {} },
    { ok: true, response: { trackRevision: 1, selectedTracks: [], tracks: [] } },
    { ok: false },
    { ok: false, error: {} },
    { ok: false, error: { code: "unknown_error" } },
  ])("rejects malformed persisted result metadata: %j", (stored) => {
    expect(parseStoredHotelSetupTrackCommandResult(stored)).toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("hotel setup track command repository", () => {
  const organizationIds: string[] = [];
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  let client: pg.Client;
  let repository: HotelSetupTrackCommandRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    repository = createPgHotelSetupTrackCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => new Date(occurredAt),
    });
  });

  afterEach(async () => {
    if (organizationIds.length === 0) return;
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        "platform.product_audit_events",
        "platform.idempotency_keys",
        "finance.billing_entitlements",
        "identity.organization_resource_links",
        "identity.product_entitlements",
        "hotel_catalog.organization_setup_track_intents",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, [
          organizationIds,
        ]);
      }
      await client.query(
        `DELETE FROM booking.booking_settings WHERE property_id = ANY($1::uuid[])`,
        [propertyIds],
      );
      await client.query(
        `DELETE FROM marketplace.marketplace_hotel_profiles WHERE property_id = ANY($1::uuid[])`,
        [propertyIds],
      );
      await client.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
        propertyIds,
      ]);
      await client.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [userIds]);
      await client.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
        organizationIds,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      organizationIds.length = 0;
      propertyIds.length = 0;
      userIds.length = 0;
    }
  });

  afterAll(async () => {
    await repository.close();
    await client.end();
  });

  it("creates, replays, extends, reconciles, and protects a setup intent", async () => {
    const fixture = await createFixture();
    const operations = command(fixture, {
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
      idempotencyKey: "setup-operations",
    });

    const created = await repository.updateTracks(operations);
    expect(created).toMatchObject({
      ok: true,
      response: {
        trackRevision: 1,
        selectedTracks: ["hotel_operations"],
        tracks: [
          {
            track: "hotel_operations",
            provisioning: "active",
            components: [
              { product: "pms", access: "active" },
              { product: "booking", access: "active" },
            ],
          },
          { track: "creator_marketplace", provisioning: "not_selected" },
        ],
      },
    });
    expect(await selectedProducts(fixture.organizationId)).toEqual(["booking", "pms"]);
    expect(await linkedProducts(fixture.organizationId)).toEqual(["booking", "pms"]);
    expect(await count("booking.booking_settings", "property_id", fixture.propertyId)).toBe(1);
    expect(
      await count("platform.product_audit_events", "organization_id", fixture.organizationId),
    ).toBe(1);

    const replay = await repository.updateTracks(operations);
    expect(replay).toEqual(created);
    expect(
      await count("platform.product_audit_events", "organization_id", fixture.organizationId),
    ).toBe(1);

    const reusedKey = await repository.updateTracks({
      ...operations,
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      expectedRevision: 1,
    });
    expect(reusedKey).toMatchObject({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });

    const stale = await repository.updateTracks(
      command(fixture, {
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        expectedRevision: 0,
        idempotencyKey: "setup-stale",
      }),
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "track_revision_conflict", currentRevision: 1 },
    });

    const extended = await repository.updateTracks(
      command(fixture, {
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        expectedRevision: 1,
        idempotencyKey: "setup-both",
      }),
    );
    expect(extended).toMatchObject({
      ok: true,
      response: {
        trackRevision: 2,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
      },
    });
    expect(await selectedProducts(fixture.organizationId)).toEqual([
      "booking",
      "marketplace",
      "pms",
    ]);
    expect(
      await count("marketplace.marketplace_hotel_profiles", "property_id", fixture.propertyId),
    ).toBe(1);

    await client.query(
      `DELETE FROM marketplace.marketplace_hotel_profiles WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    await client.query(
      `DELETE FROM identity.organization_resource_links
       WHERE organization_id = $1::uuid AND product = 'marketplace'`,
      [fixture.organizationId],
    );
    const reconciled = await repository.updateTracks(
      command(fixture, {
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        expectedRevision: 2,
        idempotencyKey: "setup-reconcile",
      }),
    );
    expect(reconciled).toMatchObject({
      ok: true,
      response: { trackRevision: 2 },
    });
    expect(await linkedProducts(fixture.organizationId)).toEqual(["booking", "marketplace", "pms"]);

    const removal = await repository.updateTracks(
      command(fixture, {
        selectedTracks: ["creator_marketplace"],
        expectedRevision: 2,
        idempotencyKey: "setup-remove",
      }),
    );
    expect(removal).toMatchObject({
      ok: false,
      error: {
        code: "track_removal_requires_service_management",
        currentRevision: 2,
      },
    });
  });

  it("records blocked intent without creating either half of Operations", async () => {
    const suspended = await createFixture();
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'booking', 'booking-engine', 'suspended',
         $2::timestamptz, '{"source":"adaptive_hotel_setup"}'::jsonb
       )`,
      [suspended.organizationId, occurredAt],
    );

    const suspendedResult = await repository.updateTracks(
      command(suspended, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-suspended",
      }),
    );
    expect(suspendedResult).toMatchObject({
      ok: true,
      response: {
        trackRevision: 1,
        selectedTracks: ["hotel_operations"],
      },
    });
    expect(
      suspendedResult.ok
        ? suspendedResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [
        { product: "pms", access: "absent" },
        { product: "booking", access: "suspended" },
      ],
    });
    expect(await selectedProducts(suspended.organizationId)).toEqual([]);
    expect(await linkedProducts(suspended.organizationId)).toEqual([]);

    await client.query(
      `UPDATE identity.product_entitlements
       SET starts_at = NULL, expires_at = $2::timestamptz - interval '1 second'
       WHERE organization_id = $1::uuid AND product = 'booking'`,
      [suspended.organizationId, occurredAt],
    );
    const retried = await repository.updateTracks(
      command(suspended, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 1,
        idempotencyKey: "setup-suspension-expired",
      }),
    );
    expect(retried).toMatchObject({
      ok: true,
      response: {
        trackRevision: 1,
        tracks: [
          { track: "hotel_operations", provisioning: "active" },
          { track: "creator_marketplace", provisioning: "not_selected" },
        ],
      },
    });
    expect(await selectedProducts(suspended.organizationId)).toEqual(["booking", "pms"]);
    expect(await linkedProducts(suspended.organizationId)).toEqual(["booking", "pms"]);

    const billing = await createFixture();
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, product, entitlement_key, billing_status, billing_provider
       )
       VALUES ($1::uuid, 'pms', 'property-management', 'active', 'manual')`,
      [billing.organizationId],
    );
    const billingResult = await repository.updateTracks(
      command(billing, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-billing",
      }),
    );
    expect(billingResult.ok).toBe(true);
    expect(
      billingResult.ok
        ? billingResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [
        { product: "pms", access: "unavailable" },
        { product: "booking", access: "absent" },
      ],
    });
    expect(await selectedProducts(billing.organizationId)).toEqual([]);
    expect(await linkedProducts(billing.organizationId)).toEqual([]);

    const activeBilling = await createFixture();
    const entitlement = await client.query<{ id: string }>(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active', $2::timestamptz,
         '{"source":"finance"}'::jsonb
       )
       RETURNING id`,
      [activeBilling.organizationId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, identity_entitlement_id, product, entitlement_key,
         billing_status, billing_provider
       )
       VALUES ($1::uuid, $2::uuid, 'pms', 'property-management', 'active', 'manual')`,
      [activeBilling.organizationId, entitlement.rows[0]!.id],
    );
    const activeBillingResult = await repository.updateTracks(
      command(activeBilling, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-active-billing",
      }),
    );
    expect(activeBillingResult).toMatchObject({
      ok: true,
      response: {
        tracks: [
          { track: "hotel_operations", provisioning: "active" },
          { track: "creator_marketplace", provisioning: "not_selected" },
        ],
      },
    });
    const pmsEntitlements = await client.query<{ entitlementKey: string; source: string }>(
      `SELECT entitlement_key AS "entitlementKey", metadata ->> 'source' AS source
       FROM identity.product_entitlements
       WHERE organization_id = $1::uuid AND product = 'pms'`,
      [activeBilling.organizationId],
    );
    expect(pmsEntitlements.rows).toEqual([
      { entitlementKey: "property-management", source: "finance" },
    ]);

    const suspendedBilling = await createFixture();
    const suspendedIdentity = await client.query<{ id: string }>(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active', $2::timestamptz,
         '{"source":"finance"}'::jsonb
       )
       RETURNING id`,
      [suspendedBilling.organizationId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, identity_entitlement_id, product, entitlement_key,
         billing_status, billing_provider
       )
       VALUES ($1::uuid, $2::uuid, 'pms', 'property-management', 'suspended', 'manual')`,
      [suspendedBilling.organizationId, suspendedIdentity.rows[0]!.id],
    );
    const suspendedBillingResult = await repository.updateTracks(
      command(suspendedBilling, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-suspended-billing",
      }),
    );
    expect(
      suspendedBillingResult.ok
        ? suspendedBillingResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [
        { product: "pms", access: "suspended" },
        { product: "booking", access: "absent" },
      ],
    });
    expect(await linkedProducts(suspendedBilling.organizationId)).toEqual([]);

    const futureBilling = await createFixture();
    const futureBillingIdentity = await client.query<{ id: string }>(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active', $2::timestamptz,
         '{"source":"finance"}'::jsonb
       )
       RETURNING id`,
      [futureBilling.organizationId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, identity_entitlement_id, product, entitlement_key,
         billing_status, billing_provider, starts_at
       )
       VALUES (
         $1::uuid, $2::uuid, 'pms', 'property-management', 'suspended', 'manual',
         $3::timestamptz + interval '1 day'
       )`,
      [futureBilling.organizationId, futureBillingIdentity.rows[0]!.id, occurredAt],
    );
    const futureBillingResult = await repository.updateTracks(
      command(futureBilling, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-future-billing-suspension",
      }),
    );
    expect(
      futureBillingResult.ok
        ? futureBillingResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({
      provisioning: "active",
      components: [
        { product: "pms", access: "active" },
        { product: "booking", access: "active" },
      ],
    });

    const resourceScoped = await createFixture();
    const secondPropertyId = await addProperty(resourceScoped.organizationId);
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'active',
         'pms', 'pms_property', $2, $3::timestamptz,
         '{"source":"finance"}'::jsonb
      )`,
      [resourceScoped.organizationId, resourceScoped.propertyId, occurredAt],
    );
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'pms', 'property-management', 'suspended',
         'pms', 'pms_property', $2, $3::timestamptz,
         '{"source":"finance"}'::jsonb
       )`,
      [resourceScoped.organizationId, secondPropertyId, occurredAt],
    );
    await client.query(
      `INSERT INTO finance.billing_entitlements (
         organization_id, product, entitlement_key, billing_status, billing_provider
       )
       VALUES ($1::uuid, 'pms', 'housekeeping-addon', 'active', 'manual')`,
      [resourceScoped.organizationId],
    );

    const resourceScopedResult = await repository.updateTracks(
      command(resourceScoped, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-resource-scoped",
      }),
    );
    expect(
      resourceScopedResult.ok
        ? resourceScopedResult.response.tracks.find((track) => track.track === "hotel_operations")
        : null,
    ).toMatchObject({ provisioning: "active" });
    expect(await accountScopedProducts(resourceScoped.organizationId)).toEqual(["booking", "pms"]);
    expect(await count("booking.booking_settings", "property_id", secondPropertyId)).toBe(1);

    const profileOwner = await createFixture();
    await client.query(
      `INSERT INTO marketplace.marketplace_hotel_profiles (
         property_id, organization_id, source_system, source_hotel_profile_id
       )
       VALUES ($1::uuid, $2::uuid, 'marketplace', $1)`,
      [profileOwner.propertyId, profileOwner.organizationId],
    );
    const profileOperator = await createOrganizationForProperty(profileOwner.propertyId);
    const profileConflictResult = await repository.updateTracks(
      command(profileOperator, {
        selectedTracks: ["creator_marketplace"],
        expectedRevision: 0,
        idempotencyKey: "setup-profile-owner-conflict",
      }),
    );
    expect(
      profileConflictResult.ok
        ? profileConflictResult.response.tracks.find(
            (track) => track.track === "creator_marketplace",
          )
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [{ product: "marketplace", access: "absent" }],
    });
    expect(await selectedProducts(profileOperator.organizationId)).toEqual([]);
    expect(await linkedProducts(profileOperator.organizationId)).toEqual([]);

    const mixedMarketplace = await createFixture();
    const mixedMarketplaceCreated = await repository.updateTracks(
      command(mixedMarketplace, {
        selectedTracks: ["creator_marketplace"],
        expectedRevision: 0,
        idempotencyKey: "setup-mixed-marketplace",
      }),
    );
    expect(mixedMarketplaceCreated.ok).toBe(true);
    const conflictedPropertyId = await addProperty(mixedMarketplace.organizationId);
    const conflictedOwner = await createOrganizationForProperty(conflictedPropertyId);
    await client.query(
      `INSERT INTO marketplace.marketplace_hotel_profiles (
         property_id, organization_id, source_system, source_hotel_profile_id
       )
       VALUES ($1::uuid, $2::uuid, 'marketplace', $1)`,
      [conflictedPropertyId, conflictedOwner.organizationId],
    );
    const mixedMarketplaceStatus = await repository.updateTracks(
      command(mixedMarketplace, {
        selectedTracks: ["creator_marketplace"],
        expectedRevision: 1,
        idempotencyKey: "setup-mixed-marketplace-status",
      }),
    );
    expect(
      mixedMarketplaceStatus.ok
        ? mixedMarketplaceStatus.response.tracks.find(
            (track) => track.track === "creator_marketplace",
          )
        : null,
    ).toMatchObject({
      provisioning: "blocked",
      components: [{ product: "marketplace", access: "active" }],
    });
  });

  it("serializes first writes and rolls the whole command back on audit failure", async () => {
    const concurrent = await createFixture();
    const [left, right] = await Promise.all([
      repository.updateTracks(
        command(concurrent, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: "setup-concurrent-operations",
        }),
      ),
      repository.updateTracks(
        command(concurrent, {
          selectedTracks: ["creator_marketplace"],
          expectedRevision: 0,
          idempotencyKey: "setup-concurrent-marketplace",
        }),
      ),
    ]);
    expect([left, right].filter((result) => result.ok)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok)).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "track_revision_conflict",
          currentRevision: 1,
        }),
      }),
    ]);

    const sharedPropertyOwner = await createFixture();
    const sharedPropertyOperator = await createOrganizationForProperty(
      sharedPropertyOwner.propertyId,
    );
    const marketplaceRace = await Promise.all([
      repository.updateTracks(
        command(sharedPropertyOwner, {
          selectedTracks: ["creator_marketplace"],
          expectedRevision: 0,
          idempotencyKey: "setup-marketplace-owner-race",
        }),
      ),
      repository.updateTracks(
        command(sharedPropertyOperator, {
          selectedTracks: ["creator_marketplace"],
          expectedRevision: 0,
          idempotencyKey: "setup-marketplace-operator-race",
        }),
      ),
    ]);
    expect(
      marketplaceRace.map((result) =>
        result.ok
          ? result.response.tracks.find((track) => track.track === "creator_marketplace")
              ?.provisioning
          : "error",
      ),
    ).toEqual(expect.arrayContaining(["active", "blocked"]));
    const marketplaceProfile = await client.query<{ organizationId: string }>(
      `SELECT organization_id AS "organizationId"
       FROM marketplace.marketplace_hotel_profiles
       WHERE property_id = $1::uuid`,
      [sharedPropertyOwner.propertyId],
    );
    expect(marketplaceProfile.rows).toHaveLength(1);
    const losingOrganizationId =
      marketplaceProfile.rows[0]?.organizationId === sharedPropertyOwner.organizationId
        ? sharedPropertyOperator.organizationId
        : sharedPropertyOwner.organizationId;
    expect(await selectedProducts(losingOrganizationId)).toEqual([]);
    expect(await linkedProducts(losingOrganizationId)).toEqual([]);

    const propertyRace = await createFixture();
    const propertyRepository = createPgSharedHotelSetupStatusRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    let blockerOpen = false;
    let trackPromise: ReturnType<HotelSetupTrackCommandRepository["updateTracks"]> | undefined;
    let propertyPromise: ReturnType<typeof propertyRepository.createPropertyProfile> | undefined;
    try {
      await client.query("BEGIN");
      blockerOpen = true;
      await client.query(`SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE`, [
        propertyRace.propertyId,
      ]);
      trackPromise = repository.updateTracks(
        command(propertyRace, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: "setup-property-create-race",
        }),
      );
      await waitForBlockedQuery("FOR UPDATE OF link, property");

      propertyPromise = propertyRepository.createPropertyProfile({
        organizationId: propertyRace.organizationId,
        profile: completePropertyProfile("Concurrent Track Test Hotel"),
      });
      await waitForBlockedQuery("FROM identity.organizations");
      await client.query("COMMIT");
      blockerOpen = false;

      const [trackResult, createdProperty] = await Promise.all([trackPromise, propertyPromise]);
      propertyIds.push(createdProperty.propertyId);
      expect(trackResult.ok).toBe(true);
      expect(
        await linkedProductsForProperty(propertyRace.organizationId, createdProperty.propertyId),
      ).toEqual(["booking", "pms"]);
      expect(
        await count("booking.booking_settings", "property_id", createdProperty.propertyId),
      ).toBe(1);
    } finally {
      if (blockerOpen) await client.query("ROLLBACK");
      await Promise.allSettled([trackPromise, propertyPromise].filter(Boolean));
      await propertyRepository.close?.();
    }

    const rollback = await createFixture();
    await expect(
      repository.updateTracks({
        ...command(rollback, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: "setup-rollback",
        }),
        actorUserId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await selectedProducts(rollback.organizationId)).toEqual([]);
    expect(await linkedProducts(rollback.organizationId)).toEqual([]);
    expect(
      await count(
        "hotel_catalog.organization_setup_track_intents",
        "organization_id",
        rollback.organizationId,
      ),
    ).toBe(0);
    expect(
      await count("platform.idempotency_keys", "organization_id", rollback.organizationId),
    ).toBe(0);
  });

  async function createFixture() {
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const actorUserId = randomUUID();
    organizationIds.push(organizationId);
    propertyIds.push(propertyId);
    userIds.push(actorUserId);
    await client.query(`INSERT INTO identity.users (id, email) VALUES ($1::uuid, $2)`, [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES ($1::uuid, 'hotel_group', 'Track Test Hotel', $2)`,
      [organizationId, `track-test-${organizationId}`],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'Track Test Hotel')`,
      [propertyId, `track-test-${propertyId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    return { organizationId, propertyId, actorUserId };
  }

  async function addProperty(organizationId: string): Promise<string> {
    const propertyId = randomUUID();
    propertyIds.push(propertyId);
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'Second Track Test Hotel')`,
      [propertyId, `track-test-${propertyId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    return propertyId;
  }

  async function createOrganizationForProperty(propertyId: string) {
    const organizationId = randomUUID();
    const actorUserId = randomUUID();
    organizationIds.push(organizationId);
    userIds.push(actorUserId);
    await client.query(`INSERT INTO identity.users (id, email) VALUES ($1::uuid, $2)`, [
      actorUserId,
      `${actorUserId}@example.test`,
    ]);
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug)
       VALUES ($1::uuid, 'hotel_group', 'Track Test Operator', $2)`,
      [organizationId, `track-test-${organizationId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'operator', 'active')`,
      [organizationId, propertyId],
    );
    return { organizationId, actorUserId };
  }

  function command(
    fixture: { organizationId: string; actorUserId: string },
    input: Pick<HotelSetupTrackCommand, "selectedTracks" | "expectedRevision" | "idempotencyKey">,
  ): HotelSetupTrackCommand {
    return {
      ...input,
      organizationId: fixture.organizationId,
      actorUserId: fixture.actorUserId,
      audit: {
        requestId: `request-${input.idempotencyKey}`,
        correlationId: `correlation-${input.idempotencyKey}`,
        source: "web",
        receivedAt: occurredAt,
      },
    };
  }

  async function selectedProducts(organizationId: string): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.product_entitlements
       WHERE organization_id = $1::uuid
         AND status = 'active'
       ORDER BY product`,
      [organizationId],
    );
    return result.rows.map((row) => row.product);
  }

  async function accountScopedProducts(organizationId: string): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.product_entitlements
       WHERE organization_id = $1::uuid
         AND status = 'active'
         AND resource_product IS NULL
         AND resource_type IS NULL
         AND resource_id IS NULL
       ORDER BY product`,
      [organizationId],
    );
    return result.rows.map((row) => row.product);
  }

  async function linkedProducts(organizationId: string): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.organization_resource_links
       WHERE organization_id = $1::uuid
         AND product IN ('booking', 'pms', 'marketplace')
         AND status = 'active'
       ORDER BY product`,
      [organizationId],
    );
    return result.rows.map((row) => row.product);
  }

  async function linkedProductsForProperty(
    organizationId: string,
    propertyId: string,
  ): Promise<string[]> {
    const result = await client.query<{ product: string }>(
      `SELECT product
       FROM identity.organization_resource_links
       WHERE organization_id = $1::uuid
         AND resource_id = $2
         AND product IN ('booking', 'pms', 'marketplace')
         AND status = 'active'
       ORDER BY product`,
      [organizationId, propertyId],
    );
    return result.rows.map((row) => row.product);
  }

  async function count(table: string, column: string, id: string): Promise<number> {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1::uuid`,
      [id],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function waitForBlockedQuery(fragment: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await client.query("SELECT pg_stat_clear_snapshot()");
      const result = await client.query(
        `SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%' || $1 || '%'
         LIMIT 1`,
        [fragment],
      );
      if (result.rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.query("SELECT pg_stat_clear_snapshot()");
    const activity = await client.query<{
      state: string;
      waitEventType: string | null;
      waitEvent: string | null;
      query: string;
    }>(
      `SELECT
         state,
         wait_event_type AS "waitEventType",
         wait_event AS "waitEvent",
         query
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state <> 'idle'
       ORDER BY pid`,
    );
    throw new Error(
      `Timed out waiting for blocked query containing "${fragment}": ${JSON.stringify(activity.rows)}`,
    );
  }
});

function completePropertyProfile(displayName: string) {
  return {
    displayName,
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      region: "Berlin",
      city: "Berlin",
      streetAddress: "1 Test Street",
      postalCode: "10115",
      rawMarketplaceLocation: null,
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      addressPublic: false,
      mapDisplayMode: "hidden" as const,
    },
    website: null,
    contactEmail: "hotel@example.test",
    phone: "+49 30 123456",
    shortDescription: null,
    longDescription: null,
    media: [],
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
