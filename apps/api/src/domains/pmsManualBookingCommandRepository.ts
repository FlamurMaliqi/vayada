import { randomUUID } from "node:crypto";

import {
  PmsManualBookingCreateError,
  type PmsManualBookingCreateCommand,
  type PmsManualBookingCreateResult,
} from "@vayada/domain-pms";
import pg, { type PoolClient } from "pg";

import {
  financeManualBookingSettlementTransaction,
  type FinanceManualBookingSettlementPort,
} from "./financeManualBookingSettlement.js";
import {
  assertManualBookingCommandIdUnused,
  completeManualBookingCommand,
  findManualBookingReplay,
  reserveManualBookingCommand,
  writeManualBookingPlatformEvidence,
} from "./pmsManualBookingCommandEvidence.js";
import {
  lockManualBookingRooms,
  markManualBookingPaid,
  persistManualBookingOwnedFacts,
} from "./pmsManualBookingPersistence.js";
import type {
  PmsManualBookingCommandRepository,
  PmsManualBookingTransactionClient,
  PmsManualBookingTransactionDependencies,
  PmsManualBookingTransactionPool,
} from "./pmsManualBookingTransactionPorts.js";

export function createPgPmsManualBookingCommandRepository(config: {
  connectionString: string;
  dependencies: PmsManualBookingTransactionDependencies;
  pool?: PmsManualBookingTransactionPool;
  max?: number;
  now?: () => Date;
  randomId?: () => string;
}): PmsManualBookingCommandRepository {
  if (!config.connectionString.trim()) throw new Error("Manual booking connectionString is empty");
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as PmsManualBookingTransactionPool);
  const now = config.now ?? (() => new Date());
  const randomId = config.randomId ?? randomUUID;
  let closed = false;

  return {
    async createManualBooking(command) {
      const acceptedAt = now();
      if (!validDate(acceptedAt)) throw new Error("Manual booking repository clock is invalid");
      const transaction = await pool.connect();
      try {
        await transaction.query("BEGIN");
        const replay = await findManualBookingReplay(transaction, command);
        if (replay) {
          await rollback(transaction);
          return replay;
        }
        const reservation = await reserveManualBookingCommand(transaction, command);
        if (!reservation) {
          const concurrent = await findManualBookingReplay(transaction, command);
          await rollback(transaction);
          if (concurrent) return concurrent;
          throw new PmsManualBookingCreateError("idempotency_conflict");
        }
        await assertManualBookingCommandIdUnused(transaction, command.commandId);
        const rooms = await lockManualBookingRooms(transaction, command);
        const preview = await config.dependencies.pricing.calculate({
          transaction,
          command,
          acceptedAt,
        });
        const guestBookingId = randomId();
        const bookingReference = publicReference(guestBookingId);
        const accepted = await persistManualBookingOwnedFacts(transaction, {
          command,
          preview,
          rooms,
          guestBookingId,
          bookingReference,
        });
        await config.dependencies.attribution.recordManualAttribution({
          transaction,
          propertyId: command.propertyId,
          guestBookingId,
          bookingChannel: "direct",
          directSource: command.directSource,
        });
        await config.dependencies.nightlyEvidence.appendExactNightlyEvidence({
          transaction,
          command,
          guestBookingId,
          bookingReference,
          rooms,
          preview,
        });
        const paymentEvidenceId = await settleIfPaid(
          transaction,
          reservation.id,
          config.dependencies.financeSettlement,
          command,
          guestBookingId,
          accepted.total.amountDecimal,
          accepted.total.currency,
          acceptedAt,
        );
        if (paymentEvidenceId) await markManualBookingPaid(transaction, guestBookingId);
        const result = createResult(command, accepted, paymentEvidenceId);
        await writeManualBookingPlatformEvidence(transaction, { command, result, reservation });
        await completeManualBookingCommand(
          transaction,
          reservation,
          result,
          acceptedAt.toISOString(),
        );
        await transaction.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(transaction);
        throw error;
      } finally {
        transaction.release();
      }
    },
    async close() {
      if (!ownsPool || closed) return;
      if (!pool.end) throw new Error("Owned manual booking pool cannot close");
      await pool.end();
      closed = true;
    },
  };
}

async function settleIfPaid(
  transaction: PmsManualBookingTransactionClient,
  bookingCreationEvidenceId: string,
  finance: FinanceManualBookingSettlementPort,
  command: PmsManualBookingCreateCommand,
  guestBookingId: string,
  amount: string,
  currency: string,
  acceptedAt: Date,
): Promise<string | null> {
  if (command.payment.settlement.status === "unpaid") return null;
  const receipt = await finance.settleFull({
    transaction: await financeManualBookingSettlementTransaction(
      transaction as unknown as Pick<PoolClient, "query" | "release">,
    ),
    bookingCreationEvidenceId,
    command: {
      commandType: "finance.manual_booking.settle_full",
      commandId: `${command.commandId}:settlement`,
      idempotencyKey: command.idempotencyKey,
      propertyId: command.propertyId,
      audit: {
        actor: command.audit.actor,
        requestId: command.audit.requestId,
        correlationId: command.audit.correlationId ?? undefined,
        reason: "Record full settlement during PMS manual booking creation.",
        requestedAt: command.audit.requestedAt,
      },
      payload: {
        booking: { guestBookingId },
        amount,
        currency,
        paymentMethod: command.payment.expectedMethod,
        sourceReference: `pms-manual-booking:${command.commandId}`,
        operatorReference: command.payment.settlement.reference,
        acceptedAt: acceptedAt.toISOString(),
      },
    },
  });
  return receipt.paymentEvidenceId;
}

function createResult(
  command: PmsManualBookingCreateCommand,
  accepted: Awaited<ReturnType<typeof persistManualBookingOwnedFacts>>,
  paymentEvidenceId: string | null,
): PmsManualBookingCreateResult {
  const paid = paymentEvidenceId !== null;
  return {
    contractVersion: command.contractVersion,
    outcome: "created",
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    guestBookingId: accepted.guestBookingId,
    bookingReference: accepted.bookingReference,
    bookingChannel: "direct",
    directSource: command.directSource,
    stayCount: command.stays.length,
    checkIn: accepted.checkIn,
    checkOut: accepted.checkOut,
    total: accepted.total,
    balance: paid ? { amountDecimal: "0.00", currency: accepted.total.currency } : accepted.total,
    paymentStatus: paid ? "paid" : "unpaid",
    paymentEvidenceId,
    sideEffects: ["calendar_refresh", "ari_changed", "guest_confirmation", "audit_event"],
  };
}

function publicReference(guestBookingId: string): string {
  return `PMS-${guestBookingId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

async function rollback(transaction: PmsManualBookingTransactionClient): Promise<void> {
  try {
    await transaction.query("ROLLBACK");
  } catch {
    // Preserve the command error.
  }
}
