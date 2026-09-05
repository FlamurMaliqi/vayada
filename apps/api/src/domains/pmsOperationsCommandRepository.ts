import { createHash } from "node:crypto";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import {
  PMS_ROOM_TYPE_DUPLICATION_COPIED_FACTS,
  PMS_ROOM_TYPE_DUPLICATION_RESET_FACTS,
  PMS_ROOM_TYPE_LIFECYCLE_CONTRACT_VERSION,
  type PmsRoomTypeRetirementBlocker,
  type PmsRoomTypeRetirementImpact,
} from "@vayada/domain-pms";

import { enqueueBookingTransitionNotifications } from "../jobs/bookingEmails.js";
import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "./stripeBookingPayments.js";
import {
  recordBookingManualPaymentInClient,
  type FinanceBookingManualPaymentSettlementCommand,
} from "./financeManualPaymentSettlement.js";
import { appendPmsManualNoShowNightlyRevenueEvidence } from "./bookingPmsManualNoShowNightlyRevenueEvidence.js";
import {
  cancelPmsManualBooking,
  ManualCancellationEvidenceError,
  ManualCancellationStateError,
} from "./bookingPmsManualCancellationNightlyRevenueEvidence.js";
import {
  ManualRefundEvidenceError,
  ManualRefundStateError,
  refundPmsManualBooking,
} from "./bookingPmsManualRefundNightlyRevenueEvidence.js";
import {
  createFinanceManualBookingRefundPort,
  financeManualBookingRefundTransaction,
} from "./financeManualBookingRefund.js";
import {
  correctPmsManualStays,
  ManualStayCorrectionAvailabilityError,
  ManualStayCorrectionScopeError,
} from "./pmsManualStayCorrection.js";
import {
  ManualStayCorrectionEvidenceError,
  ManualStayCorrectionStateError,
} from "./bookingPmsManualStayCorrection.js";
import {
  correctBookingPmsManualPrices,
  ManualPriceCorrectionEvidenceError,
  ManualPriceCorrectionStateError,
  propertyDate,
} from "./bookingPmsManualPriceCorrection.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";
import { lockPmsRoomOrder, pmsRoomOrderVersion } from "./pmsRoomOrder.js";
import type { PmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import type { PmsRoomAssignmentOptimizationTriggerPort } from "./pmsRoomAssignmentOptimizationTriggers.js";
import {
  captureDirectNightlyRevenueEvidence,
  reconcileStripeBookingPaymentProviderDetails,
  settleStripeBookingPayment,
} from "./stripeBookingSettlement.js";
import { stripeAmountMinor } from "./stripeMoney.js";
import {
  PMS_OPERATIONS_CONTRACT_VERSION,
  type PmsCheckInCommand,
  type PmsCheckOutCommand,
  type PmsCheckOutCommandResult,
  type PmsCheckOutRecord,
  type PmsAssignmentCommand,
  type PmsAssignmentCommandConflictCode,
  type PmsAssignmentCommandResult,
  type PmsBookingLifecycleCommand,
  type PmsCheckoutCharge,
  type PmsCheckoutChargeCommandResult,
  type PmsCheckoutChargeCreateCommand,
  type PmsCheckoutChargeMarkPaidCommand,
  type PmsCheckoutChargeStatus,
  type PmsCheckoutChargeWaiveCommand,
  type PmsCommandMeta,
  type PmsNoShowCommand,
  type PmsManualCancellationCommand,
  type PmsManualRefundCommand,
  type PmsManualPriceCorrectionCommand,
  type PmsManualStayCorrectionCommand,
  type PmsOperationalCommandResult,
  type PmsOperationalStatus,
  type PmsOperationalStatusCommand,
  type PmsOperationalTemplate,
  type PmsOperationalTemplateCommandResult,
  type PmsOperationalTemplateKind,
  type PmsOperationalTemplateUpdateCommand,
  type PmsTemplateStep,
  type PmsOperationsCommandSideEffect,
  type PmsOperationsCommandRepository,
  type PmsPrivateNote,
  type PmsPrivateNoteCommandResult,
  type PmsPrivateNoteCreateCommand,
  type PmsPrivateNoteDeleteCommand,
  type PmsPrivateNoteDeleteResult,
  type PmsPrivateNoteUpdateCommand,
  type PmsRoomBlockCommandResult,
  type PmsRoomBlockCreateCommand,
  type PmsRoomBlockReleaseCommand,
  type PmsRoomBlockSummary,
  type PmsRoomBlockUpdateCommand,
  type PmsRoomOrderCommand,
  type PmsRoomOrderCommandResult,
  type PmsRoomType,
  type PmsRoomTypeCommandResult,
  type PmsRoomTypeCreateCommand,
  type PmsRoomTypeDuplicateCommand,
  type PmsRoomTypeRetireCommand,
  type PmsRoomTypeRetireCommandResult,
  type PmsRoomTypeUpdateCommand,
} from "../routes/pmsOperations.js";

export type PmsOperationsCommandClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsOperationsCommandPool = {
  connect(): Promise<PmsOperationsCommandClient>;
  end(): Promise<void>;
};

export type TargetPmsOperationsCommandRepositoryConfig = {
  connectionString: string;
  max?: number;
  pool?: PmsOperationsCommandPool;
  readRepository: PmsOperationsReadRepository;
  stripePaymentProvider?: StripeBookingPaymentProvider;
  now?: () => Date;
  roomAssignmentOptimization?: PmsRoomAssignmentOptimizationTriggerPort;
};

type PmsAssignmentRow = {
  assignmentId: string;
  guestBookingId: string;
  roomTypeId: string;
  roomId: string | null;
  position: number;
  assignmentStatus: string;
  version: string | null;
  updatedAt: Date | string;
  checkIn: string;
  checkOut: string;
  source: string;
  stayEvidenceKind: string;
};

type PmsRoomAvailabilityRow = {
  roomId: string;
  roomTypeId: string;
  status: string;
};

type PmsIdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  idempotencyMetadata: Record<string, unknown> | null;
  responseBodyHash?: string | null;
  responseStatusCode?: number | null;
};

type PmsOperationalCommand =
  | PmsOperationalStatusCommand
  | PmsCheckInCommand
  | PmsNoShowCommand
  | PmsManualCancellationCommand
  | PmsManualRefundCommand
  | PmsManualPriceCorrectionCommand
  | PmsManualStayCorrectionCommand
  | PmsBookingLifecycleCommand;

type PmsOperationalCommandOperation =
  | "status_command"
  | "checkin_command"
  | "no_show_command"
  | "manual_cancellation_command"
  | "manual_refund_command"
  | "manual_price_correction_command"
  | "manual_stay_correction_command"
  | "booking_acceptance_command"
  | "booking_mark_paid_command"
  | "checkout_command";

type PmsOperationalMutationSuccess = {
  ok: true;
  sideEffects?: PmsOperationsCommandSideEffect[];
};

class PmsRoomScopeChangedError extends Error {}

type BookingPaymentLifecycleRow = QueryResultRow & {
  guestBookingId: string;
  propertyId: string;
  publicReference: string;
  invoiceId: string;
  lifecycleStatus: string;
  paymentStatus: string;
  paymentMethod: string | null;
  checkIn: string;
  checkOut: string;
  totalAmount: string;
  balanceAmount: string;
  currency: string;
  acceptedMethods: string[] | null;
  depositPolicy: unknown;
  paymentInstructions: unknown;
  pendingExpiresAt: string | null;
  acceptedPaymentDeadlineAt: string | null;
  sourceSystem: string;
  bookingMetadata: unknown;
  providerPaymentIntentId: string | null;
  providerAccountRef: string | null;
  chargeType: string | null;
};
type PmsOperationalTemplateOperation =
  | "checkin_checklist_template_update"
  | "checkout_inspection_template_update";
type PmsCheckoutChargeOperation =
  | "checkout_charge_create"
  | "checkout_charge_mark_paid"
  | "checkout_charge_waive";
type PmsRoomTypeCommandOperation =
  | "room_type_create"
  | "room_type_location_update"
  | "room_type_duplicate"
  | "room_type_retire";
type PmsRoomTypeCommand =
  | PmsRoomTypeCreateCommand
  | PmsRoomTypeUpdateCommand
  | PmsRoomTypeDuplicateCommand
  | PmsRoomTypeRetireCommand;

type PmsRoomTypeLifecycleRow = {
  roomTypeId: string;
  name: string;
  roomFactsRevision: number | string;
};

type PmsLegacyRatePlanRow = {
  ratePlanId: string;
  code: string;
  name: string;
  rateType: "flexible" | "non_refundable" | "package" | "manual";
  mealPlan: string | null;
  baseRateAmount: string;
  currency: string;
  active: boolean;
};
type PmsRoomBlockCommand =
  | PmsRoomBlockCreateCommand
  | PmsRoomBlockUpdateCommand
  | PmsRoomBlockReleaseCommand;
type PmsRoomBlockOperation = "room_block_create" | "room_block_update" | "room_block_release";

type PmsRoomBlockRow = {
  blockId: string;
  blockKind: "manual" | "linked_booking" | "linked_manual_block";
  roomTypeId: string;
  roomId: string | null;
  startsOn: Date | string;
  endsOn: Date | string;
  blockedCount: number;
  reason: string;
  status: "active" | "released" | "expired";
  revision: number;
};

type PmsRoomBlockMutation = {
  items: PmsRoomBlockSummary[];
  roomTypeId: string;
  affectedFrom: string;
  affectedTo: string;
};

const ALLOWED_OPERATIONAL_STATUS_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlySet<PmsOperationalStatus>
> = new Map<string, ReadonlySet<PmsOperationalStatus>>([
  ["pending", new Set<PmsOperationalStatus>(["assigned"])],
  ["assigned", new Set<PmsOperationalStatus>(["checked_in", "in_house"])],
  ["checked_in", new Set<PmsOperationalStatus>(["in_house"])],
  ["in_house", new Set<PmsOperationalStatus>(["checked_out"])],
]);

type PmsPrivateNoteReplay = {
  commandMeta: PmsCommandMeta;
  noteId: string;
  note?: PmsPrivateNote;
};

type PmsPrivateNoteRow = {
  noteId: string;
  body: string;
  authorUserId: string | null;
  authorDisplayName: string;
  source: "pms" | "migration" | "system";
  createdAt: Date | string;
  editedByUserId: string | null;
  editedByDisplayName: string | null;
  editedAt: Date | string | null;
};

type PmsOperationalTemplateRow = {
  propertyId: string;
  steps: unknown;
  updatedByUserId: string | null;
  updatedAt: Date | string;
};

type PmsCheckoutChargeRow = {
  chargeId: string;
  propertyId: string;
  guestBookingId: string;
  assignmentId: string | null;
  label: string;
  amountDecimal: string;
  originalAmountDecimal: string;
  currency: string;
  status: PmsCheckoutChargeStatus;
  createdByUserId: string | null;
  createdAt: Date | string;
  settledAt: Date | string | null;
  waivedAt: Date | string | null;
};

type PmsCheckOutRecordRow = {
  checkoutRecordId: string;
  propertyId: string;
  guestBookingId: string;
  assignmentId: string | null;
  completedByUserId: string | null;
  completedAt: Date | string;
  inspectionResults: unknown;
  chargesSettled: unknown;
  pendingFlags: unknown;
  checkoutNotes: string | null;
};

export function createTargetPmsOperationsCommandRepository(
  config: TargetPmsOperationsCommandRepositoryConfig,
): PmsOperationsCommandRepository {
  if (!config.connectionString.trim()) {
    throw new Error("PMS operations command repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: PmsOperationsCommandPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });
  const now = config.now ?? (() => new Date());

  return {
    reorderRooms(command) {
      return executeRoomOrderCommand(pool, now, command);
    },
    createRoomBlocks(command) {
      return executeRoomBlockCommand(pool, now, "room_block_create", command);
    },
    updateRoomBlock(command) {
      return executeRoomBlockCommand(pool, now, "room_block_update", command);
    },
    releaseRoomBlock(command) {
      return executeRoomBlockCommand(pool, now, "room_block_release", command);
    },
    async createRoomType(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(roomTypeCommandFingerprint(command)));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["ari_changed", "distribution_refresh", "audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findRoomTypeCommandReplay(
          client,
          "room_type_create",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const insertedIdempotencyKey = await recordRoomTypeCommandIdempotency(
          client,
          "room_type_create",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          const replay = await findRoomTypeCommandReplay(
            client,
            "room_type_create",
            command,
            keyHash,
            requestFingerprintHash,
          );
          await client.query("ROLLBACK");
          return (
            replay ??
            roomTypeConflict(
              "idempotency_conflict",
              "Room type create idempotency key could not be reserved.",
            )
          );
        }

        if (
          command.initialSetupOnly &&
          (await initialRoomSetupAlreadyExists(client, command.propertyId))
        ) {
          await client.query("ROLLBACK");
          return roomTypeConflict(
            "room_type_conflict",
            "Initial room setup was already completed for this property.",
          );
        }

        const roomTypeId = await insertRoomType(client, command, acceptedAt);
        const ratePlans = await insertRoomTypeRatePlans(client, command, roomTypeId, acceptedAt);
        const insertedRoomCount = await insertInitialRooms(client, command, roomTypeId, acceptedAt);
        if (insertedRoomCount !== command.roomCount) {
          await client.query("ROLLBACK");
          return roomTypeConflict(
            "room_type_conflict",
            "Generated room numbers conflict with existing rooms.",
          );
        }
        const inventoryHorizon = buildRoomTypeInventoryHorizon(command, acceptedAt);
        await insertRoomTypeRateRules(
          client,
          command,
          roomTypeId,
          ratePlans,
          inventoryHorizon,
          acceptedAt,
        );
        await insertRoomTypeInventoryDays(
          client,
          command,
          roomTypeId,
          inventoryHorizon,
          acceptedAt,
        );
        const created = roomTypeFromCommand(command, roomTypeId, ratePlans);

        await enqueueInventoryChangedSideEffects(
          client,
          command,
          {
            roomTypeId: created.roomTypeId,
            resourceType: "room_type",
            resourceId: created.roomTypeId,
            dateRange: {
              from: acceptedAt.slice(0, 10),
              to: addUtcDays(acceptedAt.slice(0, 10), PMS_ROOM_INVENTORY_HORIZON_DAYS - 1),
            },
            calendarRefresh: false,
          },
          commandMeta,
          keyHash,
          acceptedAt,
        );
        await insertRoomTypeAuditEvent(client, command, created, commandMeta, keyHash);
        await completeRoomTypeCommandIdempotency(
          client,
          "room_type_create",
          command,
          keyHash,
          commandMeta,
          acceptedAt,
          created,
        );
        await client.query("COMMIT");
        return { ok: true, roomType: created, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return roomTypeConflict(
            "room_type_conflict",
            "Room type create conflicts with the current property state.",
          );
        }
        if (isPgForeignKeyViolation(error)) {
          return roomTypeInvalidBody("Room type create references a property that does not exist.");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async updateRoomTypeLocation(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(roomTypeCommandFingerprint(command)));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: command.flexibleCancellationPolicy
          ? ["ari_changed", "distribution_refresh", "audit_event"]
          : ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findRoomTypeCommandReplay(
          client,
          "room_type_location_update",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const insertedIdempotencyKey = await recordRoomTypeCommandIdempotency(
          client,
          "room_type_location_update",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          const replay = await findRoomTypeCommandReplay(
            client,
            "room_type_location_update",
            command,
            keyHash,
            requestFingerprintHash,
          );
          await client.query("ROLLBACK");
          return (
            replay ??
            roomTypeConflict(
              "idempotency_conflict",
              "Room type update idempotency key could not be reserved.",
            )
          );
        }

        const currentRoomType = await config.readRepository.findRoomTypeById(
          command.propertyId,
          command.roomTypeId,
        );
        if (!currentRoomType) {
          await client.query("ROLLBACK");
          return roomTypeNotFound(command.roomTypeId);
        }

        const updated = await updateRoomTypeLocation(client, command, acceptedAt);
        if (!updated) {
          await client.query("ROLLBACK");
          return roomTypeNotFound(command.roomTypeId);
        }
        if (
          command.flexibleCancellationPolicy &&
          !(await updateRoomTypeFlexibleCancellation(client, command, acceptedAt))
        ) {
          await client.query("ROLLBACK");
          return roomTypeInvalidBody(
            "Flexible cancellation is unavailable for this room type's pricing contract.",
          );
        }

        const roomType = {
          ...currentRoomType,
          attributes: { ...currentRoomType.attributes, ...command.attributes },
          ratePlans: currentRoomType.ratePlans.map((ratePlan) =>
            command.flexibleCancellationPolicy &&
            ratePlan.active &&
            ratePlan.rateType === "flexible" &&
            ratePlan.pricingContractVersion == null
              ? {
                  ...ratePlan,
                  cancellationPolicySnapshot: command.flexibleCancellationPolicy,
                }
              : ratePlan,
          ),
        };
        if (command.flexibleCancellationPolicy) {
          await enqueueInventoryChangedSideEffects(
            client,
            command,
            {
              roomTypeId: command.roomTypeId,
              resourceType: "room_type",
              resourceId: command.roomTypeId,
              dateRange: {
                from: acceptedAt.slice(0, 10),
                to: addUtcDays(acceptedAt.slice(0, 10), PMS_ROOM_INVENTORY_HORIZON_DAYS - 1),
              },
              calendarRefresh: false,
            },
            commandMeta,
            keyHash,
            acceptedAt,
          );
        }
        await insertRoomTypeLocationUpdateAuditEvent(client, command, commandMeta, keyHash);
        await completeRoomTypeCommandIdempotency(
          client,
          "room_type_location_update",
          command,
          keyHash,
          commandMeta,
          acceptedAt,
          roomType,
        );
        await client.query("COMMIT");
        return { ok: true, roomType, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgForeignKeyViolation(error)) {
          return roomTypeInvalidBody("Room type update references a property that does not exist.");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async duplicateRoomType(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(roomTypeCommandFingerprint(command)));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["ari_changed", "distribution_refresh", "audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findRoomTypeCommandReplay(
          client,
          "room_type_duplicate",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const source = await lockActiveRoomTypeForLifecycle(client, command);
        if (!source) {
          await client.query("ROLLBACK");
          return roomTypeNotFound(command.roomTypeId);
        }
        if (roomTypeVersion(source.roomFactsRevision) !== command.expectedVersion) {
          await client.query("ROLLBACK");
          return roomTypeConflict("version_conflict", "Room type version is stale.");
        }
        const sourceReadModel = await config.readRepository.findRoomTypeById(
          command.propertyId,
          command.roomTypeId,
        );
        if (!sourceReadModel) {
          await client.query("ROLLBACK");
          return roomTypeNotFound(command.roomTypeId);
        }

        const insertedIdempotencyKey = await recordRoomTypeCommandIdempotency(
          client,
          "room_type_duplicate",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          await client.query("ROLLBACK");
          return roomTypeConflict(
            "idempotency_conflict",
            "Room type duplicate idempotency key could not be reserved.",
          );
        }

        const duplicateName = await availableRoomTypeCopyName(
          client,
          command.propertyId,
          source.name,
        );
        const duplicated = await insertDuplicatedRoomType(
          client,
          command,
          duplicateName,
          acceptedAt,
        );
        const copiedRatePlans = await copyLegacyRoomTypePricing(
          client,
          command,
          duplicated.roomTypeId,
          acceptedAt,
        );
        await copyRoomTypeMediaAssignments(client, command, duplicated.roomTypeId, acceptedAt);

        const roomType: PmsRoomType = {
          ...sourceReadModel,
          roomTypeId: duplicated.roomTypeId,
          version: roomTypeVersion(1),
          name: duplicateName,
          active: true,
          sortOrder: duplicated.sortOrder,
          roomMediaRevision: 1,
          ratePlans: copiedRatePlans,
          roomCount: 0,
        };
        await enqueueInventoryChangedSideEffects(
          client,
          command,
          lifecycleInventoryResource(command, duplicated.roomTypeId, acceptedAt),
          commandMeta,
          keyHash,
          acceptedAt,
        );
        await insertRoomTypeLifecycleAuditEvent(
          client,
          command,
          "pms.room_type.duplicated",
          duplicated.roomTypeId,
          commandMeta,
          keyHash,
          {
            sourceRoomTypeId: command.roomTypeId,
            copiedFacts: PMS_ROOM_TYPE_DUPLICATION_COPIED_FACTS,
            resetFacts: PMS_ROOM_TYPE_DUPLICATION_RESET_FACTS,
          },
        );
        await completeRoomTypeCommandIdempotency(
          client,
          "room_type_duplicate",
          command,
          keyHash,
          commandMeta,
          acceptedAt,
          roomType,
        );
        await client.query("COMMIT");
        return { ok: true, roomType, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return roomTypeConflict(
            "room_type_conflict",
            "Room type duplication conflicts with the current property state.",
          );
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async inspectRoomTypeRetirement(propertyId, roomTypeId) {
      const client = await pool.connect();
      try {
        return inspectRoomTypeRetirement(client, propertyId, roomTypeId);
      } finally {
        client.release();
      }
    },

    async retireRoomType(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(roomTypeCommandFingerprint(command)));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["ari_changed", "distribution_refresh", "audit_event"],
      };
      try {
        await client.query("BEGIN");
        const replay = await findRoomTypeRetireReplay(
          client,
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }
        const source = await lockActiveRoomTypeForLifecycle(client, command);
        if (!source) {
          await client.query("ROLLBACK");
          return roomTypeRetireNotFound(command.roomTypeId);
        }
        if (roomTypeVersion(source.roomFactsRevision) !== command.expectedVersion) {
          await client.query("ROLLBACK");
          return roomTypeRetireConflict("version_conflict", "Room type version is stale.");
        }

        await lockRoomTypeRetirementDependencies(client);
        const impact = await inspectRoomTypeRetirement(
          client,
          command.propertyId,
          command.roomTypeId,
        );
        if (!impact) {
          await client.query("ROLLBACK");
          return roomTypeRetireNotFound(command.roomTypeId);
        }
        if (!impact.canRetire) {
          await client.query("ROLLBACK");
          return {
            ...roomTypeRetireConflict(
              "room_type_retirement_blocked",
              "Resolve the reported room type dependencies before retirement.",
            ),
            impact,
          };
        }

        const insertedIdempotencyKey = await recordRoomTypeCommandIdempotency(
          client,
          "room_type_retire",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          await client.query("ROLLBACK");
          return roomTypeRetireConflict(
            "idempotency_conflict",
            "Room type retirement idempotency key could not be reserved.",
          );
        }

        await client.query(
          `UPDATE pms.rate_plans
           SET active = FALSE, updated_at = $3::timestamptz
           WHERE property_id = $1::uuid AND room_type_id = $2::uuid AND active`,
          [command.propertyId, command.roomTypeId, acceptedAt],
        );
        const retired = await client.query<{ roomFactsRevision: number | string }>(
          `UPDATE pms.room_types
           SET active = FALSE,
               room_facts_revision = room_facts_revision + 1,
               updated_at = $3::timestamptz
           WHERE property_id = $1::uuid AND id = $2::uuid AND active
           RETURNING room_facts_revision AS "roomFactsRevision"`,
          [command.propertyId, command.roomTypeId, acceptedAt],
        );
        if (retired.rowCount !== 1) throw new Error("Room type retirement lost its locked row");
        const retiredImpact: PmsRoomTypeRetirementImpact = {
          ...impact,
          version: roomTypeVersion(retired.rows[0]!.roomFactsRevision),
          canRetire: false,
        };
        await enqueueInventoryChangedSideEffects(
          client,
          command,
          lifecycleInventoryResource(command, command.roomTypeId, acceptedAt),
          commandMeta,
          keyHash,
          acceptedAt,
        );
        await insertRoomTypeLifecycleAuditEvent(
          client,
          command,
          "pms.room_type.retired",
          command.roomTypeId,
          commandMeta,
          keyHash,
          { dependencyImpact: impact },
        );
        await completeRoomTypeRetireIdempotency(
          client,
          command,
          keyHash,
          commandMeta,
          acceptedAt,
          retiredImpact,
        );
        await client.query("COMMIT");
        return { ok: true, impact: retiredImpact, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async listCheckoutCharges(propertyId, guestBookingId) {
      const client = await pool.connect();
      try {
        if (!(await reservationExists(client, propertyId, guestBookingId))) return null;
        return listCheckoutCharges(client, propertyId, guestBookingId);
      } finally {
        client.release();
      }
    },

    async createCheckoutCharge(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(checkoutChargeCommandFingerprint(command)));
      const commandMeta = checkoutChargeCommandMeta(command, acceptedAt);

      try {
        await client.query("BEGIN");
        const replay = await findCheckoutChargeCommandReplay(
          client,
          "checkout_charge_create",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return checkoutChargeReservationNotFound(command.guestBookingId);
        }
        if (
          command.assignmentId &&
          !(await checkoutChargeAssignmentBelongsToReservation(client, command))
        ) {
          await client.query("ROLLBACK");
          return checkoutChargeInvalidBody(
            "Checkout charge assignmentId does not belong to this reservation.",
          );
        }

        const insertedIdempotencyKey = await recordCheckoutChargeCommandIdempotency(
          client,
          "checkout_charge_create",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          await client.query("ROLLBACK");
          return checkoutChargeConflict(
            "Checkout charge create idempotency key could not be reserved.",
          );
        }

        const result = await client.query<PmsCheckoutChargeRow>(
          `INSERT INTO pms.booking_checkout_charges (
             property_id,
             guest_booking_id,
             assignment_id,
             label,
             amount,
             original_amount,
             currency,
             status,
             created_by_user_id,
             created_at
           )
           VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             $4,
             $5::numeric,
             $5::numeric,
             $6,
             'pending',
             $7::uuid,
             $8::timestamptz
           )
           RETURNING
             id::text AS "chargeId",
             property_id::text AS "propertyId",
             guest_booking_id::text AS "guestBookingId",
             assignment_id::text AS "assignmentId",
             label,
             amount::text AS "amountDecimal",
             original_amount::text AS "originalAmountDecimal",
             currency,
             status,
             created_by_user_id::text AS "createdByUserId",
             created_at AS "createdAt",
             settled_at AS "settledAt",
             waived_at AS "waivedAt"`,
          [
            command.propertyId,
            command.guestBookingId,
            command.assignmentId ?? null,
            command.label,
            command.amountDecimal,
            command.currency,
            checkoutChargeActorUserId(command),
            acceptedAt,
          ],
        );
        const charge = toPmsCheckoutCharge(result.rows[0]!);

        await insertCheckoutChargeAuditEvent(
          client,
          "created",
          command,
          charge,
          commandMeta,
          keyHash,
        );
        await completeCheckoutChargeCommandIdempotency(
          client,
          "checkout_charge_create",
          command,
          keyHash,
          commandMeta,
          acceptedAt,
          charge,
        );
        await client.query("COMMIT");
        return { ok: true, charge, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return checkoutChargeConflict(
            "Checkout charge create conflicts with the current reservation state.",
          );
        }
        if (isPgForeignKeyViolation(error)) {
          return checkoutChargeInvalidBody(
            "Checkout charge references a reservation resource that does not exist.",
          );
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async markCheckoutChargePaid(command) {
      return executeCheckoutChargeStateCommand(pool, now, {
        command,
        operation: "checkout_charge_mark_paid",
        action: "marked_paid",
        status: "paid",
        mutate: async (client, acceptedAt) => {
          const charge = await findCheckoutChargeForUpdate(client, command);
          if (!charge) return checkoutChargeNotFound(command.chargeId);
          if (charge.status !== "pending") {
            return checkoutChargeInvalidTransition(charge.status, "paid");
          }
          return updateCheckoutChargeStatus(client, command, "paid", acceptedAt);
        },
      });
    },

    async waiveCheckoutCharge(command) {
      return executeCheckoutChargeStateCommand(pool, now, {
        command,
        operation: "checkout_charge_waive",
        action: "waived",
        status: "waived",
        mutate: async (client, acceptedAt) => {
          const charge = await findCheckoutChargeForUpdate(client, command);
          if (!charge) return checkoutChargeNotFound(command.chargeId);
          if (charge.status === "waived" || charge.status === "void") {
            return checkoutChargeInvalidTransition(charge.status, "waived");
          }
          return updateCheckoutChargeStatus(client, command, "waived", acceptedAt);
        },
      });
    },

    async executeCheckOutCommand(command) {
      return executeCheckOutCommand(config, pool, now, command);
    },

    async listPrivateNotes(propertyId, guestBookingId) {
      const client = await pool.connect();
      try {
        if (!(await reservationExists(client, propertyId, guestBookingId))) return null;
        const result = await client.query<PmsPrivateNoteRow>(
          `SELECT
             note.id::text AS "noteId",
             note.body,
             note.author_user_id::text AS "authorUserId",
             note.author_display_name AS "authorDisplayName",
             note.source,
             note.created_at AS "createdAt",
             note.edited_by_user_id::text AS "editedByUserId",
             note.edited_by_display_name AS "editedByDisplayName",
             note.edited_at AS "editedAt"
           FROM pms.booking_notes_private note
           WHERE note.property_id = $1::uuid
             AND note.guest_booking_id = $2::uuid
           ORDER BY note.created_at DESC, note.id DESC`,
          [propertyId, guestBookingId],
        );
        return result.rows.map(toPmsPrivateNote);
      } finally {
        client.release();
      }
    },

    async createPrivateNote(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findPrivateNoteCommandReplay(
          client,
          "private_note_create",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          if (!replay.ok) return replay;
          return replay.note
            ? { ok: true, note: replay.note, commandMeta: replay.commandMeta, replayed: true }
            : privateNoteConflict("Private note create replay metadata is unavailable.");
        }

        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return privateNoteReservationNotFound(command.guestBookingId);
        }

        const insertedIdempotencyKey = await recordPrivateNoteCommandIdempotency(
          client,
          "private_note_create",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          const existing = await findPrivateNoteCommandReplay(
            client,
            "private_note_create",
            command,
            keyHash,
            requestFingerprintHash,
          );
          await client.query("ROLLBACK");
          if (existing) {
            if (!existing.ok) return existing;
            return existing.note
              ? {
                  ok: true,
                  note: existing.note,
                  commandMeta: existing.commandMeta,
                  replayed: true,
                }
              : privateNoteConflict("Private note create replay metadata is unavailable.");
          }
          return privateNoteConflict(
            "Idempotency key was already used for a private note command.",
          );
        }

        const noteResult = await client.query<PmsPrivateNoteRow>(
          `INSERT INTO pms.booking_notes_private (
             property_id,
             guest_booking_id,
             author_user_id,
             author_display_name,
             body,
             source,
             created_at
           )
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'pms', $6::timestamptz)
           RETURNING
             id::text AS "noteId",
             body,
             author_user_id::text AS "authorUserId",
             author_display_name AS "authorDisplayName",
             source,
             created_at AS "createdAt",
             edited_by_user_id::text AS "editedByUserId",
             edited_by_display_name AS "editedByDisplayName",
             edited_at AS "editedAt"`,
          [
            command.propertyId,
            command.guestBookingId,
            command.actorUserId,
            command.authorDisplayName,
            command.body,
            acceptedAt,
          ],
        );
        const note = toPmsPrivateNote(noteResult.rows[0]!);

        await insertPrivateNoteAuditEvent(client, {
          action: "pms.private_note.created",
          auditKey: privateNoteAuditKey("created", command.propertyId, note.noteId, keyHash),
          command,
          keyHash,
          noteId: note.noteId,
          occurredAt: acceptedAt,
          privatePayload: { bodyRedacted: true, bodyLength: command.body.length },
        });
        await completePrivateNoteCommandIdempotency(
          client,
          "private_note_create",
          command.propertyId,
          keyHash,
          commandMeta,
          acceptedAt,
          note.noteId,
          note,
        );
        await client.query("COMMIT");
        return { ok: true, note, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return privateNoteConflict("Private note command conflicts with current note state.");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async updatePrivateNote(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findPrivateNoteCommandReplay(
          client,
          "private_note_update",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          if (!replay.ok) return replay;
          return replay.note
            ? { ok: true, note: replay.note, commandMeta: replay.commandMeta, replayed: true }
            : privateNoteConflict("Private note update replay metadata is unavailable.");
        }

        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return privateNoteReservationNotFound(command.guestBookingId);
        }

        const insertedIdempotencyKey = await recordPrivateNoteCommandIdempotency(
          client,
          "private_note_update",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          const existing = await findPrivateNoteCommandReplay(
            client,
            "private_note_update",
            command,
            keyHash,
            requestFingerprintHash,
          );
          await client.query("ROLLBACK");
          if (existing) {
            if (!existing.ok) return existing;
            return existing.note
              ? {
                  ok: true,
                  note: existing.note,
                  commandMeta: existing.commandMeta,
                  replayed: true,
                }
              : privateNoteConflict("Private note update replay metadata is unavailable.");
          }
          return privateNoteConflict(
            "Idempotency key was already used for a private note command.",
          );
        }

        const updated = await client.query<PmsPrivateNoteRow>(
          `UPDATE pms.booking_notes_private
           SET body = $4,
               edited_by_user_id = $5::uuid,
               edited_by_display_name = $6,
               edited_at = $7::timestamptz
           WHERE id = $1::uuid
             AND property_id = $2::uuid
             AND guest_booking_id = $3::uuid
           RETURNING
             id::text AS "noteId",
             body,
             author_user_id::text AS "authorUserId",
             author_display_name AS "authorDisplayName",
             source,
             created_at AS "createdAt",
             edited_by_user_id::text AS "editedByUserId",
             edited_by_display_name AS "editedByDisplayName",
             edited_at AS "editedAt"`,
          [
            command.noteId,
            command.propertyId,
            command.guestBookingId,
            command.body,
            command.actorUserId,
            command.editorDisplayName,
            acceptedAt,
          ],
        );
        const row = updated.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return noteNotFound(command.noteId);
        }
        const note = toPmsPrivateNote(row);

        await insertPrivateNoteAuditEvent(client, {
          action: "pms.private_note.edited",
          auditKey: privateNoteAuditKey("edited", command.propertyId, note.noteId, keyHash),
          command,
          keyHash,
          noteId: note.noteId,
          occurredAt: acceptedAt,
          privatePayload: { bodyRedacted: true, bodyLength: command.body.length },
        });
        await completePrivateNoteCommandIdempotency(
          client,
          "private_note_update",
          command.propertyId,
          keyHash,
          commandMeta,
          acceptedAt,
          note.noteId,
          note,
        );
        await client.query("COMMIT");
        return { ok: true, note, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return privateNoteConflict("Private note command conflicts with current note state.");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async deletePrivateNote(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findPrivateNoteCommandReplay(
          client,
          "private_note_delete",
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay.ok
            ? {
                ok: true,
                noteId: replay.noteId,
                commandMeta: replay.commandMeta,
                replayed: true,
              }
            : replay;
        }

        if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
          await client.query("ROLLBACK");
          return privateNoteReservationNotFound(command.guestBookingId);
        }

        const insertedIdempotencyKey = await recordPrivateNoteCommandIdempotency(
          client,
          "private_note_delete",
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          const existing = await findPrivateNoteCommandReplay(
            client,
            "private_note_delete",
            command,
            keyHash,
            requestFingerprintHash,
          );
          await client.query("ROLLBACK");
          if (existing) {
            return existing.ok
              ? {
                  ok: true,
                  noteId: existing.noteId,
                  commandMeta: existing.commandMeta,
                  replayed: true,
                }
              : existing;
          }
          return privateNoteConflict(
            "Idempotency key was already used for a private note command.",
          );
        }

        const deleted = await client.query<{ noteId: string }>(
          `DELETE FROM pms.booking_notes_private
           WHERE id = $1::uuid
             AND property_id = $2::uuid
             AND guest_booking_id = $3::uuid
           RETURNING id::text AS "noteId"`,
          [command.noteId, command.propertyId, command.guestBookingId],
        );
        const noteId = deleted.rows[0]?.noteId;
        if (!noteId) {
          await client.query("ROLLBACK");
          return noteNotFound(command.noteId);
        }

        await insertPrivateNoteAuditEvent(client, {
          action: "pms.private_note.deleted",
          auditKey: privateNoteAuditKey("deleted", command.propertyId, noteId, keyHash),
          command,
          keyHash,
          noteId,
          occurredAt: acceptedAt,
          privatePayload: { deleted: true },
        });
        await completePrivateNoteCommandIdempotency(
          client,
          "private_note_delete",
          command.propertyId,
          keyHash,
          commandMeta,
          acceptedAt,
          noteId,
        );
        await client.query("COMMIT");
        return { ok: true, noteId, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return privateNoteConflict("Private note command conflicts with current note state.");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async executeAssignmentCommand(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["calendar_refresh", "ari_changed", "audit_event"],
      };

      try {
        await client.query("BEGIN");

        const replay = await findAssignmentCommandReplay(
          client,
          command,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          if ("ok" in replay) {
            await client.query("ROLLBACK");
            return replay;
          }
          await client.query("COMMIT");
          const reservation = await config.readRepository.findReservationByGuestBookingId(
            command.propertyId,
            command.guestBookingId,
            true,
          );
          return reservation
            ? { ok: true, reservation, commandMeta: replay, replayed: true }
            : reservationNotFound(command.guestBookingId);
        }

        const insertedIdempotencyKey = await recordAssignmentCommandIdempotency(
          client,
          command,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          const existing = await findAssignmentCommandReplay(
            client,
            command,
            keyHash,
            requestFingerprintHash,
          );
          if (existing) {
            await client.query("ROLLBACK");
            if ("ok" in existing) return existing;
            const reservation = await config.readRepository.findReservationByGuestBookingId(
              command.propertyId,
              command.guestBookingId,
              true,
            );
            return reservation
              ? { ok: true, reservation, commandMeta: existing, replayed: true }
              : reservationNotFound(command.guestBookingId);
          }
          await client.query("ROLLBACK");
          return assignmentConflict(
            "idempotency_conflict",
            "Assignment command idempotency key could not be reserved.",
          );
        }

        await lockPmsInventoryMutationScope(client, command.propertyId);
        const mutation = await applyAssignmentCommandMutation(client, command, acceptedAt);
        if (!mutation.ok) {
          await client.query("ROLLBACK");
          return mutation;
        }

        const linkedChanges = await reconcilePmsLinkedInventory(
          client,
          command.propertyId,
          acceptedAt,
        );
        if (mutation.inventoryTransfer) {
          const { sourceRoomTypeId, targetRoomTypeId, checkIn, checkOut } =
            mutation.inventoryTransfer;
          const endsOn = new Date(Date.parse(`${checkOut}T00:00:00Z`) - 86_400_000)
            .toISOString()
            .slice(0, 10);
          await reconcilePmsOccupiedInventory(
            client,
            command.propertyId,
            [
              { roomTypeId: sourceRoomTypeId, checkIn, checkOut },
              { roomTypeId: targetRoomTypeId, checkIn, checkOut },
            ],
            acceptedAt,
          );
          linkedChanges.push(
            ...(await reconcilePmsLinkedInventory(client, command.propertyId, acceptedAt, [
              { roomTypeId: sourceRoomTypeId, startsOn: checkIn, endsOn },
              { roomTypeId: targetRoomTypeId, startsOn: checkIn, endsOn },
            ])),
          );
        }

        await enqueueAssignmentCommandSideEffects(
          client,
          command,
          commandMeta,
          keyHash,
          acceptedAt,
        );
        if (mutation.inventoryTransfer) {
          await enqueueAssignmentInventoryTransferSideEffects(
            client,
            command,
            mutation.inventoryTransfer,
            keyHash,
            acceptedAt,
          );
        }
        await enqueuePmsLinkedInventorySideEffects(
          client,
          {
            propertyId: command.propertyId,
            operation: "assignment_command",
            commandId: command.commandId,
            keyHash,
            acceptedAt,
            audit: { requestId: command.commandId },
          },
          linkedChanges,
        );
        await completeAssignmentCommandIdempotency(
          client,
          command,
          keyHash,
          commandMeta,
          acceptedAt,
        );
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return {
            ok: false,
            statusCode: 409,
            code: "assignment_conflict",
            message: "Assignment command conflicts with the current reservation state.",
          };
        }
        throw error;
      } finally {
        client.release();
      }

      const reservation = await config.readRepository.findReservationByGuestBookingId(
        command.propertyId,
        command.guestBookingId,
        true,
      );
      return reservation
        ? { ok: true, reservation, commandMeta }
        : reservationNotFound(command.guestBookingId);
    },
    async executeOperationalStatusCommand(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "status_command",
        sideEffects: ["audit_event"],
        mutate: applyOperationalStatusCommandMutation,
      });
    },
    async executeCheckInCommand(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "checkin_command",
        sideEffects: ["audit_event"],
        mutate: applyCheckInCommandMutation,
      });
    },
    async executeNoShowCommand(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "no_show_command",
        sideEffects: ["audit_event"],
        mutate: applyNoShowCommandMutation,
      });
    },
    async cancelManualBooking(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "manual_cancellation_command",
        sideEffects: ["calendar_refresh", "ari_changed", "audit_event"],
        mutate: applyManualCancellationCommandMutation,
      });
    },
    async refundManualBooking(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "manual_refund_command",
        sideEffects: ["audit_event"],
        mutate: applyManualRefundCommandMutation,
      });
    },
    async correctManualBookingStays(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "manual_stay_correction_command",
        sideEffects: ["calendar_refresh", "ari_changed", "audit_event"],
        mutate: applyManualStayCorrectionCommandMutation,
      });
    },
    async correctManualBookingPrices(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "manual_price_correction_command",
        sideEffects: ["audit_event"],
        mutate: applyManualPriceCorrectionCommandMutation,
      });
    },
    async acceptBooking(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "booking_acceptance_command",
        sideEffects: ["audit_event"],
        mutate: (client, lifecycleCommand, acceptedAt) =>
          applyBookingAcceptanceCommandMutation(config, client, lifecycleCommand, acceptedAt),
      });
    },
    async markBookingPaid(command) {
      return executeOperationalCommand(config, pool, now, {
        command,
        operation: "booking_mark_paid_command",
        sideEffects: ["guest_notification", "audit_event"],
        mutate: applyBookingMarkPaidCommandMutation,
      });
    },
    async getOperationalTemplate(propertyId, templateKind) {
      const client = await pool.connect();
      try {
        return readOperationalTemplate(client, propertyId, templateKind);
      } finally {
        client.release();
      }
    },
    async updateOperationalTemplate(command) {
      const client = await pool.connect();
      const acceptedAt = now().toISOString();
      const keyHash = sha256(command.idempotencyKey);
      const operation = operationalTemplateOperation(command.templateKind);
      const requestFingerprintHash = sha256(stableJson(command));
      const commandMeta: PmsCommandMeta = {
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        acceptedAt,
        sideEffects: ["audit_event"],
      };

      try {
        await client.query("BEGIN");
        const replay = await findOperationalTemplateCommandReplay(
          client,
          command,
          operation,
          keyHash,
          requestFingerprintHash,
        );
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }

        const insertedIdempotencyKey = await recordOperationalTemplateCommandIdempotency(
          client,
          command,
          operation,
          keyHash,
          requestFingerprintHash,
          acceptedAt,
        );
        if (!insertedIdempotencyKey) {
          await client.query("ROLLBACK");
          return operationalTemplateConflict(
            "Operational template idempotency key could not be reserved.",
          );
        }

        const template = await upsertOperationalTemplate(client, command, acceptedAt);
        await insertOperationalTemplateAuditEvent(client, command, template, commandMeta, keyHash);
        await completeOperationalTemplateCommandIdempotency(
          client,
          command,
          operation,
          keyHash,
          commandMeta,
          acceptedAt,
          template,
        );
        await client.query("COMMIT");
        return { ok: true, template, commandMeta };
      } catch (error) {
        await rollbackQuietly(client);
        if (isPgUniqueViolation(error)) {
          return operationalTemplateConflict(
            "Operational template update conflicts with the current template state.",
          );
        }
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

async function executeCheckoutChargeStateCommand<
  TCommand extends PmsCheckoutChargeMarkPaidCommand | PmsCheckoutChargeWaiveCommand,
>(
  pool: PmsOperationsCommandPool,
  now: () => Date,
  options: {
    command: TCommand;
    operation: Exclude<PmsCheckoutChargeOperation, "checkout_charge_create">;
    action: "marked_paid" | "waived";
    status: Extract<PmsCheckoutChargeStatus, "paid" | "waived">;
    mutate: (
      client: PmsOperationsCommandClient,
      acceptedAt: string,
    ) => Promise<PmsCheckoutCharge | Exclude<PmsCheckoutChargeCommandResult, { ok: true }>>;
  },
): Promise<PmsCheckoutChargeCommandResult> {
  const { command, operation, action, mutate } = options;
  const client = await pool.connect();
  const acceptedAt = now().toISOString();
  const keyHash = sha256(command.idempotencyKey);
  const requestFingerprintHash = sha256(stableJson(checkoutChargeCommandFingerprint(command)));
  const commandMeta = checkoutChargeCommandMeta(command, acceptedAt);

  try {
    await client.query("BEGIN");
    const replay = await findCheckoutChargeCommandReplay(
      client,
      operation,
      command,
      keyHash,
      requestFingerprintHash,
    );
    if (replay) {
      await client.query("ROLLBACK");
      return replay;
    }

    if (!(await reservationExists(client, command.propertyId, command.guestBookingId))) {
      await client.query("ROLLBACK");
      return checkoutChargeReservationNotFound(command.guestBookingId);
    }

    const insertedIdempotencyKey = await recordCheckoutChargeCommandIdempotency(
      client,
      operation,
      command,
      keyHash,
      requestFingerprintHash,
      acceptedAt,
    );
    if (!insertedIdempotencyKey) {
      await client.query("ROLLBACK");
      return checkoutChargeConflict("Checkout charge idempotency key could not be reserved.");
    }

    const mutation = await mutate(client, acceptedAt);
    if ("ok" in mutation && !mutation.ok) {
      await client.query("ROLLBACK");
      return mutation;
    }

    const charge = mutation as PmsCheckoutCharge;
    await insertCheckoutChargeAuditEvent(client, action, command, charge, commandMeta, keyHash);
    await completeCheckoutChargeCommandIdempotency(
      client,
      operation,
      command,
      keyHash,
      commandMeta,
      acceptedAt,
      charge,
    );
    await client.query("COMMIT");
    return { ok: true, charge, commandMeta };
  } catch (error) {
    await rollbackQuietly(client);
    if (isPgUniqueViolation(error)) {
      return checkoutChargeConflict(
        "Checkout charge command conflicts with the current charge state.",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function executeCheckOutCommand(
  config: TargetPmsOperationsCommandRepositoryConfig,
  pool: PmsOperationsCommandPool,
  now: () => Date,
  command: PmsCheckOutCommand,
): Promise<PmsCheckOutCommandResult> {
  const client = await pool.connect();
  const acceptedAt = now().toISOString();
  const keyHash = sha256(command.idempotencyKey);
  const requestFingerprintHash = sha256(stableJson(checkOutCommandFingerprint(command)));
  const commandMeta: PmsCommandMeta = {
    contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects: ["audit_event"],
  };

  try {
    await client.query("BEGIN");
    const replay = await findCheckOutCommandReplay(
      config,
      client,
      command,
      keyHash,
      requestFingerprintHash,
    );
    if (replay) {
      await client.query("ROLLBACK");
      return replay;
    }

    const insertedIdempotencyKey = await recordCheckOutCommandIdempotency(
      client,
      command,
      keyHash,
      requestFingerprintHash,
      acceptedAt,
    );
    if (!insertedIdempotencyKey) {
      await client.query("ROLLBACK");
      return checkOutConflict("Check-out command idempotency key could not be reserved.");
    }

    await lockOperationalCommandRoomScopes(client, command);
    const sources = await findAssignmentsForOperationalCommand(client, command);
    if (sources.length === 0) {
      await client.query("ROLLBACK");
      return checkOutReservationNotFound(command.guestBookingId);
    }
    if (
      command.expectedVersion &&
      sources.some((source) => !assignmentVersionMatches(source, command.expectedVersion!))
    ) {
      await client.query("ROLLBACK");
      return checkOutVersionConflict("Reservation check-out version is stale.");
    }
    const invalidSource = sources.find((source) => source.assignmentStatus !== "in_house");
    if (invalidSource) {
      await client.query("ROLLBACK");
      return checkOutInvalidTransition(invalidSource.assignmentStatus, "checked_out");
    }
    if (await hasExistingCheckOutRecord(client, command)) {
      await client.query("ROLLBACK");
      return checkOutInvalidTransition("checked_out", "checked_out");
    }

    const charges = await listCheckoutChargesForUpdate(
      client,
      command.propertyId,
      command.guestBookingId,
      command.assignmentId,
    );
    const chargeIds = new Set(charges.map((charge) => charge.chargeId));
    const unknownSettledChargeId = command.chargesSettled.find(
      (chargeId) => !chargeIds.has(chargeId),
    );
    if (unknownSettledChargeId) {
      await client.query("ROLLBACK");
      return checkOutChargeNotFound(unknownSettledChargeId);
    }

    const settledIdSet = new Set(command.chargesSettled);
    const unsettledSettledCharge = charges.find(
      (charge) =>
        settledIdSet.has(charge.chargeId) && charge.status !== "paid" && charge.status !== "waived",
    );
    if (unsettledSettledCharge) {
      await client.query("ROLLBACK");
      return checkOutInvalidBody(
        "chargesSettled may only include paid or waived checkout charges.",
      );
    }

    const chargesSettled = charges.filter((charge) => settledIdSet.has(charge.chargeId));
    const pendingChargeIds = charges
      .filter((charge) => charge.status === "pending" && !settledIdSet.has(charge.chargeId))
      .map((charge) => charge.chargeId);
    const unsettledPaidChargeIds = charges
      .filter((charge) => charge.status === "paid")
      .map((charge) => charge.chargeId);
    const pendingFlags = checkOutPendingFlags(command, pendingChargeIds, unsettledPaidChargeIds);

    const checkout = await insertCheckOutRecord(client, command, {
      acceptedAt,
      assignmentId: command.assignmentId ?? null,
      chargesSettled,
      pendingFlags,
      pendingChargeIds,
      unsettledPaidChargeIds,
    });
    await updateAssignmentsOperationalStatus(client, command, sources, "checked_out");
    await insertCheckOutAuditEvent(client, command, checkout, commandMeta, keyHash);
    await completeCheckOutCommandIdempotency(
      client,
      command,
      keyHash,
      commandMeta,
      acceptedAt,
      checkout,
      charges,
    );
    await client.query("COMMIT");

    return checkOutResultForCommand(config, command, commandMeta, checkout, charges, false);
  } catch (error) {
    await rollbackQuietly(client);
    if (error instanceof PmsRoomScopeChangedError) {
      return checkOutVersionConflict("Reservation room scope changed. Retry check-out.");
    }
    if (isPgUniqueViolation(error)) {
      return checkOutConflict("Check-out command conflicts with the current reservation state.");
    }
    if (isPgForeignKeyViolation(error)) {
      return checkOutInvalidBody(
        "Check-out references a reservation resource that does not exist.",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function listCheckoutCharges(
  client: PmsOperationsCommandClient,
  propertyId: string,
  guestBookingId: string,
): Promise<PmsCheckoutCharge[]> {
  const result = await client.query<PmsCheckoutChargeRow>(
    checkoutChargeSelectSql(
      `WHERE charge.property_id = $1::uuid
         AND charge.guest_booking_id = $2::uuid
       ORDER BY charge.created_at DESC, charge.id DESC`,
    ),
    [propertyId, guestBookingId],
  );
  return result.rows.map(toPmsCheckoutCharge);
}

async function insertRoomType(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeCreateCommand,
  acceptedAt: string,
): Promise<string> {
  const result = await client.query<{ roomTypeId: string }>(
    `INSERT INTO pms.room_types (
       property_id,
       name,
       description,
       category,
       occupancy_limits,
       room_attributes,
       amenities_snapshot,
       media_snapshot,
       base_rate_amount,
       currency,
       active,
       sort_order,
       created_at,
       updated_at
     )
     VALUES (
       $1::uuid,
       $2,
       $3,
       $4,
       $5::jsonb,
       $6::jsonb,
       $7::jsonb,
       $8::jsonb,
       $9::numeric,
       $10,
       $11,
       $12::integer,
       $13::timestamptz,
       $13::timestamptz
     )
     RETURNING id::text AS "roomTypeId"`,
    [
      command.propertyId,
      command.name,
      command.description,
      command.category,
      JSON.stringify(command.occupancyLimits),
      JSON.stringify(command.attributes),
      JSON.stringify(command.amenities),
      JSON.stringify(command.media),
      command.baseRate.amountDecimal,
      command.baseRate.currency,
      command.active,
      command.sortOrder,
      acceptedAt,
    ],
  );
  return result.rows[0]!.roomTypeId;
}

async function initialRoomSetupAlreadyExists(
  client: PmsOperationsCommandClient,
  propertyId: string,
): Promise<boolean> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(concat('pms-initial-room-setup:', $1::text), 0)
     )`,
    [propertyId],
  );
  const result = await client.query<{ roomSetupExists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM pms.room_types room_type
       WHERE room_type.property_id = $1::uuid
     ) AS "roomSetupExists"`,
    [propertyId],
  );
  return result.rows[0]?.roomSetupExists === true;
}

async function updateRoomTypeLocation(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeUpdateCommand,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE pms.room_types
     SET room_attributes = COALESCE(room_attributes, '{}'::jsonb) || $3::jsonb,
         updated_at = $4::timestamptz
     WHERE property_id = $1::uuid
       AND id = $2::uuid`,
    [command.propertyId, command.roomTypeId, JSON.stringify(command.attributes), acceptedAt],
  );
  return (result.rowCount ?? 0) > 0;
}

async function updateRoomTypeFlexibleCancellation(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeUpdateCommand,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE pms.rate_plans
     SET cancellation_policy_snapshot = $3::jsonb,
         updated_at = $4::timestamptz
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
       AND rate_type = 'flexible'
       AND active = TRUE
       AND pricing_contract_version IS NULL`,
    [
      command.propertyId,
      command.roomTypeId,
      JSON.stringify(command.flexibleCancellationPolicy),
      acceptedAt,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertRoomTypeRatePlans(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeCreateCommand,
  roomTypeId: string,
  acceptedAt: string,
): Promise<PmsRoomType["ratePlans"]> {
  const ratePlans: PmsRoomType["ratePlans"] = [
    await insertRoomTypeRatePlan(client, command, roomTypeId, acceptedAt, {
      code: "FLEX",
      name: "Flexible",
      rateType: "flexible",
      baseRate: command.baseRate,
      cancellationPolicySnapshot: command.flexibleCancellationPolicy ?? {
        kind: "flexible",
        text: "Free until 7 days before",
        flexibleCancellationType: "free",
        partialRefundCancelWindowDays: 30,
        partialRefundAmountPercent: 50,
        partialRefundTiers: [],
      },
    }),
  ];
  if (command.nonRefundableRate) {
    ratePlans.push(
      await insertRoomTypeRatePlan(client, command, roomTypeId, acceptedAt, {
        code: "NRF",
        name: "Non-refundable",
        rateType: "non_refundable",
        baseRate: command.nonRefundableRate,
        cancellationPolicySnapshot: {},
      }),
    );
  }
  return ratePlans;
}

async function insertRoomTypeRatePlan(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeCreateCommand,
  roomTypeId: string,
  acceptedAt: string,
  ratePlan: Pick<
    PmsRoomType["ratePlans"][number],
    "code" | "name" | "rateType" | "baseRate" | "cancellationPolicySnapshot"
  >,
): Promise<PmsRoomType["ratePlans"][number]> {
  const result = await client.query<{ ratePlanId: string }>(
    `INSERT INTO pms.rate_plans (
       property_id,
       room_type_id,
       code,
       name,
       rate_type,
       base_rate_amount,
       currency,
       cancellation_policy_snapshot,
       active,
       created_at,
       updated_at
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3,
       $4,
       $5,
       $6::numeric,
       $7,
       $8::jsonb,
       TRUE,
       $9::timestamptz,
       $9::timestamptz
     )
     ON CONFLICT (property_id, room_type_id, code) DO UPDATE
     SET base_rate_amount = EXCLUDED.base_rate_amount,
         currency = EXCLUDED.currency,
         cancellation_policy_snapshot = EXCLUDED.cancellation_policy_snapshot,
         updated_at = EXCLUDED.updated_at
     RETURNING id::text AS "ratePlanId"`,
    [
      command.propertyId,
      roomTypeId,
      ratePlan.code,
      ratePlan.name,
      ratePlan.rateType,
      ratePlan.baseRate.amountDecimal,
      ratePlan.baseRate.currency,
      JSON.stringify(ratePlan.cancellationPolicySnapshot),
      acceptedAt,
    ],
  );
  return {
    ratePlanId: result.rows[0]!.ratePlanId,
    code: ratePlan.code,
    name: ratePlan.name,
    rateType: ratePlan.rateType,
    mealPlan: null,
    baseRate: ratePlan.baseRate,
    cancellationPolicySnapshot: ratePlan.cancellationPolicySnapshot,
    active: true,
  };
}

export const PMS_ROOM_INVENTORY_HORIZON_DAYS = 366;

export type PmsRoomInventoryDaySeed = {
  stayDate: string;
  status: "open" | "closed";
  totalCount: number;
  availableCount: number;
  seasonIndex: number | null;
  rateAmountDecimal: string | null;
  minStayNights: number | null;
  maxStayNights: number | null;
};

export function buildRoomTypeInventoryHorizon(
  command: PmsRoomTypeCreateCommand,
  acceptedAt: string,
): PmsRoomInventoryDaySeed[] {
  const firstDate = new Date(`${acceptedAt.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(firstDate.getTime())) throw new Error("Room inventory horizon requires a date.");

  return Array.from({ length: PMS_ROOM_INVENTORY_HORIZON_DAYS }, (_, offset) => {
    const date = new Date(firstDate);
    date.setUTCDate(firstDate.getUTCDate() + offset);
    const stayDate = date.toISOString().slice(0, 10);
    const monthDay = stayDate.slice(5);
    const isOperating = command.operatingPeriods.some((period) =>
      recurringMonthDayRangeContains(monthDay, period.from, period.to),
    );
    const seasonIndex = command.seasons.findIndex((season) =>
      recurringMonthDayRangeContains(monthDay, season.from, season.to),
    );
    const season = seasonIndex >= 0 ? command.seasons[seasonIndex]! : null;
    const isOpen = command.active && command.roomCount > 0 && isOperating && season !== null;

    return {
      stayDate,
      status: isOpen ? "open" : "closed",
      totalCount: command.roomCount,
      availableCount: isOpen ? command.roomCount : 0,
      seasonIndex: isOpen ? seasonIndex : null,
      rateAmountDecimal: isOpen ? season!.rate.amountDecimal : null,
      minStayNights: isOpen ? season!.minStayNights : null,
      maxStayNights: isOpen ? season!.maxStayNights : null,
    };
  });
}

function recurringMonthDayRangeContains(monthDay: string, from: string, to: string): boolean {
  return from <= to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to;
}

type PmsRoomRateRuleSeed = {
  startsOn: string;
  endsOn: string;
  seasonIndex: number;
  rateAmountDecimal: string;
  minStayNights: number;
  maxStayNights: number | null;
};

function roomTypeRateRuleSeeds(horizon: readonly PmsRoomInventoryDaySeed[]): PmsRoomRateRuleSeed[] {
  const rules: PmsRoomRateRuleSeed[] = [];
  for (const day of horizon) {
    if (
      day.status !== "open" ||
      day.seasonIndex === null ||
      day.rateAmountDecimal === null ||
      day.minStayNights === null
    ) {
      continue;
    }
    const previous = rules.at(-1);
    if (
      previous &&
      addUtcDays(previous.endsOn, 1) === day.stayDate &&
      previous.seasonIndex === day.seasonIndex &&
      previous.rateAmountDecimal === day.rateAmountDecimal &&
      previous.minStayNights === day.minStayNights &&
      previous.maxStayNights === day.maxStayNights
    ) {
      previous.endsOn = day.stayDate;
      continue;
    }
    rules.push({
      startsOn: day.stayDate,
      endsOn: day.stayDate,
      seasonIndex: day.seasonIndex,
      rateAmountDecimal: day.rateAmountDecimal,
      minStayNights: day.minStayNights,
      maxStayNights: day.maxStayNights,
    });
  }
  return rules;
}

function addUtcDays(dateValue: string, days: number): string {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function insertRoomTypeRateRules(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeCreateCommand,
  roomTypeId: string,
  ratePlans: readonly PmsRoomType["ratePlans"][number][],
  horizon: readonly PmsRoomInventoryDaySeed[],
  acceptedAt: string,
): Promise<void> {
  const baseRateMinor = moneyMinorUnits(command.baseRate.amountDecimal);
  const rules = roomTypeRateRuleSeeds(horizon).flatMap((rule) =>
    ratePlans.map((ratePlan) => {
      const ratePlanMinor = moneyMinorUnits(ratePlan.baseRate.amountDecimal);
      const seasonMinor = moneyMinorUnits(rule.rateAmountDecimal);
      const effectiveMinor = Math.round((seasonMinor * ratePlanMinor) / baseRateMinor);
      return {
        ...rule,
        ratePlanId: ratePlan.ratePlanId,
        priceDeltaAmount: ((effectiveMinor - ratePlanMinor) / 100).toFixed(2),
        effectiveRateAmount: (effectiveMinor / 100).toFixed(2),
        ratePlanCode: ratePlan.code,
      };
    }),
  );
  if (rules.length === 0) return;

  await client.query(
    `INSERT INTO pms.rate_rules (
       property_id,
       room_type_id,
       rate_plan_id,
       rule_type,
       starts_on,
       ends_on,
       min_stay_nights,
       max_stay_nights,
       price_delta_amount,
       rule_payload,
       created_at,
       updated_at
     )
     SELECT
       $1::uuid,
       $2::uuid,
       source."ratePlanId"::uuid,
       'season',
       source."startsOn"::date,
       source."endsOn"::date,
       source."minStayNights"::integer,
       source."maxStayNights"::integer,
       source."priceDeltaAmount"::numeric,
       jsonb_build_object(
         'seasonIndex', source."seasonIndex"::integer,
         'name', source."seasonName",
         'tier', source."seasonTier",
         'rateAmount', source."effectiveRateAmount",
         'ratePlanCode', source."ratePlanCode"
       ),
       $4::timestamptz,
       $4::timestamptz
     FROM jsonb_to_recordset($3::jsonb) AS source(
       "ratePlanId" text,
       "startsOn" text,
       "endsOn" text,
       "seasonIndex" integer,
       "seasonName" text,
       "seasonTier" text,
       "minStayNights" integer,
       "maxStayNights" integer,
       "priceDeltaAmount" text,
       "effectiveRateAmount" text,
       "ratePlanCode" text
     )`,
    [
      command.propertyId,
      roomTypeId,
      JSON.stringify(
        rules.map((rule) => ({
          ...rule,
          seasonName: command.seasons[rule.seasonIndex]!.name,
          seasonTier: command.seasons[rule.seasonIndex]!.tier,
        })),
      ),
      acceptedAt,
    ],
  );
}

function moneyMinorUnits(amountDecimal: string): number {
  return Math.round(Number(amountDecimal) * 100);
}

async function insertRoomTypeInventoryDays(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeCreateCommand,
  roomTypeId: string,
  horizon: readonly PmsRoomInventoryDaySeed[],
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO pms.inventory_days (
       property_id,
       room_type_id,
       stay_date,
       total_count,
       assigned_count,
       blocked_count,
       available_count,
       status,
       source_freshness,
       updated_at
     )
     SELECT
       $1::uuid,
       $2::uuid,
       source."stayDate"::date,
       source."totalCount"::integer,
       0,
       0,
       source."availableCount"::integer,
       source.status,
       jsonb_build_object(
         'pms', jsonb_build_object(
           'status', 'fresh',
           'generatedAt', $4::timestamptz,
           'horizonDays', $5::integer
         )
       ),
       $4::timestamptz
     FROM jsonb_to_recordset($3::jsonb) AS source(
       "stayDate" text,
       "totalCount" integer,
       "availableCount" integer,
       status text
     )
     ON CONFLICT (property_id, room_type_id, stay_date) DO UPDATE SET
       total_count = EXCLUDED.total_count,
       available_count = CASE
         WHEN EXCLUDED.status = 'closed' THEN 0
         ELSE GREATEST(
           0,
           EXCLUDED.total_count
             - pms.inventory_days.assigned_count
             - pms.inventory_days.blocked_count
         )
       END,
       status = EXCLUDED.status,
       source_freshness = EXCLUDED.source_freshness,
       updated_at = EXCLUDED.updated_at`,
    [
      command.propertyId,
      roomTypeId,
      JSON.stringify(horizon),
      acceptedAt,
      PMS_ROOM_INVENTORY_HORIZON_DAYS,
    ],
  );
}

async function insertInitialRooms(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeCreateCommand,
  roomTypeId: string,
  acceptedAt: string,
): Promise<number> {
  if (command.roomCount === 0) return 0;
  await lockPmsRoomOrder(client, command.propertyId);
  const result = await client.query(
    `INSERT INTO pms.rooms (
       property_id,
       room_type_id,
       room_number,
       operational_label_status,
       status,
       sort_order,
       room_metadata,
       created_at,
       updated_at
     )
     SELECT
       $1::uuid,
       $2::uuid,
       NULL,
       'unverified',
       'available',
       room_order_seed.max_sort_order + source.n,
       jsonb_build_object('roomTypeName', $3::text, 'setupGenerated', TRUE),
       $5::timestamptz,
       $5::timestamptz
     FROM (
       SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
       FROM pms.rooms
       WHERE property_id = $1::uuid AND status <> 'retired'
     ) room_order_seed
     CROSS JOIN generate_series(1, $4::integer) AS source(n)
     RETURNING id`,
    [command.propertyId, roomTypeId, command.name, command.roomCount, acceptedAt],
  );
  return result.rowCount ?? result.rows.length;
}

function roomTypeFromCommand(
  command: PmsRoomTypeCreateCommand,
  roomTypeId: string,
  ratePlans: PmsRoomType["ratePlans"],
): PmsRoomType {
  return {
    roomTypeId,
    version: roomTypeVersion(1),
    name: command.name,
    description: command.description,
    category: command.category,
    occupancyLimits: command.occupancyLimits,
    attributes: command.attributes,
    amenities: command.amenities,
    media: command.media,
    baseRate: command.baseRate,
    active: command.active,
    sortOrder: command.sortOrder,
    ratePlans,
    rateRulesSummary: {
      minStayNights: null,
      maxStayNights: null,
      closedToArrival: false,
      closedToDeparture: false,
      activeRuleCount: 0,
    },
    roomCount: command.roomCount,
  };
}

async function executeRoomOrderCommand(
  pool: PmsOperationsCommandPool,
  now: () => Date,
  command: PmsRoomOrderCommand,
): Promise<PmsRoomOrderCommandResult> {
  const client = await pool.connect();
  const acceptedAt = now().toISOString();
  const keyHash = sha256(command.idempotencyKey);
  const requestFingerprintHash = sha256(stableJson(roomOrderCommandFingerprint(command)));
  const commandMeta: PmsCommandMeta = {
    contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects: ["audit_event"],
  };

  try {
    await client.query("BEGIN");
    const replay = await findRoomOrderCommandReplay(
      client,
      command,
      keyHash,
      requestFingerprintHash,
    );
    if (replay) {
      await client.query("ROLLBACK");
      return replay;
    }
    if (
      !(await recordRoomOrderCommandIdempotency(
        client,
        command,
        keyHash,
        requestFingerprintHash,
        acceptedAt,
      ))
    ) {
      const concurrentReplay = await findRoomOrderCommandReplay(
        client,
        command,
        keyHash,
        requestFingerprintHash,
      );
      await client.query("ROLLBACK");
      return (
        concurrentReplay ??
        roomOrderConflict(
          "idempotency_conflict",
          "Room reorder idempotency key could not be reserved.",
        )
      );
    }

    await lockPmsRoomOrder(client, command.propertyId);
    const roomTypeIds = await client.query<{ roomTypeId: string }>(
      `SELECT DISTINCT room_type_id::text AS "roomTypeId"
       FROM pms.rooms
       WHERE property_id = $1::uuid AND status <> 'retired'
       ORDER BY room_type_id::text`,
      [command.propertyId],
    );
    for (const { roomTypeId } of roomTypeIds.rows) {
      await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, roomTypeId);
    }
    const current = await client.query<{ roomId: string }>(
      `SELECT id::text AS "roomId" FROM pms.rooms
       WHERE property_id = $1::uuid AND status <> 'retired'
       ORDER BY sort_order ASC, room_number ASC, id ASC FOR UPDATE`,
      [command.propertyId],
    );
    const currentRoomIds = current.rows.map(({ roomId }) => roomId);
    if (pmsRoomOrderVersion(currentRoomIds) !== command.expectedVersion) {
      await client.query("ROLLBACK");
      return roomOrderConflict("version_conflict", "Room order changed since it was loaded.");
    }
    if (
      currentRoomIds.length !== command.orderedRoomIds.length ||
      currentRoomIds.some((roomId) => !command.orderedRoomIds.includes(roomId))
    ) {
      await client.query("ROLLBACK");
      return roomOrderConflict(
        "room_order_conflict",
        "orderedRoomIds must contain every active room of this property exactly once.",
      );
    }

    const result = await client.query(
      `WITH desired AS (
         SELECT room_id, sort_order::integer
         FROM unnest($2::uuid[]) WITH ORDINALITY AS input(room_id, sort_order)
       )
       UPDATE pms.rooms room
       SET sort_order = desired.sort_order, updated_at = $3::timestamptz
       FROM desired
       WHERE room.property_id = $1::uuid AND room.status <> 'retired'
         AND room.id = desired.room_id`,
      [command.propertyId, command.orderedRoomIds, acceptedAt],
    );
    if (result.rowCount !== command.orderedRoomIds.length) {
      throw new Error("PMS room reorder update count mismatch");
    }
    await insertRoomOrderAuditEvent(client, command, currentRoomIds, commandMeta, keyHash);
    const orderVersion = pmsRoomOrderVersion(command.orderedRoomIds);
    await completeRoomOrderCommandIdempotency(
      client,
      command,
      commandMeta,
      orderVersion,
      keyHash,
      acceptedAt,
    );
    await client.query("COMMIT");
    return { ok: true, orderedRoomIds: command.orderedRoomIds, orderVersion, commandMeta };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function findRoomOrderCommandReplay(
  client: PmsOperationsCommandClient,
  command: PmsRoomOrderCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsRoomOrderCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = 'room_reorder' AND key_hash = $1
       AND tenant_scope = 'property' AND property_id = $2::uuid
     FOR UPDATE`,
    [keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return roomOrderConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different room order.",
    );
  }
  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const orderedRoomIds = existing.idempotencyMetadata?.["orderedRoomIds"];
  const orderVersion = existing.idempotencyMetadata?.["orderVersion"];
  if (
    existing.status !== "completed" ||
    !isPmsCommandMeta(commandMeta) ||
    !Array.isArray(orderedRoomIds) ||
    !orderedRoomIds.every((roomId) => typeof roomId === "string") ||
    typeof orderVersion !== "string"
  ) {
    return roomOrderConflict("idempotency_conflict", "Room reorder is already in progress.");
  }
  return { ok: true, orderedRoomIds, orderVersion, commandMeta, replayed: true };
}

async function recordRoomOrderCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsRoomOrderCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, property_id, correlation_id, expires_at, idempotency_metadata
     ) VALUES (
       'pms', 'room_reorder', $1, $2, 'in_progress', 'property', $3::uuid, $4,
       $5::timestamptz + interval '24 hours', $6::jsonb
     ) ON CONFLICT DO NOTHING RETURNING id`,
    [
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId, audit: command.audit }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeRoomOrderCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsRoomOrderCommand,
  commandMeta: PmsCommandMeta,
  orderVersion: string,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  const metadata = { commandMeta, orderedRoomIds: command.orderedRoomIds, orderVersion };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = 200,
         response_resource_product = 'pms', response_resource_type = 'room_order',
         response_resource_id = $1, response_body_hash = $2,
         completed_at = $3::timestamptz, last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms' AND operation = 'room_reorder' AND key_hash = $5
       AND tenant_scope = 'property' AND property_id = $1::uuid`,
    [
      command.propertyId,
      sha256(stableJson(metadata)),
      acceptedAt,
      JSON.stringify(metadata),
      keyHash,
    ],
  );
}

async function insertRoomOrderAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsRoomOrderCommand,
  previousRoomIds: string[],
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata
     ) VALUES (
       $1, 'pms', 'pms.rooms.reordered', $2::timestamptz, 'property', $3::uuid,
       $4, $5::uuid, 'pms', 'room_order', $3, $6, $7, $8::jsonb, $9::jsonb
     ) ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.room_reorder.property.${command.propertyId}.key.${keyHash}.audit.v1`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({ commandMeta, previousRoomIds, orderedRoomIds: command.orderedRoomIds }),
      JSON.stringify({ reason: command.audit.reason, requestId: command.audit.requestId }),
    ],
  );
}

function roomOrderCommandFingerprint(command: PmsRoomOrderCommand): unknown {
  const { audit: _audit, ...fingerprint } = command;
  return fingerprint;
}

function roomOrderConflict(
  code: "idempotency_conflict" | "room_order_conflict" | "version_conflict",
  message: string,
): Exclude<PmsRoomOrderCommandResult, { ok: true }> {
  return { ok: false, statusCode: 409, code, message };
}

async function executeRoomBlockCommand(
  pool: PmsOperationsCommandPool,
  now: () => Date,
  operation: PmsRoomBlockOperation,
  command: PmsRoomBlockCommand,
): Promise<PmsRoomBlockCommandResult> {
  const client = await pool.connect();
  const acceptedAt = now().toISOString();
  const keyHash = sha256(command.idempotencyKey);
  const requestFingerprintHash = sha256(stableJson(roomBlockCommandFingerprint(command)));
  const commandMeta: PmsCommandMeta = {
    contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects: ["calendar_refresh", "ari_changed", "audit_event"],
  };
  let writingSideEffects = false;

  try {
    await client.query("BEGIN");
    const replay = await findRoomBlockCommandReplay(
      client,
      operation,
      command,
      keyHash,
      requestFingerprintHash,
    );
    if (replay) {
      await client.query("ROLLBACK");
      return replay;
    }
    if (
      !(await recordRoomBlockCommandIdempotency(
        client,
        operation,
        command,
        keyHash,
        requestFingerprintHash,
        acceptedAt,
      ))
    ) {
      const concurrentReplay = await findRoomBlockCommandReplay(
        client,
        operation,
        command,
        keyHash,
        requestFingerprintHash,
      );
      await client.query("ROLLBACK");
      return (
        concurrentReplay ??
        roomBlockConflict(
          "idempotency_conflict",
          "Room block command idempotency key could not be reserved.",
        )
      );
    }

    await lockPmsInventoryMutationScope(client, command.propertyId);
    const mutation = await applyRoomBlockMutation(client, operation, command, acceptedAt);
    if (!mutation.ok) {
      await client.query("ROLLBACK");
      return mutation;
    }

    writingSideEffects = true;
    const linkedChanges = await reconcilePmsLinkedInventory(client, command.propertyId, acceptedAt);
    await enqueueInventoryChangedSideEffects(
      client,
      command,
      {
        roomTypeId: mutation.value.roomTypeId,
        resourceType: "room_block",
        resourceId: mutation.value.items[0]!.blockId,
        dateRange: { from: mutation.value.affectedFrom, to: mutation.value.affectedTo },
        calendarRefresh: true,
      },
      commandMeta,
      keyHash,
      acceptedAt,
    );
    await enqueuePmsLinkedInventorySideEffects(
      client,
      {
        propertyId: command.propertyId,
        operation,
        commandId: command.commandId,
        keyHash,
        acceptedAt,
        audit: command.audit,
      },
      linkedChanges,
    );
    await insertRoomBlockAuditEvent(
      client,
      operation,
      command,
      mutation.value,
      commandMeta,
      keyHash,
    );
    await completeRoomBlockCommandIdempotency(
      client,
      operation,
      command,
      mutation.value.items,
      commandMeta,
      keyHash,
      acceptedAt,
    );
    await client.query("COMMIT");
    return { ok: true, items: mutation.value.items, commandMeta };
  } catch (error) {
    await rollbackQuietly(client);
    if (writingSideEffects) {
      return {
        ok: false,
        statusCode: 500,
        code: "side_effect_failed",
        message: "Room block side effects could not be queued; no changes were committed.",
      };
    }
    if (isPgUniqueViolation(error) || isPgForeignKeyViolation(error)) {
      return roomBlockConflict(
        "room_block_conflict",
        "Room block conflicts with the current inventory state.",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function applyRoomBlockMutation(
  client: PmsOperationsCommandClient,
  operation: PmsRoomBlockOperation,
  command: PmsRoomBlockCommand,
  acceptedAt: string,
): Promise<
  { ok: true; value: PmsRoomBlockMutation } | Exclude<PmsRoomBlockCommandResult, { ok: true }>
> {
  if (operation === "room_block_create") {
    const create = command as PmsRoomBlockCreateCommand;
    await lockPmsPhysicalRoomUnitMutationScope(client, create.propertyId, create.roomTypeId);
    await lockRoomTypeRooms(client, create.propertyId, create.roomTypeId);
    if (
      !(await roomBlockRoomsAreAvailable(
        client,
        create.propertyId,
        create.roomTypeId,
        create.roomIds,
        create.startsOn,
        create.endsOn,
        null,
      )) ||
      !(await roomBlockCapacityIsAvailable(
        client,
        create.propertyId,
        create.roomTypeId,
        create.startsOn,
        create.endsOn,
        create.roomIds.length,
      ))
    ) {
      return roomBlockConflict(
        "room_block_conflict",
        "One or more rooms are unavailable for the requested dates.",
      );
    }
    const result = await client.query<PmsRoomBlockRow>(
      `INSERT INTO pms.room_blocks (
         property_id, room_type_id, room_id, starts_on, ends_on, blocked_count,
         reason, created_by_user_id, created_at, updated_at
       )
       SELECT $1::uuid, $2::uuid, room_id, $3::date, $4::date, 1, $5,
              $6::uuid, $7::timestamptz, $7::timestamptz
       FROM unnest($8::uuid[]) AS room_id
       RETURNING id::text AS "blockId", room_type_id::text AS "roomTypeId",
         room_id::text AS "roomId",
         starts_on AS "startsOn", ends_on AS "endsOn", blocked_count AS "blockedCount",
         reason, status, revision`,
      [
        create.propertyId,
        create.roomTypeId,
        create.startsOn,
        create.endsOn,
        create.reason,
        create.audit.actor.kind === "user" ? create.audit.actor.userId : null,
        acceptedAt,
        create.roomIds,
      ],
    );
    await reconcileRoomBlockInventory(
      client,
      create.propertyId,
      create.roomTypeId,
      create.startsOn,
      create.endsOn,
      acceptedAt,
    );
    return {
      ok: true,
      value: {
        items: result.rows.map(roomBlockSummary),
        roomTypeId: create.roomTypeId,
        affectedFrom: create.startsOn,
        affectedTo: create.endsOn,
      },
    };
  }

  const existingCommand = command as PmsRoomBlockUpdateCommand | PmsRoomBlockReleaseCommand;
  const initial = await findRoomBlock(client, existingCommand.propertyId, existingCommand.blockId);
  if (!initial) return roomBlockNotFound(existingCommand.blockId);
  await lockPmsPhysicalRoomUnitMutationScope(
    client,
    existingCommand.propertyId,
    initial.roomTypeId,
  );
  await lockRoomTypeRooms(client, existingCommand.propertyId, initial.roomTypeId);
  const current = await findRoomBlock(
    client,
    existingCommand.propertyId,
    existingCommand.blockId,
    true,
  );
  if (!current || current.status !== "active" || current.blockKind !== "manual") {
    return roomBlockNotFound(existingCommand.blockId);
  }
  if (existingCommand.expectedVersion !== `room-block-v${current.revision}`) {
    return roomBlockConflict("version_conflict", "Room block changed. Refresh and try again.");
  }

  if (operation === "room_block_update") {
    const update = command as PmsRoomBlockUpdateCommand;
    const startsOn = update.startsOn ?? dateOnly(current.startsOn);
    const endsOn = update.endsOn ?? dateOnly(current.endsOn);
    if (startsOn > endsOn) {
      return roomBlockConflict("room_block_conflict", "Room block dates are not ordered.");
    }
    if (
      !current.roomId ||
      !(await roomBlockRoomsAreAvailable(
        client,
        update.propertyId,
        current.roomTypeId,
        [current.roomId],
        startsOn,
        endsOn,
        current.blockId,
      )) ||
      !(await roomBlockCapacityIsAvailable(
        client,
        update.propertyId,
        current.roomTypeId,
        startsOn,
        endsOn,
        1,
        { from: dateOnly(current.startsOn), to: dateOnly(current.endsOn) },
      ))
    ) {
      return roomBlockConflict(
        "room_block_conflict",
        "Room is unavailable for the requested dates.",
      );
    }
    const result = await client.query<PmsRoomBlockRow>(
      `UPDATE pms.room_blocks
       SET starts_on = $3::date, ends_on = $4::date, reason = $5,
           revision = revision + 1, updated_at = $6::timestamptz
       WHERE property_id = $1::uuid AND id = $2::uuid
         AND status = 'active' AND block_kind = 'manual'
       RETURNING id::text AS "blockId", room_type_id::text AS "roomTypeId",
         room_id::text AS "roomId",
         starts_on AS "startsOn", ends_on AS "endsOn", blocked_count AS "blockedCount",
         reason, status, revision`,
      [
        update.propertyId,
        update.blockId,
        startsOn,
        endsOn,
        update.reason ?? current.reason,
        acceptedAt,
      ],
    );
    const affectedFrom =
      startsOn < dateOnly(current.startsOn) ? startsOn : dateOnly(current.startsOn);
    const affectedTo = endsOn > dateOnly(current.endsOn) ? endsOn : dateOnly(current.endsOn);
    await reconcileRoomBlockInventory(
      client,
      update.propertyId,
      current.roomTypeId,
      affectedFrom,
      affectedTo,
      acceptedAt,
    );
    return {
      ok: true,
      value: {
        items: result.rows.map(roomBlockSummary),
        roomTypeId: current.roomTypeId,
        affectedFrom,
        affectedTo,
      },
    };
  }

  const released = await client.query<PmsRoomBlockRow>(
    `UPDATE pms.room_blocks
     SET status = 'released', released_at = $3::timestamptz,
         revision = revision + 1, updated_at = $3::timestamptz
     WHERE property_id = $1::uuid AND id = $2::uuid
       AND status = 'active' AND block_kind = 'manual'
     RETURNING id::text AS "blockId", room_type_id::text AS "roomTypeId",
       room_id::text AS "roomId",
       starts_on AS "startsOn", ends_on AS "endsOn", blocked_count AS "blockedCount",
       reason, status, revision`,
    [existingCommand.propertyId, existingCommand.blockId, acceptedAt],
  );
  const from = dateOnly(current.startsOn);
  const to = dateOnly(current.endsOn);
  await reconcileRoomBlockInventory(
    client,
    existingCommand.propertyId,
    current.roomTypeId,
    from,
    to,
    acceptedAt,
  );
  return {
    ok: true,
    value: {
      items: released.rows.map(roomBlockSummary),
      roomTypeId: current.roomTypeId,
      affectedFrom: from,
      affectedTo: to,
    },
  };
}

async function lockRoomTypeRooms(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<void> {
  await client.query(
    `SELECT id FROM pms.rooms
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
     ORDER BY id FOR UPDATE`,
    [propertyId, roomTypeId],
  );
}

async function roomBlockRoomsAreAvailable(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomTypeId: string,
  roomIds: string[],
  startsOn: string,
  endsOn: string,
  excludedBlockId: string | null,
): Promise<boolean> {
  const result = await client.query<{ roomId: string }>(
    `SELECT room.id::text AS "roomId"
     FROM pms.rooms room
     WHERE room.property_id = $1::uuid AND room.room_type_id = $2::uuid
       AND room.id = ANY($3::uuid[]) AND room.status = 'available'
       AND room.operational_label_status = 'verified' AND room.room_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pms.room_blocks block
         WHERE block.property_id = room.property_id AND block.room_id = room.id
           AND block.status = 'active' AND ($6::uuid IS NULL OR block.id <> $6::uuid)
           AND daterange(block.starts_on, block.ends_on + 1, '[)') &&
               daterange($4::date, $5::date + 1, '[)')
       )
       AND NOT EXISTS (
         SELECT 1 FROM pms.operational_booking_assignments assignment
         JOIN booking.guest_bookings booking
           ON booking.id = assignment.guest_booking_id
          AND booking.property_id = assignment.property_id
         WHERE assignment.property_id = room.property_id AND assignment.room_id = room.id
           AND assignment.assignment_status NOT IN ('canceled', 'released')
           AND daterange(COALESCE(assignment.check_in, booking.check_in),
                         COALESCE(assignment.check_out, booking.check_out), '[)') &&
               daterange($4::date, $5::date + 1, '[)')
       )`,
    [propertyId, roomTypeId, roomIds, startsOn, endsOn, excludedBlockId],
  );
  return result.rows.length === roomIds.length;
}

async function roomBlockCapacityIsAvailable(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomTypeId: string,
  startsOn: string,
  endsOn: string,
  requestedCount: number,
  creditedRange?: { from: string; to: string },
): Promise<boolean> {
  const result = await client.query<{
    stayDate: Date | string;
    totalCount: number;
    assignedCount: number;
    blockedCount: number;
  }>(
    `SELECT stay_date AS "stayDate", total_count AS "totalCount",
            assigned_count AS "assignedCount", blocked_count AS "blockedCount"
     FROM pms.inventory_days
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND stay_date BETWEEN $3::date AND $4::date
     ORDER BY stay_date FOR UPDATE`,
    [propertyId, roomTypeId, startsOn, endsOn],
  );
  const expectedDays =
    Math.floor(
      (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000,
    ) + 1;
  return (
    result.rows.length === expectedDays &&
    result.rows.every((day) => {
      const stayDate = dateOnly(day.stayDate);
      const credit =
        creditedRange && stayDate >= creditedRange.from && stayDate <= creditedRange.to ? 1 : 0;
      return (
        Number(day.totalCount) - Number(day.assignedCount) - Number(day.blockedCount) + credit >=
        requestedCount
      );
    })
  );
}

async function reconcileRoomBlockInventory(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomTypeId: string,
  affectedFrom: string,
  affectedTo: string,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `WITH affected_dates AS (
       SELECT generate_series($3::date, $4::date, interval '1 day')::date AS stay_date
     ), changes AS (
       SELECT affected.stay_date,
              COALESCE(SUM(block.blocked_count), 0)::integer AS blocked_count
       FROM affected_dates affected
       LEFT JOIN pms.room_blocks block
         ON block.property_id = $1::uuid AND block.room_type_id = $2::uuid
        AND block.status = 'active'
        AND affected.stay_date BETWEEN block.starts_on AND block.ends_on
       GROUP BY affected.stay_date
     )
     UPDATE pms.inventory_days inventory
     SET blocked_count = changes.blocked_count,
         available_count = CASE WHEN inventory.status = 'closed' OR inventory.linked_stop_sell
           THEN 0 ELSE GREATEST(
           0, COALESCE(inventory.effective_sellable_limit_count, inventory.total_count)
             - inventory.assigned_count - changes.blocked_count
         ) END,
         inventory_revision = CASE WHEN inventory.inventory_revision IS NULL THEN NULL ELSE inventory.inventory_revision + 1 END,
         block_source_revision = CASE WHEN inventory.block_source_revision IS NULL THEN NULL ELSE inventory.block_source_revision + 1 END,
         updated_at = $5::timestamptz
     FROM changes
     WHERE inventory.property_id = $1::uuid AND inventory.room_type_id = $2::uuid
       AND inventory.stay_date = changes.stay_date
       AND inventory.blocked_count IS DISTINCT FROM changes.blocked_count`,
    [propertyId, roomTypeId, affectedFrom, affectedTo, acceptedAt],
  );
}

async function findRoomBlock(
  client: PmsOperationsCommandClient,
  propertyId: string,
  blockId: string,
  forUpdate = false,
): Promise<PmsRoomBlockRow | null> {
  const result = await client.query<PmsRoomBlockRow>(
    `SELECT id::text AS "blockId", block_kind AS "blockKind",
       room_type_id::text AS "roomTypeId",
       room_id::text AS "roomId",
       starts_on AS "startsOn", ends_on AS "endsOn", blocked_count AS "blockedCount",
       reason, status, revision
     FROM pms.room_blocks
     WHERE property_id = $1::uuid AND id = $2::uuid${forUpdate ? " FOR UPDATE" : ""}`,
    [propertyId, blockId],
  );
  return result.rows[0] ?? null;
}

async function findRoomBlockCommandReplay(
  client: PmsOperationsCommandClient,
  operation: PmsRoomBlockOperation,
  command: PmsRoomBlockCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsRoomBlockCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'property' AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return roomBlockConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different room block command.",
    );
  }
  if (existing.status !== "completed") {
    return roomBlockConflict("idempotency_conflict", "Room block command is already in progress.");
  }
  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const items = existing.idempotencyMetadata?.["items"];
  if (!isPmsCommandMeta(commandMeta) || !Array.isArray(items) || !items.every(isRoomBlockSummary)) {
    return roomBlockConflict(
      "idempotency_conflict",
      "Room block command replay metadata is unavailable.",
    );
  }
  return { ok: true, items, commandMeta, replayed: true };
}

async function recordRoomBlockCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: PmsRoomBlockOperation,
  command: PmsRoomBlockCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, property_id, correlation_id, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
       $6::timestamptz + interval '24 hours', $7::jsonb
     ) ON CONFLICT DO NOTHING RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId, audit: command.audit }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeRoomBlockCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: PmsRoomBlockOperation,
  command: PmsRoomBlockCommand,
  items: PmsRoomBlockSummary[],
  commandMeta: PmsCommandMeta,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  const metadata = { commandMeta, items };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = 200,
         response_resource_product = 'pms', response_resource_type = 'room_block',
         response_resource_id = $1, response_body_hash = $2,
         completed_at = $3::timestamptz, last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms' AND operation = $5 AND key_hash = $6
       AND tenant_scope = 'property' AND property_id = $7::uuid`,
    [
      items[0]!.blockId,
      sha256(stableJson(metadata)),
      acceptedAt,
      JSON.stringify(metadata),
      operation,
      keyHash,
      command.propertyId,
    ],
  );
}

async function insertRoomBlockAuditEvent(
  client: PmsOperationsCommandClient,
  operation: PmsRoomBlockOperation,
  command: PmsRoomBlockCommand,
  mutation: PmsRoomBlockMutation,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, correlation_id, causation_id, redacted_payload, audit_metadata
     ) VALUES (
       $1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, $5, $6::uuid,
       'pms', 'room_block', $7, $8, $9, $10::jsonb, $11::jsonb
     ) ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.${operation}.property.${command.propertyId}.key.${keyHash}.audit.v1`,
      `pms.${operation}`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      mutation.items[0]!.blockId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        commandMeta,
        roomTypeId: mutation.roomTypeId,
        itemCount: mutation.items.length,
      }),
      JSON.stringify({ reason: command.audit.reason, requestId: command.audit.requestId }),
    ],
  );
}

function roomBlockCommandFingerprint(command: PmsRoomBlockCommand): unknown {
  const { audit: _audit, ...fingerprint } = command;
  return fingerprint;
}

function roomBlockSummary(row: PmsRoomBlockRow): PmsRoomBlockSummary {
  return {
    blockId: row.blockId,
    version: `room-block-v${row.revision}`,
    roomTypeId: row.roomTypeId,
    roomId: row.roomId,
    startsOn: dateOnly(row.startsOn),
    endsOn: dateOnly(row.endsOn),
    blockedCount: Number(row.blockedCount),
    reason: row.reason,
    status: row.status,
  };
}

function isRoomBlockSummary(value: unknown): value is PmsRoomBlockSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PmsRoomBlockSummary>;
  return (
    typeof item.blockId === "string" &&
    typeof item.version === "string" &&
    typeof item.roomTypeId === "string" &&
    (typeof item.roomId === "string" || item.roomId === null) &&
    typeof item.startsOn === "string" &&
    typeof item.endsOn === "string" &&
    typeof item.blockedCount === "number" &&
    typeof item.reason === "string" &&
    (item.status === "active" || item.status === "released" || item.status === "expired")
  );
}

function dateOnly(value: Date | string): string {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function roomBlockConflict(
  code: "room_block_conflict" | "version_conflict" | "idempotency_conflict",
  message: string,
): Exclude<PmsRoomBlockCommandResult, { ok: true }> {
  return { ok: false, statusCode: 409, code, message };
}

function roomBlockNotFound(blockId: string): Exclude<PmsRoomBlockCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "room_block_not_found",
    message: `Room block ${blockId} was not found.`,
  };
}

async function findRoomTypeCommandReplay(
  client: PmsOperationsCommandClient,
  operation: PmsRoomTypeCommandOperation,
  command: PmsRoomTypeCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsRoomTypeCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return roomTypeConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different room type command.",
    );
  }
  if (existing.status !== "completed") {
    return roomTypeConflict("idempotency_conflict", "Room type command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const roomType = existing.idempotencyMetadata?.["roomType"];
  if (!isPmsCommandMeta(commandMeta) || !isPmsRoomType(roomType)) {
    return roomTypeConflict(
      "idempotency_conflict",
      "Room type command replay metadata is unavailable.",
    );
  }
  return { ok: true, roomType, commandMeta, replayed: true };
}

async function recordRoomTypeCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: PmsRoomTypeCommandOperation,
  command: PmsRoomTypeCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId, audit: command.audit }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeRoomTypeCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: PmsRoomTypeCommandOperation,
  command: PmsRoomTypeCommand,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  roomType: PmsRoomType,
): Promise<void> {
  const idempotencyMetadata = { commandMeta, roomType };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'room_type',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      roomType.roomTypeId,
      sha256(stableJson(idempotencyMetadata)),
      acceptedAt,
      JSON.stringify(idempotencyMetadata),
      operation,
      keyHash,
      command.propertyId,
    ],
  );
}

async function lockActiveRoomTypeForLifecycle(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeDuplicateCommand | PmsRoomTypeRetireCommand,
): Promise<PmsRoomTypeLifecycleRow | null> {
  const result = await client.query<PmsRoomTypeLifecycleRow>(
    `SELECT id::text AS "roomTypeId", name,
            room_facts_revision AS "roomFactsRevision"
     FROM pms.room_types
     WHERE property_id = $1::uuid AND id = $2::uuid AND active
     FOR UPDATE`,
    [command.propertyId, command.roomTypeId],
  );
  return result.rows[0] ?? null;
}

function roomTypeVersion(revision: number | string): string {
  return `room-type-facts-v${Number(revision)}`;
}

async function availableRoomTypeCopyName(
  client: PmsOperationsCommandClient,
  propertyId: string,
  sourceName: string,
): Promise<string> {
  const names = await client.query<{ name: string }>(
    `SELECT lower(name) AS name
     FROM pms.room_types
     WHERE property_id = $1::uuid AND active
     ORDER BY lower(name)`,
    [propertyId],
  );
  const existing = new Set(names.rows.map(({ name }) => name));
  for (let copyNumber = 1; copyNumber <= 999; copyNumber += 1) {
    const suffix = copyNumber === 1 ? " Copy" : ` Copy ${copyNumber}`;
    const candidate = `${sourceName.slice(0, 200 - suffix.length).trimEnd()}${suffix}`;
    if (!existing.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error("Room type copy name space is exhausted");
}

async function insertDuplicatedRoomType(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeDuplicateCommand,
  name: string,
  acceptedAt: string,
): Promise<{ roomTypeId: string; sortOrder: number }> {
  const result = await client.query<{ roomTypeId: string; sortOrder: number }>(
    `INSERT INTO pms.room_types (
       property_id, source_system, source_room_type_id, setup_draft_room_id,
       name, description, category, occupancy_limits, room_attributes,
       amenities_snapshot, media_snapshot, base_rate_amount, currency, active,
       sort_order, location_summary, room_facts_revision, room_units_revision,
       room_media_revision, room_amenities_revision, room_amenities_reviewed_at,
       linked_inventory_group_id, created_at, updated_at
     )
     SELECT
       source.property_id, 'pms', NULL, NULL,
       $3, source.description, source.category, source.occupancy_limits,
       source.room_attributes, source.amenities_snapshot, source.media_snapshot,
       source.base_rate_amount, source.currency, TRUE,
       COALESCE((SELECT max(sort_order) + 1 FROM pms.room_types
                 WHERE property_id = source.property_id AND active), 0),
       source.location_summary, 1, 1, 1, 1, NULL, NULL,
       $4::timestamptz, $4::timestamptz
     FROM pms.room_types source
     WHERE source.property_id = $1::uuid AND source.id = $2::uuid AND source.active
     RETURNING id::text AS "roomTypeId", sort_order AS "sortOrder"`,
    [command.propertyId, command.roomTypeId, name, acceptedAt],
  );
  const duplicated = result.rows[0];
  if (!duplicated) throw new Error("Room type duplication lost its locked source");
  return duplicated;
}

async function copyRoomTypeMediaAssignments(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeDuplicateCommand,
  duplicatedRoomTypeId: string,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO pms.room_type_media (
       property_id, room_type_id, platform_media_object_id, alt_text,
       sort_order, created_at, updated_at
     )
     SELECT property_id, $3::uuid, platform_media_object_id, alt_text,
            sort_order, $4::timestamptz, $4::timestamptz
     FROM pms.room_type_media
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
     ORDER BY sort_order, platform_media_object_id`,
    [command.propertyId, command.roomTypeId, duplicatedRoomTypeId, acceptedAt],
  );
}

async function copyLegacyRoomTypePricing(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeDuplicateCommand,
  duplicatedRoomTypeId: string,
  acceptedAt: string,
): Promise<PmsRoomType["ratePlans"]> {
  await client.query(
    `INSERT INTO pms.rate_plans (
       property_id, room_type_id, code, name, rate_type, meal_plan,
       payment_policy, deposit_policy, cancellation_policy_snapshot,
       base_rate_amount, currency, active, created_at, updated_at
     )
     SELECT source.property_id, $3::uuid, source.code, source.name,
            source.rate_type, source.meal_plan, source.payment_policy,
            source.deposit_policy, source.cancellation_policy_snapshot,
            source.base_rate_amount, source.currency, source.active,
            $4::timestamptz, $4::timestamptz
     FROM pms.rate_plans source
     WHERE source.property_id = $1::uuid AND source.room_type_id = $2::uuid
       AND source.pricing_contract_version IS NULL
     ORDER BY source.code, source.id`,
    [command.propertyId, command.roomTypeId, duplicatedRoomTypeId, acceptedAt],
  );
  await client.query(
    `INSERT INTO pms.rate_rules (
       property_id, room_type_id, rate_plan_id, rule_type, starts_on, ends_on,
       days_of_week, min_stay_nights, max_stay_nights, closed_to_arrival,
       closed_to_departure, price_delta_amount, price_delta_percent,
       rule_payload, created_at, updated_at
     )
     SELECT rule.property_id, $3::uuid, target_plan.id, rule.rule_type,
            rule.starts_on, rule.ends_on, rule.days_of_week, rule.min_stay_nights,
            rule.max_stay_nights, rule.closed_to_arrival, rule.closed_to_departure,
            rule.price_delta_amount, rule.price_delta_percent, rule.rule_payload,
            $4::timestamptz, $4::timestamptz
     FROM pms.rate_rules rule
     LEFT JOIN pms.rate_plans source_plan
       ON source_plan.id = rule.rate_plan_id
      AND source_plan.property_id = rule.property_id
      AND source_plan.room_type_id = rule.room_type_id
     LEFT JOIN pms.rate_plans target_plan
       ON target_plan.property_id = rule.property_id
      AND target_plan.room_type_id = $3::uuid
      AND target_plan.code = source_plan.code
     WHERE rule.property_id = $1::uuid AND rule.room_type_id = $2::uuid
       AND (rule.rate_plan_id IS NULL OR source_plan.pricing_contract_version IS NULL)
       AND (rule.rate_plan_id IS NULL OR target_plan.id IS NOT NULL)
     ORDER BY rule.starts_on, rule.ends_on, rule.id`,
    [command.propertyId, command.roomTypeId, duplicatedRoomTypeId, acceptedAt],
  );
  const plans = await client.query<PmsLegacyRatePlanRow>(
    `SELECT id::text AS "ratePlanId", code, name, rate_type AS "rateType",
            meal_plan AS "mealPlan", base_rate_amount::text AS "baseRateAmount",
            currency, active
     FROM pms.rate_plans
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
     ORDER BY code, id`,
    [command.propertyId, duplicatedRoomTypeId],
  );
  return plans.rows.map((plan) => ({
    ratePlanId: plan.ratePlanId,
    pricingContractVersion: null,
    code: plan.code,
    name: plan.name,
    rateType: plan.rateType,
    mealPlan: plan.mealPlan,
    baseRate: { amountDecimal: plan.baseRateAmount, currency: plan.currency },
    active: plan.active,
  }));
}

type PmsRoomTypeRetirementCountsRow = {
  reservationCount: number | string;
  physicalUnitCount: number | string;
  inventoryCount: number | string;
  publicationCount: number | string;
  roomFactsRevision: number | string;
};

async function inspectRoomTypeRetirement(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<PmsRoomTypeRetirementImpact | null> {
  const result = await client.query<PmsRoomTypeRetirementCountsRow>(
    `SELECT room_type.room_facts_revision AS "roomFactsRevision",
       ((SELECT count(*) FROM pms.operational_booking_assignments assignment
         WHERE assignment.property_id = room_type.property_id
           AND assignment.room_type_id = room_type.id
           AND assignment.assignment_status IN ('pending','assigned','checked_in','in_house'))
        +
        (SELECT count(*) FROM pms.inventory_reservation_receipts receipt
         JOIN pms.inventory_reservation_statuses status
           ON status.receipt_id = receipt.receipt_id
         WHERE receipt.property_id = room_type.property_id
           AND receipt.room_type_id = room_type.id
           AND status.lifecycle_state IN ('reserved','handed_off')
           AND receipt.check_out > CURRENT_DATE))::bigint AS "reservationCount",
       (SELECT count(*) FROM pms.rooms room
        WHERE room.property_id = room_type.property_id
          AND room.room_type_id = room_type.id
          AND room.status <> 'retired')::bigint AS "physicalUnitCount",
       ((SELECT count(*) FROM pms.inventory_days inventory
         WHERE inventory.property_id = room_type.property_id
           AND inventory.room_type_id = room_type.id
           AND inventory.stay_date >= CURRENT_DATE
           AND (inventory.status <> 'closed' OR inventory.available_count > 0
                OR inventory.assigned_count > 0 OR inventory.blocked_count > 0))
        +
        (SELECT count(*) FROM pms.room_blocks block
         WHERE block.property_id = room_type.property_id
           AND (block.room_type_id = room_type.id OR block.source_room_type_id = room_type.id)
           AND block.status = 'active' AND block.ends_on >= CURRENT_DATE)
        + CASE WHEN room_type.linked_inventory_group_id IS NULL THEN 0 ELSE 1 END
       )::bigint AS "inventoryCount",
       ((SELECT count(*) FROM distribution.public_room_offer_snapshots offer
         WHERE offer.property_id = room_type.property_id
           AND offer.room_type_id = room_type.id
           AND offer.stay_date >= CURRENT_DATE AND offer.sellable_publicly)
        +
        (SELECT count(*) FROM pms.channel_room_type_mappings mapping
         WHERE mapping.property_id = room_type.property_id
           AND mapping.room_type_id = room_type.id AND mapping.status = 'active')
        +
        (SELECT count(*) FROM pms.channel_rate_plan_mappings mapping
         WHERE mapping.property_id = room_type.property_id
           AND mapping.room_type_id = room_type.id AND mapping.status = 'active')
        +
        (SELECT count(*)
         FROM distribution.active_public_booking_revision active_revision
         JOIN distribution.public_booking_content_revisions content
           ON content.id = active_revision.content_revision_id
          AND content.property_id = active_revision.property_id
         WHERE active_revision.property_id = room_type.property_id
           AND (
             jsonb_path_exists(
               content.source_manifest,
               'strict $.** ? (@ == $roomTypeId)',
               jsonb_build_object('roomTypeId', to_jsonb(room_type.id::text))
             )
             OR jsonb_path_exists(
               content.public_content,
               'strict $.** ? (@ == $roomTypeId)',
               jsonb_build_object('roomTypeId', to_jsonb(room_type.id::text))
             )
           ))
       )::bigint AS "publicationCount"
     FROM pms.room_types room_type
     WHERE room_type.property_id = $1::uuid AND room_type.id = $2::uuid AND room_type.active`,
    [propertyId, roomTypeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const blockers: PmsRoomTypeRetirementBlocker[] = [];
  const add = (
    category: PmsRoomTypeRetirementBlocker["category"],
    code: PmsRoomTypeRetirementBlocker["code"],
    count: number | string,
    action: string,
  ) => {
    const affectedCount = Number(count);
    if (affectedCount > 0) blockers.push({ category, code, affectedCount, action });
  };
  add(
    "reservations",
    "active_reservations",
    row.reservationCount,
    "Move, cancel, check out, or release active reservations and inventory holds.",
  );
  add(
    "physical_units",
    "active_physical_units",
    row.physicalUnitCount,
    "Retire or move every active physical room unit assigned to this room type.",
  );
  add(
    "inventory",
    "future_inventory",
    row.inventoryCount,
    "Close future inventory, release room blocks, and remove linked-inventory membership.",
  );
  add(
    "publication",
    "active_publication",
    row.publicationCount,
    "Unpublish public offers and disable channel mappings for this room type.",
  );
  return {
    contractVersion: PMS_ROOM_TYPE_LIFECYCLE_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    version: roomTypeVersion(row.roomFactsRevision),
    canRetire: blockers.length === 0,
    blockers,
  };
}

async function lockRoomTypeRetirementDependencies(
  client: PmsOperationsCommandClient,
): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query(
    `LOCK TABLE pms.operational_booking_assignments,
       pms.inventory_reservation_receipts, pms.inventory_reservation_statuses,
       pms.rooms, pms.inventory_days, pms.room_blocks,
       pms.rate_plans, pms.rate_rules,
       pms.channel_room_type_mappings, pms.channel_rate_plan_mappings,
       distribution.public_room_offer_snapshots,
       distribution.active_public_booking_revision,
       distribution.public_booking_content_revisions
     IN SHARE ROW EXCLUSIVE MODE`,
  );
}

function lifecycleInventoryResource(
  command: PmsRoomTypeDuplicateCommand | PmsRoomTypeRetireCommand,
  roomTypeId: string,
  acceptedAt: string,
) {
  return {
    roomTypeId,
    resourceType: "room_type" as const,
    resourceId: roomTypeId,
    dateRange: {
      from: acceptedAt.slice(0, 10),
      to: addUtcDays(acceptedAt.slice(0, 10), PMS_ROOM_INVENTORY_HORIZON_DAYS - 1),
    },
    calendarRefresh: false,
  };
}

async function findRoomTypeRetireReplay(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeRetireCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsRoomTypeRetireCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = 'room_type_retire'
       AND key_hash = $1 AND tenant_scope = 'property' AND property_id = $2::uuid
     FOR UPDATE`,
    [keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return roomTypeRetireConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different room type retirement command.",
    );
  }
  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const impact = existing.idempotencyMetadata?.["impact"];
  if (
    existing.status !== "completed" ||
    !isPmsCommandMeta(commandMeta) ||
    !isPmsRoomTypeRetirementImpact(impact)
  ) {
    return roomTypeRetireConflict(
      "idempotency_conflict",
      "Room type retirement replay metadata is unavailable.",
    );
  }
  return { ok: true, impact, commandMeta, replayed: true };
}

async function completeRoomTypeRetireIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeRetireCommand,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  impact: PmsRoomTypeRetirementImpact,
): Promise<void> {
  const metadata = { commandMeta, impact };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = 200,
         response_resource_product = 'pms', response_resource_type = 'room_type',
         response_resource_id = $1, response_body_hash = $2,
         completed_at = $3::timestamptz, last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms' AND operation = 'room_type_retire'
       AND key_hash = $5 AND tenant_scope = 'property' AND property_id = $6::uuid`,
    [
      command.roomTypeId,
      sha256(stableJson(metadata)),
      acceptedAt,
      JSON.stringify(metadata),
      keyHash,
      command.propertyId,
    ],
  );
}

async function enqueueInventoryChangedSideEffects(
  client: PmsOperationsCommandClient,
  command: Pick<PmsRoomBlockCommand | PmsRoomTypeCommand, "propertyId" | "commandId" | "audit">,
  resource: {
    roomTypeId: string;
    resourceType: "room_type" | "room_block";
    resourceId: string;
    dateRange: { from: string; to: string };
    calendarRefresh: boolean;
  },
  commandMeta: PmsCommandMeta,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  const inventoryChangedPayload = JSON.stringify({
    propertyId: command.propertyId,
    roomTypeId: resource.roomTypeId,
    dateRange: resource.dateRange,
    inventoryVersion: keyHash,
  });
  const domainEvent = await client.query<{ eventId: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events (
         source_system,
         event_key,
         event_type,
         event_version,
         occurred_at,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         causation_id,
         idempotency_key_hash,
         payload,
         event_metadata
       )
       VALUES (
         'pms',
         $1,
         'pms.inventory.changed',
         1,
         $2::timestamptz,
         'property',
         $3::uuid,
         'pms',
         $4,
         $5,
         $6,
         $7,
         $8,
         $9::jsonb,
         $10::jsonb
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id::text AS "eventId"
     )
     SELECT "eventId" FROM inserted
     UNION ALL
     SELECT id::text AS "eventId"
     FROM platform.domain_events
     WHERE source_system = 'pms'
       AND event_key = $1
     LIMIT 1`,
    [
      `pms.inventory.changed.${resource.resourceType}.property.${command.propertyId}.key.${keyHash}.v1`,
      acceptedAt,
      command.propertyId,
      resource.resourceType,
      resource.resourceId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      keyHash,
      inventoryChangedPayload,
      JSON.stringify({ commandMeta, contractVersion: PMS_OPERATIONS_CONTRACT_VERSION }),
    ],
  );

  await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id,
       outbox_key,
       destination,
       event_type,
       tenant_scope,
       property_id,
       resource_product,
       resource_type,
       resource_id,
       correlation_id,
       idempotency_key_hash,
       payload,
       outbox_metadata
     )
     VALUES (
       $1::uuid,
       $2,
       'pms.channel-manager',
       'pms.inventory.ari_changed',
       'property',
       $3::uuid,
       'pms',
       $4,
       $5,
       $6,
       $7,
       $8::jsonb,
       $9::jsonb
     )
     ON CONFLICT (destination, outbox_key) DO NOTHING`,
    [
      domainEvent.rows[0]!.eventId,
      `pms.ari_changed.${resource.resourceType}.property.${command.propertyId}.key.${keyHash}.v1`,
      command.propertyId,
      resource.resourceType,
      resource.resourceId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      inventoryChangedPayload,
      JSON.stringify({ sideEffects: commandMeta.sideEffects }),
    ],
  );

  await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id,
       outbox_key,
       destination,
       event_type,
       tenant_scope,
       property_id,
       resource_product,
       resource_type,
       resource_id,
       correlation_id,
       idempotency_key_hash,
       payload,
       outbox_metadata
     )
     VALUES (
       $1::uuid,
       $2,
       'distribution.public-bookability',
       'pms.inventory.changed',
       'property',
       $3::uuid,
       'pms',
       $4,
       $5,
       $6,
       $7,
       $8::jsonb,
       $9::jsonb
     )
     ON CONFLICT (destination, outbox_key) DO NOTHING`,
    [
      domainEvent.rows[0]!.eventId,
      `distribution.inventory_changed.${resource.resourceType}.property.${command.propertyId}.key.${keyHash}.v1`,
      command.propertyId,
      resource.resourceType,
      resource.resourceId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      inventoryChangedPayload,
      JSON.stringify({ sideEffects: commandMeta.sideEffects }),
    ],
  );

  if (resource.calendarRefresh) {
    await client.query(
      `INSERT INTO platform.outbox_events (
         domain_event_id, outbox_key, destination, event_type, tenant_scope,
         property_id, resource_product, resource_type, resource_id, correlation_id,
         idempotency_key_hash, payload, outbox_metadata
       ) VALUES (
         $1::uuid, $2, 'pms.calendar-projection', 'pms.calendar.refresh_requested',
         'property', $3::uuid, 'pms', $4, $5, $6, $7, $8::jsonb, $9::jsonb
       ) ON CONFLICT (destination, outbox_key) DO NOTHING`,
      [
        domainEvent.rows[0]!.eventId,
        `pms.calendar_refresh.${resource.resourceType}.property.${command.propertyId}.key.${keyHash}.v1`,
        command.propertyId,
        resource.resourceType,
        resource.resourceId,
        command.audit.correlationId ?? command.audit.requestId,
        keyHash,
        inventoryChangedPayload,
        JSON.stringify({ sideEffects: commandMeta.sideEffects }),
      ],
    );
  }
}

async function insertRoomTypeAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeCreateCommand,
  roomType: PmsRoomType,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       'pms.room_type.created',
       1,
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       $4,
       $5::uuid,
       'pms',
       'room_type',
       $6,
       $7,
       $8,
       $9::jsonb,
       $10::jsonb,
       $11::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.room_type.created.property.${command.propertyId}.room_type.${roomType.roomTypeId}.key.${keyHash}.v1`,
      commandMeta.acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      roomTypeActorUserId(command),
      roomType.roomTypeId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        roomTypeId: roomType.roomTypeId,
        roomCount: roomType.roomCount,
        baseRate: roomType.baseRate,
      }),
      JSON.stringify({
        name: roomType.name,
        description: roomType.description,
        category: roomType.category,
      }),
      JSON.stringify({ commandMeta, idempotencyKeyHash: keyHash }),
    ],
  );
}

async function insertRoomTypeLocationUpdateAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeUpdateCommand,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       'pms.room_type.updated',
       1,
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       $4,
       $5::uuid,
       'pms',
       'room_type',
       $6,
       $7,
       $8,
       $9::jsonb,
       $10::jsonb,
       $11::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.room_type.updated.property.${command.propertyId}.room_type.${command.roomTypeId}.key.${keyHash}.v1`,
      commandMeta.acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      roomTypeActorUserId(command),
      command.roomTypeId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        roomTypeId: command.roomTypeId,
        changedFields: [
          ...Object.keys(command.attributes),
          ...(command.flexibleCancellationPolicy ? ["flexibleCancellationPolicy"] : []),
        ],
      }),
      JSON.stringify({
        attributes: command.attributes,
        ...(command.flexibleCancellationPolicy
          ? { flexibleCancellationPolicy: command.flexibleCancellationPolicy }
          : {}),
      }),
      JSON.stringify({ commandMeta, idempotencyKeyHash: keyHash }),
    ],
  );
}

async function insertRoomTypeLifecycleAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsRoomTypeDuplicateCommand | PmsRoomTypeRetireCommand,
  action: "pms.room_type.duplicated" | "pms.room_type.retired",
  targetRoomTypeId: string,
  commandMeta: PmsCommandMeta,
  keyHash: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at, tenant_scope,
       organization_id, property_id, actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       correlation_id, causation_id, redacted_payload, private_payload,
       audit_metadata, retention_class, privacy_scope
     ) VALUES (
       $1, 'pms', $2, 1, $3::timestamptz, 'property', NULL, $4::uuid,
       $5, $6::uuid, 'pms', 'room_type', $7, $8, $9,
       $10::jsonb, '{}'::jsonb, $11::jsonb, 'standard', 'internal'
     ) ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `${action}.property.${command.propertyId}.room_type.${targetRoomTypeId}.key.${keyHash}.v1`,
      action,
      commandMeta.acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      roomTypeActorUserId(command),
      targetRoomTypeId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        roomTypeId: targetRoomTypeId,
        expectedVersion: command.expectedVersion,
        ...details,
      }),
      JSON.stringify({ commandMeta, idempotencyKeyHash: keyHash }),
    ],
  );
}

function roomTypeActorUserId(command: PmsRoomTypeCommand): string | null {
  return command.audit.actor.kind === "user" ? command.audit.actor.userId : null;
}

function roomTypeCommandFingerprint(command: PmsRoomTypeCommand): unknown {
  const { audit: _audit, ...fingerprint } = command;
  return fingerprint;
}

async function listCheckoutChargesForUpdate(
  client: PmsOperationsCommandClient,
  propertyId: string,
  guestBookingId: string,
  assignmentId?: string,
): Promise<PmsCheckoutCharge[]> {
  const result = await client.query<PmsCheckoutChargeRow>(
    checkoutChargeSelectSql(
      `WHERE charge.property_id = $1::uuid
         AND charge.guest_booking_id = $2::uuid
         AND ($3::uuid IS NULL OR charge.assignment_id IS NULL OR charge.assignment_id = $3::uuid)
       ORDER BY charge.created_at DESC, charge.id DESC
       FOR UPDATE OF charge`,
    ),
    [propertyId, guestBookingId, assignmentId ?? null],
  );
  return result.rows.map(toPmsCheckoutCharge);
}

async function checkoutChargeAssignmentBelongsToReservation(
  client: PmsOperationsCommandClient,
  command: PmsCheckoutChargeCreateCommand,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM pms.operational_booking_assignments assignment
     WHERE assignment.id = $1::uuid
       AND assignment.property_id = $2::uuid
       AND assignment.guest_booking_id = $3::uuid
     LIMIT 1`,
    [command.assignmentId, command.propertyId, command.guestBookingId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

async function findCheckoutChargeForUpdate(
  client: PmsOperationsCommandClient,
  command: PmsCheckoutChargeMarkPaidCommand | PmsCheckoutChargeWaiveCommand,
): Promise<PmsCheckoutCharge | null> {
  const result = await client.query<PmsCheckoutChargeRow>(
    checkoutChargeSelectSql(
      `WHERE charge.id = $1::uuid
         AND charge.property_id = $2::uuid
         AND charge.guest_booking_id = $3::uuid
       FOR UPDATE OF charge`,
    ),
    [command.chargeId, command.propertyId, command.guestBookingId],
  );
  return result.rows[0] ? toPmsCheckoutCharge(result.rows[0]) : null;
}

async function updateCheckoutChargeStatus(
  client: PmsOperationsCommandClient,
  command: PmsCheckoutChargeMarkPaidCommand | PmsCheckoutChargeWaiveCommand,
  status: Extract<PmsCheckoutChargeStatus, "paid" | "waived">,
  acceptedAt: string,
): Promise<PmsCheckoutCharge> {
  const result = await client.query<PmsCheckoutChargeRow>(
    `UPDATE pms.booking_checkout_charges charge
     SET status = $1,
         settled_at = CASE WHEN $1 = 'paid' THEN $5::timestamptz ELSE NULL END,
         waived_at = CASE WHEN $1 = 'waived' THEN $5::timestamptz ELSE NULL END
     WHERE charge.id = $2::uuid
       AND charge.property_id = $3::uuid
       AND charge.guest_booking_id = $4::uuid
     RETURNING
       id::text AS "chargeId",
       property_id::text AS "propertyId",
       guest_booking_id::text AS "guestBookingId",
       assignment_id::text AS "assignmentId",
       label,
       amount::text AS "amountDecimal",
       original_amount::text AS "originalAmountDecimal",
       currency,
       status,
       created_by_user_id::text AS "createdByUserId",
       created_at AS "createdAt",
       settled_at AS "settledAt",
       waived_at AS "waivedAt"`,
    [status, command.chargeId, command.propertyId, command.guestBookingId, acceptedAt],
  );
  return toPmsCheckoutCharge(result.rows[0]!);
}

function checkoutChargeSelectSql(whereClause: string): string {
  return `SELECT
            charge.id::text AS "chargeId",
            charge.property_id::text AS "propertyId",
            charge.guest_booking_id::text AS "guestBookingId",
            charge.assignment_id::text AS "assignmentId",
            charge.label,
            charge.amount::text AS "amountDecimal",
            charge.original_amount::text AS "originalAmountDecimal",
            charge.currency,
            charge.status,
            charge.created_by_user_id::text AS "createdByUserId",
            charge.created_at AS "createdAt",
            charge.settled_at AS "settledAt",
            charge.waived_at AS "waivedAt"
          FROM pms.booking_checkout_charges charge
          ${whereClause}`;
}

function toPmsCheckoutCharge(row: PmsCheckoutChargeRow): PmsCheckoutCharge {
  return {
    chargeId: row.chargeId,
    propertyId: row.propertyId,
    guestBookingId: row.guestBookingId,
    assignmentId: row.assignmentId,
    label: row.label,
    amount: { amountDecimal: row.amountDecimal, currency: row.currency },
    originalAmount: { amountDecimal: row.originalAmountDecimal, currency: row.currency },
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: toIsoOrNull(row.createdAt)!,
    settledAt: toIsoOrNull(row.settledAt),
    waivedAt: toIsoOrNull(row.waivedAt),
    operationalOwnership: {
      owner: "pms",
      financeSettlementOwner: "finance",
      providerSettlement: false,
    },
  };
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function checkoutChargeCommandMeta(
  command:
    | PmsCheckoutChargeCreateCommand
    | PmsCheckoutChargeMarkPaidCommand
    | PmsCheckoutChargeWaiveCommand,
  acceptedAt: string,
): PmsCommandMeta {
  return {
    contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects: ["audit_event"],
  };
}

function checkoutChargeActorUserId(
  command:
    | PmsCheckoutChargeCreateCommand
    | PmsCheckoutChargeMarkPaidCommand
    | PmsCheckoutChargeWaiveCommand,
): string | null {
  return command.audit.actor.kind === "user" ? command.audit.actor.userId : null;
}

function checkoutChargeCommandFingerprint(
  command:
    | PmsCheckoutChargeCreateCommand
    | PmsCheckoutChargeMarkPaidCommand
    | PmsCheckoutChargeWaiveCommand,
): unknown {
  const { audit: _audit, ...fingerprint } = command;
  return fingerprint;
}

async function findCheckoutChargeCommandReplay(
  client: PmsOperationsCommandClient,
  operation: PmsCheckoutChargeOperation,
  command:
    | PmsCheckoutChargeCreateCommand
    | PmsCheckoutChargeMarkPaidCommand
    | PmsCheckoutChargeWaiveCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsCheckoutChargeCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return checkoutChargeConflict(
      "Idempotency key was used with a different checkout charge command.",
    );
  }
  if (existing.status !== "completed") {
    return checkoutChargeConflict("Checkout charge command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const charge = existing.idempotencyMetadata?.["charge"];
  if (!isPmsCommandMeta(commandMeta) || !isPmsCheckoutCharge(charge)) {
    return checkoutChargeConflict("Checkout charge command replay metadata is unavailable.");
  }
  return { ok: true, charge, commandMeta, replayed: true };
}

async function recordCheckoutChargeCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: PmsCheckoutChargeOperation,
  command:
    | PmsCheckoutChargeCreateCommand
    | PmsCheckoutChargeMarkPaidCommand
    | PmsCheckoutChargeWaiveCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({
        commandId: command.commandId,
        audit: command.audit,
        financeSettlementOwner: "finance",
        providerSettlement: false,
      }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeCheckoutChargeCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: PmsCheckoutChargeOperation,
  command:
    | PmsCheckoutChargeCreateCommand
    | PmsCheckoutChargeMarkPaidCommand
    | PmsCheckoutChargeWaiveCommand,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  charge: PmsCheckoutCharge,
): Promise<void> {
  const idempotencyMetadata = { commandMeta, charge };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'booking_checkout_charge',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      charge.chargeId,
      sha256(stableJson(idempotencyMetadata)),
      acceptedAt,
      JSON.stringify(idempotencyMetadata),
      operation,
      keyHash,
      command.propertyId,
    ],
  );
}

async function insertCheckoutChargeAuditEvent(
  client: PmsOperationsCommandClient,
  action: "created" | "marked_paid" | "waived",
  command:
    | PmsCheckoutChargeCreateCommand
    | PmsCheckoutChargeMarkPaidCommand
    | PmsCheckoutChargeWaiveCommand,
  charge: PmsCheckoutCharge,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       secondary_resource_product,
       secondary_resource_type,
       secondary_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       $2,
       1,
       $3::timestamptz,
       'property',
       NULL,
       $4::uuid,
       $5,
       $6::uuid,
       'pms',
       'booking_checkout_charge',
       $7,
       'booking',
       'guest_booking',
       $8,
       $9,
       $10,
       $11::jsonb,
       $12::jsonb,
       $13::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.checkout_charge.${action}.property.${command.propertyId}.charge.${charge.chargeId}.key.${keyHash}.v1`,
      `pms.checkout_charge.${action}`,
      commandMeta.acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      checkoutChargeActorUserId(command),
      charge.chargeId,
      command.guestBookingId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        chargeId: charge.chargeId,
        status: charge.status,
        amount: charge.amount,
        financeSettlementOwner: "finance",
      }),
      JSON.stringify({
        label: charge.label,
        reason: "reason" in command ? command.reason : undefined,
      }),
      JSON.stringify({
        commandMeta,
        idempotencyKeyHash: keyHash,
        operationalOwner: "pms",
        financeSettlementOwner: "finance",
        providerSettlement: false,
        invoicePosting: false,
        payoutTrigger: false,
        reconciliation: false,
      }),
    ],
  );
}

async function hasExistingCheckOutRecord(
  client: PmsOperationsCommandClient,
  command: PmsCheckOutCommand,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
     FROM pms.booking_checkout_records
     WHERE property_id = $1::uuid
       AND guest_booking_id = $2::uuid
       AND ($3::uuid IS NULL OR assignment_id = $3::uuid)
     LIMIT 1
     FOR UPDATE`,
    [command.propertyId, command.guestBookingId, command.assignmentId ?? null],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

async function insertCheckOutRecord(
  client: PmsOperationsCommandClient,
  command: PmsCheckOutCommand,
  input: {
    acceptedAt: string;
    assignmentId: string | null;
    chargesSettled: PmsCheckoutCharge[];
    pendingFlags: string[];
    pendingChargeIds: string[];
    unsettledPaidChargeIds: string[];
  },
): Promise<PmsCheckOutRecord> {
  const result = await client.query<PmsCheckOutRecordRow>(
    `INSERT INTO pms.booking_checkout_records (
       property_id,
       guest_booking_id,
       assignment_id,
       completed_by_user_id,
       completed_at,
       inspection_results,
       charges_settled,
       pending_flags,
       checkout_notes
     )
     VALUES (
       $1::uuid,
       $2::uuid,
       $3::uuid,
       $4::uuid,
       $5::timestamptz,
       $6::jsonb,
       $7::jsonb,
       $8::jsonb,
       $9
     )
     RETURNING
       id::text AS "checkoutRecordId",
       property_id::text AS "propertyId",
       guest_booking_id::text AS "guestBookingId",
       assignment_id::text AS "assignmentId",
       completed_by_user_id::text AS "completedByUserId",
       completed_at AS "completedAt",
       inspection_results AS "inspectionResults",
       charges_settled AS "chargesSettled",
       pending_flags AS "pendingFlags",
       checkout_notes AS "checkoutNotes"`,
    [
      command.propertyId,
      command.guestBookingId,
      input.assignmentId,
      checkOutActorUserId(command),
      input.acceptedAt,
      JSON.stringify(command.inspectionResults),
      JSON.stringify(input.chargesSettled),
      JSON.stringify(input.pendingFlags),
      command.checkoutNotes ?? null,
    ],
  );
  return toPmsCheckOutRecord(result.rows[0]!, {
    pendingChargeIds: input.pendingChargeIds,
    unsettledPaidChargeIds: input.unsettledPaidChargeIds,
  });
}

function toPmsCheckOutRecord(
  row: PmsCheckOutRecordRow,
  financeHandoff: Pick<
    PmsCheckOutRecord["financeHandoff"],
    "pendingChargeIds" | "unsettledPaidChargeIds"
  >,
): PmsCheckOutRecord {
  return {
    checkoutRecordId: row.checkoutRecordId,
    propertyId: row.propertyId,
    guestBookingId: row.guestBookingId,
    assignmentId: row.assignmentId,
    completedByUserId: row.completedByUserId,
    completedAt: toIsoOrNull(row.completedAt)!,
    inspectionResults: Array.isArray(row.inspectionResults) ? row.inspectionResults : [],
    chargesSettled: toPmsCheckoutChargeArray(row.chargesSettled),
    pendingFlags: toStringArray(row.pendingFlags),
    checkoutNotes: row.checkoutNotes,
    financeHandoff: {
      financeSettlementOwner: "finance",
      providerSettlement: false,
      pendingChargeIds: financeHandoff.pendingChargeIds,
      unsettledPaidChargeIds: financeHandoff.unsettledPaidChargeIds,
    },
  };
}

function toPmsCheckoutChargeArray(value: unknown): PmsCheckoutCharge[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPmsCheckoutCharge);
}

function checkOutPendingFlags(
  command: PmsCheckOutCommand,
  pendingChargeIds: string[],
  unsettledPaidChargeIds: string[],
): string[] {
  const flags = new Set(command.pendingFlags);
  for (const flag of inspectionPendingFlags(command.inspectionResults)) flags.add(flag);
  if (pendingChargeIds.length > 0) flags.add("checkout_charges_unsettled");
  if (unsettledPaidChargeIds.length > 0) flags.add("finance_settlement_handoff_required");
  return [...flags].sort();
}

function inspectionPendingFlags(inspectionResults: unknown[]): string[] {
  return inspectionResults.flatMap((result) => {
    if (!result || typeof result !== "object") return [];
    const item = result as { stepId?: unknown; status?: unknown };
    if (typeof item.stepId !== "string" || !item.stepId.trim()) return [];
    if (item.status === "completed") return [];
    return [`inspection_${item.stepId.trim()}`];
  });
}

async function findCheckOutCommandReplay(
  config: TargetPmsOperationsCommandRepositoryConfig,
  client: PmsOperationsCommandClient,
  command: PmsCheckOutCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsCheckOutCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = 'checkout_command'
       AND key_hash = $1
       AND tenant_scope = 'property'
       AND property_id = $2::uuid
     FOR UPDATE`,
    [keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return checkOutConflict("Idempotency key was used with a different check-out command.");
  }
  if (existing.status !== "completed") {
    return checkOutConflict("Check-out command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const checkout = existing.idempotencyMetadata?.["checkout"];
  const charges = existing.idempotencyMetadata?.["charges"];
  if (!isPmsCommandMeta(commandMeta) || !isPmsCheckOutRecord(checkout) || !Array.isArray(charges)) {
    return checkOutConflict("Check-out command replay metadata is unavailable.");
  }
  return checkOutResultForCommand(
    config,
    command,
    commandMeta,
    checkout,
    charges.filter(isPmsCheckoutCharge),
    true,
  );
}

async function recordCheckOutCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsCheckOutCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       'checkout_command',
       $1,
       $2,
       'in_progress',
       'property',
       $3::uuid,
       $4,
       $5::timestamptz + interval '24 hours',
       $6::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({
        commandId: command.commandId,
        audit: command.audit,
        financeSettlementOwner: "finance",
        providerSettlement: false,
      }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeCheckOutCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsCheckOutCommand,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  checkout: PmsCheckOutRecord,
  charges: PmsCheckoutCharge[],
): Promise<void> {
  const idempotencyMetadata = { commandMeta, checkout, charges };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'booking_checkout_record',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = 'checkout_command'
       AND key_hash = $5
       AND tenant_scope = 'property'
       AND property_id = $6::uuid`,
    [
      checkout.checkoutRecordId,
      sha256(stableJson(idempotencyMetadata)),
      acceptedAt,
      JSON.stringify(idempotencyMetadata),
      keyHash,
      command.propertyId,
    ],
  );
}

async function insertCheckOutAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsCheckOutCommand,
  checkout: PmsCheckOutRecord,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       secondary_resource_product,
       secondary_resource_type,
       secondary_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       'pms.checkout.completed',
       1,
       $2::timestamptz,
       'property',
       NULL,
       $3::uuid,
       $4,
       $5::uuid,
       'pms',
       'booking_checkout_record',
       $6,
       'booking',
       'guest_booking',
       $7,
       $8,
       $9,
       $10::jsonb,
       $11::jsonb,
       $12::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.checkout.completed.property.${command.propertyId}.checkout.${checkout.checkoutRecordId}.key.${keyHash}.v1`,
      commandMeta.acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      checkOutActorUserId(command),
      checkout.checkoutRecordId,
      command.guestBookingId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        checkoutRecordId: checkout.checkoutRecordId,
        pendingFlags: checkout.pendingFlags,
        financeSettlementOwner: "finance",
      }),
      JSON.stringify({
        inspectionResults: checkout.inspectionResults,
        chargesSettled: checkout.chargesSettled,
        checkoutNotes: checkout.checkoutNotes,
      }),
      JSON.stringify({
        commandMeta,
        idempotencyKeyHash: keyHash,
        operationalOwner: "pms",
        financeSettlementOwner: "finance",
        providerSettlement: false,
        invoicePosting: false,
        payoutTrigger: false,
        reconciliation: false,
        financeHandoff: checkout.financeHandoff,
      }),
    ],
  );
}

async function checkOutResultForCommand(
  config: TargetPmsOperationsCommandRepositoryConfig,
  command: PmsCheckOutCommand,
  commandMeta: PmsCommandMeta,
  checkout: PmsCheckOutRecord,
  charges: PmsCheckoutCharge[],
  replayed: boolean,
): Promise<PmsCheckOutCommandResult> {
  const reservation = await config.readRepository.findReservationByGuestBookingId(
    command.propertyId,
    command.guestBookingId,
    true,
  );
  if (!reservation) return checkOutReservationNotFound(command.guestBookingId);
  return {
    ok: true,
    reservation: {
      ...reservation,
      checkout: {
        completedAt: checkout.completedAt,
        pendingFlags: checkout.pendingFlags,
      },
      assignments: reservation.assignments.map((assignment) =>
        !command.assignmentId || assignment.assignmentId === command.assignmentId
          ? { ...assignment, assignmentStatus: "checked_out" }
          : assignment,
      ),
    },
    checkout,
    charges,
    commandMeta,
    replayed,
  };
}

function checkOutActorUserId(command: PmsCheckOutCommand): string | null {
  return command.audit.actor.kind === "user" ? command.audit.actor.userId : null;
}

function checkOutCommandFingerprint(command: PmsCheckOutCommand): unknown {
  const { audit: _audit, ...fingerprint } = command;
  return fingerprint;
}

async function executeOperationalCommand<TCommand extends PmsOperationalCommand>(
  config: TargetPmsOperationsCommandRepositoryConfig,
  pool: PmsOperationsCommandPool,
  now: () => Date,
  options: {
    command: TCommand;
    operation: PmsOperationalCommandOperation;
    sideEffects: PmsOperationsCommandSideEffect[];
    mutate: (
      client: PmsOperationsCommandClient,
      command: TCommand,
      acceptedAt: string,
    ) => Promise<
      PmsOperationalMutationSuccess | Exclude<PmsOperationalCommandResult, { ok: true }>
    >;
  },
): Promise<PmsOperationalCommandResult> {
  const { command, operation, sideEffects, mutate } = options;
  const client = await pool.connect();
  const acceptedAt = now().toISOString();
  const keyHash = sha256(command.idempotencyKey);
  const requestFingerprintHash = sha256(stableJson(operationalCommandFingerprint(command)));
  let commandMeta: PmsCommandMeta = {
    contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects,
  };
  let roomTypeIds: string[] = [];
  const linkedInventoryMutation = [
    "no_show_command",
    "manual_cancellation_command",
    "manual_stay_correction_command",
  ].includes(operation);

  try {
    await client.query("BEGIN");

    const replay = await findOperationalCommandReplay(
      client,
      command,
      operation,
      keyHash,
      requestFingerprintHash,
    );
    if (replay) {
      if ("ok" in replay) {
        await client.query("ROLLBACK");
        return replay;
      }
      await client.query("COMMIT");
      return reservationResultForCommand(config, command, replay, true);
    }

    const insertedIdempotencyKey = await recordOperationalCommandIdempotency(
      client,
      command,
      operation,
      keyHash,
      requestFingerprintHash,
      acceptedAt,
    );
    if (!insertedIdempotencyKey) {
      const existing = await findOperationalCommandReplay(
        client,
        command,
        operation,
        keyHash,
        requestFingerprintHash,
      );
      if (existing) {
        await client.query("ROLLBACK");
        if ("ok" in existing) return existing;
        return reservationResultForCommand(config, command, existing, true);
      }
      await client.query("ROLLBACK");
      return operationalConflict(
        "idempotency_conflict",
        "Operational command idempotency key could not be reserved.",
      );
    }

    if (linkedInventoryMutation) {
      await lockPmsInventoryMutationScope(client, command.propertyId);
    }
    if (
      [
        "status_command",
        "checkin_command",
        "no_show_command",
        "manual_cancellation_command",
        "manual_stay_correction_command",
      ].includes(operation)
    ) {
      roomTypeIds = await lockOperationalCommandRoomScopes(client, command);
    }
    const mutation = await mutate(client, command, acceptedAt);
    if (!mutation.ok) {
      await client.query("ROLLBACK");
      return mutation;
    }
    if (mutation.sideEffects) {
      commandMeta = { ...commandMeta, sideEffects: mutation.sideEffects };
    }
    if (
      config.roomAssignmentOptimization &&
      (operation === "manual_cancellation_command" ||
        operation === "manual_stay_correction_command")
    ) {
      const optimization = await config.roomAssignmentOptimization.afterChange({
        transaction: client,
        command,
        roomTypeIds,
        reason: operation === "manual_cancellation_command" ? "cancel" : "modify",
        acceptedAt: new Date(acceptedAt),
      });
      commandMeta = {
        ...commandMeta,
        rearrangedBookingCount: new Set(
          optimization.flatMap(({ rearrangedGuestBookingIds }) => rearrangedGuestBookingIds),
        ).size,
      };
    }
    if (linkedInventoryMutation) {
      const linkedChanges = await reconcilePmsLinkedInventory(
        client,
        command.propertyId,
        acceptedAt,
      );
      await enqueuePmsLinkedInventorySideEffects(
        client,
        {
          propertyId: command.propertyId,
          operation,
          commandId: command.commandId,
          keyHash,
          acceptedAt,
          audit: command.audit,
        },
        linkedChanges,
      );
    }

    await recordOperationalCommandAuditEvent(client, command, operation, commandMeta, keyHash);
    await completeOperationalCommandIdempotency(
      client,
      command,
      operation,
      keyHash,
      commandMeta,
      acceptedAt,
    );
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    if (error instanceof PmsRoomScopeChangedError) {
      return operationalConflict(
        "version_conflict",
        "Reservation room scope changed. Retry the command.",
      );
    }
    if (isPgUniqueViolation(error)) {
      return operationalConflict(
        "idempotency_conflict",
        "Operational command conflicts with the current reservation state.",
      );
    }
    throw error;
  } finally {
    client.release();
  }

  return reservationResultForCommand(config, command, commandMeta, false);
}

async function reservationExists(
  client: PmsOperationsCommandClient,
  propertyId: string,
  guestBookingId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM booking.guest_bookings booking
     WHERE booking.property_id = $1::uuid
       AND booking.id = $2::uuid
     LIMIT 1`,
    [propertyId, guestBookingId],
  );
  return (result.rowCount ?? 0) > 0;
}

function toPmsPrivateNote(row: PmsPrivateNoteRow): PmsPrivateNote {
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  const editedAt =
    row.editedAt instanceof Date
      ? row.editedAt.toISOString()
      : row.editedAt
        ? String(row.editedAt)
        : null;
  return {
    noteId: row.noteId,
    body: row.body,
    authorUserId: row.authorUserId,
    authorDisplayName: row.authorDisplayName,
    createdAt,
    auditMetadata: {
      source: row.source,
      createdByUserId: row.authorUserId,
      createdByDisplayName: row.authorDisplayName,
      createdAt,
      editedByUserId: row.editedByUserId,
      editedByDisplayName: row.editedByDisplayName,
      editedAt,
      privacyScope: "internal",
    },
  };
}

async function readOperationalTemplate(
  client: PmsOperationsCommandClient,
  propertyId: string,
  templateKind: PmsOperationalTemplateKind,
): Promise<PmsOperationalTemplate> {
  const result = await client.query<PmsOperationalTemplateRow>(
    `SELECT
       property_id::text AS "propertyId",
       steps,
       updated_by_user_id::text AS "updatedByUserId",
       updated_at AS "updatedAt"
     FROM ${operationalTemplateTable(templateKind)}
     WHERE property_id = $1::uuid`,
    [propertyId],
  );
  const row = result.rows[0];
  return row
    ? toPmsOperationalTemplate(templateKind, row)
    : {
        propertyId,
        templateKind,
        steps: [],
        updatedByUserId: null,
        updatedAt: null,
      };
}

async function upsertOperationalTemplate(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  acceptedAt: string,
): Promise<PmsOperationalTemplate> {
  const result = await client.query<PmsOperationalTemplateRow>(
    `INSERT INTO ${operationalTemplateTable(command.templateKind)} (
       property_id,
       steps,
       updated_by_user_id,
       updated_at
     )
     VALUES ($1::uuid, $2::jsonb, $3::uuid, $4::timestamptz)
     ON CONFLICT (property_id) DO UPDATE
     SET steps = EXCLUDED.steps,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at
     RETURNING
       property_id::text AS "propertyId",
       steps,
       updated_by_user_id::text AS "updatedByUserId",
       updated_at AS "updatedAt"`,
    [command.propertyId, JSON.stringify(command.steps), command.actorUserId, acceptedAt],
  );
  return toPmsOperationalTemplate(command.templateKind, result.rows[0]!);
}

function operationalTemplateTable(templateKind: PmsOperationalTemplateKind): string {
  return templateKind === "check_in_checklist"
    ? "pms.checkin_checklist_templates"
    : "pms.checkout_inspection_templates";
}

function operationalTemplateOperation(
  templateKind: PmsOperationalTemplateKind,
): PmsOperationalTemplateOperation {
  return templateKind === "check_in_checklist"
    ? "checkin_checklist_template_update"
    : "checkout_inspection_template_update";
}

function toPmsOperationalTemplate(
  templateKind: PmsOperationalTemplateKind,
  row: PmsOperationalTemplateRow,
): PmsOperationalTemplate {
  const updatedAt =
    row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
  return {
    propertyId: row.propertyId,
    templateKind,
    steps: toPmsTemplateSteps(row.steps),
    updatedByUserId: row.updatedByUserId,
    updatedAt,
  };
}

function toPmsTemplateSteps(value: unknown): PmsTemplateStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PmsTemplateStep | null => {
      if (!item || typeof item !== "object") return null;
      const step = item as Partial<PmsTemplateStep>;
      if (typeof step.stepId !== "string" || typeof step.label !== "string") return null;
      return {
        stepId: step.stepId,
        label: step.label,
        required: step.required === true,
      };
    })
    .filter((step): step is PmsTemplateStep => step !== null);
}

async function insertOperationalTemplateAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  template: PmsOperationalTemplate,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       $2,
       1,
       $3::timestamptz,
       'property',
       $4::uuid,
       'user',
       $5::uuid,
       'pms',
       'operational_template',
       $6,
       $7,
       $8::jsonb,
       $9::jsonb,
       $10::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.${command.templateKind}.updated.property.${command.propertyId}.key.${keyHash}.v1`,
      `pms.${command.templateKind}.updated`,
      commandMeta.acceptedAt,
      command.propertyId,
      command.actorUserId,
      command.templateKind,
      command.commandId,
      JSON.stringify({
        propertyId: command.propertyId,
        templateKind: command.templateKind,
        stepCount: template.steps.length,
      }),
      JSON.stringify({ steps: template.steps }),
      JSON.stringify({
        commandMeta,
        idempotencyKeyHash: keyHash,
        targetOwner: operationalTemplateTable(command.templateKind),
      }),
    ],
  );
}

async function findOperationalTemplateCommandReplay(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  operation: PmsOperationalTemplateOperation,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsOperationalTemplateCommandResult | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return operationalTemplateConflict(
      "Idempotency key was used with a different operational template command.",
    );
  }
  if (existing.status !== "completed") {
    return operationalTemplateConflict("Operational template command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const template = existing.idempotencyMetadata?.["template"];
  if (!isPmsCommandMeta(commandMeta) || !isPmsOperationalTemplate(template)) {
    return operationalTemplateConflict(
      "Operational template command replay metadata is unavailable.",
    );
  }
  return { ok: true, template, commandMeta };
}

async function recordOperationalTemplateCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  operation: PmsOperationalTemplateOperation,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.commandId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId, templateKind: command.templateKind }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function completeOperationalTemplateCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalTemplateUpdateCommand,
  operation: PmsOperationalTemplateOperation,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  template: PmsOperationalTemplate,
): Promise<void> {
  const idempotencyMetadata = { commandMeta, template };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'operational_template',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      command.templateKind,
      sha256(stableJson(idempotencyMetadata)),
      acceptedAt,
      JSON.stringify(idempotencyMetadata),
      operation,
      keyHash,
      command.propertyId,
    ],
  );
}

async function findPrivateNoteCommandReplay(
  client: PmsOperationsCommandClient,
  operation: "private_note_create" | "private_note_update" | "private_note_delete",
  command: PmsPrivateNoteCreateCommand | PmsPrivateNoteUpdateCommand | PmsPrivateNoteDeleteCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<
  | ({ ok: true } & PmsPrivateNoteReplay)
  | Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }>
  | null
> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return privateNoteConflict("Idempotency key was used with a different private note command.");
  }
  if (existing.status !== "completed") {
    return privateNoteConflict("Private note command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  const noteId = existing.idempotencyMetadata?.["noteId"];
  const note = existing.idempotencyMetadata?.["note"];
  if (!isPmsCommandMeta(commandMeta) || typeof noteId !== "string") {
    return privateNoteConflict("Private note command replay metadata is unavailable.");
  }
  const replayNote = normalizePmsPrivateNote(note);
  return replayNote
    ? { ok: true, commandMeta, noteId, note: replayNote }
    : { ok: true, commandMeta, noteId };
}

async function recordPrivateNoteCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: "private_note_create" | "private_note_update" | "private_note_delete",
  command: PmsPrivateNoteCreateCommand | PmsPrivateNoteUpdateCommand | PmsPrivateNoteDeleteCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.commandId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertPrivateNoteAuditEvent(
  client: PmsOperationsCommandClient,
  input: {
    action: "pms.private_note.created" | "pms.private_note.edited" | "pms.private_note.deleted";
    auditKey: string;
    command:
      | PmsPrivateNoteCreateCommand
      | PmsPrivateNoteUpdateCommand
      | PmsPrivateNoteDeleteCommand;
    keyHash: string;
    noteId: string;
    occurredAt: string;
    privatePayload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       secondary_resource_product,
       secondary_resource_type,
       secondary_resource_id,
       correlation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'pms',
       $2,
       1,
       $3::timestamptz,
       'property',
       $4::uuid,
       'user',
       $5::uuid,
       'pms',
       'booking_note_private',
       $6,
       'booking',
       'guest_booking',
       $7,
       $8,
       $9::jsonb,
       $10::jsonb,
       $11::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      input.auditKey,
      input.action,
      input.occurredAt,
      input.command.propertyId,
      input.command.actorUserId,
      input.noteId,
      input.command.guestBookingId,
      input.command.commandId,
      JSON.stringify({
        propertyId: input.command.propertyId,
        guestBookingId: input.command.guestBookingId,
        noteId: input.noteId,
        bodyRedacted: true,
      }),
      JSON.stringify(input.privatePayload),
      JSON.stringify({
        contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
        idempotencyKeyHash: input.keyHash,
        visibility: "pms_private_only",
      }),
    ],
  );
}

async function completePrivateNoteCommandIdempotency(
  client: PmsOperationsCommandClient,
  operation: "private_note_create" | "private_note_update" | "private_note_delete",
  propertyId: string,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
  noteId: string,
  note?: PmsPrivateNote,
): Promise<void> {
  const idempotencyMetadata = note ? { commandMeta, noteId, note } : { commandMeta, noteId };
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'booking_note_private',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      noteId,
      sha256(stableJson(idempotencyMetadata)),
      acceptedAt,
      JSON.stringify(idempotencyMetadata),
      operation,
      keyHash,
      propertyId,
    ],
  );
}

function privateNoteAuditKey(
  action: "created" | "edited" | "deleted",
  propertyId: string,
  noteId: string,
  keyHash: string,
): string {
  return `pms.private_note.${action}.property.${propertyId}.note.${noteId}.key.${keyHash}.v1`;
}

async function findAssignmentCommandReplay(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsCommandMeta | Exclude<PmsAssignmentCommandResult, { ok: true }> | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = 'assignment_command'
       AND key_hash = $1
       AND tenant_scope = 'property'
       AND property_id = $2::uuid
     FOR UPDATE`,
    [keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return assignmentConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different assignment command.",
    );
  }
  if (existing.status !== "completed") {
    return assignmentConflict("idempotency_conflict", "Assignment command is already in progress.");
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  return isPmsCommandMeta(commandMeta) ? commandMeta : null;
}

async function findOperationalCommandReplay(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
  keyHash: string,
  requestFingerprintHash: string,
): Promise<PmsCommandMeta | Exclude<PmsOperationalCommandResult, { ok: true }> | null> {
  const result = await client.query<PmsIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       response_body_hash AS "responseBodyHash",
       response_status_code AS "responseStatusCode",
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [operation, keyHash, command.propertyId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== requestFingerprintHash) {
    return operationalConflict(
      "idempotency_conflict",
      "Idempotency key was used with a different PMS operational command.",
    );
  }
  if (existing.status !== "completed") {
    return operationalConflict(
      "idempotency_conflict",
      "PMS operational command is already in progress.",
    );
  }

  const commandMeta = existing.idempotencyMetadata?.["commandMeta"];
  return isOperationalReplayMeta(commandMeta, command) &&
    existing.responseStatusCode === 200 &&
    existing.responseBodyHash === sha256(stableJson(commandMeta))
    ? commandMeta
    : null;
}

async function recordAssignmentCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       'assignment_command',
       $1,
       $2,
       'in_progress',
       'property',
       $3::uuid,
       $4,
       $5::timestamptz + interval '24 hours',
       $6::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.commandId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function recordOperationalCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
  keyHash: string,
  requestFingerprintHash: string,
  acceptedAt: string,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       property_id,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'pms',
       $1,
       $2,
       $3,
       'in_progress',
       'property',
       $4::uuid,
       $5,
       $6::timestamptz + interval '24 hours',
       $7::jsonb
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      operation,
      keyHash,
      requestFingerprintHash,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      acceptedAt,
      JSON.stringify({ commandId: command.commandId, audit: command.audit }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function applyOperationalStatusCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsOperationalStatusCommand,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  const expectedVersion = command.expectedVersion;
  if (
    expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, expectedVersion))
  ) {
    return operationalConflict("version_conflict", "Reservation operational status is stale.");
  }
  const invalidSource = sources.find(
    (source) => !isAllowedOperationalStatusTransition(source, command.status),
  );
  if (invalidSource) {
    return invalidStatusTransition(invalidSource.assignmentStatus, command.status);
  }
  if (
    command.status !== "checked_out" &&
    !(await assignmentsHaveVerifiedOperationalIdentity(client, command.propertyId, sources))
  ) {
    return operationalIdentityRequired("status update");
  }

  await updateAssignmentsOperationalStatus(client, command, sources, command.status);
  return { ok: true };
}

async function applyBookingAcceptanceCommandMutation(
  config: TargetPmsOperationsCommandRepositoryConfig,
  client: PmsOperationsCommandClient,
  command: PmsBookingLifecycleCommand,
  acceptedAt: string,
): Promise<PmsOperationalMutationSuccess | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const booking = await loadBookingPaymentLifecycle(client, command);
  if (!booking) return reservationNotFound(command.guestBookingId);
  const acceptanceMode = jsonObject(booking.bookingMetadata)["acceptanceMode"];
  const isRequestPayAtProperty =
    acceptanceMode === "request" &&
    (booking.paymentMethod === "pay_at_property" || booking.paymentMethod === "cash") &&
    booking.lifecycleStatus === "pending_payment" &&
    booking.paymentStatus === "unpaid" &&
    !deadlinePassed(booking.pendingExpiresAt, acceptedAt);
  if (isRequestPayAtProperty) {
    return acceptRequestPayAtPropertyBooking(client, command, booking, acceptedAt);
  }
  const isRequestCard =
    acceptanceMode === "request" &&
    booking.paymentMethod === "card" &&
    booking.lifecycleStatus === "pending_payment" &&
    booking.paymentStatus === "authorized" &&
    !deadlinePassed(booking.pendingExpiresAt, acceptedAt);
  if (isRequestCard) {
    return captureAcceptedRequestCardBooking(config, client, command, booking, acceptedAt);
  }
  if (
    booking.lifecycleStatus !== "pending_payment" ||
    booking.paymentStatus !== "unpaid" ||
    booking.paymentMethod !== "bank_transfer" ||
    deadlinePassed(booking.pendingExpiresAt, acceptedAt)
  ) {
    return invalidStatusTransition(booking.lifecycleStatus, "confirmed");
  }
  const destination = await client.query(
    `SELECT binding.destination_id
    FROM finance.bank_transfer_bookings binding
    JOIN finance.bank_transfer_destinations destination ON destination.id=binding.destination_id
      AND destination.property_id=binding.property_id
    WHERE binding.guest_booking_id=$1::uuid AND binding.property_id=$2::uuid AND destination.deleted_at IS NULL
    FOR SHARE OF destination`,
    [command.guestBookingId, command.propertyId],
  );
  if (!destination.rows.length)
    return operationalConflict(
      "bank_transfer_unavailable",
      "Cannot accept this booking because its bank-transfer destination is unavailable.",
    );
  const paymentDeadlineAt = new Date(Date.parse(acceptedAt) + 24 * 60 * 60 * 1000).toISOString();

  const updated = await client.query(
    `WITH booking_update AS (
       UPDATE booking.guest_bookings booking
          SET lifecycle_status = 'confirmed',
              booking_metadata = booking.booking_metadata ||
                jsonb_build_object('acceptedPaymentDeadlineAt', $7::text),
              updated_at = $3::timestamptz
        WHERE booking.property_id = $1::uuid
          AND booking.id = $2::uuid
          AND booking.lifecycle_status = 'pending_payment'
          AND booking.payment_status = 'unpaid'
          AND ($8::timestamptz IS NULL OR $3::timestamptz < $8::timestamptz)
       RETURNING booking.id
     ),
     status_event AS (
       INSERT INTO booking.booking_status_events (
         guest_booking_id, event_type, from_status, to_status, actor_type,
         actor_user_id, public_visible, public_message, event_payload, occurred_at
       )
       SELECT
         booking_update.id, 'guest_booking.accepted', 'pending_payment', 'confirmed',
         $4, $5::uuid, TRUE, 'Booking accepted. Payment instructions sent.',
         $6::jsonb, $3::timestamptz
       FROM booking_update
     ),
     summary AS (
       UPDATE booking.direct_booking_summary_read_model summary
          SET lifecycle_status = 'confirmed',
              projected_at = $3::timestamptz
        WHERE summary.guest_booking_id = (SELECT id FROM booking_update)
     )
     SELECT id FROM booking_update`,
    [
      command.propertyId,
      command.guestBookingId,
      acceptedAt,
      command.audit.actor.kind === "user" ? "property_user" : "system",
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      JSON.stringify({
        commandId: command.commandId,
        requestId: command.audit.requestId,
        correlationId: command.audit.correlationId ?? command.audit.requestId,
        paymentMethod: "bank_transfer",
      }),
      paymentDeadlineAt,
      booking.pendingExpiresAt,
    ],
  );
  if ((updated.rowCount ?? updated.rows.length) === 0) {
    return invalidStatusTransition("pending_payment", "confirmed");
  }
  await captureDirectNightlyRevenueEvidence(client, booking, {
    fingerprint: command.idempotencyKey,
    required: booking.sourceSystem === "booking",
  });

  await enqueueBookingTransitionNotifications(client, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    occurredAt: acceptedAt,
    correlationId: command.audit.correlationId ?? command.audit.requestId,
    causationId: command.commandId,
    actor:
      command.audit.actor.kind === "user"
        ? { type: "user", userId: command.audit.actor.userId }
        : { type: "system" },
    source: "apps/api-pms-booking-acceptance",
    paymentDeadlineAt,
    transition: {
      eventType: "guest_booking.accepted",
      fromStatus: "pending_payment",
      toStatus: "confirmed",
    },
  });
  return { ok: true, sideEffects: ["guest_notification", "audit_event"] };
}

async function acceptRequestPayAtPropertyBooking(
  client: PmsOperationsCommandClient,
  command: PmsBookingLifecycleCommand,
  booking: BookingPaymentLifecycleRow,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const updated = await client.query(
    `WITH booking_update AS (
       UPDATE booking.guest_bookings booking
          SET lifecycle_status = 'confirmed', updated_at = $3::timestamptz
        WHERE booking.property_id = $1::uuid
          AND booking.id = $2::uuid
          AND booking.lifecycle_status = 'pending_payment'
          AND booking.payment_status = 'unpaid'
          AND booking.booking_metadata ->> 'acceptanceMode' = 'request'
       RETURNING booking.id
     ),
     status_event AS (
       INSERT INTO booking.booking_status_events (
         guest_booking_id, event_type, from_status, to_status, actor_type,
         actor_user_id, public_visible, public_message, event_payload, occurred_at
       )
       SELECT booking_update.id, 'guest_booking.accepted', 'pending_payment', 'confirmed',
         $4, $5::uuid, TRUE, 'Booking request accepted.', $6::jsonb, $3::timestamptz
       FROM booking_update
     ),
     summary AS (
       UPDATE booking.direct_booking_summary_read_model summary
          SET lifecycle_status = 'confirmed', projected_at = $3::timestamptz
        WHERE summary.guest_booking_id = (SELECT id FROM booking_update)
     )
     SELECT id FROM booking_update`,
    [
      command.propertyId,
      command.guestBookingId,
      acceptedAt,
      command.audit.actor.kind === "user" ? "property_user" : "system",
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      JSON.stringify({
        commandId: command.commandId,
        requestId: command.audit.requestId,
        correlationId: command.audit.correlationId ?? command.audit.requestId,
        paymentMethod: booking.paymentMethod,
      }),
    ],
  );
  if ((updated.rowCount ?? updated.rows.length) === 0) {
    return invalidStatusTransition("pending_payment/unpaid", "confirmed/unpaid");
  }
  await captureDirectNightlyRevenueEvidence(client, booking, {
    fingerprint: command.idempotencyKey,
    required: booking.sourceSystem === "booking",
  });
  return { ok: true };
}

async function captureAcceptedRequestCardBooking(
  config: TargetPmsOperationsCommandRepositoryConfig,
  client: PmsOperationsCommandClient,
  command: PmsBookingLifecycleCommand,
  booking: BookingPaymentLifecycleRow,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  if (
    !config.stripePaymentProvider ||
    !booking.providerPaymentIntentId ||
    !booking.providerAccountRef
  ) {
    return invalidStatusTransition("card_capture_unavailable", "confirmed/paid");
  }
  let intent = await config.stripePaymentProvider.retrievePaymentIntent(
    booking.providerPaymentIntentId,
    booking.chargeType === "direct" ? booking.providerAccountRef : null,
  );
  assertAcceptedRequestCardIntent(booking, intent);
  if (intent.status === "requires_capture") {
    intent = await config.stripePaymentProvider.capturePaymentIntent(
      booking.providerPaymentIntentId,
      booking.chargeType === "direct" ? booking.providerAccountRef : null,
      `pms-booking-capture:${command.propertyId}:${command.guestBookingId}:${sha256(command.idempotencyKey)}`,
    );
    assertAcceptedRequestCardIntent(booking, intent);
  }
  if (intent.status !== "succeeded") {
    return invalidStatusTransition(`card/${intent.status}`, "confirmed/paid");
  }
  const settlement = await settleStripeBookingPayment(client, {
    paymentIntentId: intent.paymentIntentId,
    providerAccountRef: intent.providerAccountRef,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    occurredAt: new Date(acceptedAt),
    correlationId: command.audit.correlationId ?? command.audit.requestId,
  });
  if (settlement === "not_found") {
    return invalidStatusTransition("card_payment_not_found", "confirmed/paid");
  }
  await client.query(
    `INSERT INTO booking.booking_status_events (
       guest_booking_id, event_type, from_status, to_status, actor_type,
       actor_user_id, public_visible, public_message, event_payload, occurred_at
     )
     SELECT
       $1::uuid, 'guest_booking.accepted', 'pending_payment', 'confirmed',
       $3, $4::uuid, TRUE, 'Booking request accepted.', $5::jsonb, $2::timestamptz
     WHERE NOT EXISTS (
       SELECT 1
       FROM booking.booking_status_events event
       WHERE event.guest_booking_id = $1::uuid
         AND event.event_type IN (
           'guest_booking.accepted', 'booking.accepted', 'booking_accepted'
         )
     )`,
    [
      command.guestBookingId,
      acceptedAt,
      command.audit.actor.kind === "user" ? "property_user" : "system",
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      JSON.stringify({
        commandId: command.commandId,
        requestId: command.audit.requestId,
        correlationId: command.audit.correlationId ?? command.audit.requestId,
        paymentMethod: "card",
      }),
    ],
  );
  await reconcileStripeBookingPaymentProviderDetails(client, intent, new Date(acceptedAt));
  return { ok: true };
}

function assertAcceptedRequestCardIntent(
  booking: BookingPaymentLifecycleRow,
  intent: StripeBookingPaymentIntent,
): void {
  if (
    !["requires_capture", "succeeded"].includes(intent.status) ||
    intent.paymentIntentId !== booking.providerPaymentIntentId ||
    intent.amountMinor !== stripeAmountMinor(booking.totalAmount, booking.currency) ||
    intent.currency !== booking.currency ||
    intent.propertyId !== booking.propertyId ||
    intent.bookingReference !== booking.publicReference ||
    intent.providerAccountRef !== booking.providerAccountRef
  ) {
    throw new Error("Stripe PaymentIntent did not match the accepted booking request.");
  }
}

async function applyBookingMarkPaidCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsBookingLifecycleCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const booking = await loadBookingPaymentLifecycle(client, command);
  if (!booking) return reservationNotFound(command.guestBookingId);
  const isPayPalPending =
    booking.paymentMethod === "paypal" && booking.lifecycleStatus === "pending_payment";
  const isAcceptedBankTransfer =
    booking.paymentMethod === "bank_transfer" && booking.lifecycleStatus === "confirmed";
  const isPayAtProperty =
    booking.paymentMethod === "pay_at_property" && booking.lifecycleStatus === "confirmed";
  const paymentDeadline = isPayPalPending
    ? booking.pendingExpiresAt
    : isAcceptedBankTransfer
      ? booking.acceptedPaymentDeadlineAt
      : null;
  if (
    booking.paymentStatus !== "unpaid" ||
    (!isPayPalPending && !isAcceptedBankTransfer && !isPayAtProperty) ||
    deadlinePassed(paymentDeadline, acceptedAt)
  ) {
    return invalidStatusTransition(
      `${booking.lifecycleStatus}/${booking.paymentStatus}`,
      "confirmed/paid",
    );
  }

  const paymentMethod = isPayPalPending
    ? "paypal"
    : isAcceptedBankTransfer
      ? "bank_transfer"
      : "pay_at_property";
  const financeCommand: FinanceBookingManualPaymentSettlementCommand = {
    commandId: command.commandId,
    idempotencyKey: `pms.booking.mark-paid.finance:${command.idempotencyKey}`,
    propertyId: command.propertyId,
    audit: command.audit,
    payload: {
      invoiceId: booking.invoiceId,
      amount: booking.balanceAmount,
      currency: booking.currency,
      paymentMethod,
      reference: `PMS ${paymentMethod} confirmation`,
    },
  };
  const financeResult = await recordBookingManualPaymentInClient(client, financeCommand);
  if (!financeResult.ok) {
    throw new Error(
      `Finance rejected PMS booking payment ${command.guestBookingId}: ${financeResult.code}`,
    );
  }

  const updated = await client.query(
    `WITH booking_update AS (
       UPDATE booking.guest_bookings booking
          SET lifecycle_status = 'confirmed',
              payment_status = 'paid',
              balance_amount = 0,
              updated_at = $3::timestamptz
        WHERE booking.property_id = $1::uuid
          AND booking.id = $2::uuid
          AND booking.lifecycle_status = $4
          AND booking.payment_status = 'unpaid'
          AND ($8::timestamptz IS NULL OR $3::timestamptz < $8::timestamptz)
       RETURNING booking.id
     ),
     status_event AS (
       INSERT INTO booking.booking_status_events (
         guest_booking_id, event_type, from_status, to_status, actor_type,
         actor_user_id, public_visible, public_message, event_payload, occurred_at
       )
       SELECT
         booking_update.id, 'guest_booking.payment_received', $4, 'confirmed',
         $5, $6::uuid, TRUE, 'Payment received. Booking confirmed.',
         $7::jsonb, $3::timestamptz
       FROM booking_update
     ),
     automatic_acceptance_event AS (
       INSERT INTO booking.booking_status_events (
         guest_booking_id, event_type, from_status, to_status, actor_type,
         actor_user_id, public_visible, public_message, event_payload, occurred_at
       )
       SELECT
         booking_update.id, 'guest_booking.accepted', $4, 'confirmed',
         'system', NULL, TRUE, 'Booking automatically accepted.',
         $7::jsonb || jsonb_build_object('acceptanceMode', 'instant'), $3::timestamptz
       FROM booking_update
       WHERE $9::boolean
         AND NOT EXISTS (
           SELECT 1
           FROM booking.booking_status_events event
           WHERE event.guest_booking_id = booking_update.id
             AND event.event_type IN (
               'guest_booking.accepted', 'booking.accepted', 'booking_accepted'
             )
         )
     ),
     summary AS (
       UPDATE booking.direct_booking_summary_read_model summary
          SET lifecycle_status = 'confirmed',
              payment_status = 'paid',
              amount_summary = jsonb_set(summary.amount_summary, '{balanceAmount}', '0'::jsonb),
              projected_at = $3::timestamptz
        WHERE summary.guest_booking_id = (SELECT id FROM booking_update)
     )
     SELECT id FROM booking_update`,
    [
      command.propertyId,
      command.guestBookingId,
      acceptedAt,
      booking.lifecycleStatus,
      command.audit.actor.kind === "user" ? "property_user" : "system",
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      JSON.stringify({
        commandId: command.commandId,
        requestId: command.audit.requestId,
        correlationId: command.audit.correlationId ?? command.audit.requestId,
        paymentMethod: booking.paymentMethod,
        fromPaymentStatus: "unpaid",
        toPaymentStatus: "paid",
      }),
      paymentDeadline,
      jsonObject(booking.bookingMetadata)["acceptanceMode"] === "instant",
    ],
  );
  if ((updated.rowCount ?? updated.rows.length) === 0) {
    return invalidStatusTransition(booking.lifecycleStatus, "confirmed/paid");
  }
  if (isPayPalPending)
    await captureDirectNightlyRevenueEvidence(client, booking, {
      fingerprint: command.idempotencyKey,
      required: booking.sourceSystem === "booking",
    });

  await enqueueBookingTransitionNotifications(client, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    occurredAt: acceptedAt,
    correlationId: command.audit.correlationId ?? command.audit.requestId,
    causationId: command.commandId,
    actor:
      command.audit.actor.kind === "user"
        ? { type: "user", userId: command.audit.actor.userId }
        : { type: "system" },
    source: "apps/api-pms-booking-payment",
    transition: {
      eventType: "guest_booking.payment_received",
      fromStatus: booking.lifecycleStatus,
      toStatus: "confirmed",
    },
  });
  return { ok: true };
}

async function loadBookingPaymentLifecycle(
  client: PmsOperationsCommandClient,
  command: PmsBookingLifecycleCommand,
): Promise<BookingPaymentLifecycleRow | null> {
  const result = await client.query<BookingPaymentLifecycleRow>(
    `SELECT
       booking.id::text AS "guestBookingId",
       booking.property_id::text AS "propertyId",
       booking.public_reference AS "publicReference",
       COALESCE(booking.booking_metadata ->> 'invoiceId', booking.id::text) AS "invoiceId",
       booking.lifecycle_status AS "lifecycleStatus",
       booking.payment_status AS "paymentStatus",
       booking.booking_metadata ->> 'paymentMethod' AS "paymentMethod",
       booking.check_in::text AS "checkIn",
       booking.check_out::text AS "checkOut",
       booking.total_amount::text AS "totalAmount",
       booking.balance_amount::text AS "balanceAmount",
       booking.currency,
       booking.source_system AS "sourceSystem",
       booking.booking_metadata AS "bookingMetadata",
       payment.accepted_methods AS "acceptedMethods",
       payment.deposit_policy AS "depositPolicy",
       booking.booking_metadata -> 'paymentInstructions' AS "paymentInstructions",
       COALESCE(
         booking.booking_metadata ->> 'hostResponseDeadlineAt',
         booking.booking_metadata ->> 'pendingExpiresAt'
       ) AS "pendingExpiresAt",
       booking.booking_metadata ->> 'acceptedPaymentDeadlineAt' AS "acceptedPaymentDeadlineAt",
       card_payment.provider_payment_intent_id AS "providerPaymentIntentId",
       card_payment.provider_account_ref AS "providerAccountRef",
       card_payment.charge_type AS "chargeType"
     FROM booking.guest_bookings booking
     LEFT JOIN finance.payment_settings payment ON payment.property_id = booking.property_id
     LEFT JOIN LATERAL (
       SELECT card.provider_payment_intent_id,
              account.provider_account_id AS provider_account_ref,
              card.payment_metadata ->> 'chargeType' AS charge_type
       FROM finance.payments card
       JOIN finance.payment_provider_accounts account
         ON account.id = card.provider_account_id
        AND account.property_id = card.property_id
       WHERE card.property_id = booking.property_id
         AND card.guest_booking_id = booking.id
         AND card.payment_method = 'card'
         AND card.provider_payment_intent_id IS NOT NULL
       ORDER BY card.created_at DESC, card.id DESC
       LIMIT 1
     ) card_payment ON TRUE
     WHERE booking.property_id = $1::uuid
       AND booking.id = $2::uuid
     FOR UPDATE OF booking`,
    [command.propertyId, command.guestBookingId],
  );
  return result.rows[0] ?? null;
}

function deadlinePassed(deadline: string | null, commandTime: string): boolean {
  if (!deadline) return false;
  const deadlineTime = Date.parse(deadline);
  const acceptedTime = Date.parse(commandTime);
  return (
    Number.isFinite(deadlineTime) && Number.isFinite(acceptedTime) && acceptedTime >= deadlineTime
  );
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function applyCheckInCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsCheckInCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  const expectedVersion = command.expectedVersion;
  if (
    expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, expectedVersion))
  ) {
    return operationalConflict("version_conflict", "Reservation check-in version is stale.");
  }
  const invalidSource = sources.find(
    (source) => !isAllowedOperationalStatusTransition(source, "checked_in"),
  );
  if (invalidSource) {
    return invalidStatusTransition(invalidSource.assignmentStatus, "checked_in");
  }
  if (!(await assignmentsHaveVerifiedOperationalIdentity(client, command.propertyId, sources))) {
    return operationalIdentityRequired("check-in");
  }
  if (await hasExistingCheckInRecord(client, command)) {
    return invalidStatusTransition("checked_in", "checked_in");
  }

  await client.query(
    `INSERT INTO pms.booking_checkin_records (
       property_id,
       guest_booking_id,
       assignment_id,
       completed_by_user_id,
       completed_at,
       step_results,
       pending_flags
     )
     SELECT $1::uuid, $2::uuid, source.assignment_id, $3::uuid, $4::timestamptz, $5::jsonb, $6::jsonb
     FROM unnest($7::uuid[]) AS source(assignment_id)`,
    [
      command.propertyId,
      command.guestBookingId,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      acceptedAt,
      JSON.stringify(command.stepResults),
      JSON.stringify(command.pendingFlags),
      sources.map((source) => source.assignmentId),
    ],
  );
  await updateAssignmentsOperationalStatus(client, command, sources, "checked_in");
  return { ok: true };
}

async function applyNoShowCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsNoShowCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  const expectedVersion = command.expectedVersion;
  if (
    expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, expectedVersion))
  ) {
    return operationalConflict("version_conflict", "Reservation no-show version is stale.");
  }
  const invalidSource = sources.find((source) => !isAllowedNoShowTransition(source));
  if (invalidSource) {
    return invalidStatusTransition(invalidSource.assignmentStatus, "no_show");
  }

  const nextVersion = nextAssignmentVersion(sources[0]!);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET room_id = NULL,
         assignment_status = 'released',
         assigned_at = NULL,
         assignment_payload = jsonb_set(
           jsonb_set(
             jsonb_set(
               COALESCE(assignment_payload, '{}'::jsonb),
               '{version}',
               to_jsonb($4::text),
               true
             ),
             '{operationalStatus}',
             to_jsonb('no_show'::text),
             true
           ),
           '{noShowReason}',
           to_jsonb($5::text),
           true
         ),
         updated_at = now()
     WHERE id = ANY($1::uuid[])
       AND property_id = $2::uuid
       AND guest_booking_id = $3::uuid`,
    [
      sources.map((source) => source.assignmentId),
      command.propertyId,
      command.guestBookingId,
      nextVersion,
      command.reason ?? "",
    ],
  );
  await appendPmsManualNoShowNightlyRevenueEvidence(client, command, acceptedAt);
  await reconcilePmsOccupiedInventory(client, command.propertyId, sources, acceptedAt);
  return { ok: true };
}

async function applyManualCancellationCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsManualCancellationCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  if (
    command.expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, command.expectedVersion!))
  )
    return operationalConflict("version_conflict", "Reservation cancellation version is stale.");
  const invalid = sources.find(
    ({ assignmentStatus }) => !["pending", "assigned"].includes(assignmentStatus),
  );
  if (invalid) return invalidStatusTransition(invalid.assignmentStatus, "canceled");

  const nextVersion = nextAssignmentVersion(sources[0]!);
  await client.query(
    `UPDATE pms.operational_booking_assignments SET room_id=NULL,assignment_status='canceled',
       assigned_at=NULL,assignment_payload=jsonb_set(jsonb_set(COALESCE(assignment_payload,'{}'),
       '{version}',to_jsonb($4::text),true),'{operationalStatus}',to_jsonb('canceled'::text),true),
       updated_at=$5::timestamptz
     WHERE id=ANY($1::uuid[]) AND property_id=$2::uuid AND guest_booking_id=$3::uuid`,
    [
      sources.map(({ assignmentId }) => assignmentId),
      command.propertyId,
      command.guestBookingId,
      nextVersion,
      acceptedAt,
    ],
  );
  try {
    await cancelPmsManualBooking(client, command, acceptedAt);
  } catch (error) {
    if (error instanceof ManualCancellationEvidenceError)
      return operationalInvalidBody(error.message);
    if (error instanceof ManualCancellationStateError)
      return invalidStatusTransition(error.currentStatus, "canceled");
    throw error;
  }
  await reconcilePmsOccupiedInventory(client, command.propertyId, sources, acceptedAt);
  return { ok: true };
}

async function applyManualRefundCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsManualRefundCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  if (
    command.expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, command.expectedVersion!))
  )
    return operationalConflict("version_conflict", "Reservation refund version is stale.");
  try {
    const financeTransaction = await financeManualBookingRefundTransaction(client);
    await refundPmsManualBooking(
      client,
      command,
      acceptedAt,
      createFinanceManualBookingRefundPort(),
      financeTransaction,
    );
  } catch (error) {
    if (error instanceof ManualRefundEvidenceError) return operationalInvalidBody(error.message);
    if (error instanceof ManualRefundStateError)
      return invalidStatusTransition(error.currentStatus, "refunded");
    throw error;
  }
  return { ok: true };
}

async function applyManualStayCorrectionCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsManualStayCorrectionCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  if (
    command.expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, command.expectedVersion!))
  )
    return operationalConflict("version_conflict", "Reservation stay-correction version is stale.");
  try {
    await correctPmsManualStays(client, command, acceptedAt, nextAssignmentVersion(sources[0]!));
  } catch (error) {
    if (error instanceof ManualStayCorrectionAvailabilityError)
      return operationalConflict("room_unavailable", error.message);
    if (
      error instanceof ManualStayCorrectionScopeError ||
      error instanceof ManualStayCorrectionEvidenceError
    )
      return operationalInvalidBody(error.message);
    if (error instanceof ManualStayCorrectionStateError)
      return invalidStatusTransition(error.currentStatus, "corrected");
    throw error;
  }
  return { ok: true };
}

async function applyManualPriceCorrectionCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsManualPriceCorrectionCommand,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsOperationalCommandResult, { ok: true }>> {
  const sources = await findAssignmentsForOperationalCommand(client, command);
  if (sources.length === 0) return reservationNotFound(command.guestBookingId);
  if (
    command.expectedVersion &&
    sources.some((source) => !assignmentVersionMatches(source, command.expectedVersion!))
  )
    return operationalConflict(
      "version_conflict",
      "Reservation price-correction version is stale.",
    );
  if (
    sources.some(
      ({ source, stayEvidenceKind }) => source !== "manual" || stayEvidenceKind !== "exact",
    )
  )
    return operationalInvalidBody("Manual price correction assignment scope is unavailable");
  try {
    await correctBookingPmsManualPrices(client, command, acceptedAt);
  } catch (error) {
    if (error instanceof ManualPriceCorrectionEvidenceError)
      return operationalInvalidBody(error.message);
    if (error instanceof ManualPriceCorrectionStateError)
      return invalidStatusTransition(error.currentStatus, "corrected");
    throw error;
  }
  return { ok: true };
}

async function applyAssignmentCommandMutation(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  acceptedAt: string,
): Promise<
  | { ok: true; inventoryTransfer?: AssignmentInventoryTransfer }
  | Exclude<PmsAssignmentCommandResult, { ok: true }>
> {
  const roomTypeId = await findAssignmentRoomTypeForCommand(client, command);
  if (!roomTypeId) return reservationNotFound(command.guestBookingId);
  const requestedMoveRoom =
    command.action === "move" && command.roomId
      ? await findAvailableRoomForAssignment(client, command.propertyId, command.roomId)
      : null;
  for (const lockRoomTypeId of [...new Set([roomTypeId, requestedMoveRoom?.roomTypeId])]
    .filter((value): value is string => value !== undefined)
    .sort()) {
    await lockRoomTypeRoomsForAssignment(client, command.propertyId, lockRoomTypeId);
  }
  const source = await findAssignmentForCommand(client, command);
  if (!source || source.roomTypeId !== roomTypeId) {
    return assignmentConflict("assignment_conflict", "Reservation assignment changed.");
  }

  if (command.expectedVersion && !assignmentVersionMatches(source, command.expectedVersion)) {
    return assignmentConflict("version_conflict", "Reservation assignment version is stale.");
  }

  if (command.action === "swap") {
    return applySwapAssignmentCommand(client, command, source);
  }

  if (command.action === "unassign") {
    const nextVersion = nextAssignmentVersion(source);
    await client.query(
      `UPDATE pms.operational_booking_assignments
       SET room_id = NULL,
           assignment_status = 'pending',
           assigned_at = NULL,
           assignment_payload = jsonb_set(
             COALESCE(assignment_payload, '{}'::jsonb),
             '{version}',
             to_jsonb($4::text),
             true
           ),
           updated_at = now()
       WHERE id = $1::uuid
         AND property_id = $2::uuid
         AND guest_booking_id = $3::uuid`,
      [source.assignmentId, command.propertyId, command.guestBookingId, nextVersion],
    );
    return { ok: true };
  }

  if (!command.roomId) {
    return assignmentConflict("room_unavailable", "Requested room is unavailable for this stay.");
  }

  const room = await findAvailableRoomForAssignment(client, command.propertyId, command.roomId);
  if (!room || (command.action === "assign" && room.roomTypeId !== source.roomTypeId)) {
    return assignmentConflict("room_unavailable", "Requested room is unavailable for this stay.");
  }
  if (command.action === "move" && room.roomTypeId !== requestedMoveRoom?.roomTypeId) {
    return assignmentConflict("assignment_conflict", "Requested room type changed.");
  }

  if (!(await isRoomAvailableForStay(client, command, source, room.roomTypeId))) {
    return assignmentConflict("room_unavailable", "Requested room is unavailable for this stay.");
  }

  if (
    command.action === "move" &&
    command.ratePolicy === "target_base" &&
    room.roomTypeId !== source.roomTypeId
  ) {
    const rateChange = await applyTargetBaseRateForMove(
      client,
      command,
      source,
      room.roomTypeId,
      acceptedAt,
    );
    if (!rateChange.ok) return rateChange;
  }

  const nextVersion = nextAssignmentVersion(source);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET room_id = $1::uuid,
         room_type_id = $6::uuid,
         rate_plan_id = CASE WHEN room_type_id = $6::uuid THEN rate_plan_id ELSE NULL END,
         assignment_status = CASE
           WHEN assignment_status IN ('checked_in', 'in_house') THEN assignment_status
           ELSE 'assigned'
         END,
         assigned_at = COALESCE(assigned_at, now()),
         assignment_payload = jsonb_set(
           COALESCE(assignment_payload, '{}'::jsonb),
           '{version}',
           to_jsonb($5::text),
           true
         ),
         updated_at = now()
     WHERE id = $2::uuid
       AND property_id = $3::uuid
       AND guest_booking_id = $4::uuid`,
    [
      command.roomId,
      source.assignmentId,
      command.propertyId,
      command.guestBookingId,
      nextVersion,
      room.roomTypeId,
    ],
  );
  return {
    ok: true,
    ...(room.roomTypeId === source.roomTypeId
      ? {}
      : {
          inventoryTransfer: {
            sourceRoomTypeId: source.roomTypeId,
            targetRoomTypeId: room.roomTypeId,
            checkIn: source.checkIn,
            checkOut: source.checkOut,
          },
        }),
  };
}

type MoveRateScope = {
  evidenceIds: string[] | null;
  evidenceCount: number;
  nightCount: number;
  targetTotal: string | null;
  currency: string | null;
  timezone: string | null;
};

async function applyTargetBaseRateForMove(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  source: PmsAssignmentRow,
  targetRoomTypeId: string,
  acceptedAt: string,
): Promise<{ ok: true } | Exclude<PmsAssignmentCommandResult, { ok: true }>> {
  const result = await client.query<MoveRateScope>(
    `WITH evidence_state AS (
       SELECT id,stay_date,line_position,
         SUM(gross_room_amount) OVER scope AS amount,
         row_number() OVER (scope ORDER BY source_revision DESC,created_at DESC,id DESC) AS tip
       FROM booking.nightly_revenue_evidence
       WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid
         AND economic_event<>'retained_charge'
       WINDOW scope AS (PARTITION BY stay_date,line_position)
     ), tips AS (
       SELECT id,stay_date,amount FROM evidence_state WHERE tip=1 AND line_position=$6::int
         AND stay_date >= $4::date AND stay_date < $5::date
     )
     SELECT array_agg(tips.id::text ORDER BY tips.stay_date)
         FILTER (WHERE tips.id IS NOT NULL) AS "evidenceIds",
       COUNT(tips.id)::int AS "evidenceCount",($5::date-$4::date)::int AS "nightCount",
       (target.base_rate_amount * ($5::date-$4::date))::text AS "targetTotal",
       target.currency,location.timezone
     FROM pms.room_types target
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id=target.property_id
     LEFT JOIN tips ON TRUE
     WHERE target.property_id=$1::uuid AND target.id=$3::uuid
     GROUP BY target.base_rate_amount,target.currency,location.timezone`,
    [
      command.propertyId,
      command.guestBookingId,
      targetRoomTypeId,
      source.checkIn,
      source.checkOut,
      source.position,
    ],
  );
  const scope = result.rows[0];
  if (
    !scope?.timezone ||
    !scope.targetTotal ||
    !scope.currency ||
    !scope.evidenceIds?.length ||
    scope.evidenceCount !== scope.nightCount
  )
    return assignmentConflict(
      "assignment_conflict",
      "Target rate requires exact manual price evidence.",
    );
  try {
    await correctBookingPmsManualPrices(
      client,
      {
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        idempotencyKey: `${command.idempotencyKey}:target-base`,
        accountingDate: [propertyDate(acceptedAt, scope.timezone), previousDate(source.checkOut)]
          .sort()
          .at(-1)!,
        pricing: {
          kind: "equal_inferred",
          targetEvidenceIds: scope.evidenceIds,
          replacementTotal: { amountDecimal: scope.targetTotal, currency: scope.currency },
        },
      },
      acceptedAt,
      { allowNoChange: true, requirePricedTargets: true },
    );
  } catch (error) {
    if (
      error instanceof ManualPriceCorrectionEvidenceError ||
      error instanceof ManualPriceCorrectionStateError
    )
      return assignmentConflict("assignment_conflict", error.message);
    throw error;
  }
  return { ok: true };
}

const previousDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

type AssignmentInventoryTransfer = {
  sourceRoomTypeId: string;
  targetRoomTypeId: string;
  checkIn: string;
  checkOut: string;
};

async function applySwapAssignmentCommand(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  source: PmsAssignmentRow,
): Promise<{ ok: true } | Exclude<PmsAssignmentCommandResult, { ok: true }>> {
  const target = await findTargetAssignmentForSwap(client, command);
  if (!target || target.assignmentId === source.assignmentId) {
    return assignmentConflict(
      "assignment_conflict",
      "Target assignment does not belong to this reservation.",
    );
  }
  if (target.roomTypeId !== source.roomTypeId) {
    return assignmentConflict(
      "assignment_conflict",
      "Target assignment room type is incompatible.",
    );
  }
  if (
    !(await roomIdsHaveVerifiedOperationalIdentity(
      client,
      command.propertyId,
      [source.roomId, target.roomId].filter((roomId): roomId is string => roomId !== null),
    ))
  ) {
    return assignmentConflict(
      "room_unavailable",
      "Assigned rooms require verified operational labels.",
    );
  }

  const nextVersion = nextAssignmentVersion(source);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET room_id = CASE id
         WHEN $1::uuid THEN $4::uuid
         WHEN $2::uuid THEN $3::uuid
       END,
       assignment_status = CASE
         WHEN CASE id WHEN $1::uuid THEN $4::uuid WHEN $2::uuid THEN $3::uuid END IS NULL
           THEN 'pending'
         ELSE 'assigned'
       END,
       assigned_at = CASE
         WHEN CASE id WHEN $1::uuid THEN $4::uuid WHEN $2::uuid THEN $3::uuid END IS NULL
           THEN NULL
         ELSE COALESCE(assigned_at, now())
       END,
       assignment_payload = jsonb_set(
         COALESCE(assignment_payload, '{}'::jsonb),
         '{version}',
         to_jsonb($7::text),
         true
       ),
       updated_at = now()
     WHERE property_id = $5::uuid
       AND guest_booking_id = $6::uuid
       AND id IN ($1::uuid, $2::uuid)`,
    [
      source.assignmentId,
      target.assignmentId,
      source.roomId,
      target.roomId,
      command.propertyId,
      command.guestBookingId,
      nextVersion,
    ],
  );
  return { ok: true };
}

async function findAssignmentRoomTypeForCommand(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
): Promise<string | null> {
  const result = await client.query<{ roomTypeId: string }>(
    `SELECT room_type_id::text AS "roomTypeId"
     FROM pms.operational_booking_assignments
     WHERE property_id = $1::uuid AND guest_booking_id = $2::uuid
       AND (($3::uuid IS NOT NULL AND id = $3::uuid)
         OR ($3::uuid IS NULL AND position = COALESCE($4::integer, 1)))
     LIMIT 1`,
    [
      command.propertyId,
      command.guestBookingId,
      command.assignmentId ?? null,
      command.position ?? null,
    ],
  );
  return result.rows[0]?.roomTypeId ?? null;
}

async function findAssignmentForCommand(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
): Promise<PmsAssignmentRow | null> {
  const result = await client.query<PmsAssignmentRow>(
    `SELECT
       assignment.id::text AS "assignmentId",
       assignment.guest_booking_id::text AS "guestBookingId",
       assignment.room_type_id::text AS "roomTypeId",
       assignment.room_id::text AS "roomId",
       assignment.position,
       assignment.assignment_status AS "assignmentStatus",
       assignment.assignment_payload ->> 'version' AS version,
       assignment.updated_at AS "updatedAt",
       assignment.source,
       assignment.stay_evidence_kind AS "stayEvidenceKind",
       COALESCE(assignment.check_in, booking.check_in)::text AS "checkIn",
       COALESCE(assignment.check_out, booking.check_out)::text AS "checkOut"
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking
       ON booking.id = assignment.guest_booking_id
      AND booking.property_id = assignment.property_id
     WHERE assignment.property_id = $1::uuid
       AND assignment.guest_booking_id = $2::uuid
       AND (
         ($3::uuid IS NOT NULL AND assignment.id = $3::uuid)
         OR ($3::uuid IS NULL AND assignment.position = COALESCE($4::integer, 1))
       )
     LIMIT 1
     FOR UPDATE OF assignment`,
    [
      command.propertyId,
      command.guestBookingId,
      command.assignmentId ?? null,
      command.position ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function findAssignmentsForOperationalCommand(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand | PmsCheckOutCommand,
): Promise<PmsAssignmentRow[]> {
  const assignmentId =
    "stepResults" in command || "inspectionResults" in command ? command.assignmentId : undefined;
  const result = await client.query<PmsAssignmentRow>(
    `SELECT
       assignment.id::text AS "assignmentId",
       assignment.guest_booking_id::text AS "guestBookingId",
       assignment.room_type_id::text AS "roomTypeId",
       assignment.room_id::text AS "roomId",
       assignment.position,
       assignment.assignment_status AS "assignmentStatus",
       assignment.assignment_payload ->> 'version' AS version,
       assignment.updated_at AS "updatedAt",
       assignment.source,
       assignment.stay_evidence_kind AS "stayEvidenceKind",
       COALESCE(assignment.check_in,booking.check_in)::text AS "checkIn",
       COALESCE(assignment.check_out,booking.check_out)::text AS "checkOut"
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking
       ON booking.id = assignment.guest_booking_id
      AND booking.property_id = assignment.property_id
     WHERE assignment.property_id = $1::uuid
       AND assignment.guest_booking_id = $2::uuid
       AND (
         ($3::uuid IS NOT NULL AND assignment.id = $3::uuid)
         OR ($3::uuid IS NULL)
       )
     ORDER BY assignment.position, assignment.created_at, assignment.id
     FOR UPDATE OF assignment`,
    [command.propertyId, command.guestBookingId, assignmentId ?? null],
  );
  return result.rows;
}

async function lockOperationalCommandRoomScopes(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand | PmsCheckOutCommand,
): Promise<string[]> {
  const roomTypeIds = await readOperationalCommandRoomTypeIds(client, command);
  const lockedRoomTypeIds = new Set(roomTypeIds);
  for (const roomTypeId of roomTypeIds) {
    await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, roomTypeId);
  }
  if (roomTypeIds.length > 0) {
    await client.query(
      `SELECT id FROM pms.rooms
       WHERE property_id = $1::uuid AND room_type_id = ANY($2::uuid[])
       ORDER BY id FOR UPDATE`,
      [command.propertyId, roomTypeIds],
    );
  }
  await client.query(
    `SELECT assignment.id
     FROM pms.operational_booking_assignments assignment
     WHERE assignment.property_id = $1::uuid AND assignment.guest_booking_id = $2::uuid
     ORDER BY assignment.id FOR UPDATE OF assignment`,
    [command.propertyId, command.guestBookingId],
  );
  const currentRoomTypeIds = await readOperationalCommandRoomTypeIds(client, command);
  if (currentRoomTypeIds.some((roomTypeId) => !lockedRoomTypeIds.has(roomTypeId))) {
    throw new PmsRoomScopeChangedError();
  }
  return roomTypeIds;
}

async function readOperationalCommandRoomTypeIds(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand | PmsCheckOutCommand,
): Promise<string[]> {
  const requestedRoomIds =
    "stays" in command
      ? command.stays.flatMap((stay) => ("roomId" in stay ? [stay.roomId] : []))
      : [];
  const scopes = await client.query<{ roomTypeId: string }>(
    `SELECT DISTINCT scope.room_type_id::text AS "roomTypeId"
     FROM (
       SELECT assignment.room_type_id
       FROM pms.operational_booking_assignments assignment
       WHERE assignment.property_id = $1::uuid AND assignment.guest_booking_id = $2::uuid
       UNION ALL
       SELECT room.room_type_id
       FROM pms.rooms room
       WHERE room.property_id = $1::uuid AND room.id = ANY($3::uuid[])
    ) scope
     ORDER BY "roomTypeId"`,
    [command.propertyId, command.guestBookingId, requestedRoomIds],
  );
  return scopes.rows.map(({ roomTypeId }) => roomTypeId);
}

async function updateAssignmentsOperationalStatus(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand | PmsCheckOutCommand,
  sources: PmsAssignmentRow[],
  status: PmsOperationalStatus,
): Promise<void> {
  const nextVersion = nextAssignmentVersion(sources[0]!);
  await client.query(
    `UPDATE pms.operational_booking_assignments
     SET assignment_status = $1,
         assignment_payload = jsonb_set(
           jsonb_set(
             COALESCE(assignment_payload, '{}'::jsonb),
             '{version}',
             to_jsonb($5::text),
             true
           ),
           '{operationalStatus}',
           to_jsonb($1::text),
           true
         ),
         updated_at = now()
     WHERE id = ANY($2::uuid[])
       AND property_id = $3::uuid
       AND guest_booking_id = $4::uuid`,
    [
      status,
      sources.map((source) => source.assignmentId),
      command.propertyId,
      command.guestBookingId,
      nextVersion,
    ],
  );
}

function isAllowedOperationalStatusTransition(
  source: PmsAssignmentRow,
  target: PmsOperationalStatus,
): boolean {
  return ALLOWED_OPERATIONAL_STATUS_TRANSITIONS.get(source.assignmentStatus)?.has(target) ?? false;
}

function isAllowedNoShowTransition(source: PmsAssignmentRow): boolean {
  return source.assignmentStatus === "pending" || source.assignmentStatus === "assigned";
}

async function hasExistingCheckInRecord(
  client: PmsOperationsCommandClient,
  command: PmsCheckInCommand,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
     FROM pms.booking_checkin_records
     WHERE property_id = $1::uuid
       AND guest_booking_id = $2::uuid
       AND ($3::uuid IS NULL OR assignment_id = $3::uuid)
     LIMIT 1
     FOR UPDATE`,
    [command.propertyId, command.guestBookingId, command.assignmentId ?? null],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

async function findTargetAssignmentForSwap(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
): Promise<PmsAssignmentRow | null> {
  const result = await client.query<PmsAssignmentRow>(
    `SELECT
       id::text AS "assignmentId",
       guest_booking_id::text AS "guestBookingId",
       room_type_id::text AS "roomTypeId",
       room_id::text AS "roomId",
       position,
       assignment_status AS "assignmentStatus",
       assignment_payload ->> 'version' AS version,
       assignment.updated_at AS "updatedAt",
       booking.check_in::text AS "checkIn",
       booking.check_out::text AS "checkOut"
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking
       ON booking.id = assignment.guest_booking_id
      AND booking.property_id = assignment.property_id
     WHERE assignment.property_id = $1::uuid
       AND assignment.guest_booking_id = $2::uuid
       AND (
         ($3::uuid IS NOT NULL AND assignment.id = $3::uuid)
         OR ($3::uuid IS NULL AND assignment.position = $4::integer)
       )
     LIMIT 1
     FOR UPDATE OF assignment`,
    [
      command.propertyId,
      command.guestBookingId,
      command.targetAssignmentId ?? null,
      command.targetPosition ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

async function findAvailableRoomForAssignment(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomId: string,
): Promise<PmsRoomAvailabilityRow | null> {
  const result = await client.query<PmsRoomAvailabilityRow>(
    `SELECT
       id::text AS "roomId",
       room_type_id::text AS "roomTypeId",
       status
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND id = $2::uuid
       AND status = 'available'
       AND operational_label_status = 'verified'
       AND room_number IS NOT NULL
     LIMIT 1`,
    [propertyId, roomId],
  );
  return result.rows[0] ?? null;
}

async function assignmentsHaveVerifiedOperationalIdentity(
  client: PmsOperationsCommandClient,
  propertyId: string,
  assignments: PmsAssignmentRow[],
): Promise<boolean> {
  if (assignments.some(({ roomId }) => roomId === null)) return false;
  return roomIdsHaveVerifiedOperationalIdentity(
    client,
    propertyId,
    assignments.map(({ roomId }) => roomId as string),
  );
}

async function roomIdsHaveVerifiedOperationalIdentity(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomIds: string[],
): Promise<boolean> {
  const uniqueRoomIds = [...new Set(roomIds)].sort();
  if (uniqueRoomIds.length === 0) return false;
  const result = await client.query(
    `SELECT id
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND id = ANY($2::uuid[])
       AND status <> 'retired'
       AND operational_label_status = 'verified'
       AND room_number IS NOT NULL
     ORDER BY id
     FOR SHARE`,
    [propertyId, uniqueRoomIds],
  );
  return (result.rowCount ?? result.rows.length) === uniqueRoomIds.length;
}

async function lockRoomTypeRoomsForAssignment(
  client: PmsOperationsCommandClient,
  propertyId: string,
  roomTypeId: string,
): Promise<void> {
  await lockPmsPhysicalRoomUnitMutationScope(client, propertyId, roomTypeId);
  await client.query(
    `SELECT id
     FROM pms.rooms
     WHERE property_id = $1::uuid
       AND room_type_id = $2::uuid
     ORDER BY id
     FOR UPDATE`,
    [propertyId, roomTypeId],
  );
}

async function isRoomAvailableForStay(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  source: PmsAssignmentRow,
  targetRoomTypeId: string,
): Promise<boolean> {
  if (!command.roomId) return false;
  const result = await client.query(
    `WITH stay_dates AS (
       SELECT generate_series($4::date, $5::date - interval '1 day', interval '1 day')::date AS stay_date
     ),
     overlapping_assignments AS (
       SELECT 1
       FROM pms.operational_booking_assignments other_assignment
       JOIN booking.guest_bookings other_booking
         ON other_booking.id = other_assignment.guest_booking_id
        AND other_booking.property_id = other_assignment.property_id
       WHERE other_assignment.property_id = $1::uuid
         AND other_assignment.room_id = $2::uuid
         AND other_assignment.id <> $3::uuid
         AND other_assignment.assignment_status IN ('assigned', 'checked_in', 'in_house')
         AND daterange(
               COALESCE(other_assignment.check_in, other_booking.check_in),
               COALESCE(other_assignment.check_out, other_booking.check_out), '[)'
             ) &&
             daterange($4::date, $5::date, '[)')
       LIMIT 1
     ),
     room_specific_blocks AS (
       SELECT 1
       FROM pms.room_blocks block
       WHERE block.property_id = $1::uuid
         AND block.room_type_id = $6::uuid
         AND block.status = 'active'
         AND block.room_id = $2::uuid
         AND daterange(block.starts_on, block.ends_on + 1, '[)') &&
             daterange($4::date, $5::date, '[)')
       LIMIT 1
     ),
     room_type_capacity AS (
       SELECT COUNT(*)::integer AS total_count
       FROM pms.rooms room
       WHERE room.property_id = $1::uuid
         AND room.room_type_id = $6::uuid
         AND room.status = 'available'
     ),
     assigned_by_date AS (
       SELECT
         stay_dates.stay_date,
         COUNT(DISTINCT CASE
           WHEN other_booking.id IS NOT NULL THEN other_assignment.room_id
         END)::integer AS assigned_count
       FROM stay_dates
       LEFT JOIN pms.operational_booking_assignments other_assignment
         ON other_assignment.property_id = $1::uuid
        AND other_assignment.room_type_id = $6::uuid
        AND other_assignment.room_id IS NOT NULL
        AND other_assignment.id <> $3::uuid
        AND other_assignment.assignment_status IN ('assigned', 'checked_in', 'in_house')
       LEFT JOIN booking.guest_bookings other_booking
         ON other_booking.id = other_assignment.guest_booking_id
        AND other_booking.property_id = other_assignment.property_id
        AND daterange(
              COALESCE(other_assignment.check_in, other_booking.check_in),
              COALESCE(other_assignment.check_out, other_booking.check_out), '[)'
            ) @> stay_dates.stay_date
       GROUP BY stay_dates.stay_date
     ),
     type_blocked_by_date AS (
       SELECT
         stay_dates.stay_date,
         COALESCE(SUM(block.blocked_count), 0)::integer AS blocked_count
       FROM stay_dates
       LEFT JOIN pms.room_blocks block
         ON block.property_id = $1::uuid
        AND block.room_type_id = $6::uuid
        AND block.room_id IS NULL
        AND block.status = 'active'
        AND block.source_assignment_id IS DISTINCT FROM $3::uuid
        AND daterange(block.starts_on, block.ends_on + 1, '[)') @> stay_dates.stay_date
       GROUP BY stay_dates.stay_date
     ),
     type_capacity_sold_out AS (
       SELECT 1
       FROM stay_dates
       CROSS JOIN room_type_capacity
       JOIN assigned_by_date USING (stay_date)
       JOIN type_blocked_by_date USING (stay_date)
       WHERE assigned_by_date.assigned_count + type_blocked_by_date.blocked_count >=
             room_type_capacity.total_count
       LIMIT 1
     ),
     canonical_inventory_unavailable AS (
       SELECT 1
       FROM stay_dates
       JOIN type_blocked_by_date USING (stay_date)
       LEFT JOIN pms.inventory_days inventory
         ON inventory.property_id=$1::uuid AND inventory.room_type_id=$6::uuid
        AND inventory.stay_date=stay_dates.stay_date
       WHERE inventory.calendar_revision IS NULL OR inventory.status<>'open'
          OR GREATEST(inventory.assigned_count
               - CASE WHEN $6::uuid=$7::uuid THEN 1 ELSE 0 END,0)
             + type_blocked_by_date.blocked_count >=
             inventory.effective_sellable_limit_count
          OR (inventory.linked_stop_sell AND EXISTS (
            SELECT 1 FROM pms.room_types target_type
            JOIN pms.room_types source_type ON source_type.property_id=target_type.property_id
              AND source_type.linked_inventory_group_id=target_type.linked_inventory_group_id
            WHERE target_type.property_id=$1::uuid AND target_type.id=$6::uuid
              AND target_type.linked_inventory_group_id IS NOT NULL
              AND (EXISTS (SELECT 1 FROM pms.inventory_reservation_receipts receipt
                JOIN pms.inventory_reservation_statuses receipt_status
                  ON receipt_status.receipt_id=receipt.receipt_id
                WHERE receipt.property_id=$1::uuid AND receipt.room_type_id=source_type.id
                  AND receipt_status.lifecycle_state='reserved'
                  AND stay_dates.stay_date>=receipt.check_in
                  AND stay_dates.stay_date<receipt.check_out)
                OR EXISTS (SELECT 1 FROM pms.operational_booking_assignments cause
                  WHERE cause.property_id=$1::uuid AND cause.room_type_id=source_type.id
                    AND cause.id<>$3::uuid AND cause.stay_evidence_kind='exact'
                    AND cause.assignment_status NOT IN ('canceled','released')
                    AND stay_dates.stay_date>=cause.check_in
                    AND stay_dates.stay_date<cause.check_out)
                OR EXISTS (SELECT 1 FROM pms.room_blocks cause
                  WHERE cause.property_id=$1::uuid AND cause.room_type_id=source_type.id
                    AND cause.block_kind='manual' AND cause.status='active'
                    AND stay_dates.stay_date BETWEEN cause.starts_on AND cause.ends_on))))
       LIMIT 1
     )
     SELECT 1
     WHERE NOT EXISTS (SELECT 1 FROM overlapping_assignments)
       AND NOT EXISTS (SELECT 1 FROM room_specific_blocks)
       AND NOT EXISTS (SELECT 1 FROM type_capacity_sold_out)
       AND NOT EXISTS (SELECT 1 FROM canonical_inventory_unavailable)`,
    [
      command.propertyId,
      command.roomId,
      source.assignmentId,
      source.checkIn,
      source.checkOut,
      targetRoomTypeId,
      source.roomTypeId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

async function enqueueAssignmentCommandSideEffects(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  commandMeta: PmsCommandMeta,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  const domainEvent = await client.query<{ eventId: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events (
         source_system,
         event_key,
         event_type,
         event_version,
         occurred_at,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         causation_id,
         idempotency_key_hash,
         payload,
         event_metadata
       )
       VALUES (
         'pms',
         $1,
         'pms.assignment.changed',
         1,
         $2::timestamptz,
         'property',
         $3::uuid,
         'pms',
         'operational_booking_assignment',
         $4,
         $5,
         $6,
         $7,
         $8::jsonb,
         $9::jsonb
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id::text AS "eventId"
     )
     SELECT "eventId" FROM inserted
     UNION ALL
     SELECT id::text AS "eventId"
     FROM platform.domain_events
     WHERE source_system = 'pms'
       AND event_key = $1
     LIMIT 1`,
    [
      `pms.assignment.${command.idempotencyKey}.v1`,
      acceptedAt,
      command.propertyId,
      command.assignmentId ?? command.guestBookingId,
      command.commandId,
      command.commandId,
      keyHash,
      JSON.stringify({ command, commandMeta }),
      JSON.stringify({ contractVersion: PMS_OPERATIONS_CONTRACT_VERSION }),
    ],
  );

  await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id,
       outbox_key,
       destination,
       event_type,
       tenant_scope,
       property_id,
       resource_product,
       resource_type,
       resource_id,
       correlation_id,
       idempotency_key_hash,
       payload,
       outbox_metadata
     )
     VALUES (
       $1::uuid,
       $2,
       'pms.calendar-projection',
       'pms.calendar.refresh_requested',
       'property',
       $3::uuid,
       'pms',
       'operational_booking',
       $4,
       $5,
       $6,
       $7::jsonb,
       $8::jsonb
     )
     ON CONFLICT (destination, outbox_key) DO NOTHING`,
    [
      domainEvent.rows[0]!.eventId,
      `pms.calendar_refresh.${command.idempotencyKey}.v1`,
      command.propertyId,
      command.guestBookingId,
      command.commandId,
      keyHash,
      JSON.stringify({
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        action: command.action,
      }),
      JSON.stringify({ sideEffects: commandMeta.sideEffects }),
    ],
  );
}

async function enqueueAssignmentInventoryTransferSideEffects(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  transfer: AssignmentInventoryTransfer,
  keyHash: string,
  acceptedAt: string,
): Promise<void> {
  const dateRange = {
    from: transfer.checkIn,
    to: new Date(Date.parse(`${transfer.checkOut}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10),
  };
  for (const roomTypeId of [transfer.sourceRoomTypeId, transfer.targetRoomTypeId]) {
    const eventKey = `pms.assignment.inventory_changed.property.${command.propertyId}.room_type.${roomTypeId}.command.${command.commandId}.key.${keyHash}.v1`;
    const payload = JSON.stringify({
      propertyId: command.propertyId,
      roomTypeId,
      dateRange,
      inventoryVersion: keyHash,
      triggerRefId: command.commandId,
    });
    const event = await client.query<{ eventId: string }>(
      `WITH inserted AS (
         INSERT INTO platform.domain_events (
           source_system, event_key, event_type, event_version, occurred_at,
           tenant_scope, property_id, resource_product, resource_type, resource_id,
           correlation_id, causation_id, idempotency_key_hash, payload, event_metadata
         ) VALUES (
           'pms', $1, 'pms.inventory.changed', 1, $2::timestamptz,
           'property', $3::uuid, 'pms', 'room_type', $4::uuid,
           $5, $5, $6, $7::jsonb, $8::jsonb
         ) ON CONFLICT (source_system, event_key) DO NOTHING
         RETURNING id::text AS "eventId"
       )
       SELECT "eventId" FROM inserted
       UNION ALL
       SELECT id::text FROM platform.domain_events
       WHERE source_system='pms' AND event_key=$1
       LIMIT 1`,
      [
        eventKey,
        acceptedAt,
        command.propertyId,
        roomTypeId,
        command.commandId,
        keyHash,
        payload,
        JSON.stringify({ contractVersion: PMS_OPERATIONS_CONTRACT_VERSION }),
      ],
    );
    const eventId = event.rows[0]?.eventId;
    if (!eventId) throw new Error("Assignment inventory event could not be persisted");
    await client.query(
      `INSERT INTO platform.outbox_events (
         domain_event_id, outbox_key, destination, event_type, tenant_scope,
         property_id, resource_product, resource_type, resource_id, correlation_id,
         idempotency_key_hash, payload, outbox_metadata
       ) SELECT $1::uuid, output.outbox_key, output.destination, output.event_type,
                'property', $2::uuid, 'pms', 'room_type', $3::uuid, $4, $5,
                $6::jsonb, $7::jsonb
         FROM (VALUES
           ($8::text, 'pms.channel-manager'::text, 'pms.inventory.ari_changed'::text),
           ($9::text, 'distribution.public-bookability'::text, 'pms.inventory.changed'::text)
         ) AS output(outbox_key, destination, event_type)
       ON CONFLICT (destination, outbox_key) DO NOTHING`,
      [
        eventId,
        command.propertyId,
        roomTypeId,
        command.commandId,
        keyHash,
        payload,
        JSON.stringify({ contractVersion: PMS_OPERATIONS_CONTRACT_VERSION }),
        `${eventKey}.ari`,
        `${eventKey}.distribution`,
      ],
    );
  }
}

async function completeAssignmentCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsAssignmentCommand,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'operational_booking',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = 'assignment_command'
       AND key_hash = $5
       AND tenant_scope = 'property'
       AND property_id = $6::uuid`,
    [
      command.guestBookingId,
      sha256(stableJson(commandMeta)),
      acceptedAt,
      JSON.stringify({ commandMeta }),
      keyHash,
      command.propertyId,
    ],
  );
}

async function recordOperationalCommandAuditEvent(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
  commandMeta: PmsCommandMeta,
  keyHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       organization_id,
       property_id,
       actor_type,
       actor_user_id,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata
     )
     VALUES (
       $1,
       'pms',
       $2,
       1,
       $3::timestamptz,
       'property',
       NULL,
       $4::uuid,
       $5,
       $6::uuid,
       'pms',
       'operational_booking',
       $7,
       $8,
       $9,
       $10::jsonb,
       $11::jsonb,
       $12::jsonb
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `pms.${operation}.property.${command.propertyId}.key.${keyHash}.audit.v1`,
      `pms.${operation.replace("_command", "")}`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.kind === "user" ? command.audit.actor.userId : null,
      command.guestBookingId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({ commandMeta, idempotencyKeyHash: keyHash }),
      JSON.stringify(
        "pricing" in command
          ? {
              accountingDate: command.accountingDate,
              reason: command.reason ?? null,
              pricing: command.pricing,
            }
          : "stays" in command
            ? { accountingDate: command.accountingDate, stays: command.stays }
            : "retainedCharges" in command
              ? { reason: command.reason ?? null }
              : "allocations" in command
                ? {
                    reason: command.reason ?? null,
                    paymentEvidenceId: command.paymentEvidenceId,
                    accountingDate: command.accountingDate,
                  }
                : {},
      ),
      JSON.stringify({
        commandId: command.commandId,
        reason: command.audit.reason,
        requestId: command.audit.requestId,
        actorOrganizationId:
          command.audit.actor.kind === "user" ? command.audit.actor.organizationId : null,
      }),
    ],
  );
}

async function completeOperationalCommandIdempotency(
  client: PmsOperationsCommandClient,
  command: PmsOperationalCommand,
  operation: PmsOperationalCommandOperation,
  keyHash: string,
  commandMeta: PmsCommandMeta,
  acceptedAt: string,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 200,
         response_resource_product = 'pms',
         response_resource_type = 'operational_booking',
         response_resource_id = $1,
         response_body_hash = $2,
         completed_at = $3::timestamptz,
         last_seen_at = $3::timestamptz,
         idempotency_metadata = $4::jsonb
     WHERE operation_scope = 'pms'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'property'
       AND property_id = $7::uuid`,
    [
      command.guestBookingId,
      sha256(stableJson(commandMeta)),
      acceptedAt,
      JSON.stringify({ commandMeta }),
      operation,
      keyHash,
      command.propertyId,
    ],
  );
}

async function reservationResultForCommand(
  config: TargetPmsOperationsCommandRepositoryConfig,
  command: PmsOperationalCommand,
  commandMeta: PmsCommandMeta,
  replayed: boolean,
): Promise<PmsOperationalCommandResult> {
  const reservation = await config.readRepository.findReservationByGuestBookingId(
    command.propertyId,
    command.guestBookingId,
    true,
  );
  return reservation
    ? { ok: true, reservation, commandMeta, replayed }
    : reservationNotFound(command.guestBookingId);
}

function assignmentVersionMatches(row: PmsAssignmentRow, expectedVersion: string): boolean {
  const updatedAt =
    row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
  return expectedVersion === row.version || expectedVersion === updatedAt;
}

function nextAssignmentVersion(row: PmsAssignmentRow): string {
  const match = /^reservation-v(\d+)$/.exec(row.version ?? "");
  return `reservation-v${match ? Number(match[1]) + 1 : 1}`;
}

function reservationNotFound(guestBookingId: string): {
  ok: false;
  statusCode: 404;
  code: "reservation_not_found";
  message: string;
} {
  return {
    ok: false,
    statusCode: 404,
    code: "reservation_not_found",
    message: `PMS reservation ${guestBookingId} was not found.`,
  };
}

function assignmentConflict(
  code: PmsAssignmentCommandConflictCode,
  message: string,
): Exclude<PmsAssignmentCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code,
    message,
  };
}

function operationalConflict(
  code:
    | "version_conflict"
    | "idempotency_conflict"
    | "room_unavailable"
    | "bank_transfer_unavailable",
  message: string,
): Exclude<PmsOperationalCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code,
    message,
  };
}

function operationalInvalidBody(
  message: string,
): Exclude<PmsOperationalCommandResult, { ok: true }> {
  return { ok: false, statusCode: 400, code: "invalid_body", message };
}

function invalidStatusTransition(
  fromStatus: string,
  toStatus: string,
): Exclude<PmsOperationalCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_status_transition",
    message: `Cannot transition PMS reservation from ${fromStatus} to ${toStatus}.`,
  };
}

function operationalIdentityRequired(
  workflow: string,
): Exclude<PmsOperationalCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_status_transition",
    message: `PMS ${workflow} requires an active room with a verified operational label.`,
  };
}

function privateNoteReservationNotFound(
  guestBookingId: string,
): Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "reservation_not_found",
    message: `PMS reservation ${guestBookingId} was not found.`,
  };
}

function noteNotFound(
  noteId: string,
): Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "note_not_found",
    message: `PMS private note ${noteId} was not found.`,
  };
}

function privateNoteConflict(
  message: string,
): Exclude<PmsPrivateNoteCommandResult | PmsPrivateNoteDeleteResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message,
  };
}

function operationalTemplateConflict(
  message: string,
): Exclude<PmsOperationalTemplateCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message,
  };
}

function checkoutChargeReservationNotFound(
  guestBookingId: string,
): Exclude<PmsCheckoutChargeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "reservation_not_found",
    message: `PMS reservation ${guestBookingId} was not found.`,
  };
}

function checkoutChargeNotFound(
  chargeId: string,
): Exclude<PmsCheckoutChargeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "charge_not_found",
    message: `PMS checkout charge ${chargeId} was not found.`,
  };
}

function checkoutChargeConflict(
  message: string,
): Exclude<PmsCheckoutChargeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message,
  };
}

function roomTypeConflict(
  code: "idempotency_conflict" | "room_type_conflict" | "version_conflict",
  message: string,
): Exclude<PmsRoomTypeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code,
    message,
  };
}

function roomTypeRetireConflict(
  code: "idempotency_conflict" | "version_conflict" | "room_type_retirement_blocked",
  message: string,
): Exclude<PmsRoomTypeRetireCommandResult, { ok: true }> {
  return { ok: false, statusCode: 409, code, message };
}

function roomTypeRetireNotFound(
  roomTypeId: string,
): Exclude<PmsRoomTypeRetireCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "room_type_not_found",
    message: `PMS room type ${roomTypeId} was not found.`,
  };
}

function roomTypeNotFound(roomTypeId: string): Exclude<PmsRoomTypeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "room_type_not_found",
    message: `PMS room type ${roomTypeId} was not found.`,
  };
}

function roomTypeInvalidBody(message: string): Exclude<PmsRoomTypeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_body",
    message,
  };
}

function checkoutChargeInvalidBody(
  message: string,
): Exclude<PmsCheckoutChargeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_body",
    message,
  };
}

function checkoutChargeInvalidTransition(
  fromStatus: string,
  toStatus: string,
): Exclude<PmsCheckoutChargeCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_status_transition",
    message: `Cannot transition PMS checkout charge from ${fromStatus} to ${toStatus}.`,
  };
}

function checkOutReservationNotFound(
  guestBookingId: string,
): Exclude<PmsCheckOutCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "reservation_not_found",
    message: `PMS reservation ${guestBookingId} was not found.`,
  };
}

function checkOutChargeNotFound(chargeId: string): Exclude<PmsCheckOutCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 404,
    code: "charge_not_found",
    message: `PMS checkout charge ${chargeId} was not found.`,
  };
}

function checkOutConflict(message: string): Exclude<PmsCheckOutCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code: "idempotency_conflict",
    message,
  };
}

function checkOutVersionConflict(message: string): Exclude<PmsCheckOutCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 409,
    code: "version_conflict",
    message,
  };
}

function checkOutInvalidBody(message: string): Exclude<PmsCheckOutCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_body",
    message,
  };
}

function checkOutInvalidTransition(
  fromStatus: string,
  toStatus: string,
): Exclude<PmsCheckOutCommandResult, { ok: true }> {
  return {
    ok: false,
    statusCode: 400,
    code: "invalid_status_transition",
    message: `Cannot transition PMS reservation from ${fromStatus} to ${toStatus}.`,
  };
}

function isPmsCommandMeta(value: unknown): value is PmsCommandMeta {
  return (
    !!value &&
    typeof value === "object" &&
    (value as PmsCommandMeta).contractVersion === PMS_OPERATIONS_CONTRACT_VERSION &&
    typeof (value as PmsCommandMeta).commandId === "string" &&
    typeof (value as PmsCommandMeta).idempotencyKey === "string" &&
    typeof (value as PmsCommandMeta).acceptedAt === "string" &&
    Array.isArray((value as PmsCommandMeta).sideEffects) &&
    ((value as PmsCommandMeta).rearrangedBookingCount === undefined ||
      (Number.isSafeInteger((value as PmsCommandMeta).rearrangedBookingCount) &&
        (value as PmsCommandMeta).rearrangedBookingCount! >= 0))
  );
}

function isOperationalReplayMeta(
  value: unknown,
  command: PmsOperationalCommand,
): value is PmsCommandMeta {
  if (!isPmsCommandMeta(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  return (
    (keys === "acceptedAt,commandId,contractVersion,idempotencyKey,sideEffects" ||
      keys ===
        "acceptedAt,commandId,contractVersion,idempotencyKey,rearrangedBookingCount,sideEffects") &&
    value.commandId === command.commandId &&
    value.idempotencyKey === command.idempotencyKey
  );
}

function operationalCommandFingerprint(command: PmsOperationalCommand): unknown {
  const { audit: _audit, ...fingerprint } = command;
  return fingerprint;
}

function normalizePmsPrivateNote(value: unknown): PmsPrivateNote | null {
  if (!value || typeof value !== "object") return null;
  const note = value as PmsPrivateNote;
  if (
    typeof note.noteId !== "string" ||
    typeof note.body !== "string" ||
    (note.authorUserId !== null && typeof note.authorUserId !== "string") ||
    typeof note.authorDisplayName !== "string" ||
    typeof note.createdAt !== "string" ||
    !note.auditMetadata ||
    typeof note.auditMetadata !== "object" ||
    note.auditMetadata.privacyScope !== "internal" ||
    typeof note.auditMetadata.createdAt !== "string" ||
    typeof note.auditMetadata.createdByDisplayName !== "string"
  ) {
    return null;
  }
  for (const editValue of [
    note.auditMetadata.editedByUserId,
    note.auditMetadata.editedByDisplayName,
    note.auditMetadata.editedAt,
  ]) {
    if (editValue !== undefined && editValue !== null && typeof editValue !== "string") return null;
  }
  return {
    ...note,
    auditMetadata: {
      ...note.auditMetadata,
      editedByUserId: note.auditMetadata.editedByUserId ?? null,
      editedByDisplayName: note.auditMetadata.editedByDisplayName ?? null,
      editedAt: note.auditMetadata.editedAt ?? null,
    },
  };
}

function isPmsOperationalTemplate(value: unknown): value is PmsOperationalTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as PmsOperationalTemplate;
  return (
    typeof template.propertyId === "string" &&
    (template.templateKind === "check_in_checklist" ||
      template.templateKind === "check_out_inspection") &&
    Array.isArray(template.steps) &&
    (template.updatedByUserId === null || typeof template.updatedByUserId === "string") &&
    (template.updatedAt === null || typeof template.updatedAt === "string")
  );
}

function isPmsCheckoutCharge(value: unknown): value is PmsCheckoutCharge {
  if (!value || typeof value !== "object") return false;
  const charge = value as PmsCheckoutCharge;
  return (
    typeof charge.chargeId === "string" &&
    typeof charge.propertyId === "string" &&
    typeof charge.guestBookingId === "string" &&
    (charge.assignmentId === null || typeof charge.assignmentId === "string") &&
    typeof charge.label === "string" &&
    !!charge.amount &&
    typeof charge.amount.amountDecimal === "string" &&
    typeof charge.amount.currency === "string" &&
    !!charge.originalAmount &&
    typeof charge.originalAmount.amountDecimal === "string" &&
    typeof charge.originalAmount.currency === "string" &&
    (charge.status === "pending" ||
      charge.status === "paid" ||
      charge.status === "waived" ||
      charge.status === "void") &&
    (charge.createdByUserId === null || typeof charge.createdByUserId === "string") &&
    typeof charge.createdAt === "string" &&
    (charge.settledAt === null || typeof charge.settledAt === "string") &&
    (charge.waivedAt === null || typeof charge.waivedAt === "string") &&
    charge.operationalOwnership?.owner === "pms" &&
    charge.operationalOwnership.financeSettlementOwner === "finance" &&
    charge.operationalOwnership.providerSettlement === false
  );
}

function isPmsRoomType(value: unknown): value is PmsRoomType {
  if (!value || typeof value !== "object") return false;
  const roomType = value as PmsRoomType;
  return (
    typeof roomType.roomTypeId === "string" &&
    typeof roomType.version === "string" &&
    typeof roomType.name === "string" &&
    typeof roomType.description === "string" &&
    (roomType.category === null || typeof roomType.category === "string") &&
    !!roomType.baseRate &&
    typeof roomType.baseRate.amountDecimal === "string" &&
    typeof roomType.baseRate.currency === "string" &&
    typeof roomType.active === "boolean" &&
    typeof roomType.sortOrder === "number" &&
    Array.isArray(roomType.ratePlans) &&
    typeof roomType.roomCount === "number"
  );
}

function isPmsRoomTypeRetirementImpact(value: unknown): value is PmsRoomTypeRetirementImpact {
  if (!value || typeof value !== "object") return false;
  const impact = value as PmsRoomTypeRetirementImpact;
  return (
    impact.contractVersion === PMS_ROOM_TYPE_LIFECYCLE_CONTRACT_VERSION &&
    typeof impact.propertyId === "string" &&
    typeof impact.roomTypeId === "string" &&
    typeof impact.version === "string" &&
    typeof impact.canRetire === "boolean" &&
    Array.isArray(impact.blockers) &&
    impact.blockers.every(
      (blocker) =>
        !!blocker &&
        typeof blocker === "object" &&
        typeof blocker.category === "string" &&
        typeof blocker.code === "string" &&
        Number.isInteger(blocker.affectedCount) &&
        blocker.affectedCount > 0 &&
        typeof blocker.action === "string",
    )
  );
}

function isPmsCheckOutRecord(value: unknown): value is PmsCheckOutRecord {
  if (!value || typeof value !== "object") return false;
  const checkout = value as PmsCheckOutRecord;
  return (
    typeof checkout.checkoutRecordId === "string" &&
    typeof checkout.propertyId === "string" &&
    typeof checkout.guestBookingId === "string" &&
    (checkout.assignmentId === null || typeof checkout.assignmentId === "string") &&
    (checkout.completedByUserId === null || typeof checkout.completedByUserId === "string") &&
    typeof checkout.completedAt === "string" &&
    Array.isArray(checkout.inspectionResults) &&
    Array.isArray(checkout.chargesSettled) &&
    Array.isArray(checkout.pendingFlags) &&
    (checkout.checkoutNotes === null || typeof checkout.checkoutNotes === "string") &&
    checkout.financeHandoff?.financeSettlementOwner === "finance" &&
    checkout.financeHandoff.providerSettlement === false &&
    Array.isArray(checkout.financeHandoff.pendingChargeIds) &&
    Array.isArray(checkout.financeHandoff.unsettledPaidChargeIds)
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rollbackQuietly(client: PmsOperationsCommandClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original error.
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "23505";
}

function isPgForeignKeyViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "23503";
}
