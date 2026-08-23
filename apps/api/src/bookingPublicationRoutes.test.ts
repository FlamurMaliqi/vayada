import { request as httpRequest } from "node:http";

import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import type { MembershipPropertyScope } from "@vayada/backend-authorization";
import { injectJson } from "@vayada/backend-test";
import type {
  BookingPublicationCommandPort,
  BookingPublicationOperation,
  RequestBookingPublicationCommand,
} from "@vayada/domain-booking";
import { createProductReadinessResult } from "@vayada/domain-hotels";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { BookingPublicationReadinessProvider } from "./routes/bookingPublication.js";

const propertyId = "85858585-8585-4585-8585-858585858501";
const operationId = "85858585-8585-4585-8585-858585858502";
const organizationId = "85858585-8585-4585-8585-858585858503";
const actorUserId = "85858585-8585-4585-8585-858585858504";
const otherPropertyId = "85858585-8585-4585-8585-858585858505";
const foreignPropertyId = "85858585-8585-4585-8585-858585858506";
type AuthOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: readonly PermissionKey[];
  entitlements?: readonly ProductEntitlement[];
  links?: readonly LinkedResource[];
  membershipStatus?: RequestContext["membership"]["status"];
  propertyScope?: MembershipPropertyScope | null;
};
type FakeRepository = BookingPublicationCommandPort & {
  requestCalls: RequestBookingPublicationCommand[];
  statusCalls: Array<{
    organizationId: string;
    propertyId: string;
    operationId: string;
    actorUserId: string;
  }>;
};
const authorizationDenials: Array<[string, string | null, AuthOptions]> = [
  ["missing authentication", null, {}],
  ["invalid authentication", "invalid", {}],
  ["wrong organization", "valid-token", { kind: "creator_workspace" }],
  ["inactive membership", "valid-token", { membershipStatus: "inactive" }],
  ["suspended membership", "valid-token", { membershipStatus: "suspended" }],
  ["missing permission", "valid-token", { permissions: [] }],
  [
    "no property assignment",
    "valid-token",
    { propertyScope: { mode: "assigned", assignedPropertyIds: [] } },
  ],
  [
    "unknown property scope",
    "valid-token",
    { propertyScope: { mode: "unknown", assignedPropertyIds: [propertyId] } },
  ],
  ["missing entitlement", "valid-token", { entitlements: [] }],
  ["suspended entitlement", "valid-token", { entitlements: [entitlement("suspended")] }],
  ["expired entitlement", "valid-token", { entitlements: [entitlement("expired")] }],
  ["missing link", "valid-token", { links: [] }],
  ["missing canonical link", "valid-token", { links: [targetLink()] }],
  ["missing target link", "valid-token", { links: [canonicalLink()] }],
  ["disallowed relationship", "valid-token", { links: links("front_desk") }],
];

describe("Booking publication routes", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("authorizes and delegates with server-evaluated readiness", async () => {
    const readiness = await readyEvidence();
    const repository = fakeRepository();
    const provider = readinessProvider(readiness);
    app = testApp(repository, provider);

    const response = await post(app, {
      expectedSourceManifestHash: readiness.sourceManifestHash,
      expectedReadinessHash: readiness.readinessHash,
    });

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({ operationId, propertyId, status: "pending" });
    expect(repository.requestCalls).toHaveLength(1);
    expect(repository.requestCalls[0]).toMatchObject({
      organizationId,
      propertyId,
      actorUserId,
      idempotencyKey: "publication-key",
      expectedActiveContentRevisionId: null,
      readiness,
    });
  });

  it("allows publication and status reads for an explicitly assigned property", async () => {
    const readiness = await readyEvidence();
    const repository = fakeRepository();
    app = testApp(repository, readinessProvider(readiness), {
      propertyScope: { mode: "assigned", assignedPropertyIds: [propertyId] },
    });

    const publication = await post(app, {
      expectedSourceManifestHash: readiness.sourceManifestHash,
      expectedReadinessHash: readiness.readinessHash,
    });
    expect(publication.statusCode).toBe(202);
    expect((await getStatus(app)).statusCode).toBe(200);
    expect(repository.requestCalls).toHaveLength(1);
    expect(repository.statusCalls).toHaveLength(1);
  });

  it.each(authorizationDenials)(
    "denies %s before readiness or command execution",
    async (_name, token, options) => {
      const readiness = await readyEvidence();
      const repository = fakeRepository();
      const provider = readinessProvider(readiness);
      app = testApp(repository, provider, options);
      const response = await post(
        app,
        {
          expectedSourceManifestHash: readiness.sourceManifestHash,
          expectedReadinessHash: readiness.readinessHash,
        },
        token,
      );
      expect(response.statusCode).toBe(token === null || token === "invalid" ? 401 : 403);
      expect(provider.calls).toBe(0);
      expect(repository.requestCalls).toHaveLength(0);
    },
  );

  it.each(authorizationDenials)(
    "denies status GET for %s before repository access",
    async (_name, token, options) => {
      const repository = fakeRepository();
      app = testApp(repository, readinessProvider(await readyEvidence()), options);
      const headers: Record<string, string> = {};
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const response = await injectJson(app, {
        method: "GET",
        url: `/api/hotel-setup/properties/${propertyId}/publications/booking/${operationId}`,
        headers,
      });
      expect(response.statusCode).toBe(token === null || token === "invalid" ? 401 : 403);
      expect(repository.statusCalls).toHaveLength(0);
    },
  );

  it.each([
    [
      "authentication",
      null,
      {},
      {
        statusCode: 401,
        error: "Unauthorized",
        message: "A valid access token is required.",
      },
    ],
    [
      "permission",
      "valid-token",
      { permissions: [] },
      {
        statusCode: 403,
        error: "Forbidden",
        message: "Missing required permission: booking.settings.manage",
      },
    ],
    [
      "organization",
      "valid-token",
      { kind: "creator_workspace" },
      {
        statusCode: 403,
        error: "Forbidden",
        message: "Booking publication requires a hotel-group organization.",
      },
    ],
    [
      "entitlement",
      "valid-token",
      { entitlements: [] },
      {
        statusCode: 403,
        error: "Forbidden",
        message: `Missing active entitlement: booking:booking-engine for booking:booking_hotel:${propertyId}`,
      },
    ],
  ] as const)("preserves the existing %s denial body", async (_name, token, options, body) => {
    const readiness = await readyEvidence();
    const repository = fakeRepository();
    app = testApp(repository, readinessProvider(readiness), options);

    const response = await post(
      app,
      {
        expectedSourceManifestHash: readiness.sourceManifestHash,
        expectedReadinessHash: readiness.readinessHash,
      },
      token,
    );

    expect(response.body).toEqual(body);
    expect(repository.requestCalls).toHaveLength(0);
  });

  it("returns the same denial for unassigned and foreign properties", async () => {
    const readiness = await readyEvidence();
    const repository = fakeRepository();
    const provider = readinessProvider(readiness);
    app = testApp(repository, provider, {
      links: [...links(), ...links("owner", otherPropertyId)],
      entitlements: [entitlement(), entitlement("active", otherPropertyId)],
      propertyScope: { mode: "assigned", assignedPropertyIds: [propertyId] },
    });

    const responses = await Promise.all([
      post(
        app,
        {
          expectedSourceManifestHash: readiness.sourceManifestHash,
          expectedReadinessHash: readiness.readinessHash,
        },
        "valid-token",
        "unassigned-key",
        otherPropertyId,
      ),
      getStatus(app, otherPropertyId),
      post(
        app,
        {
          expectedSourceManifestHash: readiness.sourceManifestHash,
          expectedReadinessHash: readiness.readinessHash,
        },
        "valid-token",
        "foreign-key",
        foreignPropertyId,
      ),
      getStatus(app, foreignPropertyId),
    ]);

    expect(responses.map(({ statusCode, body }) => ({ statusCode, body }))).toEqual(
      Array(4).fill({
        statusCode: 403,
        body: {
          code: "forbidden",
          message: "Booking publication requires an entitled hotel-group property.",
        },
      }),
    );
    expect(provider.calls).toBe(0);
    expect(repository.requestCalls).toHaveLength(0);
    expect(repository.statusCalls).toHaveLength(0);
  });

  it("runs authorization before Fastify parses a malformed body", async () => {
    const repository = fakeRepository();
    const provider = readinessProvider(await readyEvidence());
    app = testApp(repository, provider);
    const response = await rawPost(app, "{not-json", {});
    expect(response.statusCode).toBe(401);
    expect(provider.calls).toBe(0);
    expect(repository.requestCalls).toHaveLength(0);
  });

  it("rejects stale readiness expectations without starting publication", async () => {
    const repository = fakeRepository();
    const provider = readinessProvider(await readyEvidence());
    app = testApp(repository, provider);
    const response = await post(app, {
      expectedSourceManifestHash:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedReadinessHash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ code: "invalid_readiness_evidence" });
    expect(provider.calls).toBe(1);
    expect(repository.requestCalls).toHaveLength(0);
  });

  it.each([null, "   ", "x".repeat(201)])("requires one bounded idempotency key", async (key) => {
    const repository = fakeRepository();
    const readiness = await readyEvidence();
    app = testApp(repository, readinessProvider(readiness));
    const response = await post(
      app,
      {
        expectedSourceManifestHash: readiness.sourceManifestHash,
        expectedReadinessHash: readiness.readinessHash,
      },
      "valid-token",
      key,
    );
    expect(response.statusCode).toBe(400);
    expect(repository.requestCalls).toHaveLength(0);
  });

  it("returns the safe operation projection and hides unknown operations", async () => {
    const repository = fakeRepository(operation("unknown"));
    app = testApp(repository, readinessProvider(await readyEvidence()));
    const status = await injectJson<Record<string, unknown>>(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/publications/booking/${operationId}`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.body).toEqual(operation("unknown"));
    expect(status.body).not.toHaveProperty("readiness");
    expect(status.body).not.toHaveProperty("sourceManifest");
    expect(status.body).not.toHaveProperty("publicContent");
    expect(repository.statusCalls).toEqual([
      { organizationId, propertyId, operationId, actorUserId },
    ]);

    await app.close();
    repository.statusCalls.length = 0;
    repository.statusResult = null;
    app = testApp(repository, readinessProvider(await readyEvidence()));
    const missing = await injectJson(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/publications/booking/${operationId}`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ code: "publication_operation_not_found" });
  });

  it("does not mount without both concrete publication dependencies", async () => {
    app = buildApp({ logger: false });
    const response = await injectJson(app, {
      method: "GET",
      url: `/api/hotel-setup/properties/${propertyId}/publications/booking/${operationId}`,
    });
    expect(response.statusCode).toBe(404);
  });
});

function fakeRepository(
  initialStatus: BookingPublicationOperation | null = operation("pending"),
): FakeRepository & { statusResult: BookingPublicationOperation | null } {
  const requestCalls: RequestBookingPublicationCommand[] = [];
  const statusCalls: FakeRepository["statusCalls"] = [];
  return {
    requestCalls,
    statusCalls,
    statusResult: initialStatus,
    async requestPublication(command) {
      requestCalls.push(command);
      return { ok: true, operation: operation("pending") };
    },
    async getPublicationStatus(input) {
      statusCalls.push(input);
      return this.statusResult;
    },
    async close() {},
  };
}

function readinessProvider(
  result: Awaited<ReturnType<typeof readyEvidence>>,
): BookingPublicationReadinessProvider & { calls: number } {
  return {
    calls: 0,
    async getBookingReadiness() {
      this.calls += 1;
      return result;
    },
  };
}

function testApp(
  repository: FakeRepository,
  provider: BookingPublicationReadinessProvider,
  options: AuthOptions = {},
) {
  const propertyScope =
    options.propertyScope === undefined
      ? { mode: "all", assignedPropertyIds: [] }
      : options.propertyScope;
  const app = buildApp({
    logger: false,
    bookingPublication: {
      propertyAccessRepository: {
        findMembershipPropertyScope: async () => propertyScope,
      },
      repository,
      readinessProvider: provider,
    },
  });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: {
        internalUserId: actorUserId,
        providerIdentity: { provider: "workos", providerUserId: "user_1" },
        email: "owner@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId,
        kind: options.kind ?? "hotel_group",
        status: "active",
      },
      membership: {
        membershipId: "85858585-8585-4585-8585-858585858507",
        status: options.membershipStatus ?? "active",
        roleKey: "hotel_owner",
        workosRoleSlugs: ["hotel_owner"],
        permissions: [...(options.permissions ?? ["booking.settings.manage"])],
      },
      linkedResources: [...(options.links ?? links())],
      entitlements: [...(options.entitlements ?? [entitlement()])],
      locale: "en",
      currency: "EUR",
      audit: { requestId: "request-1", source: "api", receivedAt: "2026-08-02T12:00:00Z" },
    } satisfies RequestContext;
  });
  return app;
}

function entitlement(
  status: ProductEntitlement["status"] = "active",
  resourceId = propertyId,
): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status,
    resource: { product: "booking", resourceType: "booking_hotel", resourceId },
  };
}

function canonicalLink(
  relationship: LinkedResource["relationship"] = "owner",
  resourceId = propertyId,
): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId,
    relationship,
    status: "active",
  };
}

function targetLink(
  relationship: LinkedResource["relationship"] = "operator",
  resourceId = propertyId,
): LinkedResource {
  return {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId,
    relationship,
    status: "active",
  };
}

function links(
  relationship: LinkedResource["relationship"] = "owner",
  resourceId = propertyId,
): LinkedResource[] {
  return [canonicalLink(relationship, resourceId), targetLink(relationship, resourceId)];
}

function operation(status: BookingPublicationOperation["status"]): BookingPublicationOperation {
  return {
    operationId,
    propertyId,
    status,
    expectedActiveContentRevisionId: null,
    resultContentRevisionId: null,
    failureCode: status === "unknown" ? "external_result_unconfirmed" : null,
    requestedAt: "2026-08-02T13:00:00.000Z",
    updatedAt: "2026-08-02T13:00:00.000Z",
    completedAt: null,
  };
}

async function readyEvidence() {
  return createProductReadinessResult({
    contractVersion: "onboarding-product-readiness.v1",
    propertyId,
    product: "booking",
    status: "ready",
    sourceManifest: {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [
        {
          ownerDomain: "booking",
          entityType: "booking_settings",
          entityId: propertyId,
          revision: "booking-settings:4",
        },
      ],
    },
    groups: [
      {
        groupId: "booking.guest_experience",
        status: "ready",
        steps: [
          {
            owningStepId: "guest_experience",
            status: "ready",
            entities: [
              {
                source: {
                  ownerDomain: "booking",
                  entityType: "booking_settings",
                  entityId: propertyId,
                  revision: "booking-settings:4",
                },
                status: "ready",
                blockers: [],
              },
            ],
          },
        ],
      },
    ],
    evaluatedAt: "2026-08-02T12:00:00.000Z",
  });
}

async function post(
  target: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
  token: string | null = "valid-token",
  key: string | null = "publication-key",
  targetPropertyId = propertyId,
) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (key !== null) headers["idempotency-key"] = key;
  return injectJson<Record<string, unknown>>(target, {
    method: "POST",
    url: `/api/hotel-setup/properties/${targetPropertyId}/publications/booking`,
    headers,
    payload: { expectedActiveContentRevisionId: null, ...body },
  });
}

async function getStatus(target: ReturnType<typeof buildApp>, targetPropertyId = propertyId) {
  return injectJson<Record<string, unknown>>(target, {
    method: "GET",
    url: `/api/hotel-setup/properties/${targetPropertyId}/publications/booking/${operationId}`,
    headers: { authorization: "Bearer valid-token" },
  });
}

async function rawPost(
  target: ReturnType<typeof buildApp>,
  payload: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  await target.listen({ host: "127.0.0.1", port: 0 });
  const address = target.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to TCP");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: `/api/hotel-setup/properties/${propertyId}/publications/booking`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}
