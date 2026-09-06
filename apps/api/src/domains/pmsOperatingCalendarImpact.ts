import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  PMS_OPERATING_CALENDAR_AUTHORIZATION,
  PMS_OPERATING_CALENDAR_IMPACT_CONFIRMATION_TTL_SECONDS,
  PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
  parsePmsOperatingCalendarImpactPreviewResult,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  resolvePmsOperatingCalendarPropertyProfileConflict,
  serializePmsOperatingCalendarProposalFingerprint,
  type PmsOperatingCalendarCommandError,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarImpact,
  type PmsOperatingCalendarImpactAffectedDate,
  type PmsOperatingCalendarImpactCategory,
  type PmsOperatingCalendarImpactPreviewPort,
  type PmsOperatingCalendarImpactPreviewResult,
  type PmsOperatingCalendarImpactRoomTypeChange,
  type PmsOperatingCalendarImpactSourceRevisions,
  type PmsOperatingCalendarPropertyProfileEvidence,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarProposal,
  type PmsOperatingCalendarRoomBinding,
  type PmsOperatingCalendarRoomEvidencePorts,
  type PreviewPmsOperatingCalendarImpactCommand,
  type RoomTypeCapacitySnapshot,
  type RoomTypeFactsSnapshot,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { loadPmsOperatingCalendarConfigurationByRevision } from "./pmsOperatingCalendarReadModel.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

export type PmsOperatingCalendarImpactClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsOperatingCalendarImpactPool = {
  connect(): Promise<PmsOperatingCalendarImpactClient>;
  end(): Promise<void>;
};

export type PmsOperatingCalendarImpactServiceConfig = Readonly<{
  connectionString?: string;
  max?: number;
  pool?: PmsOperatingCalendarImpactPool;
  propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort;
  roomEvidence: PmsOperatingCalendarRoomEvidencePorts;
  confirmationSecret: string;
  now?: () => Date;
}>;

export type PmsOperatingCalendarLockedImpactInput = Readonly<{
  client: PmsOperatingCalendarImpactClient;
  proposal: PmsOperatingCalendarProposal;
  profile: PmsOperatingCalendarPropertyProfileEvidence;
  roomBindings: readonly PmsOperatingCalendarRoomBinding[];
  currentConfiguration: PmsOperatingCalendarConfigurationSnapshot | null;
}>;

export type PmsOperatingCalendarImpactConfirmationVerifier = Readonly<{
  /** Caller holds inventory, profile, room-facts, and sorted unit locks. */
  verifyLockedImpactConfirmation(
    input: PmsOperatingCalendarLockedImpactInput &
      Readonly<{ command: UpsertPmsOperatingCalendarCommand; acceptedAt: Date }>,
  ): Promise<PmsOperatingCalendarCommandError | null>;
}>;

export type PmsOperatingCalendarImpactService = PmsOperatingCalendarImpactPreviewPort &
  PmsOperatingCalendarImpactConfirmationVerifier &
  Readonly<{ close(): Promise<void> }>;

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

type InventoryDayRow = {
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
  sourceFreshness: unknown;
};

type InventoryDay = Readonly<{
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

type ReservationRow = {
  organizationId: string;
  receiptId: string;
  roomTypeId: string;
  checkIn: Date | string;
  checkOut: Date | string;
  roomCount: number | string;
  lifecycleState: string;
  lifecycleRevision: number | string;
};

type ActiveReservation = Readonly<{
  receiptId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  lifecycleState: "reserved" | "handed_off";
  lifecycleRevision: 1 | 2;
}>;

type LockedSources = Readonly<{
  sourceRevisions: PmsOperatingCalendarImpactSourceRevisions;
  sourceFingerprint: string;
  impact: PmsOperatingCalendarImpact;
}>;

class ImpactSourceInvariantError extends Error {}
class ImpactSourceNotCurrentError extends Error {}

export function createPgPmsOperatingCalendarImpactService(
  config: PmsOperatingCalendarImpactServiceConfig,
): PmsOperatingCalendarImpactService {
  if (config.confirmationSecret.length < 32) {
    throw new Error("PMS operating-calendar impact confirmation secret must be at least 32 bytes");
  }
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim()) {
    throw new Error("PMS operating-calendar impact connectionString must not be empty");
  }
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as PmsOperatingCalendarImpactPool);
  const now = config.now ?? (() => new Date());

  return {
    async previewOperatingCalendarImpact(command) {
      const generatedAt = now();
      if (!validDate(generatedAt))
        throw new Error("PMS operating-calendar impact clock is invalid");
      return previewLocked(pool, config, command, generatedAt);
    },

    async verifyLockedImpactConfirmation(input) {
      const token = verifyToken(
        input.command.impactConfirmation,
        config.confirmationSecret,
        input.acceptedAt,
      );
      if (token === "expired") return failure("impact_confirmation_expired");
      if (!token || token.propertyId !== input.command.propertyId) {
        return failure("impact_confirmation_invalid");
      }
      const proposalFingerprint = sha256(
        serializePmsOperatingCalendarProposalFingerprint(input.command),
      );
      if (
        token.proposalFingerprint !== proposalFingerprint ||
        input.command.impactConfirmation.proposalFingerprint !== proposalFingerprint
      ) {
        return failure("impact_confirmation_configuration_mismatch");
      }
      let sources: LockedSources;
      try {
        sources = await readLockedSources(input, input.acceptedAt);
      } catch (error) {
        if (error instanceof ImpactSourceNotCurrentError) {
          return failure("impact_confirmation_stale");
        }
        throw error;
      }
      return token.sourceFingerprint === sources.sourceFingerprint &&
        input.command.impactConfirmation.sourceFingerprint === sources.sourceFingerprint
        ? null
        : failure("impact_confirmation_stale");
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };

  function failure(code: Extract<PmsOperatingCalendarCommandError, { code: string }>["code"]) {
    return Object.freeze({ code }) as PmsOperatingCalendarCommandError;
  }
}

async function previewLocked(
  pool: PmsOperatingCalendarImpactPool,
  config: PmsOperatingCalendarImpactServiceConfig,
  command: PreviewPmsOperatingCalendarImpactCommand,
  generatedAt: Date,
): Promise<PmsOperatingCalendarImpactPreviewResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (!(await lockAuthorizedScope(client, command, generatedAt))) {
      await rollbackQuietly(client);
      return previewFailure({ code: "setup_scope_unavailable" });
    }
    await lockPmsInventoryMutationScope(client, command.propertyId);
    return await config.propertyProfileEvidence.runWithPropertyProfileEvidence(
      {
        propertyId: command.propertyId,
        expectedProfileRevision: command.expectedPropertyProfileRevision,
      },
      async (profileResult) => {
        const profileConflict = resolvePmsOperatingCalendarPropertyProfileConflict(
          profileResult,
          command.expectedPropertyProfileRevision,
          config.propertyProfileEvidence,
        );
        if (profileConflict) {
          await rollbackQuietly(client);
          return previewFailure(profileConflict);
        }
        if (profileResult.status !== "available") {
          throw new Error("PMS operating-calendar impact profile evidence is invalid");
        }

        await lockPmsRoomFactsMutationScope(client, command.propertyId);
        const currentRevision = await latestRevision(client, command.propertyId);
        if (currentRevision !== command.expectedCalendarRevision) {
          await rollbackQuietly(client);
          return previewFailure({ code: "calendar_revision_conflict", currentRevision });
        }
        const factsBeforeLocks = await readRoomFacts(config.roomEvidence, command.propertyId);
        const activeIds = factsBeforeLocks
          .filter(({ lifecycle }) => lifecycle === "active")
          .map(({ roomTypeId }) => roomTypeId);
        if (activeIds.length === 0) {
          await rollbackQuietly(client);
          return previewFailure({ code: "active_room_type_set_empty" });
        }
        const commandIds = command.roomTypeLimits.map(({ roomTypeId }) => roomTypeId);
        for (const roomTypeId of sortedUnique([...activeIds, ...commandIds])) {
          await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, roomTypeId);
        }
        const facts = (await readRoomFacts(config.roomEvidence, command.propertyId)).filter(
          ({ lifecycle }) => lifecycle === "active",
        );
        if (facts.length === 0) {
          await rollbackQuietly(client);
          return previewFailure({ code: "active_room_type_set_empty" });
        }
        const currentIds = facts.map(({ roomTypeId }) => roomTypeId);
        if (!sameStrings(currentIds, commandIds)) {
          await rollbackQuietly(client);
          return previewFailure({ code: "room_type_set_conflict", currentRoomTypeIds: currentIds });
        }
        const bindings = await validateBindings(config.roomEvidence, command, facts);
        if (bindingFailure(bindings)) {
          await rollbackQuietly(client);
          return previewFailure(bindings);
        }
        const currentConfiguration =
          currentRevision === 0
            ? null
            : await loadPmsOperatingCalendarConfigurationByRevision(
                client,
                command.propertyId,
                currentRevision,
                config.propertyProfileEvidence,
              );
        if (currentRevision > 0 && !currentConfiguration) {
          throw new ImpactSourceInvariantError("Current operating calendar disappeared");
        }
        const sources = await readLockedSources(
          {
            client,
            proposal: command,
            profile: profileResult.evidence,
            roomBindings: bindings,
            currentConfiguration,
          },
          generatedAt,
        );
        const proposalFingerprint = sha256(
          serializePmsOperatingCalendarProposalFingerprint(command),
        );
        const confirmation = issueToken(
          {
            propertyId: command.propertyId,
            proposalFingerprint,
            sourceFingerprint: sources.sourceFingerprint,
          },
          config.confirmationSecret,
          generatedAt,
        );
        const parsed = parsePmsOperatingCalendarImpactPreviewResult({
          ok: true,
          preview: {
            contractVersion: PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
            propertyId: command.propertyId,
            proposalFingerprint,
            sourceFingerprint: sources.sourceFingerprint,
            sourceRevisions: sources.sourceRevisions,
            impact: sources.impact,
            confirmation,
            generatedAt: generatedAt.toISOString(),
          },
        });
        if (!parsed?.ok) throw new Error("PMS operating-calendar impact result is invalid");
        await rollbackQuietly(client);
        return parsed;
      },
    );
  } catch (error) {
    await rollbackQuietly(client);
    if (error instanceof ImpactSourceNotCurrentError) {
      return previewFailure({ code: "materialization_not_current" });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function readLockedSources(
  input: PmsOperatingCalendarLockedImpactInput,
  generatedAt: Date,
): Promise<LockedSources> {
  const coverage = await readCoverage(input.client, input.proposal.propertyId);
  if (coverage && normalizeUuid(coverage.organizationId) !== input.proposal.organizationId) {
    throw new ImpactSourceInvariantError("Inventory coverage escaped organization scope");
  }
  const currentCalendarRevision = input.currentConfiguration?.calendarRevision ?? 0;
  if (
    (currentCalendarRevision === 0 && coverage !== null) ||
    (currentCalendarRevision > 0 &&
      (!coverage ||
        positiveInteger(coverage.calendarRevision) !== currentCalendarRevision ||
        positiveInteger(coverage.materializedRevision) !== currentCalendarRevision))
  ) {
    throw new ImpactSourceNotCurrentError("Inventory materialization is not current");
  }
  const currentBindings = input.currentConfiguration?.sourceInputs.roomBindings ?? [];
  const inventoryBindings = coverage ? currentBindings : input.roomBindings;
  const days = await readInventoryDays(
    input.client,
    input.proposal.propertyId,
    coverage,
    inventoryBindings,
  );
  const currentCapacityByRoom = new Map(
    currentBindings.map(({ roomTypeId, physicalCapacityCount }) => [
      roomTypeId,
      physicalCapacityCount,
    ]),
  );
  if (
    days.some(
      (day) =>
        day.totalCount !== currentCapacityByRoom.get(day.roomTypeId) ||
        day.status !==
          (input.currentConfiguration &&
          scheduleOpen(input.currentConfiguration.schedule, day.stayDate)
            ? "open"
            : "closed"),
    )
  ) {
    throw new ImpactSourceNotCurrentError("Inventory materialization evidence is stale");
  }
  const localToday = hotelLocalDate(generatedAt, input.profile.timeZone);
  const reservations = await readActiveReservations(
    input.client,
    input.proposal.organizationId,
    input.proposal.propertyId,
    localToday,
  );
  const sourceRevisions = buildSourceRevisions(input, coverage, days, reservations);
  const sourceFingerprint = sha256(
    stableJson({
      calendar: input.currentConfiguration?.source ?? null,
      sourceRevisions,
    }),
  );
  return Object.freeze({
    sourceRevisions,
    sourceFingerprint,
    impact: computeImpact(input.proposal, input.currentConfiguration, days, reservations),
  });
}

function buildSourceRevisions(
  input: PmsOperatingCalendarLockedImpactInput,
  coverage: CoverageRow | null,
  days: readonly InventoryDay[],
  reservations: readonly ActiveReservation[],
): PmsOperatingCalendarImpactSourceRevisions {
  const inventoryPayload = days.map((day) => ({
    roomTypeId: day.roomTypeId,
    stayDate: day.stayDate,
    calendarRevision: day.calendarRevision,
    inventoryRevision: day.inventoryRevision,
    status: day.status,
    totalCount: day.totalCount,
    generatedSellableLimitCount: day.generatedSellableLimitCount,
    channelSellableLimitCount: day.channelSellableLimitCount,
    manualSellableLimitCount: day.manualSellableLimitCount,
    effectiveSellableLimitCount: day.effectiveSellableLimitCount,
    assignedCount: day.assignedCount,
    blockedCount: day.blockedCount,
    availableCount: day.availableCount,
    generatedSourceRevision: day.generatedSourceRevision,
  }));
  const bookingPayload = {
    days: days.map(({ roomTypeId, stayDate, assignedCount, bookingSourceRevision }) => ({
      roomTypeId,
      stayDate,
      assignedCount,
      bookingSourceRevision,
    })),
    reservations,
  };
  const blockPayload = days.map(({ roomTypeId, stayDate, blockedCount, blockSourceRevision }) => ({
    roomTypeId,
    stayDate,
    blockedCount,
    blockSourceRevision,
  }));
  const overridePayload = days.map(
    ({
      roomTypeId,
      stayDate,
      channelSellableLimitCount,
      manualSellableLimitCount,
      channelSourceRevision,
      manualSourceRevision,
    }) => ({
      roomTypeId,
      stayDate,
      channelSellableLimitCount,
      manualSellableLimitCount,
      channelSourceRevision,
      manualSourceRevision,
    }),
  );
  return deepFreeze({
    calendarRevision: input.currentConfiguration?.calendarRevision ?? 0,
    propertyProfile: {
      revision: profileRevision(input.profile.source.revision),
      timeZone: input.profile.timeZone,
    },
    roomTypes: input.roomBindings.map((room) => ({
      roomTypeId: room.roomTypeId,
      roomFactsRevision: room.sourceRoomFactsRevision,
      roomUnitsRevision: room.sourceRoomUnitsRevision,
      physicalCapacityCount: room.physicalCapacityCount,
    })),
    inventory: {
      materializedRevision: coverage ? positiveInteger(coverage.materializedRevision) : null,
      coverageFrom: coverage ? databaseDate(coverage.coverageFrom) : null,
      coverageThrough: coverage ? databaseDate(coverage.coverageThrough) : null,
      dayCount: days.length,
      inventoryFingerprint: sha256(stableJson(inventoryPayload)),
      bookingFingerprint: sha256(stableJson(bookingPayload)),
      blockFingerprint: sha256(stableJson(blockPayload)),
      overrideFingerprint: sha256(stableJson(overridePayload)),
      activeReservationCount: reservations.length,
    },
  });
}

function computeImpact(
  proposal: PmsOperatingCalendarProposal,
  current: PmsOperatingCalendarConfigurationSnapshot | null,
  days: readonly InventoryDay[],
  reservations: readonly ActiveReservation[],
): PmsOperatingCalendarImpact {
  const proposedLimits = new Map(
    proposal.roomTypeLimits.map(({ roomTypeId, startingSellableLimitCount }) => [
      roomTypeId,
      startingSellableLimitCount,
    ]),
  );
  const proposedRoomIds = new Set(proposedLimits.keys());
  const currentRoomIds = new Set(
    current?.sourceInputs.roomBindings.map(({ roomTypeId }) => roomTypeId) ?? [],
  );
  const reservationsByDate = new Map<string, ActiveReservation[]>();
  const affectedReservationIds = new Set<string>();
  let acceptedBookedRoomNights = 0;
  for (const reservation of reservations) {
    for (const stayDate of stayDates(reservation.checkIn, reservation.checkOut)) {
      const entries = reservationsByDate.get(stayDate) ?? [];
      entries.push(reservation);
      reservationsByDate.set(stayDate, entries);
      if (
        current &&
        ((currentRoomIds.has(reservation.roomTypeId) &&
          !proposedRoomIds.has(reservation.roomTypeId)) ||
          (scheduleOpen(current.schedule, stayDate) && !scheduleOpen(proposal.schedule, stayDate)))
      ) {
        affectedReservationIds.add(reservation.receiptId);
        acceptedBookedRoomNights += reservation.roomCount;
      }
    }
  }

  const dateAggregates = new Map<
    string,
    {
      before: number;
      after: number;
      assigned: number;
      blocked: number;
      currentOpen: boolean;
      proposedOpen: boolean;
      override: boolean;
    }
  >();
  const roomDeltas = new Map<string, number>();
  for (const day of days) {
    const proposedGenerated = proposedLimits.get(day.roomTypeId);
    const proposedOpen =
      proposedGenerated !== undefined && scheduleOpen(proposal.schedule, day.stayDate);
    const proposedEffective =
      proposedGenerated === undefined
        ? 0
        : (day.manualSellableLimitCount ?? day.channelSellableLimitCount ?? proposedGenerated);
    const proposedAvailable = proposedOpen
      ? Math.max(0, proposedEffective - day.assignedCount - day.blockedCount)
      : 0;
    const aggregate = dateAggregates.get(day.stayDate) ?? {
      before: 0,
      after: 0,
      assigned: 0,
      blocked: 0,
      currentOpen: day.status === "open",
      proposedOpen,
      override: false,
    };
    aggregate.before += day.availableCount;
    aggregate.after += proposedAvailable;
    aggregate.assigned += day.assignedCount;
    aggregate.blocked += day.blockedCount;
    aggregate.currentOpen ||= day.status === "open";
    aggregate.proposedOpen ||= proposedOpen;
    aggregate.override ||=
      day.manualSellableLimitCount !== null || day.channelSellableLimitCount !== null;
    dateAggregates.set(day.stayDate, aggregate);
    roomDeltas.set(
      day.roomTypeId,
      (roomDeltas.get(day.roomTypeId) ?? 0) + proposedAvailable - day.availableCount,
    );
  }
  const coverageDates = sortedUnique(days.map(({ stayDate }) => stayDate));
  for (const limit of proposal.roomTypeLimits) {
    if (currentRoomIds.has(limit.roomTypeId)) continue;
    for (const stayDate of coverageDates) {
      const proposedOpen = scheduleOpen(proposal.schedule, stayDate);
      const proposedAvailable = proposedOpen ? limit.startingSellableLimitCount : 0;
      const aggregate = dateAggregates.get(stayDate) ?? {
        before: 0,
        after: 0,
        assigned: 0,
        blocked: 0,
        currentOpen: current ? scheduleOpen(current.schedule, stayDate) : false,
        proposedOpen,
        override: false,
      };
      aggregate.after += proposedAvailable;
      aggregate.proposedOpen ||= proposedOpen;
      dateAggregates.set(stayDate, aggregate);
      roomDeltas.set(limit.roomTypeId, (roomDeltas.get(limit.roomTypeId) ?? 0) + proposedAvailable);
    }
  }

  const affectedDates: PmsOperatingCalendarImpactAffectedDate[] = [];
  let availableRoomNightsRemoved = 0;
  let availableRoomNightsAdded = 0;
  let blockedRoomNights = 0;
  let ownerOverrideDateCount = 0;
  for (const [stayDate, aggregate] of [...dateAggregates].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    if (aggregate.before === aggregate.after && aggregate.currentOpen === aggregate.proposedOpen) {
      continue;
    }
    const statusChange =
      aggregate.currentOpen && !aggregate.proposedOpen
        ? "open_to_closed"
        : !aggregate.currentOpen && aggregate.proposedOpen
          ? "closed_to_open"
          : "availability_changed";
    const active = reservationsByDate.get(stayDate) ?? [];
    affectedDates.push({
      stayDate,
      statusChange,
      availableCountBefore: aggregate.before,
      availableCountAfter: aggregate.after,
      assignedCount: aggregate.assigned,
      blockedCount: aggregate.blocked,
      acceptedBookingCount: new Set(active.map(({ receiptId }) => receiptId)).size,
      ownerOverridePresent: aggregate.override,
    });
    availableRoomNightsRemoved += Math.max(0, aggregate.before - aggregate.after);
    availableRoomNightsAdded += Math.max(0, aggregate.after - aggregate.before);
    if (statusChange === "open_to_closed") blockedRoomNights += aggregate.blocked;
    if (aggregate.override) ownerOverrideDateCount += 1;
  }

  const roomTypeChanges: PmsOperatingCalendarImpactRoomTypeChange[] = proposal.roomTypeLimits.map(
    (limit) => ({
      roomTypeId: limit.roomTypeId,
      previousStartingSellableLimitCount:
        current?.sourceInputs.roomBindings.find(({ roomTypeId }) => roomTypeId === limit.roomTypeId)
          ?.startingSellableLimitCount ?? null,
      proposedStartingSellableLimitCount: limit.startingSellableLimitCount,
      availableRoomNightsDelta: roomDeltas.get(limit.roomTypeId) ?? 0,
    }),
  );
  const categories = new Set<PmsOperatingCalendarImpactCategory>();
  if (affectedDates.some(({ statusChange }) => statusChange === "open_to_closed")) {
    categories.add("operating_dates_close");
  }
  if (affectedDates.some(({ statusChange }) => statusChange === "closed_to_open")) {
    categories.add("operating_dates_open");
  }
  if (affectedReservationIds.size > 0) categories.add("accepted_bookings_on_closing_dates");
  if (blockedRoomNights > 0) categories.add("room_blocks_on_closing_dates");
  if (ownerOverrideDateCount > 0) categories.add("owner_overrides_on_changed_dates");
  if (
    (current !== null &&
      [...currentRoomIds].some((roomTypeId) => !proposedRoomIds.has(roomTypeId))) ||
    roomTypeChanges.some(
      ({ previousStartingSellableLimitCount, proposedStartingSellableLimitCount }) =>
        previousStartingSellableLimitCount !== null &&
        proposedStartingSellableLimitCount < previousStartingSellableLimitCount,
    )
  ) {
    categories.add("starting_availability_decreases");
  }
  if (
    (current !== null &&
      [...proposedRoomIds].some((roomTypeId) => !currentRoomIds.has(roomTypeId))) ||
    roomTypeChanges.some(
      ({ previousStartingSellableLimitCount, proposedStartingSellableLimitCount }) =>
        previousStartingSellableLimitCount !== null &&
        proposedStartingSellableLimitCount > previousStartingSellableLimitCount,
    )
  ) {
    categories.add("starting_availability_increases");
  }
  const defaultMinimumStayChanged =
    current !== null && current.defaultMinimumStayNights !== proposal.defaultMinimumStayNights;
  if (defaultMinimumStayChanged) categories.add("default_minimum_stay_changes");
  return deepFreeze({
    categories: [...categories].sort(compareCodeUnits),
    summary: {
      closingDateCount: affectedDates.filter(
        ({ statusChange }) => statusChange === "open_to_closed",
      ).length,
      openingDateCount: affectedDates.filter(
        ({ statusChange }) => statusChange === "closed_to_open",
      ).length,
      availableRoomNightsRemoved,
      availableRoomNightsAdded,
      acceptedBookingCount: affectedReservationIds.size,
      acceptedBookedRoomNights,
      blockedRoomNights,
      ownerOverrideDateCount,
      defaultMinimumStayChanged,
    },
    affectedDates,
    roomTypeChanges,
  });
}

async function readCoverage(
  client: PmsOperatingCalendarImpactClient,
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
     FOR SHARE`,
    [propertyId],
  );
  if (result.rows.length > 1)
    throw new ImpactSourceInvariantError("Inventory coverage is not unique");
  return result.rows[0] ?? null;
}

async function readInventoryDays(
  client: PmsOperatingCalendarImpactClient,
  propertyId: string,
  coverage: CoverageRow | null,
  expectedRoomBindings: readonly PmsOperatingCalendarRoomBinding[],
): Promise<readonly InventoryDay[]> {
  const result = await client.query<InventoryDayRow>(
    `SELECT room_type_id::text AS "roomTypeId", stay_date::text AS "stayDate",
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
            available_count AS "availableCount", source_freshness AS "sourceFreshness"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid
       AND ($2::date IS NULL OR stay_date BETWEEN $2::date AND $3::date)
     ORDER BY room_type_id::text COLLATE "C", stay_date
     FOR SHARE`,
    [
      propertyId,
      coverage ? databaseDate(coverage.coverageFrom) : null,
      coverage ? databaseDate(coverage.coverageThrough) : null,
    ],
  );
  if (!coverage && result.rows.length > 0) {
    const capacities = new Map(
      expectedRoomBindings.map(({ roomTypeId, physicalCapacityCount }) => [
        roomTypeId,
        physicalCapacityCount,
      ]),
    );
    if (
      !result.rows.every((row) => {
        const roomTypeId = normalizeUuid(row.roomTypeId);
        const capacity = roomTypeId ? capacities.get(roomTypeId) : undefined;
        return capacity !== undefined && pristineOnboardingLegacyDay(row, capacity);
      })
    ) {
      throw new ImpactSourceInvariantError("Canonical inventory exists without coverage");
    }
    return Object.freeze([]);
  }
  const days = result.rows.map(parseInventoryDay);
  if (days.some((day) => !day)) throw new ImpactSourceInvariantError("Inventory day is malformed");
  const parsedDays = days as InventoryDay[];
  if (coverage) {
    const calendarRevision = positiveInteger(coverage.calendarRevision);
    const materializedRevision = positiveInteger(coverage.materializedRevision);
    const coverageFrom = databaseDate(coverage.coverageFrom);
    const coverageThrough = databaseDate(coverage.coverageThrough);
    const roomTypeCount = positiveInteger(coverage.roomTypeCount);
    const expected = nonNegativeInteger(coverage.expectedDayCount);
    const materialized = nonNegativeInteger(coverage.materializedDayCount);
    const expectedRooms = new Set(expectedRoomBindings.map(({ roomTypeId }) => roomTypeId));
    const coverageDayCount =
      coverageFrom && coverageThrough
        ? Math.floor(
            (Date.parse(`${coverageThrough}T00:00:00.000Z`) -
              Date.parse(`${coverageFrom}T00:00:00.000Z`)) /
              86_400_000,
          ) + 1
        : 0;
    if (
      normalizeUuid(coverage.propertyId) !== propertyId ||
      calendarRevision !== materializedRevision ||
      !coverageFrom ||
      !coverageThrough ||
      coverageDayCount < 1 ||
      roomTypeCount !== expectedRooms.size ||
      expected !== roomTypeCount * coverageDayCount ||
      expected !== materialized ||
      expected !== parsedDays.length ||
      parsedDays.some(
        (day) =>
          day.calendarRevision !== calendarRevision ||
          day.stayDate < coverageFrom ||
          day.stayDate > coverageThrough ||
          !expectedRooms.has(day.roomTypeId),
      ) ||
      new Set(parsedDays.map((day) => `${day.roomTypeId}:${day.stayDate}`)).size !==
        parsedDays.length
    ) {
      throw new ImpactSourceInvariantError("Inventory coverage manifest is not exact");
    }
  }
  return Object.freeze(parsedDays);
}

function pristineOnboardingLegacyDay(row: InventoryDayRow, physicalCapacityCount: number): boolean {
  const freshness = exactRecord(row.sourceFreshness, ["pms"]) ? row.sourceFreshness["pms"] : null;
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
    exactRecord(freshness, ["status", "generatedAt", "horizonDays"]) &&
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

async function readActiveReservations(
  client: PmsOperatingCalendarImpactClient,
  organizationId: string,
  propertyId: string,
  localToday: string,
): Promise<readonly ActiveReservation[]> {
  const result = await client.query<ReservationRow>(
    `SELECT receipt.organization_id::text AS "organizationId",
            receipt.receipt_id::text AS "receiptId",
            receipt.room_type_id::text AS "roomTypeId",
            receipt.check_in::text AS "checkIn",
            receipt.check_out::text AS "checkOut",
            receipt.room_count AS "roomCount",
            status.lifecycle_state AS "lifecycleState",
            status.lifecycle_revision AS "lifecycleRevision"
     FROM pms.active_inventory_reservation_receipts receipt
     JOIN pms.inventory_reservation_statuses status
       ON status.receipt_id = receipt.receipt_id
      AND status.organization_id = receipt.organization_id
      AND status.property_id = receipt.property_id
     WHERE receipt.property_id = $1::uuid
       AND receipt.check_out > $2::date
       AND status.lifecycle_state IN ('reserved', 'handed_off')
     ORDER BY receipt.receipt_id::text COLLATE "C"
     FOR SHARE OF receipt, status`,
    [propertyId, localToday],
  );
  return Object.freeze(
    result.rows.map((row) => {
      const receiptId = normalizeUuid(row.receiptId);
      const receiptOrganizationId = normalizeUuid(row.organizationId);
      const roomTypeId = normalizeUuid(row.roomTypeId);
      const checkIn = databaseDate(row.checkIn);
      const checkOut = databaseDate(row.checkOut);
      const roomCount = positiveInteger(row.roomCount);
      const lifecycleRevision = positiveInteger(row.lifecycleRevision);
      if (
        receiptOrganizationId !== organizationId ||
        !receiptId ||
        !roomTypeId ||
        !checkIn ||
        !checkOut ||
        checkIn >= checkOut ||
        (row.lifecycleState !== "reserved" && row.lifecycleState !== "handed_off") ||
        (lifecycleRevision !== 1 && lifecycleRevision !== 2) ||
        (row.lifecycleState === "reserved" && lifecycleRevision !== 1) ||
        (row.lifecycleState === "handed_off" && lifecycleRevision !== 2)
      ) {
        throw new ImpactSourceInvariantError("Inventory reservation source is malformed");
      }
      return Object.freeze({
        receiptId,
        roomTypeId,
        checkIn,
        checkOut,
        roomCount,
        lifecycleState: row.lifecycleState,
        lifecycleRevision,
      }) as ActiveReservation;
    }),
  );
}

function parseInventoryDay(row: InventoryDayRow): InventoryDay | null {
  const roomTypeId = normalizeUuid(row.roomTypeId);
  const stayDate = databaseDate(row.stayDate);
  const revisions = [row.calendarRevision, row.inventoryRevision, row.generatedSourceRevision].map(
    positiveIntegerOrZeroDisallowed,
  );
  const limits = [row.generatedSellableLimitCount, row.effectiveSellableLimitCount].map(
    nullableNonNegativeInteger,
  );
  const sources = [
    row.channelSourceRevision,
    row.manualSourceRevision,
    row.blockSourceRevision,
    row.bookingSourceRevision,
    row.totalCount,
    row.assignedCount,
    row.blockedCount,
    row.availableCount,
  ].map(nullableNonNegativeInteger);
  const channelLimit = nullableNonNegativeInteger(row.channelSellableLimitCount);
  const manualLimit = nullableNonNegativeInteger(row.manualSellableLimitCount);
  if (
    !roomTypeId ||
    !stayDate ||
    revisions.some((value) => value === null) ||
    limits.some((value) => value === null) ||
    sources.some((value) => value === null) ||
    (row.channelSellableLimitCount !== null && channelLimit === null) ||
    (row.manualSellableLimitCount !== null && manualLimit === null) ||
    (row.status !== "open" && row.status !== "closed")
  ) {
    return null;
  }
  const [calendarRevision, inventoryRevision, generatedSourceRevision] = revisions as number[];
  const [generatedLimit, effective] = limits as number[];
  const [channel, manual, block, booking, total, assigned, blocked, available] =
    sources as number[];
  if (
    generatedSourceRevision !== calendarRevision ||
    generatedLimit > total ||
    (channelLimit !== null && channelLimit > total) ||
    (manualLimit !== null && manualLimit > total) ||
    effective > total ||
    effective !== (manualLimit ?? channelLimit ?? generatedLimit) ||
    assigned + blocked > total ||
    available !== (row.status === "closed" ? 0 : Math.max(0, effective - assigned - blocked))
  ) {
    return null;
  }
  return Object.freeze({
    roomTypeId,
    stayDate,
    calendarRevision,
    inventoryRevision,
    generatedSourceRevision,
    channelSourceRevision: channel,
    manualSourceRevision: manual,
    blockSourceRevision: block,
    bookingSourceRevision: booking,
    status: row.status,
    totalCount: total,
    generatedSellableLimitCount: generatedLimit,
    channelSellableLimitCount: channelLimit,
    manualSellableLimitCount: manualLimit,
    effectiveSellableLimitCount: effective,
    assignedCount: assigned,
    blockedCount: blocked,
    availableCount: available,
  });
}

async function validateBindings(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  proposal: PmsOperatingCalendarProposal,
  facts: readonly RoomTypeFactsSnapshot[],
): Promise<
  | readonly PmsOperatingCalendarRoomBinding[]
  | Exclude<PmsOperatingCalendarImpactPreviewResult, { ok: true }>["error"]
> {
  const limits = new Map(proposal.roomTypeLimits.map((limit) => [limit.roomTypeId, limit]));
  const bindings: PmsOperatingCalendarRoomBinding[] = [];
  for (const fact of facts) {
    const limit = limits.get(fact.roomTypeId)!;
    if (fact.roomFactsRevision !== limit.expectedRoomFactsRevision) {
      return {
        code: "room_facts_revision_conflict" as const,
        roomTypeId: fact.roomTypeId,
        currentRevision: fact.roomFactsRevision,
      };
    }
    const capacity = await readCapacity(ports, proposal.propertyId, fact.roomTypeId);
    if (!capacity || capacity.activeUnitCount === 0) {
      return { code: "room_capacity_unavailable" as const, roomTypeId: fact.roomTypeId };
    }
    if (capacity.roomUnitsRevision !== limit.expectedRoomUnitsRevision) {
      return {
        code: "room_units_revision_conflict" as const,
        roomTypeId: fact.roomTypeId,
        currentRevision: capacity.roomUnitsRevision,
      };
    }
    if (limit.startingSellableLimitCount > capacity.activeUnitCount) {
      return {
        code: "starting_sellable_limit_exceeds_capacity" as const,
        roomTypeId: fact.roomTypeId,
        physicalCapacityCount: capacity.activeUnitCount,
      };
    }
    bindings.push({
      roomTypeId: fact.roomTypeId,
      sourceRoomFactsRevision: fact.roomFactsRevision,
      sourceRoomUnitsRevision: capacity.roomUnitsRevision,
      physicalCapacityCount: capacity.activeUnitCount,
      startingSellableLimitCount: limit.startingSellableLimitCount,
    });
  }
  return Object.freeze(bindings);
}

function bindingFailure(
  value:
    | readonly PmsOperatingCalendarRoomBinding[]
    | Exclude<PmsOperatingCalendarImpactPreviewResult, { ok: true }>["error"],
): value is Exclude<PmsOperatingCalendarImpactPreviewResult, { ok: true }>["error"] {
  return !Array.isArray(value);
}

async function readRoomFacts(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  propertyId: string,
): Promise<readonly RoomTypeFactsSnapshot[]> {
  const facts = (await ports.roomFacts.listRoomTypeFacts(propertyId)).map(
    parseRoomTypeFactsSnapshot,
  );
  if (facts.some((item) => !item)) throw new Error("PMS operating-calendar room facts are invalid");
  const parsed = facts as RoomTypeFactsSnapshot[];
  if (parsed.some((item) => item.propertyId !== propertyId)) {
    throw new Error("PMS operating-calendar room facts escaped property scope");
  }
  parsed.sort((left, right) => compareCodeUnits(left.roomTypeId, right.roomTypeId));
  if (new Set(parsed.map(({ roomTypeId }) => roomTypeId)).size !== parsed.length) {
    throw new Error("PMS operating-calendar room facts contain duplicates");
  }
  return Object.freeze(parsed);
}

async function readCapacity(
  ports: PmsOperatingCalendarRoomEvidencePorts,
  propertyId: string,
  roomTypeId: string,
): Promise<RoomTypeCapacitySnapshot | null> {
  const capacity = parseRoomTypeCapacitySnapshot(
    await ports.roomCapacity.getRoomTypeCapacity(propertyId, roomTypeId),
  );
  if (!capacity) return null;
  if (capacity.propertyId !== propertyId || capacity.roomTypeId !== roomTypeId) {
    throw new Error("PMS operating-calendar capacity escaped room scope");
  }
  return capacity;
}

async function latestRevision(
  client: PmsOperatingCalendarImpactClient,
  propertyId: string,
): Promise<number> {
  const result = await client.query<{ calendarRevision: number | string }>(
    `SELECT calendar_revision AS "calendarRevision"
     FROM pms.operating_calendar_revisions
     WHERE property_id = $1::uuid
     ORDER BY calendar_revision DESC LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ? positiveInteger(result.rows[0].calendarRevision) : 0;
}

async function lockAuthorizedScope(
  client: PmsOperatingCalendarImpactClient,
  command: PreviewPmsOperatingCalendarImpactCommand,
  at: Date,
): Promise<boolean> {
  const scope = await client.query(
    `SELECT resource.id
     FROM identity.organizations organization
     JOIN identity.organization_resource_links resource
       ON resource.organization_id = organization.id
      AND resource.product = $4 AND resource.resource_type = $5
      AND resource.resource_id = $2::uuid::text
      AND resource.relationship = ANY($6::text[]) AND resource.status = 'active'
     JOIN identity.users actor ON actor.id = $3::uuid AND actor.status = 'active'
     JOIN identity.organization_memberships membership
       ON membership.organization_id = organization.id AND membership.user_id = actor.id
      AND membership.status = 'active'
     JOIN identity.role_permission_grants permission_grant
       ON permission_grant.organization_kind = 'hotel_group'
      AND permission_grant.role_key = membership.role_key
      AND permission_grant.permission_key = $7
     WHERE organization.id = $1::uuid AND organization.kind = 'hotel_group'
       AND organization.status = 'active'
     FOR SHARE OF organization, resource, actor, membership
     FOR KEY SHARE OF permission_grant`,
    [
      command.organizationId,
      command.propertyId,
      command.audit.actor.userId,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.resourceType,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.allowedRelationships,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.permission,
    ],
  );
  if ((scope.rowCount ?? 0) < 1) return false;
  const entitlements = await client.query<{
    status: string;
    startsAt: Date | string | null;
    expiresAt: Date | string | null;
  }>(
    `SELECT status, starts_at AS "startsAt", expires_at AS "expiresAt"
     FROM identity.product_entitlements
     WHERE organization_id = $1::uuid AND product = $3
       AND entitlement_key = $4
       AND (resource_product IS NULL OR
            (resource_product = $5 AND resource_type = $6
             AND resource_id = $2::uuid::text))
     FOR SHARE`,
    [
      command.organizationId,
      command.propertyId,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.entitlement.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.entitlement.key,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.product,
      PMS_OPERATING_CALENDAR_AUTHORIZATION.resource.resourceType,
    ],
  );
  const applicable = entitlements.rows.filter(
    ({ startsAt, expiresAt }) =>
      (!startsAt || new Date(startsAt) <= at) && (!expiresAt || new Date(expiresAt) > at),
  );
  return (
    !applicable.some(({ status }) => status === "suspended") &&
    applicable.some(({ status }) => status === "active")
  );
}

type TokenClaims = Readonly<{
  version: 1;
  propertyId: string;
  proposalFingerprint: string;
  sourceFingerprint: string;
  issuedAt: string;
  expiresAt: string;
}>;

function issueToken(
  scope: Pick<TokenClaims, "propertyId" | "proposalFingerprint" | "sourceFingerprint">,
  secret: string,
  now: Date,
) {
  const claims: TokenClaims = Object.freeze({
    version: 1,
    ...scope,
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + PMS_OPERATING_CALENDAR_IMPACT_CONFIRMATION_TTL_SECONDS * 1_000,
    ).toISOString(),
  });
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return Object.freeze({
    contractVersion: PMS_OPERATING_CALENDAR_IMPACT_CONTRACT_VERSION,
    proposalFingerprint: claims.proposalFingerprint,
    sourceFingerprint: claims.sourceFingerprint,
    token: `${encoded}.${signature}`,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  });
}

function verifyToken(
  confirmation: UpsertPmsOperatingCalendarCommand["impactConfirmation"],
  secret: string,
  now: Date,
): TokenClaims | "expired" | null {
  const [encoded, signature, extra] = confirmation.token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(encoded, "utf8").digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (
    actual.toString("base64url") !== signature ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (
    !exactRecord(parsed, [
      "version",
      "propertyId",
      "proposalFingerprint",
      "sourceFingerprint",
      "issuedAt",
      "expiresAt",
    ]) ||
    parsed.version !== 1 ||
    !normalizeUuid(parsed.propertyId) ||
    !sha256Pattern(parsed.proposalFingerprint) ||
    !sha256Pattern(parsed.sourceFingerprint) ||
    !isoDateTime(parsed.issuedAt) ||
    !isoDateTime(parsed.expiresAt) ||
    parsed.issuedAt !== confirmation.issuedAt ||
    parsed.expiresAt !== confirmation.expiresAt ||
    parsed.proposalFingerprint !== confirmation.proposalFingerprint ||
    parsed.sourceFingerprint !== confirmation.sourceFingerprint
  ) {
    return null;
  }
  if (new Date(parsed.expiresAt) <= now) return "expired";
  return Object.freeze(parsed) as TokenClaims;
}

function previewFailure(
  error: Exclude<PmsOperatingCalendarImpactPreviewResult, { ok: true }>["error"],
): PmsOperatingCalendarImpactPreviewResult {
  return Object.freeze({ ok: false, error: Object.freeze(error) });
}

function scheduleOpen(
  schedule: PmsOperatingCalendarProposal["schedule"],
  stayDate: string,
): boolean {
  if (schedule.mode === "year_round") return true;
  const monthDay = stayDate.slice(5);
  return schedule.periods.some(({ startsOn, endsOn }) =>
    startsOn <= endsOn
      ? monthDay >= startsOn && monthDay <= endsOn
      : monthDay >= startsOn || monthDay <= endsOn,
  );
}

function stayDates(checkIn: string, checkOut: string): readonly string[] {
  const dates: string[] = [];
  let cursor = Date.parse(`${checkIn}T00:00:00.000Z`);
  const end = Date.parse(`${checkOut}T00:00:00.000Z`);
  while (cursor < end) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return dates;
}

function hotelLocalDate(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const result = `${field("year")}-${field("month")}-${field("day")}`;
  if (!databaseDate(result)) throw new Error("PMS operating-calendar local date is invalid");
  return result;
}

function profileRevision(value: string): number {
  const revision = /^profile:([1-9][0-9]*)$/.exec(value)?.[1];
  return positiveInteger(revision ?? null);
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function positiveInteger(value: unknown): number {
  const result = databaseInteger(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) {
    throw new ImpactSourceInvariantError("PMS operating-calendar source revision is invalid");
  }
  return result;
}

function positiveIntegerOrZeroDisallowed(value: unknown): number | null {
  try {
    return positiveInteger(value);
  } catch {
    return null;
  }
}

function nonNegativeInteger(value: unknown): number {
  const result = databaseInteger(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 2_147_483_647) {
    throw new ImpactSourceInvariantError("PMS operating-calendar source count is invalid");
  }
  return result;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  if (value === null) return null;
  try {
    return nonNegativeInteger(value);
  } catch {
    return null;
  }
}

function databaseInteger(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : Number.NaN;
}

function databaseDate(value: unknown): string | null {
  if (value instanceof Date && validDate(value)) return value.toISOString().slice(0, 10);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value
    ? value
    : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Pattern(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

async function rollbackQuietly(client: PmsOperatingCalendarImpactClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}
