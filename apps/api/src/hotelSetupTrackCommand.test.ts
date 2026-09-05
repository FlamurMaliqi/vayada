import { createPgMarketplaceAdminRepository } from "./routes/marketplaceAdmin.js";
import { createPgMarketplaceOfferIdentityAccessCommandPort } from "./platform/marketplaceOfferIdentityAccess.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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
const safetyCases = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/onboarding-command-safety/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{ id: string; idempotencyKey: string }>;
};

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
    {
      ok: true,
      response: {
        trackRevision: 2_147_483_648,
        selectedTracks: ["hotel_operations"],
        tracks: [],
      },
    },
    { ok: false },
    { ok: false, error: {} },
    { ok: false, error: { code: "unknown_error" } },
    { ok: false, error: { code: "track_revision_conflict" } },
    { ok: false, error: { code: "idempotency_key_conflict", currentRevision: 1 } },
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
        "identity.organization_memberships",
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
      for (const table of [
        "marketplace.marketplace_offer_read_model",
        "marketplace.offer_creator_requirements",
        "marketplace.offer_deliverables",
        "marketplace.offer_compensation_options",
        "marketplace.marketplace_offers",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          propertyIds,
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
    const exactRetry = safetyCase("exact_retry");
    const operations = command(fixture, {
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
      idempotencyKey: exactRetry.idempotencyKey,
    });

    expect(
      await repository.getTrackStatus({ organizationId: fixture.organizationId }),
    ).toMatchObject({
      trackRevision: 0,
      selectedTracks: [],
      tracks: [
        { track: "hotel_operations", provisioning: "not_selected" },
        { track: "creator_marketplace", provisioning: "not_selected" },
      ],
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
    expect(await activeEntitlementProducts(fixture.organizationId)).toEqual(["booking", "pms"]);
    expect(await linkedProducts(fixture.organizationId)).toEqual(["booking", "pms"]);
    expect(await count("booking.booking_settings", "property_id", fixture.propertyId)).toBe(1);
    expect(
      await count("platform.product_audit_events", "organization_id", fixture.organizationId),
    ).toBe(1);
    expect(await repository.getTrackStatus({ organizationId: fixture.organizationId })).toEqual(
      created.ok ? created.response : null,
    );
    const statusRepository = createPgSharedHotelSetupStatusRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    try {
      const status = await statusRepository.getHotelSetupStatus({
        organizationId: fixture.organizationId,
        propertyIds: [fixture.propertyId],
      });
      expect(status.properties).toMatchObject([
        {
          propertyId: fixture.propertyId,
          taskFacts: {
            shared_identity: {
              readiness: "actionable",
              reasonCodes: expect.arrayContaining([
                "missing_property_type",
                "missing_street_address",
                "missing_email_contact",
              ]),
            },
            direct_booking_publication: {
              readiness: "actionable",
            },
          },
        },
      ]);
    } finally {
      await statusRepository.close?.();
    }

    const replay = await repository.updateTracks({
      ...operations,
      audit: {
        requestId: "request-exact-retry",
        correlationId: "correlation-exact-retry",
        source: "admin",
        sourceIp: "192.0.2.20",
        userAgent: "command-safety-fixture",
        receivedAt: "2026-07-26T16:05:00.000Z",
      },
    });
    expect(replay).toEqual(created);
    const stored = await client.query<{ result: unknown }>(
      `SELECT idempotency_metadata -> 'result' AS result
       FROM platform.idempotency_keys
       WHERE operation_scope = 'hotel_catalog'
         AND operation = 'hotel_setup.tracks.update'
         AND organization_id = $1::uuid`,
      [fixture.organizationId],
    );
    expect(stored.rows[0]?.result).toEqual(created);
    expect(
      await count("platform.product_audit_events", "organization_id", fixture.organizationId),
    ).toBe(1);

    const reusedKey = await repository.updateTracks({
      ...operations,
      selectedTracks: ["hotel_operations", "creator_marketplace"],
    });
    expect(reusedKey).toMatchObject({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
    const reusedKeyWithChangedRevision = await repository.updateTracks({
      ...operations,
      expectedRevision: 1,
    });
    expect(reusedKeyWithChangedRevision).toMatchObject({
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
    expect(await activeEntitlementProducts(fixture.organizationId)).toEqual([
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

  it.each([
    {
      id: "null-metadata",
      mutation: `idempotency_metadata = 'null'::jsonb`,
    },
    {
      id: "status-mismatch",
      mutation: `response_status_code = 409`,
    },
    {
      id: "hash-mismatch",
      mutation: `response_body_hash = repeat('0', 64)`,
    },
  ])("rejects a stored replay with $id", async ({ id, mutation }) => {
    const fixture = await createFixture();
    const request = command(fixture, {
      selectedTracks: ["hotel_operations"],
      expectedRevision: 0,
      idempotencyKey: `setup-malformed-replay-${id}`,
    });
    await expect(repository.updateTracks(request)).resolves.toMatchObject({ ok: true });
    await client.query(
      `UPDATE platform.idempotency_keys
       SET ${mutation}
       WHERE operation_scope = 'hotel_catalog'
         AND operation = 'hotel_setup.tracks.update'
         AND organization_id = $1::uuid`,
      [fixture.organizationId],
    );

    await expect(repository.updateTracks(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "idempotency_key_conflict" },
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
    expect(await activeEntitlementProducts(suspended.organizationId)).toEqual([]);
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
    expect(await activeEntitlementProducts(suspended.organizationId)).toEqual(["booking", "pms"]);
    expect(await linkedProducts(suspended.organizationId)).toEqual(["booking", "pms"]);

    const scheduledOwnSuspension = await createFixture();
    await client.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status, starts_at, metadata
       )
       VALUES (
         $1::uuid, 'booking', 'booking-engine', 'suspended',
         $2::timestamptz + interval '1 day', '{"source":"adaptive_hotel_setup"}'::jsonb
       )`,
      [scheduledOwnSuspension.organizationId, occurredAt],
    );
    const scheduledOwnSuspensionResult = await repository.updateTracks(
      command(scheduledOwnSuspension, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "setup-scheduled-own-suspension",
      }),
    );
    expect(scheduledOwnSuspensionResult).toMatchObject({
      ok: true,
      response: {
        tracks: [
          { track: "hotel_operations", provisioning: "active" },
          { track: "creator_marketplace", provisioning: "not_selected" },
        ],
      },
    });

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
    expect(await activeEntitlementProducts(billing.organizationId)).toEqual([]);
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
    const blockedPropertyRepository = createPgSharedHotelSetupStatusRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    try {
      const blockedProperty = await blockedPropertyRepository.createPropertyProfile({
        organizationId: suspendedBilling.organizationId,
        idempotencyKey: "blocked-operations-property",
        correlationId: "blocked-operations-property",
        profile: completePropertyProfile("Blocked Operations Test Hotel"),
      });
      propertyIds.push(blockedProperty.propertyId);
      expect(blockedProperty).toMatchObject({
        profile: {
          contacts: expect.arrayContaining([
            expect.objectContaining({
              channelType: "email",
              value: "hotel@example.test",
            }),
            expect.objectContaining({
              channelType: "phone",
              value: "+49 30 123456",
            }),
          ]),
          location: {
            localityPublic: false,
            geoPublic: false,
            mapDisplayMode: "hidden",
          },
        },
      });
      expect(
        await linkedProductsForProperty(
          suspendedBilling.organizationId,
          blockedProperty.propertyId,
        ),
      ).toEqual([]);
      expect(
        await count("booking.booking_settings", "property_id", blockedProperty.propertyId),
      ).toBe(0);
      await expect(
        blockedPropertyRepository.createPropertyProfile({
          organizationId: suspendedBilling.organizationId,
          idempotencyKey: "blocked-operations-property",
          correlationId: "blocked-operations-property-replay",
          profile: completePropertyProfile("Blocked Operations Test Hotel"),
        }),
      ).resolves.toMatchObject({ propertyId: blockedProperty.propertyId });
      await expect(
        blockedPropertyRepository.createPropertyProfile({
          organizationId: suspendedBilling.organizationId,
          idempotencyKey: "blocked-operations-property",
          correlationId: "blocked-operations-property-conflict",
          profile: completePropertyProfile("Different Hotel"),
        }),
      ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
    } finally {
      await blockedPropertyRepository.close?.();
    }

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
    expect(await activeEntitlementProducts(profileOperator.organizationId)).toEqual([]);
    expect(await linkedProducts(profileOperator.organizationId)).toEqual([]);

    const strayMarketplaceLink = await createFixture();
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'marketplace', 'hotel_profile', $2, 'owner', 'active')`,
      [strayMarketplaceLink.organizationId, randomUUID()],
    );
    await expect(
      repository.updateTracks(
        command(strayMarketplaceLink, {
          selectedTracks: ["creator_marketplace"],
          expectedRevision: 0,
          idempotencyKey: "setup-stray-marketplace-link",
        }),
      ),
    ).resolves.toMatchObject({ ok: true });

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
    expect(
      (
        await repository.getTrackStatus({ organizationId: mixedMarketplace.organizationId })
      ).tracks.find(({ track }) => track === "creator_marketplace"),
    ).toMatchObject({
      provisioning: "blocked",
      components: [{ product: "marketplace", access: "active" }],
    });
  });

  it("serializes first writes and rolls the whole command back on audit failure", async () => {
    const concurrent = await createFixture();
    const concurrentStale = safetyCase("concurrent_stale_write");
    const [left, right] = await Promise.all([
      repository.updateTracks(
        command(concurrent, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: `${concurrentStale.idempotencyKey}-operations`,
        }),
      ),
      repository.updateTracks(
        command(concurrent, {
          selectedTracks: ["creator_marketplace"],
          expectedRevision: 0,
          idempotencyKey: `${concurrentStale.idempotencyKey}-marketplace`,
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
    expect(await activeEntitlementProducts(losingOrganizationId)).toEqual([]);
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
        idempotencyKey: "setup-property-create-race",
        correlationId: "setup-property-create-race",
        profile: completePropertyProfile("Concurrent Track Test Hotel"),
      });
      await waitForBlockedQuery("FROM identity.organizations");
      await client.query("COMMIT");
      blockerOpen = false;

      const [trackSettled, propertySettled] = await Promise.allSettled([
        trackPromise,
        propertyPromise,
      ]);
      if (propertySettled.status === "fulfilled") {
        propertyIds.push(propertySettled.value.propertyId);
      }
      if (trackSettled.status === "rejected") throw trackSettled.reason;
      if (propertySettled.status === "rejected") throw propertySettled.reason;
      const trackResult = trackSettled.value;
      const createdProperty = propertySettled.value;
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
    const auditRollback = safetyCase("injected_audit_rollback");
    await expect(
      repository.updateTracks({
        ...command(rollback, {
          selectedTracks: ["hotel_operations"],
          expectedRevision: 0,
          idempotencyKey: auditRollback.idempotencyKey,
        }),
        actorUserId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await activeEntitlementProducts(rollback.organizationId)).toEqual([]);
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

  it("lets an authorized admin add Marketplace without publishing or duplicating profiles", async () => {
    const hotel = await createFixture();
    await addProperty(hotel.organizationId);
    await client.query(
      `INSERT INTO identity.organization_memberships (organization_id, user_id, role_key, access_origin) VALUES ($1, $2, 'hotel_owner', 'agency')`,
      [hotel.organizationId, hotel.actorUserId],
    );
    await repository.updateTracks(
      command(hotel, {
        selectedTracks: ["hotel_operations"],
        expectedRevision: 0,
        idempotencyKey: "initial-operations",
      }),
    );
    const platformOrganizationId = randomUUID();
    const adminId = randomUUID();
    organizationIds.push(platformOrganizationId);
    userIds.push(adminId);
    await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
      adminId,
      `${adminId}@example.test`,
    ]);
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug) VALUES ($1::uuid, 'platform', 'Admin', $1::text)`,
      [platformOrganizationId],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (organization_id, user_id, role_key, access_origin) VALUES ($1, $2, 'platform_admin', 'agency')`,
      [platformOrganizationId, adminId],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (organization_id, product, resource_type, resource_id, relationship, status) VALUES ($1, 'platform', 'platform', 'vayada', 'operator', 'active')`,
      [platformOrganizationId],
    );
    const activation = {
      ...command(hotel, {
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        expectedRevision: 1,
        idempotencyKey: "admin-enable",
      }),
      actorUserId: adminId,
      adminActivation: {
        platformOrganizationId,
        accountUserId: hotel.actorUserId,
        actorUserId: adminId,
      },
    };
    const [first, replay] = await Promise.all([
      repository.updateTracks(activation),
      repository.updateTracks(activation),
    ]);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      ok: true,
      response: { tracks: [{ provisioning: "active" }, { provisioning: "active" }] },
    });
    const profiles = await client.query(
      `SELECT marketplace_profile_status FROM marketplace.marketplace_hotel_profiles WHERE organization_id = $1`,
      [hotel.organizationId],
    );
    expect(profiles.rows).toHaveLength(2);
    expect(profiles.rows.every((row) => row.marketplace_profile_status !== "verified")).toBe(true);
    const audit = await client.query(
      `SELECT actor_user_id, audit_metadata FROM platform.product_audit_events WHERE organization_id = $1 AND actor_user_id = $2`,
      [hotel.organizationId, adminId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].audit_metadata.adminActivation.accountUserId).toBe(hotel.actorUserId);
    const offers = createPgMarketplaceAdminRepository({
      connectionString: TEST_DATABASE_URL!,
      identityAccess: createPgMarketplaceOfferIdentityAccessCommandPort(),
    });
    try {
      const scope = {
        hotelUserId: hotel.actorUserId,
        authorizationMode: "platform_organization_membership" as const,
      };
      await expect(offers.readHotelReviewForUser(scope)).rejects.toMatchObject({ statusCode: 409 });
      const input = {
        ...scope,
        propertyId: hotel.propertyId,
        idempotencyKey: "draft-retry",
        request: {
          title: "Private draft",
          deliverables: [],
          compensationOptions: [],
          creatorRequirements: {
            platforms: [],
            targetCountries: [],
            targetAgeMin: null,
            targetAgeMax: null,
            targetAgeGroups: [],
            creatorTypes: [],
          },
        },
        audit: {
          actorUserId: adminId,
          actorOrganizationId: platformOrganizationId,
          requestId: "draft-test",
          correlationId: null,
          source: "web" as const,
          occurredAt,
        },
      };
      const [draft, retried] = await Promise.all([
        offers.createOfferForUser(input),
        offers.createOfferForUser(input),
      ]);
      expect(draft?.offerStatus).toBe("draft");
      expect(retried?.offerId).toBe(draft?.offerId);
      await expect(
        offers.createOfferForUser({ ...input, request: { ...input.request, title: "Changed" } }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const review = await offers.readHotelReviewForUser({
        ...scope,
        propertyId: hotel.propertyId,
      });
      expect(review.offers).toHaveLength(1);
      const discovery = await client.query(
        `SELECT offer_id FROM marketplace.marketplace_offer_read_model WHERE property_id = $1 AND visibility_status = 'public'`,
        [hotel.propertyId],
      );
      expect(discovery.rows).toHaveLength(0);
      await expect(
        offers.verifyOfferForUser({
          ...scope,
          propertyId: hotel.propertyId,
          offerId: draft!.offerId,
        }),
      ).rejects.toMatchObject({ statusCode: 422 });
      const other = await createFixture();
      expect(
        await offers.createOfferForUser({ ...input, propertyId: other.propertyId }),
      ).toBeNull();
    } finally {
      await offers.close?.();
    }
    // Revoked target membership must deny even an otherwise valid replay.
    await client.query(
      `UPDATE identity.organization_memberships SET status = 'suspended' WHERE organization_id = $1`,
      [hotel.organizationId],
    );
    await expect(repository.updateTracks(activation)).rejects.toMatchObject({
      code: "invalid_platform_scope",
    });
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

  function safetyCase(id: string): { id: string; idempotencyKey: string } {
    const fixture = safetyCases.cases.find((candidate) => candidate.id === id);
    if (!fixture) throw new Error(`Missing onboarding command-safety fixture "${id}"`);
    return fixture;
  }

  async function activeEntitlementProducts(organizationId: string): Promise<string[]> {
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
      city: "Berlin",
      streetAddress: "1 Test Street",
      postalCode: "10115",
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      localityPublic: false,
      geoPublic: false,
      mapDisplayMode: "hidden" as const,
    },
    contacts: [
      {
        channelType: "email" as const,
        value: "hotel@example.test",
        purpose: "guest" as const,
        isPublic: false,
      },
      {
        channelType: "phone" as const,
        value: "+49 30 123456",
        purpose: "operations" as const,
        isPublic: false,
      },
    ],
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
