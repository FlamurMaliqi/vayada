import { createFakeVerifier } from "@vayada/backend-auth";
import type { MembershipPropertyScope } from "@vayada/backend-authorization";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { requestContextFixtureCases } from "./platform/requestContext.fixtures.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const itemId = "10000000-0000-4000-8000-000000000002";
const root = `/api/finance/properties/${propertyId}/financials`;
const native = { product: "pms", resourceType: "pms_property", resourceId: propertyId } as const;
const scope: MembershipPropertyScope = {
  mode: "assigned",
  roleKey: "finance_manager",
  accessOrigin: "agency",
  assignedPropertyIds: [propertyId],
};
const command = { commandId: itemId, idempotencyKey: "test-command", expectedRevision: 1 };
const create = { commandId: itemId, idempotencyKey: "test-command" };
const money = { amount: "12.0000", currency: "EUR" };
const expense = {
  ...create,
  categoryId: itemId,
  incurredOn: "2026-09-06",
  vendor: "Vendor",
  amount: money,
  paymentStatus: "unpaid",
};
const folio = {
  ...create,
  bookingId: null,
  recipient: { name: "Test", email: null },
  serviceFrom: "2026-09-06",
  serviceTo: "2026-09-06",
  lines: [
    {
      position: 1,
      kind: "fee",
      description: "Test",
      quantity: "1.0000",
      unitAmount: money,
      serviceOn: "2026-09-06",
      source: { type: "manual", id: itemId, revision: 1 },
    },
  ],
  paymentRefs: [],
};
const routes = [
  ["GET", "expense-categories"],
  ["POST", "expense-categories", { ...create, name: "Test", color: "#123456", sortOrder: 1 }],
  ["PATCH", `expense-categories/${itemId}`, { ...command, name: "Test" }],
  ["DELETE", `expense-categories/${itemId}`, command],
  ["GET", "expenses"],
  ["POST", "expenses", expense],
  ["POST", "expenses", { ...expense, recurrence: { cadence: "monthly", startsOn: "2026-09-06" } }],
  ["GET", `expenses/${itemId}`],
  ["GET", `expenses/${itemId}/receipt`],
  ["PATCH", `expenses/${itemId}`, { ...command, vendor: "Test" }],
  ["DELETE", `expenses/${itemId}`, command],
  ["GET", `recurring-expenses/${itemId}`],
  ["PATCH", `recurring-expenses/${itemId}`, { ...command, vendor: "Test" }],
  ["DELETE", `recurring-expenses/${itemId}`, command],
  ["GET", "folios"],
  ["GET", `folios/${itemId}`],
  ["POST", "folios", folio],
  ["PATCH", `folios/${itemId}`, { ...folio, expectedRevision: 1 }],
  ["POST", `folios/${itemId}/ready`, command],
  ["DELETE", `folios/${itemId}`, command],
  ["GET", "ota-commission-settings"],
  [
    "PUT",
    "ota-commission-settings/booking_com",
    { ...create, expectedRevision: 0, effectiveFrom: "2026-09-06T00:00:00Z", percentageRate: "15" },
  ],
] as const;

function state() {
  const context = structuredClone(
    requestContextFixtureCases.find(({ scope }) => scope === "hotel")!.context,
  );
  context.membership.roleKey = scope.roleKey;
  context.membership.permissions = ["pms.finance.read", "pms.finance.manage"];
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
  context.entitlements = ["property-management", "module:financials"].map((key) => ({
    product: "pms",
    key,
    status: "active",
    resource: native,
  }));
  return { context, scope: structuredClone(scope) as MembershipPropertyScope | null };
}
type State = ReturnType<typeof state>;

function fixture(value: State) {
  const expenseRead = {
    categories: vi.fn(async () => null),
    expense: vi.fn(async () => null),
    expenses: vi.fn(async () => null),
    recurringRule: vi.fn(async () => null),
  };
  const categories = { create: vi.fn(), update: vi.fn(), archive: vi.fn() };
  const expenses = { create: vi.fn(), update: vi.fn(), archive: vi.fn() };
  const recurring = { create: vi.fn(), update: vi.fn(), disable: vi.fn() };
  const folioRead = { list: vi.fn(async () => null), detail: vi.fn(async () => null) };
  const folioCommands = { create: vi.fn(), correct: vi.fn(), ready: vi.fn(), archive: vi.fn() };
  const ota = { list: vi.fn(async () => []), setRule: vi.fn() };
  const receipt = vi.fn(async () => null),
    signPrivateDownload = vi.fn();
  const propertyAccessRepository = { findMembershipPropertyScope: vi.fn(async () => value.scope) };
  const { context } = value;
  const app = buildApp({
    logger: false,
    financeExpenses: {
      read: expenseRead,
      categories,
      expenses,
      recurring,
      receiptMedia: {
        read: { receipt },
        signer: { signPrivateDownload },
        serving: {
          bucketName: "test-media",
          cdnBaseUrl: "https://cdn.example",
          cdnOriginHost: "origin.example",
          publicPathPrefix: "media",
          publicCacheControl: "public",
          privateDownloadTtlSeconds: 300,
          privateDownloadMaxTtlSeconds: 900,
        },
      },
    },
    financeFolios: { repository: folioRead, commands: folioCommands },
    financeOtaCommissionSettingsRepository: ota,
    auth: {
      verifier: createFakeVerifier(
        new Map([
          [
            "valid",
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
          workosMembershipId: "test-member",
          workosRoleSlugs: [],
        }),
        findLinkedResources: async () => context.linkedResources,
      },
      propertyAccessRepository,
      rolePermissionRepository: {
        findPermissionsForRole: async () => context.membership.permissions,
      },
      entitlementRepository: { findEntitlementsForContext: async () => context.entitlements },
    },
  });
  const ports = [
    expenseRead,
    categories,
    expenses,
    recurring,
    folioRead,
    folioCommands,
    ota,
  ].flatMap(Object.values);
  return { app, ports: [...ports, receipt, signPrivateDownload], expenseRead, folioRead, ota };
}

const denied: Array<[string, (s: State) => void, number?]> = [
  [
    "empty assignment",
    (s) => {
      s.scope!.assignedPropertyIds = [];
    },
  ],
  [
    "different assignment",
    (s) => {
      s.scope!.assignedPropertyIds = [itemId];
    },
  ],
  [
    "missing scope",
    (s) => {
      s.scope = null;
    },
  ],
  [
    "invalid mode",
    (s) => {
      s.scope!.mode = "invalid";
    },
  ],
  [
    "role mismatch",
    (s) => {
      s.scope!.roleKey = "hotel_owner";
    },
  ],
  [
    "delegated origin",
    (s) => {
      s.scope!.accessOrigin = "external_owner";
    },
  ],
  [
    "missing canonical link",
    (s) => {
      s.context.linkedResources.pop();
    },
  ],
  [
    "inactive canonical link",
    (s) => {
      s.context.linkedResources[1]!.status = "suspended";
    },
  ],
  [
    "foreign canonical link",
    (s) => {
      s.context.linkedResources[1]!.resourceId = itemId;
    },
  ],
  [
    "missing native link",
    (s) => {
      s.context.linkedResources.shift();
    },
  ],
  [
    "inactive native link",
    (s) => {
      s.context.linkedResources[0]!.status = "suspended";
    },
  ],
  [
    "source-native link",
    (s) => {
      s.context.linkedResources[0]!.resourceType = "pms_hotel";
    },
  ],
  [
    "canonical operator",
    (s) => {
      s.context.linkedResources[1]!.relationship = "operator";
    },
  ],
  [
    "native operator",
    (s) => {
      s.context.linkedResources[0]!.relationship = "operator";
    },
  ],
  [
    "missing permission",
    (s) => {
      s.context.membership.permissions = [];
    },
  ],
  [
    "missing product entitlement",
    (s) => {
      s.context.entitlements.shift();
    },
  ],
  [
    "missing module entitlement",
    (s) => {
      s.context.entitlements.pop();
    },
  ],
  [
    "inactive module entitlement",
    (s) => {
      s.context.entitlements[1]!.status = "suspended";
    },
  ],
  [
    "inactive membership",
    (s) => {
      s.context.membership.status = "inactive";
    },
    401,
  ],
  [
    "inactive organization",
    (s) => {
      s.context.selectedOrganization.status = "suspended";
    },
    401,
  ],
  [
    "wrong organization kind",
    (s) => {
      s.context.selectedOrganization.kind = "platform";
    },
  ],
  [
    "all mode without canonical link",
    (s) => {
      s.scope!.mode = "all";
      s.context.linkedResources.pop();
    },
  ],
];

describe("Financials property access at the real app boundary", () => {
  it.each(denied)(
    "denies %s before every read, command or receipt signer",
    async (_name, mutate, status = 403) => {
      const value = state();
      mutate(value);
      const { app, ports } = fixture(value);
      try {
        for (const [method, path, payload] of routes) {
          const response = await app.inject({
            method,
            url: `${root}/${path}`,
            payload,
            headers: { authorization: "Bearer valid" },
          });
          expect(response.statusCode, `${method} ${path}`).toBe(status);
        }
        for (const port of ports) expect(port).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );

  it.each(["assigned", "all"])(
    "permits %s reads only through active canonical/native links",
    async (mode) => {
      const value = state();
      value.scope!.mode = mode;
      if (mode === "all") {
        value.context.membership.roleKey = value.scope!.roleKey = "hotel_owner";
        value.scope!.assignedPropertyIds = [];
        value.context.linkedResources.forEach((link) => {
          link.relationship = "owner";
        });
      }
      const { app, expenseRead, folioRead, ota } = fixture(value);
      try {
        for (const [path, status] of [
          ["expense-categories", 404],
          ["folios", 404],
          ["ota-commission-settings", 200],
        ] as const) {
          expect(
            (
              await app.inject({
                url: `${root}/${path}`,
                headers: { authorization: "Bearer valid" },
              })
            ).statusCode,
          ).toBe(status);
        }
        expect(expenseRead.categories).toHaveBeenCalledWith(propertyId);
        expect(folioRead.list).toHaveBeenCalledOnce();
        expect(ota.list).toHaveBeenCalledWith(propertyId);
      } finally {
        await app.close();
      }
    },
  );
});
