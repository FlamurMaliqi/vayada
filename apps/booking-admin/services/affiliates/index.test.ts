import { describe, expect, it } from "vitest";

import type { ApiClient } from "../api/client";
import {
  createAffiliatesService,
  type Affiliate,
  type AffiliateCommission,
  type AffiliateListResponse,
} from "./index";

type TestClient = Pick<ApiClient, "get" | "post" | "patch">;
type Call = {
  method: "get" | "post" | "patch";
  endpoint: string;
  body?: unknown;
  options?: RequestInit;
};

const affiliate: Affiliate = {
  contractVersion: "marketplace-affiliate-admin.v1",
  affiliateId: "affiliate/with space",
  propertyId: "property/with space",
  referralCode: "VAY1278",
  displayName: "Ada Affiliate",
  contactEmail: "ada@example.test",
  socialMedia: "@ada",
  affiliateType: "creator",
  lifecycleStatus: "pending",
  applicationSource: "public_registration",
  appliedAt: "2026-08-13T20:00:00.000Z",
  updatedAt: "2026-08-13T20:00:00.000Z",
};

const commission: AffiliateCommission = {
  contractVersion: "finance-affiliate-commission.v1",
  propertyId: affiliate.propertyId,
  affiliateId: affiliate.affiliateId,
  defaultPercentageRate: "7.5",
  overridePercentageRate: "12",
  effectivePercentageRate: "12",
  updatedAt: "2026-08-13T21:00:00.000Z",
};

describe("Booking Admin affiliate target client", () => {
  it("lists filtered affiliates through the canonical Marketplace property route", async () => {
    const { client, calls } = fakeClient();
    const service = testService(client);
    const result = await service.list({
      status: "pending",
      affiliateType: "creator",
      search: "Ada Affiliate",
      limit: 20,
      offset: 40,
    });

    expect(result.affiliates).toEqual([affiliate]);
    expect(calls).toEqual([
      {
        method: "get",
        endpoint:
          "/api/marketplace/properties/property%2Fwith%20space/affiliates?status=pending&affiliateType=creator&search=Ada+Affiliate&limit=20&offset=40",
        options: omitHotelContext,
      },
    ]);
  });

  it("keeps Marketplace detail independent from Finance commission access", async () => {
    const { client, calls } = fakeClient();
    const service = testService(client);
    const detail = await service.get(" affiliate/with space ");
    const affiliateCommission = await service.getCommission(" affiliate/with space ");

    expect(detail).toEqual(affiliate);
    expect(affiliateCommission).toEqual(commission);
    expect(calls).toEqual([
      {
        method: "get",
        endpoint:
          "/api/marketplace/properties/property%2Fwith%20space/affiliates/affiliate%2Fwith%20space",
        options: omitHotelContext,
      },
      {
        method: "get",
        endpoint:
          "/api/finance/properties/property%2Fwith%20space/affiliates/affiliate%2Fwith%20space/commission",
        options: omitHotelContext,
      },
    ]);
    expect(JSON.stringify({ detail, affiliateCommission })).not.toMatch(
      /payout|iban|bankAccount|paymentMethod/i,
    );
  });

  it("posts lifecycle actions with a stable command/idempotency pair", async () => {
    const { client, calls } = fakeClient();
    await testService(client).updateStatus(affiliate.affiliateId, "approve");

    expect(calls).toEqual([
      {
        method: "post",
        endpoint:
          "/api/marketplace/properties/property%2Fwith%20space/affiliates/affiliate%2Fwith%20space/lifecycle",
        body: {
          commandId: "affiliate-approve-command-id",
          idempotencyKey: "affiliate-approve-command-id",
          action: "approve",
        },
        options: omitHotelContext,
      },
    ]);
  });

  it("patches Finance default and nullable affiliate overrides", async () => {
    const { client, calls } = fakeClient();
    const service = testService(client);
    await service.getDefaultCommission();
    await service.updateDefaultCommission("8.25");
    await service.updateCommission(affiliate.affiliateId, null);

    expect(calls).toEqual([
      {
        method: "get",
        endpoint: "/api/finance/properties/property%2Fwith%20space/affiliate-commission",
        options: omitHotelContext,
      },
      {
        method: "patch",
        endpoint: "/api/finance/properties/property%2Fwith%20space/affiliate-commission",
        body: {
          commandId: "affiliate-default-commission-command-id",
          idempotencyKey: "affiliate-default-commission-command-id",
          percentageRate: "8.25",
        },
        options: omitHotelContext,
      },
      {
        method: "patch",
        endpoint:
          "/api/finance/properties/property%2Fwith%20space/affiliates/affiliate%2Fwith%20space/commission",
        body: {
          commandId: "affiliate-commission-command-id",
          idempotencyKey: "affiliate-commission-command-id",
          percentageRate: null,
        },
        options: omitHotelContext,
      },
    ]);
  });

  it("rejects empty target scope and affiliate identifiers before network calls", async () => {
    const { client, calls } = fakeClient();
    await expect(
      createAffiliatesService({ client, resolvePropertyId: async () => " " }).list(),
    ).rejects.toThrow("Select a property");
    await expect(testService(client).get(" ")).rejects.toThrow("Affiliate id is required");
    expect(calls).toEqual([]);
  });
});

function testService(client: TestClient) {
  return createAffiliatesService({
    client,
    resolvePropertyId: async () => affiliate.propertyId,
    newCommandId: (prefix) => `${prefix}-command-id`,
  });
}

function fakeClient(): { client: TestClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: TestClient = {
    async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
      calls.push({ method: "get", endpoint, options });
      if (endpoint.includes("affiliate-commission") || endpoint.endsWith("/commission")) {
        return commission as T;
      }
      if (endpoint.includes("?") || endpoint.endsWith("/affiliates")) {
        return {
          contractVersion: "marketplace-affiliate-admin.v1",
          affiliates: [affiliate],
          total: 1,
          limit: 20,
          offset: 0,
        } satisfies AffiliateListResponse as T;
      }
      return affiliate as T;
    },
    async post<T>(endpoint: string, body?: unknown, options?: RequestInit): Promise<T> {
      calls.push({ method: "post", endpoint, body, options });
      return { outcome: "applied", commandId: "command", affiliate } as T;
    },
    async patch<T>(endpoint: string, body?: unknown, options?: RequestInit): Promise<T> {
      calls.push({ method: "patch", endpoint, body, options });
      return { outcome: "applied", commandId: "command", commission } as T;
    },
  };
  return { client, calls };
}

const omitHotelContext = { headers: { "X-Vayada-Omit-Hotel-Context": "true" } };
