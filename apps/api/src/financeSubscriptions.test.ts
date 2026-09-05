import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import type { FinanceSubscriptionService } from "@vayada/domain-finance";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";

const propertyId = "f3000000-0000-0000-0000-000000001120";
const organizationId = "f2000000-0000-0000-0000-000000001120";

describe("Finance subscription route authorization", () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("denies unauthenticated and unauthorized property reads before calling Finance", async () => {
    for (const testCase of [
      { name: "unauthenticated", auth: false, expected: 401 },
      { name: "missing permission", permissions: ["pms.operations.read"], expected: 403 },
      { name: "missing entitlement", entitlements: [], expected: 403 },
      { name: "unlinked property", linked: false, expected: 403 },
    ] satisfies Array<{
      name: string;
      auth?: boolean;
      permissions?: PermissionKey[];
      entitlements?: ProductEntitlement[];
      linked?: boolean;
      expected: number;
    }>) {
      const fixture = createApp(testCase);
      apps.push(fixture.app);
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/finance/properties/${propertyId}/plan-status`,
        headers: testCase.auth === false ? {} : { authorization: "Bearer valid-token" },
      });
      expect(response.statusCode, testCase.name).toBe(testCase.expected);
      expect(fixture.service.getPlanStatus, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("allows linked Finance reads and settings writes with the target entitlement", async () => {
    const fixture = createApp({
      permissions: ["pms.finance.read", "booking.settings.manage"],
    });
    apps.push(fixture.app);
    const read = await fixture.app.inject({
      method: "GET",
      url: `/api/finance/properties/${propertyId}/plan-status`,
      headers: { authorization: "Bearer valid-token" },
    });
    const write = await fixture.app.inject({
      method: "POST",
      url: `/api/finance/properties/${propertyId}/fixed-plan/checkout`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "command-1",
        idempotencyKey: "idempotency-1",
        customerEmail: "attacker@example.test",
      },
    });
    const selectCommission = await fixture.app.inject({
      method: "POST",
      url: `/api/finance/properties/${propertyId}/select-commission`,
      headers: { authorization: "Bearer valid-token" },
      payload: { commandId: "command-commission", idempotencyKey: "commission-1" },
    });
    const billing = await fixture.app.inject({
      method: "GET",
      url: `/api/finance/properties/${propertyId}/billing`,
      headers: { authorization: "Bearer valid-token" },
    });
    const paymentMethod = await fixture.app.inject({
      method: "PATCH",
      url: `/api/finance/properties/${propertyId}/payment-method`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "command-payment",
        idempotencyKey: "payment-1",
        paymentMethod: "bank_transfer",
      },
    });
    const cardActivation = await fixture.app.inject({
      method: "POST",
      url: `/api/finance/properties/${propertyId}/fixed-plan/card`,
      headers: { authorization: "Bearer valid-token" },
      payload: { commandId: "command-card", idempotencyKey: "card-1" },
    });
    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(201);
    expect(selectCommission.statusCode).toBe(201);
    expect(billing.statusCode).toBe(200);
    expect(paymentMethod.statusCode).toBe(200);
    expect(cardActivation.statusCode).toBe(200);
    expect(fixture.service.createFixedPlanCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        organizationId,
        customerEmail: "host@example.test",
      }),
    );
    expect(fixture.service.selectCommissionPlan).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId, organizationId }),
    );
    expect(fixture.service.activateFixedPlanByCard).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId, organizationId }),
    );
  });
});

function createApp(options: {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  linked?: boolean;
}) {
  const service = {
    getPlanStatus: vi.fn(async () => planStatus()),
    getBillingOverview: vi.fn(async () => billingOverview()),
    selectCommissionPlan: vi.fn(async () => ({
      ok: true as const,
      status: "created" as const,
      value: { planStatus: planStatus() },
    })),
    createFixedPlanCheckout: vi.fn(async () => ({
      ok: true as const,
      status: "created" as const,
      value: {
        checkoutSessionId: "cs_fixed",
        checkoutUrl: "https://checkout.stripe.test/fixed",
        currency: "EUR" as const,
        amountMinor: 3_000,
        activeRoomCount: 1,
      },
    })),
    activateFixedPlanByInvoice: vi.fn(async () => ({
      ok: true as const,
      status: "updated" as const,
      value: { ...billingOverview(), planStatus: { ...planStatus(), plan: "fixed" as const } },
    })),
    activateFixedPlanByCard: vi.fn(async () => ({
      ok: true as const,
      status: "updated" as const,
      value: { ...billingOverview(), planStatus: { ...planStatus(), plan: "fixed" as const } },
    })),
    openCustomerPortal: vi.fn(),
    scheduleCommissionPlan: vi.fn(),
    switchToCommissionNow: vi.fn(),
    updateBillingDetails: vi.fn(async () => ({
      ok: true as const,
      status: "updated" as const,
      value: billingOverview(),
    })),
    updatePaymentMethod: vi.fn(async () => ({
      ok: true as const,
      status: "updated" as const,
      value: { ...billingOverview(), paymentMethod: "bank_transfer" as const },
    })),
    close: vi.fn(),
  } satisfies FinanceSubscriptionService;
  const app = buildApp({
    logger: false,
    financeSubscriptionService: service,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options.linked !== false),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["pms.finance.read"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return options.entitlements ?? [directBookingFinanceEntitlement()];
        },
      },
    },
  });
  return { app, service };
}

const session: VerifiedSession = {
  workosUserId: "workos_finance_subscription_user",
  workosOrgId: "workos_finance_subscription_org",
  sessionId: "session_finance_subscription",
  expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
};

function identityRepository(linked: boolean): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: "user-finance-subscription", email: "host@example.test", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId,
        workosOrgId: session.workosOrgId,
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership-finance-subscription",
        status: "active",
        roleKey: "finance_manager",
        workosMembershipId: "workos-membership-finance-subscription",
        workosRoleSlugs: ["finance_manager"],
      };
    },
    async findLinkedResources() {
      return linked
        ? [
            {
              product: "pms",
              resourceType: "property",
              resourceId: propertyId,
              relationship: "finance_manager",
              status: "active" as const,
            },
          ]
        : [];
    },
  };
}

function directBookingFinanceEntitlement(): ProductEntitlement {
  return {
    product: "booking",
    key: "direct-booking-finance",
    status: "active",
    resource: { product: "pms", resourceType: "property", resourceId: propertyId },
  };
}

function planStatus() {
  return {
    propertyId,
    plan: "commission" as const,
    status: "commission" as const,
    currency: "EUR" as const,
    activeRoomCount: 1,
    amountMinor: 3_000,
    fixedPlanAvailable: true,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    nextBillingDate: null,
    cancelAtPeriodEnd: false,
    checkoutPending: false,
    customerPortalAvailable: false,
    activatedAt: null,
    updatedAt: "2026-08-11T12:00:00.000Z",
  };
}

function billingOverview() {
  return {
    propertyId,
    planStatus: planStatus(),
    paymentMethod: "card" as const,
    savedCard: null,
    billingDetails: { companyName: "", billingEmail: "", taxId: null },
    invoices: [],
  };
}
