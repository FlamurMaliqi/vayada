import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import type {
  FinanceAffiliatePayoutMarkPaidCommand,
  FinancePlatformAffiliatePayoutRepository,
} from "@vayada/domain-finance";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFinancePlatformAffiliatePayoutRoutes } from "./financePlatformAffiliatePayoutRoutes.js";

const PLATFORM_ORG = "10000000-0000-4000-8000-000000000001";
const USER_ID = "20000000-0000-4000-8000-000000000001";
const AFFILIATE_ORG = "30000000-0000-4000-8000-000000000001";
const AFFILIATE_ID = "affiliate-42";

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

const summary = {
  affiliateId: AFFILIATE_ID,
  organizationId: AFFILIATE_ORG,
  affiliateLifecycleStatus: "active" as const,
  currency: "EUR",
  payoutMethod: "bank_transfer",
  outstandingAmount: "50.00",
  payableAmount: "50.00",
  paidAmount: "25.00",
  payoutCount: 2,
  payableCount: 1,
  lastPaidAt: "2026-08-12T09:00:00.000Z",
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
  const commands: FinanceAffiliatePayoutMarkPaidCommand[] = [];
  const value: Partial<FinancePlatformAffiliatePayoutRepository> = {
    async listPlatformAffiliatePayoutSummaries(query) {
      return { summaries: [summary], total: 1, ...query };
    },
    async getPlatformAffiliatePayoutDetail(affiliateId, currency) {
      return {
        summary: { ...summary, affiliateId, currency },
        payouts: [],
        history: [],
      };
    },
    async markAffiliatePayoutPaid(command) {
      commands.push(command);
      return {
        ok: true,
        status: "updated",
        evidence: {
          evidenceId: "40000000-0000-4000-8000-000000000001",
          affiliateId: command.affiliateId,
          organizationId: AFFILIATE_ORG,
          payoutIds: ["50000000-0000-4000-8000-000000000001"],
          amount: "50.00",
          currency: command.currency,
          paymentMethod: command.payload.paymentMethod,
          externalReference: command.payload.externalReference,
          evidenceReference: command.payload.evidenceReference,
          note: command.payload.note ?? null,
          paidAt: command.payload.paidAt,
          recordedAt: "2026-08-13T09:00:00.000Z",
        },
        commandMeta: {
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          sideEffects: ["audit_event"],
          outboxEvents: [],
          jobs: [],
        },
      };
    },
  };
  return { value, commands };
}

async function testApp(
  repo: Partial<FinancePlatformAffiliatePayoutRepository>,
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
        receivedAt: "2026-08-13T09:00:00.000Z",
      },
    };
  });
  await app.register(registerFinancePlatformAffiliatePayoutRoutes, { repository: repo });
  return app;
}

function markPaidBody(overrides: Record<string, unknown> = {}) {
  return {
    commandId: "command-1",
    idempotencyKey: "idempotency-1",
    currency: "EUR",
    payoutIds: ["50000000-0000-4000-8000-000000000001"],
    expectedAmount: "50.00",
    paymentMethod: "bank_transfer",
    externalReference: "transfer-42",
    evidenceReference: "vault://transfer-42",
    paidAt: "2026-08-13T08:55:00.000Z",
    note: "Receipt verified",
    ...overrides,
  };
}

describe("Platform Finance affiliate payout routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("serves authorized list and currency-scoped detail reads", async () => {
    const repo = repository();
    app = await testApp(repo.value);

    const list = await app.inject({
      method: "GET",
      url: "/finance/platform/affiliate-payouts?limit=25&offset=0",
      headers: { authorization: "Bearer valid" },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/finance/platform/affiliate-payouts/${AFFILIATE_ID}?currency=EUR`,
      headers: { authorization: "Bearer valid" },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({
      contractVersion: "finance-platform-affiliate-payouts.v1",
      summaries: [summary],
      total: 1,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      summary: { affiliateId: AFFILIATE_ID, currency: "EUR" },
    });
  });

  it.each([
    [{ authenticated: false }, 401, "unauthenticated"],
    [{ permissions: [] }, 403, "missing_permission"],
    [{ entitlements: [] }, 403, "missing_entitlement"],
    [{ entitlements: [{ ...entitlement, status: "suspended" }] }, 403, "inactive_entitlement"],
    [{ links: [] }, 403, "missing_resource_access"],
    [{ kind: "hotel_group" }, 403, "missing_resource_access"],
    [{ role: "operator" }, 403, "missing_resource_access"],
  ] as const)("enforces the Platform Finance denial matrix %#", async (auth, status, code) => {
    app = await testApp(repository().value, auth as AuthOptions);
    const response = await app.inject({
      method: "GET",
      url: "/finance/platform/affiliate-payouts",
      headers: { authorization: "Bearer valid" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
  });

  it("builds the authorized mark-paid command from required evidence", async () => {
    const repo = repository();
    app = await testApp(repo.value);

    const response = await app.inject({
      method: "POST",
      url: `/finance/platform/affiliate-payouts/${AFFILIATE_ID}/mark-paid`,
      headers: { authorization: "Bearer valid" },
      payload: markPaidBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "updated", evidence: { amount: "50.00" } });
    expect(repo.commands).toEqual([
      expect.objectContaining({
        affiliateId: AFFILIATE_ID,
        currency: "EUR",
        audit: expect.objectContaining({
          actor: { kind: "user", userId: USER_ID, organizationId: PLATFORM_ORG },
        }),
        payload: expect.objectContaining({
          payoutIds: ["50000000-0000-4000-8000-000000000001"],
          expectedAmount: "50.00",
          externalReference: "transfer-42",
          evidenceReference: "vault://transfer-42",
        }),
      }),
    ]);
  });

  it.each([
    [markPaidBody({ evidenceReference: undefined }), "missing evidence"],
    [markPaidBody({ paymentMethod: "stripe" }), "provider method"],
    [markPaidBody({ payoutIds: [] }), "empty snapshot"],
    [markPaidBody({ extra: true }), "unexpected field"],
  ])("rejects invalid mark-paid %s before calling Finance", async (body) => {
    const repo = repository();
    const command = vi.spyOn(repo.value, "markAffiliatePayoutPaid");
    app = await testApp(repo.value);

    const response = await app.inject({
      method: "POST",
      url: `/finance/platform/affiliate-payouts/${AFFILIATE_ID}/mark-paid`,
      headers: { authorization: "Bearer valid" },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(command).not.toHaveBeenCalled();
  });

  it("requires the manage permission independently of read access", async () => {
    app = await testApp(repository().value, { permissions: ["platform.finance.read"] });
    const response = await app.inject({
      method: "POST",
      url: `/finance/platform/affiliate-payouts/${AFFILIATE_ID}/mark-paid`,
      headers: { authorization: "Bearer valid" },
      payload: markPaidBody(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "missing_permission" });
  });
});
