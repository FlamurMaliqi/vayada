import {
  createFakeVerifier,
  type IdentityLifecycleCommand,
  type IdentityLifecycleCommandBus,
  type IdentityRepository,
  type LinkedResource,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type { MarketplaceAdminCreateOfferRequest } from "./routes/marketplaceAdmin.js";
import {
  createPgMarketplaceHotelSelfServiceRepository,
  MarketplaceOfferIdempotencyConflictError,
} from "./routes/marketplaceHotelSelfService.js";
import { recordOfferMatchingAudit, replaceOfferChildren } from "./routes/marketplaceAdmin.js";
import type {
  MarketplaceHotelSelfServiceOffer,
  MarketplaceHotelSelfServiceProfile,
  MarketplaceHotelSelfServiceRepository,
} from "./routes/marketplaceHotelSelfService.js";

const propertyOne = "property-one";
const propertyTwo = "property-two";
const offerResourceId = "offer-resource-id";
const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace hotel self-service routes", () => {
  it("persists matching criteria with requirement levels and private audit metadata", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    await replaceOfferChildren(
      {
        async query(text: string, values: readonly unknown[] = []) {
          queries.push({ text, values });
          return { rows: [] };
        },
      } as never,
      {
        offerId: offerResourceId,
        propertyId: propertyTwo,
        organizationId: "org_hotel_group",
        actorUserId: "user_hotel_owner",
        deliverables: [
          {
            platform: "instagram",
            deliverableType: "reel",
            quantity: 1,
            requirementLevel: "required",
          },
        ],
        matchingCriteria: matchingCriteria(),
      },
    );

    expect(queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("requirement_level"),
          values: expect.arrayContaining(["required"]),
        }),
        expect.objectContaining({
          text: expect.stringContaining("INSERT INTO marketplace.offer_matching_criteria"),
          values: expect.arrayContaining([JSON.stringify(matchingCriteria()), "user_hotel_owner"]),
        }),
      ]),
    );
  });

  it("records criteria deletion as an attributed product audit event", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    await recordOfferMatchingAudit(
      {
        async query(text: string, values: readonly unknown[] = []) {
          queries.push({ text, values });
          return { rows: [] };
        },
      } as never,
      {
        action: "updated",
        offerId: offerResourceId,
        propertyId: propertyTwo,
        request: { matchingCriteria: null },
        audit: offerAudit(),
      },
    );

    expect(queries[0]?.text).toContain("INSERT INTO platform.product_audit_events");
    expect(JSON.parse(String(queries[0]?.values[8]))).toEqual({
      changedFields: ["matchingCriteria"],
      matchingCriteriaOperation: "deleted",
    });
    expect(JSON.parse(String(queries[0]?.values[9]))).toMatchObject({
      requestId: offerAudit().requestId,
      source: "api",
    });
  });

  it("updates profile completeness and offer projections in one transaction", async () => {
    const statements: string[] = [];
    const client = {
      async query(text: string) {
        statements.push(text);
        if (text.includes("UPDATE marketplace.marketplace_hotel_profiles")) {
          return { rows: [{ propertyId: propertyTwo }] };
        }
        if (
          text.includes('property.display_name AS "displayName"') &&
          text.includes("FOR UPDATE OF property")
        ) {
          return {
            rows: [
              {
                propertyId: propertyTwo,
                publicId: "hotel-alpenrose",
                displayName: "Hotel Alpenrose",
                defaultLocale: "en",
                canonicalSlug: "hotel-alpenrose",
              },
            ],
          };
        }
        if (
          text.includes('offer.id::text AS "offerId"') &&
          text.includes("offer.offer_status <> 'archived'")
        ) {
          return { rows: [] };
        }
        if (text.includes('profile_complete AS "profileComplete"')) {
          return {
            rows: [
              {
                propertyId: propertyTwo,
                profileStatus: "pending",
                profileComplete: true,
                hostSummary: "An independent alpine hotel.",
                collaborationGuidelines: null,
                createdAt: "2026-07-11T00:00:00.000Z",
                updatedAt: "2026-07-27T00:00:00.000Z",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: {
        connect: vi.fn(async () => client),
        end: vi.fn(async () => undefined),
      } as never,
    });

    await expect(
      repository.updateProfile({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        hostSummary: "An independent alpine hotel.",
      }),
    ).resolves.toMatchObject({ propertyId: propertyTwo, profileComplete: true });

    expect(statements[0]).toBe("BEGIN");
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UPDATE marketplace.marketplace_hotel_profiles"),
        expect.stringContaining("INSERT INTO hotel_catalog.property_public_profile_read_model"),
        expect.stringContaining("FROM marketplace.marketplace_offers offer"),
      ]),
    );
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("resolves CRUD identifiers through the canonical offer ID", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: { query, end: vi.fn(async () => undefined) } as never,
    });

    await expect(
      repository.resolveOfferResourceId("org-id", "property-id", "offer-id"),
    ).resolves.toBeNull();

    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("id::text = $3");
    expect(sql).not.toContain("source_offer_id = $3");
  });

  it("reads media from each offer resource with legacy URL fallback", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [
        offerRow("offer-one", [
          { mediaObjectId: "media-one", url: "https://images.example/one.jpg" },
        ]),
        offerRow("offer-two", [
          { mediaObjectId: "media-two", url: "https://images.example/two.jpg" },
        ]),
      ],
    }));
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: { query, end: vi.fn(async () => undefined) } as never,
    });

    const offers = await repository.listOffers("org-id", "property-id");

    expect(offers.map(({ offer: value }) => value.media)).toEqual([
      [
        {
          mediaObjectId: "media-one",
          url: "https://images.example/one.jpg",
          approvalStatus: "approved",
          lifecycleStatus: "active",
        },
      ],
      [
        {
          mediaObjectId: "media-two",
          url: "https://images.example/two.jpg",
          approvalStatus: "approved",
          lifecycleStatus: "active",
        },
      ],
    ]);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("media_object.resource_id = offer.id::text");
    expect(sql).toContain("unnest(offer.image_urls)");
  });

  it("replays an offer only after its operator access grant is completed", async () => {
    const harness = createOfferRepositoryHarness();
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: harness.pool,
    });
    const input = {
      organizationId: "org_hotel_group",
      propertyId: propertyTwo,
      audit: offerAudit(),
      idempotencyKey: "onboarding-draft-offer-one",
      request: offerRequest(),
    };

    const created = await repository.createOffer(input);
    expect(harness.idempotencyStatus()).toBe("in_progress");
    await repository.completeOfferCreation({ ...input, offerResourceId });
    const replayed = await repository.createOffer(input);

    expect(created).toMatchObject({ offerResourceId, replayed: false });
    expect(replayed).toMatchObject({ offerResourceId, replayed: true });
    expect(harness.offerInsertCount()).toBe(1);
    expect(harness.auditInsertCount()).toBe(1);
    expect(
      harness
        .queries()
        .find(({ text }) => text.includes("INSERT INTO platform.product_audit_events"))?.values,
    ).toEqual(
      expect.arrayContaining([
        "marketplace.offer_matching_input.created",
        offerAudit().actorUserId,
        offerResourceId,
      ]),
    );
    expect(harness.idempotencyStatus()).toBe("completed");
    const idempotencyLookup = harness
      .queries()
      .find(({ text }) => text.includes("FROM platform.idempotency_keys"));
    expect(idempotencyLookup?.text).toContain("tenant_scope = 'organization'");
    expect(idempotencyLookup?.text).toContain("organization_id = $2::uuid");
    expect(idempotencyLookup?.text).toContain("property_id IS NULL");
    expect(idempotencyLookup?.values?.[1]).toBe(input.organizationId);
    const idempotencyReservation = harness
      .queries()
      .find(({ text }) => text.includes("INSERT INTO platform.idempotency_keys"));
    expect(idempotencyReservation?.text).toContain("tenant_scope, organization_id");
    expect(idempotencyReservation?.text).toContain("'organization', $3::uuid");
    expect(idempotencyReservation?.values?.[2]).toBe(input.organizationId);
    expect(harness.transactions()).toEqual([
      "BEGIN",
      "COMMIT",
      "BEGIN",
      "COMMIT",
      "BEGIN",
      "COMMIT",
    ]);
  });

  it("rejects a replay when its stored offer no longer belongs to the organization", async () => {
    const harness = createOfferRepositoryHarness();
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: harness.pool,
    });
    const input = {
      organizationId: "org_hotel_group",
      propertyId: propertyTwo,
      audit: offerAudit(),
      idempotencyKey: "onboarding-organization-recheck",
      request: offerRequest(),
    };
    await repository.createOffer(input);
    await repository.completeOfferCreation({ ...input, offerResourceId });
    harness.setOfferOrganization("org_other_hotel_group");

    await expect(repository.createOffer(input)).rejects.toBeInstanceOf(
      MarketplaceOfferIdempotencyConflictError,
    );

    const accessCheck = harness
      .queries()
      .findLast(({ text }) => text.includes("FROM marketplace.marketplace_hotel_profiles profile"));
    expect(accessCheck?.values).toEqual([offerResourceId, input.organizationId, input.propertyId]);
    expect(harness.transactions().slice(-2)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("rolls back when an offer key is reused with a different request", async () => {
    const harness = createOfferRepositoryHarness();
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: harness.pool,
    });
    const input = {
      organizationId: "org_hotel_group",
      propertyId: propertyTwo,
      audit: offerAudit(),
      idempotencyKey: "onboarding-draft-offer-one",
      request: offerRequest(),
    };
    await repository.createOffer(input);
    await repository.completeOfferCreation({ ...input, offerResourceId });

    await expect(
      repository.createOffer({
        ...input,
        request: { ...input.request, title: "A different hotel stay" },
      }),
    ).rejects.toBeInstanceOf(MarketplaceOfferIdempotencyConflictError);

    expect(harness.offerInsertCount()).toBe(1);
    expect(harness.transactions().slice(-2)).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("rolls back the offer write when its audit event cannot be stored", async () => {
    const harness = createOfferRepositoryHarness({ auditError: new Error("audit unavailable") });
    const repository = createPgMarketplaceHotelSelfServiceRepository({
      connectionString: "postgresql://target-db",
      pool: harness.pool,
    });

    await expect(
      repository.createOffer({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        audit: offerAudit(),
        idempotencyKey: "onboarding-audit-failure",
        request: offerRequest(),
      }),
    ).rejects.toThrow("audit unavailable");

    expect(harness.transactions()).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("reads the explicitly selected hotel when an account has multiple hotels", async () => {
    const calls: string[] = [];
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyOne), profileLink(propertyTwo)],
      repository: repository({
        async getProfile(organizationId, propertyId) {
          calls.push(`${organizationId}:${propertyId}`);
          return profile(propertyId);
        },
      }),
    });

    const response = await injectJson<MarketplaceHotelSelfServiceProfile>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${propertyTwo}/profile`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.propertyId).toBe(propertyTwo);
    expect(calls).toEqual([`org_hotel_group:${propertyTwo}`]);
  });

  it("lists only offers with an active offer resource link", async () => {
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async listOffers() {
          return [
            { offer: offer(propertyTwo), offerResourceId },
            {
              offer: { ...offer(propertyTwo), offerId: "unlinked-offer-id" },
              offerResourceId: "unlinked-offer-id",
            },
          ];
        },
      }),
    });

    const response = await injectJson<{ offers: MarketplaceHotelSelfServiceOffer[] }>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.offers.map(({ offerId }) => offerId)).toEqual([offerResourceId]);
  });

  it("creates an offer under the selected hotel with collaboration operator access", async () => {
    const createOffer = vi.fn(async (input) => ({
      offer: offer(input.propertyId),
      offerResourceId,
      replayed: false,
    }));
    const lifecycleCommandBus = recordingCommandBus();
    const completeOfferCreation = vi.fn(async (input) => offer(input.propertyId));
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyOne), profileLink(propertyTwo)],
      repository: repository({ createOffer, completeOfferCreation }),
      lifecycleCommandBus,
    });

    const request = { ...offerRequest(), matchingCriteria: matchingCriteria() };
    const response = await injectJson<MarketplaceHotelSelfServiceOffer>(app, {
      method: "POST",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "hotel-onboarding-offer-two",
      },
      payload: request,
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.propertyId).toBe(propertyTwo);
    expect(response.body.mediaResourceId).toBe(offerResourceId);
    expect(response.body).not.toHaveProperty("authorizationMode");
    expect(createOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        audit: expect.objectContaining({ actorUserId: "user_hotel_owner", source: "api" }),
        idempotencyKey: "hotel-onboarding-offer-two",
        request,
      }),
    );
    expect(lifecycleCommandBus.commands).toEqual([
      expect.objectContaining({
        commandType: "identity.resource_links.grant",
        payload: expect.objectContaining({
          organizationId: "org_hotel_group",
          resourceLinks: [
            expect.objectContaining({
              resourceType: "marketplace_offer",
              resourceId: offerResourceId,
              relationship: "operator",
              status: "active",
            }),
          ],
        }),
      }),
    ]);
    expect(completeOfferCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        audit: expect.objectContaining({ actorUserId: "user_hotel_owner", source: "api" }),
        idempotencyKey: "hotel-onboarding-offer-two",
        offerResourceId,
      }),
    );
  });

  it("requires a bounded Idempotency-Key before creating an offer", async () => {
    const createOffer = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      repository: repository({ createOffer }),
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "POST",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: { authorization: "Bearer valid-token" },
      payload: offerRequest(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe("idempotency_key_required");
    expect(createOffer).not.toHaveBeenCalled();
  });

  it("returns an idempotent replay without granting or changing offer access", async () => {
    const lifecycleCommandBus = recordingCommandBus();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      repository: repository({
        async createOffer(input) {
          return {
            offer: offer(input.propertyId),
            offerResourceId,
            replayed: true,
          };
        },
      }),
      lifecycleCommandBus,
    });

    const response = await injectJson<MarketplaceHotelSelfServiceOffer>(app, {
      method: "POST",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "hotel-onboarding-replay",
      },
      payload: offerRequest(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.body.offerId).toBe(offerResourceId);
    expect(lifecycleCommandBus.commands).toEqual([]);
  });

  it("returns a conflict when an offer key is reused with another request", async () => {
    const lifecycleCommandBus = recordingCommandBus();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      repository: repository({
        async createOffer() {
          throw new MarketplaceOfferIdempotencyConflictError();
        },
      }),
      lifecycleCommandBus,
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "POST",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "hotel-onboarding-conflict",
      },
      payload: offerRequest(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe("idempotency_conflict");
    expect(lifecycleCommandBus.commands).toEqual([]);
  });

  it("archives offer access without revoking the hotel membership", async () => {
    const lifecycleCommandBus = recordingCommandBus();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      lifecycleCommandBus,
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
      }),
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(204);
    expect(lifecycleCommandBus.commands).toEqual([
      expect.objectContaining({
        commandType: "identity.access.revoke",
        payload: {
          userId: "user_hotel_owner",
          organizationId: "org_hotel_group",
          resourceLinks: [
            {
              product: "marketplace",
              resourceType: "marketplace_offer",
              resourceId: offerResourceId,
              relationship: "owner",
              status: "archived",
            },
          ],
        },
      }),
    ]);
  });

  it("archives a new offer when its identity link cannot be granted", async () => {
    const failOfferCreation = vi.fn(async () => undefined);
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      lifecycleCommandBus: recordingCommandBus(new Error("identity unavailable")),
      repository: repository({ failOfferCreation }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "hotel-onboarding-offer-link-failure",
      },
      payload: offerRequest(),
    });

    expect(response.statusCode).toBe(500);
    expect(failOfferCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        audit: expect.objectContaining({ actorUserId: "user_hotel_owner", source: "api" }),
        idempotencyKey: "hotel-onboarding-offer-link-failure",
        request: offerRequest(),
        offerResourceId,
      }),
    );
  });

  it("recovers the archived offer on retry without duplicating the offer or operator link", async () => {
    const harness = createOfferRepositoryHarness();
    const lifecycleCommandBus = failFirstGrantCommandBus();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      lifecycleCommandBus,
      repository: createPgMarketplaceHotelSelfServiceRepository({
        connectionString: "postgresql://target-db",
        pool: harness.pool,
      }),
    });
    const request = {
      method: "POST" as const,
      url: `/api/marketplace/properties/${propertyTwo}/offers`,
      headers: {
        authorization: "Bearer valid-token",
        "idempotency-key": "hotel-onboarding-recover-link",
      },
      payload: offerRequest(),
    };

    const failed = await app.inject(request);

    expect(failed.statusCode).toBe(500);
    expect(harness.offerStatus()).toBe("archived");
    expect(harness.idempotencyStatus()).toBe("in_progress");
    expect(harness.idempotencyMetadata()).toMatchObject({ accessGrantFailed: true });
    expect(harness.offerInsertCount()).toBe(1);
    expect(lifecycleCommandBus.successfulOfferLinks.size).toBe(0);

    const changedPayload = await injectJson<{ code: string }>(app, {
      ...request,
      payload: { ...offerRequest(), title: "A different hotel stay" },
    });
    expect(changedPayload.statusCode).toBe(409);
    expect(changedPayload.body.code).toBe("idempotency_conflict");

    const recovered = await injectJson<MarketplaceHotelSelfServiceOffer>(app, request);
    const replayed = await injectJson<MarketplaceHotelSelfServiceOffer>(app, request);

    expect(recovered.statusCode).toBe(201);
    expect(recovered.body.offerId).toBe(offerResourceId);
    expect(recovered.body.offerStatus).toBe("pending");
    expect(replayed.statusCode).toBe(201);
    expect(replayed.body.offerId).toBe(offerResourceId);
    expect(harness.offerStatus()).toBe("pending");
    expect(harness.idempotencyStatus()).toBe("completed");
    expect(harness.offerInsertCount()).toBe(1);
    expect(lifecycleCommandBus.commands).toHaveLength(2);
    expect(
      new Set(lifecycleCommandBus.commands.map(({ idempotencyKey }) => idempotencyKey)),
    ).toEqual(new Set([`marketplace-offer:org_hotel_group:${offerResourceId}:operator`]));
    expect(lifecycleCommandBus.successfulOfferLinks).toEqual(new Set([offerResourceId]));
  });

  it("requires the offer resource link before updating an offer", async () => {
    const updateOffer = vi.fn(async (input) => offer(input.propertyId));
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async resolveOfferResourceId(organizationId, propertyId, offerId) {
          expect([organizationId, propertyId, offerId]).toEqual([
            "org_hotel_group",
            propertyTwo,
            offerResourceId,
          ]);
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<MarketplaceHotelSelfServiceOffer>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: { title: "Updated hotel stay", matchingCriteria: matchingCriteria() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.mediaResourceId).toBe(offerResourceId);
    expect(updateOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        audit: expect.objectContaining({ actorUserId: "user_hotel_owner", source: "api" }),
        offerResourceId,
        request: {
          title: "Updated hotel stay",
          matchingCriteria: matchingCriteria(),
        },
      }),
    );
  });

  it("accepts an empty offer update so projections can be refreshed", async () => {
    const updateOffer = vi.fn(async (input) => offer(input.propertyId));
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<MarketplaceHotelSelfServiceOffer>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(updateOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_hotel_group",
        propertyId: propertyTwo,
        offerResourceId,
        request: {},
      }),
    );
  });

  it("rejects offer updates when only the hotel profile is linked", async () => {
    const updateOffer = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<{ message: string }>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: { title: "Updated hotel stay" },
    });

    expect(response.statusCode).toBe(403);
    expect(updateOffer).not.toHaveBeenCalled();
  });

  it("rejects malformed matching criteria before persistence", async () => {
    const updateOffer = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        matchingCriteria: {
          ...matchingCriteria(),
          availability: {
            ...matchingCriteria().availability,
            startsOn: "2026-10-20",
            endsOn: "2026-10-01",
          },
        },
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("invalid_matching_criteria");
    expect(updateOffer).not.toHaveBeenCalled();
  });

  it("rejects ambiguous mandatory/preferred flags", async () => {
    const updateOffer = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        deliverables: [
          {
            ...offerRequest().deliverables[0],
            requirementLevel: "mandatory",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("invalid_deliverable_requirement_level");
    expect(updateOffer).not.toHaveBeenCalled();
  });

  it("rejects follower criteria without a platform", async () => {
    const updateOffer = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
      repository: repository({
        async resolveOfferResourceId() {
          return offerResourceId;
        },
        updateOffer,
      }),
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        compensationOptions: [
          {
            ...offerRequest().compensationOptions[0],
            platforms: [],
            followerRequirementLevel: "required",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("invalid_follower_requirement");
    expect(updateOffer).not.toHaveBeenCalled();
  });

  it("denies matching-criteria updates across the hotel authorization matrix", async () => {
    const cases = [
      {
        name: "missing session",
        headers: {},
        linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
        statusCode: 401,
      },
      {
        name: "missing permission",
        headers: { authorization: "Bearer valid-token" },
        permissions: [] as PermissionKey[],
        linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
        statusCode: 403,
      },
      {
        name: "missing entitlement",
        headers: { authorization: "Bearer valid-token" },
        entitlements: [] as ProductEntitlement[],
        linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
        statusCode: 403,
      },
      {
        name: "missing profile link",
        headers: { authorization: "Bearer valid-token" },
        linkedResources: [offerLink(offerResourceId)],
        statusCode: 403,
      },
      {
        name: "missing offer link",
        headers: { authorization: "Bearer valid-token" },
        linkedResources: [profileLink(propertyTwo)],
        statusCode: 403,
      },
      {
        name: "wrong organization kind",
        headers: { authorization: "Bearer valid-token" },
        organizationKind: "creator_workspace" as const,
        linkedResources: [profileLink(propertyTwo), offerLink(offerResourceId)],
        statusCode: 403,
      },
    ];

    for (const testCase of cases) {
      const updateOffer = vi.fn();
      const instance = buildMarketplaceHotelApp({
        permissions: testCase.permissions,
        entitlements: testCase.entitlements,
        linkedResources: testCase.linkedResources,
        organizationKind: testCase.organizationKind,
        repository: repository({
          async resolveOfferResourceId() {
            return offerResourceId;
          },
          updateOffer,
        }),
      });
      const response = await instance.inject({
        method: "PUT",
        url: `/api/marketplace/properties/${propertyTwo}/offers/${offerResourceId}`,
        headers: testCase.headers,
        payload: { matchingCriteria: matchingCriteria() },
      });
      expect(response.statusCode, testCase.name).toBe(testCase.statusCode);
      expect(updateOffer, testCase.name).not.toHaveBeenCalled();
      await instance.close();
    }
  });

  it("rejects canonical property fields on the Marketplace profile route", async () => {
    const updateProfile = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      repository: repository({ updateProfile }),
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "PUT",
      url: `/api/marketplace/properties/${propertyTwo}/profile`,
      headers: { authorization: "Bearer valid-token" },
      payload: { displayName: "Wrong owner" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe("canonical_property_read_only");
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("rejects all self-service access while Marketplace is suspended", async () => {
    const getProfile = vi.fn();
    app = buildMarketplaceHotelApp({
      linkedResources: [profileLink(propertyTwo)],
      entitlements: [
        { product: "marketplace", key: "marketplace-hotel-profile", status: "suspended" },
      ],
      repository: repository({ getProfile }),
    });

    const response = await injectJson<{ message: string }>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${propertyTwo}/profile`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(getProfile).not.toHaveBeenCalled();
  });
});

function buildMarketplaceHotelApp(options: {
  repository: MarketplaceHotelSelfServiceRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  entitlements?: ProductEntitlement[];
  lifecycleCommandBus?: RecordingCommandBus;
  organizationKind?: "hotel_group" | "creator_workspace";
}): FastifyInstance {
  return buildApp({
    logger: false,
    marketplaceHotelSelfServiceRepository: options.repository,
    identityLifecycleCommandBus: options.lifecycleCommandBus ?? recordingCommandBus(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options.linkedResources, options.organizationKind),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["marketplace.profile.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return (
            options.entitlements ?? [
              {
                product: "marketplace",
                key: "marketplace-hotel-profile",
                status: "active",
              },
            ]
          );
        },
      },
    },
  });
}

function identityRepository(
  linkedResources?: LinkedResource[],
  organizationKind: "hotel_group" | "creator_workspace" = "hotel_group",
): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: "user_hotel_owner", email: "owner@example.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_hotel_group",
        workosOrgId: session.workosOrgId ?? null,
        name: "Alpenrose Hotels",
        kind: organizationKind,
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_hotel_owner",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om_hotel_owner",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return linkedResources ?? [profileLink(propertyOne)];
    },
  };
}

function repository(
  overrides: Partial<MarketplaceHotelSelfServiceRepository> = {},
): MarketplaceHotelSelfServiceRepository {
  return {
    async getProfile(_organizationId, propertyId) {
      return profile(propertyId);
    },
    async updateProfile(input) {
      return profile(input.propertyId);
    },
    async listOffers() {
      return [];
    },
    async resolveOfferResourceId() {
      return null;
    },
    async createOffer(input) {
      return { offer: offer(input.propertyId), offerResourceId, replayed: false };
    },
    async completeOfferCreation(input) {
      return offer(input.propertyId);
    },
    async failOfferCreation() {},
    async updateOffer(input) {
      return offer(input.propertyId);
    },
    async archiveOffer() {
      return true;
    },
    ...overrides,
  };
}

type RecordingCommandBus = IdentityLifecycleCommandBus & {
  commands: IdentityLifecycleCommand[];
};

function recordingCommandBus(error?: Error): RecordingCommandBus {
  const commands: IdentityLifecycleCommand[] = [];
  return {
    commands,
    async execute(command) {
      commands.push(command);
      if (error) throw error;
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        events: [],
      };
    },
  };
}

function failFirstGrantCommandBus(): RecordingCommandBus & {
  successfulOfferLinks: Set<string>;
} {
  const commands: IdentityLifecycleCommand[] = [];
  const successfulOfferLinks = new Set<string>();
  let failNextGrant = true;
  return {
    commands,
    successfulOfferLinks,
    async execute(command) {
      commands.push(command);
      if (failNextGrant) {
        failNextGrant = false;
        throw new Error("identity unavailable");
      }
      if (command.commandType === "identity.resource_links.grant") {
        for (const link of command.payload.resourceLinks) {
          if (link.resourceType === "marketplace_offer" && link.relationship === "operator") {
            successfulOfferLinks.add(link.resourceId);
          }
        }
      }
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        events: [],
      };
    },
  };
}

function profile(propertyId: string): MarketplaceHotelSelfServiceProfile {
  return {
    propertyId,
    profileStatus: "pending",
    profileComplete: false,
    hostSummary: null,
    collaborationGuidelines: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function offer(propertyId: string) {
  return {
    contractVersion: "marketplace-admin.v1" as const,
    authorizationMode: "platform_organization_membership" as const,
    offerId: offerResourceId,
    propertyId,
    offerStatus: "pending" as const,
    title: "Hotel stay",
    offerSummary: "Two nights",
    media: [],
    deliverables: [],
    compensationOptions: [],
    creatorRequirements: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function offerRow(
  offerId: string,
  media: Array<{ mediaObjectId: string; url: string }>,
  offerStatus: "pending" | "archived" = "pending",
) {
  return {
    offerId,
    propertyId: propertyTwo,
    offerStatus,
    title: "Hotel stay",
    offerSummary: "Two nights",
    media,
    deliverables: [],
    compensationOptions: [],
    creatorRequirements: {},
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function offerRequest(): MarketplaceAdminCreateOfferRequest {
  return {
    title: "Hotel stay",
    offerSummary: "Two nights",
    deliverables: [
      {
        platform: "instagram",
        deliverableType: "content",
        quantity: 1,
      },
    ],
    compensationOptions: [
      {
        compensationType: "free_stay",
        availabilityMonths: ["July"],
        platforms: ["instagram"],
        freeStayMinNights: 1,
        freeStayMaxNights: 2,
        paidMaxAmount: null,
        discountPercentage: null,
        commissionPercentage: null,
        minFollowers: null,
        currency: null,
        termsSummary: null,
      },
    ],
    creatorRequirements: {
      platforms: ["instagram"],
      targetCountries: [],
      targetAgeMin: null,
      targetAgeMax: null,
      targetAgeGroups: [],
      creatorTypes: ["travel"],
    },
  };
}

function matchingCriteria() {
  return {
    primaryCampaignGoal: "ugc_asset_creation" as const,
    availability: {
      requirementLevel: "required" as const,
      flexibility: "flexible" as const,
      startsOn: "2026-10-01",
      endsOn: "2026-10-31",
      blackouts: [{ startsOn: "2026-10-10", endsOn: "2026-10-12" }],
    },
    contentCategories: { requirementLevel: "required" as const, values: ["travel"] },
    contentStyles: { requirementLevel: "preferred" as const, values: ["cinematic"] },
    usageRights: {
      channels: ["organic_social", "website"],
      duration: { mode: "fixed" as const, days: 365 },
    },
    includedRevisionRounds: 2,
    expectedEffortHours: { minimum: 6, maximum: 10 },
    expectedCompensationValue: { amount: "900.00", currency: "USD" },
    applicationCapacity: { acceptingApplications: true, maximumActiveApplications: 20 },
  };
}

function offerAudit() {
  return {
    actorUserId: "user_hotel_owner",
    actorOrganizationId: "org_hotel_group",
    requestId: "request-marketplace-offer",
    correlationId: "correlation-marketplace-offer",
    source: "api" as const,
    occurredAt: "2026-09-03T00:00:00.000Z",
  };
}

function profileLink(
  resourceId: string,
  relationship: LinkedResource["relationship"] = "owner",
): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "hotel_profile",
    resourceId,
    relationship,
    status: "active",
  };
}

function offerLink(
  resourceId: string,
  relationship: LinkedResource["relationship"] = "owner",
): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "marketplace_offer",
    resourceId,
    relationship,
    status: "active",
  };
}

function createOfferRepositoryHarness(options: { auditError?: Error } = {}) {
  let idempotency:
    | {
        id: string;
        status: string;
        requestFingerprintHash: string;
        responseResourceId: string | null;
        idempotencyMetadata: Record<string, unknown>;
        organizationId: string;
      }
    | undefined;
  let offerInserts = 0;
  let auditInserts = 0;
  let offerStatus: "pending" | "archived" = "pending";
  let offerOrganizationId = "org_hotel_group";
  const transactionStatements: string[] = [];
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];

  const client = {
    async query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        transactionStatements.push(text);
        return queryResult();
      }
      if (text.includes("FROM platform.idempotency_keys")) {
        return queryResult(
          idempotency && idempotency.organizationId === values[1] ? [idempotency] : [],
        );
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        if (idempotency && idempotency.organizationId === values[2]) return queryResult();
        idempotency = {
          id: "00000000-0000-4000-8000-000000000020",
          status: "in_progress",
          requestFingerprintHash: String(values[1]),
          responseResourceId: null,
          idempotencyMetadata: {},
          organizationId: String(values[2]),
        };
        return queryResult([{ id: idempotency.id }]);
      }
      if (text.includes("INSERT INTO marketplace.marketplace_offers")) {
        offerInserts += 1;
        offerOrganizationId = String(values[1]);
        return queryResult([{ id: offerResourceId }]);
      }
      if (text.includes("INSERT INTO platform.product_audit_events")) {
        if (options.auditError) throw options.auditError;
        auditInserts += 1;
        return queryResult();
      }
      if (text.includes('property.display_name AS "displayName"')) {
        return queryResult([
          {
            propertyId: propertyTwo,
            publicId: "prop_property_two",
            displayName: "Hotel Two",
            defaultLocale: "en",
            canonicalSlug: "hotel-two",
          },
        ]);
      }
      if (text.includes("INSERT INTO hotel_catalog.property_public_profile_read_model")) {
        return queryResult();
      }
      if (text.includes("FROM marketplace.marketplace_hotel_profiles profile")) {
        return queryResult(
          values[1] === offerOrganizationId && values[2] === propertyTwo
            ? [offerRow(offerResourceId, [], offerStatus)]
            : [],
        );
      }
      if (text.includes("FROM marketplace.marketplace_offers offer")) {
        return queryResult([offerRow(offerResourceId, [], offerStatus)]);
      }
      if (
        text.includes("UPDATE marketplace.marketplace_offers") &&
        text.includes("SET offer_status = 'archived'")
      ) {
        const changed = offerStatus !== "archived";
        offerStatus = "archived";
        return queryResult(changed ? [{ id: offerResourceId }] : []);
      }
      if (
        text.includes("UPDATE marketplace.marketplace_offers") &&
        text.includes("WHEN offer_status = 'archived'")
      ) {
        const canRestore = Boolean(values[3]);
        if (offerStatus === "archived" && !canRestore) return queryResult();
        if (canRestore) offerStatus = "pending";
        return queryResult([{ id: offerResourceId }]);
      }
      if (
        text.includes("UPDATE platform.idempotency_keys") &&
        text.includes("response_resource_product = 'marketplace'") &&
        !text.includes("status = 'completed'")
      ) {
        if (!idempotency) throw new Error("Missing idempotency reservation");
        idempotency.requestFingerprintHash = String(values[1]);
        idempotency.responseResourceId = String(values[2]);
        idempotency.idempotencyMetadata = {
          ...idempotency.idempotencyMetadata,
          ...(JSON.parse(String(values[3])) as Record<string, unknown>),
        };
        return queryResult([{ id: idempotency.id }]);
      }
      if (
        text.includes("UPDATE platform.idempotency_keys") &&
        text.includes("idempotency_metadata = idempotency_metadata || $2::jsonb")
      ) {
        if (!idempotency) throw new Error("Missing idempotency reservation");
        idempotency.idempotencyMetadata = {
          ...idempotency.idempotencyMetadata,
          ...(JSON.parse(String(values[1])) as Record<string, unknown>),
        };
        return queryResult([{ id: idempotency.id }]);
      }
      if (
        text.includes("UPDATE platform.idempotency_keys") &&
        text.includes("status = 'completed'")
      ) {
        if (!idempotency) throw new Error("Missing idempotency reservation");
        idempotency.status = "completed";
        idempotency.requestFingerprintHash = String(values[1]);
        idempotency.responseResourceId = String(values[3]);
        idempotency.idempotencyMetadata = {
          ...idempotency.idempotencyMetadata,
          ...(JSON.parse(String(values[4])) as Record<string, unknown>),
        };
        return queryResult([{ id: idempotency.id }]);
      }
      if (
        text.includes("DELETE FROM marketplace.offer_") ||
        text.includes("INSERT INTO marketplace.offer_") ||
        text.includes("INSERT INTO marketplace.marketplace_offer_read_model")
      ) {
        return queryResult();
      }
      if (text.includes("DELETE FROM platform.idempotency_keys")) {
        idempotency = undefined;
        return queryResult();
      }
      throw new Error(`Unexpected offer repository query: ${text}`);
    },
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
    end: vi.fn(async () => undefined),
  } as never;

  return {
    pool,
    offerInsertCount: () => offerInserts,
    auditInsertCount: () => auditInserts,
    offerStatus: () => offerStatus,
    idempotencyStatus: () => idempotency?.status,
    idempotencyMetadata: () => idempotency?.idempotencyMetadata,
    queries: () => queries,
    setOfferOrganization: (organizationId: string) => {
      offerOrganizationId = organizationId;
    },
    transactions: () => transactionStatements,
  };
}

function queryResult(rows: Record<string, unknown>[] = []) {
  return { rows, rowCount: rows.length };
}
