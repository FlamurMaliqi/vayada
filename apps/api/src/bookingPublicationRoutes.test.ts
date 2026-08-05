import { request as httpRequest } from "node:http";

import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
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
type AuthOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
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

  it.each([
    ["missing authentication", null, {}],
    ["invalid authentication", "invalid", {}],
    ["wrong organization", "valid-token", { kind: "creator_workspace" }],
    ["missing permission", "valid-token", { permissions: [] }],
    ["missing entitlement", "valid-token", { entitlements: [] }],
    ["suspended entitlement", "valid-token", { entitlements: [entitlement("suspended")] }],
    ["expired entitlement", "valid-token", { entitlements: [entitlement("expired")] }],
    ["missing link", "valid-token", { links: [] }],
    ["disallowed relationship", "valid-token", { links: [link({ relationship: "front_desk" })] }],
  ] as Array<[string, string | null, AuthOptions]>)(
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

  it.each([
    ["missing authentication", null, {}],
    ["invalid authentication", "invalid", {}],
    ["wrong organization", "valid-token", { kind: "creator_workspace" }],
    ["missing permission", "valid-token", { permissions: [] }],
    ["missing entitlement", "valid-token", { entitlements: [] }],
    ["suspended entitlement", "valid-token", { entitlements: [entitlement("suspended")] }],
    ["expired entitlement", "valid-token", { entitlements: [entitlement("expired")] }],
    ["missing link", "valid-token", { links: [] }],
    ["disallowed relationship", "valid-token", { links: [link({ relationship: "front_desk" })] }],
  ] as Array<[string, string | null, AuthOptions]>)(
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
  const app = buildApp({
    logger: false,
    bookingPublication: { repository, readinessProvider: provider },
  });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId, kind: options.kind ?? "hotel_group" },
      membership: { permissions: options.permissions ?? ["booking.settings.manage"] },
      linkedResources: options.links ?? [link()],
      entitlements: options.entitlements ?? [entitlement()],
      audit: { requestId: "request-1", source: "api", receivedAt: "2026-08-02T12:00:00Z" },
    } as RequestContext;
  });
  return app;
}

function entitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status,
    resource: { product: "booking", resourceType: "booking_hotel", resourceId: propertyId },
  };
}

function link(overrides: Partial<LinkedResource> = {}): LinkedResource {
  return {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: propertyId,
    relationship: "operator",
    status: "active",
    ...overrides,
  };
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
) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (key !== null) headers["idempotency-key"] = key;
  return injectJson<Record<string, unknown>>(target, {
    method: "POST",
    url: `/api/hotel-setup/properties/${propertyId}/publications/booking`,
    headers,
    payload: { expectedActiveContentRevisionId: null, ...body },
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
