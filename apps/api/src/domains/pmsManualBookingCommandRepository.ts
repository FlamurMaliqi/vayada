import { createHash, randomUUID } from "node:crypto";

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
import type {
  PmsManualBookingAcceptedWrite,
  PmsManualBookingCommandRepository,
  PmsManualBookingTransactionClient,
  PmsManualBookingTransactionDependencies,
  PmsManualBookingTransactionPool,
} from "./pmsManualBookingTransactionPorts.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";

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
      const attribution = config.dependencies.attribution.resolveManualAttribution({
        directSource: command.directSource,
      });
      const transaction = await pool.connect();
      try {
        await transaction.query("BEGIN");
        const replay = await config.dependencies.platform.findReplay({ transaction, command });
        if (replay) {
          await rollback(transaction);
          return replay;
        }
        const reservation = await config.dependencies.platform.reserveCommand({
          transaction,
          command,
        });
        if (!reservation) {
          const concurrent = await config.dependencies.platform.findReplay({
            transaction,
            command,
          });
          await rollback(transaction);
          if (concurrent) return concurrent;
          throw new PmsManualBookingCreateError("idempotency_conflict");
        }
        await config.dependencies.booking.assertSourceCommandUnused({
          transaction,
          commandId: command.commandId,
        });
        await lockPmsInventoryMutationScope(transaction, command.propertyId);
        const rooms = await config.dependencies.operations.lockRooms({ transaction, command });
        const preview = await config.dependencies.pricing.calculate({
          transaction,
          command,
          acceptedAt,
        });
        assertPersistableTotal(preview.grandTotal.amountDecimal);
        const guestBookingId = randomId();
        const bookingReference = publicReference(guestBookingId);
        const accepted = await config.dependencies.booking.persistBookingFacts({
          transaction,
          command,
          preview,
          guestBookingId,
          bookingReference,
          attribution,
        });
        await config.dependencies.operations.persistOperationalFacts({
          transaction,
          command,
          rooms,
          guestBookingId,
          acceptedAt: acceptedAt.toISOString(),
        });
        await config.dependencies.nightlyEvidence.appendExactNightlyEvidence({
          transaction,
          command,
          guestBookingId,
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
        if (paymentEvidenceId)
          await config.dependencies.booking.markPaid({ transaction, guestBookingId });
        const optimization = await config.dependencies.roomAssignmentOptimization.afterCreate({
          transaction,
          command,
          rooms,
          acceptedAt,
        });
        const rearrangedBookingCount = new Set(
          optimization.flatMap(({ rearrangedGuestBookingIds }) => rearrangedGuestBookingIds),
        ).size;
        const linkedChanges = await reconcilePmsLinkedInventory(
          transaction,
          command.propertyId,
          acceptedAt.toISOString(),
        );
        await enqueuePmsLinkedInventorySideEffects(
          transaction,
          {
            propertyId: command.propertyId,
            operation: "manual_booking_create",
            commandId: command.commandId,
            keyHash: createHash("sha256").update(command.idempotencyKey).digest("hex"),
            acceptedAt: acceptedAt.toISOString(),
            audit: command.audit,
          },
          linkedChanges,
        );
        const result = createResult(command, accepted, paymentEvidenceId, rearrangedBookingCount);
        await config.dependencies.platform.writeEvidence({
          transaction,
          command,
          preview,
          result,
          reservation,
        });
        await config.dependencies.platform.completeCommand({
          transaction,
          reservation,
          result,
          completedAt: acceptedAt.toISOString(),
        });
        await transaction.query("COMMIT");
        return result;
      } catch (error) {
        await rollback(transaction);
        if (commandIdUniqueConflict(error))
          throw new PmsManualBookingCreateError("idempotency_conflict");
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
  accepted: PmsManualBookingAcceptedWrite,
  paymentEvidenceId: string | null,
  rearrangedBookingCount: number,
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
    rearrangedBookingCount,
    sideEffects: ["calendar_refresh", "ari_changed", "guest_confirmation", "audit_event"],
  };
}

function publicReference(guestBookingId: string): string {
  return `PMS-${guestBookingId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function assertPersistableTotal(amountDecimal: string): void {
  const digits = amountDecimal.match(/^\d+\.\d{2}$/)?.[0].replace(".", "");
  if (!digits || BigInt(digits) > 999_999_999_999_999n)
    throw new PmsManualBookingCreateError("invalid_body", "grandTotal");
}

function commandIdUniqueConflict(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "code" in value &&
    value.code === "23505" &&
    "constraint" in value &&
    value.constraint === "uq_guest_bookings_source"
  );
}

async function rollback(transaction: PmsManualBookingTransactionClient): Promise<void> {
  try {
    await transaction.query("ROLLBACK");
  } catch {
    // Preserve the command error.
  }
}
