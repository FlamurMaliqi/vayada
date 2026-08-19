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

export type PmsRoomAssignmentOptimizationTriggerPort = Readonly<{
  afterCreate(input: {
    transaction: PmsManualBookingTransaction;
    command: PmsManualBookingCreateCommand;
    rooms: readonly PmsManualBookingRoom[];
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
      const currentDate = await propertyLocalDate(transaction, command.propertyId, acceptedAt);
      const roomTypeIds = [...new Set(rooms.map(({ roomTypeId }) => roomTypeId))].sort();
      const results: OptimizationResult[] = [];
      for (const roomTypeId of roomTypeIds) {
        const optimizationCommand: PmsRoomAssignmentOptimizationCommand = {
          propertyId: command.propertyId,
          roomTypeId,
          reason: "create",
          currentDate,
          commandId: `${command.commandId}:optimize:create:${roomTypeId}`,
          correlationId: command.audit.correlationId ?? command.audit.requestId,
          causationId: command.commandId,
          actor: { kind: "user", userId: command.audit.actor.userId },
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
          throw new Error(`PMS room optimization create trigger failed: ${result.outcome}`);
        }
        results.push({ roomTypeId, result });
      }
      return results;
    },
  };
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
