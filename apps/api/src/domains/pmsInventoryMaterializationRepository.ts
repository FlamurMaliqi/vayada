import { createHash } from "node:crypto";

import {
  PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
  PMS_INVENTORY_MATERIALIZATION_IDEMPOTENCY,
  PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
  evaluatePmsInventoryLaunchReadiness,
  parsePmsOperatingCalendarPropertyProfileEvidence,
  parsePmsOperatingCalendarSourceRevision,
  planPmsInventoryMaterialization,
  type PmsInventoryCoverageEvidence,
  type PmsInventoryDaySnapshot,
  type PmsInventoryLaunchReadinessReadPort,
  type PmsInventoryMaterializationCommand,
  type PmsInventoryMaterializationPort,
  type PmsInventoryMaterializationResult,
  type PmsInventoryProjectionRefreshIntent,
  type PmsInventoryRequiredCoverage,
  type PmsInventorySellableLimitEvidence,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarPropertyProfileEvidenceResult,
  type PmsOperatingCalendarReadPort,
  type RoomCapacityReadPort,
  type RoomFactsCommandAudit,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import {
  reconcilePmsLinkedInventory,
  type PmsLinkedInventoryDirtyRange,
} from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import { loadPmsOperatingCalendarConfigurationByRevision } from "./pmsOperatingCalendarReadModel.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

const MATERIALIZATION_OPERATION = PMS_INVENTORY_MATERIALIZATION_IDEMPOTENCY.operation;
const MATERIALIZATION_RESOURCE_TYPE = "inventory_materialization";
const MAX_REVISION = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const DAY_MS = 86_400_000;

export type PmsInventoryMaterializationAuthorizationPort = {
  authorizeInventoryMaterialization(
    request: Readonly<{
      organizationId: string;
      propertyId: string;
      audit: RoomFactsCommandAudit;
    }>,
  ): Promise<boolean>;
};

export type PmsInventoryMaterializationRepositoryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInventoryMaterializationRepositoryPool = {
  connect(): Promise<PmsInventoryMaterializationRepositoryClient>;
  end(): Promise<void>;
};

export type PmsInventoryMaterializationRepositoryConfig = Readonly<{
  connectionString?: string;
  max?: number;
  pool?: PmsInventoryMaterializationRepositoryPool;
  now?: () => Date;
  authorization: PmsInventoryMaterializationAuthorizationPort;
  operatingCalendar: PmsOperatingCalendarReadPort;
  propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort;
  roomCapacity: RoomCapacityReadPort;
}>;

export type PmsInventoryMaterializationRepository = PmsInventoryMaterializationPort &
  PmsInventoryLaunchReadinessReadPort & { close(): Promise<void> };

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | string | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};

type IdempotencyReservation = Readonly<{ id: string; attempt: number }>;

type InventoryDayRow = {
  propertyId: string;
  roomTypeId: string;
  stayDate: Date | string;
  calendarRevision: number | string | null;
  inventoryRevision: number | string | null;
  generatedSourceRevision: number | string | null;
  channelSourceRevision: number | string | null;
  manualSourceRevision: number | string | null;
  blockSourceRevision: number | string | null;
  bookingSourceRevision: number | string | null;
  status: string;
  totalCount: number | string;
  generatedSellableLimitCount: number | string | null;
  channelSellableLimitCount: number | string | null;
  manualSellableLimitCount: number | string | null;
  effectiveSellableLimitCount: number | string | null;
  assignedCount: number | string;
  blockedCount: number | string;
  linkedStopSell: boolean;
  linkedSourceRevision: number | string;
  availableCount: number | string;
  sourceFreshness: unknown;
};

type CurrentCalendarRevisionRow = { calendarRevision: number | string | null };
type CurrentRoomFactsRow = { roomTypeId: string; roomFactsRevision: number | string };

type CoverageRow = {
  organizationId: string;
  propertyId: string;
  calendarRevision: number | string;
  materializedRevision: number | string;
  coverageFrom: Date | string;
  coverageThrough: Date | string;
  roomTypeCount: number | string;
  expectedDayCount: number | string;
  materializedDayCount: number | string;
};

type ReadinessDayRow = {
  roomTypeId: string;
  stayDate: Date | string;
  calendarRevision: number | string | null;
  generatedSourceRevision: number | string | null;
  effectiveSellableLimitCount: number | string | null;
};

class InventoryInvariantError extends Error {}

export function createPgPmsInventoryMaterializationRepository(
  config: PmsInventoryMaterializationRepositoryConfig,
): PmsInventoryMaterializationRepository {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS inventory materialization connectionString must not be empty");
  }
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as PmsInventoryMaterializationRepositoryPool);
  const now = config.now ?? (() => new Date());

  return {
    async materializeInventory(command) {
      const normalized = normalizeMaterializationCommand(command);
      if (!normalized) return failure("inventory_invariant_violation");
      if (
        !(await config.authorization.authorizeInventoryMaterialization({
          organizationId: normalized.organizationId,
          propertyId: normalized.propertyId,
          audit: normalized.audit,
        }))
      ) {
        return failure("configuration_not_found");
      }
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("PMS inventory materialization clock is invalid");
      return executeMaterialization(pool, config, normalized, acceptedAt);
    },

    async getInventoryLaunchReadiness(request) {
      const requiredCoverage = normalizeRequiredCoverage(request.requiredCoverage);
      const propertyId = normalizeUuid(request.propertyId);
      if (!propertyId || !requiredCoverage) return null;
      const current =
        await config.operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId);
      if (!current || current.sourceStatus !== "current") return null;
      const expectedProfileRevision = propertyProfileRevision(current.configuration);
      if (expectedProfileRevision === null) return null;
      return config.propertyProfileEvidence.runWithPropertyProfileEvidence(
        { propertyId, expectedProfileRevision },
        async (profileEvidence) => {
          if (
            !profileEvidenceMatchesConfiguration(
              profileEvidence,
              current.configuration,
              config.propertyProfileEvidence,
            )
          ) {
            return null;
          }
          const readiness = await readLaunchReadiness(
            pool,
            current.configuration,
            requiredCoverage,
          );
          const confirmed =
            await config.operatingCalendar.getCurrentOperatingCalendarConfiguration(propertyId);
          return confirmed &&
            confirmed.sourceStatus === "current" &&
            sameConfigurationIdentity(current.configuration, confirmed.configuration)
            ? readiness
            : null;
        },
      );
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function executeMaterialization(
  pool: PmsInventoryMaterializationRepositoryPool,
  config: PmsInventoryMaterializationRepositoryConfig,
  command: PmsInventoryMaterializationCommand,
  acceptedAt: Date,
): Promise<PmsInventoryMaterializationResult> {
  const keyHash = sha256(command.idempotencyKey);
  const fingerprint = sha256(materializationFingerprint(command));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPmsInventoryMutationScope(client, command.propertyId);
    const replay = await findReplay(client, command, keyHash, fingerprint, acceptedAt);
    if (replay) {
      await rollbackQuietly(client);
      return replay;
    }
    const reservation = await reserveIdempotency(client, command, keyHash, fingerprint, acceptedAt);
    if (!reservation) {
      const concurrent = await findReplay(client, command, keyHash, fingerprint, acceptedAt);
      await rollbackQuietly(client);
      return concurrent ?? failure("command_in_progress");
    }

    const immutable = await config.operatingCalendar.getOperatingCalendarConfigurationBySource(
      command.configurationSource,
    );
    if (!immutable) {
      return finalizeMaterialization(
        client,
        command,
        reservation,
        keyHash,
        failure("configuration_not_found"),
        acceptedAt,
      );
    }
    const expectedProfileRevision = propertyProfileRevision(immutable);
    if (expectedProfileRevision === null) {
      return finalizeMaterialization(
        client,
        command,
        reservation,
        keyHash,
        failure("configuration_not_current"),
        acceptedAt,
      );
    }
    return config.propertyProfileEvidence.runWithPropertyProfileEvidence(
      { propertyId: command.propertyId, expectedProfileRevision },
      async (profileEvidence) => {
        if (
          !profileEvidenceMatchesConfiguration(
            profileEvidence,
            immutable,
            config.propertyProfileEvidence,
          )
        ) {
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            failure("configuration_not_current"),
            acceptedAt,
          );
        }

        await lockPmsRoomFactsMutationScope(client, command.propertyId);
        for (const { roomTypeId } of [...immutable.sourceInputs.roomBindings].sort((left, right) =>
          compareCodeUnits(left.roomTypeId, right.roomTypeId),
        )) {
          await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, roomTypeId);
        }

        const exact = await loadLockedCurrentConfiguration(
          client,
          command.propertyId,
          config.propertyProfileEvidence,
        );
        if (
          !exact ||
          !sameConfigurationIdentity(immutable, exact) ||
          !(await roomFactsStillMatch(client, exact))
        ) {
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            failure("configuration_not_current"),
            acceptedAt,
          );
        }
        if (command.expectedMaterializedRevision !== exact.calendarRevision) {
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            revisionConflict(exact.calendarRevision),
            acceptedAt,
          );
        }
        if (!(await capacitiesStillMatch(config.roomCapacity, exact))) {
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            failure("configuration_not_current"),
            acceptedAt,
          );
        }

        const coverage = await lockCoverage(client, command.propertyId);
        if (
          coverage &&
          (normalizeUuid(coverage.organizationId) !== command.organizationId ||
            normalizeUuid(coverage.propertyId) !== command.propertyId)
        ) {
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            failure("configuration_not_found"),
            acceptedAt,
          );
        }
        if (coverage && positiveInteger(coverage.calendarRevision) > exact.calendarRevision) {
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            revisionConflict(positiveInteger(coverage.calendarRevision)),
            acceptedAt,
          );
        }

        let currentDays: readonly PmsInventoryDaySnapshot[];
        try {
          currentDays = await lockPmsInventoryDaysForMaterialization(client, command, exact);
        } catch (error) {
          if (!(error instanceof InventoryInvariantError)) throw error;
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            failure("inventory_invariant_violation"),
            acceptedAt,
          );
        }
        const plan = planPmsInventoryMaterialization({
          propertyId: command.propertyId,
          configurationSource: command.configurationSource,
          configuration: exact,
          horizon: command.horizon,
          currentDays,
        });
        if (!plan.ok) {
          const generatedRevision = maxGeneratedRevision(currentDays);
          const result =
            plan.error.code === "generated_revision_conflict" && generatedRevision > 0
              ? revisionConflict(generatedRevision)
              : failure("inventory_invariant_violation");
          return finalizeMaterialization(client, command, reservation, keyHash, result, acceptedAt);
        }
        if (!coverageMatchesPlanState(coverage, plan.outcome, exact.calendarRevision)) {
          return finalizeMaterialization(
            client,
            command,
            reservation,
            keyHash,
            failure("inventory_invariant_violation"),
            acceptedAt,
          );
        }

        if (plan.outcome === "unchanged") {
          const result = successUnchanged(plan.coverage);
          return finalizeMaterialization(client, command, reservation, keyHash, result, acceptedAt);
        }

        await persistPmsInventoryMaterializationDays(client, plan.changedDays, acceptedAt);
        const linkedChanges = await reconcilePmsLinkedInventory(
          client,
          command.propertyId,
          acceptedAt.toISOString(),
          linkedDirtyRanges(plan.changedDays),
        );
        await enqueuePmsLinkedInventorySideEffects(
          client,
          {
            propertyId: command.propertyId,
            operation: "inventory_materialization",
            commandId: reservation.id,
            keyHash,
            acceptedAt: acceptedAt.toISOString(),
            audit: command.audit,
          },
          linkedChanges,
        );
        const intent = projectionRefreshIntent(command, plan.coverage, plan.outcome);
        const event = await enqueueProjectionRefresh(
          client,
          command,
          reservation,
          keyHash,
          intent,
          acceptedAt,
        );
        await persistPmsInventoryMaterializationCoverage(
          client,
          command,
          reservation.id,
          event.eventId,
          event.outboxEventId,
          plan.coverage,
          acceptedAt,
        );
        const result: PmsInventoryMaterializationResult = Object.freeze({
          ok: true,
          outcome: plan.outcome,
          coverage: plan.coverage,
          changedDayCount: plan.changedDays.length,
          projectionRefreshIntent: intent,
        });
        return finalizeMaterialization(
          client,
          command,
          reservation,
          keyHash,
          result,
          acceptedAt,
          event.eventId,
        );
      },
    );
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function loadLockedCurrentConfiguration(
  client: PmsInventoryMaterializationRepositoryClient,
  propertyId: string,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
): Promise<PmsOperatingCalendarConfigurationSnapshot | null> {
  const result = await client.query<CurrentCalendarRevisionRow>(
    `SELECT max(calendar_revision) AS "calendarRevision"
     FROM pms.operating_calendar_revisions
     WHERE property_id = $1::uuid`,
    [propertyId],
  );
  const revision = nullablePositiveInteger(result.rows[0]?.calendarRevision ?? null);
  return revision === null
    ? null
    : loadPmsOperatingCalendarConfigurationByRevision(client, propertyId, revision, registry);
}

async function roomFactsStillMatch(
  client: PmsInventoryMaterializationRepositoryClient,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
): Promise<boolean> {
  const result = await client.query<CurrentRoomFactsRow>(
    `SELECT id::text AS "roomTypeId", room_facts_revision AS "roomFactsRevision"
     FROM pms.room_types
     WHERE property_id = $1::uuid AND active IS TRUE
     ORDER BY id::text`,
    [configuration.propertyId],
  );
  const expected = [...configuration.sourceInputs.roomBindings].sort((left, right) =>
    compareCodeUnits(left.roomTypeId, right.roomTypeId),
  );
  return (
    result.rows.length === expected.length &&
    result.rows.every(
      (row, index) =>
        normalizeUuid(row.roomTypeId) === expected[index]?.roomTypeId &&
        positiveInteger(row.roomFactsRevision) === expected[index]?.sourceRoomFactsRevision,
    )
  );
}

async function capacitiesStillMatch(
  roomCapacity: RoomCapacityReadPort,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
): Promise<boolean> {
  for (const binding of configuration.sourceInputs.roomBindings) {
    const current = await roomCapacity.getRoomTypeCapacity(
      configuration.propertyId,
      binding.roomTypeId,
    );
    if (
      !current ||
      current.propertyId !== configuration.propertyId ||
      current.roomTypeId !== binding.roomTypeId ||
      current.roomUnitsRevision !== binding.sourceRoomUnitsRevision ||
      current.activeUnitCount !== binding.physicalCapacityCount
    ) {
      return false;
    }
  }
  return true;
}

function propertyProfileRevision(
  configuration: PmsOperatingCalendarConfigurationSnapshot,
): number | null {
  const match = /^profile:([1-9]\d*)$/.exec(configuration.sourceInputs.propertyProfile.revision);
  const revision = match?.[1] ? Number(match[1]) : 0;
  return positiveRevision(revision) ? revision : null;
}

function profileEvidenceMatchesConfiguration(
  result: PmsOperatingCalendarPropertyProfileEvidenceResult,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  registry: PmsOperatingCalendarPropertyProfileEvidencePort,
): boolean {
  if (result.status !== "available") return false;
  const evidence = parsePmsOperatingCalendarPropertyProfileEvidence(result.evidence, registry);
  return (
    evidence !== null &&
    stableJson(evidence.source) === stableJson(configuration.sourceInputs.propertyProfile) &&
    evidence.timeZone === configuration.sourceInputs.propertyTimeZone
  );
}

async function lockCoverage(
  client: PmsInventoryMaterializationRepositoryClient,
  propertyId: string,
): Promise<CoverageRow | null> {
  const result = await client.query<CoverageRow>(
    `SELECT organization_id::text AS "organizationId",
            property_id::text AS "propertyId",
            calendar_revision AS "calendarRevision",
            materialized_revision AS "materializedRevision",
            coverage_from::text AS "coverageFrom",
            coverage_through::text AS "coverageThrough",
            room_type_count AS "roomTypeCount",
            expected_day_count AS "expectedDayCount",
            materialized_day_count AS "materializedDayCount"
     FROM pms.inventory_materialization_coverage
     WHERE property_id = $1::uuid
     FOR UPDATE`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS inventory coverage is not unique");
  return result.rows[0] ?? null;
}

export async function lockPmsInventoryDaysForMaterialization(
  client: PmsInventoryMaterializationRepositoryClient,
  command: PmsInventoryMaterializationCommand,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
): Promise<readonly PmsInventoryDaySnapshot[]> {
  const roomTypeIds = configuration.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId);
  const result = await client.query<InventoryDayRow>(
    `SELECT property_id::text AS "propertyId",
            room_type_id::text AS "roomTypeId",
            stay_date::text AS "stayDate",
            calendar_revision AS "calendarRevision",
            inventory_revision AS "inventoryRevision",
            generated_source_revision AS "generatedSourceRevision",
            channel_source_revision AS "channelSourceRevision",
            manual_source_revision AS "manualSourceRevision",
            block_source_revision AS "blockSourceRevision",
            booking_source_revision AS "bookingSourceRevision",
            status,
            total_count AS "totalCount",
            generated_sellable_limit_count AS "generatedSellableLimitCount",
            channel_sellable_limit_count AS "channelSellableLimitCount",
            manual_sellable_limit_count AS "manualSellableLimitCount",
            effective_sellable_limit_count AS "effectiveSellableLimitCount",
            assigned_count AS "assignedCount",
            blocked_count AS "blockedCount",
            linked_stop_sell AS "linkedStopSell",
            linked_source_revision AS "linkedSourceRevision",
            available_count AS "availableCount",
            source_freshness AS "sourceFreshness"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid
       AND room_type_id = ANY($2::uuid[])
       AND stay_date BETWEEN $3::date AND $4::date
     ORDER BY room_type_id::text COLLATE "C", stay_date
     FOR UPDATE`,
    [command.propertyId, roomTypeIds, command.horizon.from, command.horizon.through],
  );
  const bindings = new Map(
    configuration.sourceInputs.roomBindings.map((binding) => [binding.roomTypeId, binding]),
  );
  const days: PmsInventoryDaySnapshot[] = [];
  for (const row of result.rows) {
    const day = inventoryDayFromRow(row);
    if (day) {
      days.push(day);
      continue;
    }
    const roomTypeId = normalizeUuid(row.roomTypeId);
    const binding = roomTypeId ? bindings.get(roomTypeId) : undefined;
    if (!binding || !pristineOnboardingLegacyDay(row, binding.physicalCapacityCount)) {
      throw new InventoryInvariantError(
        "PMS inventory materialization encountered a legacy or malformed day",
      );
    }
  }
  return Object.freeze(days);
}

function pristineOnboardingLegacyDay(row: InventoryDayRow, physicalCapacityCount: number): boolean {
  const freshness = exactDataRecord(row.sourceFreshness, ["pms"])
    ? row.sourceFreshness["pms"]
    : null;
  const total = nullableNonNegativeInteger(row.totalCount);
  const assigned = nullableNonNegativeInteger(row.assignedCount);
  const blocked = nullableNonNegativeInteger(row.blockedCount);
  const available = nullableNonNegativeInteger(row.availableCount);
  return (
    row.calendarRevision === null &&
    row.inventoryRevision === null &&
    row.generatedSellableLimitCount === null &&
    row.channelSellableLimitCount === null &&
    row.manualSellableLimitCount === null &&
    row.effectiveSellableLimitCount === null &&
    row.generatedSourceRevision === null &&
    row.channelSourceRevision === null &&
    row.manualSourceRevision === null &&
    row.blockSourceRevision === null &&
    row.bookingSourceRevision === null &&
    exactDataRecord(freshness, ["status", "generatedAt", "horizonDays"]) &&
    freshness["status"] === "fresh" &&
    freshness["horizonDays"] === 366 &&
    databaseTimestampValue(freshness["generatedAt"]) &&
    total === physicalCapacityCount &&
    assigned === 0 &&
    blocked === 0 &&
    ((row.status === "open" && available === total) || (row.status === "closed" && available === 0))
  );
}

function databaseTimestampValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return false;
  const calendarDate = `${match[1]}-${match[2]}-${match[3]}`;
  const midnight = new Date(`${calendarDate}T00:00:00.000Z`);
  const offset = match[7]!;
  return (
    validDate(midnight) &&
    midnight.toISOString().slice(0, 10) === calendarDate &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    (offset === "Z" || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4)) <= 59)) &&
    validDate(new Date(value))
  );
}

function inventoryDayFromRow(row: InventoryDayRow): PmsInventoryDaySnapshot | null {
  const propertyId = normalizeUuid(row.propertyId);
  const roomTypeId = normalizeUuid(row.roomTypeId);
  const stayDate = databaseDate(row.stayDate);
  const calendarRevision = nullablePositiveInteger(row.calendarRevision);
  const inventoryRevision = nullablePositiveInteger(row.inventoryRevision);
  const generated = nullablePositiveInteger(row.generatedSourceRevision);
  const channel = nullableNonNegativeInteger(row.channelSourceRevision);
  const manual = nullableNonNegativeInteger(row.manualSourceRevision);
  const block = nullableNonNegativeInteger(row.blockSourceRevision);
  const booking = nullableNonNegativeInteger(row.bookingSourceRevision);
  const generatedLimit = nullableNonNegativeInteger(row.generatedSellableLimitCount);
  const effectiveLimit = nullableNonNegativeInteger(row.effectiveSellableLimitCount);
  const channelLimit = nullableNonNegativeInteger(row.channelSellableLimitCount);
  const manualLimit = nullableNonNegativeInteger(row.manualSellableLimitCount);
  const linkedSourceRevision = nullableNonNegativeInteger(row.linkedSourceRevision);
  if (
    !propertyId ||
    !roomTypeId ||
    !stayDate ||
    calendarRevision === null ||
    inventoryRevision === null ||
    generated === null ||
    channel === null ||
    manual === null ||
    block === null ||
    booking === null ||
    generatedLimit === null ||
    effectiveLimit === null ||
    (row.channelSellableLimitCount !== null && channelLimit === null) ||
    (row.manualSellableLimitCount !== null && manualLimit === null) ||
    typeof row.linkedStopSell !== "boolean" ||
    linkedSourceRevision === null ||
    (row.status !== "open" && row.status !== "closed")
  ) {
    return null;
  }
  return Object.freeze({
    propertyId,
    roomTypeId,
    stayDate,
    calendarRevision,
    inventoryRevision,
    sourceRevisions: Object.freeze({ generated, channel, manual, block, booking }),
    operatingStatus: row.status,
    physicalCapacityCount: nonNegativeInteger(row.totalCount),
    generatedSellableLimitCount: generatedLimit,
    channelSellableLimitCount: row.channelSellableLimitCount === null ? null : channelLimit,
    manualSellableLimitCount: row.manualSellableLimitCount === null ? null : manualLimit,
    effectiveSellableLimitCount: effectiveLimit,
    assignedCount: nonNegativeInteger(row.assignedCount),
    blockedCount: nonNegativeInteger(row.blockedCount),
    linkedStopSell: row.linkedStopSell,
    linkedSourceRevision,
    availableCount: nonNegativeInteger(row.availableCount),
  });
}

export async function persistPmsInventoryMaterializationDays(
  client: PmsInventoryMaterializationRepositoryClient,
  days: readonly PmsInventoryDaySnapshot[],
  acceptedAt: Date,
  generatedPricingSource: Readonly<{
    fingerprint: string;
    rateReadyRoomTypeIds: ReadonlySet<string>;
  }> | null = null,
): Promise<void> {
  if (days.length === 0) return;
  const result = await client.query(
    `INSERT INTO pms.inventory_days (
       property_id, room_type_id, stay_date, total_count, assigned_count,
       blocked_count, available_count, status, updated_at, calendar_revision,
       inventory_revision, generated_sellable_limit_count,
       channel_sellable_limit_count, manual_sellable_limit_count,
       effective_sellable_limit_count, generated_source_revision,
       channel_source_revision, manual_source_revision, block_source_revision,
       booking_source_revision, linked_stop_sell, linked_source_revision,
       generated_pricing_source_fingerprint, rate_gate_open
     )
     SELECT day.property_id, day.room_type_id, day.stay_date, day.total_count,
       day.assigned_count, day.blocked_count, day.available_count, day.status,
       day.updated_at, day.calendar_revision, day.inventory_revision,
       day.generated_sellable_limit_count, day.channel_sellable_limit_count,
       day.manual_sellable_limit_count, day.effective_sellable_limit_count,
       day.generated_source_revision, day.channel_source_revision,
       day.manual_source_revision, day.block_source_revision,
       day.booking_source_revision, day.linked_stop_sell, day.linked_source_revision,
       day.generated_pricing_source_fingerprint, day.rate_gate_open
     FROM jsonb_populate_recordset(NULL::pms.inventory_days, $1::jsonb) AS day
     ON CONFLICT (property_id, room_type_id, stay_date)
     DO UPDATE SET
       total_count = EXCLUDED.total_count,
       assigned_count = EXCLUDED.assigned_count,
       blocked_count = EXCLUDED.blocked_count,
       available_count = EXCLUDED.available_count,
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at,
       calendar_revision = EXCLUDED.calendar_revision,
       inventory_revision = EXCLUDED.inventory_revision,
       generated_sellable_limit_count = EXCLUDED.generated_sellable_limit_count,
       channel_sellable_limit_count = EXCLUDED.channel_sellable_limit_count,
       manual_sellable_limit_count = EXCLUDED.manual_sellable_limit_count,
       effective_sellable_limit_count = EXCLUDED.effective_sellable_limit_count,
       generated_source_revision = EXCLUDED.generated_source_revision,
       channel_source_revision = EXCLUDED.channel_source_revision,
       manual_source_revision = EXCLUDED.manual_source_revision,
       block_source_revision = EXCLUDED.block_source_revision,
       booking_source_revision = EXCLUDED.booking_source_revision,
       linked_stop_sell = EXCLUDED.linked_stop_sell,
       linked_source_revision = EXCLUDED.linked_source_revision,
       generated_pricing_source_fingerprint = COALESCE(
         EXCLUDED.generated_pricing_source_fingerprint,
         pms.inventory_days.generated_pricing_source_fingerprint
       ),
       rate_gate_open = COALESCE(
         EXCLUDED.rate_gate_open,
         pms.inventory_days.rate_gate_open
       )`,
    [
      JSON.stringify(
        days.map((day) => ({
          property_id: day.propertyId,
          room_type_id: day.roomTypeId,
          stay_date: day.stayDate,
          total_count: day.physicalCapacityCount,
          assigned_count: day.assignedCount,
          blocked_count: day.blockedCount,
          available_count: day.availableCount,
          status: day.operatingStatus,
          updated_at: acceptedAt.toISOString(),
          calendar_revision: day.calendarRevision,
          inventory_revision: day.inventoryRevision,
          generated_sellable_limit_count: day.generatedSellableLimitCount,
          channel_sellable_limit_count: day.channelSellableLimitCount,
          manual_sellable_limit_count: day.manualSellableLimitCount,
          effective_sellable_limit_count: day.effectiveSellableLimitCount,
          generated_source_revision: day.sourceRevisions.generated,
          channel_source_revision: day.sourceRevisions.channel,
          manual_source_revision: day.sourceRevisions.manual,
          block_source_revision: day.sourceRevisions.block,
          booking_source_revision: day.sourceRevisions.booking,
          linked_stop_sell: day.linkedStopSell,
          linked_source_revision: day.linkedSourceRevision,
          generated_pricing_source_fingerprint: generatedPricingSource?.fingerprint ?? null,
          rate_gate_open: generatedPricingSource?.rateReadyRoomTypeIds.has(day.roomTypeId) ?? null,
        })),
      ),
    ],
  );
  if (result.rowCount !== days.length) throw new Error("PMS inventory day persistence failed");
}

function linkedDirtyRanges(
  days: readonly PmsInventoryDaySnapshot[],
): PmsLinkedInventoryDirtyRange[] {
  const ranges: PmsLinkedInventoryDirtyRange[] = [];
  for (const day of days) {
    const previous = ranges.at(-1);
    if (
      previous?.roomTypeId === day.roomTypeId &&
      new Date(Date.parse(`${previous.endsOn}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10) ===
        day.stayDate
    ) {
      previous.endsOn = day.stayDate;
    } else {
      ranges.push({ roomTypeId: day.roomTypeId, startsOn: day.stayDate, endsOn: day.stayDate });
    }
  }
  return ranges;
}

export async function persistPmsInventoryMaterializationCoverage(
  client: PmsInventoryMaterializationRepositoryClient,
  command: PmsInventoryMaterializationCommand,
  idempotencyId: string,
  eventId: string,
  outboxEventId: string,
  coverage: PmsInventoryCoverageEvidence,
  acceptedAt: Date,
  generatedPricingSourceFingerprint: string | null = null,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO pms.inventory_materialization_coverage (
       property_id, organization_id, calendar_revision, materialized_revision,
       coverage_from, coverage_through, room_type_count, expected_day_count,
       materialized_day_count, last_changed_materialization_idempotency_key_id,
       last_changed_materialization_domain_event_id,
       last_changed_materialization_outbox_event_id,
       generated_pricing_source_fingerprint, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $3, $4::date, $5::date, $6, $7, $8,
       $9::uuid, $10::uuid, $11::uuid, $12, $13::timestamptz
     )
     ON CONFLICT (property_id) DO UPDATE SET
       organization_id = EXCLUDED.organization_id,
       calendar_revision = EXCLUDED.calendar_revision,
       materialized_revision = EXCLUDED.materialized_revision,
       coverage_from = EXCLUDED.coverage_from,
       coverage_through = EXCLUDED.coverage_through,
       room_type_count = EXCLUDED.room_type_count,
       expected_day_count = EXCLUDED.expected_day_count,
       materialized_day_count = EXCLUDED.materialized_day_count,
       last_changed_materialization_idempotency_key_id =
         EXCLUDED.last_changed_materialization_idempotency_key_id,
       last_changed_materialization_domain_event_id =
         EXCLUDED.last_changed_materialization_domain_event_id,
       last_changed_materialization_outbox_event_id =
         EXCLUDED.last_changed_materialization_outbox_event_id,
       generated_pricing_source_fingerprint =
         EXCLUDED.generated_pricing_source_fingerprint,
       updated_at = GREATEST(
         EXCLUDED.updated_at,
         pms.inventory_materialization_coverage.updated_at + interval '1 microsecond'
       )`,
    [
      command.propertyId,
      command.organizationId,
      coverage.materializedRevision,
      coverage.coverageFrom,
      coverage.coverageThrough,
      coverage.roomTypeIds.length,
      coverage.expectedDayCount,
      coverage.materializedDayCount,
      idempotencyId,
      eventId,
      outboxEventId,
      generatedPricingSourceFingerprint,
      acceptedAt.toISOString(),
    ],
  );
  if (result.rowCount !== 1) throw new Error("PMS inventory coverage persistence failed");
}

function coverageMatchesPlanState(
  coverage: CoverageRow | null,
  outcome: "applied" | "extended" | "rematerialized" | "unchanged",
  calendarRevision: number,
): boolean {
  if (!coverage) return outcome === "applied";
  const storedRevision = positiveInteger(coverage.calendarRevision);
  if (outcome === "applied") return false;
  if (outcome === "rematerialized") return storedRevision < calendarRevision;
  return storedRevision === calendarRevision;
}

function maxGeneratedRevision(days: readonly PmsInventoryDaySnapshot[]): number {
  return days.reduce((maximum, day) => Math.max(maximum, day.sourceRevisions.generated), 0);
}

async function findReplay(
  client: PmsInventoryMaterializationRepositoryClient,
  command: PmsInventoryMaterializationCommand,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<PmsInventoryMaterializationResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata",
            expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [MATERIALIZATION_OPERATION, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing || databaseTimestamp(existing.expiresAt) <= acceptedAt) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return failure("idempotency_key_conflict");
  }
  if (existing.status !== "completed") return failure("command_in_progress");
  const stored = dataRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = parsePmsInventoryMaterializationResult(stored);
  if (
    !parsed ||
    !materializationReplayMatchesCommand(parsed, command) ||
    databaseInteger(existing.responseStatusCode) !== materializationResultStatus(parsed) ||
    existing.responseBodyHash !== sha256(stableJson(parsed))
  ) {
    return failure("idempotency_key_conflict");
  }
  return parsed;
}

function materializationReplayMatchesCommand(
  result: PmsInventoryMaterializationResult,
  command: PmsInventoryMaterializationCommand,
): boolean {
  if (!result.ok) return true;
  const coverageMatches =
    stableJson(result.coverage.configurationSource) === stableJson(command.configurationSource) &&
    result.coverage.materializedRevision === command.expectedMaterializedRevision &&
    result.coverage.coverageFrom === command.horizon.from &&
    result.coverage.coverageThrough === command.horizon.through;
  if (!coverageMatches) return false;
  const intent = result.projectionRefreshIntent;
  return (
    intent === null ||
    (intent.organizationId === command.organizationId &&
      intent.propertyId === command.propertyId &&
      stableJson(intent.configurationSource) === stableJson(command.configurationSource) &&
      intent.materializedRevision === command.expectedMaterializedRevision &&
      intent.coverageFrom === command.horizon.from &&
      intent.coverageThrough === command.horizon.through)
  );
}

async function reserveIdempotency(
  client: PmsInventoryMaterializationRepositoryClient,
  command: PmsInventoryMaterializationCommand,
  keyHash: string,
  fingerprint: string,
  acceptedAt: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '24 hours',
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
       status = 'in_progress', response_status_code = NULL, response_body_hash = NULL,
       response_resource_product = NULL, response_resource_type = NULL,
       response_resource_id = NULL, correlation_id = EXCLUDED.correlation_id,
       first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at,
       completed_at = NULL, expires_at = EXCLUDED.expires_at,
       idempotency_metadata = jsonb_build_object(
         'attempt',
         COALESCE((idempotency_keys.idempotency_metadata->>'attempt')::integer, 1) + 1
       )
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text AS id,
       (idempotency_metadata->>'attempt')::integer AS attempt`,
    [
      MATERIALIZATION_OPERATION,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt.toISOString(),
    ],
  );
  return result.rows[0] ?? null;
}

async function completeIdempotency(
  client: PmsInventoryMaterializationRepositoryClient,
  idempotencyId: string,
  result: PmsInventoryMaterializationResult,
  acceptedAt: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      idempotencyId,
      materializationResultStatus(result),
      sha256(stableJson(result)),
      acceptedAt.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) {
    throw new Error("PMS inventory materialization idempotency completion failed");
  }
}

async function enqueueProjectionRefresh(
  client: PmsInventoryMaterializationRepositoryClient,
  command: PmsInventoryMaterializationCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  intent: PmsInventoryProjectionRefreshIntent,
  acceptedAt: Date,
): Promise<Readonly<{ eventId: string; outboxEventId: string }>> {
  const actor = platformActor(command.audit);
  const eventKey = `pms.inventory.projection-refresh.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`;
  const event = await client.query<{ eventId: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id, resource_product,
       resource_type, resource_id, actor_type, actor_user_id, correlation_id,
       causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope
     ) VALUES (
       'pms', $1, $2, 1, $3::timestamptz, 'property', NULL, $4::uuid, 'pms',
       $5, $4::uuid::text, $6, $7::uuid, $8, $9, $10, $11::jsonb,
       $12::jsonb, 'confidential'
     ) RETURNING id::text AS "eventId"`,
    [
      eventKey,
      intent.eventType,
      acceptedAt.toISOString(),
      command.propertyId,
      MATERIALIZATION_RESOURCE_TYPE,
      actor.type,
      actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      keyHash,
      JSON.stringify(intent),
      JSON.stringify({
        contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("PMS inventory materialization event insert failed");
  const outbox = await client.query<{ outboxEventId: string }>(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       organization_id, property_id, resource_product, resource_type,
       resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, $3, $4, 'property', NULL, $5::uuid, 'pms', $6,
       $5::uuid::text, $7, $8, $9::jsonb, $10::jsonb
     ) RETURNING id::text AS "outboxEventId"`,
    [
      eventId,
      `${PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION}.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
      intent.eventType,
      command.propertyId,
      MATERIALIZATION_RESOURCE_TYPE,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify(intent),
      JSON.stringify({
        contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  const outboxEventId = outbox.rows[0]?.outboxEventId;
  if (!outboxEventId) throw new Error("PMS inventory materialization outbox insert failed");
  return Object.freeze({ eventId, outboxEventId });
}

async function finalizeMaterialization(
  client: PmsInventoryMaterializationRepositoryClient,
  command: PmsInventoryMaterializationCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: PmsInventoryMaterializationResult,
  acceptedAt: Date,
  eventId: string | null = null,
): Promise<PmsInventoryMaterializationResult> {
  await recordMaterializationAudit(
    client,
    command,
    reservation,
    keyHash,
    result,
    eventId,
    acceptedAt,
  );
  await completeIdempotency(client, reservation.id, result, acceptedAt);
  await client.query("COMMIT");
  return result;
}

async function recordMaterializationAudit(
  client: PmsInventoryMaterializationRepositoryClient,
  command: PmsInventoryMaterializationCommand,
  reservation: IdempotencyReservation,
  keyHash: string,
  result: PmsInventoryMaterializationResult,
  eventId: string | null,
  acceptedAt: Date,
): Promise<void> {
  const actor = platformActor(command.audit);
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, domain_event_id, idempotency_key_id,
       correlation_id, causation_id, redacted_payload, private_payload,
       audit_metadata, privacy_scope
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', NULL, $4::uuid, $5,
       $6::uuid, 'pms', $7, $4::uuid::text, $8::uuid, $9::uuid, $10, $11,
       $12::jsonb, '{}'::jsonb, $13::jsonb, 'confidential'
     )`,
    [
      `pms.inventory-materialization.property.${command.propertyId}.key.${keyHash}.attempt.${reservation.attempt}.v1`,
      MATERIALIZATION_OPERATION,
      acceptedAt.toISOString(),
      command.propertyId,
      actor.type,
      actor.userId,
      MATERIALIZATION_RESOURCE_TYPE,
      eventId,
      reservation.id,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(redactedMaterializationAudit(command, result)),
      JSON.stringify({
        requestId: command.audit.requestId,
        requestedAt: command.audit.requestedAt,
        actorOrganizationId: command.organizationId,
        actorService: command.audit.actor.kind === "system" ? command.audit.actor.service : null,
        contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
      }),
    ],
  );
}

function platformActor(audit: RoomFactsCommandAudit): Readonly<{
  type: "user" | "system";
  userId: string | null;
}> {
  return audit.actor.kind === "user"
    ? Object.freeze({ type: "user" as const, userId: audit.actor.userId })
    : Object.freeze({ type: "system" as const, userId: null });
}

function redactedMaterializationAudit(
  command: PmsInventoryMaterializationCommand,
  result: PmsInventoryMaterializationResult,
): Record<string, unknown> {
  return {
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    configurationSource: command.configurationSource,
    expectedMaterializedRevision: command.expectedMaterializedRevision,
    horizon: command.horizon,
    outcome: result.ok ? result.outcome : result.error.code,
    ...(result.ok
      ? { changedDayCount: result.changedDayCount, coverage: result.coverage }
      : "currentRevision" in result.error
        ? { currentRevision: result.error.currentRevision }
        : {}),
  };
}

async function readLaunchReadiness(
  pool: PmsInventoryMaterializationRepositoryPool,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  requiredCoverage: PmsInventoryRequiredCoverage,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const coverage = await readCoverage(client, configuration.propertyId);
    const rows = await readReadinessDays(client, configuration, requiredCoverage);
    await client.query("COMMIT");

    const dates = horizonDates(requiredCoverage);
    if (!dates) return null;
    const roomTypeIds = configuration.sourceInputs.roomBindings
      .map(({ roomTypeId }) => roomTypeId)
      .sort(compareCodeUnits);
    const expectedKeys = new Set<string>();
    for (const roomTypeId of roomTypeIds) {
      for (const stayDate of dates) expectedKeys.add(`${roomTypeId}:${stayDate}`);
    }
    const currentRows = rows.filter(
      (row) =>
        nullablePositiveInteger(row.calendarRevision) === configuration.calendarRevision &&
        nullablePositiveInteger(row.generatedSourceRevision) === configuration.calendarRevision,
    );
    const presentKeys = new Set(
      currentRows.map(
        (row) => `${row.roomTypeId.toLowerCase()}:${databaseDate(row.stayDate) ?? ""}`,
      ),
    );
    const gaps = [...expectedKeys]
      .filter((key) => !presentKeys.has(key))
      .map((key) => {
        const separator = key.lastIndexOf(":");
        return Object.freeze({
          roomTypeId: key.slice(0, separator),
          stayDate: key.slice(separator + 1),
        });
      })
      .sort(
        (left, right) =>
          compareCodeUnits(left.roomTypeId, right.roomTypeId) ||
          compareCodeUnits(left.stayDate, right.stayDate),
      );
    const coverageEvidence: PmsInventoryCoverageEvidence = Object.freeze({
      configurationSource: configuration.source,
      materializedRevision: coverage ? positiveInteger(coverage.materializedRevision) : 0,
      coverageFrom: coverage ? requireDatabaseDate(coverage.coverageFrom) : requiredCoverage.from,
      coverageThrough: coverage
        ? requireDatabaseDate(coverage.coverageThrough)
        : requiredCoverage.through,
      roomTypeIds: Object.freeze(roomTypeIds),
      expectedDayCount: coverage
        ? nonNegativeInteger(coverage.expectedDayCount)
        : expectedKeys.size,
      materializedDayCount: coverage
        ? nonNegativeInteger(coverage.materializedDayCount)
        : presentKeys.size,
      gaps: Object.freeze(gaps),
    });
    const sellableLimits = configuration.sourceInputs.roomBindings
      .map((binding): PmsInventorySellableLimitEvidence => {
        const limits = currentRows
          .filter((row) => row.roomTypeId.toLowerCase() === binding.roomTypeId)
          .map(({ effectiveSellableLimitCount }) =>
            effectiveSellableLimitCount === null
              ? -1
              : (nullableNonNegativeInteger(effectiveSellableLimitCount) ?? -1),
          );
        return Object.freeze({
          roomTypeId: binding.roomTypeId,
          sourceRoomFactsRevision: binding.sourceRoomFactsRevision,
          sourceRoomUnitsRevision: binding.sourceRoomUnitsRevision,
          physicalCapacityCount: binding.physicalCapacityCount,
          configuredSellableLimitCount: binding.startingSellableLimitCount,
          minimumEffectiveSellableLimitCount: limits.length > 0 ? Math.min(...limits) : -1,
          maximumEffectiveSellableLimitCount: limits.length > 0 ? Math.max(...limits) : -1,
        });
      })
      .sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
    const snapshot = Object.freeze({
      contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
      propertyId: configuration.propertyId,
      configuration: Object.freeze({
        source: configuration.source,
        calendarRevision: configuration.calendarRevision,
        propertyProfileSource: configuration.sourceInputs.propertyProfile,
        propertyTimeZone: configuration.sourceInputs.propertyTimeZone,
      }),
      roomSet: configuration.sourceInputs.roomBindings,
      materializedRevision: coverage ? positiveInteger(coverage.materializedRevision) : 0,
      coverage: coverageEvidence,
      sellableLimits: Object.freeze(sellableLimits),
    });
    return evaluatePmsInventoryLaunchReadiness(snapshot, requiredCoverage);
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function readCoverage(
  client: PmsInventoryMaterializationRepositoryClient,
  propertyId: string,
): Promise<CoverageRow | null> {
  const result = await client.query<CoverageRow>(
    `SELECT organization_id::text AS "organizationId",
            property_id::text AS "propertyId",
            calendar_revision AS "calendarRevision",
            materialized_revision AS "materializedRevision",
            coverage_from::text AS "coverageFrom",
            coverage_through::text AS "coverageThrough",
            room_type_count AS "roomTypeCount",
            expected_day_count AS "expectedDayCount",
            materialized_day_count AS "materializedDayCount"
     FROM pms.inventory_materialization_coverage
     WHERE property_id = $1::uuid`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS inventory coverage is not unique");
  return result.rows[0] ?? null;
}

async function readReadinessDays(
  client: PmsInventoryMaterializationRepositoryClient,
  configuration: PmsOperatingCalendarConfigurationSnapshot,
  requiredCoverage: PmsInventoryRequiredCoverage,
): Promise<readonly ReadinessDayRow[]> {
  const roomTypeIds = configuration.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId);
  const result = await client.query<ReadinessDayRow>(
    `SELECT room_type_id::text AS "roomTypeId", stay_date::text AS "stayDate",
            calendar_revision AS "calendarRevision",
            generated_source_revision AS "generatedSourceRevision",
            effective_sellable_limit_count AS "effectiveSellableLimitCount"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid
       AND room_type_id = ANY($2::uuid[])
       AND stay_date BETWEEN $3::date AND $4::date
     ORDER BY room_type_id::text COLLATE "C", stay_date`,
    [configuration.propertyId, roomTypeIds, requiredCoverage.from, requiredCoverage.through],
  );
  return Object.freeze(result.rows);
}

function normalizeMaterializationCommand(
  command: PmsInventoryMaterializationCommand,
): PmsInventoryMaterializationCommand | null {
  if (
    !exactDataRecord(command, [
      "organizationId",
      "propertyId",
      "configurationSource",
      "expectedMaterializedRevision",
      "horizon",
      "idempotencyKey",
      "audit",
    ])
  ) {
    return null;
  }
  const organizationId = normalizeUuid(command.organizationId);
  const propertyId = normalizeUuid(command.propertyId);
  const source = parsePmsOperatingCalendarSourceRevision(command.configurationSource);
  const horizon = normalizeRequiredCoverage(command.horizon);
  const audit = normalizeAudit(command.audit);
  if (
    !organizationId ||
    !propertyId ||
    !source ||
    source.entityId !== propertyId ||
    !positiveRevision(command.expectedMaterializedRevision) ||
    source.revision !== `calendar:${command.expectedMaterializedRevision}` ||
    !horizon ||
    !trimmedText(command.idempotencyKey, 1, 200) ||
    !audit
  ) {
    return null;
  }
  return Object.freeze({
    organizationId,
    propertyId,
    configurationSource: source,
    expectedMaterializedRevision: command.expectedMaterializedRevision,
    horizon,
    idempotencyKey: command.idempotencyKey,
    audit,
  });
}

function normalizeAudit(value: unknown): RoomFactsCommandAudit | null {
  if (
    !exactDataRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !trimmedText(value.requestId, 1, 200) ||
    !(value.correlationId === null || trimmedText(value.correlationId, 1, 200)) ||
    !isoTimestamp(value.requestedAt) ||
    !dataRecord(value.actor)
  ) {
    return null;
  }
  if (value.actor.kind === "user") {
    if (!exactDataRecord(value.actor, ["kind", "userId"])) return null;
    const userId = normalizeUuid(value.actor.userId);
    return userId
      ? Object.freeze({
          actor: Object.freeze({ kind: "user" as const, userId }),
          requestId: value.requestId,
          correlationId: value.correlationId,
          requestedAt: value.requestedAt,
        })
      : null;
  }
  if (
    value.actor.kind !== "system" ||
    !exactDataRecord(value.actor, ["kind", "service"]) ||
    !trimmedText(value.actor.service, 1, 100)
  ) {
    return null;
  }
  return Object.freeze({
    actor: Object.freeze({ kind: "system" as const, service: value.actor.service }),
    requestId: value.requestId,
    correlationId: value.correlationId,
    requestedAt: value.requestedAt,
  });
}

function normalizeRequiredCoverage(value: unknown): PmsInventoryRequiredCoverage | null {
  if (!exactDataRecord(value, ["from", "through"])) return null;
  const dates = horizonDates(value);
  return dates
    ? Object.freeze({ from: value.from as string, through: value.through as string })
    : null;
}

function materializationFingerprint(command: PmsInventoryMaterializationCommand): string {
  return stableJson({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    configurationSource: command.configurationSource,
    expectedMaterializedRevision: command.expectedMaterializedRevision,
    horizon: command.horizon,
  });
}

function projectionRefreshIntent(
  command: PmsInventoryMaterializationCommand,
  coverage: PmsInventoryCoverageEvidence,
  outcome: "applied" | "extended" | "rematerialized",
): PmsInventoryProjectionRefreshIntent {
  return Object.freeze({
    contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
    destination: PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
    eventType: "pms.inventory.projection_refresh_requested" as const,
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    configurationSource: coverage.configurationSource,
    materializedRevision: coverage.materializedRevision,
    coverageFrom: coverage.coverageFrom,
    coverageThrough: coverage.coverageThrough,
    roomTypeIds: coverage.roomTypeIds,
    reason:
      outcome === "applied"
        ? "full_horizon_apply"
        : outcome === "extended"
          ? "horizon_extension"
          : "rematerialization",
  });
}

function successUnchanged(
  coverage: PmsInventoryCoverageEvidence,
): PmsInventoryMaterializationResult {
  return Object.freeze({
    ok: true,
    outcome: "unchanged" as const,
    coverage,
    changedDayCount: 0 as const,
    projectionRefreshIntent: null,
  });
}

function failure(
  code:
    | "configuration_not_found"
    | "configuration_not_current"
    | "inventory_invariant_violation"
    | "idempotency_key_conflict"
    | "command_in_progress",
): PmsInventoryMaterializationResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function revisionConflict(currentRevision: number): PmsInventoryMaterializationResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "materialized_revision_conflict" as const, currentRevision }),
  });
}

function sameConfigurationIdentity(
  left: PmsOperatingCalendarConfigurationSnapshot,
  right: PmsOperatingCalendarConfigurationSnapshot,
): boolean {
  return (
    left.propertyId === right.propertyId &&
    left.calendarRevision === right.calendarRevision &&
    stableJson(left.source) === stableJson(right.source) &&
    stableJson(left) === stableJson(right)
  );
}

export function parsePmsInventoryMaterializationResult(
  value: unknown,
): PmsInventoryMaterializationResult | null {
  if (!dataRecord(value) || typeof value.ok !== "boolean") return null;
  if (!value.ok) {
    if (!exactDataRecord(value, ["ok", "error"]) || !dataRecord(value.error)) return null;
    if (
      exactDataRecord(value.error, ["code"]) &&
      oneOf(value.error.code, [
        "configuration_not_found",
        "configuration_not_current",
        "inventory_invariant_violation",
        "idempotency_key_conflict",
        "command_in_progress",
      ] as const)
    ) {
      return failure(value.error.code);
    }
    if (
      exactDataRecord(value.error, ["code", "currentRevision"]) &&
      value.error.code === "materialized_revision_conflict" &&
      positiveRevision(value.error.currentRevision)
    ) {
      return revisionConflict(value.error.currentRevision);
    }
    return null;
  }
  if (
    !exactDataRecord(value, [
      "ok",
      "outcome",
      "coverage",
      "changedDayCount",
      "projectionRefreshIntent",
    ])
  ) {
    return null;
  }
  const coverage = parseStoredCoverage(value.coverage);
  if (!coverage) return null;
  if (
    value.outcome === "unchanged" &&
    value.changedDayCount === 0 &&
    value.projectionRefreshIntent === null
  ) {
    return successUnchanged(coverage);
  }
  if (
    !oneOf(value.outcome, ["applied", "extended", "rematerialized"] as const) ||
    !positiveRevision(value.changedDayCount) ||
    value.changedDayCount > coverage.expectedDayCount
  ) {
    return null;
  }
  const intent = parseStoredProjectionIntent(value.projectionRefreshIntent);
  if (!intent || !intentMatchesCoverage(intent, coverage, value.outcome)) return null;
  return Object.freeze({
    ok: true,
    outcome: value.outcome,
    coverage,
    changedDayCount: value.changedDayCount,
    projectionRefreshIntent: intent,
  });
}

function parseStoredCoverage(value: unknown): PmsInventoryCoverageEvidence | null {
  if (
    !exactDataRecord(value, [
      "configurationSource",
      "materializedRevision",
      "coverageFrom",
      "coverageThrough",
      "roomTypeIds",
      "expectedDayCount",
      "materializedDayCount",
      "gaps",
    ])
  ) {
    return null;
  }
  const source = parsePmsOperatingCalendarSourceRevision(value.configurationSource);
  const horizon = normalizeRequiredCoverage({
    from: value.coverageFrom,
    through: value.coverageThrough,
  });
  const roomTypeIds = parseSortedUuidArray(value.roomTypeIds);
  const dates = horizon ? horizonDates(horizon) : null;
  const expectedDayCount = dates && roomTypeIds ? dates.length * roomTypeIds.length : 0;
  if (
    !source ||
    !horizon ||
    !positiveRevision(value.materializedRevision) ||
    source.revision !== `calendar:${value.materializedRevision}` ||
    !roomTypeIds ||
    !positiveRevision(value.expectedDayCount) ||
    !positiveRevision(value.materializedDayCount) ||
    value.expectedDayCount !== expectedDayCount ||
    value.materializedDayCount !== expectedDayCount ||
    !Array.isArray(value.gaps) ||
    value.gaps.length !== 0
  ) {
    return null;
  }
  return Object.freeze({
    configurationSource: source,
    materializedRevision: value.materializedRevision,
    coverageFrom: horizon.from,
    coverageThrough: horizon.through,
    roomTypeIds,
    expectedDayCount: value.expectedDayCount,
    materializedDayCount: value.materializedDayCount,
    gaps: Object.freeze([]),
  });
}

function parseStoredProjectionIntent(value: unknown): PmsInventoryProjectionRefreshIntent | null {
  if (
    !exactDataRecord(value, [
      "contractVersion",
      "destination",
      "eventType",
      "organizationId",
      "propertyId",
      "configurationSource",
      "materializedRevision",
      "coverageFrom",
      "coverageThrough",
      "roomTypeIds",
      "reason",
    ]) ||
    value.contractVersion !== PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION ||
    value.destination !== PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION ||
    value.eventType !== "pms.inventory.projection_refresh_requested" ||
    !oneOf(value.reason, ["full_horizon_apply", "horizon_extension", "rematerialization"] as const)
  ) {
    return null;
  }
  const organizationId = normalizeUuid(value.organizationId);
  const propertyId = normalizeUuid(value.propertyId);
  const source = parsePmsOperatingCalendarSourceRevision(value.configurationSource);
  const roomTypeIds = parseSortedUuidArray(value.roomTypeIds);
  const horizon = normalizeRequiredCoverage({
    from: value.coverageFrom,
    through: value.coverageThrough,
  });
  if (
    !organizationId ||
    !propertyId ||
    !source ||
    source.entityId !== propertyId ||
    !positiveRevision(value.materializedRevision) ||
    source.revision !== `calendar:${value.materializedRevision}` ||
    !roomTypeIds ||
    !horizon
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION,
    destination: PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION,
    eventType: "pms.inventory.projection_refresh_requested" as const,
    organizationId,
    propertyId,
    configurationSource: source,
    materializedRevision: value.materializedRevision,
    coverageFrom: horizon.from,
    coverageThrough: horizon.through,
    roomTypeIds,
    reason: value.reason,
  });
}

function intentMatchesCoverage(
  intent: PmsInventoryProjectionRefreshIntent,
  coverage: PmsInventoryCoverageEvidence,
  outcome: "applied" | "extended" | "rematerialized",
): boolean {
  const expectedReason =
    outcome === "applied"
      ? "full_horizon_apply"
      : outcome === "extended"
        ? "horizon_extension"
        : "rematerialization";
  return (
    intent.reason === expectedReason &&
    intent.materializedRevision === coverage.materializedRevision &&
    intent.coverageFrom === coverage.coverageFrom &&
    intent.coverageThrough === coverage.coverageThrough &&
    stableJson(intent.configurationSource) === stableJson(coverage.configurationSource) &&
    stableJson(intent.roomTypeIds) === stableJson(coverage.roomTypeIds)
  );
}

function parseSortedUuidArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed = value.map(normalizeUuid);
  if (parsed.some((entry) => !entry)) return null;
  const roomTypeIds = parsed as string[];
  if (
    new Set(roomTypeIds).size !== roomTypeIds.length ||
    roomTypeIds.some(
      (entry, index) => index > 0 && compareCodeUnits(roomTypeIds[index - 1]!, entry) >= 0,
    )
  ) {
    return null;
  }
  return Object.freeze(roomTypeIds);
}

function materializationResultStatus(result: PmsInventoryMaterializationResult): number {
  if (result.ok) return 200;
  return result.error.code === "configuration_not_found" ? 404 : 409;
}

function horizonDates(horizon: unknown): readonly string[] | null {
  if (!dataRecord(horizon) || !canonicalDate(horizon.from) || !canonicalDate(horizon.through)) {
    return null;
  }
  const from = dateNumber(horizon.from);
  const through = dateNumber(horizon.through);
  if (from === null || through === null || through < from) return null;
  const count = Math.floor((through - from) / DAY_MS) + 1;
  if (count < 1 || count > 366) return null;
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      new Date(from + index * DAY_MS).toISOString().slice(0, 10),
    ),
  );
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const instant = dateNumber(value);
  return instant !== null && new Date(instant).toISOString().slice(0, 10) === value;
}

function dateNumber(value: string): number | null {
  const [year, month, day] = value.split("-").map(Number);
  const instant = Date.UTC(year!, month! - 1, day!);
  return Number.isFinite(instant) ? instant : null;
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REVISION;
}

function positiveInteger(value: number | string | null): number {
  const parsed = databaseInteger(value);
  if (!positiveRevision(parsed))
    throw new InventoryInvariantError("PMS inventory revision is invalid");
  return parsed;
}

function nonNegativeInteger(value: number | string | null): number {
  const parsed = databaseInteger(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_REVISION) {
    throw new InventoryInvariantError("PMS inventory counter is invalid");
  }
  return parsed;
}

function nullablePositiveInteger(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = databaseInteger(value);
  return positiveRevision(parsed) ? parsed : null;
}

function nullableNonNegativeInteger(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_REVISION ? parsed : null;
}

function databaseInteger(value: number | string | null): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function databaseTimestamp(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!validDate(parsed)) throw new Error("PMS inventory timestamp is invalid");
  return parsed;
}

function databaseDate(value: Date | string): string | null {
  if (typeof value === "string") return canonicalDate(value) ? value : null;
  return validDate(value) ? value.toISOString().slice(0, 10) : null;
}

function requireDatabaseDate(value: Date | string): string {
  const parsed = databaseDate(value);
  if (!parsed) throw new InventoryInvariantError("PMS inventory date is invalid");
  return parsed;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return validDate(parsed) && parsed.toISOString() === value;
}

function trimmedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function exactDataRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (!dataRecord(value)) return false;
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function dataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!dataRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function rollbackQuietly(client: PmsInventoryMaterializationRepositoryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original command error.
  }
}
