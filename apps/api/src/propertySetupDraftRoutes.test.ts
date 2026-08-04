import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  type PropertySetupStepId,
  type SavePropertySetupDraftError,
} from "@vayada/domain-hotels";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type {
  PropertySetupDraftCommandRepository,
  PropertySetupDraftSaveCommand,
} from "./domains/propertySetupDraftCommandRepository.js";

const propertyId = "f6853000-0000-4000-8000-000000000001";
const otherPropertyId = "f6853000-0000-4000-8000-000000000002";
const organizationId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";
type SetupProduct = "marketplace" | "booking" | "pms";
type Options = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};
type FakeRepository = PropertySetupDraftCommandRepository & {
  calls: PropertySetupDraftSaveCommand[];
};
const ACCESS_BY_PRODUCT = {
  marketplace: {
    key: "marketplace-hotel-profile",
    resourceType: "hotel_profile",
  },
  booking: {
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  pms: {
    key: "property-management",
    resourceType: "pms_property",
  },
} as const;

function draft(stepId: PropertySetupStepId = "rooms"): Record<string, unknown> {
  const step = PROPERTY_SETUP_STEP_DEFINITIONS.find((item) => item.stepId === stepId)!;
  return {
    stepId,
    payload: {},
    dirtyFields: [],
    expectedBaseRevisions: Object.fromEntries(
      step.baseRevisionKeys.map((key) => [key, `${key}:1`]),
    ),
    expectedTrackRevision: 1,
    expectedSessionRevision: 0,
    expectedDraftRevision: 0,
  };
}

function entitlement(
  product: SetupProduct = "pms",
  status: ProductEntitlement["status"] = "active",
  resourceId = propertyId,
): ProductEntitlement {
  const access = ACCESS_BY_PRODUCT[product];
  return {
    product,
    key: access.key,
    status,
    resource: { product, resourceType: access.resourceType, resourceId },
  };
}

function link(
  product: SetupProduct | "hotel_catalog" = "hotel_catalog",
  overrides: Partial<LinkedResource> = {},
  resourceId = propertyId,
): LinkedResource {
  return {
    product,
    resourceType:
      product === "hotel_catalog" ? "property" : ACCESS_BY_PRODUCT[product].resourceType,
    resourceId,
    relationship: "operator",
    status: "active",
    ...overrides,
  };
}

function fakeRepository(error?: SavePropertySetupDraftError): FakeRepository {
  const calls: PropertySetupDraftSaveCommand[] = [];
  return {
    calls,
    async saveStepDraft(command) {
      calls.push(command);
      if (error) return { ok: false, error };
      return {
        ok: true,
        receipt: {
          contractVersion: "property-setup-draft.v1",
          sessionId: "33333333-3333-4333-8333-333333333333",
          stepId: command.request.stepId,
          selectedTracks: ["hotel_operations"],
          trackRevision: 1,
          sessionRevision: 1,
          draftRevision: 1,
          retentionExpiresAt: "2026-10-30T10:00:00.000Z",
          updatedAt: "2026-07-30T10:00:00.000Z",
          replayed: calls.length > 1,
        },
      };
    },
    async resetStepDraft() {
      return { ok: false, error: { code: "setup_scope_unavailable" } };
    },
    async close() {},
  };
}

function testApp(repository: FakeRepository, options: Options = {}) {
  const app = buildApp({ logger: false, propertySetupDraftCommandRepository: repository });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId, kind: options.kind ?? "hotel_group" },
      membership: {
        permissions: options.permissions ?? ["hotel_catalog.setup.read", "pms.operations.manage"],
      },
      linkedResources: options.links ?? [link(), link("pms")],
      entitlements: options.entitlements ?? [entitlement()],
      audit: { requestId: "request-1", source: "api", receivedAt: "2026-07-30T10:00:00Z" },
    } as RequestContext;
  });
  return app;
}

async function put(
  app: ReturnType<typeof buildApp>,
  options: {
    step?: PropertySetupStepId;
    body?: Record<string, unknown>;
    token?: string | null;
    key?: string | null;
    property?: string;
  } = {},
) {
  const step = options.step ?? "rooms";
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? "valid-token"}`;
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "draft-key";
  return injectJson<Record<string, unknown>>(app, {
    method: "PUT",
    url: `/api/hotel-setup/properties/${options.property ?? propertyId}/setup-drafts/${step}`,
    headers,
    payload: options.body ?? draft(step),
  });
}

describe("property setup draft save route", () => {
  let app: ReturnType<typeof buildApp> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it.each([
    ["present_hotel", "hotel_catalog.setup.manage", "pms"],
    ["marketplace_preferences", "marketplace.profile.manage", "marketplace"],
    ["booking_design", "booking.settings.manage", "booking"],
    ["rooms", "pms.operations.manage", "pms"],
  ] as const)(
    "uses the %s step policy and only delegates the draft command",
    async (step, permission, product) => {
      const repository = fakeRepository();
      app = testApp(repository, {
        permissions: ["hotel_catalog.setup.read", permission],
        entitlements: [entitlement(product)],
        links: [link(), link(product)],
      });
      const response = await put(app, {
        step,
        key: "  stable-key  ",
        property: propertyId.toUpperCase(),
      });
      expect(response.statusCode).toBe(200);
      expect(repository.calls).toHaveLength(1);
      expect(repository.calls[0]).toMatchObject({
        organizationId,
        propertyId,
        actorUserId,
        idempotencyKey: "stable-key",
        request: { stepId: step },
      });
    },
  );

  it.each([
    ["locale-only", { "profile.default_locale": "de-DE" }, ["profile.default_locale"]],
    [
      "locale-plus-summary",
      {
        "profile.short_description": "A calm hotel.",
        "profile.default_locale": "de-DE",
      },
      ["profile.short_description", "profile.default_locale"],
    ],
  ] as const)(
    "saves a %s Back/Exit draft without completing Step 1 or calling another command",
    async (_name, payload, dirtyFields) => {
      const repository = fakeRepository();
      app = testApp(repository, {
        permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
      });
      const response = await put(app, {
        step: "present_hotel",
        body: {
          ...draft("present_hotel"),
          payload,
          dirtyFields,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toHaveProperty("completedStepIds");
      expect(response.body).not.toHaveProperty("profileStatus");
      expect(repository.calls).toHaveLength(1);
      expect(repository.calls[0]?.request).toMatchObject({
        stepId: "present_hotel",
        payload,
        dirtyFields:
          "profile.short_description" in payload
            ? ["profile.default_locale", "profile.short_description"]
            : ["profile.default_locale"],
      });
    },
  );

  it.each([
    ["missing authentication", null, {}],
    ["invalid authentication", "bad-token", {}],
    ["non-hotel organization", "valid-token", { kind: "creator_workspace" }],
    ["missing step permission", "valid-token", { permissions: ["hotel_catalog.setup.read"] }],
    ["missing entitlement", "valid-token", { entitlements: [] }],
    ["inactive entitlement", "valid-token", { entitlements: [entitlement("pms", "suspended")] }],
    ["missing catalog link", "valid-token", { links: [link("pms")] }],
    ["missing product link", "valid-token", { links: [link()] }],
    [
      "disallowed relationship",
      "valid-token",
      { links: [link(), link("pms", { relationship: "front_desk" })] },
    ],
    ["suspended product", "valid-token", { links: [link(), link("pms", { status: "suspended" })] }],
    [
      "shared step without product access",
      "valid-token",
      {
        permissions: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
        links: [link()],
      },
      "present_hotel",
    ],
  ] as Array<[string, string | null, Options, PropertySetupStepId?]>)(
    "denies %s before persistence",
    async (_name, token, options, step) => {
      const repository = fakeRepository();
      app = testApp(repository, options);
      const response = await put(app, { token, step });
      expect(response.statusCode).toBe(token === null || token === "bad-token" ? 401 : 403);
      expect(repository.calls).toHaveLength(0);
    },
  );

  it.each([
    ["marketplace_preferences", "marketplace.profile.manage", "marketplace"],
    ["booking_design", "booking.settings.manage", "booking"],
    ["rooms", "pms.operations.manage", "pms"],
  ] as const)(
    "denies %s when otherwise valid product access belongs to another property",
    async (step, permission, product) => {
      const repository = fakeRepository();
      app = testApp(repository, {
        permissions: ["hotel_catalog.setup.read", permission],
        entitlements: [entitlement(product, "active", otherPropertyId)],
        links: [link(), link(product, {}, otherPropertyId)],
      });
      const response = await put(app, { step });
      expect(response.statusCode).toBe(403);
      expect(repository.calls).toHaveLength(0);
    },
  );

  it("authenticates before rejecting malformed property and step scope", async () => {
    const repository = fakeRepository();
    app = testApp(repository);
    const unauthenticated = await injectJson(app, {
      method: "PUT",
      url: "/api/hotel-setup/properties/not-a-uuid/setup-drafts/not-a-step",
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(repository.calls).toHaveLength(0);
  });

  it.each([
    ["route/body mismatch", "rooms", draft("booking_design"), "invalid_request"],
    ["unknown field", "rooms", { ...draft(), payload: { unknown: true } }, "invalid_request"],
    [
      "secret",
      "present_hotel",
      {
        ...draft("present_hotel"),
        payload: { "profile.short_description": "Bearer abcdefghijklmnopqrstuvwxyz12345" },
      },
      "unsafe_payload",
    ],
    [
      "excessive",
      "present_hotel",
      { ...draft("present_hotel"), payload: { "profile.short_description": "x".repeat(66_000) } },
      "payload_too_large",
    ],
  ] as const)("rejects %s payloads", async (_name, step, body, code) => {
    const repository = fakeRepository();
    app = testApp(repository, {
      permissions: [
        "hotel_catalog.setup.read",
        "hotel_catalog.setup.manage",
        "pms.operations.manage",
      ],
    });
    const response = await put(app, { step, body });
    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe(code);
    expect(repository.calls).toHaveLength(0);
  });

  it.each([null, "   ", "x".repeat(201)])("requires one bounded Idempotency-Key", async (key) => {
    const repository = fakeRepository();
    app = testApp(repository);
    expect((await put(app, { key })).statusCode).toBe(400);
    expect(repository.calls).toHaveLength(0);
  });

  it("rejects repeated Idempotency-Key headers", async () => {
    const repository = fakeRepository();
    app = testApp(repository);
    const payload = JSON.stringify(draft());
    const response = await requestWithRawHeaders(app, payload, {
      authorization: "Bearer valid-token",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
      "idempotency-key": ["first", "second"],
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe("invalid_request");
    expect(repository.calls).toHaveLength(0);
  });

  it("returns exact retries and safely maps command conflicts", async () => {
    const repository = fakeRepository();
    app = testApp(repository);
    expect((await put(app, { key: "retry" })).body.replayed).toBe(false);
    expect((await put(app, { key: "retry" })).body.replayed).toBe(true);
    await app.close();
    const conflictRepository = fakeRepository({ code: "idempotency_key_conflict" });
    app = testApp(conflictRepository);
    const conflict = await put(app);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe("idempotency_key_conflict");
  });

  it.each([
    [{ code: "session_revision_conflict", currentSessionRevision: 2 }, 409],
    [{ code: "setup_scope_unavailable" }, 404],
  ] as Array<[SavePropertySetupDraftError, number]>)("maps $0 safely", async (error, status) => {
    app = testApp(fakeRepository(error));
    const response = await put(app);
    expect(response.statusCode).toBe(status);
    expect(response.body.code).toBe(error.code);
  });

  it("does not mount the route without an injected repository", async () => {
    app = buildApp({ logger: false });
    expect((await put(app)).statusCode).toBe(404);
  });

  it("injects the PostgreSQL repository from the production startup", () => {
    const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(serverSource).toMatch(
      /const propertySetupDraftCommandRepository = createPgPropertySetupDraftCommandRepository\(\{[\s\S]*?connectionString:\s*targetDatabaseUrl,[\s\S]*?\}\);/,
    );
    expect(serverSource).toMatch(
      /const app = buildApp\(\{[\s\S]*\n  propertySetupDraftCommandRepository,/,
    );
  });
});

async function requestWithRawHeaders(
  target: ReturnType<typeof buildApp>,
  payload: string,
  headers: Record<string, string | string[]>,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  await target.listen({ host: "127.0.0.1", port: 0 });
  const address = target.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to TCP");

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: `/api/hotel-setup/properties/${propertyId}/setup-drafts/rooms`,
        method: "PUT",
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
          });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}
