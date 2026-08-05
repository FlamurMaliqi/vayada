import { describe, expect, it } from "vitest";

import {
  PRICING_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE,
  buildPricingDraftRequest,
  discountedDecimal,
  hydratePricingDraft,
  normalizeMoneyInput,
  validatePricingDraft,
  type PricingDraftState,
} from "./pricingState";

const roomTypeId = "22222222-2222-4222-8222-222222222222";
const currencyCapabilities = {
  contractVersion: "pms-pricing-currency-capabilities.v1",
  supportedCurrencies: [{ code: "EUR", scale: 2 }],
} as never;

describe("pricing state", () => {
  it("normalizes locale-aware money without floating-point conversion", () => {
    expect(normalizeMoneyInput("1.234,5", "de-DE", false)).toBe("1234.50");
    expect(normalizeMoneyInput("1.234,56", "de-DE", false)).toBe("1234.56");
    expect(normalizeMoneyInput("1234.56", "de-DE", false)).toBe("1234.56");
    expect(normalizeMoneyInput("1,234.50", "en-US", false)).toBe("1234.50");
    expect(normalizeMoneyInput("1234,56", "en-US", false)).toBeNull();
    expect(normalizeMoneyInput("1.234.56", "de-DE", false)).toBeNull();
    expect(normalizeMoneyInput("1,23.45", "en-US", false)).toBeNull();
    expect(normalizeMoneyInput("12,345", "de-DE", false)).toBeNull();
    expect(normalizeMoneyInput("0,00", "de-DE", false)).toBeNull();
    expect(normalizeMoneyInput("0,00", "de-DE", true)).toBe("0.00");
    expect(normalizeMoneyInput("12,345", "en-US", false)).toBe("12345.00");
    expect(normalizeMoneyInput("12.345", "de-DE", false)).toBe("12345.00");
    expect(normalizeMoneyInput("12,345", "en-US", false)).toBe("12345.00");
    expect(normalizeMoneyInput("12.345", "en-US", false)).toBeNull();
    expect(normalizeMoneyInput("12345678901234.00", "en-US", false)).toBeNull();
  });

  it("derives non-refundable previews with integer minor-unit half-up rounding", () => {
    expect(discountedDecimal("160.00", 10)).toBe("144.00");
    expect(discountedDecimal("0.05", 10)).toBe("0.05");
    expect(discountedDecimal("0.05", 50)).toBe("0.03");
  });

  it("validates complete recurring configuration and annual overlaps", () => {
    const state = completeState();
    state.seasons = [season("Summer", "06-01", "09-01"), season("Late summer", "08-20", "10-01")];
    const errors = validatePricingDraft(state, "de-DE");
    expect(errors["season.1.dates"]).toMatch(/overlaps/i);

    state.seasons[1]!.startMonthDay = "10-02";
    state.seasons[1]!.endMonthDay = "11-01";
    expect(validatePricingDraft(state, "de-DE")).toEqual({});
  });

  it("enforces the shared-draft and PMS intersection for seasons", () => {
    const state = completeState();
    state.seasons = [season(" Summer", "02-29", "03-10")];
    let errors = validatePricingDraft(state, "de-DE");
    expect(errors["season.0.name"]).toMatch(/1–100 characters/i);
    expect(errors["season.0.start"]).toMatch(/valid start/i);

    state.seasons = Array.from({ length: 25 }, (_, index) =>
      season(`Season ${index}`, "01-01", "01-01"),
    );
    errors = validatePricingDraft(state, "de-DE");
    expect(errors.seasons).toMatch(/no more than 24/i);
  });

  it("builds the exact Step 5 draft payload and refuses missing manifests", () => {
    const state = completeState();
    const request = buildPricingDraftRequest(
      state,
      {
        sessionId: "33333333-3333-4333-8333-333333333333",
        trackRevision: 2,
        sessionRevision: 4,
        draftRevision: 1,
        baseRevisions: {
          "pms.pricing_settings": "pricing:3",
          "pms.rate_plans": "plans:4",
          "pms.rate_rules": "rules:5",
        },
      },
      "de-DE",
    );

    expect(request).toMatchObject({
      stepId: "pricing",
      expectedBaseRevisions: {
        "pms.pricing_settings": "pricing:3",
        "pms.rate_plans": "plans:4",
        "pms.rate_rules": "rules:5",
      },
      payload: {
        "rate.currency": "EUR",
        "rate.base_nightly_rate": { [roomTypeId]: "160.00" },
        "rate.occupancy_prices": {
          [roomTypeId]: { includedGuests: 1, additionalGuestAmount: "25.00" },
        },
      },
    });

    expect(() =>
      buildPricingDraftRequest(
        state,
        {
          sessionId: null,
          trackRevision: 0,
          sessionRevision: 0,
          draftRevision: 0,
          baseRevisions: null,
        },
        "de-DE",
      ),
    ).toThrow(PRICING_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE);
  });

  it("treats an explicit empty season draft as authoritative", () => {
    const hydrated = hydratePricingDraft(
      {
        stepId: "pricing",
        payload: { "rate.seasons": [] },
      } as never,
      {
        currencyCapabilities,
        rooms: [roomSnapshot(roomTypeId, 2)] as never,
        pricing: pricingSnapshot([planSnapshot(roomTypeId, 7)]) as never,
        recurringPricing: {
          sources: [
            {
              sourceKind: "season",
              configuredState: "active",
              sourceId: "77777777-7777-4777-8777-777777777777",
              sourceRevision: 1,
              name: "Summer",
              startMonthDay: "06-01",
              endMonthDay: "09-01",
              roomPrices: [{ roomTypeId, amountDecimal: "190.00" }],
            },
          ],
        } as never,
        confirmation: null,
        confirmationRevision: 0,
      },
      () => "88888888-8888-4888-8888-888888888888",
    );

    expect(hydrated.seasons).toEqual([]);
  });

  it("does not invent a cancellation default when saved room plans disagree", () => {
    const secondRoomId = "99999999-9999-4999-8999-999999999999";
    const hydrated = hydratePricingDraft(
      null,
      {
        currencyCapabilities,
        rooms: [roomSnapshot(roomTypeId, 2), roomSnapshot(secondRoomId, 2)] as never,
        pricing: pricingSnapshot([
          planSnapshot(roomTypeId, 7),
          planSnapshot(secondRoomId, 14),
        ]) as never,
        recurringPricing: { sources: [] } as never,
        confirmation: null,
        confirmationRevision: 0,
      },
      () => "88888888-8888-4888-8888-888888888888",
    );

    expect(hydrated.freeCancellationDeadlineDaysInput).toBe("");
  });

  it("preserves explicitly cleared draft amounts and disabled occupancy pricing", () => {
    const seasonId = "77777777-7777-4777-8777-777777777777";
    const hydrated = hydratePricingDraft(
      {
        stepId: "pricing",
        payload: {
          "rate.base_nightly_rate": { [roomTypeId]: null },
          "rate.occupancy_prices": {},
          "rate.seasons": [
            { id: seasonId, name: "Summer", startMonthDay: "06-01", endMonthDay: "09-01" },
          ],
          "rate.seasonal_prices": { [seasonId]: { [roomTypeId]: null } },
          "rate.weekend_days": ["friday"],
          "rate.weekend_surcharge": {},
        },
      } as never,
      {
        currencyCapabilities,
        rooms: [roomSnapshot(roomTypeId, 2)] as never,
        pricing: pricingSnapshot([planSnapshot(roomTypeId, 7)]) as never,
        recurringPricing: {
          sources: [
            {
              sourceKind: "season",
              configuredState: "active",
              sourceId: seasonId,
              sourceRevision: 1,
              name: "Summer",
              startMonthDay: "06-01",
              endMonthDay: "09-01",
              roomPrices: [{ roomTypeId, amountDecimal: "190.00" }],
            },
            {
              sourceKind: "additional_guest",
              configuredState: "active",
              lifecycle: "active",
              sourceId: "88888888-8888-4888-8888-888888888888",
              sourceRevision: 1,
              roomTypeId,
              includedGuests: 1,
              amountDecimal: "25.00",
            },
            {
              sourceKind: "weekend_surcharge",
              configuredState: "active",
              sourceId: "99999999-9999-4999-8999-999999999999",
              sourceRevision: 1,
              weekdays: ["friday"],
              roomSurcharges: [{ roomTypeId, amountDecimal: "10.00" }],
            },
          ],
        } as never,
        confirmation: null,
        confirmationRevision: 0,
      },
    );

    expect(hydrated.rooms[0]).toMatchObject({
      baseAmountInput: "",
      additionalGuestEnabled: false,
    });
    expect(hydrated.seasons[0]?.roomPrices[roomTypeId]).toBe("");
    expect(hydrated.weekendSurcharges[roomTypeId]).toBe("");
  });

  it("clears a resumed acknowledgement when its owner confirmation fingerprint is stale", () => {
    const hydrated = hydratePricingDraft(
      {
        stepId: "pricing",
        payload: { "rate.mandatory_charges_acknowledged": true },
      } as never,
      {
        currencyCapabilities,
        rooms: [roomSnapshot(roomTypeId, 2)] as never,
        pricing: pricingSnapshot([planSnapshot(roomTypeId, 7)]) as never,
        recurringPricing: { sources: [] } as never,
        confirmation: null,
        confirmationRevision: 7,
      },
    );

    expect(hydrated.mandatoryChargesAcknowledged).toBe(false);
    expect(hydrated.confirmationRevision).toBe(7);
  });
});

function completeState(): PricingDraftState {
  return {
    currencyInput: "EUR",
    pricingCurrencyRevision: 0,
    freeCancellationDeadlineDaysInput: "7",
    nonRefundableEnabled: true,
    nonRefundableDiscountInput: "10",
    nonRefundableSourceId: "44444444-4444-4444-8444-444444444444",
    nonRefundableSourceRevision: 0,
    rooms: [
      {
        roomTypeId,
        name: "Garden Suite",
        maximumAdults: 2,
        roomFactsRevision: 1,
        flexibleRatePlanId: null,
        flexibleRatePlanRevision: 0,
        baseAmountInput: "160,00",
        additionalGuestEnabled: true,
        includedGuestsInput: "1",
        additionalGuestAmountInput: "25,00",
        additionalGuestSourceId: "55555555-5555-4555-8555-555555555555",
        additionalGuestSourceRevision: 0,
      },
    ],
    seasons: [],
    weekendEnabled: true,
    weekendSourceId: "66666666-6666-4666-8666-666666666666",
    weekendSourceRevision: 0,
    weekendDays: ["friday", "saturday"],
    weekendSurcharges: { [roomTypeId]: "10,00" },
    mandatoryChargesAcknowledged: true,
    confirmationRevision: 0,
    dirty: true,
  };
}

function season(name: string, startMonthDay: string, endMonthDay: string) {
  return {
    sourceId: crypto.randomUUID(),
    sourceRevision: 0,
    name,
    startMonthDay,
    endMonthDay,
    roomPrices: { [roomTypeId]: "180.00" },
  };
}

function roomSnapshot(id: string, maxAdults: number) {
  return {
    roomTypeId: id,
    roomFactsRevision: 1,
    lifecycle: "active",
    facts: { name: "Garden Suite", occupancy: { maxAdults } },
  };
}

function planSnapshot(id: string, freeCancellationDeadlineDays: number) {
  return {
    roomTypeId: id,
    flexibleRatePlanId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    flexibleRatePlanRevision: 1,
    baseAmount: { amountDecimal: "160.00" },
    cancellationTerms: { freeCancellationDeadlineDays },
  };
}

function pricingSnapshot(flexibleRatePlans: unknown[]) {
  return {
    pricingCurrency: { currency: "EUR", pricingCurrencyRevision: 1 },
    flexibleRatePlans,
  };
}
