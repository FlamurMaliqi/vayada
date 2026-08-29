import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import {
  FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
  type AcceptFinanceOnlineCardExecutionEvidenceCommand,
  type FinancePlatformOnlineCardExecutionEvidenceRepository,
  type RevokeFinanceOnlineCardExecutionEvidenceCommand,
} from "@vayada/domain-finance";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFinancePlatformOnlineCardExecutionEvidenceRoutes } from "./financePlatformOnlineCardExecutionEvidenceRoutes.js";

const PLATFORM_ORG = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const EVIDENCE_ID = "40000000-0000-4000-8000-000000000001";
const ACCEPT_COMMAND_ID = "50000000-0000-4000-8000-000000000001";
const ACCEPT_IDEMPOTENCY_KEY = "60000000-0000-4000-8000-000000000001";
const REVOKE_COMMAND_ID = "50000000-0000-4000-8000-000000000002";
const REVOKE_IDEMPOTENCY_KEY = "60000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);

const entitlement: ProductEntitlement = {
  product: "platform",
  key: "finance-admin",
  status: "active",
  resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
};

const link: LinkedResource = {
  product: "platform",
  resourceType: "platform",
  resourceId: "vayada",
  relationship: "operator",
  status: "active",
};

type AuthOptions = {
  authenticated?: boolean;
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
  kind?: RequestContext["selectedOrganization"]["kind"];
  role?: string;
};

function repository() {
  const accepts: AcceptFinanceOnlineCardExecutionEvidenceCommand[] = [];
  const revokes: RevokeFinanceOnlineCardExecutionEvidenceCommand[] = [];
  const value: Partial<FinancePlatformOnlineCardExecutionEvidenceRepository> = {
    async acceptOnlineCardExecutionEvidence(command) {
      accepts.push(command);
      return {
        ok: true,
        status: "accepted",
        response: response(command.commandId, command.idempotencyKey, "accepted", null, true),
      };
    },
    async revokeOnlineCardExecutionEvidence(command) {
      revokes.push(command);
      return {
        ok: true,
        status: "revoked",
        response: response(
          command.commandId,
          command.idempotencyKey,
          "revoked",
          "2026-08-28T10:30:00.000Z",
          false,
        ),
      };
    },
  };
  return { value, accepts, revokes };
}

function response(
  commandId: string,
  idempotencyKey: string,
  status: "accepted" | "revoked",
  revokedAt: string | null,
  cardReady: boolean,
) {
  return {
    contractVersion: FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
    propertyId: PROPERTY_ID,
    evidenceId: EVIDENCE_ID,
    providerCapabilityRevision: 7,
    propertyReadinessRevision: 1,
    status,
    acceptedAt: "2026-08-28T10:00:00.000Z",
    revokedAt,
    cardReady,
    commandMeta: {
      commandId,
      idempotencyKey,
      sideEffects: ["audit_event" as const],
      outboxEvents: ["finance.online_card_readiness.changed"],
      jobs: [],
    },
  };
}

async function testApp(
  repo: Partial<FinancePlatformOnlineCardExecutionEvidenceRepository>,
  auth: AuthOptions = {},
) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (auth.authenticated === false || request.headers.authorization !== "Bearer valid") return;
    request.authContext = {
      actor: {
        internalUserId: USER_ID,
        providerIdentity: { provider: "workos", providerUserId: "workos-user" },
        email: "finance@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId: PLATFORM_ORG,
        kind: auth.kind ?? "platform",
        status: "active",
      },
      membership: {
        membershipId: "membership-1",
        status: "active",
        roleKey: auth.role ?? "platform_admin",
        workosRoleSlugs: [auth.role ?? "platform_admin"],
        permissions: auth.permissions ?? ["platform.finance.read", "platform.finance.manage"],
      },
      linkedResources: auth.links ?? [link],
      entitlements: auth.entitlements ?? [entitlement],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "admin",
        receivedAt: "2026-08-28T10:30:00.000Z",
      },
    };
  });
  await app.register(registerFinancePlatformOnlineCardExecutionEvidenceRoutes, {
    repository: repo,
  });
  return app;
}

function acceptBody(overrides: Record<string, unknown> = {}) {
  return {
    commandId: ACCEPT_COMMAND_ID,
    idempotencyKey: ACCEPT_IDEMPOTENCY_KEY,
    expectedCardCapabilityRevision: 7,
    expectedPropertyReadinessRevision: 1,
    evidenceFingerprintHash: HASH,
    executedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

describe("Platform Finance online-card execution evidence routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("builds a platform-scoped accept command without accepting raw proof material", async () => {
    const repo = repository();
    app = await testApp(repo.value);

    const result = await app.inject({
      method: "POST",
      url: `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence`,
      headers: { authorization: "Bearer valid" },
      payload: acceptBody(),
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: "accepted", cardReady: true });
    expect(repo.accepts).toEqual([
      expect.objectContaining({
        commandType: "finance.online_card_execution_evidence.accept",
        propertyId: PROPERTY_ID,
        audit: expect.objectContaining({
          actor: { kind: "user", userId: USER_ID, organizationId: PLATFORM_ORG },
        }),
        payload: {
          expectedCardCapabilityRevision: 7,
          expectedPropertyReadinessRevision: 1,
          evidenceFingerprintHash: HASH,
          executedAt: "2026-08-28T10:00:00.000Z",
        },
      }),
    ]);
  });

  it("builds an exact property-scoped one-way revocation command", async () => {
    const repo = repository();
    app = await testApp(repo.value);

    const result = await app.inject({
      method: "POST",
      url: `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence/${EVIDENCE_ID}/revoke`,
      headers: { authorization: "Bearer valid" },
      payload: { commandId: REVOKE_COMMAND_ID, idempotencyKey: REVOKE_IDEMPOTENCY_KEY },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: "revoked", cardReady: false });
    expect(repo.revokes).toEqual([
      expect.objectContaining({
        commandType: "finance.online_card_execution_evidence.revoke",
        propertyId: PROPERTY_ID,
        payload: { evidenceId: EVIDENCE_ID },
      }),
    ]);
  });

  it.each([
    [{ authenticated: false }, 401, "unauthenticated"],
    [{ permissions: ["platform.finance.read"] }, 403, "missing_permission"],
    [{ entitlements: [] }, 403, "missing_entitlement"],
    [{ entitlements: [{ ...entitlement, status: "suspended" }] }, 403, "inactive_entitlement"],
    [{ links: [] }, 403, "missing_resource_access"],
    [{ kind: "hotel_group" }, 403, "missing_resource_access"],
    [{ role: "operator" }, 403, "missing_resource_access"],
  ] as const)(
    "enforces the Platform Finance manage denial matrix %#",
    async (auth, status, code) => {
      app = await testApp(repository().value, auth as AuthOptions);
      const result = await app.inject({
        method: "POST",
        url: `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence`,
        headers: { authorization: "Bearer valid" },
        payload: acceptBody(),
      });
      expect(result.statusCode).toBe(status);
      expect(result.json()).toMatchObject({ code });
    },
  );

  it.each([
    [acceptBody({ evidenceFingerprintHash: "A".repeat(64) }), "non-canonical hash"],
    [acceptBody({ executedAt: "2026-08-28" }), "imprecise timestamp"],
    [acceptBody({ executedAt: "2026-08-28T10:31:00.000Z" }), "future execution"],
    [acceptBody({ proofKey: "must-never-transit" }), "raw proof field"],
    [acceptBody({ expectedCardCapabilityRevision: 0 }), "invalid revision"],
    [acceptBody({ expectedPropertyReadinessRevision: 0 }), "invalid property revision"],
    [acceptBody({ commandId: "pi_secret_123" }), "unsafe command identifier"],
    [acceptBody({ idempotencyKey: "client_secret_123" }), "unsafe idempotency identifier"],
  ])("rejects %s before calling Finance", async (body) => {
    const repo = repository();
    const accept = vi.spyOn(repo.value, "acceptOnlineCardExecutionEvidence");
    app = await testApp(repo.value);

    const result = await app.inject({
      method: "POST",
      url: `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence`,
      headers: { authorization: "Bearer valid" },
      payload: body,
    });

    expect(result.statusCode).toBe(400);
    expect(accept).not.toHaveBeenCalled();
    expect(result.body).not.toContain("must-never-transit");
  });

  it("returns safe repository conflicts without echoing evidence input", async () => {
    const repo = repository();
    repo.value.acceptOnlineCardExecutionEvidence = async () => ({
      ok: false,
      statusCode: 409,
      code: "provider_capability_revision_conflict",
      message: "Stripe capability state changed. Run the ONB-25A test again.",
    });
    app = await testApp(repo.value);

    const result = await app.inject({
      method: "POST",
      url: `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence`,
      headers: { authorization: "Bearer valid" },
      payload: acceptBody(),
    });

    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({
      code: "provider_capability_revision_conflict",
      category: "conflict",
    });
    expect(result.body).not.toContain(HASH);
  });

  it("reports unconfigured evidence acceptance as an unavailable capability", async () => {
    app = await testApp({});

    const result = await app.inject({
      method: "POST",
      url: `/finance/platform/properties/${PROPERTY_ID}/online-card-execution-evidence`,
      headers: { authorization: "Bearer valid" },
      payload: acceptBody(),
    });

    expect(result.statusCode).toBe(501);
    expect(result.json()).toMatchObject({
      statusCode: 501,
      code: "write_unavailable",
      category: "write_model",
    });
  });
});
