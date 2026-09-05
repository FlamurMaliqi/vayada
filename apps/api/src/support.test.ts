import Fastify from "fastify";
import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";
import {
  registerPlatformContactIntakeRoutes,
  type PlatformContactIntakePayload,
} from "./routes/platformContactIntake.js";

const context: RequestContext = {
  actor: {
    internalUserId: "user-1",
    email: "real@example.com",
    status: "active",
    providerIdentity: { provider: "workos", providerUserId: "workos-1" },
  },
  selectedOrganization: { organizationId: "org-1", kind: "hotel_group", status: "active" },
  membership: {
    membershipId: "member-1",
    status: "active",
    roleKey: "member",
    permissions: [],
    workosRoleSlugs: [],
  },
  linkedResources: [],
  entitlements: [],
  locale: "en",
  currency: "EUR",
  audit: { requestId: "request-1", source: "api", receivedAt: "2026-09-05T00:00:00Z" },
};
const payload = { kind: "support", message: " Please help ", page: "/settings", product: "pms" };

async function request(body: unknown, authorized = true, fail = false) {
  const stored: PlatformContactIntakePayload[] = [];
  const app = Fastify();
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (req) => {
    if (authorized) req.authContext = context;
  });
  app.register(registerPlatformContactIntakeRoutes, {
    prefix: "/api",
    repository: {
      async submitContact(input) {
        if (fail) throw new Error("private database error");
        stored.push(input.payload);
        return {
          contractVersion: "pl1-non-media.v1",
          command: {
            contractVersion: "pl1-non-media.v1",
            idempotencyKey: "key",
            receivedAt: "now",
          },
          intakeId: "contact_123",
          eventId: "event",
          jobId: "job",
          status: "accepted",
        };
      },
    },
  });
  try {
    return {
      response: await app.inject({ method: "POST", url: "/api/support", payload: body as object }),
      stored,
    };
  } finally {
    await app.close();
  }
}

describe("authenticated support", () => {
  it.each(["support", "bug"])(
    "saves %s with server identity even without permissions, entitlements or resources",
    async (kind) => {
      const { response, stored } = await request({
        ...payload,
        kind,
        email: "spoof@example.com",
        userId: "other",
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ status: "accepted", reference: "contact_123" });
      expect(stored[0]?.email).toBe("real@example.com");
      expect(JSON.parse(stored[0]!.message)).toEqual({
        ...payload,
        kind,
        message: "Please help",
        userId: "user-1",
        organizationId: "org-1",
      });
    },
  );
  it("denies requests without a resolved authenticated identity", async () => {
    const { response, stored } = await request(payload, false);
    expect(response.statusCode).toBe(401);
    expect(stored).toEqual([]);
  });
  it.each([
    null,
    {},
    { ...payload, message: " " },
    { ...payload, message: "x".repeat(4001) },
    { ...payload, kind: "other" },
    { ...payload, product: "other" },
    { ...payload, page: "/settings?token=secret" },
    { ...payload, page: "//evil.test" },
  ])("rejects invalid input %j before storage", async (body) => {
    const { response, stored } = await request(body);
    expect(response.statusCode).toBe(400);
    expect(stored).toEqual([]);
  });
  it("does not acknowledge failed storage or expose database details", async () => {
    const { response } = await request(payload, true, true);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private database error");
  });
});
