import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsMandatoryChargePricingSourceSnapshot,
  parseConfirmMandatoryChargesIncludedResult,
  parseFlexibleRatePlanCommandResult,
  parsePmsMandatoryChargeConfirmationReadResult,
  parsePmsMandatoryChargePricingSourceFingerprint,
  parsePmsPricingCurrencyCapabilities,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  parsePmsRecurringPricingCommandResult,
  parseRoomTypeFactsSnapshot,
  parsePropertyPricingCurrencyCommandResult,
  type FlexibleRatePlanSnapshot,
  type FlexibleRatePlanCommandError,
  type PmsMandatoryChargeConfirmationCommandError,
  type PmsRecurringPricingCommandError,
  type PmsRecurringPricingSourceSnapshot,
  type PropertyPricingCurrencyCommandError,
  type RoomTypeFactsSnapshot,
} from "@vayada/domain-pms";
import {
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  isSetupTrack,
  type SavePropertySetupDraftError,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";

import {
  normalizeMoneyInput,
  type PricingCanonicalWorkspace,
  type PricingDraftState,
} from "@/components/setup/adaptive/pricing/pricingState";
import { ApiErrorResponse } from "./client";
import { targetApiClient } from "./targetClient";

export type PricingSetupHttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export type PricingSetupClient = {
  loadWorkspace(
    organizationId: string,
    propertyId: string,
    options?: RequestInit,
  ): Promise<PricingCanonicalWorkspace>;
  saveDraft(
    propertyId: string,
    request: Extract<SavePropertySetupDraftRequest, { stepId: "pricing" }>,
  ): Promise<SavePropertySetupDraftReceipt>;
  saveCanonical(
    organizationId: string,
    propertyId: string,
    state: PricingDraftState,
    workspace: PricingCanonicalWorkspace,
    locale: string,
  ): Promise<PricingCanonicalWorkspace>;
};

export class PricingOwnerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: unknown,
    readonly requiresRefresh: boolean,
  ) {
    super(message);
    this.name = "PricingOwnerError";
  }
}

export function createPricingSetupClient(http: PricingSetupHttpClient): PricingSetupClient {
  const loadWorkspace = async (
    organizationId: string,
    propertyId: string,
    options?: RequestInit,
  ): Promise<PricingCanonicalWorkspace> => {
    const [capabilitiesValue, roomValue, pricingValue, recurringValue, confirmationValue] =
      await Promise.all([
        http.get<unknown>(
          `/api/pms/properties/${encodeURIComponent(propertyId)}/pricing-source/currency-capabilities`,
          options,
        ),
        http.get<unknown>(
          `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types`,
          options,
        ),
        optionalGet(
          http,
          `/api/pms/properties/${encodeURIComponent(propertyId)}/pricing-source`,
          "pricing_currency_not_configured",
          options,
        ),
        optionalGet(
          http,
          `/api/pms/properties/${encodeURIComponent(propertyId)}/pricing-source/recurring-booking-evidence`,
          "pricing_currency_not_configured",
          options,
        ),
        confirmationGet(http, organizationId, propertyId, options),
      ]);
    const currencyCapabilities = parsePmsPricingCurrencyCapabilities(capabilitiesValue);
    const rooms = parseRoomList(roomValue, propertyId);
    const pricing = pricingValue === null ? null : parsePmsPricingSourceSnapshot(pricingValue);
    const recurringPricing =
      recurringValue === null ? null : parsePmsRecurringPricingBookingEvidence(recurringValue);
    if (
      !currencyCapabilities ||
      !rooms ||
      (pricingValue !== null && (!pricing || pricing.propertyId !== propertyId.toLowerCase())) ||
      (recurringValue !== null &&
        (!recurringPricing || recurringPricing.propertyId !== propertyId.toLowerCase())) ||
      (pricing === null) !== (recurringPricing === null) ||
      (pricing &&
        recurringPricing &&
        (pricing.pricingCurrency.pricingCurrencyRevision !==
          recurringPricing.pricingCurrencyRevision ||
          pricing.pricingCurrency.currency !== recurringPricing.currency)) ||
      ((!pricing || !recurringPricing) && confirmationValue !== null)
    ) {
      throw invalidOwnerContract("pricing workspace");
    }
    let confirmation = confirmationValue;
    const confirmationRevision = confirmationValue?.confirmationRevision ?? 0;
    if (pricing && recurringPricing && confirmation) {
      const source = createPmsMandatoryChargePricingSourceSnapshot({
        rooms: rooms
          .filter(({ lifecycle }) => lifecycle === "active")
          .map((room) => ({
            roomTypeId: room.roomTypeId,
            roomFactsRevision: room.roomFactsRevision,
            occupancy: room.facts.occupancy,
          })),
        pricing,
        recurringPricing,
      });
      const currentFingerprint = await sha256Hex(
        new TextEncoder().encode(source.serializedPayload),
      );
      if (confirmation.pricingSourceFingerprint !== currentFingerprint) confirmation = null;
    }
    return {
      currencyCapabilities,
      rooms,
      pricing,
      recurringPricing,
      confirmation,
      confirmationRevision,
    };
  };

  return {
    loadWorkspace,
    async saveDraft(propertyId, request) {
      const value = await ownerPut(
        http,
        `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/setup-drafts/pricing`,
        request,
        await commandKey("pricing-draft", propertyId, request),
        "draft",
      );
      const receipt = parseDraftReceipt(value, request);
      if (!receipt) throw invalidOwnerContract("pricing draft receipt");
      return receipt;
    },
    async saveCanonical(organizationId, propertyId, state, workspace, locale) {
      let activeWorkspace = workspace;
      let pricing = activeWorkspace.pricing;
      const requestedCurrency = state.currencyInput.toUpperCase();
      if (
        !activeWorkspace.currencyCapabilities.supportedCurrencies.some(
          ({ code }) => code === requestedCurrency,
        )
      ) {
        throw new PricingOwnerError(
          "That currency is not supported end to end yet.",
          "unsupported_pricing_currency",
          null,
          false,
        );
      }
      if (!pricing || pricing.pricingCurrency.currency !== requestedCurrency) {
        const body = {
          expectedPricingCurrencyRevision:
            pricing?.pricingCurrency.pricingCurrencyRevision ?? state.pricingCurrencyRevision,
          currency: requestedCurrency,
        };
        const value = await ownerPut(
          http,
          `/api/pms/properties/${encodeURIComponent(propertyId)}/pricing-source/currency`,
          body,
          await commandKey("pricing-currency", propertyId, body),
          "currency",
        );
        const result = parsePropertyPricingCurrencyCommandResult({ ok: true, response: value });
        if (
          !result?.ok ||
          result.response.pricingCurrency.propertyId !== propertyId.toLowerCase() ||
          result.response.pricingCurrency.currency !== requestedCurrency
        ) {
          throw invalidOwnerContract("pricing currency receipt");
        }
        activeWorkspace = await loadWorkspace(organizationId, propertyId, { cache: "no-store" });
        pricing = activeWorkspace.pricing;
      }
      if (
        !pricing ||
        !activeWorkspace.recurringPricing ||
        pricing.pricingCurrency.currency !== requestedCurrency
      ) {
        throw refreshRequiredConflict();
      }
      const currencyRevision = pricing.pricingCurrency.pricingCurrencyRevision;
      const plans = new Map(pricing.flexibleRatePlans.map((plan) => [plan.roomTypeId, plan]));
      for (const room of state.rooms) {
        const currentPlan = plans.get(room.roomTypeId);
        const baseAmountDecimal = requiredMoney(room.baseAmountInput, locale, false);
        const freeCancellationDeadlineDays = Number(state.freeCancellationDeadlineDaysInput);
        const body = {
          expectedRoomFactsRevision: room.roomFactsRevision,
          expectedPricingCurrencyRevision: currencyRevision,
          expectedFlexibleRatePlanRevision:
            currentPlan?.flexibleRatePlanRevision ?? room.flexibleRatePlanRevision,
          baseAmountDecimal,
          cancellationTerms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
        } as const;
        if (
          currentPlan &&
          flexiblePlanMatches(
            currentPlan,
            room.roomFactsRevision,
            requestedCurrency,
            baseAmountDecimal,
            freeCancellationDeadlineDays,
          )
        ) {
          continue;
        }
        const value = await ownerPut(
          http,
          `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(room.roomTypeId)}/flexible-rate-plan`,
          body,
          await commandKey("flexible-rate-plan", propertyId, {
            roomTypeId: room.roomTypeId,
            ...body,
          }),
          "plan",
        );
        const result = parseFlexibleRatePlanCommandResult({ ok: true, response: value });
        if (
          !result?.ok ||
          result.response.flexibleRatePlan.propertyId !== propertyId.toLowerCase() ||
          result.response.flexibleRatePlan.roomTypeId !== room.roomTypeId
        ) {
          throw invalidOwnerContract("flexible rate plan receipt");
        }
        plans.set(room.roomTypeId, result.response.flexibleRatePlan);
      }

      const roomEvidence = state.rooms
        .map((room) => {
          const plan = plans.get(room.roomTypeId);
          if (!plan) throw invalidOwnerContract("complete flexible rate plan evidence");
          return {
            roomTypeId: room.roomTypeId,
            expectedRoomFactsRevision: room.roomFactsRevision,
            flexibleRatePlanId: plan.flexibleRatePlanId,
            expectedFlexibleRatePlanRevision: plan.flexibleRatePlanRevision,
          };
        })
        .sort((left, right) => codeUnitCompare(left.roomTypeId, right.roomTypeId));
      const desiredIds = new Set<string>();
      const desiredBodies = new Map<string, Record<string, unknown>>();
      const expectedSources = new Map<string, PmsRecurringPricingSourceSnapshot>();
      const existingSources = new Map(
        activeWorkspace.recurringPricing.sources.map((source) => [source.sourceId, source]),
      );
      let expectedAggregateRevision =
        activeWorkspace.recurringPricing.optionalPricingAggregateRevision;
      for (const season of state.seasons) {
        desiredIds.add(season.sourceId);
        const body = {
          sourceKind: "season",
          expectedSourceRevision: season.sourceRevision,
          expectedPricingCurrencyRevision: currencyRevision,
          name: season.name.trim(),
          startMonthDay: season.startMonthDay,
          endMonthDay: season.endMonthDay,
          roomPrices: roomEvidence.map((evidence) => ({
            ...evidence,
            amountDecimal: requiredMoney(
              season.roomPrices[evidence.roomTypeId] ?? "",
              locale,
              false,
            ),
          })),
        } as const;
        desiredBodies.set(season.sourceId, body);
        const existing = existingSources.get(season.sourceId);
        if (existing && recurringMatches(existing, body)) {
          expectedSources.set(season.sourceId, existing);
        } else {
          const result = await upsertRecurring(http, propertyId, season.sourceId, body);
          expectedSources.set(season.sourceId, result.source);
          expectedAggregateRevision = result.optionalPricingAggregateRevision;
        }
      }
      if (state.weekendEnabled) {
        desiredIds.add(state.weekendSourceId);
        const body = {
          sourceKind: "weekend_surcharge",
          expectedSourceRevision: state.weekendSourceRevision,
          expectedPricingCurrencyRevision: currencyRevision,
          weekdays: state.weekendDays,
          roomSurcharges: roomEvidence.map((evidence) => ({
            ...evidence,
            amountDecimal: requiredMoney(
              state.weekendSurcharges[evidence.roomTypeId] ?? "",
              locale,
              true,
            ),
          })),
        } as const;
        desiredBodies.set(state.weekendSourceId, body);
        const existing = existingSources.get(state.weekendSourceId);
        if (existing && recurringMatches(existing, body)) {
          expectedSources.set(state.weekendSourceId, existing);
        } else {
          const result = await upsertRecurring(http, propertyId, state.weekendSourceId, body);
          expectedSources.set(state.weekendSourceId, result.source);
          expectedAggregateRevision = result.optionalPricingAggregateRevision;
        }
      }
      for (const room of state.rooms.filter(
        ({ additionalGuestEnabled }) => additionalGuestEnabled,
      )) {
        const evidence = roomEvidence.find(({ roomTypeId }) => roomTypeId === room.roomTypeId)!;
        desiredIds.add(room.additionalGuestSourceId);
        const body = {
          sourceKind: "additional_guest",
          expectedSourceRevision: room.additionalGuestSourceRevision,
          expectedPricingCurrencyRevision: currencyRevision,
          ...evidence,
          includedGuests: Number(room.includedGuestsInput),
          amountDecimal: requiredMoney(room.additionalGuestAmountInput, locale, true),
        } as const;
        desiredBodies.set(room.additionalGuestSourceId, body);
        const existing = existingSources.get(room.additionalGuestSourceId);
        if (existing && recurringMatches(existing, body)) {
          expectedSources.set(room.additionalGuestSourceId, existing);
        } else {
          const result = await upsertRecurring(
            http,
            propertyId,
            room.additionalGuestSourceId,
            body,
          );
          expectedSources.set(room.additionalGuestSourceId, result.source);
          expectedAggregateRevision = result.optionalPricingAggregateRevision;
        }
      }
      if (state.nonRefundableEnabled) {
        desiredIds.add(state.nonRefundableSourceId);
        const body = {
          sourceKind: "non_refundable",
          expectedSourceRevision: state.nonRefundableSourceRevision,
          expectedPricingCurrencyRevision: currencyRevision,
          discountPercent: Number(state.nonRefundableDiscountInput),
          roomPlans: roomEvidence,
        } as const;
        desiredBodies.set(state.nonRefundableSourceId, body);
        const existing = existingSources.get(state.nonRefundableSourceId);
        if (existing && recurringMatches(existing, body)) {
          expectedSources.set(state.nonRefundableSourceId, existing);
        } else {
          const result = await upsertRecurring(http, propertyId, state.nonRefundableSourceId, body);
          expectedSources.set(state.nonRefundableSourceId, result.source);
          expectedAggregateRevision = result.optionalPricingAggregateRevision;
        }
      }

      for (const source of activeWorkspace.recurringPricing.sources) {
        if (source.configuredState === "active" && !desiredIds.has(source.sourceId)) {
          const result = await disableRecurring(http, propertyId, source);
          expectedSources.set(source.sourceId, result.source);
          expectedAggregateRevision = result.optionalPricingAggregateRevision;
        }
      }

      const current = await loadWorkspace(organizationId, propertyId, { cache: "no-store" });
      if (!current.pricing || !current.recurringPricing) {
        throw invalidOwnerContract("mandatory-charge source manifest");
      }
      assertRefetchedPricingMatches(
        current,
        state,
        locale,
        plans,
        desiredIds,
        desiredBodies,
        expectedSources,
        expectedAggregateRevision,
      );
      const source = createPmsMandatoryChargePricingSourceSnapshot({
        rooms: current.rooms
          .filter(({ lifecycle }) => lifecycle === "active")
          .map((room) => ({
            roomTypeId: room.roomTypeId,
            roomFactsRevision: room.roomFactsRevision,
            occupancy: room.facts.occupancy,
          })),
        pricing: current.pricing,
        recurringPricing: current.recurringPricing,
      });
      const fingerprint = parsePmsMandatoryChargePricingSourceFingerprint(
        await sha256Hex(new TextEncoder().encode(source.serializedPayload)),
      );
      if (!fingerprint) throw invalidOwnerContract("mandatory-charge fingerprint");
      if (current.confirmation?.pricingSourceFingerprint === fingerprint) return current;
      const confirmationBody = {
        expectedConfirmationRevision: current.confirmationRevision,
        claimedPricingSourceFingerprint: fingerprint,
        expectedPricingSourceRevisions: source.sourceRevisions,
      };
      const confirmationValue = await ownerPut(
        http,
        `/api/pms/properties/${encodeURIComponent(propertyId)}/mandatory-charge-confirmation`,
        confirmationBody,
        await commandKey("mandatory-charge-confirmation", propertyId, confirmationBody),
        "confirmation",
      );
      const confirmationResult = parseConfirmMandatoryChargesIncludedResult({
        ok: true,
        response: confirmationValue,
      });
      if (
        !confirmationResult?.ok ||
        confirmationResult.response.evidence.organizationId !== organizationId.toLowerCase() ||
        confirmationResult.response.evidence.propertyId !== propertyId.toLowerCase() ||
        confirmationResult.response.evidence.pricingSourceFingerprint !== fingerprint
      ) {
        throw invalidOwnerContract("mandatory-charge confirmation receipt");
      }
      const confirmed = await loadWorkspace(organizationId, propertyId, { cache: "no-store" });
      if (confirmed.confirmation?.pricingSourceFingerprint !== fingerprint) {
        throw refreshRequiredConflict();
      }
      return confirmed;
    },
  };
}

async function upsertRecurring(
  http: PricingSetupHttpClient,
  propertyId: string,
  sourceId: string,
  body: Record<string, unknown>,
): Promise<{
  source: PmsRecurringPricingSourceSnapshot;
  optionalPricingAggregateRevision: number;
}> {
  const value = await ownerPut(
    http,
    `/api/pms/properties/${encodeURIComponent(propertyId)}/pricing-source/recurring/${encodeURIComponent(sourceId)}`,
    body,
    await commandKey("recurring-pricing", propertyId, { sourceId, ...body }),
    "recurring",
  );
  const result = parsePmsRecurringPricingCommandResult({ ok: true, response: value });
  if (
    !result?.ok ||
    result.response.source.propertyId !== propertyId.toLowerCase() ||
    result.response.source.sourceId !== sourceId.toLowerCase() ||
    result.response.source.sourceKind !== body.sourceKind
  ) {
    throw invalidOwnerContract("recurring pricing receipt");
  }
  return {
    source: result.response.source,
    optionalPricingAggregateRevision: result.response.optionalPricingAggregateRevision,
  };
}

async function disableRecurring(
  http: PricingSetupHttpClient,
  propertyId: string,
  source: PmsRecurringPricingSourceSnapshot,
): Promise<{
  source: PmsRecurringPricingSourceSnapshot;
  optionalPricingAggregateRevision: number;
}> {
  const body = { sourceKind: source.sourceKind, expectedSourceRevision: source.sourceRevision };
  const value = await ownerPost(
    http,
    `/api/pms/properties/${encodeURIComponent(propertyId)}/pricing-source/recurring/${encodeURIComponent(source.sourceId)}/disable`,
    body,
    await commandKey("disable-recurring-pricing", propertyId, {
      sourceId: source.sourceId,
      ...body,
    }),
    "recurring",
  );
  const result = parsePmsRecurringPricingCommandResult({ ok: true, response: value });
  if (
    !result?.ok ||
    result.response.source.propertyId !== propertyId.toLowerCase() ||
    result.response.source.sourceId !== source.sourceId ||
    result.response.source.sourceKind !== source.sourceKind ||
    result.response.source.configuredState !== "disabled"
  ) {
    throw invalidOwnerContract("recurring pricing disable receipt");
  }
  return {
    source: result.response.source,
    optionalPricingAggregateRevision: result.response.optionalPricingAggregateRevision,
  };
}

function flexiblePlanMatches(
  plan: FlexibleRatePlanSnapshot,
  roomFactsRevision: number,
  currency: string,
  baseAmountDecimal: string,
  freeCancellationDeadlineDays: number,
): boolean {
  return (
    plan.sourceRoomFactsRevision === roomFactsRevision &&
    plan.baseAmount.amountDecimal === baseAmountDecimal &&
    plan.baseAmount.currency === currency &&
    plan.cancellationTerms.type === "free_until_days_before_arrival" &&
    plan.cancellationTerms.freeCancellationDeadlineDays === freeCancellationDeadlineDays &&
    plan.cancellationTerms.afterDeadlinePenalty === "full_booking_amount" &&
    plan.cancellationTerms.noShowPenalty === "full_booking_amount"
  );
}

function recurringMatches(
  source: PmsRecurringPricingSourceSnapshot,
  body: Record<string, unknown>,
): boolean {
  if (
    source.configuredState !== "active" ||
    source.lifecycle === "disabled" ||
    source.sourceKind !== body.sourceKind ||
    source.sourceRevision !== body.expectedSourceRevision ||
    source.pricingCurrencyRevision !== body.expectedPricingCurrencyRevision
  ) {
    return false;
  }
  return recurringConfigurationMatches(source, body);
}

function recurringConfigurationMatches(
  source: PmsRecurringPricingSourceSnapshot,
  body: Record<string, unknown>,
): boolean {
  const expected = { ...body, expectedSourceRevision: source.sourceRevision };
  return JSON.stringify(recurringBodyForSource(source)) === JSON.stringify(expected);
}

function recurringBodyForSource(
  source: PmsRecurringPricingSourceSnapshot,
): Record<string, unknown> {
  const room = (evidence: {
    roomTypeId: string;
    roomFactsRevision: number;
    flexibleRatePlanId: string;
    flexibleRatePlanRevision: number;
  }) => ({
    roomTypeId: evidence.roomTypeId,
    expectedRoomFactsRevision: evidence.roomFactsRevision,
    flexibleRatePlanId: evidence.flexibleRatePlanId,
    expectedFlexibleRatePlanRevision: evidence.flexibleRatePlanRevision,
  });
  const base = {
    sourceKind: source.sourceKind,
    expectedSourceRevision: source.sourceRevision,
    expectedPricingCurrencyRevision: source.pricingCurrencyRevision,
  };
  switch (source.sourceKind) {
    case "season":
      return {
        ...base,
        name: source.name,
        startMonthDay: source.startMonthDay,
        endMonthDay: source.endMonthDay,
        roomPrices: source.roomPrices.map((price) => ({
          ...room(price),
          amountDecimal: price.amountDecimal,
        })),
      };
    case "weekend_surcharge":
      return {
        ...base,
        weekdays: [...source.weekdays],
        roomSurcharges: source.roomSurcharges.map((surcharge) => ({
          ...room(surcharge),
          amountDecimal: surcharge.amountDecimal,
        })),
      };
    case "additional_guest":
      return {
        ...base,
        ...room(source),
        includedGuests: source.includedGuests,
        amountDecimal: source.amountDecimal,
      };
    case "non_refundable":
      return {
        ...base,
        discountPercent: source.discountPercent,
        roomPlans: source.roomPlans.map(room),
      };
  }
}

function assertRefetchedPricingMatches(
  current: PricingCanonicalWorkspace,
  state: PricingDraftState,
  locale: string,
  expectedPlans: ReadonlyMap<string, FlexibleRatePlanSnapshot>,
  desiredIds: ReadonlySet<string>,
  desiredBodies: ReadonlyMap<string, Record<string, unknown>>,
  expectedSources: ReadonlyMap<string, PmsRecurringPricingSourceSnapshot>,
  expectedAggregateRevision: number,
): void {
  const pricing = current.pricing;
  const recurring = current.recurringPricing;
  if (!pricing || !recurring) throw refreshRequiredConflict();
  const activeRooms = current.rooms
    .filter(({ lifecycle }) => lifecycle === "active")
    .map(({ roomTypeId, roomFactsRevision }) => ({ roomTypeId, roomFactsRevision }))
    .sort((left, right) => codeUnitCompare(left.roomTypeId, right.roomTypeId));
  const desiredRooms = state.rooms
    .map(({ roomTypeId, roomFactsRevision }) => ({ roomTypeId, roomFactsRevision }))
    .sort((left, right) => codeUnitCompare(left.roomTypeId, right.roomTypeId));
  const currentPlans = new Map(pricing.flexibleRatePlans.map((plan) => [plan.roomTypeId, plan]));
  if (
    JSON.stringify(activeRooms) !== JSON.stringify(desiredRooms) ||
    pricing.pricingCurrency.currency !== state.currencyInput.toUpperCase() ||
    recurring.optionalPricingAggregateRevision !== expectedAggregateRevision
  ) {
    throw refreshRequiredConflict();
  }
  for (const room of state.rooms) {
    const expected = expectedPlans.get(room.roomTypeId);
    const actual = currentPlans.get(room.roomTypeId);
    if (
      !expected ||
      !actual ||
      actual.flexibleRatePlanId !== expected.flexibleRatePlanId ||
      actual.flexibleRatePlanRevision !== expected.flexibleRatePlanRevision ||
      !flexiblePlanMatches(
        actual,
        room.roomFactsRevision,
        state.currencyInput.toUpperCase(),
        requiredMoney(room.baseAmountInput, locale, false),
        Number(state.freeCancellationDeadlineDaysInput),
      )
    ) {
      throw refreshRequiredConflict();
    }
  }
  const actualSources = new Map(recurring.sources.map((source) => [source.sourceId, source]));
  const actualActiveIds = recurring.sources
    .filter(({ configuredState }) => configuredState === "active")
    .map(({ sourceId }) => sourceId)
    .sort(codeUnitCompare);
  if (
    JSON.stringify(actualActiveIds) !== JSON.stringify(Array.from(desiredIds).sort(codeUnitCompare))
  ) {
    throw refreshRequiredConflict();
  }
  for (const [sourceId, expected] of Array.from(expectedSources.entries())) {
    const actual = actualSources.get(sourceId);
    const desired = desiredBodies.get(sourceId);
    if (
      !actual ||
      actual.sourceRevision !== expected.sourceRevision ||
      actual.configuredState !== expected.configuredState ||
      (desired
        ? actual.configuredState !== "active" || !recurringConfigurationMatches(actual, desired)
        : actual.configuredState !== "disabled")
    ) {
      throw refreshRequiredConflict();
    }
  }
}

function refreshRequiredConflict(): PricingOwnerError {
  return new PricingOwnerError(
    "Pricing changed in another session before the final-price confirmation was recorded. Reload the latest pricing.",
    "pricing_source_conflict",
    null,
    true,
  );
}

async function optionalGet(
  http: PricingSetupHttpClient,
  endpoint: string,
  missingCode: string,
  options?: RequestInit,
): Promise<unknown | null> {
  try {
    return await http.get<unknown>(endpoint, options);
  } catch (error) {
    if (
      error instanceof ApiErrorResponse &&
      error.status === 404 &&
      error.data.code === missingCode
    ) {
      return null;
    }
    throw error;
  }
}

async function confirmationGet(
  http: PricingSetupHttpClient,
  organizationId: string,
  propertyId: string,
  options?: RequestInit,
) {
  try {
    const value = await http.get<unknown>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/mandatory-charge-confirmation`,
      options,
    );
    const result = parsePmsMandatoryChargeConfirmationReadResult(value);
    if (
      result?.organizationId !== organizationId.toLowerCase() ||
      result.propertyId !== propertyId.toLowerCase()
    ) {
      throw invalidOwnerContract("mandatory-charge confirmation");
    }
    if (result.outcome === "available") return result.evidence;
    if (result.outcome === "missing") return null;
    throw invalidOwnerContract("mandatory-charge confirmation");
  } catch (error) {
    if (error instanceof ApiErrorResponse && error.status === 404) {
      const result = parsePmsMandatoryChargeConfirmationReadResult(error.data as unknown);
      if (
        result?.outcome === "missing" &&
        result.organizationId === organizationId.toLowerCase() &&
        result.propertyId === propertyId.toLowerCase()
      ) {
        return null;
      }
      throw invalidOwnerContract("mandatory-charge confirmation");
    }
    throw error;
  }
}

function parseRoomList(value: unknown, propertyId: string): RoomTypeFactsSnapshot[] | null {
  if (
    !isExactRecord(value, ["contractVersion", "propertyId", "items"]) ||
    value.contractVersion !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    value.propertyId !== propertyId.toLowerCase() ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const rooms = value.items.map(parseRoomTypeFactsSnapshot);
  return rooms.some((room) => !room || room.propertyId !== propertyId.toLowerCase()) ||
    new Set(rooms.map((room) => room?.roomTypeId)).size !== rooms.length
    ? null
    : (rooms as RoomTypeFactsSnapshot[]);
}

function parseDraftReceipt(
  value: unknown,
  request: Extract<SavePropertySetupDraftRequest, { stepId: "pricing" }>,
): SavePropertySetupDraftReceipt | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "sessionId",
      "stepId",
      "selectedTracks",
      "trackRevision",
      "sessionRevision",
      "draftRevision",
      "retentionExpiresAt",
      "updatedAt",
      "replayed",
    ]) ||
    value.contractVersion !== PROPERTY_SETUP_DRAFT_CONTRACT_VERSION ||
    value.stepId !== "pricing" ||
    !isUuid(value.sessionId) ||
    !Array.isArray(value.selectedTracks) ||
    value.selectedTracks.some((track) => !isSetupTrack(track)) ||
    new Set(value.selectedTracks).size !== value.selectedTracks.length ||
    !value.selectedTracks.includes("hotel_operations") ||
    value.trackRevision !== request.expectedTrackRevision ||
    value.sessionRevision !== request.expectedSessionRevision + 1 ||
    value.draftRevision !== request.expectedDraftRevision + 1 ||
    !isIsoDateTime(value.retentionExpiresAt) ||
    !isIsoDateTime(value.updatedAt) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }
  return value as SavePropertySetupDraftReceipt;
}

async function ownerPut(
  http: PricingSetupHttpClient,
  endpoint: string,
  body: unknown,
  idempotencyKey: string,
  kind: PricingCommandKind,
): Promise<unknown> {
  try {
    return await http.put<unknown>(endpoint, body, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
  } catch (error) {
    throw ownerError(error, kind);
  }
}

async function ownerPost(
  http: PricingSetupHttpClient,
  endpoint: string,
  body: unknown,
  idempotencyKey: string,
  kind: PricingCommandKind,
): Promise<unknown> {
  try {
    return await http.post<unknown>(endpoint, body, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
  } catch (error) {
    throw ownerError(error, kind);
  }
}

type PricingCommandKind = "draft" | "currency" | "plan" | "recurring" | "confirmation";
type PricingCommandError =
  | SavePropertySetupDraftError
  | PropertyPricingCurrencyCommandError
  | FlexibleRatePlanCommandError
  | PmsRecurringPricingCommandError
  | PmsMandatoryChargeConfirmationCommandError;

function ownerError(error: unknown, kind: PricingCommandKind): Error {
  if (!(error instanceof ApiErrorResponse))
    return error instanceof Error ? error : new Error("Pricing could not be saved.");
  const parsed = parsePricingCommandError(kind, error.data as unknown);
  if (!parsed || pricingCommandErrorStatus(kind, parsed) !== error.status) {
    return invalidOwnerContract(`${kind} command error`);
  }
  const code = parsed.code;
  const messages: Record<string, string> = {
    unsupported_pricing_currency: "That currency is not supported end to end yet.",
    pricing_currency_unchanged: "The pricing currency already matches this draft.",
    pricing_currency_change_blocked:
      "The currency is already used by pricing, payments, bookings, or publication. Keep the current currency.",
    pricing_currency_not_configured: "Choose a pricing currency before saving room prices.",
    pricing_currency_revision_conflict: "The pricing currency changed in another session.",
    room_type_not_found: "A room in this pricing draft is no longer available.",
    room_facts_revision_conflict: "A room changed in another session.",
    flexible_rate_plan_revision_conflict: "A room price changed in another session.",
    ambiguous_legacy_flexible_rate_plans:
      "Room pricing contains ambiguous historical plans and cannot be changed safely.",
    source_not_found: "An optional pricing rule is no longer available.",
    source_kind_conflict: "An optional pricing rule changed type in another session.",
    flexible_rate_plan_not_found: "A room price required by this rule is no longer available.",
    additional_guest_capacity_inapplicable:
      "Additional guest pricing is not available for a room with this occupancy.",
    optional_pricing_aggregate_revision_conflict:
      "Optional pricing rules changed in another session.",
    inactive_setup_step: "This setup step is no longer active.",
    track_revision_conflict: "The selected setup track changed in another session.",
    session_revision_conflict: "This setup session changed in another session.",
    draft_revision_conflict: "This pricing draft changed in another session.",
    base_revision_conflict: "The pricing source manifest changed in another session.",
    setup_session_expired: "This setup session expired. Refresh setup before saving.",
    setup_draft_expired: "This pricing draft expired. Refresh setup before saving.",
    source_revision_conflict: "An optional pricing rule changed in another session.",
    pricing_source_conflict: "Pricing changed before the final-price confirmation was recorded.",
    confirmation_revision_conflict: "The final-price confirmation changed in another session.",
    recurring_pricing_room_plan_set_incomplete:
      "Every active room needs a complete flexible price before this option can be saved.",
    season_overlap: "One seasonal period overlaps another saved period.",
    season_name_conflict: "A saved season already uses that name.",
    command_in_progress: "This pricing save is still processing. Retry in a moment.",
    idempotency_key_conflict:
      "This exact save key was reused for different pricing input. Reload the latest pricing.",
    setup_scope_unavailable: "Pricing access is no longer available for this hotel.",
  };
  const requiresRefresh =
    code.includes("revision_conflict") ||
    code === "inactive_setup_step" ||
    code === "setup_session_expired" ||
    code === "setup_draft_expired" ||
    code === "pricing_currency_unchanged" ||
    code === "pricing_currency_change_blocked" ||
    code === "pricing_currency_not_configured" ||
    code === "room_type_not_found" ||
    code === "source_not_found" ||
    code === "source_kind_conflict" ||
    code === "flexible_rate_plan_not_found" ||
    code === "ambiguous_legacy_flexible_rate_plans" ||
    code === "pricing_source_conflict" ||
    code === "idempotency_key_conflict" ||
    code === "setup_scope_unavailable";
  return new PricingOwnerError(
    messages[code] ?? error.message ?? "Pricing could not be saved. Try again.",
    code,
    parsed,
    requiresRefresh,
  );
}

function parsePricingCommandError(
  kind: PricingCommandKind,
  value: unknown,
): PricingCommandError | null {
  if (kind === "draft") return parseDraftCommandError(value);
  const wrapped = { ok: false as const, error: value };
  const result =
    kind === "currency"
      ? parsePropertyPricingCurrencyCommandResult(wrapped)
      : kind === "plan"
        ? parseFlexibleRatePlanCommandResult(wrapped)
        : kind === "recurring"
          ? parsePmsRecurringPricingCommandResult(wrapped)
          : parseConfirmMandatoryChargesIncludedResult(wrapped);
  return result && !result.ok ? result.error : null;
}

function pricingCommandErrorStatus(kind: PricingCommandKind, error: PricingCommandError): number {
  if (error.code === "setup_scope_unavailable") return 404;
  if (kind === "currency" && error.code === "unsupported_pricing_currency") return 422;
  if (kind === "plan" && error.code === "room_type_not_found") return 404;
  if (
    kind === "recurring" &&
    ["source_not_found", "room_type_not_found", "flexible_rate_plan_not_found"].includes(error.code)
  ) {
    return 404;
  }
  if (
    kind === "recurring" &&
    [
      "season_name_conflict",
      "season_overlap",
      "additional_guest_capacity_inapplicable",
      "recurring_pricing_room_plan_set_incomplete",
    ].includes(error.code)
  ) {
    return 422;
  }
  return 409;
}

function parseDraftCommandError(value: unknown): SavePropertySetupDraftError | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  if (
    ["setup_scope_unavailable", "idempotency_key_conflict", "command_in_progress"].includes(
      value.code,
    )
  ) {
    return isExactRecord(value, ["code"]) ? (value as SavePropertySetupDraftError) : null;
  }
  const revisionKey =
    value.code === "inactive_setup_step" || value.code === "track_revision_conflict"
      ? "currentTrackRevision"
      : value.code === "session_revision_conflict" || value.code === "setup_session_expired"
        ? "currentSessionRevision"
        : value.code === "draft_revision_conflict" || value.code === "setup_draft_expired"
          ? "currentDraftRevision"
          : null;
  return revisionKey &&
    isExactRecord(value, ["code", revisionKey]) &&
    Number.isSafeInteger(value[revisionKey]) &&
    (value[revisionKey] as number) >= 0
    ? (value as SavePropertySetupDraftError)
    : null;
}

function requiredMoney(input: string, locale: string, allowZero: boolean): string {
  const value = normalizeMoneyInput(input, locale, allowZero);
  if (!value) throw new TypeError("Complete pricing contains an invalid amount.");
  return value;
}

async function commandKey(label: string, propertyId: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return `${label}:${propertyId}:${(await sha256Hex(bytes)).slice(0, 40)}`;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalidOwnerContract(name: string): PricingOwnerError {
  return new PricingOwnerError(
    `The ${name} returned invalid data. Refresh the page and try again.`,
    "owner_contract_violation",
    null,
    true,
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const pricingSetupApi = createPricingSetupClient(targetApiClient);
