import type {
  PropertySetupRouteReadModel,
  SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";
import {
  parsePmsRecurringMonthDay,
  type FlexibleRatePlanSnapshot,
  type PmsMandatoryChargeConfirmationEvidence,
  type PmsPricingSourceSnapshot,
  type PmsRecurringPricingBookingEvidence,
  type PmsRecurringPricingSourceSnapshot,
  type RoomTypeFactsSnapshot,
} from "@vayada/domain-pms";

export const PRICING_DRAFT_FIELDS = [
  "rate.currency",
  "rate.base_nightly_rate",
  "rate.free_cancellation_deadline_days",
  "rate.non_refundable_enabled",
  "rate.non_refundable_discount",
  "rate.seasons",
  "rate.seasonal_prices",
  "rate.weekend_days",
  "rate.weekend_surcharge",
  "rate.occupancy_prices",
  "rate.mandatory_charges_acknowledged",
] as const;

export const PRICING_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type PricingWeekday = (typeof PRICING_WEEKDAYS)[number];

export type PricingCanonicalWorkspace = {
  rooms: RoomTypeFactsSnapshot[];
  pricing: PmsPricingSourceSnapshot | null;
  recurringPricing: PmsRecurringPricingBookingEvidence | null;
  confirmation: PmsMandatoryChargeConfirmationEvidence | null;
  /** Latest owner CAS revision, retained even when its fingerprint is stale. */
  confirmationRevision: number;
};

export type PricingRoomDraft = {
  roomTypeId: string;
  name: string;
  maximumAdults: number;
  roomFactsRevision: number;
  flexibleRatePlanId: string | null;
  flexibleRatePlanRevision: number;
  baseAmountInput: string;
  additionalGuestEnabled: boolean;
  includedGuestsInput: string;
  additionalGuestAmountInput: string;
  additionalGuestSourceId: string;
  additionalGuestSourceRevision: number;
};

export type PricingSeasonDraft = {
  sourceId: string;
  sourceRevision: number;
  name: string;
  startMonthDay: string;
  endMonthDay: string;
  roomPrices: Record<string, string>;
};

export type PricingDraftState = {
  currencyInput: string;
  pricingCurrencyRevision: number;
  freeCancellationDeadlineDaysInput: string;
  nonRefundableEnabled: boolean;
  nonRefundableDiscountInput: string;
  nonRefundableSourceId: string;
  nonRefundableSourceRevision: number;
  rooms: PricingRoomDraft[];
  seasons: PricingSeasonDraft[];
  weekendEnabled: boolean;
  weekendSourceId: string;
  weekendSourceRevision: number;
  weekendDays: PricingWeekday[];
  weekendSurcharges: Record<string, string>;
  mandatoryChargesAcknowledged: boolean;
  confirmationRevision: number;
  dirty: boolean;
};

export type PricingDraftRevisionContext = {
  sessionId: string | null;
  trackRevision: number;
  sessionRevision: number | null;
  draftRevision: number;
  baseRevisions: {
    "pms.pricing_settings": string;
    "pms.rate_plans": string;
    "pms.rate_rules": string;
  } | null;
};

export type PricingValidationErrors = Record<string, string>;

export function pricingDraftRevisionContext(
  route: PropertySetupRouteReadModel,
  step: PropertySetupRouteReadModel["steps"][number],
): PricingDraftRevisionContext {
  const draft = step.stepId === "pricing" ? step.draft : null;
  const base = draft?.stepId === "pricing" ? draft.baseRevisions : null;
  return {
    sessionId: route.sessionId,
    trackRevision: route.trackRevision,
    sessionRevision: route.sessionRevision,
    draftRevision: draft?.stepId === "pricing" ? draft.revision : 0,
    baseRevisions: base
      ? {
          "pms.pricing_settings": base["pms.pricing_settings"],
          "pms.rate_plans": base["pms.rate_plans"],
          "pms.rate_rules": base["pms.rate_rules"],
        }
      : null,
  };
}

export function hydratePricingDraft(
  routeDraft: PropertySetupRouteReadModel["steps"][number]["draft"],
  workspace: PricingCanonicalWorkspace,
  idFactory: () => string = () => crypto.randomUUID(),
): PricingDraftState {
  const payload = routeDraft?.stepId === "pricing" ? routeDraft.payload : {};
  const pricing = workspace.pricing;
  const sources = workspace.recurringPricing?.sources ?? [];
  assertUnambiguousSources(sources);

  const plans = new Map(pricing?.flexibleRatePlans.map((plan) => [plan.roomTypeId, plan]) ?? []);
  const hasDraftCurrency = Object.hasOwn(payload, "rate.currency");
  const hasDraftBaseAmounts = Object.hasOwn(payload, "rate.base_nightly_rate");
  const baseAmounts = record(payload["rate.base_nightly_rate"]);
  const hasDraftOccupancyPrices = Object.hasOwn(payload, "rate.occupancy_prices");
  const occupancyPrices = record(payload["rate.occupancy_prices"]);
  const hasDraftWeekendSurcharges = Object.hasOwn(payload, "rate.weekend_surcharge");
  const weekendSurchargeDraft = record(payload["rate.weekend_surcharge"]);
  const additionalByRoom = new Map(
    sources
      .filter(
        (
          source,
        ): source is Extract<
          PmsRecurringPricingSourceSnapshot,
          { sourceKind: "additional_guest" }
        > => source.sourceKind === "additional_guest" && source.configuredState === "active",
      )
      .map((source) => [source.roomTypeId, source]),
  );
  const rooms = workspace.rooms
    .filter(({ lifecycle }) => lifecycle === "active")
    .map((room) => {
      const plan = plans.get(room.roomTypeId);
      const additional = additionalByRoom.get(room.roomTypeId);
      const occupancyDraft = record(occupancyPrices[room.roomTypeId]);
      const hasDraftOccupancy = Object.hasOwn(occupancyPrices, room.roomTypeId);
      return {
        roomTypeId: room.roomTypeId,
        name: room.facts.name,
        maximumAdults: room.facts.occupancy.maxAdults,
        roomFactsRevision: room.roomFactsRevision,
        flexibleRatePlanId: plan?.flexibleRatePlanId ?? null,
        flexibleRatePlanRevision: plan?.flexibleRatePlanRevision ?? 0,
        baseAmountInput: hasDraftBaseAmounts
          ? stringValue(baseAmounts[room.roomTypeId])
          : plan?.baseAmount.amountDecimal || "",
        additionalGuestEnabled: hasDraftOccupancyPrices
          ? hasDraftOccupancy
          : additional?.configuredState === "active" && additional.lifecycle !== "invalid",
        includedGuestsInput: hasDraftOccupancy
          ? numberText(occupancyDraft["includedGuests"])
          : numberText(additional?.includedGuests),
        additionalGuestAmountInput: hasDraftOccupancy
          ? stringValue(occupancyDraft["additionalGuestAmount"])
          : additional?.amountDecimal || "",
        additionalGuestSourceId: additional?.sourceId ?? idFactory(),
        additionalGuestSourceRevision: additional?.sourceRevision ?? 0,
      };
    });

  const hasDraftSeasons = Object.hasOwn(payload, "rate.seasons");
  const draftSeasons = array(payload["rate.seasons"]);
  const allCanonicalSeasons = sources.filter(
    (source): source is Extract<PmsRecurringPricingSourceSnapshot, { sourceKind: "season" }> =>
      source.sourceKind === "season",
  );
  const activeCanonicalSeasons = allCanonicalSeasons.filter(
    ({ configuredState }) => configuredState === "active",
  );
  const hasDraftSeasonPrices = Object.hasOwn(payload, "rate.seasonal_prices");
  const seasonPriceDraft = record(payload["rate.seasonal_prices"]);
  const seasons = (hasDraftSeasons ? draftSeasons : activeCanonicalSeasons).flatMap((value) => {
    const sourceId = isRecord(value) ? stringValue(value.id) || stringValue(value.sourceId) : "";
    const canonical = allCanonicalSeasons.find((source) => source.sourceId === sourceId);
    const actualId = sourceId || canonical?.sourceId || idFactory();
    const prices = record(seasonPriceDraft[actualId]);
    return [
      {
        sourceId: actualId,
        sourceRevision: canonical?.sourceRevision ?? 0,
        name: isRecord(value) ? stringValue(value.name) : (canonical?.name ?? ""),
        startMonthDay: isRecord(value)
          ? stringValue(value.startMonthDay)
          : (canonical?.startMonthDay ?? ""),
        endMonthDay: isRecord(value)
          ? stringValue(value.endMonthDay)
          : (canonical?.endMonthDay ?? ""),
        roomPrices: Object.fromEntries(
          rooms.map((room) => [
            room.roomTypeId,
            hasDraftSeasonPrices
              ? stringValue(prices[room.roomTypeId])
              : canonical?.roomPrices.find(({ roomTypeId }) => roomTypeId === room.roomTypeId)
                  ?.amountDecimal || room.baseAmountInput,
          ]),
        ),
      },
    ];
  });

  const weekendSources = sources.filter((source) => source.sourceKind === "weekend_surcharge");
  const weekend =
    weekendSources.find(({ configuredState }) => configuredState === "active") ??
    (weekendSources.length === 1 ? weekendSources[0] : undefined);
  const draftWeekendDays = array(payload["rate.weekend_days"]).filter(isWeekday);
  const hasDraftWeekend = Object.hasOwn(payload, "rate.weekend_days");
  const weekendEnabled = hasDraftWeekend
    ? draftWeekendDays.length > 0
    : weekend?.configuredState === "active";
  const nonRefundableSources = sources.filter((source) => source.sourceKind === "non_refundable");
  const nonRefundable =
    nonRefundableSources.find(({ configuredState }) => configuredState === "active") ??
    (nonRefundableSources.length === 1 ? nonRefundableSources[0] : undefined);
  const hasDraftNonRefundable = Object.hasOwn(payload, "rate.non_refundable_enabled");

  return {
    currencyInput: hasDraftCurrency
      ? stringValue(payload["rate.currency"])
      : pricing?.pricingCurrency.currency || "",
    pricingCurrencyRevision: pricing?.pricingCurrency.pricingCurrencyRevision ?? 0,
    freeCancellationDeadlineDaysInput: Object.hasOwn(
      payload,
      "rate.free_cancellation_deadline_days",
    )
      ? numberText(payload["rate.free_cancellation_deadline_days"])
      : cancellationDeadlineInput(pricing?.flexibleRatePlans ?? []),
    nonRefundableEnabled: hasDraftNonRefundable
      ? payload["rate.non_refundable_enabled"] === true
      : nonRefundable?.configuredState === "active",
    nonRefundableDiscountInput: Object.hasOwn(payload, "rate.non_refundable_discount")
      ? numberText(payload["rate.non_refundable_discount"])
      : (nonRefundable?.sourceKind === "non_refundable"
          ? numberText(nonRefundable.discountPercent)
          : "") || "10",
    nonRefundableSourceId: nonRefundable?.sourceId ?? idFactory(),
    nonRefundableSourceRevision: nonRefundable?.sourceRevision ?? 0,
    rooms,
    seasons,
    weekendEnabled,
    weekendSourceId: weekend?.sourceId ?? idFactory(),
    weekendSourceRevision: weekend?.sourceRevision ?? 0,
    weekendDays:
      draftWeekendDays.length > 0
        ? draftWeekendDays
        : weekend?.sourceKind === "weekend_surcharge"
          ? [...weekend.weekdays]
          : ["friday", "saturday"],
    weekendSurcharges: Object.fromEntries(
      rooms.map((room) => [
        room.roomTypeId,
        hasDraftWeekendSurcharges
          ? stringValue(weekendSurchargeDraft[room.roomTypeId])
          : (weekend?.sourceKind === "weekend_surcharge"
              ? weekend.roomSurcharges.find(({ roomTypeId }) => roomTypeId === room.roomTypeId)
                  ?.amountDecimal
              : undefined) || "0.00",
      ]),
    ),
    mandatoryChargesAcknowledged:
      workspace.confirmationRevision > 0 && workspace.confirmation === null
        ? false
        : payload["rate.mandatory_charges_acknowledged"] === true ||
          workspace.confirmation !== null,
    confirmationRevision: workspace.confirmationRevision,
    dirty: false,
  };
}

export function validatePricingDraft(
  state: PricingDraftState,
  locale: string,
): PricingValidationErrors {
  const errors: PricingValidationErrors = {};
  if (!/^[A-Z]{3}$/.test(state.currencyInput)) {
    errors.currency = "Enter a three-letter ISO currency code.";
  }
  if (state.rooms.length === 0) errors.rooms = "Complete at least one room before setting prices.";
  for (const room of state.rooms) {
    if (!normalizeMoneyInput(room.baseAmountInput, locale, false)) {
      errors[`base.${room.roomTypeId}`] = "Enter a positive amount with no more than two decimals.";
    }
    if (room.additionalGuestEnabled) {
      if (room.maximumAdults <= 1) {
        errors[`included.${room.roomTypeId}`] =
          "This room no longer supports additional-adult pricing. Turn off the rule or update occupancy.";
        continue;
      }
      const included = wholeNumber(room.includedGuestsInput, 1, room.maximumAdults - 1);
      if (included === null) {
        errors[`included.${room.roomTypeId}`] = `Enter a whole number below ${room.maximumAdults}.`;
      }
      if (!normalizeMoneyInput(room.additionalGuestAmountInput, locale, true)) {
        errors[`additional.${room.roomTypeId}`] = "Enter zero or a positive amount.";
      }
    }
  }
  if (wholeNumber(state.freeCancellationDeadlineDaysInput, 0, 365) === null) {
    errors.cancellation = "Enter a whole number from 0 to 365.";
  }
  if (state.nonRefundableEnabled && wholeNumber(state.nonRefundableDiscountInput, 1, 50) === null) {
    errors.nonRefundable = "Enter a whole-number discount from 1% to 50%.";
  }
  const names = new Set<string>();
  if (state.seasons.length > 24) errors.seasons = "Add no more than 24 seasonal periods.";
  state.seasons.forEach((season, index) => {
    const key = season.name.trim().toLocaleLowerCase();
    if (!key) errors[`season.${index}.name`] = "Enter a season name.";
    else if (season.name !== season.name.trim() || season.name.length > 100) {
      errors[`season.${index}.name`] = "Use 1–100 characters without leading or trailing spaces.";
    } else if (names.has(key)) errors[`season.${index}.name`] = "Season names must be unique.";
    else names.add(key);
    if (!isSharedDraftMonthDay(season.startMonthDay)) {
      errors[`season.${index}.start`] = "Enter a valid start month and day.";
    }
    if (!isSharedDraftMonthDay(season.endMonthDay)) {
      errors[`season.${index}.end`] = "Enter a valid end month and day.";
    }
    state.rooms.forEach((room) => {
      if (!normalizeMoneyInput(season.roomPrices[room.roomTypeId] ?? "", locale, false)) {
        errors[`season.${index}.${room.roomTypeId}`] = "Enter a positive seasonal price.";
      }
    });
  });
  for (let left = 0; left < state.seasons.length; left += 1) {
    for (let right = left + 1; right < state.seasons.length; right += 1) {
      if (seasonsOverlap(state.seasons[left]!, state.seasons[right]!)) {
        errors[`season.${right}.dates`] = "This period overlaps another season.";
      }
    }
  }
  if (state.weekendEnabled) {
    if (state.weekendDays.length === 0) errors.weekendDays = "Choose at least one weekend night.";
    state.rooms.forEach((room) => {
      if (!normalizeMoneyInput(state.weekendSurcharges[room.roomTypeId] ?? "", locale, true)) {
        errors[`weekend.${room.roomTypeId}`] = "Enter zero or a positive surcharge.";
      }
    });
  }
  if (!state.mandatoryChargesAcknowledged) {
    errors.mandatory = "Confirm that predictable mandatory charges are included.";
  }
  return errors;
}

function isSharedDraftMonthDay(value: string): boolean {
  if (!parsePmsRecurringMonthDay(value) || !/^\d{2}-\d{2}$/.test(value)) return false;
  const [month, day] = value.split("-").map(Number);
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  return day! <= daysInMonth[month! - 1]!;
}

export function buildPricingDraftRequest(
  state: PricingDraftState,
  revision: PricingDraftRevisionContext,
  locale: string,
): Extract<SavePropertySetupDraftRequest, { stepId: "pricing" }> {
  if (!revision.sessionId || revision.sessionRevision === null || revision.baseRevisions === null) {
    throw new Error(PRICING_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE);
  }
  const amount = (input: string, allowZero = false) =>
    normalizeMoneyInput(input, locale, allowZero);
  const payload = {
    "rate.currency": state.currencyInput || null,
    "rate.base_nightly_rate": Object.fromEntries(
      state.rooms.map((room) => [room.roomTypeId, amount(room.baseAmountInput)]),
    ),
    "rate.free_cancellation_deadline_days": wholeNumber(
      state.freeCancellationDeadlineDaysInput,
      0,
      365,
    ),
    "rate.non_refundable_enabled": state.nonRefundableEnabled,
    "rate.non_refundable_discount": state.nonRefundableEnabled
      ? wholeNumber(state.nonRefundableDiscountInput, 1, 50)
      : null,
    "rate.seasons": state.seasons.map((season) => ({
      id: season.sourceId,
      name: season.name || null,
      startMonthDay: season.startMonthDay || null,
      endMonthDay: season.endMonthDay || null,
    })),
    "rate.seasonal_prices": Object.fromEntries(
      state.seasons.map((season) => [
        season.sourceId,
        Object.fromEntries(
          state.rooms.map((room) => [
            room.roomTypeId,
            amount(season.roomPrices[room.roomTypeId] ?? ""),
          ]),
        ),
      ]),
    ),
    "rate.weekend_days": state.weekendEnabled ? state.weekendDays : [],
    "rate.weekend_surcharge": state.weekendEnabled
      ? Object.fromEntries(
          state.rooms.map((room) => [
            room.roomTypeId,
            amount(state.weekendSurcharges[room.roomTypeId] ?? "", true),
          ]),
        )
      : {},
    "rate.occupancy_prices": Object.fromEntries(
      state.rooms.flatMap((room) =>
        room.additionalGuestEnabled
          ? [
              [
                room.roomTypeId,
                {
                  includedGuests: wholeNumber(room.includedGuestsInput, 1, 99),
                  additionalGuestAmount: amount(room.additionalGuestAmountInput, true),
                },
              ] as const,
            ]
          : [],
      ),
    ),
    "rate.mandatory_charges_acknowledged": state.mandatoryChargesAcknowledged,
  } as const;
  return {
    stepId: "pricing",
    payload,
    dirtyFields: [...PRICING_DRAFT_FIELDS],
    expectedBaseRevisions: revision.baseRevisions,
    expectedTrackRevision: revision.trackRevision,
    expectedSessionRevision: revision.sessionRevision,
    expectedDraftRevision: revision.draftRevision,
  };
}

/** Converts a localized scale-2 input to canonical decimal text without floating-point money. */
export function normalizeMoneyInput(
  input: string,
  locale: string,
  allowZero: boolean,
): string | null {
  const symbols = numberSymbols(locale);
  const value = input.trim().replace(/[\s\u00a0\u202f']/g, "");
  if (!value) return null;
  const normalized = canonicalizeSeparators(value, symbols);
  if (!normalized) return null;
  const match = /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
  return !allowZero && canonical === "0.00" ? null : canonical;
}

function canonicalizeSeparators(
  value: string,
  symbols: { decimal: string; group: string },
): string | null {
  if (symbols.decimal === ",") {
    if (value.includes(",")) return withDecimal(value, ",", ".");
    if (value.includes(".")) {
      if (/^\d+\.\d{1,2}$/.test(value)) return value;
      return validGroupedInteger(value, ".") ? value.replaceAll(".", "") : null;
    }
    return /^\d+$/.test(value) ? value : null;
  }
  if (value.includes(".")) return withDecimal(value, ".", symbols.group || ",");
  if (value.includes(",")) {
    return validGroupedInteger(value, ",") ? value.replaceAll(",", "") : null;
  }
  return /^\d+$/.test(value) ? value : null;
}

function withDecimal(value: string, decimal: string, group: string): string | null {
  if (value.split(decimal).length !== 2) return null;
  const [integer, fraction] = value.split(decimal);
  if (!integer || !fraction || !/^\d{1,2}$/.test(fraction)) return null;
  const normalizedInteger = integer.includes(group)
    ? validGroupedInteger(integer, group)
      ? integer.replaceAll(group, "")
      : null
    : /^\d+$/.test(integer)
      ? integer
      : null;
  return normalizedInteger ? `${normalizedInteger}.${fraction}` : null;
}

function validGroupedInteger(value: string, group: string): boolean {
  const parts = value.split(group);
  return (
    parts.length > 1 &&
    /^\d{1,3}$/.test(parts[0] ?? "") &&
    parts.slice(1).every((part) => /^\d{3}$/.test(part))
  );
}

export function discountedDecimal(amountDecimal: string, discountPercent: number): string {
  const minor = decimalToMinor(amountDecimal);
  const result = (minor * BigInt(100 - discountPercent) + BigInt(50)) / BigInt(100);
  return minorToDecimal(result);
}

export function formatDecimal(amountDecimal: string, locale: string): string {
  const symbols = numberSymbols(locale);
  const [integer, fraction = "00"] = amountDecimal.split(".");
  const grouped = integer!.replace(/\B(?=(\d{3})+(?!\d))/g, symbols.group || ",");
  return `${grouped}${symbols.decimal}${fraction.padEnd(2, "0")}`;
}

export const PRICING_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE =
  "This pricing draft is missing its server revision manifest. Refresh setup and try again.";

/** VAY-1049 route-v2 compatibility seam: historical draft manifests are never rebased. */
export function pricingDraftManifestIsCurrent(
  step: PropertySetupRouteReadModel["steps"][number],
): boolean {
  const current = (
    step as PropertySetupRouteReadModel["steps"][number] & {
      currentBaseRevisions?: unknown;
    }
  ).currentBaseRevisions;
  if (current === undefined) return true;
  if (step.stepId !== "pricing" || step.draft?.stepId !== "pricing") return true;
  if (!isRecord(current)) return false;
  const keys = ["pms.pricing_settings", "pms.rate_plans", "pms.rate_rules"] as const;
  const historical = step.draft.baseRevisions as Record<(typeof keys)[number], string>;
  return (
    Object.keys(current).length === keys.length &&
    keys.every((key) => typeof current[key] === "string" && current[key] === historical[key])
  );
}

function cancellationDeadlineInput(plans: readonly FlexibleRatePlanSnapshot[]): string {
  if (plans.length === 0) return "7";
  const deadline = plans[0]!.cancellationTerms.freeCancellationDeadlineDays;
  return numberText(
    plans.every((plan) => plan.cancellationTerms.freeCancellationDeadlineDays === deadline)
      ? deadline
      : null,
  );
}

function assertUnambiguousSources(sources: readonly PmsRecurringPricingSourceSnapshot[]): void {
  const singular = ["weekend_surcharge", "non_refundable"] as const;
  if (
    singular.some(
      (kind) =>
        sources.filter(
          (source) => source.sourceKind === kind && source.configuredState === "active",
        ).length > 1,
    )
  ) {
    throw new TypeError(
      "Pricing sources are ambiguous. Refresh setup after reviewing them in PMS.",
    );
  }
  const additionalRooms = sources
    .filter(
      (
        source,
      ): source is Extract<PmsRecurringPricingSourceSnapshot, { sourceKind: "additional_guest" }> =>
        source.sourceKind === "additional_guest" && source.configuredState === "active",
    )
    .map((source) => source.roomTypeId);
  if (new Set(additionalRooms).size !== additionalRooms.length) {
    throw new TypeError("Additional-guest pricing sources are ambiguous.");
  }
}

function seasonsOverlap(left: PricingSeasonDraft, right: PricingSeasonDraft): boolean {
  const leftSegments = annualSegments(left.startMonthDay, left.endMonthDay);
  const rightSegments = annualSegments(right.startMonthDay, right.endMonthDay);
  return leftSegments.some(([leftStart, leftEnd]) =>
    rightSegments.some(([rightStart, rightEnd]) => leftStart <= rightEnd && rightStart <= leftEnd),
  );
}

function annualSegments(start: string, end: string): Array<[number, number]> {
  const startDay = monthDayOrdinal(start);
  const endDay = monthDayOrdinal(end);
  if (startDay === null || endDay === null) return [];
  return startDay <= endDay
    ? [[startDay, endDay]]
    : [
        [startDay, 366],
        [1, endDay],
      ];
}

function monthDayOrdinal(value: string): number | null {
  if (!parsePmsRecurringMonthDay(value)) return null;
  const date = new Date(`2000-${value}T00:00:00.000Z`);
  return Math.floor((date.getTime() - Date.UTC(2000, 0, 1)) / 86_400_000) + 1;
}

function wholeNumber(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function decimalToMinor(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,12})\.\d{2}$/.test(value)) throw new TypeError("Invalid decimal amount.");
  const [integer, fraction] = value.split(".");
  return BigInt(integer!) * BigInt(100) + BigInt(fraction!);
}

function minorToDecimal(value: bigint): string {
  return `${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`;
}

function numberSymbols(locale: string): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(1000.1);
  return {
    decimal: parts.find(({ type }) => type === "decimal")?.value ?? ".",
    group: parts.find(({ type }) => type === "group")?.value ?? ",",
  };
}

function isWeekday(value: unknown): value is PricingWeekday {
  return typeof value === "string" && (PRICING_WEEKDAYS as readonly string[]).includes(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
