import {
  PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
  parsePmsOperatingCalendarImpactConfirmation,
  parsePmsOperatingCalendarProposal,
  parsePmsOperatingCalendarProposalRequest,
  type PmsOperatingCalendarCommandAudit,
  type PmsOperatingCalendarImpactConfirmation,
  type PmsOperatingCalendarProposal,
  type PmsOperatingCalendarProposalRequest,
  type PmsOperatingCalendarSourceConflict,
} from "./operatingCalendar.js";

export const PMS_OPERATING_CALENDAR_IMPACT_CATEGORIES = Object.freeze([
  "accepted_bookings_on_closing_dates",
  "default_minimum_stay_changes",
  "operating_dates_close",
  "operating_dates_open",
  "owner_overrides_on_changed_dates",
  "room_blocks_on_closing_dates",
  "starting_availability_decreases",
  "starting_availability_increases",
] as const);

export type PmsOperatingCalendarImpactCategory =
  (typeof PMS_OPERATING_CALENDAR_IMPACT_CATEGORIES)[number];

export type PreviewPmsOperatingCalendarImpactCommand = PmsOperatingCalendarProposal &
  Readonly<{ audit: PmsOperatingCalendarCommandAudit }>;

export type PmsOperatingCalendarImpactPreviewRequest = PmsOperatingCalendarProposalRequest;

export type PmsOperatingCalendarImpactSourceRevisions = Readonly<{
  calendarRevision: number;
  propertyProfile: Readonly<{ revision: number; timeZone: string }>;
  roomTypes: readonly Readonly<{
    roomTypeId: string;
    roomFactsRevision: number;
    roomUnitsRevision: number;
    physicalCapacityCount: number;
  }>[];
  inventory: Readonly<{
    materializedRevision: number | null;
    coverageFrom: string | null;
    coverageThrough: string | null;
    dayCount: number;
    inventoryFingerprint: string;
    bookingFingerprint: string;
    blockFingerprint: string;
    overrideFingerprint: string;
    activeReservationCount: number;
  }>;
}>;

export type PmsOperatingCalendarImpactAffectedDate = Readonly<{
  stayDate: string;
  statusChange: "open_to_closed" | "closed_to_open" | "availability_changed";
  availableCountBefore: number;
  availableCountAfter: number;
  assignedCount: number;
  blockedCount: number;
  acceptedBookingCount: number;
  ownerOverridePresent: boolean;
}>;

export type PmsOperatingCalendarImpactRoomTypeChange = Readonly<{
  roomTypeId: string;
  previousStartingSellableLimitCount: number | null;
  proposedStartingSellableLimitCount: number;
  availableRoomNightsDelta: number;
}>;

export type PmsOperatingCalendarImpact = Readonly<{
  categories: readonly PmsOperatingCalendarImpactCategory[];
  summary: Readonly<{
    closingDateCount: number;
    openingDateCount: number;
    availableRoomNightsRemoved: number;
    availableRoomNightsAdded: number;
    acceptedBookingCount: number;
    acceptedBookedRoomNights: number;
    blockedRoomNights: number;
    ownerOverrideDateCount: number;
    defaultMinimumStayChanged: boolean;
  }>;
  affectedDates: readonly PmsOperatingCalendarImpactAffectedDate[];
  roomTypeChanges: readonly PmsOperatingCalendarImpactRoomTypeChange[];
}>;

export type PmsOperatingCalendarImpactPreview = Readonly<{
  contractVersion: typeof PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION;
  propertyId: string;
  proposalFingerprint: string;
  sourceFingerprint: string;
  sourceRevisions: PmsOperatingCalendarImpactSourceRevisions;
  impact: PmsOperatingCalendarImpact;
  confirmation: PmsOperatingCalendarImpactConfirmation;
  generatedAt: string;
}>;

export type PmsOperatingCalendarImpactPreviewError =
  | Readonly<{ code: "setup_scope_unavailable" }>
  | Readonly<{ code: "materialization_not_current" }>
  | Readonly<{ code: "calendar_revision_conflict"; currentRevision: number }>
  | PmsOperatingCalendarSourceConflict;

export type PmsOperatingCalendarImpactPreviewResult =
  | Readonly<{ ok: true; preview: PmsOperatingCalendarImpactPreview }>
  | Readonly<{ ok: false; error: PmsOperatingCalendarImpactPreviewError }>;

export type PmsOperatingCalendarImpactPreviewPort = Readonly<{
  /**
   * Implementations authorize first, then take the shared property inventory
   * lock, Hotel Catalog profile guard, room-facts lock, and sorted unit locks.
   * The preview writes no canonical calendar, inventory, audit, event, or
   * idempotency state. Returned impacts contain aggregates and owner revisions
   * only; opaque reservation identities and guest data never cross this port.
   */
  previewOperatingCalendarImpact(
    command: PreviewPmsOperatingCalendarImpactCommand,
  ): Promise<PmsOperatingCalendarImpactPreviewResult>;
}>;

export function parsePreviewPmsOperatingCalendarImpactCommand(
  value: unknown,
): PreviewPmsOperatingCalendarImpactCommand | null {
  if (!exactRecord(value, [...PROPOSAL_KEYS, "audit"])) return null;
  const proposal = parsePmsOperatingCalendarProposal(
    Object.fromEntries(PROPOSAL_KEYS.map((key) => [key, value[key]])),
  );
  const audit = parseAudit(value.audit);
  return proposal && audit ? Object.freeze({ ...proposal, audit }) : null;
}

export function parsePmsOperatingCalendarImpactPreviewRequest(
  value: unknown,
): PmsOperatingCalendarImpactPreviewRequest | null {
  return parsePmsOperatingCalendarProposalRequest(value);
}

export function parsePmsOperatingCalendarImpactPreviewResult(
  value: unknown,
): PmsOperatingCalendarImpactPreviewResult | null {
  if (!record(value)) return null;
  if (value.ok === false && exactRecord(value, ["ok", "error"])) {
    const error = parsePmsOperatingCalendarImpactPreviewError(value.error);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  if (value.ok !== true || !exactRecord(value, ["ok", "preview"])) return null;
  const preview = parsePmsOperatingCalendarImpactPreview(value.preview);
  return preview ? Object.freeze({ ok: true as const, preview }) : null;
}

const PROPOSAL_KEYS = [
  "organizationId",
  "propertyId",
  "expectedCalendarRevision",
  "expectedPropertyProfileRevision",
  "schedule",
  "defaultMinimumStayNights",
  "roomTypeLimits",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA_256 = /^[0-9a-f]{64}$/;

export function parsePmsOperatingCalendarImpactPreview(
  value: unknown,
): PmsOperatingCalendarImpactPreview | null {
  if (
    !exactRecord(value, [
      "contractVersion",
      "propertyId",
      "proposalFingerprint",
      "sourceFingerprint",
      "sourceRevisions",
      "impact",
      "confirmation",
      "generatedAt",
    ]) ||
    value.contractVersion !== PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION ||
    !uuid(value.propertyId) ||
    !sha256(value.proposalFingerprint) ||
    !sha256(value.sourceFingerprint) ||
    !isoDateTime(value.generatedAt)
  ) {
    return null;
  }
  const sourceRevisions = parseSourceRevisions(value.sourceRevisions);
  const impact = parseImpact(value.impact);
  const confirmation = parsePmsOperatingCalendarImpactConfirmation(value.confirmation);
  if (
    !sourceRevisions ||
    !impact ||
    !confirmation ||
    confirmation.proposalFingerprint !== value.proposalFingerprint ||
    confirmation.sourceFingerprint !== value.sourceFingerprint ||
    confirmation.issuedAt !== value.generatedAt
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
    propertyId: value.propertyId.toLowerCase(),
    proposalFingerprint: value.proposalFingerprint,
    sourceFingerprint: value.sourceFingerprint,
    sourceRevisions,
    impact,
    confirmation,
    generatedAt: value.generatedAt,
  });
}

function parseSourceRevisions(value: unknown): PmsOperatingCalendarImpactSourceRevisions | null {
  if (
    !exactRecord(value, ["calendarRevision", "propertyProfile", "roomTypes", "inventory"]) ||
    !integer(value.calendarRevision, 0, 2_147_483_647) ||
    !exactRecord(value.propertyProfile, ["revision", "timeZone"]) ||
    !integer(value.propertyProfile.revision, 1, 2_147_483_647) ||
    !trimmed(value.propertyProfile.timeZone, 1, 100) ||
    !Array.isArray(value.roomTypes) ||
    value.roomTypes.length < 1 ||
    !exactRecord(value.inventory, [
      "materializedRevision",
      "coverageFrom",
      "coverageThrough",
      "dayCount",
      "inventoryFingerprint",
      "bookingFingerprint",
      "blockFingerprint",
      "overrideFingerprint",
      "activeReservationCount",
    ])
  ) {
    return null;
  }
  const roomTypes = value.roomTypes.map(parseRoomRevision);
  if (roomTypes.some((room) => !room)) return null;
  const rooms = roomTypes as PmsOperatingCalendarImpactSourceRevisions["roomTypes"];
  if (!sortedUnique(rooms.map(({ roomTypeId }) => roomTypeId))) return null;
  const inventory = value.inventory;
  const coverageAbsent =
    inventory.materializedRevision === null &&
    inventory.coverageFrom === null &&
    inventory.coverageThrough === null;
  const coveragePresent =
    integer(inventory.materializedRevision, 1, 2_147_483_647) &&
    date(inventory.coverageFrom) &&
    date(inventory.coverageThrough) &&
    inventory.coverageFrom <= inventory.coverageThrough;
  if (
    (!coverageAbsent && !coveragePresent) ||
    !integer(inventory.dayCount, 0, 2_147_483_647) ||
    !sha256(inventory.inventoryFingerprint) ||
    !sha256(inventory.bookingFingerprint) ||
    !sha256(inventory.blockFingerprint) ||
    !sha256(inventory.overrideFingerprint) ||
    !integer(inventory.activeReservationCount, 0, 2_147_483_647)
  ) {
    return null;
  }
  return deepFreeze({
    calendarRevision: value.calendarRevision,
    propertyProfile: {
      revision: value.propertyProfile.revision,
      timeZone: value.propertyProfile.timeZone,
    },
    roomTypes: rooms,
    inventory: {
      materializedRevision: coverageAbsent ? null : (inventory.materializedRevision as number),
      coverageFrom: coverageAbsent ? null : (inventory.coverageFrom as string),
      coverageThrough: coverageAbsent ? null : (inventory.coverageThrough as string),
      dayCount: inventory.dayCount as number,
      inventoryFingerprint: inventory.inventoryFingerprint as string,
      bookingFingerprint: inventory.bookingFingerprint as string,
      blockFingerprint: inventory.blockFingerprint as string,
      overrideFingerprint: inventory.overrideFingerprint as string,
      activeReservationCount: inventory.activeReservationCount as number,
    },
  });
}

function parseRoomRevision(value: unknown) {
  return exactRecord(value, [
    "roomTypeId",
    "roomFactsRevision",
    "roomUnitsRevision",
    "physicalCapacityCount",
  ]) &&
    uuid(value.roomTypeId) &&
    integer(value.roomFactsRevision, 1, 2_147_483_647) &&
    integer(value.roomUnitsRevision, 1, 2_147_483_647) &&
    integer(value.physicalCapacityCount, 1, 500)
    ? Object.freeze({
        roomTypeId: value.roomTypeId.toLowerCase(),
        roomFactsRevision: value.roomFactsRevision,
        roomUnitsRevision: value.roomUnitsRevision,
        physicalCapacityCount: value.physicalCapacityCount,
      })
    : null;
}

function parseImpact(value: unknown): PmsOperatingCalendarImpact | null {
  if (
    !exactRecord(value, ["categories", "summary", "affectedDates", "roomTypeChanges"]) ||
    !Array.isArray(value.categories) ||
    !Array.isArray(value.affectedDates) ||
    !Array.isArray(value.roomTypeChanges) ||
    !exactRecord(value.summary, [
      "closingDateCount",
      "openingDateCount",
      "availableRoomNightsRemoved",
      "availableRoomNightsAdded",
      "acceptedBookingCount",
      "acceptedBookedRoomNights",
      "blockedRoomNights",
      "ownerOverrideDateCount",
      "defaultMinimumStayChanged",
    ])
  ) {
    return null;
  }
  const categories = value.categories.filter((item): item is PmsOperatingCalendarImpactCategory =>
    PMS_OPERATING_CALENDAR_IMPACT_CATEGORIES.includes(item as PmsOperatingCalendarImpactCategory),
  );
  const dates = value.affectedDates.map(parseAffectedDate);
  const roomChanges = value.roomTypeChanges.map(parseRoomChange);
  const summaryNumbers = Object.entries(value.summary)
    .filter(([key]) => key !== "defaultMinimumStayChanged")
    .map(([, item]) => item);
  if (
    categories.length !== value.categories.length ||
    !sortedUnique(categories) ||
    dates.some((item) => !item) ||
    roomChanges.some((item) => !item) ||
    !sortedUnique(
      (dates as PmsOperatingCalendarImpactAffectedDate[]).map(({ stayDate }) => stayDate),
    ) ||
    !sortedUnique(
      (roomChanges as PmsOperatingCalendarImpactRoomTypeChange[]).map(
        ({ roomTypeId }) => roomTypeId,
      ),
    ) ||
    summaryNumbers.some((item) => !integer(item, 0, Number.MAX_SAFE_INTEGER)) ||
    typeof value.summary.defaultMinimumStayChanged !== "boolean"
  ) {
    return null;
  }
  return deepFreeze({
    categories,
    summary: {
      closingDateCount: value.summary.closingDateCount,
      openingDateCount: value.summary.openingDateCount,
      availableRoomNightsRemoved: value.summary.availableRoomNightsRemoved,
      availableRoomNightsAdded: value.summary.availableRoomNightsAdded,
      acceptedBookingCount: value.summary.acceptedBookingCount,
      acceptedBookedRoomNights: value.summary.acceptedBookedRoomNights,
      blockedRoomNights: value.summary.blockedRoomNights,
      ownerOverrideDateCount: value.summary.ownerOverrideDateCount,
      defaultMinimumStayChanged: value.summary.defaultMinimumStayChanged,
    },
    affectedDates: dates,
    roomTypeChanges: roomChanges,
  }) as unknown as PmsOperatingCalendarImpact;
}

function parseAffectedDate(value: unknown) {
  return exactRecord(value, [
    "stayDate",
    "statusChange",
    "availableCountBefore",
    "availableCountAfter",
    "assignedCount",
    "blockedCount",
    "acceptedBookingCount",
    "ownerOverridePresent",
  ]) &&
    date(value.stayDate) &&
    ["open_to_closed", "closed_to_open", "availability_changed"].includes(
      value.statusChange as string,
    ) &&
    [
      value.availableCountBefore,
      value.availableCountAfter,
      value.assignedCount,
      value.blockedCount,
      value.acceptedBookingCount,
    ].every((item) => integer(item, 0, Number.MAX_SAFE_INTEGER)) &&
    typeof value.ownerOverridePresent === "boolean"
    ? (Object.freeze(value) as PmsOperatingCalendarImpactAffectedDate)
    : null;
}

function parseRoomChange(value: unknown) {
  return exactRecord(value, [
    "roomTypeId",
    "previousStartingSellableLimitCount",
    "proposedStartingSellableLimitCount",
    "availableRoomNightsDelta",
  ]) &&
    uuid(value.roomTypeId) &&
    (value.previousStartingSellableLimitCount === null ||
      integer(value.previousStartingSellableLimitCount, 1, 500)) &&
    integer(value.proposedStartingSellableLimitCount, 1, 500) &&
    integer(value.availableRoomNightsDelta, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    ? (Object.freeze({
        ...value,
        roomTypeId: value.roomTypeId.toLowerCase(),
      }) as PmsOperatingCalendarImpactRoomTypeChange)
    : null;
}

export function parsePmsOperatingCalendarImpactPreviewError(
  value: unknown,
): PmsOperatingCalendarImpactPreviewError | null {
  if (!record(value) || typeof value.code !== "string") return null;
  if (
    [
      "setup_scope_unavailable",
      "materialization_not_current",
      "property_timezone_missing",
      "property_timezone_invalid",
      "active_room_type_set_empty",
    ].includes(value.code) &&
    exactRecord(value, ["code"])
  ) {
    return value as PmsOperatingCalendarImpactPreviewError;
  }
  if (
    ["calendar_revision_conflict", "property_profile_revision_conflict"].includes(value.code) &&
    exactRecord(value, ["code", "currentRevision"]) &&
    integer(
      value.currentRevision,
      value.code === "calendar_revision_conflict" ? 0 : 1,
      2_147_483_647,
    )
  ) {
    return value as PmsOperatingCalendarImpactPreviewError;
  }
  if (
    value.code === "room_type_set_conflict" &&
    exactRecord(value, ["code", "currentRoomTypeIds"]) &&
    Array.isArray(value.currentRoomTypeIds) &&
    value.currentRoomTypeIds.every(uuid) &&
    sortedUnique(value.currentRoomTypeIds as string[])
  ) {
    return deepFreeze(value) as PmsOperatingCalendarImpactPreviewError;
  }
  if (
    ["room_facts_revision_conflict", "room_units_revision_conflict"].includes(value.code) &&
    exactRecord(value, ["code", "roomTypeId", "currentRevision"]) &&
    uuid(value.roomTypeId) &&
    integer(value.currentRevision, 1, 2_147_483_647)
  ) {
    return value as PmsOperatingCalendarImpactPreviewError;
  }
  if (
    value.code === "room_capacity_unavailable" &&
    exactRecord(value, ["code", "roomTypeId"]) &&
    uuid(value.roomTypeId)
  ) {
    return value as PmsOperatingCalendarImpactPreviewError;
  }
  if (
    value.code === "starting_sellable_limit_exceeds_capacity" &&
    exactRecord(value, ["code", "roomTypeId", "physicalCapacityCount"]) &&
    uuid(value.roomTypeId) &&
    integer(value.physicalCapacityCount, 0, 500)
  ) {
    return value as PmsOperatingCalendarImpactPreviewError;
  }
  return null;
}

function parseAudit(value: unknown): PmsOperatingCalendarCommandAudit | null {
  if (
    !exactRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !exactRecord(value.actor, ["kind", "userId"]) ||
    value.actor.kind !== "user" ||
    !uuid(value.actor.userId) ||
    !trimmed(value.requestId, 1, 200) ||
    !(value.correlationId === null || trimmed(value.correlationId, 1, 200)) ||
    !isoDateTime(value.requestedAt)
  ) {
    return null;
  }
  return Object.freeze({
    actor: Object.freeze({ kind: "user" as const, userId: value.actor.userId.toLowerCase() }),
    requestId: value.requestId,
    correlationId: value.correlationId,
    requestedAt: value.requestedAt,
  });
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
  return typeof value === "string" && SHA_256.test(value);
}
function date(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
}
function isoDateTime(value: unknown): value is string {
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
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
