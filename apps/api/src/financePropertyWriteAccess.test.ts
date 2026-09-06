import { createFakeVerifier } from "@vayada/backend-auth";
import type { MembershipPropertyScope } from "@vayada/backend-authorization";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { requestContextFixtureCases } from "./platform/requestContext.fixtures.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const itemId = "10000000-0000-4000-8000-000000000002";
const root = `/api/finance/properties/${propertyId}`;
const native = { product: "pms", resourceType: "pms_property", resourceId: propertyId } as const;
const command = { commandId: itemId, idempotencyKey: "synthetic-command" };
const routes = [
  ["PATCH", "payment-settings", { ...command, paymentSettings: { paymentsEnabled: false } }],
  ["POST", "provider-accounts/stripe", { ...command, email: "staff@example.test", country: "DE" }],
  ["POST", `provider-accounts/${itemId}/onboarding-link`, command],
  ["POST", "provider-accounts/stripe/reconcile", command],
  ["POST", "provider-accounts/stripe/dashboard-link", command],
  [
    "POST",
    `payouts/${itemId}/dispatch`,
    {
      ...command,
      legacySchedulerFrozenAt: "2026-09-06T00:00:00Z",
      reconciliationReadyAt: "2026-09-06T00:00:00Z",
    },
  ],
  [
    "POST",
    "provider-accounts/xendit/bank-validation",
    {
      ...command,
      channelCode: "ID_BCA",
      accountNumber: "12345678",
      accountHolderName: "Test",
    },
  ],
  ["POST", "reconciliation/xendit-payouts", { ...command, olderThanMinutes: 30 }],
  ["POST", "select-commission", command],
  ["POST", "fixed-plan/checkout", command],
  ["POST", "customer-portal", command],
  ["POST", "fixed-plan/invoice", command],
  ["POST", "fixed-plan/card", command],
  ["POST", "switch-to-commission", command],
  ["POST", "switch-to-commission-now", command],
  [
    "PATCH",
    "billing-details",
    { ...command, companyName: "Test", billingEmail: "staff@example.test" },
  ],
  ["PATCH", "payment-method", { ...command, paymentMethod: "bank_transfer" }],
  [
    "PUT",
    "bank-transfer-destination",
    {
      action: "replace",
      commandId: itemId,
      expectedVersion: 0,
      details: {
        accountHolder: "Test",
        accountType: "iban",
        accountNumber: "DE89370400440532013000",
        bankName: "Test",
        bicSwift: "COBADEFFXXX",
        instructions: "Test",
      },
    },
  ],
  [
    "PUT",
    "bank-transfer-destination",
    { action: "disable", commandId: itemId, expectedVersion: 1 },
  ],
  ["PUT", "bank-transfer-destination", { action: "delete", commandId: itemId, expectedVersion: 1 }],
] as const;

function state() {
  const context = structuredClone(
    requestContextFixtureCases.find(({ scope }) => scope === "hotel")!.context,
  );
  context.membership.roleKey = "finance_manager";
  context.membership.permissions = ["pms.operations.manage", "booking.settings.manage"];
  context.linkedResources = [
    { ...native, relationship: "finance_manager", status: "active" },
    {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      relationship: "finance_manager",
      status: "active",
    },
  ];
  context.entitlements = [
    { product: "pms", key: "property-management", status: "active", resource: native },
  ];
  const scope: MembershipPropertyScope = {
    mode: "assigned",
    roleKey: "finance_manager",
    accessOrigin: "agency",
    assignedPropertyIds: [propertyId],
  };
  return { context, scope: scope as MembershipPropertyScope | null };
}
type State = ReturnType<typeof state>;

function fixture(value: State) {
  const writes = {
    updatePaymentSettings: vi.fn(),
    createStripeProviderAccount: vi.fn(),
    issueStripeOnboardingLink: vi.fn(),
    reconcileStripeProviderAccount: vi.fn(),
    issueStripeDashboardLoginLink: vi.fn(),
    enqueuePropertyPayoutDispatch: vi.fn(),
    enqueueXenditPayoutReconciliation: vi.fn(),
  };
  const service = {
    getPlanStatus: vi.fn(),
    getBillingOverview: vi.fn(),
    selectCommissionPlan: vi.fn(),
    createFixedPlanCheckout: vi.fn(),
    openCustomerPortal: vi.fn(),
    activateFixedPlanByInvoice: vi.fn(),
    activateFixedPlanByCard: vi.fn(),
    scheduleCommissionPlan: vi.fn(),
    switchToCommissionNow: vi.fn(),
    updateBillingDetails: vi.fn(),
    updatePaymentMethod: vi.fn(),
  };
  // Controlled command failures prove authorized requests reach the ports without live effects.
  for (const port of [...Object.values(writes), ...Object.values(service)]) {
    port.mockResolvedValue({
      ok: false,
      statusCode: 409,
      code: "fixture_conflict",
      message: "Synthetic command reached.",
    });
  }
  const repository = { getPaymentSettings: vi.fn(), getCancellationPolicy: vi.fn(), ...writes };
  const bank = { read: vi.fn(), execute: vi.fn().mockResolvedValue({ status: "conflict" }) };
  const validateBankAccount = vi
    .fn()
    .mockResolvedValue({ status: "valid", accountHolderName: "Test", providerReference: "test" });
  const publish = vi.fn();
  const { context } = value;
  const findMembershipPropertyScope = vi.fn(async () => value.scope);
  const app = buildApp({
    logger: false,
    financeRepository: repository,
    financeSubscriptionService: service,
    financeBankTransfer: { repository: bank },
    financeXenditBankValidator: { validateBankAccount },
    publicBookabilityPublisher: { publish },
    auth: {
      verifier: createFakeVerifier(
        new Map([
          [
            "valid-token",
            {
              workosUserId: "test-user",
              workosOrgId: "test-org",
              sessionId: "test-session",
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
        ]),
      ),
      repository: {
        findUserByProviderUserId: async () => ({
          userId: context.actor.internalUserId,
          email: "staff@example.test",
          status: context.actor.status,
        }),
        findOrganizationByWorkosOrgId: async () => ({
          ...context.selectedOrganization,
          workosOrgId: "test-org",
        }),
        findActiveMembership: async () => ({
          ...context.membership,
          workosMembershipId: "test-membership",
          workosRoleSlugs: [],
        }),
        findLinkedResources: async () => context.linkedResources,
      },
      propertyAccessRepository: { findMembershipPropertyScope },
      rolePermissionRepository: {
        findPermissionsForRole: async () => context.membership.permissions,
      },
      entitlementRepository: { findEntitlementsForContext: async () => context.entitlements },
    },
  });
  return {
    app,
    writes,
    service,
    bank,
    validateBankAccount,
    findMembershipPropertyScope,
    ports: [
      ...Object.values(repository),
      ...Object.values(service),
      ...Object.values(bank),
      validateBankAccount,
      publish,
    ],
  };
}

const denials: Array<[string, (s: State) => void, number?]> = [
  ["empty assignment", (s) => (s.scope!.assignedPropertyIds = [])],
  ["different assignment", (s) => (s.scope!.assignedPropertyIds = [itemId])],
  ["missing scope", (s) => (s.scope = null)],
  ["invalid mode", (s) => (s.scope!.mode = "invalid")],
  ["mismatched role", (s) => (s.scope!.roleKey = "hotel_owner")],
  ["external owner origin", (s) => (s.scope!.accessOrigin = "external_owner")],
  [
    "missing canonical link",
    (s) => {
      s.context.linkedResources.pop();
    },
  ],
  ["inactive canonical link", (s) => (s.context.linkedResources[1]!.status = "suspended")],
  ["foreign canonical link", (s) => (s.context.linkedResources[1]!.resourceId = itemId)],
  ["canonical operator", (s) => (s.context.linkedResources[1]!.relationship = "operator")],
  [
    "missing native link",
    (s) => {
      s.context.linkedResources.shift();
    },
  ],
  ["inactive native link", (s) => (s.context.linkedResources[0]!.status = "suspended")],
  ["source-native link", (s) => (s.context.linkedResources[0]!.resourceType = "pms_hotel")],
  ["native operator", (s) => (s.context.linkedResources[0]!.relationship = "operator")],
  [
    "compatibility link alone",
    (s) => {
      s.context.linkedResources[0]!.resourceType = "property";
      s.context.entitlements[0]!.resource = { ...native, resourceType: "property" };
    },
  ],
  ["missing permission", (s) => (s.context.membership.permissions = [])],
  ["read-only permission", (s) => (s.context.membership.permissions = ["pms.finance.read"])],
  ["missing entitlement", (s) => (s.context.entitlements = [])],
  ["inactive entitlement", (s) => (s.context.entitlements[0]!.status = "suspended")],
  [
    "foreign entitlement",
    (s) => (s.context.entitlements[0]!.resource = { ...native, resourceId: itemId }),
  ],
  ["inactive membership", (s) => (s.context.membership.status = "inactive"), 401],
  ["inactive organization", (s) => (s.context.selectedOrganization.status = "suspended"), 401],
  ["wrong organization kind", (s) => (s.context.selectedOrganization.kind = "creator_workspace")],
  [
    "all without canonical link",
    (s) => {
      s.scope!.mode = "all";
      s.context.linkedResources.pop();
    },
  ],
];

describe("Finance property write scope", () => {
  it.each(denials)(
    "denies %s before every command/provider/publication port",
    async (_name, mutate, status = 403) => {
      const value = state();
      mutate(value);
      const { app, ports } = fixture(value);
      try {
        for (const [method, route, payload] of routes) {
          const response = await app.inject({
            method,
            url: `${root}/${route}`,
            payload,
            headers: { authorization: "Bearer valid-token" },
          });
          expect(response.statusCode, `${method} ${route}`).toBe(status);
        }
        for (const port of ports) expect(port).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each([undefined, "Bearer invalid-token"])(
    "denies invalid auth (%s) before all ports",
    async (authorization) => {
      const { app, ports } = fixture(state());
      try {
        for (const [method, route, payload] of routes) {
          const response = await app.inject({
            method,
            url: `${root}/${route}`,
            payload,
            headers: authorization ? { authorization } : {},
          });
          expect(response.statusCode, route).toBe(401);
        }
        for (const port of ports) expect(port).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each(["assigned", "all", "booking-only", "compatibility-entitlement"])(
    "preserves %s command access and denies after scope revocation",
    async (mode) => {
      const value = state();
      if (mode === "all") {
        value.context.membership.roleKey = value.scope!.roleKey = "hotel_owner";
        value.scope!.mode = "all";
        value.scope!.assignedPropertyIds = [];
        for (const link of value.context.linkedResources) link.relationship = "owner";
      }
      if (mode === "booking-only") {
        value.context.membership.permissions = ["booking.settings.manage"];
        value.context.entitlements[0]!.product = "booking";
        value.context.entitlements[0]!.key = "direct-booking-finance";
      }
      if (mode === "compatibility-entitlement") {
        value.context.linkedResources.push({
          ...native,
          resourceType: "property",
          relationship: "finance_manager",
          status: "active",
        });
        value.context.entitlements[0]!.resource = { ...native, resourceType: "property" };
      }
      const {
        app,
        writes,
        service,
        bank,
        validateBankAccount,
        findMembershipPropertyScope,
        ports,
      } = fixture(value);
      try {
        for (const [method, route, payload] of routes) {
          const response = await app.inject({
            method,
            url: `${root}/${route}`,
            payload,
            headers: { authorization: "Bearer valid-token" },
          });
          expect(response.statusCode, route).toBe(route.endsWith("bank-validation") ? 200 : 409);
        }
        for (const port of Object.values(writes)) expect(port).toHaveBeenCalledTimes(1);
        for (const [name, port] of Object.entries(service)) {
          if (!name.startsWith("get")) expect(port).toHaveBeenCalledTimes(1);
        }
        expect(bank.execute).toHaveBeenCalledTimes(3);
        expect(validateBankAccount).toHaveBeenCalledTimes(1);
        expect(findMembershipPropertyScope).toHaveBeenCalledTimes(routes.length);
        value.scope!.mode = "assigned";
        value.scope!.assignedPropertyIds = [];
        for (const port of ports) port.mockClear();
        for (const [method, route, payload] of routes) {
          const response = await app.inject({
            method,
            url: `${root}/${route}`,
            payload,
            headers: { authorization: "Bearer valid-token" },
          });
          expect(response.statusCode, route).toBe(403);
        }
        for (const port of ports) expect(port).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
});
