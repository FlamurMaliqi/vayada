import {
  parsePmsOperatingCalendarConfigurationSnapshot,
  parsePmsOperatingCalendarSourceRevision,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  resolvePmsOperatingCalendarPropertyProfileConflict,
  sortPmsOperatingCalendarStaleSourceConflicts,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarCurrentReadResult,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarPropertyProfileEvidenceResult,
  type PmsOperatingCalendarReadPort,
  type PmsOperatingCalendarRoomEvidencePorts,
  type PmsOperatingCalendarSourceRevision,
  type PmsOperatingCalendarStaleSourceConflict,
  type RoomTypeCapacitySnapshot,
  type RoomTypeFactsSnapshot,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

export type PmsOperatingCalendarReadClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsOperatingCalendarReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  connect(): Promise<PmsOperatingCalendarReadClient>;
  end?(): Promise<void>;
};

export type PmsOperatingCalendarRevisionRow = {
  propertyId: string;
  calendarRevision: number | string;
  contractVersion: string;
  sourceOwnerDomain: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceRevision: string;
  propertyProfileOwnerDomain: string;
  propertyProfileEntityType: string;
  propertyProfileEntityId: string;
  propertyProfileSourceRevision: string;
  propertyTimeZone: string;
  scheduleMode: string;
  recurringPeriodCount: number | string;
  roomBindingCount: number | string;
  defaultMinimumStayNights: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type PmsOperatingCalendarRecurringPeriodRow = {
  propertyId: string;
  calendarRevision: number | string;
  periodIndex: number | string;
  startMonth: number | string;
  startDay: number | string;
  endMonth: number | string;
  endDay: number | string;
};

export type PmsOperatingCalendarRoomBindingRow = {
  propertyId: string;
  calendarRevision: number | string;
  roomTypeId: string;
  sourceRoomFactsRevision: number | string;
  sourceRoomUnitsRevision: number | string;
  physicalCapacityCount: number | string;
  startingSellableLimitCount: number | string;
};

export type PmsOperatingCalendarReadModel = PmsOperatingCalendarReadPort & {
  close(): Promise<void>;
};

type Queryable = Pick<PmsOperatingCalendarReadClient, "query">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REVISION_SELECT = `SELECT
  revision.property_id::text AS "propertyId",
  revision.calendar_revision AS "calendarRevision",
  revision.contract_version AS "contractVersion",
  revision.source_owner_domain AS "sourceOwnerDomain",
  revision.source_entity_type AS "sourceEntityType",
  revision.source_entity_id::text AS "sourceEntityId",
  revision.source_revision AS "sourceRevision",
  revision.property_profile_owner_domain AS "propertyProfileOwnerDomain",
  revision.property_profile_entity_type AS "propertyProfileEntityType",
  revision.property_profile_entity_id::text AS "propertyProfileEntityId",
  revision.property_profile_source_revision AS "propertyProfileSourceRevision",
  revision.property_time_zone AS "propertyTimeZone",
  revision.schedule_mode AS "scheduleMode",
  revision.recurring_period_count AS "recurringPeriodCount",
  revision.room_binding_count AS "roomBindingCount",
  revision.default_minimum_stay_nights AS "defaultMinimumStayNights",
  revision.created_at AS "createdAt",
  revision.updated_at AS "updatedAt"
FROM pms.operating_calendar_revisions revision`;

export function createPgPmsOperatingCalendarReadModel(config: {
  connectionString?: string;
  max?: number;
  pool?: PmsOperatingCalendarReadPool;
  propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort;
  roomEvidence: PmsOperatingCalendarRoomEvidencePorts;
}): PmsOperatingCalendarReadModel {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS operating-calendar read model connectionString must not be empty");
  }
  const pool: PmsOperatingCalendarReadPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const registry = config.propertyProfileEvidence;

  return {
    async getOperatingCalendarConfigurationBySource(source) {
      const parsed = parsePmsOperatingCalendarSourceRevision(source);
      if (!parsed || !sameSource(parsed, source)) {
        throw new TypeError("PMS operating-calendar source scope is malformed");
      }
      const snapshot = await loadPmsOperatingCalendarConfigurationByRevision(
        pool,
        parsed.entityId,
        sourceRevisionNumber(parsed),
        registry,
      );
      if (!snapshot) return null;
      if (!sameSource(snapshot.source, parsed)) {
        throw new Error("PMS operating-calendar exact-source read escaped its source scope");
      }
      return snapshot;
    },

    async getCurrentOperatingCalendarConfiguration(propertyId) {
      const normalizedPropertyId = readUuid(propertyId);
      const initialProbe = await latestRevision(pool, normalizedPropertyId);
      const probe = initialProbe ?? (await confirmCurrentRevision(pool, normalizedPropertyId));
      if (probe === null) return null;
      const expectedProfileRevision = await profileRevisionFor(pool, normalizedPropertyId, probe);
      return config.propertyProfileEvidence.runWithPropertyProfileEvidence(
        { propertyId: normalizedPropertyId, expectedProfileRevision },
        (profileEvidence) =>
          readCurrentWithOwnerEvidence(
            pool,
            normalizedPropertyId,
            profileEvidence,
            registry,
            config.roomEvidence,
          ),
      );
    },

    async close() {
      if (!ownsPool) return;
      if (!pool.end) throw new Error("Owned PMS operating-calendar read pool cannot be closed");
      await pool.end();
    },
  };
}

export async function loadPmsOperatingCalendarConfigurationByRevision(
  queryable: Queryable,
  propertyId: string,
  calendarRevision: number,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): Promise<PmsOperatingCalendarConfigurationSnapshot | null> {
  const normalizedPropertyId = readUuid(propertyId);
  positiveInteger(calendarRevision, "calendar revision");
  const roots = await queryable.query<PmsOperatingCalendarRevisionRow>(
    `${REVISION_SELECT}
     WHERE revision.property_id = $1::uuid
       AND revision.calendar_revision = $2`,
    [normalizedPropertyId, calendarRevision],
  );
  if (roots.rows.length > 1) throw new Error("PMS operating-calendar revision is not unique");
  const root = roots.rows[0];
  if (!root) return null;
  const periods = await queryable.query<PmsOperatingCalendarRecurringPeriodRow>(
    `SELECT property_id::text AS "propertyId", calendar_revision AS "calendarRevision",
            period_index AS "periodIndex", start_month AS "startMonth",
            start_day AS "startDay", end_month AS "endMonth", end_day AS "endDay"
     FROM pms.operating_calendar_recurring_periods
     WHERE property_id = $1::uuid AND calendar_revision = $2
     ORDER BY period_index`,
    [normalizedPropertyId, calendarRevision],
  );
  const rooms = await queryable.query<PmsOperatingCalendarRoomBindingRow>(
    `SELECT property_id::text AS "propertyId", calendar_revision AS "calendarRevision",
            room_type_id::text AS "roomTypeId",
            source_room_facts_revision AS "sourceRoomFactsRevision",
            source_room_units_revision AS "sourceRoomUnitsRevision",
            physical_capacity_count AS "physicalCapacityCount",
            starting_sellable_limit_count AS "startingSellableLimitCount"
     FROM pms.operating_calendar_room_bindings
     WHERE property_id = $1::uuid AND calendar_revision = $2
     ORDER BY room_type_id`,
    [normalizedPropertyId, calendarRevision],
  );
  return snapshotFromRows(root, periods.rows, rooms.rows, registry);
}

async function readCurrentWithOwnerEvidence(
  pool: PmsOperatingCalendarReadPool,
  propertyId: string,
  profileEvidence: PmsOperatingCalendarPropertyProfileEvidenceResult,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
  roomEvidence: PmsOperatingCalendarRoomEvidencePorts,
): Promise<PmsOperatingCalendarCurrentReadResult | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPmsRoomFactsMutationScope(client, propertyId);
    const revision = await latestRevision(client, propertyId);
    if (revision === null) {
      await client.query("COMMIT");
      return null;
    }
    const configuration = await loadPmsOperatingCalendarConfigurationByRevision(
      client,
      propertyId,
      revision,
      registry,
    );
    if (!configuration) throw new Error("PMS operating-calendar current revision disappeared");
    const facts = await readRoomFacts(roomEvidence, propertyId);
    const lockIds = sortedUnique([
      ...facts
        .filter(({ lifecycle }) => lifecycle === "active")
        .map(({ roomTypeId }) => roomTypeId),
      ...configuration.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId),
    ]);
    for (const roomTypeId of lockIds) {
      await lockPmsPhysicalRoomUnitMutationScope(client, propertyId, roomTypeId);
    }
    const capacities = await readActiveCapacities(roomEvidence, propertyId, facts);
    const result = currentResult(configuration, profileEvidence, facts, capacities, registry);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

function currentResult(
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  profileEvidence: PmsOperatingCalendarPropertyProfileEvidenceResult,
  facts: readonly RoomTypeFactsSnapshot[],
  capacities: ReadonlyMap<string, RoomTypeCapacitySnapshot | null>,
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarCurrentReadResult {
  const conflicts: PmsOperatingCalendarStaleSourceConflict[] = [];
  const profileSource =
    profileEvidence.status === "available"
      ? profileEvidence.evidence.source
      : profileEvidence.source;
  if (profileSource.entityId !== configuration.propertyId) {
    throw new Error("PMS operating-calendar profile evidence escaped its property scope");
  }
  const profileConflict = resolvePmsOperatingCalendarPropertyProfileConflict(
    profileEvidence,
    profileRevisionNumber(configuration.sourceInputs.propertyProfile.revision),
    registry,
  );
  if (profileConflict) {
    if (profileConflict.code === "starting_sellable_limit_exceeds_capacity") {
      throw new Error("Hotel Catalog evidence returned an impossible room conflict");
    }
    conflicts.push(profileConflict);
  }
  if (
    !profileConflict &&
    profileEvidence.status === "available" &&
    profileEvidence.evidence.timeZone !== configuration.sourceInputs.propertyTimeZone
  ) {
    throw new Error("Hotel Catalog timezone changed without advancing its profile source");
  }

  const activeFacts = facts.filter(({ lifecycle }) => lifecycle === "active");
  if (activeFacts.length === 0) {
    conflicts.push({ code: "active_room_type_set_empty" });
    return staleOrCurrent(configuration, conflicts);
  }
  const currentIds = activeFacts.map(({ roomTypeId }) => roomTypeId);
  const acceptedIds = configuration.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId);
  if (!sameStrings(currentIds, acceptedIds)) {
    conflicts.push({ code: "room_type_set_conflict", currentRoomTypeIds: currentIds });
  }
  const acceptedById = new Map(
    configuration.sourceInputs.roomBindings.map((binding) => [binding.roomTypeId, binding]),
  );
  for (const factsSnapshot of activeFacts) {
    const accepted = acceptedById.get(factsSnapshot.roomTypeId);
    if (accepted && factsSnapshot.roomFactsRevision !== accepted.sourceRoomFactsRevision) {
      conflicts.push({
        code: "room_facts_revision_conflict",
        roomTypeId: factsSnapshot.roomTypeId,
        currentRevision: factsSnapshot.roomFactsRevision,
      });
    }
    const capacity = capacities.get(factsSnapshot.roomTypeId) ?? null;
    if (!capacity || capacity.activeUnitCount === 0) {
      conflicts.push({ code: "room_capacity_unavailable", roomTypeId: factsSnapshot.roomTypeId });
      continue;
    }
    if (accepted && capacity.roomUnitsRevision !== accepted.sourceRoomUnitsRevision) {
      conflicts.push({
        code: "room_units_revision_conflict",
        roomTypeId: factsSnapshot.roomTypeId,
        currentRevision: capacity.roomUnitsRevision,
      });
    } else if (accepted && capacity.activeUnitCount !== accepted.physicalCapacityCount) {
      throw new Error("PMS room capacity changed without advancing its unit source");
    }
  }
  return staleOrCurrent(configuration, conflicts);
}

function staleOrCurrent(
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  conflicts: readonly PmsOperatingCalendarStaleSourceConflict[],
): PmsOperatingCalendarCurrentReadResult {
  if (conflicts.length === 0) {
    return Object.freeze({
      configuration,
      sourceStatus: "current" as const,
      sourceConflicts: Object.freeze([]) as readonly [],
    });
  }
  return Object.freeze({
    configuration,
    sourceStatus: "stale" as const,
    sourceConflicts: sortPmsOperatingCalendarStaleSourceConflicts(conflicts),
  });
}

async function readRoomFacts(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  propertyId: string,
): Promise<readonly RoomTypeFactsSnapshot[]> {
  const raw = await ports.roomFacts.listRoomTypeFacts(propertyId);
  const facts = raw.map(parseRoomTypeFactsSnapshot);
  if (facts.some((item) => !item)) throw new Error("PMS room facts evidence is invalid");
  const parsed = facts as RoomTypeFactsSnapshot[];
  if (parsed.some((item) => item.propertyId !== propertyId)) {
    throw new Error("PMS room facts evidence escaped its property scope");
  }
  parsed.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  if (new Set(parsed.map(({ roomTypeId }) => roomTypeId)).size !== parsed.length) {
    throw new Error("PMS room facts evidence contains duplicate room types");
  }
  return Object.freeze(parsed);
}

async function readActiveCapacities(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  propertyId: string,
  facts: readonly RoomTypeFactsSnapshot[],
): Promise<ReadonlyMap<string, RoomTypeCapacitySnapshot | null>> {
  const result = new Map<string, RoomTypeCapacitySnapshot | null>();
  for (const { roomTypeId, lifecycle } of facts) {
    if (lifecycle !== "active") continue;
    const raw = await ports.roomCapacity.getRoomTypeCapacity(propertyId, roomTypeId);
    if (!raw) {
      result.set(roomTypeId, null);
      continue;
    }
    const capacity = parseRoomTypeCapacitySnapshot(raw);
    if (!capacity) throw new Error("PMS room capacity evidence is invalid");
    if (capacity.propertyId !== propertyId || capacity.roomTypeId !== roomTypeId) {
      throw new Error("PMS room capacity evidence escaped its room scope");
    }
    result.set(roomTypeId, capacity);
  }
  return result;
}

function snapshotFromRows(
  root: PmsOperatingCalendarRevisionRow,
  periods: readonly PmsOperatingCalendarRecurringPeriodRow[],
  rooms: readonly PmsOperatingCalendarRoomBindingRow[],
  registry: PmsOperatingCalendarCanonicalTimeZoneRegistry,
): PmsOperatingCalendarConfigurationSnapshot {
  const propertyId = readUuid(root.propertyId);
  const revision = positiveInteger(root.calendarRevision, "calendar revision");
  const periodCount = nonNegativeInteger(root.recurringPeriodCount, "period count");
  const roomCount = positiveInteger(root.roomBindingCount, "room count");
  if (periods.length !== periodCount || rooms.length !== roomCount) {
    throw new Error("PMS operating-calendar manifest count is incomplete");
  }
  const schedule =
    root.scheduleMode === "year_round"
      ? { mode: "year_round", periods: [] }
      : {
          mode: root.scheduleMode,
          periods: periods.map((period, index) => {
            assertChildScope(period, propertyId, revision);
            if (nonNegativeInteger(period.periodIndex, "period index") !== index) {
              throw new Error("PMS operating-calendar period manifest is not dense");
            }
            return {
              startsOn: monthDay(period.startMonth, period.startDay),
              endsOn: monthDay(period.endMonth, period.endDay),
            };
          }),
        };
  const roomBindings = rooms.map((room) => {
    assertChildScope(room, propertyId, revision);
    return {
      roomTypeId: readUuid(room.roomTypeId),
      sourceRoomFactsRevision: positiveInteger(room.sourceRoomFactsRevision, "room facts revision"),
      sourceRoomUnitsRevision: positiveInteger(room.sourceRoomUnitsRevision, "room units revision"),
      physicalCapacityCount: positiveInteger(room.physicalCapacityCount, "physical capacity"),
      startingSellableLimitCount: positiveInteger(
        room.startingSellableLimitCount,
        "starting sellable limit",
      ),
    };
  });
  if (
    !sameStrings(
      roomBindings.map(({ roomTypeId }) => roomTypeId),
      sortedUnique(roomBindings.map(({ roomTypeId }) => roomTypeId)),
    )
  ) {
    throw new Error("PMS operating-calendar room manifest is not canonical");
  }
  const candidate = {
    contractVersion: root.contractVersion,
    propertyId,
    calendarRevision: revision,
    source: {
      ownerDomain: root.sourceOwnerDomain,
      entityType: root.sourceEntityType,
      entityId: root.sourceEntityId,
      revision: root.sourceRevision,
    },
    sourceInputs: {
      propertyProfile: {
        ownerDomain: root.propertyProfileOwnerDomain,
        entityType: root.propertyProfileEntityType,
        entityId: root.propertyProfileEntityId,
        revision: root.propertyProfileSourceRevision,
      },
      propertyTimeZone: root.propertyTimeZone,
      roomBindings,
    },
    schedule,
    defaultMinimumStayNights: positiveInteger(
      root.defaultMinimumStayNights,
      "default minimum stay",
    ),
    createdAt: isoDate(root.createdAt),
    updatedAt: isoDate(root.updatedAt),
  };
  const snapshot = parsePmsOperatingCalendarConfigurationSnapshot(candidate, registry);
  if (!snapshot) throw new Error("PMS operating-calendar revision failed contract validation");
  return snapshot;
}

async function latestRevision(queryable: Queryable, propertyId: string): Promise<number | null> {
  const result = await queryable.query<{ calendarRevision: number | string }>(
    `SELECT calendar_revision AS "calendarRevision"
     FROM pms.operating_calendar_revisions
     WHERE property_id = $1::uuid
     ORDER BY calendar_revision DESC
     LIMIT 1`,
    [propertyId],
  );
  return result.rows[0]
    ? positiveInteger(result.rows[0].calendarRevision, "calendar revision")
    : null;
}

async function profileRevisionFor(
  queryable: Queryable,
  propertyId: string,
  calendarRevision: number,
): Promise<number> {
  const result = await queryable.query<{ profileRevision: number | string }>(
    `SELECT property_profile_revision AS "profileRevision"
     FROM pms.operating_calendar_revisions
     WHERE property_id = $1::uuid AND calendar_revision = $2`,
    [propertyId, calendarRevision],
  );
  if (!result.rows[0]) throw new Error("PMS operating-calendar revision probe disappeared");
  return positiveInteger(result.rows[0].profileRevision, "profile revision");
}

async function confirmCurrentRevision(
  pool: PmsOperatingCalendarReadPool,
  propertyId: string,
): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPmsRoomFactsMutationScope(client, propertyId);
    const revision = await latestRevision(client, propertyId);
    await client.query("COMMIT");
    return revision;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

function assertChildScope(
  row: { propertyId: string; calendarRevision: number | string },
  propertyId: string,
  calendarRevision: number,
): void {
  if (
    readUuid(row.propertyId) !== propertyId ||
    positiveInteger(row.calendarRevision, "child calendar revision") !== calendarRevision
  ) {
    throw new Error("PMS operating-calendar child escaped its revision scope");
  }
}

function sourceRevisionNumber(source: PmsOperatingCalendarSourceRevision): number {
  return positiveInteger(source.revision.slice("calendar:".length), "source revision");
}

function profileRevisionNumber(value: string): number {
  return positiveInteger(value.slice("profile:".length), "profile revision");
}

function sameSource(
  left: PmsOperatingCalendarSourceRevision,
  right: PmsOperatingCalendarSourceRevision,
): boolean {
  return (
    left.ownerDomain === right.ownerDomain &&
    left.entityType === right.entityType &&
    left.entityId === right.entityId &&
    left.revision === right.revision
  );
}

function monthDay(monthValue: number | string, dayValue: number | string): string {
  const month = positiveInteger(monthValue, "period month");
  const day = positiveInteger(dayValue, "period day");
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function readUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError("PMS operating-calendar UUID is malformed");
  return value.toLowerCase();
}

function positiveInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > 2_147_483_647 ||
    (typeof value === "string" && !/^[1-9][0-9]*$/.test(value))
  ) {
    throw new Error(`PMS operating-calendar ${label} is invalid`);
  }
  return parsed;
}

function nonNegativeInteger(value: number | string, label: string): number {
  if (value === 0 || value === "0") return 0;
  return positiveInteger(value, label);
}

function isoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error("PMS operating-calendar timestamp is invalid");
  return date.toISOString();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function rollbackQuietly(client: PmsOperatingCalendarReadClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the read or owner-evidence error.
  }
}
