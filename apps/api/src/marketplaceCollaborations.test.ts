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
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  createPgMarketplaceCollaborationReadRepository,
  toMarketplaceCollaborationListResponse,
  type MarketplaceCollaborationListFilters,
  type MarketplaceCollaborationLifecycleWriteInput,
  type MarketplaceCollaborationLifecycleWriteResponse,
  type MarketplaceCollaborationReadRepository,
} from "./routes/marketplaceCollaborations.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "workos_creator_user",
  workosOrgId: "workos_creator_org",
  sessionId: "session_marketplace_creator",
  expiresAt: futureExpiry,
};

describe("marketplace collaboration read routes", () => {
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
        return [];
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

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/marketplace/collaborations/conversations",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual([]);
    expect(calls).toEqual(["hotel"]);
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
      payload: { content: "Looks good to me.", message_type: "text" },
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
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      code: "missing_creator_resource_link",
    });
  });

  it("rejects creator applications when the workspace owns multiple creator profiles", async () => {
    const repository = createCollaborationRepository({
      async executeLifecycleWrite() {
        throw new Error("repository should not be called");
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
      url: "/api/marketplace/collaborations",
      payload: {
        idempotencyKey: "marketplace.collaboration.create:offer_001:ambiguous:v1",
        side: "creator",
        offerId: "offer_001",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: "ambiguous_marketplace_creator_profile",
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

describe("marketplace collaboration PostgreSQL writes", () => {
  it("resolves a target-native creator with no source ID from the authenticated resource link", async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const targetNativeCreator = {
      id: "creator_profile_001",
      organizationId: "org_creator",
      sourceCreatorId: null,
    };
    const client = {
      async query(text: string, values: readonly unknown[] = []) {
        queries.push({ text, values });
        if (text === "BEGIN" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("FROM platform.idempotency_keys")) return { rows: [] };
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "idempotency_001" }] };
        }
        if (text.includes("FROM marketplace.creator_profiles")) {
          return { rows: [targetNativeCreator] };
        }
        if (text.includes("FROM marketplace.marketplace_offers")) {
          return {
            rows: [{ id: "offer_001", propertyId: "property_001", organizationId: "org_hotel" }],
          };
        }
        if (text.includes("SELECT gen_random_uuid()")) {
          return { rows: [{ id: "collaboration_target_001" }] };
        }
        if (text.includes("INSERT INTO marketplace.collaborations")) {
          return { rows: [{ id: "collaboration_target_001" }] };
        }
        if (text.includes("FROM marketplace.collaborations collaboration")) {
          return { rows: [targetNativeCollaborationRow()] };
        }
        if (text.includes("UPDATE platform.idempotency_keys")) return { rows: [] };
        if (text === "COMMIT") return { rows: [] };
        throw new Error(`Unexpected query: ${text}`);
      },
      release() {},
    };
    const pool = {
      async query() {
        throw new Error("transactional writes must use a client");
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

    const result = await repository.executeLifecycleWrite?.({
      context: creatorRequestContext(),
      side: "creator",
      action: "create",
      idempotencyKey: "marketplace.collaboration.create:offer_001:test:v1",
      payload: {
        offerId: "offer_001",
        creatorId: "legacy_or_user_id_from_browser",
        initiatorSide: "hotel",
      },
    });

    const creatorLookup = queries.find((query) =>
      query.text.includes("FROM marketplace.creator_profiles"),
    );
    const collaborationRead = queries.find((query) =>
      query.text.includes("FROM marketplace.collaborations collaboration"),
    );
    const collaborationInsert = queries.find((query) =>
      query.text.includes("INSERT INTO marketplace.collaborations"),
    );
    expect(result?.collaboration.creatorId).toBe("creator_profile_001");
    expect(creatorLookup?.text).not.toContain("source_creator_id");
    expect(creatorLookup?.values).toEqual(["creator_profile_001", "org_creator"]);
    expect(collaborationInsert?.values[6]).toBe("creator");
    expect(collaborationRead?.text).toContain(
      'COALESCE(creator.source_creator_id, creator.id::text) AS "creatorId"',
    );
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
      return [];
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

function creatorRequestContext(): RequestContext {
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
      organizationId: "org_creator",
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
        resourceId: "creator_profile_001",
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

function targetNativeCollaborationRow() {
  return {
    collaborationId: "collaboration_target_001",
    authorizationMode: "creator_workspace_resource_link",
    offerId: "offer_001",
    creatorId: "creator_profile_001",
    hotelProfileId: "hotel_profile_legacy_001",
    side: "creator",
    initiatorSide: "creator",
    status: "pending",
    compensationType: "free_stay",
    offerTitle: "Alpenrose launch",
    hotelLocation: "Tyrol, Austria",
    creatorProfileId: "creator_profile_001",
    creatorOrganizationId: "org_creator",
    creatorDisplayName: "Ari Creator",
    creatorAvatarUrl: null,
    hotelProfileResourceId: "hotel_profile_001",
    hotelOrganizationId: "org_hotel",
    hotelDisplayName: "Hotel Alpenrose",
    hotelAvatarUrl: null,
    freeStayMinNights: 2,
    freeStayMaxNights: 3,
    paidAmount: null,
    currency: "EUR",
    discountPercentage: null,
    affiliateEnabled: false,
    affiliateCommissionPercentage: null,
    travelDateFrom: null,
    travelDateTo: null,
    preferredDateFrom: null,
    preferredDateTo: null,
    preferredMonths: [],
    deliverables: [],
    lastMessageAt: null,
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}
