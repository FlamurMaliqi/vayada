import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type Product,
  type RequestContext,
  type ResourceRelationship,
  type ResourceType,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION,
  MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
  type MarketplaceCollaborationMessage,
  type MarketplaceCollaborationRead,
} from "@vayada/domain-marketplace";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import { createPgPlatformMediaRepository } from "./platform/platformMediaRepository.js";
import type { PlatformMediaPrivateDownloadSigner } from "./platform/platformMediaS3.js";
import {
  createPgMarketplaceCollaborationReadRepository,
  toMarketplaceCollaborationListResponse,
  type MarketplaceCollaborationListFilters,
  type MarketplaceCollaborationLifecycleWriteInput,
  type MarketplaceCollaborationLifecycleWriteResponse,
  type MarketplaceCollaborationReadPool,
  type MarketplaceCollaborationReadRepository,
} from "./routes/marketplaceCollaborations.js";
import type { PlatformMediaObjectRecord } from "./routes/platformMedia.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "workos_creator_user",
  workosOrgId: "workos_creator_org",
  sessionId: "session_marketplace_creator",
  expiresAt: futureExpiry,
};

describe("marketplace collaboration read routes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-30T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("lists current-user collaborations through the V4 read repository", async () => {
    const calls: MarketplaceCollaborationListFilters[] = [];
    const repository = createCollaborationRepository({
      async listCollaborations({ filters }) {
        calls.push(filters);
        return toMarketplaceCollaborationListResponse({
          authorizationMode: "creator_workspace_resource_link",
          items: [collaborationRead()],
        });
      },
    });
    const app = buildMarketplaceCollaborationsApp({ repository });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/me",
      query: {
        side: "creator",
        status: "pending",
        initiatedBy: "creator",
        offerId: "offer_001",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
      authorizationMode: "creator_workspace_resource_link",
      items: [{ collaborationId: "collab_001", side: "creator" }],
    });
    expect(calls).toEqual([
      {
        side: "creator",
        status: "pending",
        initiatedBy: "creator",
        offerId: "offer_001",
      },
    ]);
  });

  it("rejects invalid read query values before repository access", async () => {
    const repository = createCollaborationRepository({
      async listCollaborations() {
        throw new Error("repository should not be called");
      },
    });
    const app = buildMarketplaceCollaborationsApp({ repository });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/me",
      query: { side: "creator", status: "archived" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_query",
      category: "validation",
    });
  });

  it("requires marketplace collaboration read permission", async () => {
    const app = buildMarketplaceCollaborationsApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/me",
      query: { side: "creator" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("infers message side from selected organization kind for current typed clients", async () => {
    const seen: string[] = [];
    const repository = createCollaborationRepository({
      async listMessages({ side }) {
        seen.push(side);
        return {
          contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
          collaborationId: "collab_001",
          authorizationMode: "creator_workspace_resource_link",
          items: [],
        };
      },
    });
    const app = buildMarketplaceCollaborationsApp({ repository });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/collab_001/messages",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(seen).toEqual(["creator"]);
  });

  it("denies collaboration reads without the required marketplace resource link", async () => {
    const repository = createCollaborationRepository({
      async listCollaborations() {
        throw new Error("repository should not be called");
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      resources: [],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/me",
      query: { side: "creator" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      code: "missing_creator_resource_link",
      category: "auth",
    });
  });

  it("allows hotel-side collaboration reads with hotel profile and offer links", async () => {
    const calls: string[] = [];
    const repository = createCollaborationRepository({
      async listConversations({ side }) {
        calls.push(side ?? "missing");
        return conversationPage();
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      organizationKind: "hotel_group",
      resources: [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: "hotel_profile_001",
          relationship: "owner",
        },
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "offer_001",
          relationship: "operator",
        },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/collaborations/conversations",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers.vary).toBe("Authorization");
    expect(response.json()).toEqual([]);
    expect(calls).toEqual(["hotel"]);
  });

  it("supports paginated conversation search while preserving the legacy array response", async () => {
    const filters: unknown[] = [];
    const repository = createCollaborationRepository({
      async listConversations(input) {
        filters.push(input.filters);
        return {
          contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
          items: [],
          nextCursor: "next-page",
          hasMore: true,
        };
      },
    });
    const app = buildMarketplaceCollaborationsApp({ repository });

    const legacy = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/conversations",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.body).toEqual([]);

    const paginated = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/conversations",
      query: { limit: "25", search: "Aurora" },
      headers: { authorization: "Bearer valid-token" },
    });
    expect(paginated.statusCode).toBe(200);
    expect(paginated.body).toMatchObject({ hasMore: true, nextCursor: "next-page" });
    expect(filters).toEqual([
      { limit: 100, search: undefined, cursor: undefined },
      { limit: 25, search: "Aurora", cursor: undefined },
    ]);
  });

  it("returns not_found when a detail read is outside the authorized side", async () => {
    const repository = createCollaborationRepository({
      async getCollaboration() {
        return null;
      },
    });
    const app = buildMarketplaceCollaborationsApp({ repository });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/collab_missing",
      query: { side: "creator" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({
      code: "collaboration_not_found",
      category: "not_found",
    });
  });

  it("routes lifecycle writes through the V4 write repository with side auth and idempotency", async () => {
    const calls: MarketplaceCollaborationLifecycleWriteInput[] = [];
    const repository = createCollaborationRepository({
      async executeLifecycleWrite(input) {
        calls.push(input);
        return lifecycleWriteResponse(input);
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/respond",
      payload: {
        idempotencyKey: "marketplace.collaboration.respond:collab_001:test:v1",
        side: "creator",
        status: "accepted",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION,
      command: {
        action: "respond",
        idempotencyKey: "marketplace.collaboration.respond:collab_001:test:v1",
      },
      collaboration: { collaborationId: "collab_001" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      side: "creator",
      action: "respond",
      collaborationId: "collab_001",
      idempotencyKey: "marketplace.collaboration.respond:collab_001:test:v1",
    });
  });

  it("rejects malformed creator travel dates before repository access", async () => {
    const executeLifecycleWrite = vi.fn();
    const app = buildMarketplaceCollaborationsApp({
      repository: createCollaborationRepository({ executeLifecycleWrite }),
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer_001:dates:v1",
        side: "creator",
        offerId: "offer_001",
        consent: true,
        whyGreatFit: "My audience is a strong match.",
        deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
        terms: {
          travelDateFrom: "2026-02-30",
          travelDateTo: "2026-10-09",
        },
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_query",
      category: "validation",
      message: "travelDateFrom must be a real ISO date in YYYY-MM-DD format.",
    });
    expect(executeLifecycleWrite).not.toHaveBeenCalled();
  });

  it("requires valid creator deliverables and real date ranges", async () => {
    const executeLifecycleWrite = vi.fn();
    const app = buildMarketplaceCollaborationsApp({
      repository: createCollaborationRepository({ executeLifecycleWrite }),
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });
    const base = {
      side: "creator",
      offerId: "offer_001",
      consent: true,
      whyGreatFit: "My audience is a strong match.",
      deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
    };
    const invalidCases = [
      { payload: { ...base, deliverables: [] }, message: "at least one valid deliverable" },
      {
        payload: {
          ...base,
          deliverables: [{ platform: "instagram", type: "", quantity: 1 }],
        },
        message: "at least one valid deliverable",
      },
      {
        payload: {
          ...base,
          terms: { travelDateFrom: "2026-02-30", travelDateTo: "2026-03-02" },
        },
        message: "travelDateFrom must be a real ISO date",
      },
      {
        payload: { ...base, terms: { travelDateFrom: "2026-09-01" } },
        message: "travelDateFrom and travelDateTo must be provided together",
      },
    ];

    for (const [index, testCase] of invalidCases.entries()) {
      const response = await injectJson(app, {
        method: "POST",
        url: "/api/marketplace/collaborations",
        payload: {
          ...testCase.payload,
          idempotencyKey: `marketplace.collaboration.create:validation-${index}:v1`,
        },
        headers: { authorization: "Bearer valid-token" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ code: "invalid_query" });
      expect(String((response.body as { message: string }).message)).toContain(testCase.message);
    }
    expect(executeLifecycleWrite).not.toHaveBeenCalled();
  });

  it("requires explicit message idempotency and a composite read cursor", async () => {
    const repository = createCollaborationRepository({
      async markMessagesRead() {
        return true;
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const send = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/messages",
      payload: { content: "Retry me safely" },
      headers: { authorization: "Bearer valid-token" },
    });
    expect(send.statusCode).toBe(400);
    expect(send.body).toMatchObject({ message: "message idempotencyKey is required." });

    const markRead = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/read",
      payload: { readThrough: { createdAt: "2026-07-22T08:00:00.000Z" } },
      headers: { authorization: "Bearer valid-token" },
    });
    expect(markRead.statusCode).toBe(400);
    expect(markRead.body).toMatchObject({
      message: "readThrough requires a valid createdAt and messageId cursor.",
    });
  });

  it.each([
    { token: undefined, permissions: ["marketplace.collaboration.write"], expected: 401 },
    { token: "invalid", permissions: ["marketplace.collaboration.write"], expected: 401 },
    { token: "valid-token", permissions: [], expected: 403 },
    {
      token: "valid-token",
      permissions: ["marketplace.collaboration.write"],
      resources: [],
      expected: 403,
    },
    { token: "valid-token", permissions: ["marketplace.collaboration.write"], expected: 200 },
  ])("enforces application edit route authorization: %j", async (options) => {
    const app = buildMarketplaceCollaborationsApp({
      permissions: options.permissions as PermissionKey[],
      resources: options.resources,
    });
    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/marketplace/collaborations/collab_001/application",
      headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
      payload: {
        idempotencyKey: "edit-route",
        expectedUpdatedAt: "2026-09-05T01:00:00.000Z",
        terms: { travelDateFrom: "2027-09-01", travelDateTo: "2027-09-03" },
      },
    });
    expect(response.statusCode).toBe(options.expected);
  });

  it.each(["respond", "cancel"] as const)(
    "rejects hotel response after cancellation and pending-only cancellation after response: %s",
    async (action) => {
      const pool = createCreatorApplicationPool({
        mutationStatus: action === "respond" ? "cancelled" : "negotiating",
        mutationInitiator: "hotel",
      });
      const repository = createPgMarketplaceCollaborationReadRepository({
        connectionString: "postgresql://target-db",
        pool: pool as never,
      });
      await expect(
        repository.executeLifecycleWrite!({
          context: creatorRequestContext(),
          side: "creator",
          action,
          collaborationId: "collab_001",
          idempotencyKey: "race-test",
          payload: { status: "accepted", pendingOnly: true },
        }),
      ).rejects.toThrow(/pending/i);
      expect(pool.calls.some((c) => c.text.includes("UPDATE marketplace.collaborations"))).toBe(
        false,
      );
    },
  );

  it.each(["pending", "negotiating", "accepted", "declined", "cancelled"])(
    "edits only pending creator applications (%s)",
    async (status) => {
      const pool = createCreatorApplicationPool({ mutationStatus: status });
      const repository = createPgMarketplaceCollaborationReadRepository({
        connectionString: "postgresql://target-db",
        pool: pool as never,
      });
      const input = {
        context: creatorRequestContext(),
        side: "creator" as const,
        action: "edit_application" as const,
        collaborationId: "collab_001",
        idempotencyKey: "edit-test",
        payload: {
          expectedUpdatedAt: "2026-09-05T01:00:00.000Z",
          compensationOptionId: "compensation-paid-001",
          whyGreatFit: "Updated pitch",
          consent: true,
          terms: { travelDateFrom: "2027-07-10", travelDateTo: "2027-07-12" },
          deliverables: [{ platform: "Instagram", type: "Reel", quantity: 2 }],
        },
      };
      if (status === "pending") {
        await repository.executeLifecycleWrite!(input);
        const update = pool.calls.find((c) => c.text.includes("application_message = $2"));
        expect(update?.values).toContain("Updated pitch");
        expect(update?.values).toContain("450.00");
        expect(update?.text).not.toContain("lifecycle_status =");
        expect(
          pool.calls.some(
            (c) => c.text.includes("FOR UPDATE") && c.text.includes("source_collaboration_id"),
          ),
        ).toBe(true);
        expect(pool.calls.at(-1)?.text).toBe("COMMIT");
      } else {
        await expect(repository.executeLifecycleWrite!(input)).rejects.toThrow(
          "Only pending applications",
        );
        expect(pool.calls.at(-1)?.text).toBe("ROLLBACK");
        expect(pool.calls.some((c) => c.text.includes("UPDATE marketplace.collaborations"))).toBe(
          false,
        );
      }
    },
  );

  it.each([
    { mutationInitiator: "hotel", expected: "Only the creator" },
    { compensationOptionExists: false, expected: "belonging to this offer" },
    { stale: true, expected: "This request changed" },
    { failDeliverables: true, expected: "deliverable storage unavailable" },
    { past: true, expected: "cannot be in the past" },
    { timezone: null, expected: "timezone is configured" },
    { timezone: "Invalid/Zone", expected: "timezone is configured" },
  ])("rolls back rejected or failed application edits: %j", async (options) => {
    const pool = createCreatorApplicationPool(options);
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    await expect(
      repository.executeLifecycleWrite!({
        context: creatorRequestContext(),
        side: "creator",
        action: "edit_application",
        collaborationId: "collab_001",
        idempotencyKey: "edit-test",
        payload: {
          expectedUpdatedAt: options.stale
            ? "2026-09-04T01:00:00.000Z"
            : "2026-09-05T01:00:00.000Z",
          terms: {
            travelDateFrom: options.past ? "2020-07-10" : "2027-07-10",
            travelDateTo: "2027-07-12",
          },
          compensationOptionId: "compensation-paid-001",
          whyGreatFit: "Updated",
          consent: true,
          deliverables: [{ platform: "Instagram", type: "Reel", quantity: 1 }],
        },
      }),
    ).rejects.toThrow(options.expected);
    expect(pool.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("derives creator identity and initiator side from auth and snapshots the selected compensation option", async () => {
    const pool = createCreatorApplicationPool();
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer-001:test:v1",
        side: "hotel",
        initiatorSide: "hotel",
        offerId: "offer-001",
        creatorId: "account-user-id-that-is-not-a-creator-id",
        message: "A stale client must not override the creator's fit statement.",
        compensationOptionId: "compensation-paid-001",
        whyGreatFit: "My audience is a strong fit.",
        consent: true,
        terms: { travelDateFrom: "2026-07-01", travelDateTo: "2026-07-03" },
        deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      collaboration: {
        creator: { profileId: "creator-profile-target-001" },
        compensationType: "paid",
        terms: { paidAmount: "450.00", currency: "EUR" },
      },
    });

    const creatorLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.creator_profiles"),
    );
    expect(creatorLookup?.text).not.toContain("source_creator_id");
    expect(creatorLookup?.values).toEqual(["creator_profile_001", "org_creator"]);

    const optionLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.offer_compensation_options"),
    );
    expect(optionLookup?.values).toEqual(["compensation-paid-001", "offer-001"]);

    const insert = pool.calls.find((call) =>
      call.text.includes("INSERT INTO marketplace.collaborations"),
    );
    expect(insert?.text).toContain("selectedCompensationOptionId");
    expect(insert?.values[6]).toBe("creator");
    expect(insert?.values[8]).toBe("My audience is a strong fit.");
    expect(insert?.values[21]).toBe(true);
    expect(insert?.values[22]).toBe("My audience is a strong fit.");
    expect(insert?.values).toEqual(
      expect.arrayContaining([
        "creator-profile-target-001",
        "paid",
        "450.00",
        "EUR",
        "compensation-paid-001",
      ]),
    );
    expect(JSON.parse(String(insert?.values[24]))).toEqual({
      compensationOptionId: "compensation-paid-001",
      compensationType: "paid",
      availabilityMonths: ["July", "August"],
      platforms: ["instagram"],
      freeStayMinNights: null,
      freeStayMaxNights: null,
      paidMaxAmount: "450.00",
      currency: "EUR",
      discountPercentage: null,
      commissionPercentage: null,
      minFollowers: 5000,
      termsSummary: "One Reel and three Stories",
      metadata: { approvalWindowDays: 7 },
    });

    const idempotencyLookup = pool.calls.find((call) =>
      call.text.includes("FROM platform.idempotency_keys"),
    );
    expect(idempotencyLookup?.text).toContain("tenant_scope = 'organization'");
    expect(idempotencyLookup?.values[2]).toBe("org_creator");
    const idempotencyReservation = pool.calls.find((call) =>
      call.text.includes("INSERT INTO platform.idempotency_keys"),
    );
    expect(idempotencyReservation?.values[2]).toBe(
      testSha256(
        testStableJson({
          action: "create",
          side: "creator",
          collaborationId: null,
          deliverableId: null,
          payload: {
            idempotencyKey: "marketplace.collaboration.create:offer-001:test:v1",
            offerId: "offer-001",
            compensationOptionId: "compensation-paid-001",
            whyGreatFit: "My audience is a strong fit.",
            consent: true,
            terms: { travelDateFrom: "2026-07-01", travelDateTo: "2026-07-03" },
            deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
          },
        }),
      ),
    );

    const offerLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.marketplace_offers"),
    );
    expect(offerLookup?.text).toContain("FOR SHARE");

    const lifecycleRead = pool.calls.find(
      (call) =>
        call.text.includes("FROM marketplace.collaborations collaboration") &&
        call.text.includes("WHERE collaboration.id::text = $1"),
    );
    expect(lifecycleRead?.text).toContain(
      `COALESCE(NULLIF(creator.source_creator_id, ''), creator.id::text) AS "creatorId"`,
    );
    expect(lifecycleRead?.text).toContain("public_profile.location->>'city'");
    expect(lifecycleRead?.text).toContain("public_profile.location->>'region'");
    expect(lifecycleRead?.text).toContain("public_profile.location->>'countryCode'");
    expect(lifecycleRead?.text).not.toContain("rawMarketplaceLocation");
    expect(lifecycleRead?.text).not.toContain("raw_marketplace_location");
  });

  it.each([
    {
      label: "a nonblank fit statement",
      payload: { whyGreatFit: "   ", consent: true },
      message: "Creator applications require whyGreatFit.",
    },
    {
      label: "explicit consent",
      payload: { whyGreatFit: "My audience is a strong fit.", consent: false },
      message: "Creator applications require explicit consent.",
    },
    {
      label: "boolean consent rather than a truthy stale value",
      payload: { whyGreatFit: "My audience is a strong fit.", consent: "true" },
      message: "Creator applications require explicit consent.",
    },
  ])("requires $label for creator applications", async ({ payload, message }) => {
    const executeLifecycleWrite = vi.fn();
    const app = buildMarketplaceCollaborationsApp({
      repository: createCollaborationRepository({ executeLifecycleWrite }),
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: `marketplace.collaboration.create:offer-001:${payload.consent}:v1`,
        offerId: "offer-001",
        compensationOptionId: "compensation-paid-001",
        ...payload,
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_query", message });
    expect(executeLifecycleWrite).not.toHaveBeenCalled();
  });

  it("rejects ambiguous active creator profile owner links", async () => {
    const executeLifecycleWrite = vi.fn();
    const app = buildMarketplaceCollaborationsApp({
      repository: createCollaborationRepository({ executeLifecycleWrite }),
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      resources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_001",
          relationship: "owner",
        },
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_002",
          relationship: "owner",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer-001:ambiguous:v1",
        offerId: "offer-001",
        compensationOptionId: "compensation-paid-001",
        whyGreatFit: "My audience is a strong fit.",
        consent: true,
        deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ code: "ambiguous_marketplace_creator_profile" });
    expect(executeLifecycleWrite).not.toHaveBeenCalled();
  });

  it("rejects a linked creator profile owned by another organization", async () => {
    const pool = createCreatorApplicationPool({ creatorProfileOrganizationMatches: false });
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer-001:cross-tenant-creator:v1",
        offerId: "offer-001",
        compensationOptionId: "compensation-paid-001",
        whyGreatFit: "My audience is a strong fit.",
        consent: true,
        deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    const creatorLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.creator_profiles"),
    );
    expect(creatorLookup?.text).toContain("organization_id::text = $2");
    expect(creatorLookup?.values).toEqual(["creator_profile_001", "org_creator"]);
    expect(
      pool.calls.some((call) => call.text.includes("INSERT INTO marketplace.collaborations")),
    ).toBe(false);
  });

  it("rejects a compensation option that does not belong to the selected offer", async () => {
    const pool = createCreatorApplicationPool({ compensationOptionExists: false });
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer-001:invalid-option:v1",
        initiatorSide: "creator",
        offerId: "offer-001",
        compensationOptionId: "compensation-from-another-offer",
        whyGreatFit: "My audience is a strong fit.",
        consent: true,
        deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_query",
      message: "The selected compensation option does not belong to this offer.",
    });
    expect(
      pool.calls.some((call) => call.text.includes("INSERT INTO marketplace.collaborations")),
    ).toBe(false);
  });

  it("does not let creators apply to pending offers", async () => {
    const pool = createCreatorApplicationPool({ offerStatus: "pending" });
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer-001:pending:v1",
        initiatorSide: "creator",
        offerId: "offer-001",
        compensationOptionId: "compensation-paid-001",
        whyGreatFit: "My audience is a strong fit.",
        consent: true,
        deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    const offerLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.marketplace_offers"),
    );
    expect(offerLookup?.text).toContain("offer_status = 'verified'");
    expect(
      pool.calls.some((call) => call.text.includes("INSERT INTO marketplace.collaborations")),
    ).toBe(false);
  });

  it("lets hotels invite creators from pending offers", async () => {
    const pool = createCreatorApplicationPool({ offerStatus: "pending" });
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      organizationKind: "hotel_group",
      resources: [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: "hotel-profile-001",
          relationship: "owner",
        },
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "offer-001",
          relationship: "operator",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer-001:hotel-pending:v1",
        initiatorSide: "hotel",
        offerId: "offer-001",
        creatorId: "creator-source-001",
        terms: {
          compensationType: "free_stay",
          freeStayMinNights: 1,
          freeStayMaxNights: 2,
        },
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(201);
    const offerLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.marketplace_offers"),
    );
    expect(offerLookup?.text).toContain("offer_status IN ('pending', 'verified')");
    const insert = pool.calls.find((call) =>
      call.text.includes("INSERT INTO marketplace.collaborations"),
    );
    expect(insert?.values[6]).toBe("hotel");
  });

  it.each([false, true])(
    "requires replacing expired stored dates on terms edits (mixed: %s)",
    async (mixedDates) => {
      for (const terms of [
        {},
        { travelDateTo: "2026-07-03" },
        { travelDateFrom: "2026-07-01", travelDateTo: "2026-07-03" },
      ]) {
        const pool = createCreatorApplicationPool({ mixedDates });
        const repository = createPgMarketplaceCollaborationReadRepository({
          connectionString: "postgresql://test",
          pool: pool as never,
        });
        const write = repository.executeLifecycleWrite!({
          context: creatorRequestContext(),
          side: "creator",
          action: "update_terms",
          collaborationId: "collab_001",
          idempotencyKey: "edit-dates",
          payload: { terms },
        });
        if ("travelDateFrom" in terms) {
          await expect(write).resolves.not.toBeNull();
          expect(
            pool.calls.find((call) => call.text.includes("UPDATE marketplace.collaborations"))
              ?.text,
          ).toContain("THEN NULL ELSE COALESCE($12, preferred_date_from)");
        } else {
          await expect(write).rejects.toThrow("Collaboration dates cannot be in the past.");
          expect(
            pool.calls.some((call) => call.text.includes("UPDATE marketplace.collaborations")),
          ).toBe(false);
        }
      }
    },
  );

  it.each([
    {
      from: "2026-07-01",
      to: "2026-02-01",
      options: {},
      message: "Collaboration dates cannot be in the past.",
    },
    {
      from: "2026-07-03",
      to: "2026-07-01",
      options: {},
      message: "The end date must be after the start date.",
    },
    {
      from: "2026-02-01",
      to: "2026-07-02",
      options: {},
      message: "Collaboration dates cannot be in the past.",
    },
    { from: "2026-07-01", to: "2026-07-02", options: { timezone: null }, message: "timezone" },
    {
      from: "2026-07-01",
      to: "2026-07-02",
      options: { availabilityMonths: ["February"] },
      message: "no remaining availability",
    },
  ])(
    "rejects invalid property-local applications atomically: $message",
    async ({ from, to, options, message }) => {
      const pool = createCreatorApplicationPool(options);
      const repository = createPgMarketplaceCollaborationReadRepository({
        connectionString: "postgresql://test",
        pool: pool as never,
      });
      const app = buildMarketplaceCollaborationsApp({
        repository,
        permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      });
      const response = await injectJson(app, {
        method: "POST",
        url: "/api/marketplace/collaborations",
        headers: { authorization: "Bearer valid-token" },
        payload: {
          idempotencyKey: "invalid-dates",
          offerId: "offer-001",
          compensationOptionId: "compensation-paid-001",
          whyGreatFit: "Travel creator",
          consent: true,
          terms: { travelDateFrom: from, travelDateTo: to },
          deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ message: expect.stringContaining(message) });
      expect(
        pool.calls.some((call) => call.text.includes("INSERT INTO marketplace.collaborations")),
      ).toBe(false);
      expect(pool.calls.some((call) => call.text === "ROLLBACK")).toBe(true);
    },
  );

  it("rejects a linked hotel offer owned by another organization", async () => {
    const pool = createCreatorApplicationPool({ hotelOfferOrganizationMatches: false });
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      organizationKind: "hotel_group",
      resources: [
        {
          product: "marketplace",
          resourceType: "hotel_profile",
          resourceId: "hotel-profile-001",
          relationship: "owner",
        },
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "offer-001",
          relationship: "operator",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer-001:cross-tenant-offer:v1",
        offerId: "offer-001",
        creatorId: "creator-source-001",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    const offerLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.marketplace_offers"),
    );
    expect(offerLookup?.text).toContain("offer.organization_id::text = $3");
    expect(offerLookup?.values).toEqual(["offer-001", ["offer-001"], "org_creator"]);
    expect(
      pool.calls.some((call) => call.text.includes("INSERT INTO marketplace.collaborations")),
    ).toBe(false);
  });

  it("does not replay a completed lifecycle response to an unrelated creator resource", async () => {
    const idempotencyKey = "marketplace.collaboration.respond:collab_001:replay:v1";
    const payload = { idempotencyKey, side: "creator", status: "accepted" };
    const fingerprint = testSha256(
      testStableJson({
        action: "respond",
        side: "creator",
        collaborationId: "collab_001",
        deliverableId: null,
        payload,
      }),
    );
    const pool = createUnauthorizedReplayPool(
      fingerprint,
      lifecycleWriteResponse({ action: "respond", idempotencyKey, side: "creator" }),
    );
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      resources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_unrelated",
          relationship: "owner",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/respond",
      payload,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
    expect(pool.calls.some((call) => call.text.includes("FROM platform.idempotency_keys"))).toBe(
      false,
    );
    const authorizationLookup = pool.calls.find((call) =>
      call.text.includes("FROM marketplace.collaborations collaboration"),
    );
    expect(authorizationLookup?.values[0]).toEqual(["creator_profile_unrelated"]);
    expect(pool.calls.some((call) => call.text.includes("UPDATE marketplace.collaborations"))).toBe(
      false,
    );
  });

  it("routes chat message writes through the V4 write repository", async () => {
    const messages: string[] = [];
    const repository = createCollaborationRepository({
      async sendMessage(input) {
        messages.push(`${input.side}:${input.content}:${input.contentType}`);
        return messageRead(input.collaborationId, input.content, input.contentType);
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/messages",
      payload: {
        content: "Looks good to me.",
        message_type: "text",
        idempotencyKey: "marketplace.collaboration.message:collab_001:one:v1",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      collaborationId: "collab_001",
      content: "Looks good to me.",
      contentType: "text",
    });
    expect(messages).toEqual(["creator:Looks good to me.:text"]);
  });

  it("persists private chat media IDs and returns signed attachment URLs", async () => {
    const pool = createChatAttachmentPool();
    const mediaObject = chatMediaObject();
    const signPrivateDownload = vi.fn(async () => "https://signed.example/chat-image");
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
      attachmentMedia: {
        repository: {
          async findMediaObject(mediaId) {
            return mediaId === "00000000-0000-4000-8000-000000000099" ? mediaObject : null;
          },
        },
        signer: { signPrivateDownload },
        serving: {
          bucketName: "vayada-media-test",
          cdnBaseUrl: "https://cdn.example.com",
          cdnOriginHost: "vayada-media-test.s3.amazonaws.com",
          publicPathPrefix: "media",
          publicCacheControl: "public, max-age=31536000, immutable",
          privateDownloadTtlSeconds: 300,
          privateDownloadMaxTtlSeconds: 900,
        },
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });

    const sentResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/messages",
      payload: {
        content: "Poolside breakfast at sunrise",
        contentType: "image",
        mediaObjectId: "00000000-0000-4000-8000-000000000099",
        idempotencyKey: "marketplace.collaboration.message:collab_001:image:v1",
      },
      headers: { authorization: "Bearer valid-token" },
    });
    const sent = {
      statusCode: sentResponse.statusCode,
      headers: sentResponse.headers,
      body: sentResponse.json<Record<string, unknown>>(),
    };

    expect(sent.statusCode).toBe(201);
    expect(sent.headers["cache-control"]).toBe("private, no-store");
    expect(sent.headers.vary).toBe("Authorization");
    expect(sent.body).toMatchObject({
      content: "Poolside breakfast at sunrise",
      contentType: "image",
      senderSide: "creator",
      metadata: {
        mediaObjectId: "00000000-0000-4000-8000-000000000099",
        attachmentUrl: "https://signed.example/chat-image",
        attachmentValidated: true,
        fileName: "lobby.jpg",
        fileSize: 1200,
        contentType: "image/jpeg",
      },
    });
    expect(pool.insertedMetadata).toEqual({
      mediaObjectId: "00000000-0000-4000-8000-000000000099",
    });
    expect(pool.insertedContent).toBe("Poolside breakfast at sunrise");
    const claim = pool.calls.find((call) =>
      call.text.includes("UPDATE platform.media_objects AS media"),
    );
    expect(claim?.text).toContain("media.created_by_user_id = $3::uuid");
    expect(claim?.text).toContain("media.owner_organization_id = $9::uuid");
    expect(claim?.text).toContain("media.retained_until > now()");
    expect(claim?.text).toContain("'attachmentState', 'orphan'");
    expect(claim?.values.slice(7, 10)).toEqual([
      "00000000-0000-4000-8000-000000000099",
      "org_creator",
      "2 years",
    ]);

    mediaObject.sourceMetadata = {
      attachmentState: "claimed",
      claimedByMessageId: sent.body.messageId,
    };

    const messagesResponse = await app.inject({
      method: "GET",
      url: "/api/marketplace/collaborations/collab_001/messages",
      headers: { authorization: "Bearer valid-token" },
    });
    const messages = {
      statusCode: messagesResponse.statusCode,
      headers: messagesResponse.headers,
      body: messagesResponse.json<Record<string, unknown>>(),
    };
    expect(messages.statusCode).toBe(200);
    expect(messages.headers["cache-control"]).toBe("private, no-store");
    expect(messages.headers.vary).toBe("Authorization");
    expect(messages.body).toMatchObject({
      items: [
        {
          metadata: {
            mediaObjectId: "00000000-0000-4000-8000-000000000099",
            attachmentUrl: "https://signed.example/chat-image",
            attachmentValidated: true,
          },
        },
      ],
    });
    expect(signPrivateDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        expiresInSeconds: 300,
        cacheControl: "private, no-store",
        responseContentDisposition: undefined,
      }),
    );
  });

  it("generates a fresh signed attachment URL for a delayed idempotent replay", async () => {
    const pool = createChatAttachmentPool();
    const mediaObject = chatMediaObject();
    let signedUrl = "https://signed.example/chat-image?version=initial";
    let now = new Date("2026-07-21T09:00:00.000Z");
    const signPrivateDownload = vi.fn(async () => signedUrl);
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
      attachmentMedia: attachmentMediaForTest({
        signPrivateDownload,
        mediaObject,
        now: () => now,
      }),
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });
    const request = {
      method: "POST" as const,
      url: "/api/marketplace/collaborations/collab_001/messages",
      payload: {
        content: "Poolside breakfast at sunrise",
        contentType: "image",
        mediaObjectId: "00000000-0000-4000-8000-000000000099",
        idempotencyKey: "marketplace.collaboration.message:collab_001:delayed-replay:v1",
      },
      headers: { authorization: "Bearer valid-token" },
    };

    const first = await injectJson<MarketplaceCollaborationMessage>(app, request);
    mediaObject.sourceMetadata = {
      attachmentState: "claimed",
      claimedByMessageId: first.body.messageId,
    };
    now = new Date("2026-07-21T09:10:00.000Z");
    signedUrl = "https://signed.example/chat-image?version=replay";
    const replay = await injectJson<MarketplaceCollaborationMessage>(app, request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(first.body.metadata?.attachmentUrl).toBe(
      "https://signed.example/chat-image?version=initial",
    );
    expect(replay.body).toMatchObject({
      messageId: first.body.messageId,
      metadata: {
        mediaObjectId: "00000000-0000-4000-8000-000000000099",
        attachmentUrl: "https://signed.example/chat-image?version=replay",
        attachmentValidated: true,
      },
    });
    expect(JSON.stringify(pool.storedIdempotencyMetadata)).not.toContain("signed.example");
    expect(pool.storedIdempotencyMetadata).toMatchObject({
      messageResponse: {
        metadata: { mediaObjectId: "00000000-0000-4000-8000-000000000099" },
      },
    });
    expect(
      pool.calls.filter((call) =>
        call.text.includes("INSERT INTO marketplace.marketplace_chat_messages"),
      ),
    ).toHaveLength(1);
    expect(signPrivateDownload).toHaveBeenCalledTimes(2);
    expect(signPrivateDownload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ expiresInSeconds: 300 }),
    );
  });

  it("does not sign an idempotent replay attachment claimed by another message", async () => {
    const pool = createChatAttachmentPool();
    const mediaObject = chatMediaObject();
    const signPrivateDownload = vi.fn(async () => "https://signed.example/chat-image");
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
      attachmentMedia: attachmentMediaForTest({ mediaObject, signPrivateDownload }),
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });
    const request = {
      method: "POST" as const,
      url: "/api/marketplace/collaborations/collab_001/messages",
      payload: {
        content: "Poolside breakfast at sunrise",
        contentType: "image",
        mediaObjectId: mediaObject.mediaId,
        idempotencyKey: "marketplace.collaboration.message:collab_001:cross-message-replay:v1",
      },
      headers: { authorization: "Bearer valid-token" },
    };

    const first = await injectJson<MarketplaceCollaborationMessage>(app, request);
    mediaObject.sourceMetadata = {
      attachmentState: "claimed",
      claimedByMessageId: "00000000-0000-4000-8000-000000000777",
    };
    const replay = await injectJson<MarketplaceCollaborationMessage>(app, request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.body.messageId).toBe(first.body.messageId);
    expect(replay.body.metadata).toEqual({ mediaObjectId: mediaObject.mediaId });
    expect(signPrivateDownload).toHaveBeenCalledOnce();
  });

  it("serves fixture-shaped migrated chat media only for its exact message and owner", async () => {
    const messageId = "00000000-0000-4000-8000-000000000123";
    const pool = createChatAttachmentPool({
      messageId,
      collaborationId: "collab_001",
      senderUserId: "user_creator",
      senderName: "creator",
      senderAvatarUrl: null,
      senderSide: "creator",
      content: "[image attachment migrated]",
      contentType: "image",
      metadata: {
        mediaObjectId: "00000000-0000-4000-8000-000000000099",
        attachmentSource: "platform_media_migration",
        attachmentUrl: "https://tracking.example/poisoned.jpg",
        attachmentValidated: true,
        fileName: "poisoned.jpg",
        legacySourceUrl: "https://legacy-private.example/chat.jpg",
        storageKey: "private/chat/secret.jpg",
        providerSecret: "must-not-leak",
      },
      createdAt: "2026-07-21T08:00:00.000Z",
    });
    const signPrivateDownload = vi.fn(async () => "https://signed.example/migrated-image");
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
      attachmentMedia: attachmentMediaForTest({
        signPrivateDownload,
        mediaObject: chatMediaObject({
          resourceType: "collaboration_chat_message",
          resourceId: messageId,
          sourceMetadata: { migrationCase: "media-url-migration" },
          retainedUntil: "2026-07-21T09:05:00.000Z",
        }),
        now: () => new Date("2026-07-21T09:00:00.000Z"),
      }),
    });
    const app = buildMarketplaceCollaborationsApp({ repository });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/collab_001/messages",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      items: [
        {
          messageId,
          metadata: {
            mediaObjectId: "00000000-0000-4000-8000-000000000099",
            attachmentSource: "platform_media_migration",
            attachmentUrl: "https://signed.example/migrated-image",
            attachmentValidated: true,
            fileName: "lobby.jpg",
          },
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain("tracking.example");
    expect(JSON.stringify(response.body)).not.toContain("legacy-private.example");
    expect(JSON.stringify(response.body)).not.toContain("private/chat/secret.jpg");
    expect(JSON.stringify(response.body)).not.toContain("must-not-leak");
    expect(signPrivateDownload).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "different migrated message",
      mediaOverrides: {
        resourceType: "collaboration_chat_message",
        resourceId: "00000000-0000-4000-8000-000000000999",
        sourceMetadata: { migrationCase: "media-url-migration" },
      },
    },
    {
      name: "different migrated owner",
      mediaOverrides: {
        resourceType: "collaboration_chat_message",
        resourceId: "00000000-0000-4000-8000-000000000123",
        ownerOrganizationId: "org_unrelated",
        sourceMetadata: { migrationCase: "media-url-migration" },
      },
    },
    {
      name: "missing retention",
      mediaOverrides: {
        retainedUntil: null,
      },
    },
    {
      name: "expired canonical attachment",
      mediaOverrides: {
        retainedUntil: "2026-07-21T09:00:00.000Z",
      },
    },
  ])("returns unavailable metadata for $name", async ({ mediaOverrides }) => {
    const messageId = "00000000-0000-4000-8000-000000000123";
    const pool = createChatAttachmentPool({
      messageId,
      collaborationId: "collab_001",
      senderUserId: "user_creator",
      senderName: "creator",
      senderAvatarUrl: null,
      senderSide: "creator",
      content: "Sent an image",
      contentType: "image",
      metadata: {
        mediaObjectId: "00000000-0000-4000-8000-000000000099",
        attachmentSource: "platform_media_migration",
        attachmentUrl: "https://tracking.example/poisoned.jpg",
        attachmentValidated: true,
      },
      createdAt: "2026-07-21T08:00:00.000Z",
    });
    const signPrivateDownload = vi.fn(async () => "unused");
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://target-db",
      pool: pool as never,
      attachmentMedia: attachmentMediaForTest({
        signPrivateDownload,
        mediaObject: chatMediaObject(mediaOverrides),
        now: () => new Date("2026-07-21T09:00:00.000Z"),
      }),
    });
    const app = buildMarketplaceCollaborationsApp({ repository });

    const response = await injectJson<{ items: Array<{ metadata: Record<string, unknown> }> }>(
      app,
      {
        method: "GET",
        url: "/api/marketplace/collaborations/collab_001/messages",
        headers: { authorization: "Bearer valid-token" },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.items[0]?.metadata).toEqual({
      mediaObjectId: "00000000-0000-4000-8000-000000000099",
      attachmentSource: "platform_media_migration",
    });
    expect(signPrivateDownload).not.toHaveBeenCalled();
  });

  it.each([
    { actorUserId: "another_user" },
    { ownerOrganizationId: "another_organization" },
  ] satisfies Array<Partial<PlatformMediaObjectRecord>>)(
    "rejects chat attachments uploaded outside the sender identity: %j",
    async (mediaOverrides) => {
      const pool = createChatAttachmentPool();
      const repository = createPgMarketplaceCollaborationReadRepository({
        connectionString: "postgresql://target-db",
        pool: pool as never,
        attachmentMedia: {
          repository: {
            async findMediaObject(mediaId) {
              return mediaId === "00000000-0000-4000-8000-000000000099"
                ? chatMediaObject(mediaOverrides)
                : null;
            },
          },
          signer: { signPrivateDownload: vi.fn() },
          serving: {
            bucketName: "vayada-media-test",
            cdnBaseUrl: "https://cdn.example.com",
            cdnOriginHost: "vayada-media-test.s3.amazonaws.com",
            publicPathPrefix: "media",
            publicCacheControl: "public, max-age=31536000, immutable",
            privateDownloadTtlSeconds: 300,
            privateDownloadMaxTtlSeconds: 900,
          },
        },
      });
      const app = buildMarketplaceCollaborationsApp({
        repository,
        permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      });

      const response = await injectJson(app, {
        method: "POST",
        url: "/api/marketplace/collaborations/collab_001/messages",
        payload: {
          contentType: "image",
          mediaObjectId: "00000000-0000-4000-8000-000000000099",
          idempotencyKey: `marketplace.collaboration.message:collab_001:${JSON.stringify(mediaOverrides)}:v1`,
        },
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({ code: "invalid_query" });
      expect(
        pool.calls.some((call) =>
          call.text.includes("INSERT INTO marketplace.marketplace_chat_messages"),
        ),
      ).toBe(false);
    },
  );

  it("rejects image messages without a private media object ID", async () => {
    const app = buildMarketplaceCollaborationsApp({
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
    });
    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/messages",
      payload: { contentType: "image", content: "https://public.example/image.jpg" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_query",
      message: "image messages require mediaObjectId.",
    });
  });

  it("denies lifecycle writes without the required marketplace resource link", async () => {
    const repository = createCollaborationRepository({
      async executeLifecycleWrite() {
        throw new Error("repository should not be called");
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      resources: [],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/approve",
      payload: {
        idempotencyKey: "marketplace.collaboration.approve_terms:collab_001:test:v1",
        side: "creator",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      code: "missing_creator_resource_link",
    });
  });

  it("denies creator applications without an owned creator-profile resource link", async () => {
    const repository = createCollaborationRepository({
      async executeLifecycleWrite() {
        throw new Error("repository should not be called");
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      resources: [],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer_001:test:v1",
        side: "creator",
        offerId: "offer_001",
        creatorId: "creator_profile_not_owned",
        consent: true,
        whyGreatFit: "My audience is a strong match.",
        deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      code: "missing_creator_resource_link",
    });
  });

  it("allows existing collaboration writes when the workspace owns multiple creator profiles", async () => {
    let writes = 0;
    const repository = createCollaborationRepository({
      async executeLifecycleWrite(input) {
        writes += 1;
        return lifecycleWriteResponse(input);
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      resources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_001",
          relationship: "owner",
        },
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: "creator_profile_002",
          relationship: "owner",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/approve",
      payload: {
        idempotencyKey: "marketplace.collaboration.approve_terms:collab_001:multi-profile:v1",
        side: "creator",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(writes).toBe(1);
  });

  it("requires hotel-profile and listing resource links for hotel lifecycle writes", async () => {
    const repository = createCollaborationRepository({
      async executeLifecycleWrite() {
        throw new Error("repository should not be called");
      },
    });
    const app = buildMarketplaceCollaborationsApp({
      repository,
      organizationKind: "hotel_group",
      permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      resources: [
        {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "offer_001",
          relationship: "operator",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/marketplace/collaborations/collab_001/approve",
      payload: {
        idempotencyKey: "marketplace.collaboration.approve_terms:collab_001:test:v1",
        side: "hotel",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      code: "missing_hotel_resource_link",
    });
  });
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("canonical collaboration timezone", () => {
  it("reads and edits with canonical timezone when the public profile is absent", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: TEST_DATABASE_URL!,
    });
    const userId = randomUUID();
    const creatorOrganizationId = randomUUID();
    const hotelOrganizationId = randomUUID();
    const creatorProfileId = randomUUID();
    const propertyId = randomUUID();
    const offerId = randomUUID();
    const collaborationId = randomUUID();
    const sourceCollaborationId = `timezone-${collaborationId}`;
    const optionId = randomUUID();
    const context = creatorRequestContext();
    context.actor.internalUserId = userId;
    context.selectedOrganization.organizationId = creatorOrganizationId;
    context.linkedResources = [
      {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creatorProfileId,
        relationship: "owner",
        status: "active",
      },
    ];
    await client.connect();
    try {
      await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        userId,
        context.actor.email,
      ]);
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'creator_workspace', 'Chat Creator', $2),
                ($3, 'hotel_group', 'Chat Hotel', $4)`,
        [
          creatorOrganizationId,
          `chat-creator-${creatorOrganizationId}`,
          hotelOrganizationId,
          `chat-hotel-${hotelOrganizationId}`,
        ],
      );
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, $2, 'Chat Test Hotel')`,
        [propertyId, `chat-property-${propertyId}`],
      );
      await client.query(
        `INSERT INTO marketplace.creator_profiles
           (id, organization_id, owner_user_id, display_name)
         VALUES ($1, $2, $3, 'Chat Test Creator')`,
        [creatorProfileId, creatorOrganizationId, userId],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles (property_id, organization_id)
         VALUES ($1, $2)`,
        [propertyId, hotelOrganizationId],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_offers (id, property_id, organization_id, title)
         VALUES ($1, $2, $3, 'Chat Test Offer')`,
        [offerId, propertyId, hotelOrganizationId],
      );
      await client.query(
        `INSERT INTO marketplace.collaborations
           (id, creator_profile_id, creator_organization_id, property_id,
            hotel_organization_id, offer_id, source_collaboration_id,
            initiator_type, lifecycle_status, compensation_type, paid_amount, currency, creator_consent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'creator', 'pending', 'paid', 450, 'EUR', TRUE)`,
        [
          collaborationId,
          creatorProfileId,
          creatorOrganizationId,
          propertyId,
          hotelOrganizationId,
          offerId,
          sourceCollaborationId,
        ],
      );

      await client.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, timezone) VALUES ($1, 'Pacific/Kiritimati')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO marketplace.offer_compensation_options (id, offer_id, property_id, organization_id, compensation_type, availability_months, paid_max_amount, currency) VALUES ($1, $2, $3, $4, 'paid', ARRAY['December'], 450, 'EUR')`,
        [optionId, offerId, propertyId, hotelOrganizationId],
      );
      const read = () =>
        repository.getCollaboration({
          context,
          collaborationId: sourceCollaborationId,
          side: "creator",
        });
      const before = await read();
      expect(before?.propertyTimezone).toBe("Pacific/Kiritimati");
      const result = await repository.executeLifecycleWrite!({
        context,
        side: "creator",
        action: "edit_application",
        collaborationId: sourceCollaborationId,
        idempotencyKey: `timezone-edit-${collaborationId}`,
        payload: {
          expectedUpdatedAt: before!.updatedAt,
          compensationOptionId: optionId,
          whyGreatFit: "Canonical timezone works",
          consent: true,
          terms: { travelDateFrom: "2099-12-10", travelDateTo: "2099-12-12" },
          deliverables: [{ platform: "instagram", type: "reel", quantity: 1 }],
        },
      });
      expect(result?.collaboration.propertyTimezone).toBe("Pacific/Kiritimati");
      expect((await read())?.applicationMessage).toBe("Canonical timezone works");
      await client.query(
        `UPDATE hotel_catalog.property_locations SET timezone = NULL WHERE property_id = $1`,
        [propertyId],
      );
      expect((await read())?.propertyTimezone).toBeNull();
    } finally {
      await client.query(`DELETE FROM marketplace.collaborations WHERE id = $1`, [collaborationId]);
      await client.query(`DELETE FROM marketplace.creator_profiles WHERE id = $1`, [
        creatorProfileId,
      ]);
      await client.query(`DELETE FROM hotel_catalog.properties WHERE id = $1`, [propertyId]);
      await client.query(`DELETE FROM platform.idempotency_keys WHERE organization_id = $1`, [
        creatorOrganizationId,
      ]);
      await client.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
        [creatorOrganizationId, hotelOrganizationId],
      ]);
      await client.query(`DELETE FROM identity.users WHERE id = $1`, [userId]);
      await repository.close?.();
      await client.end();
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("marketplace chat attachment persistence", () => {
  it("atomically claims an orphan once and rejects claimed, expired, and wrong-owner media", async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const mediaRepository = createPgPlatformMediaRepository({
      connectionString: TEST_DATABASE_URL!,
      publicCdnBaseUrl: "https://cdn.example.com",
    });
    const signPrivateDownload = vi.fn(async () => "https://signed.example/chat-image");
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: TEST_DATABASE_URL!,
      attachmentMedia: {
        repository: mediaRepository,
        signer: { signPrivateDownload },
        serving: {
          bucketName: "vayada-media-test",
          cdnBaseUrl: "https://cdn.example.com",
          cdnOriginHost: "vayada-media-test.s3.amazonaws.com",
          publicPathPrefix: "media",
          publicCacheControl: "public, max-age=31536000, immutable",
          privateDownloadTtlSeconds: 300,
          privateDownloadMaxTtlSeconds: 900,
        },
      },
    });
    const userId = randomUUID();
    const creatorOrganizationId = randomUUID();
    const hotelOrganizationId = randomUUID();
    const creatorProfileId = randomUUID();
    const propertyId = randomUUID();
    const offerId = randomUUID();
    const collaborationId = randomUUID();
    const sourceCollaborationId = `integration-${collaborationId}`;
    const mediaIds = {
      orphan: randomUUID(),
      claimed: randomUUID(),
      expired: randomUUID(),
      wrongOwner: randomUUID(),
    };
    const allMediaIds = Object.values(mediaIds);
    const context: RequestContext = {
      actor: {
        internalUserId: userId,
        providerIdentity: { provider: "workos", providerUserId: `workos-${userId}` },
        email: `${userId}@example.com`,
        status: "active",
      },
      selectedOrganization: {
        organizationId: creatorOrganizationId,
        kind: "creator_workspace",
        status: "active",
      },
      membership: {
        membershipId: randomUUID(),
        status: "active",
        roleKey: "creator_owner",
        workosRoleSlugs: [],
        permissions: ["marketplace.collaboration.read", "marketplace.collaboration.write"],
      },
      linkedResources: [
        {
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: creatorProfileId,
          relationship: "owner",
          status: "active",
        },
      ],
      entitlements: [],
      locale: "en",
      currency: "USD",
      audit: {
        requestId: randomUUID(),
        source: "web",
        receivedAt: new Date().toISOString(),
      },
    };

    await client.connect();
    try {
      await client.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
        userId,
        context.actor.email,
      ]);
      await client.query(
        `INSERT INTO identity.organizations (id, kind, name, slug)
         VALUES ($1, 'creator_workspace', 'Chat Creator', $2),
                ($3, 'hotel_group', 'Chat Hotel', $4)`,
        [
          creatorOrganizationId,
          `chat-creator-${creatorOrganizationId}`,
          hotelOrganizationId,
          `chat-hotel-${hotelOrganizationId}`,
        ],
      );
      await client.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1, $2, 'Chat Test Hotel')`,
        [propertyId, `chat-property-${propertyId}`],
      );
      await client.query(
        `INSERT INTO marketplace.creator_profiles
           (id, organization_id, owner_user_id, display_name)
         VALUES ($1, $2, $3, 'Chat Test Creator')`,
        [creatorProfileId, creatorOrganizationId, userId],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles (property_id, organization_id)
         VALUES ($1, $2)`,
        [propertyId, hotelOrganizationId],
      );
      await client.query(
        `INSERT INTO marketplace.marketplace_offers (id, property_id, organization_id, title)
         VALUES ($1, $2, $3, 'Chat Test Offer')`,
        [offerId, propertyId, hotelOrganizationId],
      );
      await client.query(
        `INSERT INTO marketplace.collaborations
           (id, creator_profile_id, creator_organization_id, property_id,
            hotel_organization_id, offer_id, source_collaboration_id,
            initiator_type, lifecycle_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'hotel', 'accepted')`,
        [
          collaborationId,
          creatorProfileId,
          creatorOrganizationId,
          propertyId,
          hotelOrganizationId,
          offerId,
          sourceCollaborationId,
        ],
      );

      for (const [state, mediaId] of Object.entries(mediaIds)) {
        const ownerOrganizationId =
          state === "wrongOwner" ? hotelOrganizationId : creatorOrganizationId;
        const attachmentState = state === "claimed" ? "claimed" : "orphan";
        const retainedUntil = new Date(
          Date.now() + (state === "expired" ? -60_000 : 60_000),
        ).toISOString();
        const storageKey = `private/media/chat/provider_original/${mediaId}.jpg`;
        await client.query(
          `INSERT INTO platform.media_objects
             (id, bucket, storage_key, visibility, purpose, owner_organization_id,
              property_id, resource_product, resource_type, resource_id,
              lifecycle_status, content_type, size_bytes, original_filename,
              source_metadata, retained_until, created_by_user_id)
           VALUES ($1, 'vayada-media-test', $2, 'private',
                   'marketplace.collaboration_chat.attachment', $3, $4,
                   'marketplace', 'collaboration', $5, 'active', 'image/jpeg',
                   1200, 'chat.jpg', $6::jsonb, $7::timestamptz, $8)`,
          [
            mediaId,
            storageKey,
            ownerOrganizationId,
            propertyId,
            collaborationId,
            JSON.stringify({ attachmentState, requestedVisibility: "private" }),
            retainedUntil,
            userId,
          ],
        );
        await client.query(
          `INSERT INTO platform.media_variants
             (media_object_id, variant_name, visibility, storage_key,
              content_type, size_bytes)
           VALUES ($1, 'provider_original', 'private', $2, 'image/jpeg', 1200)`,
          [mediaId, storageKey],
        );
      }

      const send = (mediaObjectId: string, attempt: number) =>
        repository.sendMessage!({
          context,
          side: "creator",
          collaborationId: sourceCollaborationId,
          content: "Sent an image",
          contentType: "image",
          mediaObjectId,
          idempotencyKey: `marketplace.collaboration.message:${sourceCollaborationId}:${mediaObjectId}:${attempt}:v1`,
        });
      const concurrentResults = await Promise.allSettled([
        send(mediaIds.orphan, 1),
        send(mediaIds.orphan, 2),
      ]);
      expect(concurrentResults.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(concurrentResults.filter(({ status }) => status === "rejected")).toHaveLength(1);
      const inserted = await client.query<{
        count: string;
        claimedByMessageId: string | null;
      }>(
        `SELECT count(message.id)::text AS count,
                max(media.source_metadata ->> 'claimedByMessageId') AS "claimedByMessageId"
         FROM platform.media_objects media
         LEFT JOIN marketplace.marketplace_chat_messages message
           ON message.id::text = media.source_metadata ->> 'claimedByMessageId'
         WHERE media.id = $1`,
        [mediaIds.orphan],
      );
      expect(inserted.rows[0]).toMatchObject({
        count: "1",
        claimedByMessageId: expect.any(String),
      });

      for (const mediaObjectId of [mediaIds.claimed, mediaIds.expired, mediaIds.wrongOwner]) {
        await expect(send(mediaObjectId, 3)).rejects.toMatchObject({
          statusCode: 400,
          code: "invalid_query",
        });
      }
      expect(signPrivateDownload).toHaveBeenCalledTimes(3);
    } finally {
      await client.query(`DELETE FROM marketplace.collaborations WHERE id = $1`, [collaborationId]);
      await client.query(`DELETE FROM platform.media_objects WHERE id = ANY($1::uuid[])`, [
        allMediaIds,
      ]);
      await client.query(`DELETE FROM marketplace.creator_profiles WHERE id = $1`, [
        creatorProfileId,
      ]);
      await client.query(`DELETE FROM hotel_catalog.properties WHERE id = $1`, [propertyId]);
      await client.query(
        `DELETE FROM platform.idempotency_keys
         WHERE organization_id = ANY($1::uuid[])`,
        [[creatorOrganizationId, hotelOrganizationId]],
      );
      await client.query(`DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])`, [
        [creatorOrganizationId, hotelOrganizationId],
      ]);
      await client.query(`DELETE FROM identity.users WHERE id = $1`, [userId]);
      await repository.close?.();
      await mediaRepository.close?.();
      await client.end();
    }
  });
});

describe("marketplace collaboration PostgreSQL behavior", () => {
  it("replays messages atomically only inside the authenticated organization scope", async () => {
    const idempotency = new Map<
      string,
      { requestFingerprintHash: string; metadata: unknown; status: "completed" }
    >();
    let messageInserts = 0;
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      async query(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("FROM marketplace.collaborations collaboration")) {
          const resourceIds = values[0] as string[];
          return resourceIds.includes("creator_profile_001")
            ? {
                rows: [
                  {
                    id: "00000000-0000-4000-8000-000000000061",
                    propertyId: "00000000-0000-4000-8000-000000000062",
                    lifecycleStatus: "active",
                    initiatorSide: "creator",
                    sourceCollaborationId: "collab_001",
                    compensationType: "paid",
                    affiliateEnabled: false,
                    creatorProfileId: "creator_profile_001",
                    creatorOrganizationId: "org_creator",
                    hotelOrganizationId: "org_hotel",
                    creatorAgreedAt: null,
                    hotelAgreedAt: null,
                  },
                ],
              }
            : { rows: [] };
        }
        if (text.includes("FROM platform.idempotency_keys")) {
          const key = `${values[2]}:${values[0]}:${values[1]}`;
          const row = idempotency.get(key);
          return { rows: row ? [row] : [] };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000051" }] };
        }
        if (text.includes("INSERT INTO marketplace.marketplace_chat_messages")) {
          messageInserts += 1;
          return {
            rows: [
              {
                messageId: "00000000-0000-4000-8000-000000000071",
                collaborationId: "collab_001",
                senderUserId: "user_creator",
                senderName: "creator",
                senderAvatarUrl: null,
                senderSide: "creator",
                content: "Safe retry",
                contentType: "text",
                metadata: {},
                createdAt: "2026-07-22T10:00:00.000Z",
              },
            ],
          };
        }
        if (text.includes("UPDATE platform.idempotency_keys")) {
          const organizationId = String(values[6]);
          const operation = String(values[4]);
          const keyHash = String(values[5]);
          idempotency.set(`${organizationId}:${operation}:${keyHash}`, {
            requestFingerprintHash: String(values[0]),
            metadata: JSON.parse(String(values[3])),
            status: "completed",
          });
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      release() {},
    };
    const pool = {
      async query() {
        throw new Error("message writes must use a transaction client");
      },
      async connect() {
        return client;
      },
      async end() {},
    };
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://test",
      pool,
    });
    const input = {
      context: creatorRequestContext(),
      side: "creator" as const,
      collaborationId: "collab_001",
      content: "Safe retry",
      contentType: "text" as const,
      idempotencyKey: "marketplace.collaboration.message:collab_001:retry:v1",
    };

    const first = await repository.sendMessage?.(input);
    const replay = await repository.sendMessage?.(input);
    const otherTenant = await repository.sendMessage?.({
      ...input,
      context: creatorRequestContext({
        organizationId: "00000000-0000-4000-8000-000000000099",
        creatorProfileId: "creator_profile_other",
      }),
    });

    expect(first?.messageId).toBe("00000000-0000-4000-8000-000000000071");
    expect(replay).toEqual(first);
    expect(otherTenant).toBeNull();
    expect(messageInserts).toBe(1);
    const replayLookups = queries.filter((query) =>
      query.text.includes("FROM platform.idempotency_keys"),
    );
    expect(replayLookups).toHaveLength(2);
    expect(
      replayLookups.every(
        (lookup) =>
          lookup.text.includes("tenant_scope = 'organization'") &&
          lookup.text.includes("organization_id = $3::uuid"),
      ),
    ).toBe(true);
    for (const replayLookup of replayLookups) {
      const lookupIndex = queries.indexOf(replayLookup);
      expect(queries[lookupIndex - 1]?.text).toContain(
        "FROM marketplace.collaborations collaboration",
      );
    }
  });

  it("types the optional message cursor so an unpaginated chat read is valid PostgreSQL", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text.includes("FROM marketplace.collaborations collaboration")) {
          return { rows: [{ id: "collaboration_internal_001", propertyId: "property_001" }] };
        }
        if (text.includes("FROM marketplace.marketplace_chat_messages message")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      async end() {},
    };
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://test",
      pool: pool as MarketplaceCollaborationReadPool,
    });

    const response = await repository.listMessages({
      context: creatorRequestContext(),
      collaborationId: "collab_001",
      side: "creator",
      filters: {},
    });

    const messageQuery = queries.find((query) =>
      query.text.includes('$4::text AS "collaborationId"'),
    );
    expect(response?.items).toEqual([]);
    expect(messageQuery?.text).toContain(
      "($3::timestamptz IS NULL OR message.created_at < $3::timestamptz)",
    );
    expect(messageQuery?.values).toEqual([
      "collaboration_internal_001",
      "property_001",
      null,
      "collab_001",
      null,
      null,
    ]);
  });

  it("paginates messages with the created-at and message-id tuple", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text.includes("FROM marketplace.collaborations collaboration")) {
          return { rows: [{ id: "collaboration_internal_001", propertyId: "property_001" }] };
        }
        if (text.includes("FROM marketplace.marketplace_chat_messages message")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      async end() {},
    };
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://test",
      pool: pool as MarketplaceCollaborationReadPool,
    });

    await repository.listMessages({
      context: creatorRequestContext(),
      collaborationId: "collab_001",
      side: "creator",
      filters: {
        cursor: {
          createdAt: "2026-07-21T10:15:00.000Z",
          messageId: "00000000-0000-4000-8000-000000000041",
        },
      },
    });

    expect(queries[1]?.text).toContain(
      "(message.created_at, message.id) < ($5::timestamptz, $6::uuid)",
    );
    expect(queries[1]?.values?.slice(4)).toEqual([
      "2026-07-21T10:15:00.000Z",
      "00000000-0000-4000-8000-000000000041",
    ]);
  });

  it("uses stable conversation tuple pagination and escaped server-side search", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        return {
          rows: [
            {
              collaborationId: "collab_002",
              side: "creator",
              partnerName: "Hotel Aurora",
              partnerAvatarUrl: null,
              offerTitle: "Aurora winter stay",
              collaborationStatus: "pending",
              lastMessageContent: "Welcome",
              lastMessageAt: "2026-07-22T09:00:00.000Z",
              unreadCount: "1",
              sortAt: "2026-07-22T09:00:00.000Z",
            },
            {
              collaborationId: "collab_001",
              side: "creator",
              partnerName: "Hotel Aurora",
              partnerAvatarUrl: null,
              offerTitle: "Aurora autumn stay",
              collaborationStatus: "active",
              lastMessageContent: null,
              lastMessageAt: null,
              unreadCount: "0",
              sortAt: "2026-07-21T09:00:00.000Z",
            },
          ],
        };
      },
      async end() {},
    };
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://test",
      pool: pool as MarketplaceCollaborationReadPool,
    });

    const page = await repository.listConversations({
      context: creatorRequestContext(),
      side: "creator",
      filters: { limit: 1, search: "Aurora_100%" },
    });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(queries[0]?.text).toContain("ILIKE $2 ESCAPE '\\'");
    expect(queries[0]?.text).toContain(
      'ORDER BY COALESCE(last_message."lastMessageAt", collaboration.updated_at) DESC',
    );
    expect(queries[0]?.values).toEqual([["creator_profile_001"], "%Aurora\\_100\\%%", 2]);
  });

  it("updates only unread messages sent by the other collaboration side", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text.includes("FROM marketplace.collaborations collaboration")) {
          return { rows: [{ id: "collaboration_internal_001", propertyId: "property_001" }] };
        }
        if (text.startsWith("WITH read_cursor AS")) {
          return { rows: [{ cursorFound: true }] };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      async end() {},
    };
    const repository = createPgMarketplaceCollaborationReadRepository({
      connectionString: "postgresql://test",
      pool: pool as MarketplaceCollaborationReadPool,
    });

    await expect(
      repository.markMessagesRead?.({
        context: creatorRequestContext(),
        collaborationId: "collab_001",
        side: "creator",
        readThrough: {
          createdAt: "2026-07-21T10:15:00.000Z",
          messageId: "00000000-0000-4000-8000-000000000041",
        },
      }),
    ).resolves.toBe(true);

    expect(queries[1]?.text).toContain("AND message.sender_type <> $3");
    expect(queries[1]?.text).toContain(
      "(message.created_at, message.id) <= (read_cursor.created_at, read_cursor.id)",
    );
    expect(queries[1]?.values).toEqual([
      "collaboration_internal_001",
      "property_001",
      "creator",
      "2026-07-21T10:15:00.000Z",
      "00000000-0000-4000-8000-000000000041",
    ]);
  });
});

function buildMarketplaceCollaborationsApp(
  options: {
    repository?: MarketplaceCollaborationReadRepository;
    permissions?: PermissionKey[];
    organizationKind?: "creator_workspace" | "hotel_group";
    resources?: Array<{
      product: Product;
      resourceType: ResourceType;
      resourceId: string;
      relationship: ResourceRelationship;
    }>;
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    marketplaceCollaborationRepository: options.repository ?? createCollaborationRepository(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository({
        organizationKind: options.organizationKind,
        resources: options.resources,
      }),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["marketplace.collaboration.read"];
        },
      },
    },
  });
}

function createCollaborationRepository(
  overrides: Partial<MarketplaceCollaborationReadRepository> = {},
): MarketplaceCollaborationReadRepository {
  return {
    async listCollaborations() {
      return toMarketplaceCollaborationListResponse({
        authorizationMode: "creator_workspace_resource_link",
        items: [collaborationRead()],
      });
    },
    async getCollaboration() {
      return collaborationRead();
    },
    async listConversations() {
      return conversationPage();
    },
    async listMessages({ collaborationId }) {
      return {
        contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
        collaborationId,
        authorizationMode: "creator_workspace_resource_link",
        items: [],
      };
    },
    async executeLifecycleWrite(input) {
      return lifecycleWriteResponse(input);
    },
    async sendMessage(input) {
      return messageRead(input.collaborationId, input.content, input.contentType);
    },
    ...overrides,
  };
}

function lifecycleWriteResponse(
  input: Pick<MarketplaceCollaborationLifecycleWriteInput, "action" | "idempotencyKey" | "side">,
): MarketplaceCollaborationLifecycleWriteResponse {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_LIFECYCLE_WRITES_CONTRACT_VERSION,
    command: {
      action: input.action,
      idempotencyKey: input.idempotencyKey,
    },
    collaboration: {
      ...collaborationRead(),
      side: input.side,
    },
    sideEffects: [{ type: "marketplace.collaboration.system_message_requested" }],
  };
}

function messageRead(
  collaborationId: string,
  content: string,
  contentType: "text" | "image",
): MarketplaceCollaborationMessage {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    messageId: "msg_target_001",
    collaborationId,
    senderUserId: "user_creator",
    senderName: "creator",
    senderAvatarUrl: null,
    senderSide: "creator",
    content,
    contentType,
    metadata: null,
    createdAt: "2026-06-13T12:00:00.000Z",
  };
}

function collaborationRead(): MarketplaceCollaborationRead {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    authorizationMode: "creator_workspace_resource_link",
    collaborationId: "collab_001",
    offerId: "offer_001",
    creatorId: "creator_legacy_001",
    hotelProfileId: "hotel_profile_001",
    side: "creator",
    initiatorSide: "creator",
    isInitiator: true,
    status: "pending",
    compensationType: "free_stay",
    offerTitle: "Alpenrose launch",
    hotelLocation: "Tyrol, Austria",
    creator: {
      side: "creator",
      organizationId: "org_creator",
      profileId: "creator_profile_001",
      displayName: "Ari Creator",
      avatarUrl: null,
      location: "Berlin, Germany",
      portfolioUrl: "https://ari.example.com",
      creatorType: "travel",
      platforms: [],
    },
    hotel: {
      side: "hotel",
      organizationId: "org_hotel",
      profileId: "hotel_profile_001",
      displayName: "Hotel Alpenrose",
      avatarUrl: null,
    },
    terms: {
      freeStayMinNights: null,
      freeStayMaxNights: null,
      paidAmount: null,
      currency: "EUR",
      discountPercentage: null,
      affiliateEnabled: true,
      affiliateCommissionPercentage: "12.00",
      travelDateFrom: null,
      travelDateTo: null,
      preferredDateFrom: null,
      preferredDateTo: null,
      preferredMonths: ["2026-09"],
    },
    deliverables: [],
    lastMessageAt: null,
    createdAt: "2026-06-12T12:00:00.000Z",
    updatedAt: "2026-06-12T12:00:00.000Z",
  };
}

function conversationPage() {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    items: [],
    nextCursor: null,
    hasMore: false,
  };
}

function identityRepository(
  options: {
    organizationKind?: "creator_workspace" | "hotel_group";
    resources?: Array<{
      product: Product;
      resourceType: ResourceType;
      resourceId: string;
      relationship: ResourceRelationship;
    }>;
  } = {},
): IdentityRepository {
  const resources = options.resources ?? [
    {
      product: "marketplace" as const,
      resourceType: "creator_profile" as const,
      resourceId: "creator_profile_001",
      relationship: "owner" as const,
    },
  ];
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_creator",
        email: "creator@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_creator",
        workosOrgId: "workos_creator_org",
        kind: options.organizationKind ?? "creator_workspace",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_creator",
        status: "active",
        roleKey: "creator_owner",
        workosMembershipId: "membership_workos_creator",
        workosRoleSlugs: ["creator_owner"],
      };
    },
    async findLinkedResources() {
      return resources.map((resource) => ({ ...resource, status: "active" }));
    },
  };
}

function createCreatorApplicationPool(
  options: {
    mutationStatus?: string;
    mutationInitiator?: string;
    failDeliverables?: boolean;
    mixedDates?: boolean;
    timezone?: string | null;
    availabilityMonths?: string[];
    compensationOptionExists?: boolean;
    offerStatus?: "pending" | "verified";
    creatorProfileOrganizationMatches?: boolean;
    hotelOfferOrganizationMatches?: boolean;
  } = {},
) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    let rows: unknown[] = [];
    if (text.includes("FROM platform.idempotency_keys")) {
      rows = [];
    } else if (text.includes("INSERT INTO platform.idempotency_keys")) {
      rows = [{ id: "idempotency-001" }];
    } else if (
      text.includes("DELETE FROM marketplace.collaboration_deliverables") &&
      options.failDeliverables
    ) {
      throw new Error("deliverable storage unavailable");
    } else if (
      text.includes('AS "lifecycleStatus"') &&
      text.includes("FROM marketplace.collaborations collaboration")
    ) {
      rows = [
        {
          id: "collaboration-target-001",
          propertyId: "property-001",
          offerId: "offer-001",
          sourceCollaborationId: "collab_001",
          lifecycleStatus: options.mutationStatus ?? "pending",
          initiatorSide: options.mutationInitiator ?? "creator",
          updatedAt: "2026-09-05T01:00:00.000Z",
        },
      ];
    } else if (text.includes("FROM hotel_catalog.property_locations")) {
      rows = [{ timezone: options.timezone === undefined ? "Europe/Vienna" : options.timezone }];
    } else if (text.includes("FROM marketplace.creator_profiles")) {
      const crossTenantCreatorLink =
        options.creatorProfileOrganizationMatches === false &&
        text.includes("AND organization_id::text");
      rows = crossTenantCreatorLink
        ? []
        : [
            {
              id: "creator-profile-target-001",
              organizationId: "org_creator",
            },
          ];
    } else if (text.includes("FROM marketplace.marketplace_offers")) {
      const creatorCannotSeePending =
        options.offerStatus === "pending" && text.includes("offer_status = 'verified'");
      const crossTenantHotelOffer =
        options.hotelOfferOrganizationMatches === false &&
        text.includes("AND offer.organization_id::text");
      rows =
        creatorCannotSeePending || crossTenantHotelOffer
          ? []
          : [
              {
                id: "offer-001",
                propertyId: "property-001",
                organizationId: "org_creator",
              },
            ];
    } else if (text.includes("FROM marketplace.offer_compensation_options")) {
      rows =
        options.compensationOptionExists === false
          ? []
          : [
              {
                compensationOptionId: "compensation-paid-001",
                compensationType: "paid",
                availabilityMonths: options.availabilityMonths ?? ["July", "August"],
                platforms: ["instagram"],
                freeStayMinNights: null,
                freeStayMaxNights: null,
                paidMaxAmount: "450.00",
                currency: "EUR",
                discountPercentage: null,
                commissionPercentage: null,
                minFollowers: 5000,
                termsSummary: "One Reel and three Stories",
                metadata: { approvalWindowDays: 7 },
              },
            ];
    } else if (text.includes("FROM marketplace.collaborations WHERE id")) {
      rows = [
        {
          travelDateFrom: options.mixedDates ? "2026-07-01" : "2026-02-01",
          travelDateTo: options.mixedDates ? "2026-07-03" : "2026-02-03",
          preferredDateFrom: options.mixedDates ? "2026-02-01" : null,
          preferredDateTo: options.mixedDates ? "2026-02-03" : null,
        },
      ];
    } else if (text.includes("collaboration.id::text AS id")) {
      rows = [
        {
          id: "collaboration-target-001",
          propertyId: "property-001",
          lifecycleStatus: "pending",
          initiatorSide: "creator",
        },
      ];
    } else if (text.includes("SELECT gen_random_uuid()")) {
      rows = [{ id: "collaboration-target-001" }];
    } else if (text.includes("INSERT INTO marketplace.collaborations")) {
      rows = [{ id: "collaboration-target-001" }];
    } else if (
      text.includes("FROM marketplace.collaborations collaboration") &&
      text.includes("WHERE collaboration.id::text = $1")
    ) {
      rows = [creatorApplicationRow()];
    }
    return { rows };
  };
  const client = { query, release() {} };
  return {
    calls,
    query,
    async connect() {
      return client;
    },
    async end() {},
  };
}

function creatorRequestContext(
  overrides: { organizationId?: string; creatorProfileId?: string } = {},
): RequestContext {
  return {
    actor: {
      internalUserId: "user_creator",
      providerIdentity: {
        provider: "workos",
        providerUserId: "workos_creator_user",
        providerOrganizationId: "workos_creator_org",
      },
      email: "creator@example.com",
      status: "active",
    },
    selectedOrganization: {
      organizationId: overrides.organizationId ?? "org_creator",
      workosOrgId: "workos_creator_org",
      kind: "creator_workspace",
      status: "active",
    },
    membership: {
      membershipId: "membership_creator",
      status: "active",
      roleKey: "creator_owner",
      permissions: ["marketplace.collaboration.write"],
      workosMembershipId: "membership_workos_creator",
      workosRoleSlugs: ["creator_owner"],
    },
    linkedResources: [
      {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: overrides.creatorProfileId ?? "creator_profile_001",
        relationship: "owner",
        status: "active",
      },
    ],
    entitlements: [],
    locale: "en",
    currency: "EUR",
    audit: {
      requestId: "request_creator_application",
      source: "web",
      receivedAt: "2026-07-21T10:00:00.000Z",
    },
  };
}

function creatorApplicationRow() {
  return {
    collaborationId: "collaboration-target-001",
    authorizationMode: "creator_workspace_resource_link",
    offerId: "offer-001",
    creatorId: "creator-source-001",
    hotelProfileId: "property-001",
    side: "creator",
    initiatorSide: "creator",
    status: "pending",
    compensationType: "paid",
    offerTitle: "City hotel launch",
    hotelLocation: "Munich, Germany",
    creatorProfileId: "creator-profile-target-001",
    creatorOrganizationId: "creator-org-target-001",
    creatorDisplayName: "Ari Creator",
    creatorAvatarUrl: null,
    hotelProfileResourceId: "property-001",
    hotelOrganizationId: "hotel-org-001",
    hotelDisplayName: "City Hotel",
    hotelAvatarUrl: null,
    freeStayMinNights: null,
    freeStayMaxNights: null,
    paidAmount: "450.00",
    currency: "EUR",
    discountPercentage: null,
    affiliateEnabled: false,
    affiliateCommissionPercentage: null,
    travelDateFrom: null,
    travelDateTo: null,
    preferredDateFrom: null,
    preferredDateTo: null,
    preferredMonths: [],
    applicationMessage: "My audience is a strong match.",
    creatorConsent: true,
    creatorAgreedAt: "2026-07-21T10:05:00.000Z",
    hotelAgreedAt: null,
    deliverables: [],
    lastMessageAt: null,
    createdAt: "2026-07-21T08:00:00.000Z",
    updatedAt: "2026-07-21T08:00:00.000Z",
  };
}

function createUnauthorizedReplayPool(
  requestFingerprintHash: string,
  response: MarketplaceCollaborationLifecycleWriteResponse,
) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    if (text.includes("FROM platform.idempotency_keys")) {
      return {
        rows: [
          {
            status: "completed",
            requestFingerprintHash,
            metadata: { response },
          },
        ],
      };
    }
    if (text.includes("FROM marketplace.collaborations collaboration")) {
      return { rows: [] };
    }
    return { rows: [] };
  };
  const client = { query, release() {} };
  return {
    calls,
    query,
    async connect() {
      return client;
    },
    async end() {},
  };
}

function testSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function testStableJson(value: unknown): string {
  return JSON.stringify(testSortJson(value));
}

function testSortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(testSortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, testSortJson(entry)]),
  );
}

function createChatAttachmentPool(initialMessage: Record<string, unknown> | null = null) {
  let message: Record<string, unknown> | null = initialMessage;
  let idempotencyReplay: {
    status: "completed";
    requestFingerprintHash: string;
    metadata: Record<string, unknown>;
  } | null = null;
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const pool = {
    calls,
    insertedMetadata: null as Record<string, unknown> | null,
    insertedContent: null as string | null,
    storedIdempotencyMetadata: null as Record<string, unknown> | null,
    async query(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("FROM platform.idempotency_keys")) {
        return { rows: idempotencyReplay ? [idempotencyReplay] : [] };
      }
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return { rows: [{ id: "idempotency-message-001" }] };
      }
      if (
        text.includes("UPDATE platform.idempotency_keys") &&
        text.includes("response_resource_type = 'collaboration_message'")
      ) {
        pool.storedIdempotencyMetadata = JSON.parse(String(values[3])) as Record<string, unknown>;
        idempotencyReplay = {
          status: "completed",
          requestFingerprintHash: String(values[0]),
          metadata: pool.storedIdempotencyMetadata,
        };
        return { rows: [] };
      }
      if (text.includes("INSERT INTO marketplace.marketplace_chat_messages")) {
        pool.insertedMetadata = JSON.parse(String(values[6])) as Record<string, unknown>;
        pool.insertedContent = String(values[5]);
        message = {
          messageId: "message-target-001",
          collaborationId: "collab_001",
          senderUserId: "user_creator",
          senderName: "creator",
          senderAvatarUrl: null,
          senderSide: "creator",
          content: values[5],
          contentType: values[4],
          metadata: pool.insertedMetadata,
          createdAt: "2026-07-21T08:00:00.000Z",
        };
        return { rows: [message] };
      }
      if (text.includes("FROM marketplace.collaborations collaboration")) {
        return {
          rows: [
            {
              id: "collaboration-target-001",
              propertyId: "property-target-001",
              lifecycleStatus: "accepted",
              initiatorSide: "creator",
              sourceCollaborationId: "collab_001",
              compensationType: "free_stay",
              affiliateEnabled: false,
              creatorProfileId: "creator_profile_001",
              creatorOrganizationId: "org_creator",
              hotelOrganizationId: "org_hotel",
              creatorAgreedAt: null,
              hotelAgreedAt: null,
            },
          ],
        };
      }
      if (text.includes("FROM marketplace.marketplace_chat_messages message")) {
        return { rows: message ? [message] : [] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        query: pool.query,
        release() {},
      };
    },
    async end() {},
  };
  return pool;
}

function attachmentMediaForTest(input: {
  mediaObject: PlatformMediaObjectRecord;
  signPrivateDownload: PlatformMediaPrivateDownloadSigner["signPrivateDownload"];
  now?: () => Date;
}) {
  return {
    repository: {
      async findMediaObject(mediaId: string) {
        return mediaId === input.mediaObject.mediaId ? input.mediaObject : null;
      },
    },
    signer: { signPrivateDownload: input.signPrivateDownload },
    serving: {
      bucketName: "vayada-media-test",
      cdnBaseUrl: "https://cdn.example.com",
      cdnOriginHost: "vayada-media-test.s3.amazonaws.com",
      publicPathPrefix: "media",
      publicCacheControl: "public, max-age=31536000, immutable",
      privateDownloadTtlSeconds: 300,
      privateDownloadMaxTtlSeconds: 900,
    },
    now: input.now,
  };
}

function chatMediaObject(
  overrides: Partial<PlatformMediaObjectRecord> = {},
): PlatformMediaObjectRecord {
  return {
    mediaId: "00000000-0000-4000-8000-000000000099",
    purpose: "marketplace.collaboration_chat.attachment" as const,
    visibility: "private" as const,
    requestedVisibility: "private" as const,
    approvalStatus: "private" as const,
    lifecycleStatus: "active" as const,
    storageKind: "vayada_managed" as const,
    bucket: "vayada-media-test",
    storageKey: "private/media/chat/provider_original/lobby.jpg",
    ownerOrganizationId: "org_creator",
    actorUserId: "user_creator",
    resourceProduct: "marketplace",
    resourceType: "collaboration",
    resourceId: "collaboration-target-001",
    propertyId: "property-target-001",
    contentType: "image/jpeg",
    sizeBytes: 1200,
    widthPx: 1200,
    heightPx: 800,
    checksumSha256: "a".repeat(64),
    originalFilename: "lobby.jpg",
    variants: [
      {
        variantName: "provider_original" as const,
        visibility: "private" as const,
        storageKey: "private/media/chat/provider_original/lobby.jpg",
        contentType: "image/jpeg",
        widthPx: 1200,
        heightPx: 800,
        sizeBytes: 1200,
        checksumSha256: "a".repeat(64),
        publicCdnUrl: null,
      },
    ],
    createdAt: "2026-07-21T08:00:00.000Z",
    retainedUntil: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}
