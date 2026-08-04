import type { SourceEntityRevision } from "@vayada/domain-hotels";

import type { RoomCapacityReadPort, RoomFactsReadPort } from "./roomFacts.js";

export const PMS_OPERATING_CALENDAR_CONTRACT_VERSION = "pms-operating-calendar.v1" as const;
export const PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION =
  "pms-operating-calendar-impact.v1" as const;
export const PMS_OPERATING_CALENDAR_IMPACT_CONFIRMATION_TTL_SECONDS = 15 * 60;
export const PMS_OPERATING_CALENDAR_SOURCE_OWNER_DOMAIN = "pms" as const;
export const PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE = "pms_operating_calendar.v1" as const;
export const PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION = "pms.inventory-source" as const;
export const PMS_OPERATING_CALENDAR_OUTBOX_METADATA = Object.freeze({
  sourceReadRequired: true,
} as const);
export const PMS_OPERATING_CALENDAR_IDEMPOTENCY = Object.freeze({
  operationScope: "pms",
  operation: "pms.operating_calendar.upsert",
  keyScope: "property",
  exactReplay: "original_response",
  replaySideEffects: "none",
  changedFingerprint: "idempotency_key_conflict",
  inProgress: "command_in_progress",
} as const);
export const PMS_OPERATING_CALENDAR_RECURRENCE_BOUNDS = Object.freeze({
  minimumPeriods: 1,
  maximumDraftPeriods: 24,
} as const);
export const PMS_OPERATING_CALENDAR_MINIMUM_STAY_BOUNDS = Object.freeze({
  minimumNights: 1,
  maximumNights: 366,
} as const);

export const PMS_OPERATING_CALENDAR_AUTHORIZATION = Object.freeze({
  permission: "pms.operations.manage",
  readPermission: "pms.operations.read",
  entitlement: Object.freeze({ product: "pms", key: "property-management" }),
  resource: Object.freeze({
    product: "pms",
    resourceType: "pms_property",
    allowedRelationships: Object.freeze(["owner", "operator"] as const),
  }),
} as const);

declare const monthDayBrand: unique symbol;
declare const canonicalTimeZoneBrand: unique symbol;
export type PmsOperatingCalendarMonthDay = string & { readonly [monthDayBrand]: true };
export type PmsCanonicalIanaTimeZone = string & { readonly [canonicalTimeZoneBrand]: true };

export type PmsRecurringOperatingPeriod = Readonly<{
  startsOn: PmsOperatingCalendarMonthDay;
  endsOn: PmsOperatingCalendarMonthDay;
}>;

export type PmsOperatingSchedule =
  | Readonly<{ mode: "year_round"; periods: readonly [] }>
  | Readonly<{ mode: "recurring"; periods: readonly PmsRecurringOperatingPeriod[] }>;

export type PmsOperatingCalendarCommandAudit = Readonly<{
  actor: Readonly<{ kind: "user"; userId: string }>;
  requestId: string;
  correlationId: string | null;
  requestedAt: string;
}>;

export type PmsStartingSellableLimitInput = Readonly<{
  roomTypeId: string;
  expectedRoomFactsRevision: number;
  expectedRoomUnitsRevision: number;
  startingSellableLimitCount: number;
}>;

export type PmsOperatingCalendarProposalRequest = Readonly<{
  expectedCalendarRevision: number;
  expectedPropertyProfileRevision: number;
  schedule: PmsOperatingSchedule;
  defaultMinimumStayNights: number;
  roomTypeLimits: readonly PmsStartingSellableLimitInput[];
}>;

export type PmsOperatingCalendarProposal = PmsOperatingCalendarProposalRequest &
  Readonly<{
    organizationId: string;
    propertyId: string;
  }>;

export type PmsOperatingCalendarImpactConfirmation = Readonly<{
  contractVersion: typeof PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION;
  proposalFingerprint: string;
  sourceFingerprint: string;
  token: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type PmsOperatingCalendarUpsertRequest = PmsOperatingCalendarProposalRequest &
  Readonly<{ impactConfirmation: PmsOperatingCalendarImpactConfirmation }>;

export type UpsertPmsOperatingCalendarCommand = PmsOperatingCalendarProposal &
  Readonly<{
    impactConfirmation: PmsOperatingCalendarImpactConfirmation;
    idempotencyKey: string;
    audit: PmsOperatingCalendarCommandAudit;
  }>;

export type PmsOperatingCalendarRoomBinding = Readonly<{
  roomTypeId: string;
  sourceRoomFactsRevision: number;
  sourceRoomUnitsRevision: number;
  physicalCapacityCount: number;
  startingSellableLimitCount: number;
}>;

export type PmsOperatingCalendarPropertyProfileSource = Omit<
  SourceEntityRevision,
  "ownerDomain" | "entityType"
> &
  Readonly<{
    ownerDomain: "hotel_catalog";
    entityType: "property_profile";
  }>;

export type PmsOperatingCalendarPropertyProfileEvidence = Readonly<{
  source: PmsOperatingCalendarPropertyProfileSource;
  timeZone: PmsCanonicalIanaTimeZone;
}>;

export type PmsOperatingCalendarPropertyProfileEvidenceResult =
  | Readonly<{
      status: "available";
      evidence: PmsOperatingCalendarPropertyProfileEvidence;
    }>
  | Readonly<{
      status: "timezone_missing";
      source: PmsOperatingCalendarPropertyProfileSource;
    }>
  | Readonly<{
      status: "timezone_invalid";
      source: PmsOperatingCalendarPropertyProfileSource;
    }>;

export type PmsOperatingCalendarSourceInputs = Readonly<{
  propertyProfile: PmsOperatingCalendarPropertyProfileSource;
  propertyTimeZone: PmsCanonicalIanaTimeZone;
  roomBindings: readonly PmsOperatingCalendarRoomBinding[];
}>;

export type PmsOperatingCalendarSourceRevision = SourceEntityRevision &
  Readonly<{
    ownerDomain: typeof PMS_OPERATING_CALENDAR_SOURCE_OWNER_DOMAIN;
    entityType: typeof PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE;
  }>;

export type PmsOperatingCalendarConfigurationSnapshot = Readonly<{
  contractVersion: typeof PMS_OPERATING_CALENDAR_CONTRACT_VERSION;
  propertyId: string;
  calendarRevision: number;
  source: PmsOperatingCalendarSourceRevision;
  sourceInputs: PmsOperatingCalendarSourceInputs;
  schedule: PmsOperatingSchedule;
  defaultMinimumStayNights: number;
  createdAt: string;
  updatedAt: string;
}>;

type RevisionConflict = Readonly<{ currentRevision: number }>;
export type PmsOperatingCalendarSourceConflict =
  | Readonly<{ code: "property_timezone_missing" | "property_timezone_invalid" }>
  | (Readonly<{ code: "property_profile_revision_conflict" }> & RevisionConflict)
  | Readonly<{ code: "active_room_type_set_empty" }>
  | Readonly<{ code: "room_type_set_conflict"; currentRoomTypeIds: readonly string[] }>
  | Readonly<{
      code: "room_facts_revision_conflict" | "room_units_revision_conflict";
      roomTypeId: string;
      currentRevision: number;
    }>
  | Readonly<{ code: "room_capacity_unavailable"; roomTypeId: string }>
  | Readonly<{
      code: "starting_sellable_limit_exceeds_capacity";
      roomTypeId: string;
      physicalCapacityCount: number;
    }>;

export type PmsOperatingCalendarCommandError =
  | Readonly<{ code: "setup_scope_unavailable" }>
  | (Readonly<{ code: "calendar_revision_conflict" }> & RevisionConflict)
  | PmsOperatingCalendarSourceConflict
  | Readonly<{ code: "operating_calendar_unchanged" }>
  | Readonly<{
      code:
        | "impact_confirmation_invalid"
        | "impact_confirmation_expired"
        | "impact_confirmation_configuration_mismatch"
        | "impact_confirmation_stale";
    }>
  | Readonly<{ code: "idempotency_key_conflict" | "command_in_progress" }>;

export type PmsOperatingCalendarStaleSourceConflict = Exclude<
  PmsOperatingCalendarSourceConflict,
  Readonly<{ code: "starting_sellable_limit_exceeds_capacity" }>
>;

export type PmsOperatingCalendarCommandResponse = Readonly<{
  contractVersion: typeof PMS_OPERATING_CALENDAR_CONTRACT_VERSION;
  outcome: "created" | "updated";
  configuration: PmsOperatingCalendarConfigurationSnapshot;
  acceptedAt: string;
}>;

export type PmsOperatingCalendarCommandResult =
  | Readonly<{ ok: true; response: PmsOperatingCalendarCommandResponse }>
  | Readonly<{ ok: false; error: PmsOperatingCalendarCommandError }>;

export type PmsOperatingCalendarCommandPort = {
  /**
   * Implementations authorize before replay and scope idempotency by operation,
   * property, and key. The exact canonical fingerprint replays the original
   * response without a revision, audit, event, or outbox write; a changed
   * fingerprint conflicts and an unfinished reservation reports in-progress.
   * Accepted writes hold the Hotel Catalog evidence guard, then the shared
   * room-facts property lock, followed by every physical-room-unit mutation
   * lock in sorted room ID order. They re-read the complete active room set
   * through the source ports while those locks are held and atomically commit
   * the immutable revision, replay result, redacted audit, event, and outbox.
   */
  upsertOperatingCalendar(
    command: UpsertPmsOperatingCalendarCommand,
  ): Promise<PmsOperatingCalendarCommandResult>;
};

export type PmsOperatingCalendarReadPort = {
  getCurrentOperatingCalendarConfiguration(
    propertyId: string,
  ): Promise<PmsOperatingCalendarCurrentReadResult | null>;
  getOperatingCalendarConfigurationBySource(
    source: PmsOperatingCalendarSourceRevision,
  ): Promise<PmsOperatingCalendarConfigurationSnapshot | null>;
};

export type PmsOperatingCalendarCurrentReadResult =
  | Readonly<{
      configuration: PmsOperatingCalendarConfigurationSnapshot;
      sourceStatus: "current";
      sourceConflicts: readonly [];
    }>
  | Readonly<{
      configuration: PmsOperatingCalendarConfigurationSnapshot;
      sourceStatus: "stale";
      sourceConflicts: readonly PmsOperatingCalendarStaleSourceConflict[];
    }>;

/** Hotel Catalog owns the lock and evidence; PMS never queries its tables. */
export type PmsOperatingCalendarPropertyProfileEvidencePort = {
  runWithPropertyProfileEvidence<Result>(
    input: Readonly<{ propertyId: string; expectedProfileRevision: number }>,
    guarded: (evidence: PmsOperatingCalendarPropertyProfileEvidenceResult) => Promise<Result>,
  ): Promise<Result>;
} & PmsOperatingCalendarCanonicalTimeZoneRegistry;

/** Hotel Catalog supplies a version-pinned, append-only registry for immutable source reads. */
export type PmsOperatingCalendarCanonicalTimeZoneRegistry = Readonly<{
  ownerDomain: "hotel_catalog";
  registryVersion: string;
  isCanonicalIanaTimeZone(value: string): boolean;
}>;

/** Existing VAY-1068/VAY-1070 reads; capacity is never inferred from legacy counts. */
export type PmsOperatingCalendarRoomEvidencePorts = Readonly<{
  roomFacts: Pick<RoomFactsReadPort, "listRoomTypeFacts">;
  roomCapacity: RoomCapacityReadPort;
}>;

/** Secret-safe payload. Consumers resolve the immutable source through the read port. */
export type PmsOperatingCalendarSourceChangedEvent = Readonly<{
  contractVersion: typeof PMS_OPERATING_CALENDAR_CONTRACT_VERSION;
  eventType: "pms.operating_calendar.changed";
  destination: typeof PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION;
  metadata: typeof PMS_OPERATING_CALENDAR_OUTBOX_METADATA;
  propertyId: string;
  calendarRevision: number;
  sourceRevision: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const PROFILE_REVISION = /^profile:([1-9][0-9]*)$/;
const CALENDAR_REVISION = /^calendar:([1-9][0-9]*)$/;
const IANA_TIME_ZONE = /^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/;
const MONTH_LENGTHS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const PROPOSAL_REQUEST_KEYS = [
  "expectedCalendarRevision",
  "expectedPropertyProfileRevision",
  "schedule",
  "defaultMinimumStayNights",
  "roomTypeLimits",
] as const;

export function parsePmsCanonicalIanaTimeZone(
  value: unknown,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsCanonicalIanaTimeZone | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !IANA_TIME_ZONE.test(value) ||
    registry.ownerDomain !== "hotel_catalog" ||
    !trimmed(registry.registryVersion, 1, 100)
  ) {
    return null;
  }
  try {
    return registry.isCanonicalIanaTimeZone(value) ? (value as PmsCanonicalIanaTimeZone) : null;
  } catch {
    return null;
  }
}

export function parsePmsOperatingCalendarMonthDay(
  value: unknown,
): PmsOperatingCalendarMonthDay | null {
  if (typeof value !== "string" || !MONTH_DAY.test(value) || value === "02-29") return null;
  const [month, day] = value.split("-").map(Number);
  return day <= MONTH_LENGTHS[month - 1]! ? (value as PmsOperatingCalendarMonthDay) : null;
}

/** Inclusive annual union: overlaps reject; adjacency merges; full-year aliases reject. */
export function parsePmsOperatingSchedule(value: unknown): PmsOperatingSchedule | null {
  if (!exactRecord(value, ["mode", "periods"]) || !Array.isArray(value.periods)) return null;
  if (value.mode === "year_round") {
    return value.periods.length === 0
      ? Object.freeze({ mode: "year_round", periods: Object.freeze([]) as readonly [] })
      : null;
  }
  if (
    value.mode !== "recurring" ||
    value.periods.length < PMS_OPERATING_CALENDAR_RECURRENCE_BOUNDS.minimumPeriods ||
    value.periods.length > PMS_OPERATING_CALENDAR_RECURRENCE_BOUNDS.maximumDraftPeriods
  ) {
    return null;
  }
  const occupied = Array<boolean>(365).fill(false);
  for (const raw of value.periods) {
    if (!exactRecord(raw, ["startsOn", "endsOn"])) return null;
    const startsOn = parsePmsOperatingCalendarMonthDay(raw.startsOn);
    const endsOn = parsePmsOperatingCalendarMonthDay(raw.endsOn);
    if (!startsOn || !endsOn) return null;
    let day = monthDayIndex(startsOn);
    const end = monthDayIndex(endsOn);
    for (;;) {
      if (occupied[day]) return null;
      occupied[day] = true;
      if (day === end) break;
      day = (day + 1) % 365;
    }
  }
  if (occupied.every(Boolean)) return null;
  const firstGap = occupied.findIndex((present) => !present);
  const periods: PmsRecurringOperatingPeriod[] = [];
  let runStart: number | null = null;
  for (let offset = 1; offset <= 365; offset += 1) {
    const day = (firstGap + offset) % 365;
    if (occupied[day] && runStart === null) runStart = day;
    const next = (day + 1) % 365;
    if (runStart !== null && (!occupied[next] || offset === 365)) {
      periods.push(
        Object.freeze({ startsOn: indexMonthDay(runStart), endsOn: indexMonthDay(day) }),
      );
      runStart = null;
    }
  }
  periods.sort((left, right) => monthDayIndex(left.startsOn) - monthDayIndex(right.startsOn));
  return Object.freeze({ mode: "recurring", periods: Object.freeze(periods) });
}

export function parseUpsertPmsOperatingCalendarCommand(
  value: unknown,
): UpsertPmsOperatingCalendarCommand | null {
  if (
    !exactRecord(value, [
      "organizationId",
      "propertyId",
      "expectedCalendarRevision",
      "expectedPropertyProfileRevision",
      "schedule",
      "defaultMinimumStayNights",
      "roomTypeLimits",
      "impactConfirmation",
      "idempotencyKey",
      "audit",
    ]) ||
    !trimmed(value.idempotencyKey, 1, 200)
  ) {
    return null;
  }
  const request = parsePmsOperatingCalendarUpsertRequest(
    Object.fromEntries(
      [...PROPOSAL_REQUEST_KEYS, "impactConfirmation"].map((key) => [key, value[key]]),
    ),
  );
  if (!request) return null;
  const { impactConfirmation, ...proposalRequest } = request;
  const proposal = parsePmsOperatingCalendarProposal({
    organizationId: value.organizationId,
    propertyId: value.propertyId,
    ...proposalRequest,
  });
  const audit = parseAudit(value.audit);
  if (!proposal || !audit) return null;
  return Object.freeze({
    ...proposal,
    impactConfirmation,
    idempotencyKey: value.idempotencyKey,
    audit,
  });
}

export function parsePmsOperatingCalendarProposal(
  value: unknown,
): PmsOperatingCalendarProposal | null {
  if (
    !exactRecord(value, [
      "organizationId",
      "propertyId",
      "expectedCalendarRevision",
      "expectedPropertyProfileRevision",
      "schedule",
      "defaultMinimumStayNights",
      "roomTypeLimits",
    ]) ||
    !uuid(value.organizationId) ||
    !uuid(value.propertyId)
  ) {
    return null;
  }
  const request = parsePmsOperatingCalendarProposalRequest(
    Object.fromEntries(PROPOSAL_REQUEST_KEYS.map((key) => [key, value[key]])),
  );
  if (!request) return null;
  return Object.freeze({
    organizationId: value.organizationId.toLowerCase(),
    propertyId: value.propertyId.toLowerCase(),
    ...request,
  });
}

export function parsePmsOperatingCalendarProposalRequest(
  value: unknown,
): PmsOperatingCalendarProposalRequest | null {
  if (
    !exactRecord(value, PROPOSAL_REQUEST_KEYS) ||
    !integer(value.expectedCalendarRevision, 0, 2_147_483_647) ||
    !integer(value.expectedPropertyProfileRevision, 1, 2_147_483_647) ||
    !integer(
      value.defaultMinimumStayNights,
      PMS_OPERATING_CALENDAR_MINIMUM_STAY_BOUNDS.minimumNights,
      PMS_OPERATING_CALENDAR_MINIMUM_STAY_BOUNDS.maximumNights,
    ) ||
    !Array.isArray(value.roomTypeLimits) ||
    value.roomTypeLimits.length < 1
  ) {
    return null;
  }
  const schedule = parsePmsOperatingSchedule(value.schedule);
  const roomTypeLimits = value.roomTypeLimits.map(parseLimitInput);
  if (!schedule || roomTypeLimits.some((limit) => !limit)) return null;
  const limits = roomTypeLimits as PmsStartingSellableLimitInput[];
  if (new Set(limits.map(({ roomTypeId }) => roomTypeId)).size !== limits.length) return null;
  limits.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  return Object.freeze({
    expectedCalendarRevision: value.expectedCalendarRevision,
    expectedPropertyProfileRevision: value.expectedPropertyProfileRevision,
    schedule,
    defaultMinimumStayNights: value.defaultMinimumStayNights,
    roomTypeLimits: Object.freeze(limits),
  });
}

export function parsePmsOperatingCalendarUpsertRequest(
  value: unknown,
): PmsOperatingCalendarUpsertRequest | null {
  if (!exactRecord(value, [...PROPOSAL_REQUEST_KEYS, "impactConfirmation"])) return null;
  const proposal = parsePmsOperatingCalendarProposalRequest(
    Object.fromEntries(PROPOSAL_REQUEST_KEYS.map((key) => [key, value[key]])),
  );
  const impactConfirmation = parsePmsOperatingCalendarImpactConfirmation(value.impactConfirmation);
  return proposal && impactConfirmation ? Object.freeze({ ...proposal, impactConfirmation }) : null;
}

export function parsePmsOperatingCalendarImpactConfirmation(
  value: unknown,
): PmsOperatingCalendarImpactConfirmation | null {
  if (
    !exactRecord(value, [
      "contractVersion",
      "proposalFingerprint",
      "sourceFingerprint",
      "token",
      "issuedAt",
      "expiresAt",
    ]) ||
    value.contractVersion !== PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION ||
    !sha256(value.proposalFingerprint) ||
    !sha256(value.sourceFingerprint) ||
    !trimmed(value.token, 1, 2048) ||
    !isoDate(value.issuedAt) ||
    !isoDate(value.expiresAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.issuedAt) !==
      PMS_OPERATING_CALENDAR_IMPACT_CONFIRMATION_TTL_SECONDS * 1_000
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
    proposalFingerprint: value.proposalFingerprint,
    sourceFingerprint: value.sourceFingerprint,
    token: value.token,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

export function serializePmsOperatingCalendarProposalFingerprint(
  proposal: PmsOperatingCalendarProposal,
): string {
  return JSON.stringify(proposalFingerprintPayload(proposal));
}

function proposalFingerprintPayload(proposal: PmsOperatingCalendarProposal) {
  return {
    organizationId: proposal.organizationId,
    propertyId: proposal.propertyId,
    expectedCalendarRevision: proposal.expectedCalendarRevision,
    expectedPropertyProfileRevision: proposal.expectedPropertyProfileRevision,
    schedule: proposal.schedule,
    defaultMinimumStayNights: proposal.defaultMinimumStayNights,
    roomTypeLimits: proposal.roomTypeLimits,
  };
}

export function serializePmsOperatingCalendarFingerprint(
  command: UpsertPmsOperatingCalendarCommand,
): string {
  return JSON.stringify({
    proposal: proposalFingerprintPayload(command),
    impactConfirmation: command.impactConfirmation,
  });
}

export function serializePmsOperatingCalendarSourceRevision(calendarRevision: number): string {
  if (!integer(calendarRevision, 1, 2_147_483_647)) {
    throw new RangeError("PMS operating calendar source revision must be positive and bounded");
  }
  return `calendar:${calendarRevision}`;
}

export function createPmsOperatingCalendarSourceRevision(
  propertyId: string,
  calendarRevision: number,
): PmsOperatingCalendarSourceRevision {
  if (!uuid(propertyId))
    throw new TypeError("PMS operating calendar source property ID is invalid");
  return Object.freeze({
    ownerDomain: PMS_OPERATING_CALENDAR_SOURCE_OWNER_DOMAIN,
    entityType: PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE,
    entityId: propertyId.toLowerCase(),
    revision: serializePmsOperatingCalendarSourceRevision(calendarRevision),
  });
}

export function parsePmsOperatingCalendarPropertyProfileEvidence(
  value: unknown,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarPropertyProfileEvidence | null {
  if (!exactRecord(value, ["source", "timeZone"])) return null;
  const source = parsePropertyProfileSource(value.source);
  const timeZone = parsePmsCanonicalIanaTimeZone(value.timeZone, registry);
  return source && timeZone ? Object.freeze({ source, timeZone }) : null;
}

export function resolvePmsOperatingCalendarPropertyProfileConflict(
  result: PmsOperatingCalendarPropertyProfileEvidenceResult,
  expectedProfileRevision: number,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarSourceConflict | null {
  if (!integer(expectedProfileRevision, 1, 2_147_483_647)) {
    throw new TypeError("PMS operating calendar expected profile revision is invalid");
  }
  let source: PmsOperatingCalendarPropertyProfileSource;
  switch (result.status) {
    case "available": {
      if (!exactRecord(result, ["status", "evidence"])) {
        throw new TypeError("PMS operating calendar profile evidence result is invalid");
      }
      const evidence = parsePmsOperatingCalendarPropertyProfileEvidence(result.evidence, registry);
      if (!evidence) {
        throw new TypeError("PMS operating calendar available profile evidence is invalid");
      }
      source = evidence.source;
      break;
    }
    case "timezone_missing":
    case "timezone_invalid": {
      if (!exactRecord(result, ["status", "source"])) {
        throw new TypeError("PMS operating calendar profile evidence result is invalid");
      }
      const parsedSource = parsePropertyProfileSource(result.source);
      if (!parsedSource) {
        throw new TypeError("PMS operating calendar profile evidence source is invalid");
      }
      source = parsedSource;
      break;
    }
    default:
      throw new TypeError("PMS operating calendar profile evidence status is invalid");
  }
  const currentRevision = profileRevision(source);
  if (currentRevision === null) {
    throw new TypeError("PMS operating calendar profile evidence source is invalid");
  }
  if (currentRevision !== expectedProfileRevision) {
    return Object.freeze({ code: "property_profile_revision_conflict", currentRevision });
  }
  switch (result.status) {
    case "timezone_missing":
      return Object.freeze({ code: "property_timezone_missing" });
    case "timezone_invalid":
      return Object.freeze({ code: "property_timezone_invalid" });
    case "available":
      return null;
  }
}

export function parsePmsOperatingCalendarConfigurationSnapshot(
  value: unknown,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarConfigurationSnapshot | null {
  if (
    !exactRecord(value, [
      "contractVersion",
      "propertyId",
      "calendarRevision",
      "source",
      "sourceInputs",
      "schedule",
      "defaultMinimumStayNights",
      "createdAt",
      "updatedAt",
    ]) ||
    value.contractVersion !== PMS_OPERATING_CALENDAR_CONTRACT_VERSION ||
    !uuid(value.propertyId) ||
    !integer(value.calendarRevision, 1, 2_147_483_647) ||
    !integer(value.defaultMinimumStayNights, 1, 366) ||
    !isoDate(value.createdAt) ||
    !isoDate(value.updatedAt)
  ) {
    return null;
  }
  const propertyId = value.propertyId.toLowerCase();
  const schedule = parsePmsOperatingSchedule(value.schedule);
  const sourceInputs = parseSourceInputs(value.sourceInputs, propertyId, registry);
  const source = parsePmsOperatingCalendarSourceRevision(value.source);
  if (
    !schedule ||
    JSON.stringify(schedule) !== JSON.stringify(value.schedule) ||
    !sourceInputs ||
    !source
  ) {
    return null;
  }
  if (
    source.entityId !== propertyId ||
    sourceInputs.propertyProfile.entityId !== propertyId ||
    source.revision !== serializePmsOperatingCalendarSourceRevision(value.calendarRevision)
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    propertyId,
    calendarRevision: value.calendarRevision,
    source,
    sourceInputs,
    schedule,
    defaultMinimumStayNights: value.defaultMinimumStayNights,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export function parsePmsOperatingCalendarCommandResult(
  value: unknown,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarCommandResult | null {
  if (!record(value)) return null;
  if (value.ok === true && exactRecord(value, ["ok", "response"])) {
    const response = value.response;
    if (
      !exactRecord(response, ["contractVersion", "outcome", "configuration", "acceptedAt"]) ||
      response.contractVersion !== PMS_OPERATING_CALENDAR_CONTRACT_VERSION ||
      (response.outcome !== "created" && response.outcome !== "updated") ||
      !isoDate(response.acceptedAt)
    ) {
      return null;
    }
    const configuration = parsePmsOperatingCalendarConfigurationSnapshot(
      response.configuration,
      registry,
    );
    return configuration
      ? Object.freeze({
          ok: true as const,
          response: Object.freeze({
            contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
            outcome: response.outcome,
            configuration,
            acceptedAt: response.acceptedAt,
          }),
        })
      : null;
  }
  if (value.ok === false && exactRecord(value, ["ok", "error"])) {
    const error = parseCommandError(value.error);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  return null;
}

export function parsePmsOperatingCalendarCurrentReadResult(
  value: unknown,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarCurrentReadResult | null {
  if (!exactRecord(value, ["configuration", "sourceStatus", "sourceConflicts"])) return null;
  const configuration = parsePmsOperatingCalendarConfigurationSnapshot(
    value.configuration,
    registry,
  );
  if (!configuration || !Array.isArray(value.sourceConflicts)) return null;
  const sourceConflicts = value.sourceConflicts.map(parseStaleSourceConflict);
  if (sourceConflicts.some((conflict) => !conflict)) return null;
  if (value.sourceStatus === "current" && sourceConflicts.length === 0) {
    return Object.freeze({
      configuration,
      sourceStatus: "current",
      sourceConflicts: Object.freeze([]) as readonly [],
    });
  }
  if (value.sourceStatus !== "stale" || sourceConflicts.length === 0) return null;
  const parsed = sourceConflicts as PmsOperatingCalendarStaleSourceConflict[];
  let canonical: readonly PmsOperatingCalendarStaleSourceConflict[];
  try {
    canonical = sortPmsOperatingCalendarStaleSourceConflicts(parsed);
  } catch {
    return null;
  }
  return JSON.stringify(value.sourceConflicts) === JSON.stringify(canonical)
    ? Object.freeze({ configuration, sourceStatus: "stale" as const, sourceConflicts: canonical })
    : null;
}

export function sortPmsOperatingCalendarStaleSourceConflicts(
  conflicts: readonly PmsOperatingCalendarStaleSourceConflict[],
): readonly PmsOperatingCalendarStaleSourceConflict[] {
  const sorted = [...conflicts].sort((left, right) =>
    compareCodeUnits(staleConflictKey(left), staleConflictKey(right)),
  );
  if (
    sorted.some(
      (conflict, index) =>
        index > 0 && staleConflictKey(sorted[index - 1]!) === staleConflictKey(conflict),
    )
  ) {
    throw new TypeError("PMS operating calendar stale source conflicts must be unique");
  }
  return Object.freeze(sorted);
}

function parseCommandError(value: unknown): PmsOperatingCalendarCommandError | null {
  if (!record(value) || typeof value.code !== "string") return null;
  if (
    [
      "setup_scope_unavailable",
      "property_timezone_missing",
      "property_timezone_invalid",
      "active_room_type_set_empty",
      "operating_calendar_unchanged",
      "impact_confirmation_invalid",
      "impact_confirmation_expired",
      "impact_confirmation_configuration_mismatch",
      "impact_confirmation_stale",
      "idempotency_key_conflict",
      "command_in_progress",
    ].includes(value.code) &&
    exactRecord(value, ["code"])
  ) {
    return { code: value.code } as PmsOperatingCalendarCommandError;
  }
  if (
    value.code === "calendar_revision_conflict" &&
    exactRecord(value, ["code", "currentRevision"]) &&
    integer(value.currentRevision, 0, 2_147_483_647)
  ) {
    return { code: value.code, currentRevision: value.currentRevision };
  }
  if (
    value.code === "property_profile_revision_conflict" &&
    exactRecord(value, ["code", "currentRevision"]) &&
    integer(value.currentRevision, 1, 2_147_483_647)
  ) {
    return { code: value.code, currentRevision: value.currentRevision };
  }
  if (
    value.code === "room_type_set_conflict" &&
    exactRecord(value, ["code", "currentRoomTypeIds"]) &&
    Array.isArray(value.currentRoomTypeIds) &&
    value.currentRoomTypeIds.every(uuid)
  ) {
    const ids = value.currentRoomTypeIds.map((id) => (id as string).toLowerCase());
    return sortedUnique(ids) ? { code: value.code, currentRoomTypeIds: Object.freeze(ids) } : null;
  }
  if (
    (value.code === "room_facts_revision_conflict" ||
      value.code === "room_units_revision_conflict") &&
    exactRecord(value, ["code", "roomTypeId", "currentRevision"]) &&
    uuid(value.roomTypeId) &&
    integer(value.currentRevision, 1, 2_147_483_647)
  ) {
    return {
      code: value.code,
      roomTypeId: value.roomTypeId.toLowerCase(),
      currentRevision: value.currentRevision,
    };
  }
  if (
    value.code === "room_capacity_unavailable" &&
    exactRecord(value, ["code", "roomTypeId"]) &&
    uuid(value.roomTypeId)
  ) {
    return { code: value.code, roomTypeId: value.roomTypeId.toLowerCase() };
  }
  if (
    value.code === "starting_sellable_limit_exceeds_capacity" &&
    exactRecord(value, ["code", "roomTypeId", "physicalCapacityCount"]) &&
    uuid(value.roomTypeId) &&
    integer(value.physicalCapacityCount, 0, 500)
  ) {
    return {
      code: value.code,
      roomTypeId: value.roomTypeId.toLowerCase(),
      physicalCapacityCount: value.physicalCapacityCount,
    };
  }
  return null;
}

function parseSourceConflict(value: unknown): PmsOperatingCalendarSourceConflict | null {
  const error = parseCommandError(value);
  switch (error?.code) {
    case "property_timezone_missing":
    case "property_timezone_invalid":
    case "property_profile_revision_conflict":
    case "active_room_type_set_empty":
    case "room_type_set_conflict":
    case "room_facts_revision_conflict":
    case "room_units_revision_conflict":
    case "room_capacity_unavailable":
    case "starting_sellable_limit_exceeds_capacity":
      return error;
    default:
      return null;
  }
}

function parseStaleSourceConflict(value: unknown): PmsOperatingCalendarStaleSourceConflict | null {
  const conflict = parseSourceConflict(value);
  return conflict?.code === "starting_sellable_limit_exceeds_capacity" ? null : conflict;
}

function staleConflictKey(conflict: PmsOperatingCalendarStaleSourceConflict): string {
  const sourceIdentity = "roomTypeId" in conflict ? `1|${conflict.roomTypeId}` : "0|property";
  return `${sourceIdentity}|${conflict.code}`;
}

function parseSourceInputs(
  value: unknown,
  propertyId: string,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarSourceInputs | null {
  if (!exactRecord(value, ["propertyProfile", "propertyTimeZone", "roomBindings"])) return null;
  const propertyProfile = parsePropertyProfileSource(value.propertyProfile);
  const propertyTimeZone = parsePmsCanonicalIanaTimeZone(value.propertyTimeZone, registry);
  if (!propertyProfile || propertyProfile.entityId !== propertyId || !propertyTimeZone) return null;
  if (!Array.isArray(value.roomBindings)) return null;
  const roomBindings = value.roomBindings.map(parseRoomBinding);
  if (roomBindings.some((entry) => !entry)) return null;
  const parsed = roomBindings as PmsOperatingCalendarRoomBinding[];
  return parsed.length > 0 && sortedUnique(parsed.map(({ roomTypeId }) => roomTypeId))
    ? Object.freeze({
        propertyProfile,
        propertyTimeZone,
        roomBindings: Object.freeze(parsed),
      })
    : null;
}

function parsePropertyProfileSource(
  value: unknown,
): PmsOperatingCalendarPropertyProfileSource | null {
  if (
    !exactRecord(value, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    value.ownerDomain !== "hotel_catalog" ||
    value.entityType !== "property_profile" ||
    !uuid(value.entityId) ||
    typeof value.revision !== "string" ||
    profileRevision(value) === null
  ) {
    return null;
  }
  return Object.freeze({
    ownerDomain: "hotel_catalog",
    entityType: "property_profile",
    entityId: value.entityId.toLowerCase(),
    revision: value.revision,
  });
}

export function parsePmsOperatingCalendarSourceRevision(
  value: unknown,
): PmsOperatingCalendarSourceRevision | null {
  return exactRecord(value, ["ownerDomain", "entityType", "entityId", "revision"]) &&
    value.ownerDomain === PMS_OPERATING_CALENDAR_SOURCE_OWNER_DOMAIN &&
    value.entityType === PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE &&
    uuid(value.entityId) &&
    typeof value.revision === "string" &&
    calendarRevision(value.revision) !== null
    ? Object.freeze({
        ownerDomain: PMS_OPERATING_CALENDAR_SOURCE_OWNER_DOMAIN,
        entityType: PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE,
        entityId: value.entityId.toLowerCase(),
        revision: value.revision,
      })
    : null;
}

function calendarRevision(value: string): number | null {
  const match = CALENDAR_REVISION.exec(value);
  const revision = match?.[1] ? Number(match[1]) : 0;
  return integer(revision, 1, 2_147_483_647) ? revision : null;
}

function profileRevision(source: unknown): number | null {
  if (!record(source) || typeof source.revision !== "string") return null;
  const match = PROFILE_REVISION.exec(source.revision);
  const revision = match?.[1] ? Number(match[1]) : 0;
  return integer(revision, 1, 2_147_483_647) ? revision : null;
}

function parseLimitInput(value: unknown): PmsStartingSellableLimitInput | null {
  return exactRecord(value, [
    "roomTypeId",
    "expectedRoomFactsRevision",
    "expectedRoomUnitsRevision",
    "startingSellableLimitCount",
  ]) &&
    uuid(value.roomTypeId) &&
    integer(value.expectedRoomFactsRevision, 1, 2_147_483_647) &&
    integer(value.expectedRoomUnitsRevision, 1, 2_147_483_647) &&
    integer(value.startingSellableLimitCount, 1, 500)
    ? Object.freeze({
        roomTypeId: value.roomTypeId.toLowerCase(),
        expectedRoomFactsRevision: value.expectedRoomFactsRevision,
        expectedRoomUnitsRevision: value.expectedRoomUnitsRevision,
        startingSellableLimitCount: value.startingSellableLimitCount,
      })
    : null;
}

function parseRoomBinding(value: unknown): PmsOperatingCalendarRoomBinding | null {
  return exactRecord(value, [
    "roomTypeId",
    "sourceRoomFactsRevision",
    "sourceRoomUnitsRevision",
    "physicalCapacityCount",
    "startingSellableLimitCount",
  ]) &&
    uuid(value.roomTypeId) &&
    integer(value.sourceRoomFactsRevision, 1, 2_147_483_647) &&
    integer(value.sourceRoomUnitsRevision, 1, 2_147_483_647) &&
    integer(value.physicalCapacityCount, 1, 500) &&
    integer(value.startingSellableLimitCount, 1, value.physicalCapacityCount as number)
    ? (Object.freeze({
        ...value,
        roomTypeId: value.roomTypeId.toLowerCase(),
      }) as PmsOperatingCalendarRoomBinding)
    : null;
}

function parseAudit(value: unknown): PmsOperatingCalendarCommandAudit | null {
  if (
    !exactRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !exactRecord(value.actor, ["kind", "userId"]) ||
    value.actor.kind !== "user" ||
    !uuid(value.actor.userId) ||
    !trimmed(value.requestId, 1, 200) ||
    !(value.correlationId === null || trimmed(value.correlationId, 1, 200)) ||
    !isoDate(value.requestedAt)
  ) {
    return null;
  }
  return Object.freeze({
    actor: Object.freeze({ kind: "user", userId: value.actor.userId.toLowerCase() }),
    requestId: value.requestId,
    correlationId: value.correlationId,
    requestedAt: value.requestedAt,
  });
}

function monthDayIndex(value: PmsOperatingCalendarMonthDay): number {
  const [month, day] = value.split("-").map(Number);
  return MONTH_LENGTHS.slice(0, month - 1).reduce((sum, length) => sum + length, 0) + day - 1;
}

function indexMonthDay(index: number): PmsOperatingCalendarMonthDay {
  let remaining = index;
  let month = 0;
  while (remaining >= MONTH_LENGTHS[month]!) remaining -= MONTH_LENGTHS[month++]!;
  return `${String(month + 1).padStart(2, "0")}-${String(remaining + 1).padStart(2, "0")}` as PmsOperatingCalendarMonthDay;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function trimmed(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= min &&
    value.length <= max
  );
}
function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
