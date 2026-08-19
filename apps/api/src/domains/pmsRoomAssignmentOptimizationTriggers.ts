import type { PmsManualBookingCreateCommand } from "@vayada/domain-pms";

import type {
  PmsManualBookingRoom,
  PmsManualBookingTransaction,
} from "./pmsManualBookingTransactionPorts.js";
import {
  optimizePmsRoomAssignmentsInTransaction,
  type PmsRoomAssignmentOptimizationCommand,
  type PmsRoomAssignmentOptimizationCommandResult,
} from "./pmsRoomAssignmentOptimizer.js";

type OptimizationResult = Readonly<{
  roomTypeId: string;
  result: PmsRoomAssignmentOptimizationCommandResult;
}>;
type OperationalChangeCommand = Readonly<{
  propertyId: string;
  commandId: string;
  audit: Readonly<{
    actor: Readonly<{ kind: "user"; userId: string }> | Readonly<{ kind: "system" }>;
    requestId: string;
    correlationId?: string | null;
  }>;
}>;

export type PmsRoomAssignmentOptimizationTriggerPort = Readonly<{
  afterCreate(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    rooms: readonly PmsManualBookingRoom[];
    acceptedAt: Date;
  }): Promise<readonly OptimizationResult[]>;
  afterChange(input: {
    transaction: PmsManualBookingTransaction;
    command: OperationalChangeCommand;
    roomTypeIds: readonly string[];
    reason: "cancel" | "modify";
    acceptedAt: Date;
  }): Promise<readonly OptimizationResult[]>;
}>;

export function createPmsRoomAssignmentOptimizationTriggerPort(
  input: {
    optimize?: typeof optimizePmsRoomAssignmentsInTransaction;
  } = {},
): PmsRoomAssignmentOptimizationTriggerPort {
  const optimize = input.optimize ?? optimizePmsRoomAssignmentsInTransaction;
  return {
    async afterCreate({ transaction, command, rooms, acceptedAt }) {
      const roomTypeIds = [...new Set(rooms.map(({ roomTypeId }) => roomTypeId))].sort();
      return optimizeRoomTypes(transaction, command, roomTypeIds, "create", acceptedAt, optimize);
    },
    afterChange({ transaction, command, roomTypeIds, reason, acceptedAt }) {
      return optimizeRoomTypes(transaction, command, roomTypeIds, reason, acceptedAt, optimize);
    },
  };
}

async function optimizeRoomTypes(
  transaction: PmsManualBookingTransaction,
  command: OperationalChangeCommand,
  roomTypeIds: readonly string[],
  reason: "create" | "cancel" | "modify",
  acceptedAt: Date,
  optimize: typeof optimizePmsRoomAssignmentsInTransaction,
): Promise<readonly OptimizationResult[]> {
  const currentDate = await propertyLocalDate(transaction, command.propertyId, acceptedAt);
  const results: OptimizationResult[] = [];
  for (const roomTypeId of [...new Set(roomTypeIds)].sort()) {
    const optimizationCommand: PmsRoomAssignmentOptimizationCommand = {
      propertyId: command.propertyId,
      roomTypeId,
      reason,
      currentDate,
      commandId: `${command.commandId}:optimize:${reason}:${roomTypeId}`,
      correlationId: command.audit.correlationId ?? command.audit.requestId,
      causationId: command.commandId,
      actor:
        command.audit.actor.kind === "user"
          ? { kind: "user", userId: command.audit.actor.userId }
          : { kind: "system" },
    };
    let result = await optimize(transaction, optimizationCommand);
    if (result.outcome === "budget_exhausted") {
      result = await optimize(transaction, { ...optimizationCommand, searchBudget: 100_000 });
    }
    if (
      result.outcome === "budget_exhausted" ||
      result.outcome === "idempotency_conflict" ||
      result.outcome === "command_in_progress" ||
      result.outcome === "invalid_snapshot"
    ) {
      throw new Error(`PMS room optimization ${reason} trigger failed: ${result.outcome}`);
    }
    results.push({ roomTypeId, result });
  }
  return results;
}

async function propertyLocalDate(
  transaction: PmsManualBookingTransaction,
  propertyId: string,
  acceptedAt: Date,
): Promise<string> {
  const result = await transaction.query<{ timeZone: string | null }>(
    `SELECT timezone AS "timeZone"
     FROM hotel_catalog.property_locations
     WHERE property_id = $1::uuid
     FOR SHARE`,
    [propertyId],
  );
  const timeZone = result.rows[0]?.timeZone;
  if (!timeZone) throw new Error("PMS room optimization property timezone is unavailable");
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(acceptedAt);
  } catch {
    throw new Error("PMS room optimization property timezone is invalid");
  }
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const localDate = `${field("year")}-${field("month")}-${field("day")}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate))
    throw new Error("PMS room optimization property date is invalid");
  return localDate;
}
