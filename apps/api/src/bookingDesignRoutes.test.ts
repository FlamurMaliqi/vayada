import type {
  LinkedResource,
  OrganizationKind,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
  BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
  type BookingDesignCommandPort,
  type BookingDesignReadPort,
  type BookingDesignRevision,
  type UpsertBookingDesignCommand,
} from "@vayada/domain-booking";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerBookingDesignRoutes,
  type BookingDesignRoutesOptions,
} from "./routes/bookingDesign.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const otherPropertyId = "223e4567-e89b-42d3-a456-426614174000";
const organizationId = "323e4567-e89b-42d3-a456-426614174000";
const actorUserId = "423e4567-e89b-42d3-a456-426614174000";
const createdAt = "2026-08-03T12:00:00.000Z";

type AuthOptions = {
  authenticated?: boolean;
  organizationKind?: OrganizationKind;
  permissions?: readonly PermissionKey[];
  entitlements?: readonly ProductEntitlement[];
  links?: readonly LinkedResource[];
};
type FakePorts = BookingDesignRoutesOptions & {
  commands: UpsertBookingDesignCommand[];
  reads: Array<{ organizationId: string; propertyId: string }>;
  readValue: unknown;
  commandValue?: unknown;
  failRead?: boolean;
  failCommand?: boolean;
};

function design(
  revision = 1,
  overrides: Partial<BookingDesignRevision> = {},
): BookingDesignRevision {
  return {
    contractVersion: "booking-design.v1",
    propertyId,
    revision,
    choices: {
      primaryColor: BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
      fontPairing: BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
    },
    createdAt,
    ...overrides,
  };
}

function fakePorts(): FakePorts {
  const ports: FakePorts = {
    commands: [],
    reads: [],
    readValue: design(),
    readPort: {
      async getCurrentDesign(input) {
        ports.reads.push(input);
        if (ports.failRead) throw new Error("private read failure");
        return ports.readValue as never;
      },
    } satisfies BookingDesignReadPort,
    commandPort: {
      async upsertDesign(command) {
        ports.commands.push(command);
        if (ports.failCommand) throw new Error("private command failure");
        return (ports.commandValue ?? {
          ok: true,
          outcome: command.expectedRevision === 0 ? "created" : "updated",
          design: design(command.expectedRevision + 1, { choices: command.choices }),
        }) as never;
      },
    } satisfies BookingDesignCommandPort,
  };
  return ports;
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (auth.authenticated === false || request.headers.authorization !== "Bearer valid-token") {
      return;
    }
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: {
        organizationId,
        kind: auth.organizationKind ?? "hotel_group",
      },
      membership: { permissions: [...(auth.permissions ?? ["booking.settings.manage"])] },
      linkedResources: [...(auth.links ?? [link()])],
      entitlements: [...(auth.entitlements ?? [entitlement()])],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: createdAt,
      },
    } as RequestContext;
  });
  await app.register(registerBookingDesignRoutes, ports);
  return app;
}

describe("Booking design routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reads only a canonical private current revision", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await get(app, propertyId.toUpperCase());
    expect(response).toMatchObject({ statusCode: 200, body: design() });
    expect(ports.reads).toEqual([{ organizationId, propertyId }]);

    ports.readValue = null;
    expect(await get(app)).toMatchObject({
      statusCode: 404,
      body: { code: "booking_design_not_configured" },
    });
  });

  it("builds canonical default and saved-choice commands", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const created = await put(
      app,
      {
        expectedRevision: 0,
        primaryColor: null,
        fontPairing: null,
      },
      "  create-key  ",
    );
    const updated = await put(
      app,
      {
        expectedRevision: 1,
        primaryColor: "#0077B6",
        fontPairing: "modern-minimalist",
      },
      "update-key",
    );

    expect([created.statusCode, updated.statusCode]).toEqual([201, 200]);
    expect(ports.commands).toEqual([
      {
        organizationId,
        propertyId,
        actorUserId,
        idempotencyKey: "create-key",
        expectedRevision: 0,
        choices: {
          primaryColor: BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
          fontPairing: BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
        },
        audit: { requestId: "request-1", correlationId: "correlation-1", source: "api" },
      },
      expect.objectContaining({
        idempotencyKey: "update-key",
        expectedRevision: 1,
        choices: { primaryColor: "#0077B6", fontPairing: "modern-minimalist" },
      }),
    ]);
    expect(created.body).toEqual({ outcome: "created", design: design() });
  });

  it("returns an exact replay without changing the response projection", async () => {
    const ports = fakePorts();
    ports.commandValue = { ok: true, outcome: "idempotent_replay", design: design() };
    app = await testApp(ports);
    expect(await put(app)).toMatchObject({
      statusCode: 200,
      body: { outcome: "idempotent_replay", design: design() },
    });
  });

  it.each([
    [{ ok: false, error: { code: "setup_scope_unavailable" } }, 404],
    [{ ok: false, error: { code: "command_in_progress" } }, 409],
    [{ ok: false, error: { code: "idempotency_key_conflict" } }, 409],
    [{ ok: false, error: { code: "design_revision_conflict", currentRevision: 3 } }, 409],
  ] as const)("maps the typed command error %#", async (commandValue, statusCode) => {
    const ports = fakePorts();
    ports.commandValue = commandValue;
    app = await testApp(ports);
    expect((await put(app)).statusCode).toBe(statusCode);
  });

  it.each([
    ["operator", { links: [link("operator")] }, 201],
    ["wrong organization", { organizationKind: "creator_workspace" }, 403],
    ["missing permission", { permissions: [] }, 403],
    ["missing entitlement", { entitlements: [] }, 403],
    ["suspended entitlement", { entitlements: [entitlement("suspended")] }, 403],
    ["missing link", { links: [] }, 403],
    ["front desk", { links: [link("front_desk")] }, 403],
    ["wrong link scope", { links: [link("owner", otherPropertyId)] }, 403],
    ["unauthenticated", { authenticated: false }, 401],
  ] as const)("enforces the %s scope before parsing", async (_name, auth, statusCode) => {
    const ports = fakePorts();
    app = await testApp(ports, auth);
    const response = await put(app, statusCode === 201 ? requestBody() : { unsafe: true });
    expect(response.statusCode).toBe(statusCode);
    expect(ports.commands).toHaveLength(statusCode === 201 ? 1 : 0);
  });

  it("rejects malformed scope, body, and Idempotency-Key inputs", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const responses = await Promise.all([
      put(app, requestBody(), "key", "not-a-uuid"),
      put(app, { ...requestBody(), extra: true }),
      put(app, { ...requestBody(), primaryColor: "#FF7F50" }),
      put(app, { ...requestBody(), fontPairing: "custom-font" }),
      put(app, requestBody(), null),
      put(app, requestBody(), "   "),
      put(app, requestBody(), "x".repeat(201)),
    ]);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      400, 400, 400, 400, 400, 400, 400,
    ]);
    expect((await repeatedIdempotencyRequest(app)).statusCode).toBe(400);
    expect(ports.commands).toHaveLength(0);
  });

  it("fails closed on thrown or malformed port values", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    ports.readValue = design(1, { propertyId: otherPropertyId });
    expect(await get(app)).toMatchObject({
      statusCode: 500,
      body: { code: "booking_design_port_contract_violation" },
    });
    ports.failRead = true;
    expect((await get(app)).statusCode).toBe(500);
    ports.failRead = false;
    ports.readValue = hostileValue();
    expect((await get(app)).statusCode).toBe(500);

    ports.commandValue = { ok: true, outcome: "created", design: design(2) };
    expect((await put(app)).statusCode).toBe(500);
    ports.commandValue = hostileValue();
    expect((await put(app)).statusCode).toBe(500);
    ports.commandValue = accessorBackedError();
    expect((await put(app)).statusCode).toBe(500);
    ports.failCommand = true;
    expect((await put(app)).statusCode).toBe(500);
  });

  it("authorizes before Fastify parses a malformed JSON body", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { authenticated: false });
    const response = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/booking-design`,
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(response.statusCode).toBe(401);
    expect(ports.commands).toHaveLength(0);
  });
});

function requestBody() {
  return {
    expectedRevision: 0,
    primaryColor: BOOKING_DESIGN_DEFAULT_PRIMARY_COLOR,
    fontPairing: BOOKING_DESIGN_DEFAULT_FONT_PAIRING,
  };
}

function entitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status,
    resource: { product: "booking", resourceType: "booking_hotel", resourceId: propertyId },
  };
}

function link(
  relationship: LinkedResource["relationship"] = "owner",
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

async function get(app: Awaited<ReturnType<typeof testApp>>, targetPropertyId = propertyId) {
  return injectJson(app, {
    method: "GET",
    url: `/properties/${targetPropertyId}/booking-design`,
    headers: { authorization: "Bearer valid-token" },
  });
}

async function put(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: unknown = requestBody(),
  idempotencyKey: string | null = "command-key",
  targetPropertyId = propertyId,
) {
  return injectJson(app, {
    method: "PUT",
    url: `/properties/${targetPropertyId}/booking-design`,
    headers: {
      authorization: "Bearer valid-token",
      ...(idempotencyKey === null ? {} : { "idempotency-key": idempotencyKey }),
    },
    payload: payload as Record<string, unknown>,
  });
}

async function repeatedIdempotencyRequest(app: Awaited<ReturnType<typeof testApp>>) {
  const payload = JSON.stringify(requestBody());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise<{ statusCode: number }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        path: `/properties/${propertyId}/booking-design`,
        method: "PUT",
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "idempotency-key": ["first", "second"],
        },
      },
      (response) => resolve({ statusCode: response.statusCode ?? 0 }),
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function hostileValue() {
  return new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("hostile port value");
      },
    },
  );
}

function accessorBackedError() {
  return {
    ok: false,
    error: Object.defineProperty({ code: "design_revision_conflict" }, "currentRevision", {
      enumerable: true,
      get: () => 1,
    }),
  };
}
