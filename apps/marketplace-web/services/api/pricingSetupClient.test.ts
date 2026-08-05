import {
  PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
  PMS_PRICING_CONTRACT_VERSION,
  PMS_RECURRING_PRICING_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsMandatoryChargePricingSourceSnapshot,
} from "@vayada/domain-pms";
import { PROPERTY_SETUP_DRAFT_CONTRACT_VERSION } from "@vayada/domain-hotels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PricingDraftState } from "@/components/setup/adaptive/pricing/pricingState";
import { ApiErrorResponse } from "./client";
import {
  createPricingSetupClient,
  PricingOwnerError,
  type PricingSetupHttpClient,
} from "./pricingSetupClient";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomTypeId = "33333333-3333-4333-8333-333333333333";
const planId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-04T12:00:00.000Z";

const calls = vi.hoisted(() => ({
  get: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>(),
  put: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
  post: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
}));
const http: PricingSetupHttpClient = {
  get: ((endpoint: string, options?: RequestInit) =>
    endpoint.endsWith("/pricing-source/currency-capabilities")
      ? Promise.resolve(currencyCapabilities())
      : calls.get(endpoint, options)) as PricingSetupHttpClient["get"],
  put: calls.put as PricingSetupHttpClient["put"],
  post: calls.post as PricingSetupHttpClient["post"],
};

describe("pricingSetupClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads a first-visit workspace only when pricing and recurring evidence are both absent", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/mandatory-charge-confirmation")) throw missingConfirmation();
      throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
    });
    const client = createPricingSetupClient(http);

    await expect(client.loadWorkspace(organizationId, propertyId)).resolves.toMatchObject({
      rooms: [{ roomTypeId, roomFactsRevision: 3 }],
      pricing: null,
      recurringPricing: null,
      confirmation: null,
    });
  });

  it("fails closed when the currency capability owner returns malformed data", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/mandatory-charge-confirmation")) throw missingConfirmation();
      throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
    });
    const invalidCapabilityHttp: PricingSetupHttpClient = {
      ...http,
      get: ((endpoint: string, options?: RequestInit) =>
        endpoint.endsWith("/pricing-source/currency-capabilities")
          ? Promise.resolve({
              contractVersion: "pms-pricing-currency-capabilities.v1",
              supportedCurrencies: [{ code: "EUR", scale: 0 }],
            })
          : calls.get(endpoint, options)) as PricingSetupHttpClient["get"],
    };

    await expect(
      createPricingSetupClient(invalidCapabilityHttp).loadWorkspace(organizationId, propertyId),
    ).rejects.toMatchObject({ code: "owner_contract_violation", requiresRefresh: true });
  });

  it("does not reinterpret an unrelated pricing 404 as first-visit absence", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/mandatory-charge-confirmation")) throw missingConfirmation();
      throw new ApiErrorResponse(404, { code: "route_not_found" });
    });
    const client = createPricingSetupClient(http);

    await expect(client.loadWorkspace(organizationId, propertyId)).rejects.toMatchObject({
      status: 404,
      data: { code: "route_not_found" },
    });
  });

  it("rejects a 200 missing-confirmation result for another scope", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        return {
          outcome: "missing",
          organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          propertyId,
        };
      }
      throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
    });
    const client = createPricingSetupClient(http);

    await expect(client.loadWorkspace(organizationId, propertyId)).rejects.toMatchObject({
      code: "owner_contract_violation",
      requiresRefresh: true,
    });
  });

  it("fails closed when cross-owner pricing evidence disagrees", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/pricing-source")) return pricingSnapshot();
      if (endpoint.endsWith("/recurring-booking-evidence")) {
        return { ...recurringEvidence(), pricingCurrencyRevision: 8 };
      }
      throw missingConfirmation();
    });
    const client = createPricingSetupClient(http);

    await expect(client.loadWorkspace(organizationId, propertyId)).rejects.toMatchObject({
      code: "owner_contract_violation",
      requiresRefresh: true,
    });
  });

  it("fails closed when confirmation exists without a complete pricing source", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        return confirmationRead("a".repeat(64), 1);
      }
      throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
    });
    const client = createPricingSetupClient(http);

    await expect(client.loadWorkspace(organizationId, propertyId)).rejects.toMatchObject({
      code: "owner_contract_violation",
      requiresRefresh: true,
    });
  });

  it("retains a stale confirmation CAS revision and reconfirms the current source", async () => {
    let confirmedFingerprint: string | null = null;
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/pricing-source")) return pricingSnapshot();
      if (endpoint.endsWith("/recurring-booking-evidence")) return recurringEvidence();
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        return confirmationRead(
          confirmedFingerprint ?? "b".repeat(64),
          confirmedFingerprint ? 8 : 7,
        );
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    calls.put.mockImplementation(async (endpoint, data) => {
      if (!endpoint.endsWith("/mandatory-charge-confirmation")) {
        throw new Error(`Unexpected PUT ${endpoint}`);
      }
      const body = data as Record<string, unknown>;
      expect(body.expectedConfirmationRevision).toBe(7);
      confirmedFingerprint = body.claimedPricingSourceFingerprint as string;
      return {
        contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
        outcome: "confirmed",
        evidence: confirmationEvidence(confirmedFingerprint, 8),
        acceptedAt: now,
      };
    });
    const client = createPricingSetupClient(http);
    const current = await client.loadWorkspace(organizationId, propertyId);
    expect(current).toMatchObject({ confirmation: null, confirmationRevision: 7 });
    const intended = state();
    intended.rooms[0]!.baseAmountInput = "160,00";

    await expect(
      client.saveCanonical(organizationId, propertyId, intended, current, "de-DE"),
    ).resolves.toMatchObject({
      confirmationRevision: 8,
      confirmation: { confirmationRevision: 8 },
    });
  });

  it("rejects extra room-list envelope keys", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return { ...roomList(), unexpected: true };
      if (endpoint.endsWith("/mandatory-charge-confirmation")) throw missingConfirmation();
      throw new ApiErrorResponse(404, { code: "pricing_currency_not_configured" });
    });
    const client = createPricingSetupClient(http);

    await expect(client.loadWorkspace(organizationId, propertyId)).rejects.toMatchObject({
      code: "owner_contract_violation",
    });
  });

  it.each([
    { extra: true },
    { retentionExpiresAt: "2026-99-99T12:00:00.000Z" },
    { sessionId: "not-a-session" },
    { sessionId: "99999999-9999-4999-8999-999999999999" },
    { trackRevision: 2 },
    { sessionRevision: 3 },
    { draftRevision: 2 },
  ])("rejects malformed pricing draft receipts %#", async (receiptOverride) => {
    calls.put.mockResolvedValue({ ...draftReceipt(), ...receiptOverride });
    const client = createPricingSetupClient(http);

    await expect(
      client.saveDraft(propertyId, draftRequest(), organizationId),
    ).rejects.toMatchObject({
      code: "owner_contract_violation",
    });
  });

  it("binds resumed receipts to their session while accepting a valid first-visit session", async () => {
    calls.put.mockResolvedValue(draftReceipt());
    const client = createPricingSetupClient(http);

    await expect(
      client.saveDraft(propertyId, draftRequest(), organizationId),
    ).resolves.toMatchObject({ sessionId: organizationId });
    await expect(client.saveDraft(propertyId, draftRequest(), null)).resolves.toMatchObject({
      sessionId: organizationId,
    });
  });

  it("maps raw draft revision conflicts to refresh-required owner errors", async () => {
    calls.put.mockRejectedValue(
      new ApiErrorResponse(409, {
        code: "draft_revision_conflict",
        currentDraftRevision: 7,
      } as never),
    );
    const client = createPricingSetupClient(http);

    await expect(
      client.saveDraft(propertyId, draftRequest(), organizationId),
    ).rejects.toMatchObject({
      code: "draft_revision_conflict",
      requiresRefresh: true,
    });

    calls.put.mockRejectedValue(
      new ApiErrorResponse(409, {
        code: "draft_revision_conflict",
        currentDraftRevision: 2_147_483_648,
      } as never),
    );
    await expect(
      client.saveDraft(propertyId, draftRequest(), organizationId),
    ).rejects.toMatchObject({
      code: "owner_contract_violation",
    });
  });

  it.each([
    { status: 422, body: { code: "unsupported_pricing_currency", extra: true } },
    { status: 409, body: { code: "unsupported_pricing_currency" } },
    { status: 409, body: { code: "not_a_pricing_error" } },
  ])("fails closed for malformed pricing error envelopes %#", async ({ status, body }) => {
    calls.put.mockRejectedValue(new ApiErrorResponse(status, body));
    const intended = state();
    intended.currencyInput = "USD";

    await expect(
      createPricingSetupClient(http).saveCanonical(
        organizationId,
        propertyId,
        intended,
        workspace(),
        "de-DE",
      ),
    ).rejects.toMatchObject({ code: "owner_contract_violation", requiresRefresh: true });
  });

  it("creates a supported first-visit currency before scale-2 prices and confirmation", async () => {
    let confirmed = false;
    let savedPlan: ReturnType<typeof planSnapshot> | null = null;
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/pricing-source")) return firstVisitPricingSnapshot(savedPlan);
      if (endpoint.endsWith("/recurring-booking-evidence")) return recurringEvidence([], 0, 1);
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        if (!confirmed) throw missingConfirmation();
        return confirmationRead("a".repeat(64), 1);
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    calls.put.mockImplementation(async (endpoint, data) => {
      if (endpoint.endsWith("/pricing-source/currency")) {
        expect(data).toEqual({ expectedPricingCurrencyRevision: 0, currency: "EUR" });
        return {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          outcome: "created",
          pricingCurrency: firstVisitPricingSnapshot(null).pricingCurrency,
          acceptedAt: now,
        };
      }
      if (endpoint.endsWith("/flexible-rate-plan")) {
        const body = data as Record<string, unknown>;
        savedPlan = {
          ...planSnapshot(),
          flexibleRatePlanRevision: 1,
          baseAmount: { amountDecimal: body.baseAmountDecimal as string, currency: "EUR" },
        };
        return {
          contractVersion: PMS_PRICING_CONTRACT_VERSION,
          outcome: "updated",
          flexibleRatePlan: savedPlan,
          acceptedAt: now,
        };
      }
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        const body = data as Record<string, unknown>;
        confirmed = true;
        const fingerprint = body.claimedPricingSourceFingerprint as string;
        calls.get.mockImplementation(async (getEndpoint) => {
          if (getEndpoint.endsWith("/room-types")) return roomList();
          if (getEndpoint.endsWith("/pricing-source")) return firstVisitPricingSnapshot(savedPlan);
          if (getEndpoint.endsWith("/recurring-booking-evidence")) {
            return recurringEvidence([], 0, 1);
          }
          if (getEndpoint.endsWith("/mandatory-charge-confirmation")) {
            return confirmationRead(fingerprint, 1);
          }
          throw new Error(`Unexpected GET ${getEndpoint}`);
        });
        return {
          contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
          outcome: "confirmed",
          evidence: confirmationEvidence(fingerprint, 1),
          acceptedAt: now,
        };
      }
      throw new Error(`Unexpected PUT ${endpoint}`);
    });
    const client = createPricingSetupClient(http);
    const workspace = {
      currencyCapabilities: currencyCapabilities() as never,
      rooms: roomList().items as never,
      pricing: null,
      recurringPricing: null,
      confirmation: null,
      confirmationRevision: 0,
    };
    const intended = state();
    intended.pricingCurrencyRevision = 0;
    intended.rooms[0]!.flexibleRatePlanId = null;
    intended.rooms[0]!.flexibleRatePlanRevision = 0;

    await expect(
      client.saveCanonical(organizationId, propertyId, intended, workspace, "de-DE"),
    ).resolves.toMatchObject({ confirmation: { confirmationRevision: 1 } });

    const planCall = calls.put.mock.calls.find(([endpoint]) =>
      endpoint.endsWith("flexible-rate-plan"),
    );
    expect(planCall?.[1]).toMatchObject({
      expectedRoomFactsRevision: 3,
      expectedPricingCurrencyRevision: 1,
      expectedFlexibleRatePlanRevision: 0,
      baseAmountDecimal: "160.50",
    });
    const confirmationCall = calls.put.mock.calls.find(([endpoint]) =>
      endpoint.endsWith("mandatory-charge-confirmation"),
    );
    expect(confirmationCall?.[1]).toMatchObject({
      expectedConfirmationRevision: 0,
      expectedPricingSourceRevisions: {
        pricingCurrencyRevision: 1,
        optionalPricingAggregateRevision: 0,
        rooms: [{ roomTypeId, roomFactsRevision: 3 }],
      },
    });
    expect(new Headers(confirmationCall?.[2]?.headers).get("Idempotency-Key")).toMatch(
      /^mandatory-charge-confirmation:/,
    );
  });

  it("does not confirm a concurrently replaced refetch", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/pricing-source")) return pricingSnapshot();
      if (endpoint.endsWith("/recurring-booking-evidence")) return recurringEvidence();
      throw missingConfirmation();
    });
    calls.put.mockImplementation(async (endpoint, data) => {
      if (!endpoint.endsWith("/flexible-rate-plan")) {
        throw new Error(`Unexpected PUT ${endpoint}`);
      }
      return {
        contractVersion: PMS_PRICING_CONTRACT_VERSION,
        outcome: "updated",
        flexibleRatePlan: {
          ...planSnapshot(),
          flexibleRatePlanRevision: 5,
          baseAmount: {
            amountDecimal: (data as Record<string, unknown>).baseAmountDecimal,
            currency: "EUR",
          },
        },
        acceptedAt: now,
      };
    });
    const client = createPricingSetupClient(http);

    await expect(
      client.saveCanonical(organizationId, propertyId, state(), workspace(), "de-DE"),
    ).rejects.toMatchObject({ code: "pricing_source_conflict", requiresRefresh: true });
    expect(calls.put).not.toHaveBeenCalledWith(
      expect.stringContaining("mandatory-charge-confirmation"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("upserts an enabled recurring rule and verifies its returned revision before confirming", async () => {
    let savedPlan = planSnapshot();
    let recurring = recurringEvidence();
    let fingerprint: string | null = null;
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/pricing-source")) return pricingSnapshot(savedPlan);
      if (endpoint.endsWith("/recurring-booking-evidence")) return recurring;
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        if (!fingerprint) throw missingConfirmation();
        return confirmationRead(fingerprint, 1);
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    calls.put.mockImplementation(async (endpoint, data) => {
      const body = data as Record<string, unknown>;
      if (endpoint.endsWith("/flexible-rate-plan")) {
        savedPlan = {
          ...planSnapshot(),
          flexibleRatePlanRevision: 5,
          baseAmount: { amountDecimal: body.baseAmountDecimal as string, currency: "EUR" },
        };
        return flexiblePlanReceipt(savedPlan);
      }
      if (endpoint.includes("/pricing-source/recurring/")) {
        const source = weekendSource({
          sourceRevision: 1,
          flexibleRatePlanRevision: 5,
          amountDecimal: "10.00",
        });
        recurring = recurringEvidence([source], 1);
        return {
          contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
          outcome: "created",
          source,
          optionalPricingAggregateRevision: 1,
          acceptedAt: now,
        };
      }
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        fingerprint = body.claimedPricingSourceFingerprint as string;
        return {
          contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
          outcome: "confirmed",
          evidence: confirmationEvidence(fingerprint, 1),
          acceptedAt: now,
        };
      }
      throw new Error(`Unexpected PUT ${endpoint}`);
    });
    const intended = state();
    intended.weekendEnabled = true;
    intended.weekendSurcharges[roomTypeId] = "10,00";
    const client = createPricingSetupClient(http);

    await expect(
      client.saveCanonical(organizationId, propertyId, intended, workspace(), "de-DE"),
    ).resolves.toMatchObject({ confirmation: { confirmationRevision: 1 } });
    expect(
      calls.put.mock.calls.some(([endpoint]) => endpoint.includes("/pricing-source/recurring/")),
    ).toBe(true);
  });

  it("skips unchanged plans, recurring sources, and current confirmation", async () => {
    const recurring = recurringEvidence(
      [weekendSource({ sourceRevision: 1, flexibleRatePlanRevision: 4, amountDecimal: "10.00" })],
      1,
    );
    const source = createPmsMandatoryChargePricingSourceSnapshot({
      rooms: [
        {
          roomTypeId,
          roomFactsRevision: 3,
          occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
        },
      ],
      pricing: pricingSnapshot() as never,
      recurringPricing: recurring as never,
    });
    const currentFingerprint = await sha256(source.serializedPayload);
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith("/pricing-source")) return pricingSnapshot();
      if (endpoint.endsWith("/recurring-booking-evidence")) return recurring;
      if (endpoint.endsWith("/mandatory-charge-confirmation")) {
        return confirmationRead(currentFingerprint, 2);
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    const client = createPricingSetupClient(http);
    const current = await client.loadWorkspace(organizationId, propertyId);
    const intended = state();
    intended.rooms[0]!.baseAmountInput = "160,00";
    intended.weekendEnabled = true;
    intended.weekendSourceRevision = 1;
    intended.weekendSurcharges[roomTypeId] = "10,00";
    intended.confirmationRevision = 2;

    await expect(
      client.saveCanonical(organizationId, propertyId, intended, current, "de-DE"),
    ).resolves.toMatchObject({ confirmation: { confirmationRevision: 2 } });
    expect(calls.put).not.toHaveBeenCalled();
    expect(calls.post).not.toHaveBeenCalled();
  });

  it("maps stale owner responses without losing refresh semantics", async () => {
    calls.put.mockRejectedValue(
      new ApiErrorResponse(409, { code: "flexible_rate_plan_revision_conflict" }),
    );
    const client = createPricingSetupClient(http);

    await expect(
      client.saveCanonical(
        organizationId,
        propertyId,
        state(),
        {
          currencyCapabilities: currencyCapabilities() as never,
          rooms: roomList().items as never,
          pricing: pricingSnapshot() as never,
          recurringPricing: recurringEvidence() as never,
          confirmation: null,
          confirmationRevision: 0,
        },
        "de-DE",
      ),
    ).rejects.toBeInstanceOf(PricingOwnerError);
  });
});

function state(): PricingDraftState {
  return {
    currencyInput: "EUR",
    pricingCurrencyRevision: 2,
    freeCancellationDeadlineDaysInput: "7",
    nonRefundableEnabled: false,
    nonRefundableDiscountInput: "10",
    nonRefundableSourceId: "55555555-5555-4555-8555-555555555555",
    nonRefundableSourceRevision: 0,
    rooms: [
      {
        roomTypeId,
        name: "Garden Suite",
        maximumAdults: 2,
        roomFactsRevision: 3,
        flexibleRatePlanId: planId,
        flexibleRatePlanRevision: 4,
        baseAmountInput: "160,50",
        additionalGuestEnabled: false,
        includedGuestsInput: "",
        additionalGuestAmountInput: "",
        additionalGuestSourceId: "66666666-6666-4666-8666-666666666666",
        additionalGuestSourceRevision: 0,
      },
    ],
    seasons: [],
    weekendEnabled: false,
    weekendSourceId: "77777777-7777-4777-8777-777777777777",
    weekendSourceRevision: 0,
    weekendDays: ["friday", "saturday"],
    weekendSurcharges: { [roomTypeId]: "0,00" },
    mandatoryChargesAcknowledged: true,
    confirmationRevision: 0,
    dirty: true,
  };
}

function roomList() {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    items: [
      {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomFactsRevision: 3,
        lifecycle: "active",
        facts: {
          name: "Garden Suite",
          description: "A quiet suite.",
          category: "suite",
          occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 1 },
          beds: [{ type: "king", quantity: 1 }],
          bedrooms: 1,
          bathrooms: 1,
          bathroomType: "private",
          size: { value: 30, unit: "sqm" },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function planSnapshot() {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    flexibleRatePlanId: planId,
    flexibleRatePlanRevision: 4,
    sourceRoomFactsRevision: 3,
    baseAmount: { amountDecimal: "160.00", currency: "EUR" },
    cancellationTerms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function pricingSnapshot(plan = planSnapshot()) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrency: {
      contractVersion: PMS_PRICING_CONTRACT_VERSION,
      propertyId,
      currency: "EUR",
      pricingCurrencyRevision: 2,
      createdAt: now,
      updatedAt: now,
    },
    flexibleRatePlans: [plan],
    capturedAt: now,
  };
}

function firstVisitPricingSnapshot(plan: ReturnType<typeof planSnapshot> | null) {
  return {
    ...pricingSnapshot(),
    pricingCurrency: {
      ...pricingSnapshot().pricingCurrency,
      pricingCurrencyRevision: 1,
    },
    flexibleRatePlans: plan ? [plan] : [],
  };
}

function flexiblePlanReceipt(plan: ReturnType<typeof planSnapshot>) {
  return {
    contractVersion: PMS_PRICING_CONTRACT_VERSION,
    outcome: "updated",
    flexibleRatePlan: plan,
    acceptedAt: now,
  };
}

function workspace() {
  return {
    currencyCapabilities: currencyCapabilities() as never,
    rooms: roomList().items as never,
    pricing: pricingSnapshot() as never,
    recurringPricing: recurringEvidence() as never,
    confirmation: null,
    confirmationRevision: 0,
  };
}

function currencyCapabilities() {
  return {
    contractVersion: "pms-pricing-currency-capabilities.v1",
    supportedCurrencies: [
      { code: "EUR", scale: 2 },
      { code: "USD", scale: 2 },
    ],
  };
}

function draftRequest() {
  return {
    stepId: "pricing",
    payload: {},
    dirtyFields: [],
    expectedBaseRevisions: {
      "pms.pricing_settings": "pricing:2",
      "pms.rate_plans": "plans:4",
      "pms.rate_rules": "rules:0",
    },
    expectedTrackRevision: 1,
    expectedSessionRevision: 1,
    expectedDraftRevision: 0,
  } as never;
}

function draftReceipt() {
  return {
    contractVersion: PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
    sessionId: organizationId,
    stepId: "pricing",
    selectedTracks: ["hotel_operations"],
    trackRevision: 1,
    sessionRevision: 2,
    draftRevision: 1,
    retentionExpiresAt: now,
    updatedAt: now,
    replayed: false,
  };
}

function recurringEvidence(
  sources: unknown[] = [],
  optionalPricingAggregateRevision = 0,
  pricingCurrencyRevision = 2,
) {
  return {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId,
    pricingCurrencyRevision,
    optionalPricingAggregateRevision,
    currency: "EUR",
    sources,
    capturedAt: now,
  };
}

function weekendSource({
  sourceRevision,
  flexibleRatePlanRevision,
  amountDecimal,
}: {
  sourceRevision: number;
  flexibleRatePlanRevision: number;
  amountDecimal: string;
}) {
  return {
    contractVersion: PMS_RECURRING_PRICING_CONTRACT_VERSION,
    propertyId,
    sourceId: "77777777-7777-4777-8777-777777777777",
    sourceRevision,
    pricingCurrencyRevision: 2,
    currency: "EUR",
    configuredState: "active",
    validation: { state: "valid", validationRevision: 1, validatedAt: now },
    lifecycle: "active",
    materializationRevision: 0,
    createdAt: now,
    updatedAt: now,
    sourceKind: "weekend_surcharge",
    weekdays: ["friday", "saturday"],
    roomSurcharges: [
      {
        roomTypeId,
        roomFactsRevision: 3,
        flexibleRatePlanId: planId,
        flexibleRatePlanRevision,
        amountDecimal,
      },
    ],
  };
}

function missingConfirmation() {
  const error = new ApiErrorResponse(404, {});
  Object.assign(error.data, { outcome: "missing", organizationId, propertyId });
  return error;
}

function confirmationEvidence(fingerprint: string, revision: number) {
  return {
    organizationId,
    propertyId,
    pricingSourceFingerprint: fingerprint,
    confirmationRevision: revision,
    confirmedAt: now,
  };
}

function confirmationRead(fingerprint: string, revision: number) {
  return {
    outcome: "available",
    organizationId,
    propertyId,
    evidence: confirmationEvidence(fingerprint, revision),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
