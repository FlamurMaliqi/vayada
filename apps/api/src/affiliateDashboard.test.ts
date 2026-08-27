import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  FinanceAffiliatePayoutSettingsPatchCommand,
  FinanceAffiliatePayoutSettingsReadModel,
  FinancePayout,
  FinancePayoutListQuery,
  FinancePropertyReadRepository,
} from "@vayada/domain-finance";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type { AffiliateDashboardReadRepository } from "./routes/affiliateDashboard.js";

const affiliateId = "affiliate_target_886";
const organizationId = "org_affiliate_target_886";
const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "workos_affiliate_user",
  workosOrgId: "workos_affiliate_org",
  sessionId: "session_affiliate",
  expiresAt: futureExpiry,
};

const payoutSettings: FinanceAffiliatePayoutSettingsReadModel = {
  affiliateId,
  marketplaceOrganizationId: organizationId,
  payoutsEnabled: true,
  payoutProvider: "stripe",
  payoutCurrency: "EUR",
  payoutSchedule: "monthly",
  payoutThresholdAmount: null,
  providerAccount: {
    providerAccountId: "acct_affiliate_target_886",
    provider: "stripe",
    status: "active",
    onboardingStatus: "completed",
    payoutsEnabled: true,
  },
  sourceFreshness: { finance: "target", status: "fresh" },
  updatedAt: "2026-06-24T10:00:00.000Z",
};

describe("affiliate dashboard target routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("serves target affiliate dashboard contracts from RequestContext", async () => {
    app = buildAffiliateApp({
      affiliateDashboardRepository: targetAffiliateRepository(),
    });

    for (const url of [
      "/api/affiliate/me",
      "/api/affiliate/dashboard",
      "/api/affiliate/properties",
      "/api/affiliate/earnings?period=3m",
      "/api/affiliate/activity?limit=5",
    ]) {
      const response = await injectJson<Record<string, unknown>>(app, {
        method: "GET",
        url,
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode, url).toBe(200);
      expect(response.body.contractVersion, url).toBe("affiliate-dashboard.v1");
      expect(JSON.stringify(response.body), url).not.toMatch(/api\.pms|pms-backend|\/affiliate\//);
    }
  });

  it("routes affiliate payout reads and writes through the finance contract", async () => {
    const seenCommands: FinanceAffiliatePayoutSettingsPatchCommand[] = [];
    app = buildAffiliateApp({
      financeRepository: targetFinanceRepository({ seenCommands }),
    });

    const settingsResponse = await injectJson<Record<string, unknown>>(app, {
      method: "GET",
      url: "/api/affiliate/payout-settings",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsResponse.body).toMatchObject({
      contractVersion: "finance-route-contracts.v1",
      affiliateId,
      payoutSettings: {
        payoutProvider: "stripe",
        providerAccount: {
          providerAccountId: "acct_affiliate_target_886",
        },
      },
    });

    const payoutsResponse = await injectJson<Record<string, unknown>>(app, {
      method: "GET",
      url: "/api/affiliate/payouts?limit=25&offset=0",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(payoutsResponse.statusCode).toBe(200);
    expect(payoutsResponse.body).toMatchObject({
      contractVersion: "finance-route-contracts.v1",
      affiliateId,
      total: 1,
    });
    expect(JSON.stringify(payoutsResponse.body)).not.toMatch(
      /referralCode|affiliateProfileEmail|accountNumber|stripeSecretKey|xenditApiKey/,
    );

    const patchResponse = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: "/api/affiliate/payout-settings",
      payload: {
        commandId: "cmd-affiliate-dashboard-settings-886",
        idempotencyKey: "affiliate-dashboard-settings-886",
        payoutsEnabled: true,
        payoutProvider: "bank_transfer",
        payoutCurrency: "EUR",
        payoutSchedule: "threshold",
        payoutThresholdAmount: "100.00",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(patchResponse.statusCode).toBe(200);
    expect(seenCommands).toHaveLength(1);
    expect(seenCommands[0]).toMatchObject({
      commandType: "finance.affiliate_payout_settings.update",
      affiliateId,
      payload: {
        payoutProvider: "bank_transfer",
        payoutThresholdAmount: "100.00",
      },
    });
  });

  it("fails closed for affiliate Xendit bank validation until VAY-795 defines the contract", async () => {
    app = buildAffiliateApp();

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: "/api/affiliate/xendit/validate-bank-account",
      payload: {
        channelCode: "ID_BCA",
        accountNumber: "1234567890",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.body).toMatchObject({
      code: "read_model_unavailable",
      followUpIssues: ["VAY-795"],
    });
  });
});

function buildAffiliateApp(
  options: {
    affiliateDashboardRepository?: Partial<AffiliateDashboardReadRepository>;
    financeRepository?: FinancePropertyReadRepository;
    permissions?: PermissionKey[];
    entitlements?: ProductEntitlement[];
  } = {},
): FastifyInstance {
  return buildApp({
    logger: false,
    affiliateDashboardRepository: options.affiliateDashboardRepository,
    financeRepository: options.financeRepository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: affiliateIdentityRepository(),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["affiliate.payout.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return options.entitlements ?? [affiliatePayoutEntitlement()];
        },
      },
    },
  });
}

function targetAffiliateRepository(): AffiliateDashboardReadRepository {
  return {
    async getSummary(requestedAffiliateId) {
      expect(requestedAffiliateId).toBe(affiliateId);
      return {
        affiliateId,
        currency: "EUR",
        totalCommissionAmount: "275.00",
        bookingCount: 4,
        clickCount: 80,
        conversionRate: 5,
        propertyCount: 1,
        outstandingBalanceAmount: "125.00",
        sourceFreshness: { marketplace: "target", finance: "target" },
      };
    },
    async listProperties(requestedAffiliateId) {
      expect(requestedAffiliateId).toBe(affiliateId);
      return [
        {
          affiliateId,
          propertyId: "property_alpenrose",
          displayName: "Hotel Alpenrose",
          slug: "hotel-alpenrose",
          referralCode: "ALPEN-886",
          commissionPercent: 10,
          status: "active",
          metrics: {
            bookingCount: 4,
            clickCount: 80,
            conversionRate: 5,
            totalRevenueAmount: "2750.00",
            totalCommissionAmount: "275.00",
          },
        },
      ];
    },
    async listEarnings(requestedAffiliateId, period) {
      expect(requestedAffiliateId).toBe(affiliateId);
      expect(period).toBe("3m");
      return {
        currency: "EUR",
        buckets: [
          {
            bucketStart: "2026-04-01",
            label: "Apr",
            commissionAmount: "75.00",
          },
        ],
        sourceFreshness: { finance: "target" },
      };
    },
    async listActivity(requestedAffiliateId, query) {
      expect(requestedAffiliateId).toBe(affiliateId);
      expect(query.limit).toBe(5);
      return [
        {
          activityType: "booking",
          occurredAt: "2026-06-24T10:00:00.000Z",
          propertyName: "Hotel Alpenrose",
          count: 1,
        },
      ];
    },
  };
}

function targetFinanceRepository(options: {
  seenCommands: FinanceAffiliatePayoutSettingsPatchCommand[];
}): FinancePropertyReadRepository {
  const payout: FinancePayout = {
    payoutId: "payout_affiliate_886",
    ownerScope: "organization",
    propertyId: null,
    organizationId,
    relatedPropertyId: "property_alpenrose",
    guestBookingId: "booking_886",
    paymentId: "payment_886",
    payoutStatus: "paid",
    amount: "125.00",
    feeAmount: "0.00",
    netAmount: "125.00",
    currency: "EUR",
    provider: "stripe",
    providerPayoutId: "po_886",
    scheduledAt: "2026-06-24T10:00:00.000Z",
    paidAt: "2026-06-24T10:05:00.000Z",
    failedAt: null,
    failureCode: null,
    retryCount: 0,
  };

  return {
    async getPaymentSettings() {
      throw new Error("property payment settings should not be called");
    },
    async getCancellationPolicy() {
      throw new Error("property cancellation policy should not be called");
    },
    async getAffiliatePayoutSettings(requestedAffiliateId) {
      expect(requestedAffiliateId).toBe(affiliateId);
      return payoutSettings;
    },
    async listAffiliatePayouts(requestedAffiliateId: string, query: FinancePayoutListQuery) {
      expect(requestedAffiliateId).toBe(affiliateId);
      return {
        payouts: [payout],
        total: 1,
        limit: query.limit,
        offset: query.offset,
        sourceFreshness: { finance: { status: "fresh" } },
      };
    },
    async updateAffiliatePayoutSettings(command) {
      options.seenCommands.push(command);
      return {
        ok: true,
        status: "updated",
        settings: {
          ...payoutSettings,
          payoutProvider: command.payload.payoutProvider ?? payoutSettings.payoutProvider,
          payoutThresholdAmount:
            command.payload.payoutThresholdAmount ?? payoutSettings.payoutThresholdAmount,
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
}

function affiliateIdentityRepository(): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_affiliate_886",
        email: "affiliate@example.test",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId,
        workosOrgId: "workos_affiliate_org",
        kind: "affiliate_partner",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_affiliate_886",
        status: "active",
        roleKey: "affiliate_owner",
        workosMembershipId: "om_affiliate_886",
        workosRoleSlugs: ["affiliate_owner"],
      };
    },
    async findLinkedResources() {
      return [
        {
          product: "affiliate",
          resourceType: "affiliate",
          resourceId: affiliateId,
          relationship: "owner",
          status: "active",
        },
      ];
    },
  };
}

function affiliatePayoutEntitlement(): ProductEntitlement {
  return {
    product: "affiliate",
    key: "affiliate-payouts",
    status: "active",
    resource: {
      product: "affiliate",
      resourceType: "affiliate",
      resourceId: affiliateId,
    },
  };
}
