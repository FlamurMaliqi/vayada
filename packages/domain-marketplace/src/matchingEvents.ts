import { createHash } from "node:crypto";

export const MARKETPLACE_MATCHING_CONTRACT_VERSION = "marketplace-matching-contract.v2" as const;
export const MARKETPLACE_MATCHING_SURFACE = "creator_offer_discovery" as const;
export const MARKETPLACE_MATCHING_IMPRESSION_DEDUPLICATION_MS = 86_400_000 as const;

export const MARKETPLACE_MATCHING_EVENT_TYPES = [
  "marketplace.match.evaluated.v1",
  "marketplace.match.impression.v1",
  "marketplace.match.saved.v1",
  "marketplace.match.dismissed.v1",
  "marketplace.match.application_submitted.v1",
  "marketplace.match.invitation_sent.v1",
  "marketplace.match.response_recorded.v1",
  "marketplace.match.accepted.v1",
  "marketplace.match.completed.v1",
  "marketplace.match.rating_recorded.v1",
  "marketplace.match.satisfaction_recorded.v1",
  "marketplace.match.guardrail_recorded.v1",
] as const;

export const MARKETPLACE_MATCHING_ELIGIBILITY_RULE_CODES = [
  "participant_eligible",
  "platform_deliverable_supported",
  "follower_requirement",
  "creator_type_required",
  "destination_dates_required",
  "compensation_required",
  "deliverable_required",
  "audience_requirement",
  "relationship_available",
] as const;

export const MARKETPLACE_MATCHING_REASON_CODES = [
  "destination_match",
  "date_overlap",
  "platform_match",
  "deliverable_match",
  "compensation_match",
  "audience_market_match",
  "campaign_goal_match",
  "brief_fit",
  "current_verified_metrics",
  "positive_outcome_history",
] as const;

export const MARKETPLACE_MATCHING_DISMISSAL_REASON_CODES = [
  "destination_not_suitable",
  "dates_not_suitable",
  "compensation_not_suitable",
  "deliverables_not_suitable",
  "brief_not_suitable",
  "not_interested",
  "other",
] as const;

export const MARKETPLACE_MATCHING_EVENT_FORBIDDEN_FIELDS = [
  "rawDemographics",
  "providerPayload",
  "contactData",
  "profileText",
  "portfolioText",
  "message",
  "travelNotes",
  "privatePreferences",
  "url",
  "privateThresholds",
] as const;

export type MarketplaceMatchingEventType = (typeof MARKETPLACE_MATCHING_EVENT_TYPES)[number];
export type MarketplaceMatchingEligibilityRuleCode =
  (typeof MARKETPLACE_MATCHING_ELIGIBILITY_RULE_CODES)[number];
export type MarketplaceMatchingReasonCode = (typeof MARKETPLACE_MATCHING_REASON_CODES)[number];
export type MarketplaceMatchingDismissalReasonCode =
  (typeof MARKETPLACE_MATCHING_DISMISSAL_REASON_CODES)[number];
export type MarketplaceMatchingParticipantSide = "creator" | "hotel";
export type MarketplaceMatchingPresentationMode = "ranked" | "exploration";
export type MarketplaceMatchingForbiddenEventFields = Readonly<{
  [Field in (typeof MARKETPLACE_MATCHING_EVENT_FORBIDDEN_FIELDS)[number]]?: never;
}>;

export type MarketplaceMatchingRecommendedAttribution = Readonly<{
  kind: "recommended";
  policyVersion: string;
  evaluationId: string;
  impressionId: string;
  recommendationSessionId: string;
  surface: typeof MARKETPLACE_MATCHING_SURFACE;
  presentationMode: MarketplaceMatchingPresentationMode;
}>;

export type MarketplaceMatchingOrganicAttribution = Readonly<{
  kind: "organic";
  policyVersion: null;
  evaluationId: null;
  impressionId: null;
  recommendationSessionId: null;
  surface: null;
  presentationMode: null;
}>;

export type MarketplaceMatchingAttribution =
  MarketplaceMatchingRecommendedAttribution | MarketplaceMatchingOrganicAttribution;

type EventBase<T extends MarketplaceMatchingEventType> = Readonly<{
  eventId: string;
  eventType: T;
  occurredAt: string;
  creatorProfileId: string;
  offerId: string;
  contractVersion: typeof MARKETPLACE_MATCHING_CONTRACT_VERSION;
  correlationId: string;
}> &
  MarketplaceMatchingForbiddenEventFields;

type AttributedEvent<T extends MarketplaceMatchingEventType, D> = EventBase<T> &
  Readonly<{ attribution: MarketplaceMatchingAttribution }> &
  Readonly<D>;

export type MarketplaceMatchEvaluatedEvent = EventBase<"marketplace.match.evaluated.v1"> &
  Readonly<{
    policyVersion: string;
    evaluationId: string;
    revision: 1;
    evaluationMode: "shadow" | "active";
    eligibilityStatus: "eligible" | "ineligible" | "not_evaluable";
    eligibilityRuleResults: readonly Readonly<{
      ruleCode: MarketplaceMatchingEligibilityRuleCode;
      outcome: "pass" | "conflict" | "unknown";
    }>[];
    hotelFitBps: number | null;
    creatorFitBps: number | null;
    pairFitBps: number | null;
    hotelCoverageBps: number;
    creatorCoverageBps: number;
    confidence: "insufficient" | "low" | "medium" | "high";
    reasonCodes: readonly MarketplaceMatchingReasonCode[];
    evidenceCounts: Readonly<{
      known: number;
      unknown: number;
      stale: number;
      unavailable: number;
      notApplicable: number;
    }>;
  }>;

export type MarketplaceMatchImpressionEvent = EventBase<"marketplace.match.impression.v1"> &
  Readonly<{
    policyVersion: string;
    evaluationId: string;
    revision: 1;
    impressionId: string;
    recommendationSessionId: string;
    surface: typeof MARKETPLACE_MATCHING_SURFACE;
    presentationMode: MarketplaceMatchingPresentationMode;
    rank: number;
    slot: number;
  }>;

export type MarketplaceMatchSavedEvent = AttributedEvent<
  "marketplace.match.saved.v1",
  { saveId: string; revision: number }
>;
export type MarketplaceMatchDismissedEvent = AttributedEvent<
  "marketplace.match.dismissed.v1",
  {
    dismissalId: string;
    revision: number;
    reasonCode: MarketplaceMatchingDismissalReasonCode | null;
  }
>;
export type MarketplaceMatchApplicationSubmittedEvent = AttributedEvent<
  "marketplace.match.application_submitted.v1",
  { collaborationId: string; revision: number }
>;
export type MarketplaceMatchInvitationSentEvent = AttributedEvent<
  "marketplace.match.invitation_sent.v1",
  { collaborationId: string; revision: number }
>;
export type MarketplaceMatchResponseRecordedEvent = AttributedEvent<
  "marketplace.match.response_recorded.v1",
  {
    collaborationId: string;
    revision: number;
    respondentSide: MarketplaceMatchingParticipantSide;
    response: "positive" | "declined";
  }
>;
export type MarketplaceMatchAcceptedEvent = AttributedEvent<
  "marketplace.match.accepted.v1",
  { collaborationId: string; revision: number }
>;
export type MarketplaceMatchCompletedEvent = AttributedEvent<
  "marketplace.match.completed.v1",
  { collaborationId: string; revision: number }
>;
export type MarketplaceMatchRatingRecordedEvent = AttributedEvent<
  "marketplace.match.rating_recorded.v1",
  {
    ratingId: string;
    collaborationId: string;
    revision: number;
    respondentSide: MarketplaceMatchingParticipantSide;
    subjectSide: MarketplaceMatchingParticipantSide;
    score: number;
  }
>;
export type MarketplaceMatchSatisfactionRecordedEvent = AttributedEvent<
  "marketplace.match.satisfaction_recorded.v1",
  {
    feedbackId: string;
    collaborationId: string;
    revision: number;
    respondentSide: MarketplaceMatchingParticipantSide;
    outcome: "satisfied" | "neutral" | "dissatisfied";
  }
>;
export type MarketplaceMatchGuardrailRecordedEvent = AttributedEvent<
  "marketplace.match.guardrail_recorded.v1",
  {
    guardrailId: string;
    collaborationId: string;
    revision: number;
    state: "opened" | "resolved";
    code: "cancellation" | "no_show" | "dispute" | "block" | "report" | "policy_violation";
  }
>;

export type MarketplaceMatchingEvent =
  | MarketplaceMatchEvaluatedEvent
  | MarketplaceMatchImpressionEvent
  | MarketplaceMatchSavedEvent
  | MarketplaceMatchDismissedEvent
  | MarketplaceMatchApplicationSubmittedEvent
  | MarketplaceMatchInvitationSentEvent
  | MarketplaceMatchResponseRecordedEvent
  | MarketplaceMatchAcceptedEvent
  | MarketplaceMatchCompletedEvent
  | MarketplaceMatchRatingRecordedEvent
  | MarketplaceMatchSatisfactionRecordedEvent
  | MarketplaceMatchGuardrailRecordedEvent;

const BASE_KEYS = [
  "eventId",
  "eventType",
  "occurredAt",
  "creatorProfileId",
  "offerId",
  "contractVersion",
  "correlationId",
] as const;
const ATTRIBUTED_KEYS = [...BASE_KEYS, "attribution"] as const;

export function parseMarketplaceMatchingEvent(value: unknown): MarketplaceMatchingEvent | null {
  if (!validBase(value)) return null;
  switch (value.eventType) {
    case "marketplace.match.evaluated.v1":
      return validEvaluated(value) ? (value as MarketplaceMatchEvaluatedEvent) : null;
    case "marketplace.match.impression.v1":
      return validImpression(value) ? (value as MarketplaceMatchImpressionEvent) : null;
    case "marketplace.match.saved.v1":
      return validAttributed(value, ["saveId", "revision"]) && uuid(value.saveId)
        ? (value as MarketplaceMatchSavedEvent)
        : null;
    case "marketplace.match.dismissed.v1":
      return validAttributed(value, ["dismissalId", "revision", "reasonCode"]) &&
        uuid(value.dismissalId) &&
        (value.reasonCode === null ||
          oneOf(value.reasonCode, MARKETPLACE_MATCHING_DISMISSAL_REASON_CODES))
        ? (value as MarketplaceMatchDismissedEvent)
        : null;
    case "marketplace.match.application_submitted.v1":
    case "marketplace.match.accepted.v1":
    case "marketplace.match.completed.v1":
      return validCollaborationEvent(value) ? (value as MarketplaceMatchingEvent) : null;
    case "marketplace.match.invitation_sent.v1":
      return validCollaborationEvent(value) && value.attribution.kind === "organic"
        ? (value as MarketplaceMatchInvitationSentEvent)
        : null;
    case "marketplace.match.response_recorded.v1":
      return validAttributed(value, [
        "collaborationId",
        "revision",
        "respondentSide",
        "response",
      ]) &&
        uuid(value.collaborationId) &&
        side(value.respondentSide) &&
        oneOf(value.response, ["positive", "declined"])
        ? (value as MarketplaceMatchResponseRecordedEvent)
        : null;
    case "marketplace.match.rating_recorded.v1":
      return validAttributed(value, [
        "ratingId",
        "collaborationId",
        "revision",
        "respondentSide",
        "subjectSide",
        "score",
      ]) &&
        uuid(value.ratingId) &&
        uuid(value.collaborationId) &&
        side(value.respondentSide) &&
        side(value.subjectSide) &&
        value.respondentSide !== value.subjectSide &&
        integer(value.score, 1, 5)
        ? (value as MarketplaceMatchRatingRecordedEvent)
        : null;
    case "marketplace.match.satisfaction_recorded.v1":
      return validAttributed(value, [
        "feedbackId",
        "collaborationId",
        "revision",
        "respondentSide",
        "outcome",
      ]) &&
        uuid(value.feedbackId) &&
        uuid(value.collaborationId) &&
        side(value.respondentSide) &&
        oneOf(value.outcome, ["satisfied", "neutral", "dissatisfied"])
        ? (value as MarketplaceMatchSatisfactionRecordedEvent)
        : null;
    case "marketplace.match.guardrail_recorded.v1":
      return validAttributed(value, [
        "guardrailId",
        "collaborationId",
        "revision",
        "state",
        "code",
      ]) &&
        uuid(value.guardrailId) &&
        uuid(value.collaborationId) &&
        oneOf(value.state, ["opened", "resolved"]) &&
        oneOf(value.code, [
          "cancellation",
          "no_show",
          "dispute",
          "block",
          "report",
          "policy_violation",
        ])
        ? (value as MarketplaceMatchGuardrailRecordedEvent)
        : null;
  }
  return null;
}

export function buildMarketplaceMatchingImpressionId(input: {
  policyVersion: string;
  creatorProfileId: string;
  offerId: string;
  occurredAt: string;
}): string {
  if (!version(input.policyVersion) || !uuid(input.creatorProfileId) || !uuid(input.offerId)) {
    throw new TypeError("Invalid matching impression identity input.");
  }
  const occurredAt = Date.parse(input.occurredAt);
  if (!utc(input.occurredAt) || occurredAt < 0) {
    throw new TypeError("Invalid matching impression occurrence time.");
  }
  const epoch = Math.floor(occurredAt / MARKETPLACE_MATCHING_IMPRESSION_DEDUPLICATION_MS);
  const source = `${input.policyVersion}|${MARKETPLACE_MATCHING_SURFACE}|creator:${input.creatorProfileId.toLowerCase()}|${input.offerId.toLowerCase()}|${epoch}`;
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export type MarketplaceMatchingRevisionReduction<T> =
  | Readonly<{ ok: true; latest: readonly T[] }>
  | Readonly<{ ok: false; code: "duplicate_revision"; subjectKey: string; revision: number }>;

export function reduceLatestMarketplaceMatchingSatisfaction(
  events: readonly MarketplaceMatchSatisfactionRecordedEvent[],
): MarketplaceMatchingRevisionReduction<MarketplaceMatchSatisfactionRecordedEvent> {
  return latest(
    events,
    (event) => `${event.collaborationId.toLowerCase()}:${event.respondentSide}`,
  );
}

export function reduceLatestMarketplaceMatchingGuardrails(
  events: readonly MarketplaceMatchGuardrailRecordedEvent[],
): MarketplaceMatchingRevisionReduction<MarketplaceMatchGuardrailRecordedEvent> {
  return latest(
    events,
    (event) => `${event.collaborationId.toLowerCase()}:${event.guardrailId.toLowerCase()}`,
  );
}

function validBase(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    oneOf(value.eventType, MARKETPLACE_MATCHING_EVENT_TYPES) &&
    uuid(value.eventId) &&
    utc(value.occurredAt) &&
    uuid(value.creatorProfileId) &&
    uuid(value.offerId) &&
    value.contractVersion === MARKETPLACE_MATCHING_CONTRACT_VERSION &&
    opaqueId(value.correlationId)
  );
}

function validEvaluated(value: Record<string, unknown>): boolean {
  if (
    !exact(value, [
      ...BASE_KEYS,
      "policyVersion",
      "evaluationId",
      "revision",
      "evaluationMode",
      "eligibilityStatus",
      "eligibilityRuleResults",
      "hotelFitBps",
      "creatorFitBps",
      "pairFitBps",
      "hotelCoverageBps",
      "creatorCoverageBps",
      "confidence",
      "reasonCodes",
      "evidenceCounts",
    ]) ||
    !version(value.policyVersion) ||
    !uuid(value.evaluationId) ||
    value.revision !== 1 ||
    !oneOf(value.evaluationMode, ["shadow", "active"]) ||
    !oneOf(value.eligibilityStatus, ["eligible", "ineligible", "not_evaluable"]) ||
    !ruleResults(value.eligibilityRuleResults, value.eligibilityStatus) ||
    !nullableBps(value.hotelFitBps) ||
    !nullableBps(value.creatorFitBps) ||
    !nullableBps(value.pairFitBps) ||
    !integer(value.hotelCoverageBps, 0, 10_000) ||
    !integer(value.creatorCoverageBps, 0, 10_000) ||
    !oneOf(value.confidence, ["insufficient", "low", "medium", "high"]) ||
    !reasons(value.reasonCodes) ||
    !counts(value.evidenceCounts)
  )
    return false;
  if (value.eligibilityStatus !== "eligible")
    return (
      value.hotelFitBps === null &&
      value.creatorFitBps === null &&
      value.pairFitBps === null &&
      value.confidence === "insufficient"
    );
  if (
    (value.hotelFitBps === null && value.hotelCoverageBps !== 0) ||
    (value.creatorFitBps === null && value.creatorCoverageBps !== 0)
  )
    return false;
  const pair =
    value.hotelFitBps === null || value.creatorFitBps === null
      ? null
      : Math.min(value.hotelFitBps, value.creatorFitBps);
  return (
    value.pairFitBps === pair &&
    (pair === null ? value.confidence === "insufficient" : value.confidence !== "insufficient")
  );
}

function validImpression(value: Record<string, unknown>): boolean {
  return (
    exact(value, [
      ...BASE_KEYS,
      "policyVersion",
      "evaluationId",
      "revision",
      "impressionId",
      "recommendationSessionId",
      "surface",
      "presentationMode",
      "rank",
      "slot",
    ]) &&
    version(value.policyVersion) &&
    uuid(value.evaluationId) &&
    value.revision === 1 &&
    hash(value.impressionId) &&
    opaqueId(value.recommendationSessionId) &&
    value.surface === MARKETPLACE_MATCHING_SURFACE &&
    oneOf(value.presentationMode, ["ranked", "exploration"]) &&
    integer(value.rank, 1) &&
    integer(value.slot, 1) &&
    value.impressionId ===
      buildMarketplaceMatchingImpressionId({
        policyVersion: value.policyVersion,
        creatorProfileId: value.creatorProfileId as string,
        offerId: value.offerId as string,
        occurredAt: value.occurredAt as string,
      })
  );
}

function validCollaborationEvent(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  attribution: MarketplaceMatchingAttribution;
  revision: number;
} {
  return validAttributed(value, ["collaborationId", "revision"]) && uuid(value.collaborationId);
}

function validAttributed(
  value: Record<string, unknown>,
  details: readonly string[],
): value is Record<string, unknown> & {
  attribution: MarketplaceMatchingAttribution;
  revision: number;
} {
  return (
    exact(value, [...ATTRIBUTED_KEYS, ...details]) &&
    attribution(value.attribution) &&
    revision(value.revision)
  );
}

function attribution(value: unknown): value is MarketplaceMatchingAttribution {
  if (!record(value)) return false;
  if (value.kind === "organic") {
    return (
      exact(value, [
        "kind",
        "policyVersion",
        "evaluationId",
        "impressionId",
        "recommendationSessionId",
        "surface",
        "presentationMode",
      ]) &&
      value.policyVersion === null &&
      value.evaluationId === null &&
      value.impressionId === null &&
      value.recommendationSessionId === null &&
      value.surface === null &&
      value.presentationMode === null
    );
  }
  return (
    value.kind === "recommended" &&
    exact(value, [
      "kind",
      "policyVersion",
      "evaluationId",
      "impressionId",
      "recommendationSessionId",
      "surface",
      "presentationMode",
    ]) &&
    version(value.policyVersion) &&
    uuid(value.evaluationId) &&
    hash(value.impressionId) &&
    opaqueId(value.recommendationSessionId) &&
    value.surface === MARKETPLACE_MATCHING_SURFACE &&
    oneOf(value.presentationMode, ["ranked", "exploration"])
  );
}

function latest<T extends { revision: number }>(
  events: readonly T[],
  subject: (event: T) => string,
): MarketplaceMatchingRevisionReduction<T> {
  const selected = new Map<string, T>();
  const seenRevisions = new Set<string>();
  for (const event of events) {
    const subjectKey = subject(event);
    const revisionKey = `${subjectKey}:${event.revision}`;
    if (seenRevisions.has(revisionKey))
      return { ok: false, code: "duplicate_revision", subjectKey, revision: event.revision };
    seenRevisions.add(revisionKey);
    const current = selected.get(subjectKey);
    if (!current || event.revision > current.revision) selected.set(subjectKey, event);
  }
  return {
    ok: true,
    latest: [...selected.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, event]) => event),
  };
}

function ruleResults(value: unknown, status: unknown): boolean {
  if (!Array.isArray(value) || value.length !== MARKETPLACE_MATCHING_ELIGIBILITY_RULE_CODES.length)
    return false;
  const outcomes = value.map((item, index) => {
    if (
      !exact(item, ["ruleCode", "outcome"]) ||
      item.ruleCode !== MARKETPLACE_MATCHING_ELIGIBILITY_RULE_CODES[index] ||
      !oneOf(item.outcome, ["pass", "conflict", "unknown"])
    )
      return null;
    return item.outcome;
  });
  if (outcomes.includes(null)) return false;
  const expected = outcomes.includes("conflict")
    ? "ineligible"
    : outcomes.includes("unknown")
      ? "not_evaluable"
      : "eligible";
  return status === expected;
}

function reasons(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    value.every((item) => oneOf(item, MARKETPLACE_MATCHING_REASON_CODES)) &&
    new Set(value).size === value.length
  );
}

function counts(value: unknown): boolean {
  return (
    exact(value, ["known", "unknown", "stale", "unavailable", "notApplicable"]) &&
    Object.values(value).every((item) => integer(item, 0))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function oneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.includes(value);
}
function integer(value: unknown, minimum: number, maximum = 2_147_483_647): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
function revision(value: unknown): value is number {
  return integer(value, 1);
}
function nullableBps(value: unknown): value is number | null {
  return value === null || integer(value, 0, 10_000);
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function version(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
}
function opaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}
function side(value: unknown): value is MarketplaceMatchingParticipantSide {
  return value === "creator" || value === "hotel";
}
function utc(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}
