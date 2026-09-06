import { createFakeVerifier } from "@vayada/backend-auth";
import type { MembershipPropertyScope } from "@vayada/backend-authorization";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { requestContextFixtureCases } from "./platform/requestContext.fixtures.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const otherPropertyId = "10000000-0000-4000-8000-000000000002";
const financePrefix = `/api/finance/properties/${propertyId}`;
const pmsPath = `/api/pms/properties/${propertyId}/payment-settings`;
const paths = [
  `${financePrefix}/payment-settings`,
  `${financePrefix}/cancellation-policy`,
  `${financePrefix}/payouts`,
  ...["payments", "payouts", "provider-accounts"].map(
    (view) => `${financePrefix}/reconciliation/${view}`,
  ),
  pmsPath,
];

function state() {
  const context = structuredClone(
    requestContextFixtureCases.find(({ scope }) => scope === "hotel")!.context,
  );
  context.membership.roleKey = "hotel_custom";
  context.membership.permissions = [];
  context.linkedResources = [
    {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      relationship: "operator",
      status: "active",
    },
    {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      relationship: "operator",
      status: "active",
    },
  ];
  context.entitlements = [
    {
      product: "pms",
      key: "property-management",
      status: "active",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
      },
    },
  ];
  const scope: MembershipPropertyScope = {
    mode: "assigned",
    roleKey: "hotel_custom",
    accessOrigin: "agency",
    assignedPropertyIds: [propertyId],
    permissionOverrides: { grant: ["pms.finance.read"], deny: [] },
  };
  return { context, scope: scope as MembershipPropertyScope | null };
}
type State = ReturnType<typeof state>;

function fixture({ context, scope }: State, compatibilityOnly = false) {
  const repository = {
    getPaymentSettings: vi.fn(async () => null),
    getCancellationPolicy: vi.fn(async () => null),
    listPayouts: vi.fn(async () => ({
      payouts: [],
      total: 0,
      limit: 25,
      offset: 0,
      sourceFreshness: {},
    })),
    listReconciliationItems: vi.fn(async () => ({
      items: [],
      total: 0,
      limit: 25,
      offset: 0,
      sourceFreshness: {},
    })),
  };
  const findMembershipPropertyScope = vi.fn(async () => scope);
  const app = buildApp({
    logger: false,
    ...(compatibilityOnly
      ? { pmsFinanceCompatibilityRepository: repository }
      : { financeRepository: repository }),
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
  return { app, repository, findMembershipPropertyScope };
}

const denialCases: Array<[string, (value: State) => void, number?]> = [
  [
    "empty assignments",
    (s) => {
      s.scope!.assignedPropertyIds = [];
    },
  ],
  [
    "different assignment",
    (s) => {
      s.scope!.assignedPropertyIds = [otherPropertyId];
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
      s.scope!.mode = "unknown";
    },
  ],
  [
    "mismatched role",
    (s) => {
      s.scope!.roleKey = "hotel_owner";
    },
  ],
  [
    "external owner origin",
    (s) => {
      s.scope!.accessOrigin = "external_owner";
    },
  ],
  [
    "missing canonical link",
    (s) => {
      s.context.linkedResources.shift();
    },
  ],
  [
    "inactive canonical link",
    (s) => {
      s.context.linkedResources[0]!.status = "suspended";
    },
  ],
  [
    "foreign canonical link",
    (s) => {
      s.context.linkedResources[0]!.resourceId = otherPropertyId;
    },
  ],
  [
    "missing native link",
    (s) => {
      s.context.linkedResources.pop();
    },
  ],
  [
    "inactive native link",
    (s) => {
      s.context.linkedResources[1]!.status = "suspended";
    },
  ],
  [
    "source-native link",
    (s) => {
      s.context.linkedResources[1]!.resourceType = "pms_hotel";
    },
  ],
  [
    "compatibility link alone",
    (s) => {
      s.context.linkedResources[1]!.resourceType = "property";
      s.context.entitlements[0]!.resource!.resourceType = "property";
    },
  ],
  [
    "missing permission",
    (s) => {
      s.scope!.permissionOverrides = { grant: [], deny: [] };
    },
  ],
  [
    "missing entitlement",
    (s) => {
      s.context.entitlements = [];
    },
  ],
  [
    "inactive entitlement",
    (s) => {
      s.context.entitlements[0]!.status = "suspended";
    },
  ],
  [
    "foreign entitlement",
    (s) => {
      s.context.entitlements[0]!.resource!.resourceId = otherPropertyId;
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
      s.context.selectedOrganization.kind = "creator_workspace";
    },
  ],
  [
    "all mode without canonical link",
    (s) => {
      s.scope!.mode = "all";
      s.context.linkedResources.shift();
    },
  ],
];

describe.each([false, true])(
  "Finance property reads (compatibility-only: %s)",
  (compatibilityOnly) => {
    it.each(denialCases)(
      "denies %s before reading Finance data",
      async (_name, mutate, status = 403) => {
        const value = state();
        mutate(value);
        const { app, repository } = fixture(value, compatibilityOnly);
        try {
          for (const url of compatibilityOnly ? [pmsPath] : paths) {
            const response = await app.inject({
              url,
              headers: { authorization: "Bearer valid-token" },
            });
            expect(response.statusCode, url).toBe(status);
          }
          for (const read of Object.values(repository)) expect(read).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      },
    );

    it.each([undefined, "Bearer invalid-token"])(
      "denies invalid auth (%s) before reads",
      async (authorization) => {
        const { app, repository } = fixture(state(), compatibilityOnly);
        try {
          for (const url of compatibilityOnly ? [pmsPath] : paths) {
            const response = await app.inject({
              url,
              headers: authorization ? { authorization } : {},
            });
            expect(response.statusCode).toBe(401);
          }
          for (const read of Object.values(repository)) expect(read).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      },
    );

    it.each(["assigned", "all"])(
      "preserves allowed %s reads and resolves scope per request",
      async (mode) => {
        const value = state();
        value.scope!.mode = mode;
        if (mode === "all") {
          value.context.membership.roleKey = value.scope!.roleKey = "hotel_owner";
          value.scope!.assignedPropertyIds = [];
          value.scope!.permissionOverrides = undefined;
          value.context.membership.permissions = ["pms.finance.read"];
        }
        // Use the same Finance-only permission for owners; no extra access is needed.
        const { app, repository, findMembershipPropertyScope } = fixture(value, compatibilityOnly);
        try {
          for (const url of compatibilityOnly ? [pmsPath] : paths) {
            const response = await app.inject({
              url,
              headers: { authorization: "Bearer valid-token" },
            });
            expect(response.statusCode, url).toBe(200);
          }
          expect(repository.getPaymentSettings).toHaveBeenCalledWith(propertyId);
          expect(repository.getCancellationPolicy).toHaveBeenCalledWith(propertyId);
          expect(findMembershipPropertyScope).toHaveBeenCalledTimes(
            compatibilityOnly ? 1 : paths.length,
          );
        } finally {
          await app.close();
        }
      },
    );
  },
);
