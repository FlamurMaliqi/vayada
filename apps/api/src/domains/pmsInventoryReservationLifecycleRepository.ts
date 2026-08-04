import { createHash, randomUUID } from "node:crypto";

import {
  PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
  PMS_INVENTORY_RESERVATION_LIFECYCLE_IDEMPOTENCY,
  createPmsOperatingCalendarSourceRevision,
  parsePmsInventoryReservationReleaseCommand,
  parsePmsInventoryReservationReleaseResult,
  parsePmsInventoryReservationReserveCommand,
  parsePmsInventoryReservationReserveResult,
  parsePmsInventoryReservationStatus,
  parsePmsInventoryReservationStatusRequest,
  parsePmsOperatingCalendarPropertyProfileEvidence,
  serializePmsInventoryReservationReleaseFingerprint,
  serializePmsInventoryReservationReserveFingerprint,
  type PmsInventoryReservationDayWatermark,
  type PmsInventoryReservationLifecyclePort,
  type PmsInventoryReservationProjectionRefreshIntent,
  type PmsInventoryReservationReleaseCommand,
  type PmsInventoryReservationReleaseResult,
  type PmsInventoryReservationReserveCommand,
  type PmsInventoryReservationReserveResult,
  type PmsInventoryReservationStatus,
  type PmsInventoryReservationStatusReadPort,
  type PmsInventoryReservationStatusRequest,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarPropertyProfileEvidenceResult,
  type PmsOperatingCalendarReadPort,
  type RoomCapacityReadPort,
  type RoomFactsCommandAudit,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

const RESERVE_OPERATION = PMS_INVENTORY_RESERVATION_LIFECYCLE_IDEMPOTENCY.reserve.operation;
const RELEASE_OPERATION = PMS_INVENTORY_RESERVATION_LIFECYCLE_IDEMPOTENCY.release.operation;
const RESOURCE_TYPE = "inventory_reservation";
const DESTINATION = "distribution.inventory-projection";
const MAX_REVISION = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const DAY_MS = 86_400_000;

export type PmsInventoryReservationLifecycleAuthorizationPort = {
  authorizeInventoryReservationScope(
    request: Readonly<{
      organizationId: string;
      propertyId: string;
      action: "reserve" | "release" | "status";
      audit: RoomFactsCommandAudit | null;
    }>,
  ): Promise<boolean>;
};

export type PmsInventoryReservationLifecycleRepositoryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInventoryReservationLifecycleRepositoryPool = {
  connect(): Promise<PmsInventoryReservationLifecycleRepositoryClient>;
  end(): Promise<void>;
};

export type PmsInventoryReservationLifecycleRepositoryConfig = Readonly<{
  connectionString?: string;
  max?: number;
  pool?: PmsInventoryReservationLifecycleRepositoryPool;
  now?: () => Date;
  createReceiptId?: () => string;
  authorization: PmsInventoryReservationLifecycleAuthorizationPort;
  operatingCalendar: PmsOperatingCalendarReadPort;
  propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort;
  roomCapacity: RoomCapacityReadPort;
}>;

export type PmsInventoryReservationLifecycleRepository = PmsInventoryReservationLifecyclePort &
  PmsInventoryReservationStatusReadPort & { close(): Promise<void> };

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | string | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
};

type IdempotencyReservation = Readonly<{ id: string }>;

type CoverageRow = {
  organizationId: string;
  propertyId: string;
  calendarRevision: number | string;
  materializedRevision: number | string;
  coverageFrom: Date | string;
  coverageThrough: Date | string;
};

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
  availableCount: number | string;
};

type CanonicalInventoryDay = Readonly<{
  propertyId: string;
  roomTypeId: string;
  stayDate: string;
  calendarRevision: number;
  inventoryRevision: number;
  generatedSourceRevision: number;
  channelSourceRevision: number;
  manualSourceRevision: number;
  blockSourceRevision: number;
  bookingSourceRevision: number;
  status: "open" | "closed";
  totalCount: number;
  generatedSellableLimitCount: number;
  channelSellableLimitCount: number | null;
  manualSellableLimitCount: number | null;
  effectiveSellableLimitCount: number;
  assignedCount: number;
  blockedCount: number;
  availableCount: number;
}>;

type ReservationRootRow = {
  receiptId: string;
  contractVersion: string;
  receiptOwner: string;
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  checkIn: Date | string;
  checkOut: Date | string;
  roomCount: number | string;
  quoteSessionId: string;
  publicOfferKey: string;
  calendarRevision: number | string;
  materializedRevision: number | string;
  reservedAt: Date | string;
  lifecycleState: string;
  lifecycleRevision: number | string;
  releasedAt: Date | string | null;
  handedOffAt: Date | string | null;
};

type WatermarkRow = {
  propertyId: string;
  roomTypeId: string;
  stayDate: Date | string;
  calendarRevision: number | string;
  inventoryRevision: number | string;
  generatedSourceRevision: number | string;
  channelSourceRevision: number | string;
  manualSourceRevision: number | string;
  blockSourceRevision: number | string;
  bookingSourceRevision: number | string;
};

class InventoryInvariantError extends Error {}

export function createPgPmsInventoryReservationLifecycleRepository(
  config: PmsInventoryReservationLifecycleRepositoryConfig,
): PmsInventoryReservationLifecycleRepository {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS inventory reservation connectionString must not be empty");
  }
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as PmsInventoryReservationLifecycleRepositoryPool);
  const now = config.now ?? (() => new Date());
  const createReceiptId = config.createReceiptId ?? randomUUID;

  return {
    async reserveInventory(command) {
      const normalized = safelyParseReserveCommand(command);
      if (!normalized) return reserveFailure("inventory_invariant_violation");
      if (
        !(await config.authorization.authorizeInventoryReservationScope({
          organizationId: normalized.organizationId,
          propertyId: normalized.propertyId,
          action: "reserve",
          audit: normalized.audit,
        }))
      ) {
        return reserveFailure("configuration_not_current");
      }
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("PMS inventory reservation clock is invalid");
      return executeReserve(pool, config, normalized, acceptedAt, createReceiptId);
    },

    async releaseInventory(command) {
      const normalized = safelyParseReleaseCommand(command);
      if (!normalized) return releaseFailure("inventory_invariant_violation");
      if (
        !(await config.authorization.authorizeInventoryReservationScope({
          organizationId: normalized.organizationId,
          propertyId: normalized.propertyId,
          action: "release",
          audit: normalized.audit,
        }))
      ) {
        return releaseFailure("receipt_not_found");
      }
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("PMS inventory reservation clock is invalid");
      return executeRelease(pool, config, normalized, acceptedAt);
    },

    async getInventoryReservationStatus(request) {
      const normalized = safelyParseStatusRequest(request);
      if (!normalized) return null;
      if (
        !(await config.authorization.authorizeInventoryReservationScope({
          organizationId: normalized.organizationId,
          propertyId: normalized.propertyId,
          action: "status",
          audit: null,
        }))
      ) {
        return null;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const status = await readReservationStatus(client, normalized, false);
        await client.query("COMMIT");
        return status;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function executeReserve(
  pool: PmsInventoryReservationLifecycleRepositoryPool,
  config: PmsInventoryReservationLifecycleRepositoryConfig,
  command: PmsInventoryReservationReserveCommand,
  acceptedAt: Date,
  createReceiptId: () => string,
): Promise<PmsInventoryReservationReserveResult> {
  const keyHash = hash(command.idempotencyKey);
  const fingerprint = hash(serializePmsInventoryReservationReserveFingerprint(command));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPmsInventoryMutationScope(client, command.propertyId);
    const replay = await findReserveReplay(client, command, keyHash, fingerprint);
    if (replay) {
      await rollbackQuietly(client);
      return replay;
    }
    const idempotency = await reserveIdempotency(
      client,
      RESERVE_OPERATION,
      command.propertyId,
      keyHash,
      fingerprint,
      command.audit,
      acceptedAt,
    );
    if (!idempotency) {
      const concurrent = await findReserveReplay(client, command, keyHash, fingerprint);
      await rollbackQuietly(client);
      return concurrent ?? reserveFailure("command_in_progress");
    }

    const immutable = await config.operatingCalendar.getOperatingCalendarConfigurationBySource(
      command.configurationSource,
    );
    if (!immutable) {
      return finalizeReserve(
        client,
        command,
        idempotency,
        keyHash,
        reserveFailure("configuration_not_current"),
        acceptedAt,
      );
    }
    const profileRevision = propertyProfileRevision(immutable);
    if (profileRevision === null) {
      return finalizeReserve(
        client,
        command,
        idempotency,
        keyHash,
        reserveFailure("configuration_not_current"),
        acceptedAt,
      );
    }

    return config.propertyProfileEvidence.runWithPropertyProfileEvidence(
      { propertyId: command.propertyId, expectedProfileRevision: profileRevision },
      async (profileEvidence) => {
        if (
          !profileEvidenceMatchesConfiguration(
            profileEvidence,
            immutable,
            config.propertyProfileEvidence,
          )
        ) {
          return finalizeReserve(
            client,
            command,
            idempotency,
            keyHash,
            reserveFailure("configuration_not_current"),
            acceptedAt,
          );
        }

        await lockPmsRoomFactsMutationScope(client, command.propertyId);
        await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, command.roomTypeId);
        const current = await config.operatingCalendar.getCurrentOperatingCalendarConfiguration(
          command.propertyId,
        );
        const exact = await config.operatingCalendar.getOperatingCalendarConfigurationBySource(
          command.configurationSource,
        );
        if (
          !current ||
          current.sourceStatus !== "current" ||
          !exact ||
          !sameConfigurationIdentity(immutable, exact) ||
          !sameConfigurationIdentity(current.configuration, exact) ||
          exact.calendarRevision !== command.expectedMaterializedRevision
        ) {
          return finalizeReserve(
            client,
            command,
            idempotency,
            keyHash,
            reserveFailure("configuration_not_current"),
            acceptedAt,
          );
        }
        const binding = exact.sourceInputs.roomBindings.find(
          ({ roomTypeId }) => roomTypeId === command.roomTypeId,
        );
        const capacity = await config.roomCapacity.getRoomTypeCapacity(
          command.propertyId,
          command.roomTypeId,
        );
        if (
          !binding ||
          !capacity ||
          capacity.propertyId !== command.propertyId ||
          capacity.roomTypeId !== command.roomTypeId ||
          capacity.roomUnitsRevision !== binding.sourceRoomUnitsRevision ||
          capacity.activeUnitCount !== binding.physicalCapacityCount
        ) {
          return finalizeReserve(
            client,
            command,
            idempotency,
            keyHash,
            reserveFailure("configuration_not_current"),
            acceptedAt,
          );
        }

        const coverage = await lockCoverage(client, command.propertyId);
        if (!coverageCoversCommand(coverage, command)) {
          return finalizeReserve(
            client,
            command,
            idempotency,
            keyHash,
            reserveFailure("materialization_not_current"),
            acceptedAt,
          );
        }
        let days: readonly CanonicalInventoryDay[];
        try {
          days = await lockInventoryDays(
            client,
            command.propertyId,
            command.roomTypeId,
            command.checkIn,
            command.checkOut,
          );
        } catch (error) {
          if (!(error instanceof InventoryInvariantError)) throw error;
          return finalizeReserve(
            client,
            command,
            idempotency,
            keyHash,
            reserveFailure("inventory_invariant_violation"),
            acceptedAt,
          );
        }
        const validation = validateReserveDays(command, days, binding.physicalCapacityCount);
        if (validation !== null) {
          return finalizeReserve(
            client,
            command,
            idempotency,
            keyHash,
            reserveFailure(validation),
            acceptedAt,
          );
        }

        await client.query("SAVEPOINT pms_inventory_reserve_mutation");
        try {
          await applyBookingDelta(client, days, command.roomCount, acceptedAt);
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT pms_inventory_reserve_mutation");
          if (!(error instanceof InventoryInvariantError) && !isConstraintError(error)) throw error;
          return finalizeReserve(
            client,
            command,
            idempotency,
            keyHash,
            reserveFailure("inventory_invariant_violation"),
            acceptedAt,
          );
        }
        await client.query("RELEASE SAVEPOINT pms_inventory_reserve_mutation");

        const receiptId = normalizeUuid(createReceiptId());
        if (!receiptId)
          throw new Error("PMS inventory reservation receipt factory returned invalid UUID");
        const intent = projectionIntent(command, 1, "reservation_held");
        const event = await enqueueProjectionRefresh(
          client,
          command.audit,
          command.propertyId,
          receiptId,
          keyHash,
          intent,
          acceptedAt,
        );
        await persistReceipt(
          client,
          command,
          receiptId,
          fingerprint,
          idempotency.id,
          event.eventId,
          event.outboxEventId,
          acceptedAt,
        );
        const status = statusFromReserve(command, receiptId, acceptedAt);
        const result: PmsInventoryReservationReserveResult = Object.freeze({
          ok: true,
          outcome: "reserved",
          status,
          projectionRefreshIntent: intent,
        });
        return finalizeReserve(
          client,
          command,
          idempotency,
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

async function executeRelease(
  pool: PmsInventoryReservationLifecycleRepositoryPool,
  config: PmsInventoryReservationLifecycleRepositoryConfig,
  command: PmsInventoryReservationReleaseCommand,
  acceptedAt: Date,
): Promise<PmsInventoryReservationReleaseResult> {
  const keyHash = hash(command.idempotencyKey);
  const fingerprint = hash(serializePmsInventoryReservationReleaseFingerprint(command));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPmsInventoryMutationScope(client, command.propertyId);
    let status = await readReservationStatus(client, command, true);
    if (!status) {
      await rollbackQuietly(client);
      return releaseFailure("receipt_not_found");
    }
    const replay = await findReleaseReplay(client, command, status, keyHash, fingerprint);
    if (replay) {
      await rollbackQuietly(client);
      return replay;
    }
    const idempotency = await reserveIdempotency(
      client,
      RELEASE_OPERATION,
      command.propertyId,
      keyHash,
      fingerprint,
      command.audit,
      acceptedAt,
    );
    if (!idempotency) {
      status = (await readReservationStatus(client, command, true)) ?? status;
      const concurrent = await findReleaseReplay(client, command, status, keyHash, fingerprint);
      await rollbackQuietly(client);
      return concurrent ?? releaseFailure("command_in_progress");
    }

    if (status.state !== "reserved") {
      const terminal = releaseTerminalResult(status);
      return finalizeRelease(client, command, idempotency, keyHash, terminal, acceptedAt);
    }

    await lockPmsRoomFactsMutationScope(client, command.propertyId);
    await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, status.roomTypeId);
    let days: readonly CanonicalInventoryDay[];
    try {
      days = await lockInventoryDays(
        client,
        status.propertyId,
        status.roomTypeId,
        status.checkIn,
        status.checkOut,
      );
    } catch (error) {
      if (!(error instanceof InventoryInvariantError)) throw error;
      return finalizeRelease(
        client,
        command,
        idempotency,
        keyHash,
        releaseFailure("inventory_invariant_violation"),
        acceptedAt,
      );
    }
    const capacity = await config.roomCapacity.getRoomTypeCapacity(
      status.propertyId,
      status.roomTypeId,
    );
    const physicalCapacity =
      capacity?.propertyId === status.propertyId && capacity.roomTypeId === status.roomTypeId
        ? capacity.activeUnitCount
        : null;
    if (!validateReleaseDays(status, days, physicalCapacity)) {
      return finalizeRelease(
        client,
        command,
        idempotency,
        keyHash,
        releaseFailure("inventory_invariant_violation"),
        acceptedAt,
      );
    }

    await client.query("SAVEPOINT pms_inventory_release_mutation");
    try {
      await applyBookingDelta(client, days, -status.roomCount, acceptedAt);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT pms_inventory_release_mutation");
      if (!(error instanceof InventoryInvariantError) && !isConstraintError(error)) throw error;
      return finalizeRelease(
        client,
        command,
        idempotency,
        keyHash,
        releaseFailure("inventory_invariant_violation"),
        acceptedAt,
      );
    }
    await client.query("RELEASE SAVEPOINT pms_inventory_release_mutation");

    const releasedStatus: PmsInventoryReservationStatus & Readonly<{ state: "released" }> =
      Object.freeze({
        ...status,
        state: "released",
        lifecycleRevision: 2,
        releasedAt: acceptedAt.toISOString(),
      });
    const intent = projectionIntent(status, 2, "reservation_released");
    const event = await enqueueProjectionRefresh(
      client,
      command.audit,
      command.propertyId,
      status.receipt.receiptId,
      keyHash,
      intent,
      acceptedAt,
    );
    const transitioned = await client.query(
      `UPDATE pms.inventory_reservation_statuses
       SET lifecycle_state = 'released', lifecycle_revision = 2,
           release_fingerprint_hash = $2,
           release_idempotency_key_id = $3::uuid,
           release_domain_event_id = $4::uuid,
           release_outbox_event_id = $5::uuid,
           released_at = $6::timestamptz
       WHERE receipt_id = $1::uuid
         AND organization_id = $7::uuid
         AND property_id = $8::uuid
         AND lifecycle_state = 'reserved'
         AND lifecycle_revision = 1`,
      [
        status.receipt.receiptId,
        fingerprint,
        idempotency.id,
        event.eventId,
        event.outboxEventId,
        acceptedAt.toISOString(),
        command.organizationId,
        command.propertyId,
      ],
    );
    if (transitioned.rowCount !== 1) {
      throw new InventoryInvariantError("PMS inventory reservation release transition failed");
    }
    const result: PmsInventoryReservationReleaseResult = Object.freeze({
      ok: true,
      outcome: "released",
      status: releasedStatus,
      projectionRefreshIntent: intent,
    });
    return finalizeRelease(
      client,
      command,
      idempotency,
      keyHash,
      result,
      acceptedAt,
      event.eventId,
    );
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function lockCoverage(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  propertyId: string,
): Promise<CoverageRow | null> {
  const result = await client.query<CoverageRow>(
    `SELECT organization_id::text AS "organizationId",
            property_id::text AS "propertyId",
            calendar_revision AS "calendarRevision",
            materialized_revision AS "materializedRevision",
            coverage_from::text AS "coverageFrom",
            coverage_through::text AS "coverageThrough"
     FROM pms.inventory_materialization_coverage
     WHERE property_id = $1::uuid
     FOR UPDATE`,
    [propertyId],
  );
  if (result.rows.length > 1) throw new InventoryInvariantError("Inventory coverage is not unique");
  return result.rows[0] ?? null;
}

function coverageCoversCommand(
  coverage: CoverageRow | null,
  command: PmsInventoryReservationReserveCommand,
): boolean {
  if (!coverage) return false;
  const checkoutPrevious = shiftDate(command.checkOut, -1);
  return (
    normalizeUuid(coverage.organizationId) === command.organizationId &&
    normalizeUuid(coverage.propertyId) === command.propertyId &&
    databaseInteger(coverage.calendarRevision) === command.expectedMaterializedRevision &&
    databaseInteger(coverage.materializedRevision) === command.expectedMaterializedRevision &&
    databaseDate(coverage.coverageFrom) !== null &&
    databaseDate(coverage.coverageFrom)! <= command.checkIn &&
    checkoutPrevious !== null &&
    databaseDate(coverage.coverageThrough) !== null &&
    databaseDate(coverage.coverageThrough)! >= checkoutPrevious
  );
}

async function lockInventoryDays(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  propertyId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
): Promise<readonly CanonicalInventoryDay[]> {
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
            status, total_count AS "totalCount",
            generated_sellable_limit_count AS "generatedSellableLimitCount",
            channel_sellable_limit_count AS "channelSellableLimitCount",
            manual_sellable_limit_count AS "manualSellableLimitCount",
            effective_sellable_limit_count AS "effectiveSellableLimitCount",
            assigned_count AS "assignedCount", blocked_count AS "blockedCount",
            available_count AS "availableCount"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
       AND stay_date >= $3::date
       AND stay_date < $4::date
     ORDER BY stay_date
     FOR UPDATE`,
    [propertyId, roomTypeId, checkIn, checkOut],
  );
  return Object.freeze(
    result.rows.map((row) => {
      const day = canonicalInventoryDay(row);
      if (!day) throw new InventoryInvariantError("Inventory day is legacy or malformed");
      return day;
    }),
  );
}

function canonicalInventoryDay(row: InventoryDayRow): CanonicalInventoryDay | null {
  const propertyId = normalizeUuid(row.propertyId);
  const roomTypeId = normalizeUuid(row.roomTypeId);
  const stayDate = databaseDate(row.stayDate);
  const calendarRevision = positiveDatabaseInteger(row.calendarRevision);
  const inventoryRevision = positiveDatabaseInteger(row.inventoryRevision);
  const generatedSourceRevision = positiveDatabaseInteger(row.generatedSourceRevision);
  const channelSourceRevision = nonNegativeDatabaseInteger(row.channelSourceRevision);
  const manualSourceRevision = nonNegativeDatabaseInteger(row.manualSourceRevision);
  const blockSourceRevision = nonNegativeDatabaseInteger(row.blockSourceRevision);
  const bookingSourceRevision = nonNegativeDatabaseInteger(row.bookingSourceRevision);
  const totalCount = nonNegativeDatabaseInteger(row.totalCount);
  const generatedSellableLimitCount = nonNegativeDatabaseInteger(row.generatedSellableLimitCount);
  const channelSellableLimitCount = nullableNonNegativeDatabaseInteger(
    row.channelSellableLimitCount,
  );
  const manualSellableLimitCount = nullableNonNegativeDatabaseInteger(row.manualSellableLimitCount);
  const effectiveSellableLimitCount = nonNegativeDatabaseInteger(row.effectiveSellableLimitCount);
  const assignedCount = nonNegativeDatabaseInteger(row.assignedCount);
  const blockedCount = nonNegativeDatabaseInteger(row.blockedCount);
  const availableCount = nonNegativeDatabaseInteger(row.availableCount);
  if (
    !propertyId ||
    !roomTypeId ||
    !stayDate ||
    calendarRevision === null ||
    inventoryRevision === null ||
    generatedSourceRevision === null ||
    channelSourceRevision === null ||
    manualSourceRevision === null ||
    blockSourceRevision === null ||
    bookingSourceRevision === null ||
    totalCount === null ||
    generatedSellableLimitCount === null ||
    (row.channelSellableLimitCount !== null && channelSellableLimitCount === null) ||
    (row.manualSellableLimitCount !== null && manualSellableLimitCount === null) ||
    effectiveSellableLimitCount === null ||
    assignedCount === null ||
    blockedCount === null ||
    availableCount === null ||
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
    generatedSourceRevision,
    channelSourceRevision,
    manualSourceRevision,
    blockSourceRevision,
    bookingSourceRevision,
    status: row.status,
    totalCount,
    generatedSellableLimitCount,
    channelSellableLimitCount:
      row.channelSellableLimitCount === null ? null : channelSellableLimitCount,
    manualSellableLimitCount:
      row.manualSellableLimitCount === null ? null : manualSellableLimitCount,
    effectiveSellableLimitCount,
    assignedCount,
    blockedCount,
    availableCount,
  });
}

function validateReserveDays(
  command: PmsInventoryReservationReserveCommand,
  days: readonly CanonicalInventoryDay[],
  physicalCapacity: number,
):
  | "materialization_not_current"
  | "inventory_watermark_conflict"
  | "inventory_unavailable"
  | "inventory_invariant_violation"
  | null {
  const dates = stayDates(command.checkIn, command.checkOut);
  if (
    !dates ||
    days.length !== dates.length ||
    command.inventoryWatermarks.length !== dates.length
  ) {
    return "materialization_not_current";
  }
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index]!;
    const day = days[index]!;
    const watermark = command.inventoryWatermarks[index]!;
    if (
      day.propertyId !== command.propertyId ||
      day.roomTypeId !== command.roomTypeId ||
      day.stayDate !== date ||
      day.calendarRevision !== command.expectedMaterializedRevision ||
      day.generatedSourceRevision !== command.expectedMaterializedRevision
    ) {
      return "materialization_not_current";
    }
    if (!watermarkMatchesDay(watermark, day)) return "inventory_watermark_conflict";
    if (!dayInvariant(day) || day.totalCount !== physicalCapacity) {
      return "inventory_invariant_violation";
    }
    if (
      day.status !== "open" ||
      day.availableCount < command.roomCount ||
      day.assignedCount + day.blockedCount + command.roomCount > day.totalCount
    ) {
      return "inventory_unavailable";
    }
    if (day.inventoryRevision === MAX_REVISION || day.bookingSourceRevision === MAX_REVISION) {
      return "inventory_invariant_violation";
    }
  }
  return null;
}

function validateReleaseDays(
  status: PmsInventoryReservationStatus & Readonly<{ state: "reserved" }>,
  days: readonly CanonicalInventoryDay[],
  physicalCapacity: number | null,
): boolean {
  const dates = stayDates(status.checkIn, status.checkOut);
  if (!dates || physicalCapacity === null || days.length !== dates.length) return false;
  return days.every(
    (day, index) =>
      day.propertyId === status.propertyId &&
      day.roomTypeId === status.roomTypeId &&
      day.stayDate === dates[index] &&
      day.totalCount === physicalCapacity &&
      dayInvariant(day) &&
      day.assignedCount >= status.roomCount &&
      day.inventoryRevision < MAX_REVISION &&
      day.bookingSourceRevision < MAX_REVISION,
  );
}

function dayInvariant(day: CanonicalInventoryDay): boolean {
  const effective =
    day.manualSellableLimitCount ??
    day.channelSellableLimitCount ??
    day.generatedSellableLimitCount;
  const expectedAvailable =
    day.status === "closed"
      ? 0
      : Math.max(0, day.effectiveSellableLimitCount - day.assignedCount - day.blockedCount);
  return (
    day.generatedSourceRevision === day.calendarRevision &&
    day.generatedSellableLimitCount <= day.totalCount &&
    (day.channelSellableLimitCount === null || day.channelSellableLimitCount <= day.totalCount) &&
    (day.manualSellableLimitCount === null || day.manualSellableLimitCount <= day.totalCount) &&
    day.effectiveSellableLimitCount === effective &&
    day.assignedCount + day.blockedCount <= day.totalCount &&
    day.availableCount === expectedAvailable
  );
}

function watermarkMatchesDay(
  watermark: PmsInventoryReservationDayWatermark,
  day: CanonicalInventoryDay,
): boolean {
  return (
    watermark.propertyId === day.propertyId &&
    watermark.roomTypeId === day.roomTypeId &&
    watermark.stayDate === day.stayDate &&
    watermark.calendarRevision === day.calendarRevision &&
    watermark.inventoryRevision === day.inventoryRevision &&
    watermark.sourceRevisions.generated === day.generatedSourceRevision &&
    watermark.sourceRevisions.channel === day.channelSourceRevision &&
    watermark.sourceRevisions.manual === day.manualSourceRevision &&
    watermark.sourceRevisions.block === day.blockSourceRevision &&
    watermark.sourceRevisions.booking === day.bookingSourceRevision
  );
}

async function applyBookingDelta(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  days: readonly CanonicalInventoryDay[],
  delta: number,
  acceptedAt: Date,
): Promise<void> {
  for (const day of days) {
    const assignedCount = day.assignedCount + delta;
    if (assignedCount < 0 || assignedCount + day.blockedCount > day.totalCount) {
      throw new InventoryInvariantError("Inventory booking delta violates physical capacity");
    }
    const availableCount =
      day.status === "closed"
        ? 0
        : Math.max(0, day.effectiveSellableLimitCount - assignedCount - day.blockedCount);
    const result = await client.query(
      `UPDATE pms.inventory_days
       SET assigned_count = $4,
           available_count = $5,
           inventory_revision = $6,
           booking_source_revision = $7,
           updated_at = $8::timestamptz
       WHERE property_id = $1::uuid
         AND room_type_id = $2::uuid
         AND stay_date = $3::date
         AND assigned_count = $9
         AND blocked_count = $10
         AND effective_sellable_limit_count = $11
         AND inventory_revision = $12
         AND booking_source_revision = $13`,
      [
        day.propertyId,
        day.roomTypeId,
        day.stayDate,
        assignedCount,
        availableCount,
        day.inventoryRevision + 1,
        day.bookingSourceRevision + 1,
        acceptedAt.toISOString(),
        day.assignedCount,
        day.blockedCount,
        day.effectiveSellableLimitCount,
        day.inventoryRevision,
        day.bookingSourceRevision,
      ],
    );
    if (result.rowCount !== 1)
      throw new InventoryInvariantError("Inventory day changed under lock");
  }
}

async function persistReceipt(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  command: PmsInventoryReservationReserveCommand,
  receiptId: string,
  fingerprint: string,
  idempotencyId: string,
  eventId: string,
  outboxEventId: string,
  acceptedAt: Date,
): Promise<void> {
  const receipt = await client.query(
    `INSERT INTO pms.inventory_reservation_receipts (
       receipt_id, contract_version, receipt_owner, organization_id, property_id,
       room_type_id, check_in, check_out, room_count, quote_session_id,
       public_offer_key, calendar_revision, materialized_revision,
       reserve_fingerprint_hash, reserve_idempotency_key_id,
       reserve_domain_event_id, reserve_outbox_event_id, reserved_at
     ) VALUES (
       $1::uuid, $2, 'pms', $3::uuid, $4::uuid, $5::uuid, $6::date, $7::date,
       $8, $9, $10, $11, $11, $12, $13::uuid, $14::uuid, $15::uuid,
       $16::timestamptz
     )`,
    [
      receiptId,
      PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
      command.organizationId,
      command.propertyId,
      command.roomTypeId,
      command.checkIn,
      command.checkOut,
      command.roomCount,
      command.offerCorrelation.quoteSessionId,
      command.offerCorrelation.publicOfferKey,
      command.expectedMaterializedRevision,
      fingerprint,
      idempotencyId,
      eventId,
      outboxEventId,
      acceptedAt.toISOString(),
    ],
  );
  if (receipt.rowCount !== 1) throw new Error("PMS inventory reservation receipt insert failed");
  const status = await client.query(
    `INSERT INTO pms.inventory_reservation_statuses (
       receipt_id, organization_id, property_id, lifecycle_state, lifecycle_revision
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'reserved', 1)`,
    [receiptId, command.organizationId, command.propertyId],
  );
  if (status.rowCount !== 1) throw new Error("PMS inventory reservation status insert failed");
  for (const watermark of command.inventoryWatermarks) {
    const persisted = await client.query(
      `INSERT INTO pms.inventory_reservation_day_watermarks (
         receipt_id, organization_id, property_id, room_type_id, stay_date,
         calendar_revision, inventory_revision, generated_source_revision,
         channel_source_revision, manual_source_revision, block_source_revision,
         booking_source_revision
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, $7, $8,
         $9, $10, $11, $12
       )`,
      [
        receiptId,
        command.organizationId,
        command.propertyId,
        command.roomTypeId,
        watermark.stayDate,
        watermark.calendarRevision,
        watermark.inventoryRevision,
        watermark.sourceRevisions.generated,
        watermark.sourceRevisions.channel,
        watermark.sourceRevisions.manual,
        watermark.sourceRevisions.block,
        watermark.sourceRevisions.booking,
      ],
    );
    if (persisted.rowCount !== 1) {
      throw new Error("PMS inventory reservation watermark insert failed");
    }
  }
}

async function readReservationStatus(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  request: Pick<PmsInventoryReservationStatusRequest, "organizationId" | "propertyId" | "receipt">,
  lock: boolean,
): Promise<PmsInventoryReservationStatus | null> {
  const root = await client.query<ReservationRootRow>(
    `SELECT receipt.receipt_id::text AS "receiptId",
            receipt.contract_version AS "contractVersion",
            receipt.receipt_owner AS "receiptOwner",
            receipt.organization_id::text AS "organizationId",
            receipt.property_id::text AS "propertyId",
            receipt.room_type_id::text AS "roomTypeId",
            receipt.check_in::text AS "checkIn", receipt.check_out::text AS "checkOut",
            receipt.room_count AS "roomCount", receipt.quote_session_id AS "quoteSessionId",
            receipt.public_offer_key AS "publicOfferKey",
            receipt.calendar_revision AS "calendarRevision",
            receipt.materialized_revision AS "materializedRevision",
            receipt.reserved_at AS "reservedAt",
            status.lifecycle_state AS "lifecycleState",
            status.lifecycle_revision AS "lifecycleRevision",
            status.released_at AS "releasedAt", status.handed_off_at AS "handedOffAt"
     FROM pms.inventory_reservation_receipts AS receipt
     JOIN pms.inventory_reservation_statuses AS status
       ON status.receipt_id = receipt.receipt_id
      AND status.organization_id = receipt.organization_id
      AND status.property_id = receipt.property_id
     WHERE receipt.receipt_id = $1::uuid
       AND receipt.organization_id = $2::uuid
       AND receipt.property_id = $3::uuid
     ${lock ? "FOR UPDATE OF receipt, status" : ""}`,
    [request.receipt.receiptId, request.organizationId, request.propertyId],
  );
  if (root.rows.length !== 1) return null;
  const watermarks = await client.query<WatermarkRow>(
    `SELECT property_id::text AS "propertyId", room_type_id::text AS "roomTypeId",
            stay_date::text AS "stayDate", calendar_revision AS "calendarRevision",
            inventory_revision AS "inventoryRevision",
            generated_source_revision AS "generatedSourceRevision",
            channel_source_revision AS "channelSourceRevision",
            manual_source_revision AS "manualSourceRevision",
            block_source_revision AS "blockSourceRevision",
            booking_source_revision AS "bookingSourceRevision"
     FROM pms.inventory_reservation_day_watermarks
     WHERE receipt_id = $1::uuid
       AND organization_id = $2::uuid
       AND property_id = $3::uuid
     ORDER BY stay_date`,
    [request.receipt.receiptId, request.organizationId, request.propertyId],
  );
  return reservationStatusFromRows(root.rows[0]!, watermarks.rows);
}

function reservationStatusFromRows(
  root: ReservationRootRow,
  watermarks: readonly WatermarkRow[],
): PmsInventoryReservationStatus | null {
  try {
    const calendarRevision = positiveDatabaseInteger(root.calendarRevision);
    const materializedRevision = positiveDatabaseInteger(root.materializedRevision);
    if (
      root.contractVersion !== PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION ||
      root.receiptOwner !== "pms" ||
      calendarRevision === null ||
      materializedRevision !== calendarRevision
    ) {
      return null;
    }
    const reservationWatermarks = watermarks.map((row) => ({
      propertyId: row.propertyId,
      roomTypeId: row.roomTypeId,
      stayDate: databaseDate(row.stayDate),
      calendarRevision: databaseInteger(row.calendarRevision),
      inventoryRevision: databaseInteger(row.inventoryRevision),
      sourceRevisions: {
        generated: databaseInteger(row.generatedSourceRevision),
        channel: databaseInteger(row.channelSourceRevision),
        manual: databaseInteger(row.manualSourceRevision),
        block: databaseInteger(row.blockSourceRevision),
        booking: databaseInteger(row.bookingSourceRevision),
      },
    }));
    const base = {
      receipt: {
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        owner: "pms",
        receiptId: root.receiptId,
      },
      organizationId: root.organizationId,
      propertyId: root.propertyId,
      roomTypeId: root.roomTypeId,
      checkIn: databaseDate(root.checkIn),
      checkOut: databaseDate(root.checkOut),
      roomCount: databaseInteger(root.roomCount),
      offerCorrelation: {
        quoteSessionId: root.quoteSessionId,
        publicOfferKey: root.publicOfferKey,
      },
      configurationSource: createPmsOperatingCalendarSourceRevision(
        root.propertyId,
        calendarRevision,
      ),
      materializedRevision,
      reservationWatermarks,
      lifecycleRevision: databaseInteger(root.lifecycleRevision),
      reservedAt: databaseTimestamp(root.reservedAt)?.toISOString(),
      state: root.lifecycleState,
      ...(root.lifecycleState === "released"
        ? { releasedAt: databaseTimestamp(root.releasedAt)?.toISOString() }
        : root.lifecycleState === "handed_off"
          ? { handedOffAt: databaseTimestamp(root.handedOffAt)?.toISOString() }
          : {}),
    };
    return parsePmsInventoryReservationStatus(base);
  } catch {
    return null;
  }
}

async function findReserveReplay(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  command: PmsInventoryReservationReserveCommand,
  keyHash: string,
  fingerprint: string,
): Promise<PmsInventoryReservationReserveResult | null> {
  const existing = await findIdempotency(client, RESERVE_OPERATION, command.propertyId, keyHash);
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return reserveFailure("idempotency_key_conflict");
  }
  if (existing.status !== "completed") return reserveFailure("command_in_progress");
  const stored = dataRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = safelyParseReserveResult(stored);
  if (
    !parsed ||
    databaseInteger(existing.responseStatusCode) !== reserveResultStatus(parsed) ||
    existing.responseBodyHash !== hash(stableJson(parsed))
  ) {
    return reserveFailure("idempotency_key_conflict");
  }
  if (!parsed.ok) return parsed;
  if (
    parsed.outcome !== "reserved" ||
    !reserveStatusMatchesCommand(parsed.status, command) ||
    !(await reserveReceiptEvidenceMatches(client, parsed.status, existing.id, fingerprint))
  ) {
    return reserveFailure("idempotency_key_conflict");
  }
  const current = await readReservationStatus(client, parsed.status, true);
  return current && sameReservationIdentity(current, parsed.status)
    ? reserveReplayResult(current)
    : reserveFailure("idempotency_key_conflict");
}

async function findReleaseReplay(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  command: PmsInventoryReservationReleaseCommand,
  current: PmsInventoryReservationStatus,
  keyHash: string,
  fingerprint: string,
): Promise<PmsInventoryReservationReleaseResult | null> {
  const existing = await findIdempotency(client, RELEASE_OPERATION, command.propertyId, keyHash);
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    return releaseFailure("idempotency_key_conflict");
  }
  if (existing.status !== "completed") return releaseFailure("command_in_progress");
  const stored = dataRecord(existing.idempotencyMetadata)
    ? existing.idempotencyMetadata["result"]
    : undefined;
  const parsed = safelyParseReleaseResult(stored);
  if (
    !parsed ||
    databaseInteger(existing.responseStatusCode) !== releaseResultStatus(parsed) ||
    existing.responseBodyHash !== hash(stableJson(parsed))
  ) {
    return releaseFailure("idempotency_key_conflict");
  }
  if (!parsed.ok) {
    return current.state === "reserved" ? parsed : releaseTerminalResult(current);
  }
  if (
    parsed.outcome === "released" &&
    !(await releaseStatusEvidenceMatches(client, command, existing.id, fingerprint))
  ) {
    return releaseFailure("idempotency_key_conflict");
  }
  return current.state !== "reserved" &&
    sameReservationIdentity(current, parsed.status) &&
    current.receipt.receiptId === command.receipt.receiptId
    ? releaseTerminalResult(current)
    : releaseFailure("idempotency_key_conflict");
}

async function reserveReceiptEvidenceMatches(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  status: PmsInventoryReservationStatus,
  idempotencyId: string,
  fingerprint: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM pms.inventory_reservation_receipts
     WHERE receipt_id = $1::uuid
       AND organization_id = $2::uuid
       AND property_id = $3::uuid
       AND reserve_idempotency_key_id = $4::uuid
       AND reserve_fingerprint_hash = $5`,
    [
      status.receipt.receiptId,
      status.organizationId,
      status.propertyId,
      idempotencyId,
      fingerprint,
    ],
  );
  return result.rowCount === 1;
}

async function releaseStatusEvidenceMatches(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  command: PmsInventoryReservationReleaseCommand,
  idempotencyId: string,
  fingerprint: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM pms.inventory_reservation_statuses
     WHERE receipt_id = $1::uuid
       AND organization_id = $2::uuid
       AND property_id = $3::uuid
       AND lifecycle_state = 'released'
       AND release_idempotency_key_id = $4::uuid
       AND release_fingerprint_hash = $5`,
    [
      command.receipt.receiptId,
      command.organizationId,
      command.propertyId,
      idempotencyId,
      fingerprint,
    ],
  );
  return result.rowCount === 1;
}

async function findIdempotency(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  operation: string,
  propertyId: string,
  keyHash: string,
): Promise<IdempotencyRow | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND organization_id IS NULL
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, propertyId],
  );
  if (result.rows.length > 1) throw new Error("PMS inventory idempotency is not unique");
  return result.rows[0] ?? null;
}

async function reserveIdempotency(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  operation: string,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
  audit: RoomFactsCommandAudit,
  acceptedAt: Date,
): Promise<IdempotencyReservation | null> {
  const result = await client.query<IdempotencyReservation>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, 'infinity'::timestamptz,
       jsonb_build_object('attempt', 1)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      operation,
      keyHash,
      fingerprint,
      propertyId,
      audit.correlationId ?? audit.requestId,
      acceptedAt.toISOString(),
    ],
  );
  return result.rows[0] ?? null;
}

async function completeIdempotency(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  id: string,
  result: PmsInventoryReservationReserveResult | PmsInventoryReservationReleaseResult,
  status: number,
  acceptedAt: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         completed_at = $4::timestamptz, last_seen_at = $4::timestamptz,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [id, status, hash(stableJson(result)), acceptedAt.toISOString(), JSON.stringify(result)],
  );
  if (completed.rowCount !== 1) throw new Error("PMS inventory idempotency completion failed");
}

async function enqueueProjectionRefresh(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  audit: RoomFactsCommandAudit,
  propertyId: string,
  receiptId: string,
  keyHash: string,
  intent: PmsInventoryReservationProjectionRefreshIntent,
  acceptedAt: Date,
): Promise<Readonly<{ eventId: string; outboxEventId: string }>> {
  const actor = platformActor(audit);
  const suffix = intent.reason === "reservation_held" ? "held" : "released";
  const event = await client.query<{ eventId: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id, resource_product,
       resource_type, resource_id, actor_type, actor_user_id, correlation_id,
       causation_id, idempotency_key_hash, payload, event_metadata, privacy_scope
     ) VALUES (
       'pms', $1, $2, 1, $3::timestamptz, 'property', NULL, $4::uuid, 'pms',
       $5, $6, $7, $8::uuid, $9, $10, $11, $12::jsonb, $13::jsonb, 'confidential'
     ) RETURNING id::text AS "eventId"`,
    [
      `pms.inventory-reservation.${suffix}.receipt.${receiptId}.key.${keyHash}.v1`,
      intent.eventType,
      acceptedAt.toISOString(),
      propertyId,
      RESOURCE_TYPE,
      receiptId,
      actor.type,
      actor.userId,
      audit.correlationId ?? audit.requestId,
      audit.requestId,
      keyHash,
      JSON.stringify(intent),
      JSON.stringify({
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("PMS inventory reservation event insert failed");
  const outbox = await client.query<{ outboxEventId: string }>(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       organization_id, property_id, resource_product, resource_type,
       resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, $3, $4, 'property', NULL, $5::uuid, 'pms', $6, $7,
       $8, $9, $10::jsonb, $11::jsonb
     ) RETURNING id::text AS "outboxEventId"`,
    [
      eventId,
      `${DESTINATION}.receipt.${receiptId}.${suffix}.key.${keyHash}.v1`,
      DESTINATION,
      intent.eventType,
      propertyId,
      RESOURCE_TYPE,
      receiptId,
      audit.correlationId ?? audit.requestId,
      keyHash,
      JSON.stringify(intent),
      JSON.stringify({
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        sourceReadRequired: true,
      }),
    ],
  );
  const outboxEventId = outbox.rows[0]?.outboxEventId;
  if (!outboxEventId) throw new Error("PMS inventory reservation outbox insert failed");
  return Object.freeze({ eventId, outboxEventId });
}

async function finalizeReserve(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  command: PmsInventoryReservationReserveCommand,
  idempotency: IdempotencyReservation,
  keyHash: string,
  result: PmsInventoryReservationReserveResult,
  acceptedAt: Date,
  eventId: string | null = null,
): Promise<PmsInventoryReservationReserveResult> {
  await recordAudit(
    client,
    RESERVE_OPERATION,
    command.audit,
    command.organizationId,
    command.propertyId,
    result.ok ? result.status.receipt.receiptId : command.propertyId,
    idempotency.id,
    keyHash,
    result.ok ? result.outcome : result.error.code,
    eventId,
    acceptedAt,
    {
      roomTypeId: command.roomTypeId,
      checkIn: command.checkIn,
      checkOut: command.checkOut,
      roomCount: command.roomCount,
    },
  );
  await completeIdempotency(
    client,
    idempotency.id,
    result,
    reserveResultStatus(result),
    acceptedAt,
  );
  await client.query("COMMIT");
  return result;
}

async function finalizeRelease(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  command: PmsInventoryReservationReleaseCommand,
  idempotency: IdempotencyReservation,
  keyHash: string,
  result: PmsInventoryReservationReleaseResult,
  acceptedAt: Date,
  eventId: string | null = null,
): Promise<PmsInventoryReservationReleaseResult> {
  await recordAudit(
    client,
    RELEASE_OPERATION,
    command.audit,
    command.organizationId,
    command.propertyId,
    command.receipt.receiptId,
    idempotency.id,
    keyHash,
    result.ok ? result.outcome : result.error.code,
    eventId,
    acceptedAt,
    {},
  );
  await completeIdempotency(
    client,
    idempotency.id,
    result,
    releaseResultStatus(result),
    acceptedAt,
  );
  await client.query("COMMIT");
  return result;
}

async function recordAudit(
  client: PmsInventoryReservationLifecycleRepositoryClient,
  operation: string,
  audit: RoomFactsCommandAudit,
  organizationId: string,
  propertyId: string,
  targetId: string,
  idempotencyId: string,
  keyHash: string,
  outcome: string,
  eventId: string | null,
  acceptedAt: Date,
  scope: Readonly<Record<string, unknown>>,
): Promise<void> {
  const actor = platformActor(audit);
  const action = operation === RESERVE_OPERATION ? "reserve" : "release";
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       property_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, domain_event_id, idempotency_key_id,
       correlation_id, causation_id, redacted_payload, private_payload,
       audit_metadata, privacy_scope
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', NULL, $4::uuid, $5,
       $6::uuid, 'pms', $7, $8, $9::uuid, $10::uuid, $11, $12,
       $13::jsonb, '{}'::jsonb, $14::jsonb, 'confidential'
     )`,
    [
      `pms.inventory-reservation.${action}.property.${propertyId}.key.${keyHash}.v1`,
      operation,
      acceptedAt.toISOString(),
      propertyId,
      actor.type,
      actor.userId,
      RESOURCE_TYPE,
      targetId,
      eventId,
      idempotencyId,
      audit.correlationId ?? audit.requestId,
      audit.requestId,
      JSON.stringify({ organizationId, propertyId, ...scope, outcome }),
      JSON.stringify({
        requestId: audit.requestId,
        requestedAt: audit.requestedAt,
        actorOrganizationId: organizationId,
        actorService: audit.actor.kind === "system" ? audit.actor.service : null,
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
      }),
    ],
  );
}

function statusFromReserve(
  command: PmsInventoryReservationReserveCommand,
  receiptId: string,
  acceptedAt: Date,
): PmsInventoryReservationStatus & Readonly<{ state: "reserved" }> {
  return Object.freeze({
    receipt: Object.freeze({
      contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
      owner: "pms" as const,
      receiptId,
    }),
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    checkIn: command.checkIn,
    checkOut: command.checkOut,
    roomCount: command.roomCount,
    offerCorrelation: command.offerCorrelation,
    configurationSource: command.configurationSource,
    materializedRevision: command.expectedMaterializedRevision,
    reservationWatermarks: command.inventoryWatermarks,
    reservedAt: acceptedAt.toISOString(),
    state: "reserved" as const,
    lifecycleRevision: 1 as const,
  });
}

function projectionIntent<const Reason extends "reservation_held" | "reservation_released">(
  scope: Pick<
    PmsInventoryReservationReserveCommand | PmsInventoryReservationStatus,
    "organizationId" | "propertyId" | "roomTypeId" | "checkIn" | "checkOut"
  >,
  lifecycleRevision: number,
  reason: Reason,
): PmsInventoryReservationProjectionRefreshIntent & Readonly<{ reason: Reason }> {
  return Object.freeze({
    contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
    destination: DESTINATION,
    eventType: "pms.inventory.projection_refresh_requested" as const,
    organizationId: scope.organizationId,
    propertyId: scope.propertyId,
    roomTypeId: scope.roomTypeId,
    coverageFrom: scope.checkIn,
    coverageThroughExclusive: scope.checkOut,
    reservationLifecycleRevision: lifecycleRevision,
    reason,
  });
}

function reserveReplayResult(
  status: PmsInventoryReservationStatus,
): PmsInventoryReservationReserveResult {
  return status.state === "reserved"
    ? Object.freeze({
        ok: true as const,
        outcome: "already_reserved" as const,
        status,
        projectionRefreshIntent: null,
      })
    : status.state === "released"
      ? Object.freeze({
          ok: true as const,
          outcome: "already_released" as const,
          status,
          projectionRefreshIntent: null,
        })
      : Object.freeze({
          ok: true as const,
          outcome: "already_handed_off" as const,
          status,
          projectionRefreshIntent: null,
        });
}

function releaseTerminalResult(
  status: PmsInventoryReservationStatus,
): PmsInventoryReservationReleaseResult {
  if (status.state === "reserved") {
    throw new InventoryInvariantError("Reserved status is not a terminal release result");
  }
  return status.state === "released"
    ? Object.freeze({
        ok: true as const,
        outcome: "already_released" as const,
        status,
        projectionRefreshIntent: null,
      })
    : Object.freeze({
        ok: true as const,
        outcome: "already_handed_off" as const,
        status,
        projectionRefreshIntent: null,
      });
}

function reserveStatusMatchesCommand(
  status: PmsInventoryReservationStatus,
  command: PmsInventoryReservationReserveCommand,
): boolean {
  return (
    status.organizationId === command.organizationId &&
    status.propertyId === command.propertyId &&
    status.roomTypeId === command.roomTypeId &&
    status.checkIn === command.checkIn &&
    status.checkOut === command.checkOut &&
    status.roomCount === command.roomCount &&
    stableJson(status.offerCorrelation) === stableJson(command.offerCorrelation) &&
    stableJson(status.configurationSource) === stableJson(command.configurationSource) &&
    status.materializedRevision === command.expectedMaterializedRevision &&
    stableJson(status.reservationWatermarks) === stableJson(command.inventoryWatermarks)
  );
}

function sameReservationIdentity(
  left: PmsInventoryReservationStatus,
  right: PmsInventoryReservationStatus,
): boolean {
  return (
    left.receipt.receiptId === right.receipt.receiptId &&
    left.organizationId === right.organizationId &&
    left.propertyId === right.propertyId &&
    left.roomTypeId === right.roomTypeId &&
    left.checkIn === right.checkIn &&
    left.checkOut === right.checkOut &&
    left.roomCount === right.roomCount &&
    left.reservedAt === right.reservedAt &&
    stableJson(left.offerCorrelation) === stableJson(right.offerCorrelation) &&
    stableJson(left.configurationSource) === stableJson(right.configurationSource) &&
    left.materializedRevision === right.materializedRevision &&
    stableJson(left.reservationWatermarks) === stableJson(right.reservationWatermarks)
  );
}

function safelyParseReserveCommand(value: unknown): PmsInventoryReservationReserveCommand | null {
  return safelyParse(parsePmsInventoryReservationReserveCommand, value);
}

function safelyParseReleaseCommand(value: unknown): PmsInventoryReservationReleaseCommand | null {
  return safelyParse(parsePmsInventoryReservationReleaseCommand, value);
}

function safelyParseStatusRequest(value: unknown): PmsInventoryReservationStatusRequest | null {
  return safelyParse(parsePmsInventoryReservationStatusRequest, value);
}

function safelyParseReserveResult(value: unknown): PmsInventoryReservationReserveResult | null {
  return safelyParse(parsePmsInventoryReservationReserveResult, value);
}

function safelyParseReleaseResult(value: unknown): PmsInventoryReservationReleaseResult | null {
  return safelyParse(parsePmsInventoryReservationReleaseResult, value);
}

function safelyParse<T>(parser: (value: unknown) => T | null, value: unknown): T | null {
  try {
    return parser(value);
  } catch {
    return null;
  }
}

function reserveFailure(
  code:
    | "configuration_not_current"
    | "materialization_not_current"
    | "inventory_watermark_conflict"
    | "inventory_unavailable"
    | "inventory_invariant_violation"
    | "idempotency_key_conflict"
    | "command_in_progress",
): PmsInventoryReservationReserveResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function releaseFailure(
  code:
    | "receipt_not_found"
    | "inventory_invariant_violation"
    | "idempotency_key_conflict"
    | "command_in_progress",
): PmsInventoryReservationReleaseResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function reserveResultStatus(result: PmsInventoryReservationReserveResult): number {
  return result.ok && result.outcome === "reserved" ? 201 : result.ok ? 200 : 409;
}

function releaseResultStatus(result: PmsInventoryReservationReleaseResult): number {
  return !result.ok && result.error.code === "receipt_not_found" ? 404 : result.ok ? 200 : 409;
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

function platformActor(audit: RoomFactsCommandAudit): Readonly<{
  type: "user" | "system";
  userId: string | null;
}> {
  return audit.actor.kind === "user"
    ? Object.freeze({ type: "user" as const, userId: audit.actor.userId })
    : Object.freeze({ type: "system" as const, userId: null });
}

function stayDates(checkIn: string, checkOut: string): readonly string[] | null {
  if (!canonicalDate(checkIn) || !canonicalDate(checkOut)) return null;
  const first = dateNumber(checkIn);
  const exclusive = dateNumber(checkOut);
  if (first === null || exclusive === null || exclusive <= first) return null;
  const count = (exclusive - first) / DAY_MS;
  if (!Number.isInteger(count) || count < 1 || count > 366) return null;
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      new Date(first + index * DAY_MS).toISOString().slice(0, 10),
    ),
  );
}

function shiftDate(value: string, days: number): string | null {
  const instant = canonicalDate(value) ? dateNumber(value) : null;
  return instant === null ? null : new Date(instant + days * DAY_MS).toISOString().slice(0, 10);
}

function canonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
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

function positiveDatabaseInteger(value: number | string | null): number | null {
  const parsed = databaseInteger(value);
  return positiveRevision(parsed) ? parsed : null;
}

function nonNegativeDatabaseInteger(value: number | string | null): number | null {
  const parsed = databaseInteger(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_REVISION ? parsed : null;
}

function nullableNonNegativeDatabaseInteger(value: number | string | null): number | null {
  return value === null ? null : nonNegativeDatabaseInteger(value);
}

function databaseInteger(value: number | string | null): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
}

function databaseDate(value: Date | string): string | null {
  if (typeof value === "string") return canonicalDate(value) ? value : null;
  return validDate(value) ? value.toISOString().slice(0, 10) : null;
}

function databaseTimestamp(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return validDate(parsed) ? parsed : null;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as Readonly<{ code?: unknown }>).code === "23514"
  );
}

async function rollbackQuietly(
  client: PmsInventoryReservationLifecycleRepositoryClient,
): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original command error.
  }
}
