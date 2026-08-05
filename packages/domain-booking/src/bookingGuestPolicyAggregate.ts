import { createHash } from "node:crypto";

import type { BookingPricingEvidenceOwnerPorts } from "./bookingPricingEvidence.js";
import {
  BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS,
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  parseBookingGuestPolicyChoices,
  parseBookingGuestPolicyHash,
  type BookingGuestPolicyBundle,
  type BookingGuestPolicyCatalogProfileEvidenceResult,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyComposition,
  type BookingGuestPolicyCompositionBlocker,
  type BookingGuestPolicyHash,
  type BookingGuestPolicyRateDisclosure,
  type BookingGuestPolicyRecurringSourceBinding,
  type BookingGuestPolicySourceBinding,
} from "./bookingGuestPolicy.js";

export const BOOKING_GUEST_POLICY_UPSERT_OPERATION = "booking.guest_policy.upsert" as const;
export const BOOKING_GUEST_POLICY_RESOURCE_TYPE = "booking_guest_policy_revision" as const;
export const BOOKING_GUEST_POLICY_OUTBOX_METADATA = Object.freeze({
  sourceReadRequired: true,
} as const);
export const BOOKING_GUEST_POLICY_AUTHORIZATION = Object.freeze({
  permission: "booking.settings.manage",
  entitlement: Object.freeze({ product: "booking", key: "booking-engine" }),
  resource: Object.freeze({
    product: "booking",
    resourceType: "booking_hotel",
    allowedRelationships: Object.freeze(["owner", "operator"] as const),
  }),
} as const);

export type BookingGuestPolicyCommandAudit = Readonly<{
  actor: Readonly<{ kind: "user"; userId: string }>;
  requestId: string;
  correlationId: string | null;
  requestedAt: string;
}>;

export type UpsertBookingGuestPolicyRequest = Readonly<{
  expectedRevision: number;
  expectedSourceFingerprint: BookingGuestPolicyHash;
  choices: BookingGuestPolicyChoices;
  confirmPolicyBundle: boolean;
}>;

export type UpsertBookingGuestPolicyCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  idempotencyKey: string;
  audit: BookingGuestPolicyCommandAudit;
  expectedRevision: number;
  expectedSourceFingerprint: BookingGuestPolicyHash;
  choices: BookingGuestPolicyChoices;
  confirmPolicyBundle: boolean;
}>;

export type PersistBookingGuestPolicyCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  idempotencyKey: string;
  audit: BookingGuestPolicyCommandAudit;
  expectedRevision: number;
  expectedSourceFingerprint: BookingGuestPolicyHash;
  choices: BookingGuestPolicyChoices;
  bundle: BookingGuestPolicyBundle;
  confirmPolicyBundle: boolean;
}>;

export type BookingPolicyConfirmation = Readonly<{
  confirmationId: string;
  confirmationRevision: number;
  basis: "explicit" | "unchanged_policy_bundle";
  basedOnConfirmationId: string | null;
  reviewedAt: string;
  recordedAt: string;
}>;

export type BookingGuestPolicyProjectionReceipt =
  | Readonly<{
      outcome: "applied";
      receiptId: string;
      sourceOutboxEventId: string;
      projectedGuestPolicyRevision: number;
      projectedBundleHash: BookingGuestPolicyHash;
      projectedSourceFingerprint: BookingGuestPolicyHash;
      catalogProfileSourceRevision: string;
      catalogPolicyProjectionRevision: number;
      recordedAt: string;
    }>
  | Readonly<{
      outcome: "source_revision_conflict";
      receiptId: string;
      sourceOutboxEventId: string;
      projectedGuestPolicyRevision: number;
      projectedBundleHash: BookingGuestPolicyHash;
      projectedSourceFingerprint: BookingGuestPolicyHash;
      catalogProfileSourceRevision: string;
      observedCatalogProfileRevision: string;
      recordedAt: string;
    }>;

export type BookingGuestPolicyRevision = Readonly<{
  contractVersion: typeof BOOKING_GUEST_POLICY_CONTRACT_VERSION;
  revisionId: string;
  organizationId: string;
  propertyId: string;
  revision: number;
  catalogProfileSourceRevision: string;
  bundle: BookingGuestPolicyBundle;
  confirmation: BookingPolicyConfirmation;
  projectionReceipt: BookingGuestPolicyProjectionReceipt | null;
  outboxEventId: string;
  acceptedAt: string;
}>;

export type BookingGuestPolicyCommandError =
  | Readonly<{ code: "guest_policy_revision_conflict"; currentRevision: number }>
  | Readonly<{ code: "source_revision_conflict"; currentSourceFingerprint: BookingGuestPolicyHash }>
  | Readonly<{ code: "policy_confirmation_required" }>
  | Readonly<{
      code: "guest_policy_not_ready";
      blockers: readonly BookingGuestPolicyCompositionBlocker[];
    }>
  | Readonly<{
      code: "command_in_progress" | "idempotency_key_conflict" | "setup_scope_unavailable";
    }>;

export type BookingGuestPolicyCommandResult =
  | Readonly<{
      ok: true;
      outcome: "created" | "updated" | "idempotent_replay";
      revision: BookingGuestPolicyRevision;
    }>
  | Readonly<{ ok: false; error: BookingGuestPolicyCommandError }>;

export type BookingGuestPolicyChangedEvent = Readonly<{
  contractVersion: typeof BOOKING_GUEST_POLICY_CONTRACT_VERSION;
  eventType: typeof BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE;
  revisionId: string;
  propertyId: string;
  guestPolicyRevision: number;
  confirmationRevision: number;
  outcome: "created" | "updated";
}>;

export type BookingGuestPolicySetupDraft = Readonly<{
  defaultGuestLanguage: null;
  childrenEnabled: null;
  adultAgeThreshold: null;
  phoneRequired: typeof BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.phoneRequired;
  arrivalTimeEnabled: typeof BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.arrivalTimeEnabled;
  specialRequestsEnabled: typeof BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.specialRequestsEnabled;
  checkInTime: null;
  checkOutTime: null;
}>;

export type BookingGuestPolicySetupAggregate = Readonly<{
  contractVersion: typeof BOOKING_GUEST_POLICY_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  supportedLanguages: typeof BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES;
  draft: BookingGuestPolicySetupDraft | null;
  current: BookingGuestPolicyRevision | null;
  /** Null only for a new draft before the required policy choices are supplied. */
  composition: BookingGuestPolicyComposition | null;
}>;

type BookingGuestPolicyPublicFlexibleRate = Readonly<
  Omit<BookingGuestPolicyRateDisclosure["flexible"], "source">
>;
type BookingGuestPolicyPublicNonRefundableRate = Readonly<
  Omit<NonNullable<BookingGuestPolicyRateDisclosure["nonRefundable"]>, "source">
>;
type BookingGuestPolicyPublicAdditionalGuestRate = Readonly<
  Omit<NonNullable<BookingGuestPolicyRateDisclosure["additionalGuest"]>, "source">
>;

/** The complete allowlist for Catalog's public policy projection. */
export type BookingGuestPolicyPublicProjection = Readonly<{
  contractVersion: typeof BOOKING_GUEST_POLICY_CONTRACT_VERSION;
  propertyId: string;
  guestPolicyRevision: number;
  catalogProfileSourceRevision: string;
  sourceFingerprint: BookingGuestPolicyHash;
  bundleHash: BookingGuestPolicyHash;
  policy: Readonly<{
    childrenEnabled: boolean;
    adultAgeThreshold: number | null;
    checkInTime: string;
    checkOutTime: string;
    pricingCurrency: string;
    propertyTimeZone: string;
    rates: readonly Readonly<{
      roomTypeId: string;
      flexible: BookingGuestPolicyPublicFlexibleRate;
      nonRefundable: BookingGuestPolicyPublicNonRefundableRate | null;
      additionalGuest: BookingGuestPolicyPublicAdditionalGuestRate | null;
    }>[];
  }>;
}>;

export interface BookingGuestPolicyCommandPort {
  /** Reauthorizes and checks idempotent replay before reading mutable owner evidence. */
  upsertGuestPolicy(
    command: UpsertBookingGuestPolicyCommand,
  ): Promise<BookingGuestPolicyCommandResult>;
}

export type BookingGuestPolicyAuthorizedReplayResult =
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "replay"; revision: BookingGuestPolicyRevision }>
  | Readonly<{
      outcome: "rejected";
      error: BookingGuestPolicyCommandError;
    }>;

export interface BookingGuestPolicyAuthorizedReplayPort {
  /** Scope is reauthorized before lookup; a matching completed request is returned without owner reads. */
  findAuthorizedReplay(
    command: UpsertBookingGuestPolicyCommand,
  ): Promise<BookingGuestPolicyAuthorizedReplayResult>;
}

export interface BookingGuestPolicyPersistencePort {
  /** Race-safe reservation and business persistence reauthorize again before replay or mutation. */
  persistGuestPolicy(
    command: PersistBookingGuestPolicyCommand,
  ): Promise<BookingGuestPolicyCommandResult>;
}

/** Typed authorization recheck used by Booking persistence without cross-domain SQL. */
export interface BookingGuestPolicyScopeAuthorizationPort {
  authorizeGuestPolicyScope(
    input: Readonly<{
      organizationId: string;
      propertyId: string;
      actorUserId: string;
      permission: typeof BOOKING_GUEST_POLICY_AUTHORIZATION.permission;
      entitlement: typeof BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement;
      resource: typeof BOOKING_GUEST_POLICY_AUTHORIZATION.resource;
      checkedAt: string;
    }>,
  ): Promise<boolean>;
}

export interface BookingGuestPolicyReadPort {
  getCurrentGuestPolicy(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<BookingGuestPolicyRevision | null>;
  getGuestPolicyPublicProjection(input: {
    propertyId: string;
    revisionId: string;
    guestPolicyRevision: number;
  }): Promise<BookingGuestPolicyPublicProjection | null>;
}

export type RecordBookingGuestPolicyProjectionReceiptCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  revisionId: string;
  guestPolicyRevision: number;
  sourceOutboxEventId: string;
  bundleHash: BookingGuestPolicyHash;
  sourceFingerprint: BookingGuestPolicyHash;
  catalogProfileSourceRevision: string;
  result:
    | Readonly<{ outcome: "applied"; catalogPolicyProjectionRevision: number }>
    | Readonly<{
        outcome: "source_revision_conflict";
        observedCatalogProfileRevision: string;
      }>;
  recordedAt: string;
}>;

export interface BookingGuestPolicyProjectionReceiptPort {
  recordProjectionReceipt(
    command: RecordBookingGuestPolicyProjectionReceiptCommand,
  ): Promise<BookingGuestPolicyProjectionReceipt>;
}

export interface BookingGuestPolicyCatalogProjectionPort {
  projectApprovedGuestPolicy(input: {
    outboxEventId: string;
    projection: BookingGuestPolicyPublicProjection;
  }): Promise<
    | Readonly<{ outcome: "applied"; catalogPolicyProjectionRevision: number }>
    | Readonly<{
        outcome: "source_revision_conflict";
        observedCatalogProfileRevision: string;
      }>
    | Readonly<{ outcome: "unavailable"; errorSource: "provider" | "system" }>
    | Readonly<{ outcome: "malformed" }>
  >;
}

export interface BookingGuestPolicyCatalogProfileEvidencePort {
  readonly bookingGuestPolicyCatalogProfileEvidencePort: "hotel_catalog";
  getCatalogProfileEvidence(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<BookingGuestPolicyCatalogProfileEvidenceResult>;
}

/** Owner-specific read ports; composition must never replace these with cross-domain SQL. */
export type BookingGuestPolicyOwnerEvidencePorts = Readonly<{
  catalogProfile: BookingGuestPolicyCatalogProfileEvidencePort;
  rooms: BookingPricingEvidenceOwnerPorts["rooms"];
  pricing: BookingPricingEvidenceOwnerPorts["pricing"];
  recurringPricing: BookingPricingEvidenceOwnerPorts["recurringPricing"];
  mandatoryChargeConfirmation: BookingPricingEvidenceOwnerPorts["mandatoryChargeConfirmation"];
}>;

export function createBookingGuestPolicyNewDraft(): BookingGuestPolicySetupDraft {
  return Object.freeze({
    defaultGuestLanguage: null,
    childrenEnabled: null,
    adultAgeThreshold: null,
    phoneRequired: BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.phoneRequired,
    arrivalTimeEnabled: BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.arrivalTimeEnabled,
    specialRequestsEnabled: BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.specialRequestsEnabled,
    checkInTime: null,
    checkOutTime: null,
  });
}

export function createBookingGuestPolicyPublicProjection(
  revisionValue: BookingGuestPolicyRevision,
): BookingGuestPolicyPublicProjection {
  const parsed = parseBookingGuestPolicyRevision(revisionValue);
  if (!parsed) throw new TypeError("Booking guest-policy revision is invalid");
  const { bundle } = parsed;
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    propertyId: parsed.propertyId,
    guestPolicyRevision: parsed.revision,
    catalogProfileSourceRevision: parsed.catalogProfileSourceRevision,
    sourceFingerprint: bundle.sourceFingerprint,
    bundleHash: bundle.bundleHash,
    policy: {
      childrenEnabled: bundle.choices.childrenEnabled,
      adultAgeThreshold: bundle.choices.childrenEnabled ? bundle.choices.adultAgeThreshold : null,
      checkInTime: bundle.choices.checkInTime,
      checkOutTime: bundle.choices.checkOutTime,
      pricingCurrency: bundle.pricingCurrency,
      propertyTimeZone: bundle.propertyTimeZone,
      rates: bundle.rates.map(({ roomTypeId, flexible, nonRefundable, additionalGuest }) => ({
        roomTypeId,
        flexible: {
          freeCancellationDeadlineDays: flexible.freeCancellationDeadlineDays,
          cutoff: { ...flexible.cutoff },
          afterDeadlinePenalty: flexible.afterDeadlinePenalty,
          noShowPenalty: flexible.noShowPenalty,
        },
        nonRefundable: nonRefundable
          ? {
              refundPolicy: nonRefundable.refundPolicy,
              noShowPenalty: nonRefundable.noShowPenalty,
              paymentTiming: nonRefundable.paymentTiming,
            }
          : null,
        additionalGuest: additionalGuest
          ? {
              includedGuestsPerRoom: additionalGuest.includedGuestsPerRoom,
              amountDecimal: additionalGuest.amountDecimal,
              currency: additionalGuest.currency,
              countedGuestTypes:
                additionalGuest.countedGuestTypes.length === 1
                  ? (["adult"] as const)
                  : (["adult", "child"] as const),
            }
          : null,
      })),
    },
  });
}

export function parseBookingGuestPolicyPublicProjection(
  value: unknown,
): BookingGuestPolicyPublicProjection | null {
  if (
    !exact(value, [
      "contractVersion",
      "propertyId",
      "guestPolicyRevision",
      "catalogProfileSourceRevision",
      "sourceFingerprint",
      "bundleHash",
      "policy",
    ]) ||
    value.contractVersion !== BOOKING_GUEST_POLICY_CONTRACT_VERSION ||
    !canonicalUuid(value.propertyId) ||
    !revision(value.guestPolicyRevision, false) ||
    !profileRevision(value.catalogProfileSourceRevision) ||
    !parseBookingGuestPolicyHash(value.sourceFingerprint) ||
    !parseBookingGuestPolicyHash(value.bundleHash) ||
    !exact(value.policy, [
      "childrenEnabled",
      "adultAgeThreshold",
      "checkInTime",
      "checkOutTime",
      "pricingCurrency",
      "propertyTimeZone",
      "rates",
    ]) ||
    typeof value.policy.childrenEnabled !== "boolean" ||
    (value.policy.childrenEnabled
      ? !integer(value.policy.adultAgeThreshold, 1, 21)
      : value.policy.adultAgeThreshold !== null) ||
    !localTime(value.policy.checkInTime) ||
    !localTime(value.policy.checkOutTime) ||
    typeof value.policy.pricingCurrency !== "string" ||
    !/^[A-Z]{3}$/.test(value.policy.pricingCurrency) ||
    typeof value.policy.propertyTimeZone !== "string" ||
    !timeZone(value.policy.propertyTimeZone) ||
    !Array.isArray(value.policy.rates)
  )
    return null;
  const policy = value.policy;
  const childrenEnabled = policy.childrenEnabled as boolean;
  const adultAgeThreshold = policy.adultAgeThreshold as number | null;
  const checkInTime = policy.checkInTime as string;
  const checkOutTime = policy.checkOutTime as string;
  const pricingCurrency = policy.pricingCurrency as string;
  const propertyTimeZone = policy.propertyTimeZone as string;
  const rates = (policy.rates as unknown[]).map((rate) =>
    parsePublicRate(rate, pricingCurrency, propertyTimeZone, childrenEnabled),
  );
  if (
    rates.some((rate) => rate === null) ||
    rates.some((rate, index) => index > 0 && rates[index - 1]!.roomTypeId >= rate!.roomTypeId)
  )
    return null;
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    propertyId: value.propertyId,
    guestPolicyRevision: value.guestPolicyRevision,
    catalogProfileSourceRevision: value.catalogProfileSourceRevision,
    sourceFingerprint: value.sourceFingerprint as BookingGuestPolicyHash,
    bundleHash: value.bundleHash as BookingGuestPolicyHash,
    policy: {
      childrenEnabled,
      adultAgeThreshold,
      checkInTime,
      checkOutTime,
      pricingCurrency,
      propertyTimeZone,
      rates: rates as BookingGuestPolicyPublicProjection["policy"]["rates"],
    },
  });
}

export function parseBookingGuestPolicyRevision(value: unknown): BookingGuestPolicyRevision | null {
  if (
    !exact(value, [
      "contractVersion",
      "revisionId",
      "organizationId",
      "propertyId",
      "revision",
      "catalogProfileSourceRevision",
      "bundle",
      "confirmation",
      "projectionReceipt",
      "outboxEventId",
      "acceptedAt",
    ]) ||
    value.contractVersion !== BOOKING_GUEST_POLICY_CONTRACT_VERSION ||
    !canonicalUuid(value.revisionId) ||
    !canonicalUuid(value.organizationId) ||
    !canonicalUuid(value.propertyId) ||
    !revision(value.revision, false) ||
    !profileRevision(value.catalogProfileSourceRevision) ||
    !canonicalUuid(value.outboxEventId) ||
    !iso(value.acceptedAt)
  )
    return null;
  const bundle = parseBookingGuestPolicyBundle(value.bundle);
  const confirmation = parsePolicyConfirmation(value.confirmation);
  const projectionReceipt = parseBookingGuestPolicyProjectionReceipt(value.projectionReceipt);
  if (
    !bundle ||
    !confirmation ||
    (value.projectionReceipt !== null && projectionReceipt === null) ||
    bundle.organizationId !== value.organizationId ||
    bundle.propertyId !== value.propertyId ||
    !bundle.sourceBindings.some(
      (source) =>
        source.ownerDomain === "hotel_catalog" &&
        source.entityType === "property_profile" &&
        source.entityId === value.propertyId &&
        source.revision === value.catalogProfileSourceRevision,
    ) ||
    (projectionReceipt !== null &&
      (projectionReceipt.projectedGuestPolicyRevision > value.revision ||
        projectionReceipt.projectedBundleHash !== bundle.bundleHash ||
        projectionReceipt.projectedSourceFingerprint !== bundle.sourceFingerprint ||
        projectionReceipt.catalogProfileSourceRevision !== value.catalogProfileSourceRevision))
  )
    return null;
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    revisionId: value.revisionId,
    organizationId: value.organizationId,
    propertyId: value.propertyId,
    revision: value.revision,
    catalogProfileSourceRevision: value.catalogProfileSourceRevision,
    bundle,
    confirmation,
    projectionReceipt,
    outboxEventId: value.outboxEventId,
    acceptedAt: value.acceptedAt,
  });
}

export function parseBookingGuestPolicyBundle(value: unknown): BookingGuestPolicyBundle | null {
  if (
    !exact(value, [
      "contractVersion",
      "organizationId",
      "propertyId",
      "choices",
      "pricingCurrency",
      "propertyTimeZone",
      "pricingSourceFingerprint",
      "mandatoryChargeConfirmationRevision",
      "sourceBindings",
      "sourceFingerprint",
      "rates",
      "bundleHash",
    ]) ||
    value.contractVersion !== BOOKING_GUEST_POLICY_CONTRACT_VERSION ||
    !canonicalUuid(value.organizationId) ||
    !canonicalUuid(value.propertyId) ||
    typeof value.pricingCurrency !== "string" ||
    !/^[A-Z]{3}$/.test(value.pricingCurrency) ||
    typeof value.propertyTimeZone !== "string" ||
    !timeZone(value.propertyTimeZone) ||
    typeof value.pricingSourceFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.pricingSourceFingerprint) ||
    !revision(value.mandatoryChargeConfirmationRevision, false) ||
    !Array.isArray(value.sourceBindings) ||
    !Array.isArray(value.rates)
  )
    return null;
  const choices = parseBookingGuestPolicyChoices(value.choices);
  const sourceFingerprint = parseBookingGuestPolicyHash(value.sourceFingerprint);
  const bundleHash = parseBookingGuestPolicyHash(value.bundleHash);
  const sourceBindings = value.sourceBindings.map((source) => parseSourceBinding(source));
  const rates = value.rates.map((rate) =>
    parseRate(rate, value.propertyTimeZone as string, value.pricingCurrency as string, choices),
  );
  if (
    !choices ||
    !sourceFingerprint ||
    !bundleHash ||
    sourceBindings.some((source) => !source) ||
    rates.some((rate) => !rate)
  )
    return null;
  const bindings = sourceBindings as BookingGuestPolicyBundle["sourceBindings"];
  const disclosures = rates as BookingGuestPolicyBundle["rates"];
  const catalogSources = bindings.filter(({ ownerDomain }) => ownerDomain === "hotel_catalog");
  const currencySources = sourcesOfType(bindings, "pms_property_pricing_currency.v1");
  const optionalAggregateSources = sourcesOfType(bindings, "pms_optional_pricing_aggregate.v1");
  const roomFactsSources = sourcesOfType(bindings, "pms_room_facts.v1");
  const flexibleSources = sourcesOfType(bindings, "pms_flexible_rate_plan.v1");
  const confirmationSources = sourcesOfType(bindings, "pms_mandatory_charge_confirmation.v1");
  if (
    !canonicalSources(bindings) ||
    !canonicalRates(disclosures) ||
    catalogSources.length !== 1 ||
    catalogSources[0]?.entityType !== "property_profile" ||
    catalogSources[0].entityId !== value.propertyId ||
    currencySources.length !== 1 ||
    currencySources[0]?.entityId !== value.propertyId ||
    optionalAggregateSources.length !== 1 ||
    optionalAggregateSources[0]?.entityId !== value.propertyId ||
    confirmationSources.length !== 1 ||
    confirmationSources[0]?.entityId !== value.propertyId ||
    confirmationSources[0].revision !== String(value.mandatoryChargeConfirmationRevision) ||
    roomFactsSources.length !== disclosures.length ||
    flexibleSources.length !== disclosures.length ||
    disclosures.some(
      ({ roomTypeId, roomFactsRevision, flexible, nonRefundable, additionalGuest }) =>
        !roomFactsSources.some(
          (source) =>
            source.entityId === roomTypeId && source.revision === String(roomFactsRevision),
        ) ||
        !hasSource(bindings, flexible.source) ||
        (nonRefundable !== null && !hasSource(bindings, nonRefundable.source.source)) ||
        (additionalGuest !== null && !hasSource(bindings, additionalGuest.source.source)),
    )
  )
    return null;
  const expectedSourceFingerprint = digest([
    BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    value.pricingSourceFingerprint,
    value.mandatoryChargeConfirmationRevision,
    bindings,
    disclosures.map(
      ({ roomTypeId, roomFactsRevision, flexible, nonRefundable, additionalGuest }) => [
        roomTypeId,
        roomFactsRevision,
        flexible.source,
        nonRefundable?.source ?? null,
        additionalGuest?.source ?? null,
      ],
    ),
  ]);
  const expectedBundleHash = digest([
    BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    expectedSourceFingerprint,
    {
      childrenEnabled: choices.childrenEnabled,
      adultAgeThreshold: choices.childrenEnabled ? choices.adultAgeThreshold : null,
      checkInTime: choices.checkInTime,
      checkOutTime: choices.checkOutTime,
    },
    value.pricingCurrency,
    value.propertyTimeZone,
    disclosures,
  ]);
  if (sourceFingerprint !== expectedSourceFingerprint || bundleHash !== expectedBundleHash)
    return null;
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    organizationId: value.organizationId,
    propertyId: value.propertyId,
    choices,
    pricingCurrency: value.pricingCurrency,
    propertyTimeZone: value.propertyTimeZone,
    pricingSourceFingerprint: value.pricingSourceFingerprint,
    mandatoryChargeConfirmationRevision: value.mandatoryChargeConfirmationRevision,
    sourceBindings: bindings,
    sourceFingerprint,
    rates: disclosures,
    bundleHash,
  }) as BookingGuestPolicyBundle;
}

export function parseBookingGuestPolicyComposition(
  value: unknown,
): BookingGuestPolicyComposition | null {
  if (exact(value, ["outcome", "bundle"]) && value.outcome === "ready") {
    const bundle = parseBookingGuestPolicyBundle(value.bundle);
    return bundle ? Object.freeze({ outcome: "ready", bundle }) : null;
  }
  if (
    !exact(value, [
      "outcome",
      "organizationId",
      "propertyId",
      "sourceBindings",
      "sourceFingerprint",
      "blockers",
    ]) ||
    value.outcome !== "blocked" ||
    !canonicalUuid(value.organizationId) ||
    !canonicalUuid(value.propertyId) ||
    !Array.isArray(value.sourceBindings) ||
    !Array.isArray(value.blockers)
  )
    return null;
  const sourceBindings = value.sourceBindings.map(parseSourceBinding);
  const sourceFingerprint = parseBookingGuestPolicyHash(value.sourceFingerprint);
  const blockers = value.blockers.map(parseCompositionBlocker);
  if (
    !sourceFingerprint ||
    sourceBindings.some((source) => !source) ||
    blockers.length === 0 ||
    blockers.some((candidate) => !candidate) ||
    !canonicalSources(sourceBindings as BookingGuestPolicySourceBinding[])
  )
    return null;
  return deepFreeze({
    outcome: "blocked",
    organizationId: value.organizationId,
    propertyId: value.propertyId,
    sourceBindings: sourceBindings as BookingGuestPolicySourceBinding[],
    sourceFingerprint,
    blockers: blockers as BookingGuestPolicyCompositionBlocker[],
  });
}

export function parseBookingGuestPolicySetupAggregate(
  value: unknown,
): BookingGuestPolicySetupAggregate | null {
  if (
    !exact(value, [
      "contractVersion",
      "organizationId",
      "propertyId",
      "supportedLanguages",
      "draft",
      "current",
      "composition",
    ]) ||
    value.contractVersion !== BOOKING_GUEST_POLICY_CONTRACT_VERSION ||
    !canonicalUuid(value.organizationId) ||
    !canonicalUuid(value.propertyId) ||
    !Array.isArray(value.supportedLanguages) ||
    value.supportedLanguages.length !== BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES.length ||
    !value.supportedLanguages.every(
      (language, index) => language === BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES[index],
    )
  )
    return null;
  const current = value.current === null ? null : parseBookingGuestPolicyRevision(value.current);
  const composition =
    value.composition === null ? null : parseBookingGuestPolicyComposition(value.composition);
  const draft = value.draft === null ? null : parseNewDraft(value.draft);
  if (
    (value.current !== null && !current) ||
    (value.composition !== null && !composition) ||
    (value.draft !== null && !draft) ||
    (current === null
      ? !draft || composition !== null
      : draft !== null ||
        !composition ||
        current.organizationId !== value.organizationId ||
        current.propertyId !== value.propertyId ||
        compositionScope(composition).organizationId !== value.organizationId ||
        compositionScope(composition).propertyId !== value.propertyId)
  )
    return null;
  return deepFreeze({
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    organizationId: value.organizationId,
    propertyId: value.propertyId,
    supportedLanguages: BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
    draft,
    current,
    composition,
  });
}

export function parseUpsertBookingGuestPolicyRequest(
  value: unknown,
): UpsertBookingGuestPolicyRequest | null {
  if (
    !exact(value, [
      "expectedRevision",
      "expectedSourceFingerprint",
      "choices",
      "confirmPolicyBundle",
    ]) ||
    !revision(value.expectedRevision, true) ||
    value.expectedRevision === 2_147_483_647 ||
    typeof value.confirmPolicyBundle !== "boolean"
  )
    return null;
  const sourceFingerprint = parseBookingGuestPolicyHash(value.expectedSourceFingerprint);
  const choices = parseBookingGuestPolicyChoices(value.choices);
  return sourceFingerprint && choices
    ? deepFreeze({
        expectedRevision: value.expectedRevision,
        expectedSourceFingerprint: sourceFingerprint,
        choices,
        confirmPolicyBundle: value.confirmPolicyBundle,
      })
    : null;
}

export function parseBookingGuestPolicyCommandResult(
  value: unknown,
  command: UpsertBookingGuestPolicyCommand,
): BookingGuestPolicyCommandResult | null {
  try {
    serializeBookingGuestPolicyCommandFingerprint(command);
  } catch {
    return null;
  }
  if (exact(value, ["ok", "outcome", "revision"]) && value.ok === true) {
    const revisionValue = parseBookingGuestPolicyRevision(value.revision);
    const expectedOutcome = command.expectedRevision === 0 ? "created" : "updated";
    const outcome = value.outcome;
    if (
      !revisionValue ||
      (outcome !== expectedOutcome && outcome !== "idempotent_replay") ||
      revisionValue.organizationId !== command.organizationId.toLowerCase() ||
      revisionValue.propertyId !== command.propertyId.toLowerCase() ||
      revisionValue.revision !== command.expectedRevision + 1 ||
      revisionValue.bundle.sourceFingerprint !== command.expectedSourceFingerprint ||
      JSON.stringify(canonicalChoices(revisionValue.bundle.choices)) !==
        JSON.stringify(canonicalChoices(command.choices))
    )
      return null;
    return Object.freeze({
      ok: true,
      outcome: outcome as "created" | "updated" | "idempotent_replay",
      revision: revisionValue,
    });
  }
  if (!exact(value, ["ok", "error"]) || value.ok !== false) return null;
  const error = parseCommandError(value.error);
  return error ? deepFreeze({ ok: false, error }) : null;
}

export function serializeBookingGuestPolicyCommandFingerprint(
  command: UpsertBookingGuestPolicyCommand,
): string {
  if (
    !uuid(command.organizationId) ||
    !uuid(command.propertyId) ||
    !parseBookingGuestPolicyHash(command.expectedSourceFingerprint) ||
    !parseBookingGuestPolicyChoices(command.choices) ||
    !revision(command.expectedRevision, true) ||
    command.expectedRevision === 2_147_483_647
  )
    throw new TypeError("Booking guest-policy command is invalid");
  return JSON.stringify({
    organizationId: command.organizationId.toLowerCase(),
    propertyId: command.propertyId.toLowerCase(),
    expectedRevision: command.expectedRevision,
    expectedSourceFingerprint: command.expectedSourceFingerprint,
    choices: canonicalChoices(command.choices),
    confirmPolicyBundle: command.confirmPolicyBundle,
  });
}

function canonicalChoices(choices: BookingGuestPolicyChoices) {
  return {
    defaultGuestLanguage: choices.defaultGuestLanguage,
    childrenEnabled: choices.childrenEnabled,
    adultAgeThreshold: choices.adultAgeThreshold,
    phoneRequired: choices.phoneRequired,
    arrivalTimeEnabled: choices.arrivalTimeEnabled,
    specialRequestsEnabled: choices.specialRequestsEnabled,
    checkInTime: choices.checkInTime,
    checkOutTime: choices.checkOutTime,
  };
}

export function parseBookingGuestPolicyChangedEvent(
  value: unknown,
): BookingGuestPolicyChangedEvent | null {
  if (
    !exact(value, [
      "contractVersion",
      "eventType",
      "revisionId",
      "propertyId",
      "guestPolicyRevision",
      "confirmationRevision",
      "outcome",
    ]) ||
    value.contractVersion !== BOOKING_GUEST_POLICY_CONTRACT_VERSION ||
    value.eventType !== BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE ||
    !uuid(value.revisionId) ||
    !uuid(value.propertyId) ||
    !revision(value.guestPolicyRevision, false) ||
    !revision(value.confirmationRevision, false) ||
    (value.outcome !== "created" && value.outcome !== "updated")
  )
    return null;
  return Object.freeze({
    contractVersion: value.contractVersion,
    eventType: value.eventType,
    revisionId: value.revisionId.toLowerCase(),
    propertyId: value.propertyId.toLowerCase(),
    guestPolicyRevision: value.guestPolicyRevision,
    confirmationRevision: value.confirmationRevision,
    outcome: value.outcome,
  });
}

function parsePolicyConfirmation(value: unknown): BookingPolicyConfirmation | null {
  if (
    !exact(value, [
      "confirmationId",
      "confirmationRevision",
      "basis",
      "basedOnConfirmationId",
      "reviewedAt",
      "recordedAt",
    ]) ||
    !canonicalUuid(value.confirmationId) ||
    !revision(value.confirmationRevision, false) ||
    (value.basis !== "explicit" && value.basis !== "unchanged_policy_bundle") ||
    !iso(value.reviewedAt) ||
    !iso(value.recordedAt) ||
    value.reviewedAt > value.recordedAt ||
    (value.basis === "explicit"
      ? value.basedOnConfirmationId !== null
      : !canonicalUuid(value.basedOnConfirmationId))
  )
    return null;
  return Object.freeze({
    confirmationId: value.confirmationId,
    confirmationRevision: value.confirmationRevision,
    basis: value.basis,
    basedOnConfirmationId: value.basedOnConfirmationId as string | null,
    reviewedAt: value.reviewedAt,
    recordedAt: value.recordedAt,
  });
}

export function parseBookingGuestPolicyProjectionReceipt(
  value: unknown,
): BookingGuestPolicyProjectionReceipt | null {
  if (value === null) return null;
  const common = [
    "outcome",
    "receiptId",
    "sourceOutboxEventId",
    "projectedGuestPolicyRevision",
    "projectedBundleHash",
    "projectedSourceFingerprint",
    "catalogProfileSourceRevision",
    "recordedAt",
  ];
  const outcome =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.getOwnPropertyDescriptor(value, "outcome")?.value
      : null;
  const resultKey =
    outcome === "applied"
      ? "catalogPolicyProjectionRevision"
      : outcome === "source_revision_conflict"
        ? "observedCatalogProfileRevision"
        : null;
  if (
    !resultKey ||
    !exact(value, [...common, resultKey]) ||
    !canonicalUuid(value.receiptId) ||
    !canonicalUuid(value.sourceOutboxEventId) ||
    !revision(value.projectedGuestPolicyRevision, false) ||
    !parseBookingGuestPolicyHash(value.projectedBundleHash) ||
    !parseBookingGuestPolicyHash(value.projectedSourceFingerprint) ||
    !profileRevision(value.catalogProfileSourceRevision) ||
    !iso(value.recordedAt)
  )
    return null;
  if (value.outcome === "applied") {
    if (!revision(value.catalogPolicyProjectionRevision, false)) return null;
    return Object.freeze({
      outcome: value.outcome,
      receiptId: value.receiptId,
      sourceOutboxEventId: value.sourceOutboxEventId,
      projectedGuestPolicyRevision: value.projectedGuestPolicyRevision,
      projectedBundleHash: value.projectedBundleHash as BookingGuestPolicyHash,
      projectedSourceFingerprint: value.projectedSourceFingerprint as BookingGuestPolicyHash,
      catalogProfileSourceRevision: value.catalogProfileSourceRevision,
      catalogPolicyProjectionRevision: value.catalogPolicyProjectionRevision,
      recordedAt: value.recordedAt,
    });
  }
  if (
    !profileRevision(value.observedCatalogProfileRevision) ||
    value.observedCatalogProfileRevision === value.catalogProfileSourceRevision
  )
    return null;
  return Object.freeze({
    outcome: "source_revision_conflict",
    receiptId: value.receiptId,
    sourceOutboxEventId: value.sourceOutboxEventId,
    projectedGuestPolicyRevision: value.projectedGuestPolicyRevision,
    projectedBundleHash: value.projectedBundleHash as BookingGuestPolicyHash,
    projectedSourceFingerprint: value.projectedSourceFingerprint as BookingGuestPolicyHash,
    catalogProfileSourceRevision: value.catalogProfileSourceRevision,
    observedCatalogProfileRevision: value.observedCatalogProfileRevision,
    recordedAt: value.recordedAt,
  });
}

function parseCompositionBlocker(value: unknown): BookingGuestPolicyCompositionBlocker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const optionalKeys = ["roomTypeId", "sourceId"].filter((key) => Object.hasOwn(value, key));
  if (
    !exact(value, ["code", ...optionalKeys]) ||
    !COMPOSITION_BLOCKER_CODES.has(value.code as BookingGuestPolicyCompositionBlocker["code"]) ||
    (Object.hasOwn(value, "roomTypeId") && !canonicalUuid(value.roomTypeId)) ||
    (Object.hasOwn(value, "sourceId") && !canonicalUuid(value.sourceId))
  )
    return null;
  return Object.freeze({
    code: value.code as BookingGuestPolicyCompositionBlocker["code"],
    ...(typeof value.roomTypeId === "string" ? { roomTypeId: value.roomTypeId } : {}),
    ...(typeof value.sourceId === "string" ? { sourceId: value.sourceId } : {}),
  });
}

const COMPOSITION_BLOCKER_CODES = new Set<BookingGuestPolicyCompositionBlocker["code"]>([
  "pricing_source_invalid",
  "pricing_source_missing",
  "pricing_currency_mismatch",
  "property_timezone_missing",
  "property_timezone_invalid",
  "property_profile_unavailable",
  "property_profile_malformed",
  "room_capacity_missing",
  "room_capacity_invalid",
  "child_policy_capacity_incompatible",
  "mandatory_charge_confirmation_missing",
  "mandatory_charge_confirmation_unavailable",
  "mandatory_charge_confirmation_malformed",
  "mandatory_charge_confirmation_stale",
  "flexible_rate_policy_missing",
  "optional_rate_policy_invalid",
]);

function parseNewDraft(value: unknown): BookingGuestPolicySetupDraft | null {
  return exact(value, [
    "defaultGuestLanguage",
    "childrenEnabled",
    "adultAgeThreshold",
    "phoneRequired",
    "arrivalTimeEnabled",
    "specialRequestsEnabled",
    "checkInTime",
    "checkOutTime",
  ]) &&
    value.defaultGuestLanguage === null &&
    value.childrenEnabled === null &&
    value.adultAgeThreshold === null &&
    value.phoneRequired === BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.phoneRequired &&
    value.arrivalTimeEnabled === BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.arrivalTimeEnabled &&
    value.specialRequestsEnabled ===
      BOOKING_GUEST_POLICY_NEW_DRAFT_DEFAULTS.specialRequestsEnabled &&
    value.checkInTime === null &&
    value.checkOutTime === null
    ? createBookingGuestPolicyNewDraft()
    : null;
}

function compositionScope(
  composition: BookingGuestPolicyComposition,
): Readonly<{ organizationId: string; propertyId: string }> {
  return composition.outcome === "ready"
    ? {
        organizationId: composition.bundle.organizationId,
        propertyId: composition.bundle.propertyId,
      }
    : { organizationId: composition.organizationId, propertyId: composition.propertyId };
}

function parseCommandError(value: unknown): BookingGuestPolicyCommandError | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
  if (
    (code === "command_in_progress" ||
      code === "idempotency_key_conflict" ||
      code === "setup_scope_unavailable" ||
      code === "policy_confirmation_required") &&
    exact(value, ["code"])
  )
    return Object.freeze({ code });
  if (
    code === "guest_policy_revision_conflict" &&
    exact(value, ["code", "currentRevision"]) &&
    revision(value.currentRevision, true)
  )
    return Object.freeze({ code, currentRevision: value.currentRevision });
  if (code === "source_revision_conflict" && exact(value, ["code", "currentSourceFingerprint"])) {
    const currentSourceFingerprint = parseBookingGuestPolicyHash(value.currentSourceFingerprint);
    return currentSourceFingerprint ? Object.freeze({ code, currentSourceFingerprint }) : null;
  }
  if (
    code === "guest_policy_not_ready" &&
    exact(value, ["code", "blockers"]) &&
    Array.isArray(value.blockers)
  ) {
    const blockers = value.blockers.map(parseCompositionBlocker);
    return blockers.length > 0 && blockers.every((candidate) => candidate !== null)
      ? deepFreeze({ code, blockers: blockers as BookingGuestPolicyCompositionBlocker[] })
      : null;
  }
  return null;
}

function parseSourceBinding(value: unknown): BookingGuestPolicySourceBinding | null {
  if (
    !exact(value, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    !canonicalUuid(value.entityId) ||
    typeof value.revision !== "string"
  )
    return null;
  if (
    value.ownerDomain === "hotel_catalog" &&
    value.entityType === "property_profile" &&
    profileRevision(value.revision)
  )
    return Object.freeze({
      ownerDomain: value.ownerDomain,
      entityType: value.entityType,
      entityId: value.entityId,
      revision: value.revision,
    });
  if (
    value.ownerDomain !== "pms" ||
    ![
      "pms_property_pricing_currency.v1",
      "pms_optional_pricing_aggregate.v1",
      "pms_room_facts.v1",
      "pms_flexible_rate_plan.v1",
      "pms_recurring_pricing_rule.v1",
      "pms_mandatory_charge_confirmation.v1",
    ].includes(String(value.entityType)) ||
    !serializedRevision(value.revision)
  )
    return null;
  return Object.freeze({
    ownerDomain: value.ownerDomain,
    entityType: value.entityType as string,
    entityId: value.entityId,
    revision: value.revision,
  });
}

function parseRate(
  value: unknown,
  propertyTimeZone: string,
  pricingCurrency: string,
  choices: BookingGuestPolicyChoices | null,
): BookingGuestPolicyRateDisclosure | null {
  if (
    !choices ||
    !exact(value, [
      "roomTypeId",
      "roomFactsRevision",
      "flexible",
      "nonRefundable",
      "additionalGuest",
    ]) ||
    !canonicalUuid(value.roomTypeId) ||
    !revision(value.roomFactsRevision, false) ||
    !exact(value.flexible, [
      "source",
      "freeCancellationDeadlineDays",
      "cutoff",
      "afterDeadlinePenalty",
      "noShowPenalty",
    ])
  )
    return null;
  const flexibleSource = parseSourceBinding(value.flexible.source);
  if (
    !flexibleSource ||
    flexibleSource.ownerDomain !== "pms" ||
    flexibleSource.entityType !== "pms_flexible_rate_plan.v1" ||
    !integer(value.flexible.freeCancellationDeadlineDays, 0, 365) ||
    !exact(value.flexible.cutoff, ["localTime", "timeZone"]) ||
    !localTime(value.flexible.cutoff.localTime) ||
    value.flexible.cutoff.timeZone !== propertyTimeZone ||
    value.flexible.afterDeadlinePenalty !== "full_booking_amount" ||
    value.flexible.noShowPenalty !== "full_booking_amount"
  )
    return null;
  const nonRefundable = parseNonRefundable(value.nonRefundable);
  const additionalGuest = parseAdditionalGuest(value.additionalGuest, pricingCurrency, choices);
  if (nonRefundable === undefined || additionalGuest === undefined) return null;
  return deepFreeze({
    roomTypeId: value.roomTypeId,
    roomFactsRevision: value.roomFactsRevision,
    flexible: {
      source: flexibleSource,
      freeCancellationDeadlineDays: value.flexible.freeCancellationDeadlineDays,
      cutoff: {
        localTime: value.flexible.cutoff.localTime,
        timeZone: value.flexible.cutoff.timeZone,
      },
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
    nonRefundable,
    additionalGuest,
  }) as BookingGuestPolicyRateDisclosure;
}

function parsePublicRate(
  value: unknown,
  pricingCurrency: string,
  propertyTimeZone: string,
  childrenEnabled: boolean,
): BookingGuestPolicyPublicProjection["policy"]["rates"][number] | null {
  if (
    !exact(value, ["roomTypeId", "flexible", "nonRefundable", "additionalGuest"]) ||
    !canonicalUuid(value.roomTypeId) ||
    !exact(value.flexible, [
      "freeCancellationDeadlineDays",
      "cutoff",
      "afterDeadlinePenalty",
      "noShowPenalty",
    ]) ||
    !integer(value.flexible.freeCancellationDeadlineDays, 0, 365) ||
    !exact(value.flexible.cutoff, ["localTime", "timeZone"]) ||
    !localTime(value.flexible.cutoff.localTime) ||
    value.flexible.cutoff.timeZone !== propertyTimeZone ||
    value.flexible.afterDeadlinePenalty !== "full_booking_amount" ||
    value.flexible.noShowPenalty !== "full_booking_amount"
  )
    return null;
  const nonRefundable = parsePublicNonRefundable(value.nonRefundable);
  const additionalGuest = parsePublicAdditionalGuest(
    value.additionalGuest,
    pricingCurrency,
    childrenEnabled,
  );
  if (nonRefundable === undefined || additionalGuest === undefined) return null;
  return deepFreeze({
    roomTypeId: value.roomTypeId,
    flexible: {
      freeCancellationDeadlineDays: value.flexible.freeCancellationDeadlineDays,
      cutoff: {
        localTime: value.flexible.cutoff.localTime,
        timeZone: value.flexible.cutoff.timeZone,
      },
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
    nonRefundable,
    additionalGuest,
  });
}

function parsePublicNonRefundable(
  value: unknown,
): BookingGuestPolicyPublicProjection["policy"]["rates"][number]["nonRefundable"] | undefined {
  if (value === null) return null;
  return exact(value, ["refundPolicy", "noShowPenalty", "paymentTiming"]) &&
    value.refundPolicy === "no_refund" &&
    value.noShowPenalty === "full_booking_amount" &&
    value.paymentTiming === "prepay_full"
    ? Object.freeze({
        refundPolicy: "no_refund",
        noShowPenalty: "full_booking_amount",
        paymentTiming: "prepay_full",
      })
    : undefined;
}

function parsePublicAdditionalGuest(
  value: unknown,
  pricingCurrency: string,
  childrenEnabled: boolean,
): BookingGuestPolicyPublicProjection["policy"]["rates"][number]["additionalGuest"] | undefined {
  if (value === null) return null;
  if (
    !exact(value, ["includedGuestsPerRoom", "amountDecimal", "currency", "countedGuestTypes"]) ||
    !integer(value.includedGuestsPerRoom, 1, 99) ||
    typeof value.amountDecimal !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(value.amountDecimal) ||
    value.currency !== pricingCurrency ||
    !guestTypes(value.countedGuestTypes, childrenEnabled)
  )
    return undefined;
  return Object.freeze({
    includedGuestsPerRoom: value.includedGuestsPerRoom,
    amountDecimal: value.amountDecimal,
    currency: value.currency,
    countedGuestTypes: childrenEnabled ? (["adult", "child"] as const) : (["adult"] as const),
  });
}

function parseNonRefundable(
  value: unknown,
): BookingGuestPolicyRateDisclosure["nonRefundable"] | undefined {
  if (value === null) return null;
  if (
    !exact(value, ["source", "refundPolicy", "noShowPenalty", "paymentTiming"]) ||
    value.refundPolicy !== "no_refund" ||
    value.noShowPenalty !== "full_booking_amount" ||
    value.paymentTiming !== "prepay_full"
  )
    return undefined;
  const source = parseRecurringSource(value.source);
  return source
    ? Object.freeze({
        source,
        refundPolicy: value.refundPolicy,
        noShowPenalty: value.noShowPenalty,
        paymentTiming: value.paymentTiming,
      })
    : undefined;
}

function parseAdditionalGuest(
  value: unknown,
  pricingCurrency: string,
  choices: BookingGuestPolicyChoices,
): BookingGuestPolicyRateDisclosure["additionalGuest"] | undefined {
  if (value === null) return null;
  if (
    !exact(value, [
      "source",
      "includedGuestsPerRoom",
      "amountDecimal",
      "currency",
      "countedGuestTypes",
    ]) ||
    !integer(value.includedGuestsPerRoom, 1, 99) ||
    typeof value.amountDecimal !== "string" ||
    !/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(value.amountDecimal) ||
    value.currency !== pricingCurrency ||
    !guestTypes(value.countedGuestTypes, choices.childrenEnabled)
  )
    return undefined;
  const source = parseRecurringSource(value.source);
  return source
    ? Object.freeze({
        source,
        includedGuestsPerRoom: value.includedGuestsPerRoom,
        amountDecimal: value.amountDecimal,
        currency: value.currency,
        countedGuestTypes: choices.childrenEnabled
          ? (["adult", "child"] as const)
          : (["adult"] as const),
      })
    : undefined;
}

function parseRecurringSource(value: unknown): BookingGuestPolicyRecurringSourceBinding | null {
  if (!exact(value, ["source", "validationRevision", "materializationRevision"])) return null;
  const source = parseSourceBinding(value.source);
  return source &&
    source.ownerDomain === "pms" &&
    source.entityType === "pms_recurring_pricing_rule.v1" &&
    revision(value.validationRevision, false) &&
    revision(value.materializationRevision, false)
    ? Object.freeze({
        source: source as BookingGuestPolicyRecurringSourceBinding["source"],
        validationRevision: value.validationRevision,
        materializationRevision: value.materializationRevision,
      })
    : null;
}

function canonicalSources(sources: readonly BookingGuestPolicySourceBinding[]): boolean {
  return sources.every((source, index) => {
    if (index === 0) return true;
    const prior = sources[index - 1]!;
    return sourceTuple(prior) < sourceTuple(source);
  });
}

function canonicalRates(rates: readonly BookingGuestPolicyRateDisclosure[]): boolean {
  return rates.every(
    (rate, index) => index === 0 || rates[index - 1]!.roomTypeId < rate.roomTypeId,
  );
}

function hasSource(
  sources: readonly BookingGuestPolicySourceBinding[],
  expected: BookingGuestPolicySourceBinding,
): boolean {
  const tuple = sourceTuple(expected);
  return sources.some((source) => sourceTuple(source) === tuple);
}

function sourcesOfType(
  sources: readonly BookingGuestPolicySourceBinding[],
  entityType: string,
): readonly BookingGuestPolicySourceBinding[] {
  return sources.filter(
    (source) => source.ownerDomain === "pms" && source.entityType === entityType,
  );
}

function sourceTuple(source: BookingGuestPolicySourceBinding): string {
  return JSON.stringify([source.ownerDomain, source.entityType, source.entityId, source.revision]);
}

function digest(value: unknown): BookingGuestPolicyHash {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function guestTypes(value: unknown, childrenEnabled: boolean): boolean {
  return (
    Array.isArray(value) &&
    (childrenEnabled
      ? value.length === 2 && value[0] === "adult" && value[1] === "child"
      : value.length === 1 && value[0] === "adult")
  );
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function serializedRevision(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  return Number(value) <= 2_147_483_647;
}

function profileRevision(value: unknown): value is string {
  return typeof value === "string" && /^profile:[1-9][0-9]*$/.test(value);
}

function localTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

function timeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value.trim() === value && value.length > 0;
  } catch {
    return false;
  }
}

function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalUuid(value: unknown): value is string {
  return uuid(value) && value === value.toLowerCase();
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function revision(value: unknown, zero: boolean): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= (zero ? 0 : 1) && Number(value) <= 2_147_483_647
  );
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
