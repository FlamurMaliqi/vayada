import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  BookingAdditionalGuestCreateCommand,
  BookingAdditionalGuestDeleteCommand,
  BookingAdditionalGuestInput,
  BookingAdditionalGuestUpdateCommand,
  BookingGuestPii,
  BookingGuestPiiCommandMeta,
  BookingGuestPiiCommandResult,
  BookingGuestPiiDeleteResult,
  BookingGuestPiiPort,
  BookingGuestPiiProjection,
} from "@vayada/domain-booking";
import type {
  PmsInventoryPublicOfferProjectionPort,
  PublicBookabilityPublicationCommandPort,
} from "@vayada/domain-distribution";
import { PROPERTY_FEATURE_LIMITS, type PropertyPlanReadModel } from "@vayada/domain-finance";
import type { PropertyPlanReadRepository } from "../domains/propertyPlanReadModel.js";
import {
  isBookingAcceptanceMode,
  type BookingAcceptanceSettingsPort,
} from "../domains/bookingAcceptanceSettings.js";
import type {
  PmsCalendarDay,
  PmsOperationsReadRepository,
  PmsOperationalReservation,
  PmsMoney,
  PmsReservationListFilters,
  PmsRoomBlockSummary,
  PmsRoom,
  PmsRoomType,
  PmsSourceFreshness,
} from "../domains/pmsOperationsReadModel.js";
import { requireAuthContext } from "@vayada/backend-auth";
import { enforceRoutePolicy } from "./policy.js";

export const PMS_OPERATIONS_CONTRACT_VERSION = "pms-operations.v1" as const;

export type PmsOperationsContractVersion = typeof PMS_OPERATIONS_CONTRACT_VERSION;
export type {
  PmsCalendarDay,
  PmsOperationsReadRepository,
  PmsOperationalReservation,
  PmsRoomBlockSummary,
  PmsRoom,
  PmsRoomType,
} from "../domains/pmsOperationsReadModel.js";

export const PMS_RESERVATION_LIST_DEFAULT_LIMIT = 50;
export const PMS_RESERVATION_LIST_MIN_LIMIT = 1;
export const PMS_RESERVATION_LIST_MAX_LIMIT = 500;
export const PMS_RESERVATION_LIST_DEFAULT_OFFSET = 0;
export const PMS_CALENDAR_MAX_RANGE_DAYS = 370;

export type PmsRoomsResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoom[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomTypesResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoomType[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomTypeDetailResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: PmsRoomType;
  sourceFreshness: PmsSourceFreshness;
};

export type PmsPropertyPlanResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  propertyPlan: PropertyPlanReadModel;
};

export type PmsCalendarResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  days: PmsCalendarDay[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomBlocksResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoomBlockSummary[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsReservationListResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsOperationalReservation[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
  sourceFreshness: PmsSourceFreshness;
};

export type PmsReservationDetailResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: PmsOperationalReservationDetail;
  sourceFreshness: PmsSourceFreshness;
};

export type PmsOperationalReservationDetail = PmsOperationalReservation & {
  additionalGuests?: readonly BookingGuestPii[];
};

export type PmsAssignmentCommandAction = "assign" | "move" | "unassign" | "swap";
export type PmsOperationsCommandSideEffect =
  | "calendar_refresh"
  | "ari_changed"
  | "distribution_refresh"
  | "guest_notification"
  | "audit_event";
export type PmsAssignmentCommandSideEffect = "calendar_refresh" | "ari_changed" | "audit_event";
export type PmsPrivateNoteSource = "pms" | "migration" | "system";
export type PmsCheckoutChargeStatus = "pending" | "paid" | "waived" | "void";

export type PmsCommandMeta = {
  contractVersion: PmsOperationsContractVersion;
  commandId: string;
  idempotencyKey: string;
  acceptedAt: string;
  sideEffects: PmsOperationsCommandSideEffect[];
};

export type PmsOperationsCommandAudit = {
  actor:
    | {
        kind: "user";
        userId: string;
        organizationId: string;
      }
    | { kind: "system"; service: "apps/api" };
  requestId: string;
  correlationId?: string;
  reason: string;
  requestedAt: string;
};

export type PmsPrivateNoteAuditMetadata = {
  source: PmsPrivateNoteSource;
  createdByUserId: string | null;
  createdByDisplayName: string;
  createdAt: string;
  privacyScope: "internal";
};

export type PmsPrivateNote = {
  noteId: string;
  body: string;
  authorUserId: string | null;
  authorDisplayName: string;
  createdAt: string;
  auditMetadata: PmsPrivateNoteAuditMetadata;
};

export type PmsTemplateStep = {
  stepId: string;
  label: string;
  required: boolean;
};

export type PmsOperationalTemplateKind = "check_in_checklist" | "check_out_inspection";

export type PmsOperationalTemplate = {
  propertyId: string;
  templateKind: PmsOperationalTemplateKind;
  steps: PmsTemplateStep[];
  updatedByUserId: string | null;
  updatedAt: string | null;
};

export type PmsCheckoutCharge = {
  chargeId: string;
  propertyId: string;
  guestBookingId: string;
  assignmentId: string | null;
  label: string;
  amount: PmsMoney;
  originalAmount: PmsMoney;
  status: PmsCheckoutChargeStatus;
  createdByUserId: string | null;
  createdAt: string;
  settledAt: string | null;
  waivedAt: string | null;
  operationalOwnership: {
    owner: "pms";
    financeSettlementOwner: "finance";
    providerSettlement: false;
  };
};

export type PmsCheckOutRecord = {
  checkoutRecordId: string;
  propertyId: string;
  guestBookingId: string;
  assignmentId: string | null;
  completedByUserId: string | null;
  completedAt: string;
  inspectionResults: unknown[];
  chargesSettled: PmsCheckoutCharge[];
  pendingFlags: string[];
  checkoutNotes: string | null;
  financeHandoff: {
    financeSettlementOwner: "finance";
    providerSettlement: false;
    pendingChargeIds: string[];
    unsettledPaidChargeIds: string[];
  };
};

export type PmsAssignmentCommandRequest = {
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  action?: PmsAssignmentCommandAction;
  assignmentId?: string;
  position?: number;
  roomId?: string | null;
  targetAssignmentId?: string;
  targetPosition?: number;
};

export type PmsPrivateNoteCreateRequest = {
  commandId: string;
  idempotencyKey: string;
  body: string;
};

export type PmsPrivateNoteDeleteRequest = {
  commandId: string;
  idempotencyKey: string;
};

export type PmsAssignmentCommand = PmsAssignmentCommandRequest & {
  propertyId: string;
  guestBookingId: string;
  action: PmsAssignmentCommandAction;
};

export type PmsOperationalStatus = "assigned" | "checked_in" | "in_house" | "checked_out";

export type PmsOperationalStatusCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  status: PmsOperationalStatus;
  audit: PmsOperationsCommandAudit;
};

export type PmsCheckInCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  assignmentId?: string;
  stepResults: unknown[];
  pendingFlags: string[];
  audit: PmsOperationsCommandAudit;
};

export type PmsNoShowCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  reason?: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsManualCancellationCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  reason?: string;
  accountingDate: string | null;
  retainedCharges: Array<{
    linePosition: number;
    stayDate: string;
    amount: PmsMoney;
  }>;
  audit: PmsOperationsCommandAudit;
};

export type PmsManualRefundCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  paymentEvidenceId: string;
  accountingDate: string;
  reason?: string;
  allocations: Array<{ evidenceId: string; amount: PmsMoney }>;
  audit: PmsOperationsCommandAudit;
};

export type PmsManualStayCorrectionCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  accountingDate: string;
  stays: Array<{
    assignmentId: string;
    position: number;
    roomId: string;
    checkIn: string;
    checkOut: string;
    nightly: Array<{
      stayDate: string;
      amount: PmsMoney | null;
      evidenceQuality: "exact" | "inferred" | "missing";
    }>;
  }>;
  audit: PmsOperationsCommandAudit;
};

export type PmsManualPriceCorrectionCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  accountingDate: string;
  reason?: string;
  pricing:
    | {
        kind: "exact";
        nights: Array<{ targetEvidenceId: string; replacementAmount: PmsMoney }>;
      }
    | {
        kind: "equal_inferred";
        targetEvidenceIds: string[];
        replacementTotal: PmsMoney;
      };
  audit: PmsOperationsCommandAudit;
};

export type PmsBookingLifecycleCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsCheckOutCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion?: string;
  assignmentId?: string;
  inspectionResults: unknown[];
  chargesSettled: string[];
  pendingFlags: string[];
  checkoutNotes?: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsRoomTypeCreateCommand = {
  propertyId: string;
  commandId: string;
  idempotencyKey: string;
  initialSetupOnly?: boolean;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: Record<string, number>;
  attributes: Record<string, string | number | boolean | null>;
  amenities: string[];
  media: PmsRoomType["media"];
  baseRate: PmsMoney;
  nonRefundableRate: PmsMoney | null;
  operatingPeriods: PmsRoomTypeOperatingPeriod[];
  seasons: PmsRoomTypeSeason[];
  active: boolean;
  sortOrder: number;
  roomCount: number;
  audit: PmsOperationsCommandAudit;
};

export type PmsRoomTypeOperatingPeriod = {
  from: string;
  to: string;
};

export type PmsRoomTypeSeason = {
  name: string;
  tier: string | null;
  from: string;
  to: string;
  rate: PmsMoney;
  minStayNights: number;
  maxStayNights: number | null;
};

export type PmsRoomTypeUpdateCommand = {
  propertyId: string;
  roomTypeId: string;
  commandId: string;
  idempotencyKey: string;
  attributes: Record<string, string | number | boolean | null>;
  audit: PmsOperationsCommandAudit;
};

export type PmsRoomBlockCreateCommand = {
  propertyId: string;
  commandId: string;
  idempotencyKey: string;
  roomTypeId: string;
  roomIds: string[];
  startsOn: string;
  endsOn: string;
  reason: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsRoomBlockUpdateCommand = {
  propertyId: string;
  blockId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion: string;
  startsOn?: string;
  endsOn?: string;
  reason?: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsRoomBlockReleaseCommand = {
  propertyId: string;
  blockId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsPrivateNoteCreateCommand = PmsPrivateNoteCreateRequest & {
  propertyId: string;
  guestBookingId: string;
  actorUserId: string;
  authorDisplayName: string;
};

export type PmsPrivateNoteDeleteCommand = PmsPrivateNoteDeleteRequest & {
  propertyId: string;
  guestBookingId: string;
  noteId: string;
  actorUserId: string;
};

export type PmsOperationalTemplateUpdateCommand = {
  propertyId: string;
  templateKind: PmsOperationalTemplateKind;
  commandId: string;
  idempotencyKey: string;
  steps: PmsTemplateStep[];
  actorUserId: string;
};

export type PmsCheckoutChargeCreateCommand = {
  propertyId: string;
  guestBookingId: string;
  commandId: string;
  idempotencyKey: string;
  assignmentId?: string;
  label: string;
  amountDecimal: string;
  currency: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsCheckoutChargeMarkPaidCommand = {
  propertyId: string;
  guestBookingId: string;
  chargeId: string;
  commandId: string;
  idempotencyKey: string;
  audit: PmsOperationsCommandAudit;
};

export type PmsCheckoutChargeWaiveCommand = PmsCheckoutChargeMarkPaidCommand & {
  reason?: string;
};

export type PmsAssignmentCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  reservation: PmsOperationalReservation;
  commandMeta: PmsCommandMeta;
};

export type PmsOperationsCommandResponse = PmsAssignmentCommandResponse;

export type PmsRoomTypeCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: PmsRoomType;
  commandMeta: PmsCommandMeta;
};

export type PmsRoomBlockCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoomBlockSummary[];
  commandMeta: PmsCommandMeta;
};

export type PmsAdditionalGuestsResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  items: readonly BookingGuestPii[];
};

export type PmsAdditionalGuestCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  additionalGuest: BookingGuestPii;
  reservation: PmsOperationalReservationDetail;
  commandMeta: BookingGuestPiiCommandMeta;
};

export type PmsAdditionalGuestDeleteResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  guestId: string;
  reservation: PmsOperationalReservationDetail;
  commandMeta: BookingGuestPiiCommandMeta;
};

export type PmsPrivateNotesResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  items: PmsPrivateNote[];
};

export type PmsPrivateNoteCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  note: PmsPrivateNote;
  commandMeta: PmsCommandMeta;
};

export type PmsPrivateNoteDeleteResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  noteId: string;
  commandMeta: PmsCommandMeta;
};

export type PmsOperationalTemplateResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  template: PmsOperationalTemplate;
};

export type PmsOperationalTemplateCommandResponse = PmsOperationalTemplateResponse & {
  commandMeta: PmsCommandMeta;
};

export type PmsCheckoutChargesResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  items: PmsCheckoutCharge[];
};

export type PmsCheckoutChargeCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  charge: PmsCheckoutCharge;
  commandMeta: PmsCommandMeta;
};

export type PmsCheckOutCommandResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  guestBookingId: string;
  reservation: PmsOperationalReservation;
  checkout: PmsCheckOutRecord;
  charges: PmsCheckoutCharge[];
  commandMeta: PmsCommandMeta;
};

export type PmsAssignmentCommandConflictCode =
  | "version_conflict"
  | "room_unavailable"
  | "assignment_conflict"
  | "idempotency_conflict";

export type PmsAssignmentCommandResult =
  | {
      ok: true;
      reservation: PmsOperationalReservation;
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 404;
      code: "reservation_not_found";
      message: string;
    }
  | {
      ok: false;
      statusCode: 409;
      code: PmsAssignmentCommandConflictCode;
      message: string;
    };

export type PmsOperationalCommandResult =
  | {
      ok: true;
      reservation: PmsOperationalReservation;
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 400;
      code: "invalid_body" | "invalid_status_transition";
      message: string;
    }
  | {
      ok: false;
      statusCode: 404;
      code: "reservation_not_found";
      message: string;
    }
  | {
      ok: false;
      statusCode: 409;
      code: "version_conflict" | "idempotency_conflict" | "room_unavailable";
      message: string;
    };

export type PmsPrivateNoteCommandResult =
  | {
      ok: true;
      note: PmsPrivateNote;
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 404 | 409;
      code: "reservation_not_found" | "note_not_found" | "idempotency_conflict";
      message: string;
    };

export type PmsPrivateNoteDeleteResult =
  | {
      ok: true;
      noteId: string;
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 404 | 409;
      code: "reservation_not_found" | "note_not_found" | "idempotency_conflict";
      message: string;
    };

export type PmsOperationalTemplateCommandResult =
  | {
      ok: true;
      template: PmsOperationalTemplate;
      commandMeta: PmsCommandMeta;
    }
  | {
      ok: false;
      statusCode: 409;
      code: "idempotency_conflict";
      message: string;
    };

export type PmsCheckoutChargeCommandResult =
  | {
      ok: true;
      charge: PmsCheckoutCharge;
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 400;
      code: "invalid_body" | "invalid_status_transition";
      message: string;
    }
  | {
      ok: false;
      statusCode: 404;
      code: "reservation_not_found" | "charge_not_found";
      message: string;
    }
  | {
      ok: false;
      statusCode: 409;
      code: "idempotency_conflict";
      message: string;
    };

export type PmsCheckOutCommandResult =
  | {
      ok: true;
      reservation: PmsOperationalReservation;
      checkout: PmsCheckOutRecord;
      charges: PmsCheckoutCharge[];
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 400;
      code: "invalid_body" | "invalid_status_transition";
      message: string;
    }
  | {
      ok: false;
      statusCode: 404;
      code: "reservation_not_found" | "charge_not_found";
      message: string;
    }
  | {
      ok: false;
      statusCode: 409;
      code: "version_conflict" | "idempotency_conflict";
      message: string;
    };

export type PmsRoomTypeCommandResult =
  | {
      ok: true;
      roomType: PmsRoomType;
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 400;
      code: "invalid_body";
      message: string;
    }
  | {
      ok: false;
      statusCode: 404;
      code: "room_type_not_found";
      message: string;
    }
  | {
      ok: false;
      statusCode: 409;
      code: "idempotency_conflict" | "room_type_conflict";
      message: string;
    };

export type PmsRoomBlockCommandResult =
  | {
      ok: true;
      items: PmsRoomBlockSummary[];
      commandMeta: PmsCommandMeta;
      replayed?: boolean;
    }
  | {
      ok: false;
      statusCode: 404 | 409 | 500;
      code:
        | "room_block_not_found"
        | "room_block_conflict"
        | "version_conflict"
        | "idempotency_conflict"
        | "side_effect_failed";
      message: string;
    };

export type PmsOperationsCommandRepository = {
  createRoomBlocks?(command: PmsRoomBlockCreateCommand): Promise<PmsRoomBlockCommandResult>;
  updateRoomBlock?(command: PmsRoomBlockUpdateCommand): Promise<PmsRoomBlockCommandResult>;
  releaseRoomBlock?(command: PmsRoomBlockReleaseCommand): Promise<PmsRoomBlockCommandResult>;
  createRoomType(command: PmsRoomTypeCreateCommand): Promise<PmsRoomTypeCommandResult>;
  updateRoomTypeLocation(command: PmsRoomTypeUpdateCommand): Promise<PmsRoomTypeCommandResult>;
  executeAssignmentCommand(command: PmsAssignmentCommand): Promise<PmsAssignmentCommandResult>;
  executeOperationalStatusCommand(
    command: PmsOperationalStatusCommand,
  ): Promise<PmsOperationalCommandResult>;
  executeCheckInCommand(command: PmsCheckInCommand): Promise<PmsOperationalCommandResult>;
  executeNoShowCommand(command: PmsNoShowCommand): Promise<PmsOperationalCommandResult>;
  cancelManualBooking?(command: PmsManualCancellationCommand): Promise<PmsOperationalCommandResult>;
  refundManualBooking?(command: PmsManualRefundCommand): Promise<PmsOperationalCommandResult>;
  correctManualBookingStays?(
    command: PmsManualStayCorrectionCommand,
  ): Promise<PmsOperationalCommandResult>;
  correctManualBookingPrices?(
    command: PmsManualPriceCorrectionCommand,
  ): Promise<PmsOperationalCommandResult>;
  acceptBooking(command: PmsBookingLifecycleCommand): Promise<PmsOperationalCommandResult>;
  markBookingPaid(command: PmsBookingLifecycleCommand): Promise<PmsOperationalCommandResult>;
  listPrivateNotes(propertyId: string, guestBookingId: string): Promise<PmsPrivateNote[] | null>;
  createPrivateNote(command: PmsPrivateNoteCreateCommand): Promise<PmsPrivateNoteCommandResult>;
  deletePrivateNote(command: PmsPrivateNoteDeleteCommand): Promise<PmsPrivateNoteDeleteResult>;
  getOperationalTemplate(
    propertyId: string,
    templateKind: PmsOperationalTemplateKind,
  ): Promise<PmsOperationalTemplate>;
  updateOperationalTemplate(
    command: PmsOperationalTemplateUpdateCommand,
  ): Promise<PmsOperationalTemplateCommandResult>;
  listCheckoutCharges(
    propertyId: string,
    guestBookingId: string,
  ): Promise<PmsCheckoutCharge[] | null>;
  createCheckoutCharge(
    command: PmsCheckoutChargeCreateCommand,
  ): Promise<PmsCheckoutChargeCommandResult>;
  markCheckoutChargePaid(
    command: PmsCheckoutChargeMarkPaidCommand,
  ): Promise<PmsCheckoutChargeCommandResult>;
  waiveCheckoutCharge(
    command: PmsCheckoutChargeWaiveCommand,
  ): Promise<PmsCheckoutChargeCommandResult>;
  executeCheckOutCommand(command: PmsCheckOutCommand): Promise<PmsCheckOutCommandResult>;
  close?(): Promise<void>;
};

export type PmsOperationsRoutesOptions = {
  repository: PmsOperationsReadRepository;
  checkoutChargeMarkPaidFreezeEnabled?: boolean;
  commandRepository?: PmsOperationsCommandRepository;
  resolveOnboardingRoomCurrency?: (propertyId: string) => Promise<string | null>;
  bookingGuestPiiPort?: BookingGuestPiiPort;
  inventoryPublicOfferProjector?: PmsInventoryPublicOfferProjectionPort;
  allowedOrigins?: string[];
  propertyPlanReadRepository?: PropertyPlanReadRepository;
  bookingAcceptanceSettings?: BookingAcceptanceSettingsPort;
  publicBookabilityPublisher?: PublicBookabilityPublicationCommandPort;
};

type PmsPropertyParams = {
  propertyId: string;
};

type PmsRoomTypeParams = PmsPropertyParams & {
  roomTypeId: string;
};

type PmsRoomBlockParams = PmsPropertyParams & {
  blockId: string;
};

type PmsReservationParams = PmsPropertyParams & {
  guestBookingId: string;
};

type PmsPrivateNoteParams = PmsReservationParams & {
  noteId: string;
};

type PmsAdditionalGuestParams = PmsReservationParams & {
  guestId: string;
};

type PmsCheckoutChargeParams = PmsReservationParams & {
  chargeId: string;
};

type PmsCalendarQuery = {
  from?: string;
  to?: string;
};

type PmsRoomBlocksQuery = {
  from?: string;
  to?: string;
};

type PmsReservationListQuery = {
  status?: string;
  arrivalFrom?: string;
  arrivalTo?: string;
  stayFrom?: string;
  stayTo?: string;
  search?: string;
  limit?: string;
  offset?: string;
};

type PmsCheckoutChargeMarkPaidBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
};

type PmsCheckoutChargeCommandBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  assignmentId?: unknown;
  label?: unknown;
  amountDecimal?: unknown;
  amount?: unknown;
  currency?: unknown;
  reason?: unknown;
};

type PmsCheckOutCommandBody = {
  commandId?: unknown;
  idempotencyKey?: unknown;
  expectedVersion?: unknown;
  assignmentId?: unknown;
  inspectionResults?: unknown;
  chargesSettled?: unknown;
  pendingFlags?: unknown;
  checkoutNotes?: unknown;
};

type PmsOperationsErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "conflict"
  | "read_model"
  | "side_effect"
  | "not_found";

type PmsOperationsErrorCode =
  | "unauthenticated"
  | "invalid_token"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_query"
  | "invalid_body"
  | "invalid_date_range"
  | "invalid_status_transition"
  | "invalid_guest_pii"
  | "finance_bridge_required"
  | PmsAssignmentCommandConflictCode
  | "property_currency_conflict"
  | "room_type_conflict"
  | "room_photo_plan_limit_reached"
  | "read_model_unavailable"
  | "room_type_not_found"
  | "room_block_not_found"
  | "room_block_conflict"
  | "side_effect_failed"
  | "reservation_not_found"
  | "additional_guest_not_found"
  | "note_not_found"
  | "charge_not_found"
  | "property_not_found";

type PmsOperationsError = {
  statusCode: 400 | 401 | 403 | 404 | 409 | 500;
  code: PmsOperationsErrorCode;
  category: PmsOperationsErrorCategory;
  message: string;
};

type PmsOperationsAuthorizationErrorCode =
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access";

export async function registerPmsOperationsRoutes(
  app: FastifyInstance,
  options: PmsOperationsRoutesOptions,
): Promise<void> {
  const { repository, commandRepository, bookingGuestPiiPort } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
    await commandRepository?.close?.();
    await bookingGuestPiiPort?.close?.();
    await options.propertyPlanReadRepository?.close?.();
    await options.bookingAcceptanceSettings?.close?.();
  });

  for (const path of [
    "/properties",
    "/properties/:propertyId/rooms",
    "/properties/:propertyId/room-types",
    "/properties/:propertyId/room-types/:roomTypeId",
    "/properties/:propertyId/plan-limits",
    "/properties/:propertyId/calendar",
    "/properties/:propertyId/room-blocks",
    "/properties/:propertyId/room-blocks/:blockId",
    "/properties/:propertyId/payment-settings",
    "/properties/:propertyId/profile",
    "/properties/:propertyId/calendar-settings",
    "/properties/:propertyId/booking-acceptance",
    "/properties/:propertyId/channex/status",
    "/properties/:propertyId/channex/channels",
    "/properties/:propertyId/messaging/unread-count",
    "/properties/:propertyId/reservations",
    "/properties/:propertyId/reservations/:guestBookingId",
    "/properties/:propertyId/reservations/:guestBookingId/notes",
    "/properties/:propertyId/reservations/:guestBookingId/notes/:noteId",
    "/properties/:propertyId/reservations/:guestBookingId/additional-guests",
    "/properties/:propertyId/reservations/:guestBookingId/additional-guests/:guestId",
    "/properties/:propertyId/check-in-checklist",
    "/properties/:propertyId/check-out-inspection",
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges",
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/mark-paid",
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/waive",
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/paid",
    "/properties/:propertyId/reservations/:guestBookingId/check-out",
    "/properties/:propertyId/reservations/:guestBookingId/assignments",
    "/properties/:propertyId/reservations/:guestBookingId/status",
    "/properties/:propertyId/reservations/:guestBookingId/check-in",
    "/properties/:propertyId/reservations/:guestBookingId/accept",
    "/properties/:propertyId/reservations/:guestBookingId/mark-paid",
    "/properties/:propertyId/reservations/:guestBookingId/no-show",
    "/properties/:propertyId/reservations/:guestBookingId/cancel",
    "/properties/:propertyId/reservations/:guestBookingId/correct-stays",
    "/properties/:propertyId/reservations/:guestBookingId/correct-prices",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      return reply.code(204).send();
    });
  }

  app.get("/properties", async (request, reply) => {
    if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
      return sendPmsOperationsError(reply, {
        statusCode: 403,
        code: "missing_permission",
        category: "authorization",
        message: "PMS operations origin is not allowed.",
      });
    }

    if (!enforcePmsOperationsListPolicy(request, reply)) return reply;
    return sendPmsOperationsError(
      reply,
      readModelUnavailable("PMS property summary read model is unavailable."),
    );
  });

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/plan-limits",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;
      if (!options.propertyPlanReadRepository) {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("Property plan read model is unavailable."),
        );
      }
      try {
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          propertyPlan: await options.propertyPlanReadRepository.getPropertyPlan(propertyId),
        } satisfies PmsPropertyPlanResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("Property plan read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/rooms",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const result = await repository.listRoomsByPropertyId(propertyId);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomsResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS rooms read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/room-types",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const result = await repository.listRoomTypesByPropertyId(propertyId);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomTypesResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room types read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsRoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId, roomTypeId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const item = await repository.findRoomTypeById(propertyId, roomTypeId);
        if (!item) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "room_type_not_found",
            category: "not_found",
            message: "PMS room type not found.",
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          item,
          sourceFreshness: {},
        } satisfies PmsRoomTypeDetailResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room types read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams; Querystring: PmsCalendarQuery }>(
    "/properties/:propertyId/calendar",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      const range = toCalendarRange(request.query);
      if ("error" in range) return sendPmsOperationsError(reply, range.error);

      try {
        const result = await repository.listCalendarDaysByPropertyId(propertyId, range.value);
        if (!result.items.every(hasBalancedCalendarCounts)) {
          return sendPmsOperationsError(
            reply,
            readModelUnavailable("PMS calendar read model is unavailable."),
          );
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          days: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsCalendarResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS calendar read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams; Querystring: PmsRoomBlocksQuery }>(
    "/properties/:propertyId/room-blocks",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      const range = toOptionalDateRange(request.query);
      if ("error" in range) return sendPmsOperationsError(reply, range.error);

      try {
        const result = await repository.listRoomBlocksByPropertyId(propertyId, range.value);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomBlocksResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room blocks read model is unavailable."),
        );
      }
    },
  );

  if (
    commandRepository?.createRoomBlocks &&
    commandRepository.updateRoomBlock &&
    commandRepository.releaseRoomBlock
  ) {
    app.post<{ Params: PmsPropertyParams; Body: unknown }>(
      "/properties/:propertyId/room-blocks",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, originNotAllowed());
        }
        const { propertyId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        const command = toRoomBlockCreateCommand(propertyId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        const result = await commandRepository.createRoomBlocks!(command.value);
        if (!result.ok) return sendPmsRoomBlockCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          commandMeta: result.commandMeta,
        } satisfies PmsRoomBlockCommandResponse;
      },
    );

    app.patch<{ Params: PmsRoomBlockParams; Body: unknown }>(
      "/properties/:propertyId/room-blocks/:blockId",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, originNotAllowed());
        }
        const { propertyId, blockId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        const command = toRoomBlockUpdateCommand(propertyId, blockId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        const result = await commandRepository.updateRoomBlock!(command.value);
        if (!result.ok) return sendPmsRoomBlockCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          commandMeta: result.commandMeta,
        } satisfies PmsRoomBlockCommandResponse;
      },
    );

    app.delete<{ Params: PmsRoomBlockParams; Body: unknown }>(
      "/properties/:propertyId/room-blocks/:blockId",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, originNotAllowed());
        }
        const { propertyId, blockId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        const command = toRoomBlockReleaseCommand(propertyId, blockId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        const result = await commandRepository.releaseRoomBlock!(command.value);
        if (!result.ok) return sendPmsRoomBlockCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          commandMeta: result.commandMeta,
        } satisfies PmsRoomBlockCommandResponse;
      },
    );
  }

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/profile",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;
      return sendPmsOperationsError(
        reply,
        readModelUnavailable("PMS property profile read model is unavailable."),
      );
    },
  );

  app.patch<{ Params: PmsPropertyParams; Body: unknown }>(
    "/properties/:propertyId/profile",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
      return sendPmsOperationsError(
        reply,
        readModelUnavailable("PMS property profile write model is unavailable."),
      );
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/booking-acceptance",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;
      try {
        const acceptanceMode =
          await options.bookingAcceptanceSettings?.findAcceptanceMode(propertyId);
        if (!acceptanceMode) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "property_not_found",
            category: "not_found",
            message: "Booking acceptance settings were not found.",
          });
        }
        return bookingAcceptanceResponse(propertyId, acceptanceMode);
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("Booking acceptance settings are unavailable."),
        );
      }
    },
  );

  app.put<{ Params: PmsPropertyParams; Body: unknown }>(
    "/properties/:propertyId/booking-acceptance",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
      const body = request.body;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !isBookingAcceptanceMode((body as Record<string, unknown>)["acceptanceMode"])
      ) {
        return sendPmsOperationsError(
          reply,
          invalidBody("acceptanceMode must be either instant or request."),
        );
      }
      try {
        const acceptanceMode = await options.bookingAcceptanceSettings?.updateAcceptanceMode(
          propertyId,
          (body as { acceptanceMode: "instant" | "request" }).acceptanceMode,
        );
        if (!acceptanceMode) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "property_not_found",
            category: "not_found",
            message: "Booking acceptance settings were not found.",
          });
        }
        await options.publicBookabilityPublisher?.publish({ propertyId });
        return bookingAcceptanceResponse(propertyId, acceptanceMode);
      } catch (error) {
        request.log.error({ err: error, propertyId }, "Booking acceptance settings update failed");
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("Booking acceptance settings could not be saved."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/calendar-settings",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;
      return sendPmsOperationsError(
        reply,
        readModelUnavailable("PMS calendar settings read model is unavailable."),
      );
    },
  );

  app.patch<{ Params: PmsPropertyParams; Body: unknown }>(
    "/properties/:propertyId/calendar-settings",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
      return sendPmsOperationsError(
        reply,
        readModelUnavailable("PMS calendar settings write model is unavailable."),
      );
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/channex/status",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;
      return sendPmsOperationsError(
        reply,
        readModelUnavailable("PMS Channex status read model is unavailable."),
      );
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/channex/channels",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;
      return sendPmsOperationsError(
        reply,
        readModelUnavailable("PMS Channex channels read model is unavailable."),
      );
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/messaging/unread-count",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;
      return sendPmsOperationsError(
        reply,
        readModelUnavailable("PMS messaging unread count read model is unavailable."),
      );
    },
  );

  app.get<{ Params: PmsPropertyParams; Querystring: PmsReservationListQuery }>(
    "/properties/:propertyId/reservations",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      const filters = toReservationFilters(request.query);
      if ("error" in filters) return sendPmsOperationsError(reply, filters.error);
      const stayRange = toReservationStayRange(request.query);
      if ("error" in stayRange) return sendPmsOperationsError(reply, stayRange.error);
      if (stayRange.value && hasReservationListFilters(filters.value)) {
        return sendPmsOperationsError(reply, invalidReservationQueryError());
      }

      try {
        const result = stayRange.value
          ? paginateReservationResult(
              await listCalendarReservationsOverlappingStayRange(
                repository,
                propertyId,
                stayRange.value,
              ),
              filters.value.limit,
              filters.value.offset,
            )
          : await repository.listReservationsByPropertyId(propertyId, filters.value);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          pagination: {
            total: result.total,
            limit: filters.value.limit,
            offset: filters.value.offset,
          },
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsReservationListResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS reservations read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsReservationParams }>(
    "/properties/:propertyId/reservations/:guestBookingId",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId, guestBookingId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const item = await repository.findReservationByGuestBookingId(propertyId, guestBookingId);
        if (!item) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "reservation_not_found",
            category: "not_found",
            message: "PMS reservation not found.",
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          item: await withAdditionalGuestProjection(
            item,
            bookingGuestPiiPort,
            propertyId,
            guestBookingId,
          ),
          sourceFreshness: {},
        } satisfies PmsReservationDetailResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS reservations read model is unavailable."),
        );
      }
    },
  );

  if (bookingGuestPiiPort) {
    app.get<{ Params: PmsReservationParams }>(
      "/properties/:propertyId/reservations/:guestBookingId/additional-guests",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

        const projection = await bookingGuestPiiPort.listGuestPiiForPmsOperations({
          propertyId,
          guestBookingId,
        });
        if (!projection) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "reservation_not_found",
            category: "not_found",
            message: "PMS reservation not found.",
          });
        }
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          items: projection.additionalGuests,
        } satisfies PmsAdditionalGuestsResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/additional-guests",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toAdditionalGuestCreateCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await bookingGuestPiiPort.createAdditionalGuestForPmsOperations(
          command.value,
        );
        if (!result.ok) return sendBookingGuestPiiCommandError(reply, result);

        const reservation = await reservationWithAdditionalGuestProjection(
          repository,
          propertyId,
          guestBookingId,
          result.projection,
        );
        if (!reservation) return sendPmsOperationsError(reply, reservationNotFoundError());

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          additionalGuest: result.additionalGuest,
          reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsAdditionalGuestCommandResponse;
      },
    );

    app.patch<{ Params: PmsAdditionalGuestParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/additional-guests/:guestId",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId, guestId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toAdditionalGuestUpdateCommand(
          propertyId,
          guestBookingId,
          guestId,
          request,
        );
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await bookingGuestPiiPort.updateAdditionalGuestForPmsOperations(
          command.value,
        );
        if (!result.ok) return sendBookingGuestPiiCommandError(reply, result);

        const reservation = await reservationWithAdditionalGuestProjection(
          repository,
          propertyId,
          guestBookingId,
          result.projection,
        );
        if (!reservation) return sendPmsOperationsError(reply, reservationNotFoundError());

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          additionalGuest: result.additionalGuest,
          reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsAdditionalGuestCommandResponse;
      },
    );

    app.delete<{ Params: PmsAdditionalGuestParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/additional-guests/:guestId",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId, guestId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toAdditionalGuestDeleteCommand(
          propertyId,
          guestBookingId,
          guestId,
          request,
        );
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await bookingGuestPiiPort.deleteAdditionalGuestForPmsOperations(
          command.value,
        );
        if (!result.ok) return sendBookingGuestPiiCommandError(reply, result);

        const reservation = await reservationWithAdditionalGuestProjection(
          repository,
          propertyId,
          guestBookingId,
          result.projection,
        );
        if (!reservation) return sendPmsOperationsError(reply, reservationNotFoundError());

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          guestId: result.guestId,
          reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsAdditionalGuestDeleteResponse;
      },
    );
  }

  async function handleCheckoutChargeMarkPaid(
    request: FastifyRequest<{
      Params: PmsCheckoutChargeParams;
      Body: PmsCheckoutChargeMarkPaidBody;
    }>,
    reply: FastifyReply,
  ): Promise<FastifyReply | PmsCheckoutChargeCommandResponse> {
    if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
      return sendPmsOperationsError(reply, {
        statusCode: 403,
        code: "missing_permission",
        category: "authorization",
        message: "PMS operations origin is not allowed.",
      });
    }
    const { propertyId, guestBookingId, chargeId } = request.params;
    if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

    const commandInput = toCheckoutChargeMarkPaidCommandMetadata(request.body);
    if ("error" in commandInput) return sendPmsOperationsError(reply, commandInput.error);

    const freezeEnabled = options.checkoutChargeMarkPaidFreezeEnabled ?? true;
    if (freezeEnabled) {
      return sendPmsOperationsError(reply, {
        statusCode: 409,
        code: "finance_bridge_required",
        category: "conflict",
        message: "Finance settlement bridge is required before marking checkout charges paid.",
      });
    }
    if (!isUuid(chargeId))
      return sendPmsOperationsError(reply, invalidBody("chargeId must be a UUID."));

    if (!commandRepository) {
      return sendPmsOperationsError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message:
          "PMS checkout charge mark-paid must be wired to a durable command service before the freeze can be disabled.",
      });
    }

    const result = await commandRepository.markCheckoutChargePaid({
      propertyId,
      guestBookingId,
      chargeId,
      ...commandInput.value,
      audit: pmsOperationsCommandAudit(
        request,
        commandInput.value.commandId,
        "Mark checkout charge paid",
      ),
    });
    if (!result.ok) return sendPmsCheckoutChargeCommandError(reply, result);

    return {
      contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
      propertyId,
      guestBookingId,
      charge: result.charge,
      commandMeta: result.commandMeta,
    } satisfies PmsCheckoutChargeCommandResponse;
  }

  app.post<{ Params: PmsCheckoutChargeParams; Body: PmsCheckoutChargeMarkPaidBody }>(
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/paid",
    handleCheckoutChargeMarkPaid,
  );

  app.post<{ Params: PmsCheckoutChargeParams; Body: PmsCheckoutChargeMarkPaidBody }>(
    "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/mark-paid",
    handleCheckoutChargeMarkPaid,
  );

  if (commandRepository) {
    app.post<{ Params: PmsPropertyParams; Body: unknown }>(
      "/properties/:propertyId/room-types",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        let currencyOverride: string | undefined;
        const requestBody = objectBody(request.body);
        if (requestBody?.onboardingSetup === true) {
          try {
            currencyOverride =
              (await options.resolveOnboardingRoomCurrency?.(propertyId)) ?? undefined;
          } catch (error) {
            request.log.error({ error, propertyId }, "Onboarding room currency resolution failed");
          }
          if (!currencyOverride) {
            return sendPmsOperationsError(reply, {
              statusCode: 500,
              code: "read_model_unavailable",
              category: "read_model",
              message: "Property currency is unavailable for onboarding room setup.",
            });
          }
          const submittedCurrency = stringField(requestBody.currency)?.toUpperCase();
          if (submittedCurrency && submittedCurrency !== currencyOverride.toUpperCase()) {
            return sendPmsOperationsError(reply, {
              statusCode: 409,
              code: "property_currency_conflict",
              category: "conflict",
              message: "Property currency changed. Review the nightly rate and try again.",
            });
          }
        }

        const command = toRoomTypeCreateCommand(propertyId, request, currencyOverride);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        if (options.propertyPlanReadRepository) {
          try {
            const propertyPlan =
              await options.propertyPlanReadRepository.getPropertyPlan(propertyId);
            if (command.value.media.length > propertyPlan.limits.maxRoomPhotosPerType) {
              return sendPmsOperationsError(reply, {
                statusCode: 409,
                code: "room_photo_plan_limit_reached",
                category: "conflict",
                message:
                  propertyPlan.plan === "commission"
                    ? `You've reached the ${propertyPlan.limits.maxRoomPhotosPerType}-photo limit. Upgrade to the paid plan for up to ${PROPERTY_FEATURE_LIMITS.fixed.maxRoomPhotosPerType} photos per room.`
                    : `You've reached the ${propertyPlan.limits.maxRoomPhotosPerType}-photo limit for the paid plan.`,
              });
            }
          } catch {
            return sendPmsOperationsError(
              reply,
              readModelUnavailable("Property plan read model is unavailable."),
            );
          }
        }

        const result = await commandRepository.createRoomType(command.value);
        if (!result.ok) return sendPmsRoomTypeCommandError(reply, result);

        if (options.inventoryPublicOfferProjector) {
          try {
            await options.inventoryPublicOfferProjector.projectPending({
              propertyId,
            });
          } catch (error) {
            request.log.error(
              { error, propertyId, roomTypeId: result.roomType.roomTypeId },
              "PMS inventory public-offer projection remains pending",
            );
          }
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          item: result.roomType,
          commandMeta: result.commandMeta,
        } satisfies PmsRoomTypeCommandResponse;
      },
    );

    app.patch<{ Params: PmsRoomTypeParams; Body: unknown }>(
      "/properties/:propertyId/room-types/:roomTypeId",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, roomTypeId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toRoomTypeUpdateCommand(propertyId, roomTypeId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.updateRoomTypeLocation(command.value);
        if (!result.ok) return sendPmsRoomTypeCommandError(reply, result);

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          item: result.roomType,
          commandMeta: result.commandMeta,
        } satisfies PmsRoomTypeCommandResponse;
      },
    );

    app.get<{ Params: PmsReservationParams }>(
      "/properties/:propertyId/reservations/:guestBookingId/checkout-charges",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

        try {
          const charges = await commandRepository.listCheckoutCharges(propertyId, guestBookingId);
          if (!charges) return sendPmsOperationsError(reply, reservationNotFoundError());

          return {
            contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
            propertyId,
            guestBookingId,
            items: charges,
          } satisfies PmsCheckoutChargesResponse;
        } catch {
          return sendPmsOperationsError(
            reply,
            readModelUnavailable("PMS checkout charges read model is unavailable."),
          );
        }
      },
    );

    app.post<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/checkout-charges",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toCheckoutChargeCreateCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.createCheckoutCharge(command.value);
        if (!result.ok) return sendPmsCheckoutChargeCommandError(reply, result);

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          charge: result.charge,
          commandMeta: result.commandMeta,
        } satisfies PmsCheckoutChargeCommandResponse;
      },
    );

    app.post<{ Params: PmsCheckoutChargeParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/checkout-charges/:chargeId/waive",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId, chargeId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toCheckoutChargeWaiveCommand(propertyId, guestBookingId, chargeId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.waiveCheckoutCharge(command.value);
        if (!result.ok) return sendPmsCheckoutChargeCommandError(reply, result);

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          charge: result.charge,
          commandMeta: result.commandMeta,
        } satisfies PmsCheckoutChargeCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Body: PmsCheckOutCommandBody }>(
      "/properties/:propertyId/reservations/:guestBookingId/check-out",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toCheckOutCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.executeCheckOutCommand(command.value);
        if (!result.ok) return sendPmsCheckOutCommandError(reply, result);

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          reservation: result.reservation,
          checkout: result.checkout,
          charges: result.charges,
          commandMeta: result.commandMeta,
        } satisfies PmsCheckOutCommandResponse;
      },
    );
  }

  if (commandRepository) {
    for (const templateRoute of [
      {
        path: "/properties/:propertyId/check-in-checklist",
        templateKind: "check_in_checklist",
        unavailableMessage: "PMS check-in checklist template read model is unavailable.",
      },
      {
        path: "/properties/:propertyId/check-out-inspection",
        templateKind: "check_out_inspection",
        unavailableMessage: "PMS check-out inspection template read model is unavailable.",
      },
    ] as const) {
      app.get<{ Params: PmsPropertyParams }>(templateRoute.path, async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId } = request.params;
        if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

        try {
          const template = await commandRepository.getOperationalTemplate(
            propertyId,
            templateRoute.templateKind,
          );
          return {
            contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
            propertyId,
            template,
          } satisfies PmsOperationalTemplateResponse;
        } catch {
          return sendPmsOperationsError(
            reply,
            readModelUnavailable(templateRoute.unavailableMessage),
          );
        }
      });

      app.put<{ Params: PmsPropertyParams; Body: unknown }>(
        templateRoute.path,
        async (request, reply) => {
          if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
            return sendPmsOperationsError(reply, {
              statusCode: 403,
              code: "missing_permission",
              category: "authorization",
              message: "PMS operations origin is not allowed.",
            });
          }
          const { propertyId } = request.params;
          if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

          const command = toOperationalTemplateUpdateCommand(
            propertyId,
            templateRoute.templateKind,
            request,
          );
          if ("error" in command) return sendPmsOperationsError(reply, command.error);

          const result = await commandRepository.updateOperationalTemplate(command.value);
          if (!result.ok) {
            return sendPmsOperationsError(reply, {
              statusCode: result.statusCode,
              code: result.code,
              category: "conflict",
              message: result.message,
            });
          }

          return {
            contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
            propertyId,
            template: result.template,
            commandMeta: result.commandMeta,
          } satisfies PmsOperationalTemplateCommandResponse;
        },
      );
    }

    app.get<{ Params: PmsReservationParams }>(
      "/properties/:propertyId/reservations/:guestBookingId/notes",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

        try {
          const notes = await commandRepository.listPrivateNotes(propertyId, guestBookingId);
          if (!notes) {
            return sendPmsOperationsError(reply, {
              statusCode: 404,
              code: "reservation_not_found",
              category: "not_found",
              message: "PMS reservation not found.",
            });
          }

          return {
            contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
            propertyId,
            guestBookingId,
            items: notes,
          } satisfies PmsPrivateNotesResponse;
        } catch {
          return sendPmsOperationsError(
            reply,
            readModelUnavailable("PMS private notes read model is unavailable."),
          );
        }
      },
    );

    app.post<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/notes",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toPrivateNoteCreateCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.createPrivateNote(command.value);
        if (!result.ok) {
          return sendPmsOperationsError(reply, {
            statusCode: result.statusCode,
            code: result.code,
            category: result.statusCode === 404 ? "not_found" : "conflict",
            message: result.message,
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          note: result.note,
          commandMeta: result.commandMeta,
        } satisfies PmsPrivateNoteCommandResponse;
      },
    );

    app.delete<{ Params: PmsPrivateNoteParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/notes/:noteId",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId, noteId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toPrivateNoteDeleteCommand(propertyId, guestBookingId, noteId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.deletePrivateNote(command.value);
        if (!result.ok) {
          return sendPmsOperationsError(reply, {
            statusCode: result.statusCode,
            code: result.code,
            category: result.statusCode === 404 ? "not_found" : "conflict",
            message: result.message,
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          guestBookingId,
          noteId: result.noteId,
          commandMeta: result.commandMeta,
        } satisfies PmsPrivateNoteDeleteResponse;
      },
    );

    app.patch<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/assignments",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toAssignmentCommand(propertyId, guestBookingId, request.body);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.executeAssignmentCommand(command.value);
        if (!result.ok) {
          return sendPmsOperationsError(reply, {
            statusCode: result.statusCode,
            code: result.code,
            category: result.statusCode === 404 ? "not_found" : "conflict",
            message: result.message,
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.patch<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/status",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toOperationalStatusCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.executeOperationalStatusCommand(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/accept",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        const command = toBookingLifecycleCommand(
          propertyId,
          guestBookingId,
          request,
          "Accept booking",
        );
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        const result = await commandRepository.acceptBooking(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/mark-paid",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        const command = toBookingLifecycleCommand(
          propertyId,
          guestBookingId,
          request,
          "Mark booking paid",
        );
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        const result = await commandRepository.markBookingPaid(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/check-in",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toCheckInCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.executeCheckInCommand(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/no-show",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;

        const command = toNoShowCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);

        const result = await commandRepository.executeNoShowCommand(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Querystring: unknown; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/cancel",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        }
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        if (
          requestsRetainedCharge(request.body) &&
          !enforcePmsFinanceManagePolicy(request, reply, propertyId)
        )
          return reply;
        const command = toManualCancellationCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        if (!commandRepository.cancelManualBooking)
          return sendPmsOperationsError(
            reply,
            readModelUnavailable("Cancellation is unavailable."),
          );
        const result = await commandRepository.cancelManualBooking(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Querystring: unknown; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/refund",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? []))
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        if (!enforcePmsFinanceManagePolicy(request, reply, propertyId)) return reply;
        const command = toManualRefundCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        if (!commandRepository.refundManualBooking)
          return sendPmsOperationsError(reply, readModelUnavailable("Refund is unavailable."));
        const result = await commandRepository.refundManualBooking(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Querystring: unknown; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/correct-stays",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? []))
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        const command = toManualStayCorrectionCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        if (!commandRepository.correctManualBookingStays)
          return sendPmsOperationsError(
            reply,
            readModelUnavailable("Manual stay correction is unavailable."),
          );
        const result = await commandRepository.correctManualBookingStays(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );

    app.post<{ Params: PmsReservationParams; Querystring: unknown; Body: unknown }>(
      "/properties/:propertyId/reservations/:guestBookingId/correct-prices",
      async (request, reply) => {
        if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? []))
          return sendPmsOperationsError(reply, {
            statusCode: 403,
            code: "missing_permission",
            category: "authorization",
            message: "PMS operations origin is not allowed.",
          });
        const { propertyId, guestBookingId } = request.params;
        if (!enforcePmsOperationsManagePolicy(request, reply, propertyId)) return reply;
        if (!enforcePmsFinanceManagePolicy(request, reply, propertyId)) return reply;
        const command = toManualPriceCorrectionCommand(propertyId, guestBookingId, request);
        if ("error" in command) return sendPmsOperationsError(reply, command.error);
        if (!commandRepository.correctManualBookingPrices)
          return sendPmsOperationsError(
            reply,
            readModelUnavailable("Manual price correction is unavailable."),
          );
        const result = await commandRepository.correctManualBookingPrices(command.value);
        if (!result.ok) return sendPmsOperationalCommandError(reply, result);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          reservation: result.reservation,
          commandMeta: result.commandMeta,
        } satisfies PmsOperationsCommandResponse;
      },
    );
  }
}

function bookingAcceptanceResponse(propertyId: string, acceptanceMode: "instant" | "request") {
  return {
    contractVersion: "booking-acceptance.v1",
    propertyId,
    acceptanceMode,
    instantBook: acceptanceMode === "instant",
  } as const;
}

async function listCalendarReservationsOverlappingStayRange(
  repository: PmsOperationsReadRepository,
  propertyId: string,
  range: { from: string; to: string },
) {
  if (repository.listReservationsOverlappingStayRangeByPropertyId) {
    return repository.listReservationsOverlappingStayRangeByPropertyId(propertyId, range);
  }

  return repository.listReservationsByPropertyId(propertyId, {
    status: undefined,
    arrivalFrom: range.from,
    arrivalTo: range.to,
    search: undefined,
    limit: PMS_RESERVATION_LIST_MAX_LIMIT,
    offset: 0,
  });
}

function paginateReservationResult(
  result: Awaited<ReturnType<PmsOperationsReadRepository["listReservationsByPropertyId"]>>,
  limit: number,
  offset: number,
) {
  return {
    ...result,
    items: result.items.slice(offset, offset + limit),
    total: result.total,
  };
}

function enforcePmsOperationsReadPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  try {
    enforceRoutePolicy(request, {
      permission: "pms.operations.read",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
    });
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, propertyId);
    if (!contractError) throw error;
    sendPmsOperationsError(reply, contractError);
    return false;
  }
}

function enforcePmsOperationsListPolicy(request: FastifyRequest, reply: FastifyReply): boolean {
  try {
    enforceRoutePolicy(request, {
      permission: "pms.operations.read",
      entitlement: {
        product: "pms",
        key: "property-management",
      },
    });
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, "");
    if (!contractError) throw error;
    sendPmsOperationsError(reply, contractError);
    return false;
  }
}

function enforcePmsOperationsManagePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  try {
    enforceRoutePolicy(request, {
      permission: "pms.operations.manage",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
    });
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, propertyId);
    if (!contractError) throw error;
    sendPmsOperationsError(reply, contractError);
    return false;
  }
}

function enforcePmsFinanceManagePolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  try {
    const resource = {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
    } as const;
    enforceRoutePolicy(request, {
      permission: "pms.finance.manage",
      entitlement: { product: "booking", key: "direct-booking-finance", resource },
      resource: { ...resource, allowedRelationships: ["owner", "finance_manager"] },
    });
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, propertyId);
    if (!contractError) throw error;
    sendPmsOperationsError(reply, contractError);
    return false;
  }
}

function sendPmsOperationsError(reply: FastifyReply, error: PmsOperationsError): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function sendPmsOperationalCommandError(
  reply: FastifyReply,
  result: Exclude<PmsOperationalCommandResult, { ok: true }>,
): FastifyReply {
  return sendPmsOperationsError(reply, {
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 400
        ? "validation"
        : result.statusCode === 404
          ? "not_found"
          : "conflict",
    message: result.message,
  });
}

function sendPmsCheckoutChargeCommandError(
  reply: FastifyReply,
  result: Exclude<PmsCheckoutChargeCommandResult, { ok: true }>,
): FastifyReply {
  return sendPmsOperationsError(reply, {
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 400
        ? "validation"
        : result.statusCode === 404
          ? "not_found"
          : "conflict",
    message: result.message,
  });
}

function sendPmsRoomTypeCommandError(
  reply: FastifyReply,
  result: Exclude<PmsRoomTypeCommandResult, { ok: true }>,
): FastifyReply {
  return sendPmsOperationsError(reply, {
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 400
        ? "validation"
        : result.statusCode === 404
          ? "not_found"
          : "conflict",
    message: result.message,
  });
}

function sendPmsRoomBlockCommandError(
  reply: FastifyReply,
  result: Exclude<PmsRoomBlockCommandResult, { ok: true }>,
): FastifyReply {
  return sendPmsOperationsError(reply, {
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 404
        ? "not_found"
        : result.statusCode === 500
          ? "side_effect"
          : "conflict",
    message: result.message,
  });
}

function originNotAllowed(): PmsOperationsError {
  return {
    statusCode: 403,
    code: "missing_permission",
    category: "authorization",
    message: "PMS operations origin is not allowed.",
  };
}

function sendPmsCheckOutCommandError(
  reply: FastifyReply,
  result: Exclude<PmsCheckOutCommandResult, { ok: true }>,
): FastifyReply {
  return sendPmsOperationsError(reply, {
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 400
        ? "validation"
        : result.statusCode === 404
          ? "not_found"
          : "conflict",
    message: result.message,
  });
}

function sendBookingGuestPiiCommandError(
  reply: FastifyReply,
  result: Exclude<BookingGuestPiiCommandResult | BookingGuestPiiDeleteResult, { ok: true }>,
): FastifyReply {
  return sendPmsOperationsError(reply, {
    statusCode: result.statusCode,
    code: result.code,
    category:
      result.statusCode === 400
        ? "validation"
        : result.statusCode === 404
          ? "not_found"
          : "conflict",
    message: result.message,
  });
}

function reservationNotFoundError(): PmsOperationsError {
  return {
    statusCode: 404,
    code: "reservation_not_found",
    category: "not_found",
    message: "PMS reservation not found.",
  };
}

function writePmsOperationsCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Headers", "authorization,content-type,x-hotel-id")
    .header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

function toRoomBlockCreateCommand(
  propertyId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsRoomBlockCreateCommand } | { error: PmsOperationsError } {
  const raw = objectBody(request.body);
  if (!raw) return { error: invalidBody("Room block create body must be an object.") };
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  const roomTypeId = stringField(raw.roomTypeId);
  const startsOn = stringField(raw.startsOn);
  const endsOn = stringField(raw.endsOn);
  const roomIds = [...new Set(toStringArray(raw.roomIds))];
  if (!commandId || !idempotencyKey || !roomTypeId || !startsOn || !endsOn) {
    return {
      error: invalidBody(
        "Room block create requires commandId, idempotencyKey, roomTypeId, startsOn, and endsOn.",
      ),
    };
  }
  if (!isUuid(roomTypeId) || roomIds.length === 0 || roomIds.some((id) => !isUuid(id))) {
    return { error: invalidBody("Room block create requires valid roomTypeId and roomIds.") };
  }
  if (!isDateOnly(startsOn) || !isDateOnly(endsOn) || startsOn > endsOn) {
    return { error: invalidBody("Room block create requires an ordered date range.") };
  }
  return {
    value: {
      propertyId,
      commandId,
      idempotencyKey,
      roomTypeId,
      roomIds,
      startsOn,
      endsOn,
      reason: typeof raw.reason === "string" ? raw.reason.trim() : "",
      audit: pmsOperationsCommandAudit(request, commandId, "Create room block"),
    },
  };
}

function toRoomBlockUpdateCommand(
  propertyId: string,
  blockId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsRoomBlockUpdateCommand } | { error: PmsOperationsError } {
  const raw = objectBody(request.body);
  if (!raw || !isUuid(blockId)) return { error: invalidBody("Room block update is invalid.") };
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  const expectedVersion = stringField(raw.expectedVersion);
  const startsOn = raw.startsOn === undefined ? undefined : stringField(raw.startsOn);
  const endsOn = raw.endsOn === undefined ? undefined : stringField(raw.endsOn);
  const reason = raw.reason === undefined ? undefined : String(raw.reason).trim();
  if (!commandId || !idempotencyKey || !expectedVersion) {
    return {
      error: invalidBody(
        "Room block update requires commandId, idempotencyKey, and expectedVersion.",
      ),
    };
  }
  if (startsOn === undefined && endsOn === undefined && reason === undefined) {
    return { error: invalidBody("Room block update requires at least one changed field.") };
  }
  if (
    (raw.startsOn !== undefined && (!startsOn || !isDateOnly(startsOn))) ||
    (raw.endsOn !== undefined && (!endsOn || !isDateOnly(endsOn)))
  ) {
    return { error: invalidBody("Room block update requires valid dates.") };
  }
  return {
    value: {
      propertyId,
      blockId,
      commandId,
      idempotencyKey,
      expectedVersion,
      startsOn,
      endsOn,
      reason,
      audit: pmsOperationsCommandAudit(request, commandId, "Update room block"),
    },
  };
}

function toRoomBlockReleaseCommand(
  propertyId: string,
  blockId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsRoomBlockReleaseCommand } | { error: PmsOperationsError } {
  const raw = objectBody(request.body);
  if (!raw || !isUuid(blockId)) return { error: invalidBody("Room block release is invalid.") };
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  const expectedVersion = stringField(raw.expectedVersion);
  if (!commandId || !idempotencyKey || !expectedVersion) {
    return {
      error: invalidBody(
        "Room block release requires commandId, idempotencyKey, and expectedVersion.",
      ),
    };
  }
  return {
    value: {
      propertyId,
      blockId,
      commandId,
      idempotencyKey,
      expectedVersion,
      audit: pmsOperationsCommandAudit(request, commandId, "Release room block"),
    },
  };
}

function toRoomTypeCreateCommand(
  propertyId: string,
  request: FastifyRequest<{ Body: unknown }>,
  currencyOverride?: string,
): { value: PmsRoomTypeCreateCommand } | { error: PmsOperationsError } {
  const raw = objectBody(request.body);
  if (!raw) return { error: invalidBody("Room type create body must be an object.") };

  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  const name = stringField(raw.name);
  if (!commandId || !idempotencyKey || !name) {
    return { error: invalidBody("Room type create requires commandId, idempotencyKey, and name.") };
  }

  const baseRate = roomTypeBaseRate(raw);
  if (!baseRate) return { error: invalidBody("Room type create requires a valid baseRate.") };

  const currency = (currencyOverride ?? stringField(raw.currency) ?? "EUR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { error: invalidBody("Room type create requires a three-letter currency.") };
  }

  const operatingPeriods = roomTypeOperatingPeriods(raw.operatingPeriods);
  if ("error" in operatingPeriods) return { error: invalidBody(operatingPeriods.error) };
  const seasons = roomTypeSeasons(raw.seasons, currency);
  if ("error" in seasons) return { error: invalidBody(seasons.error) };

  const parsedRoomCount = optionalNonNegativeInteger(raw.totalRooms);
  if (raw.totalRooms !== undefined && parsedRoomCount === undefined) {
    return { error: invalidBody("Room type create totalRooms must be a non-negative integer.") };
  }
  const roomCount = parsedRoomCount ?? 0;
  if (roomCount > 500) {
    return { error: invalidBody("Room type create totalRooms cannot exceed 500.") };
  }

  const maxAdults = optionalNonNegativeInteger(raw.maxAdults);
  const maxChildren = optionalNonNegativeInteger(raw.maxChildren);
  const maxOccupancy = optionalNonNegativeInteger(raw.maxOccupancy);
  const occupancyLimits: Record<string, number> = {};
  if (maxAdults !== undefined) occupancyLimits.adults = maxAdults;
  if (maxChildren !== undefined) occupancyLimits.children = maxChildren;
  occupancyLimits.total = maxOccupancy ?? (maxAdults ?? 0) + (maxChildren ?? 0);

  const nonRefundableRate =
    raw.nonRefundableEnabled === true ? roomTypeNonRefundableRate(raw, baseRate, currency) : null;
  if (raw.nonRefundableEnabled === true && !nonRefundableRate) {
    return {
      error: invalidBody(
        "Room type create non-refundable rate requires a valid nonRefundableRate or nonRefundableDiscount.",
      ),
    };
  }
  const locationAttributes = roomTypeLocationAttributes(raw, "Room type create");
  if ("error" in locationAttributes) return { error: invalidBody(locationAttributes.error) };

  return {
    value: {
      propertyId,
      commandId,
      idempotencyKey,
      initialSetupOnly: raw.initialSetupOnly === true,
      name,
      description: optionalStringField(raw.description) ?? "",
      category: nullableStringField(raw.category) ?? null,
      occupancyLimits,
      attributes: { ...roomTypeAttributes(raw), ...locationAttributes.value },
      amenities: toStringArray(raw.amenities),
      media: roomTypeMedia(raw.images),
      baseRate: { amountDecimal: baseRate, currency },
      nonRefundableRate,
      operatingPeriods: operatingPeriods.value,
      seasons: seasons.value,
      active: typeof raw.isActive === "boolean" ? raw.isActive : true,
      sortOrder: optionalNonNegativeInteger(raw.sortOrder) ?? 0,
      roomCount,
      audit: pmsOperationsCommandAudit(request, commandId, "Create room type"),
    },
  };
}

function roomTypeOperatingPeriods(
  value: unknown,
): { value: PmsRoomTypeOperatingPeriod[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "Room type create requires at least one operating period." };
  }
  const periods: PmsRoomTypeOperatingPeriod[] = [];
  for (const item of value) {
    const raw = objectBody(item);
    const from = raw ? stringField(raw.from) : undefined;
    const to = raw ? stringField(raw.to) : undefined;
    if (!from || !to || !isRecurringMonthDay(from) || !isRecurringMonthDay(to)) {
      return { error: "Room type operating periods require valid MM-DD from and to dates." };
    }
    periods.push({ from, to });
  }
  return { value: periods };
}

function roomTypeSeasons(
  value: unknown,
  currency: string,
): { value: PmsRoomTypeSeason[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "Room type create requires at least one priced season." };
  }
  const seasons: PmsRoomTypeSeason[] = [];
  for (const [index, item] of value.entries()) {
    const raw = objectBody(item);
    const from = raw ? stringField(raw.from) : undefined;
    const to = raw ? stringField(raw.to) : undefined;
    const rate = raw ? moneyDecimal(raw.rate) : undefined;
    const minStay = raw ? optionalNonNegativeInteger(raw.minStay) : undefined;
    const maxStay = raw ? optionalNonNegativeInteger(raw.maxStay) : undefined;
    if (!from || !to || !isRecurringMonthDay(from) || !isRecurringMonthDay(to)) {
      return { error: `Room type season ${index + 1} requires valid MM-DD from and to dates.` };
    }
    if (!rate || rate === "0.00") {
      return { error: `Room type season ${index + 1} requires a rate greater than zero.` };
    }
    if (raw && raw.minStay !== undefined && (!minStay || minStay < 1)) {
      return { error: `Room type season ${index + 1} minStay must be at least one night.` };
    }
    if (raw && raw.maxStay != null && raw.maxStay !== "" && (!maxStay || maxStay < 1)) {
      return { error: `Room type season ${index + 1} maxStay must be at least one night.` };
    }
    if (maxStay && maxStay < (minStay ?? 1)) {
      return { error: `Room type season ${index + 1} maxStay cannot be less than minStay.` };
    }
    seasons.push({
      name: raw ? (optionalStringField(raw.name) ?? `Season ${index + 1}`) : `Season ${index + 1}`,
      tier: raw ? (nullableStringField(raw.tier) ?? null) : null,
      from,
      to,
      rate: { amountDecimal: rate, currency },
      minStayNights: minStay ?? 1,
      maxStayNights: maxStay ?? null,
    });
  }
  return { value: seasons };
}

function isRecurringMonthDay(value: string): boolean {
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(2024, month, 0)).getUTCDate();
}

function toRoomTypeUpdateCommand(
  propertyId: string,
  roomTypeId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsRoomTypeUpdateCommand } | { error: PmsOperationsError } {
  const raw = objectBody(request.body);
  if (!raw) return { error: invalidBody("Room type update body must be an object.") };
  if (!isUuid(roomTypeId)) return { error: invalidBody("roomTypeId must be a UUID.") };

  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return { error: invalidBody("Room type update requires commandId and idempotencyKey.") };
  }

  const attributes = roomTypeLocationAttributes(raw, "Room type update");
  if ("error" in attributes) return { error: invalidBody(attributes.error) };

  return {
    value: {
      propertyId,
      roomTypeId,
      commandId,
      idempotencyKey,
      attributes: attributes.value,
      audit: pmsOperationsCommandAudit(request, commandId, "Update room type location"),
    },
  };
}

function roomTypeBaseRate(raw: Record<string, unknown>): string | undefined {
  const explicit = moneyDecimal(raw.baseRate ?? raw.rate);
  if (explicit && explicit !== "0.00") return explicit;
  return firstSeasonRate(raw.seasons) ?? explicit;
}

function firstSeasonRate(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const raw = objectBody(item);
    if (!raw) continue;
    const rate = moneyDecimal(raw.rate);
    if (rate && rate !== "0.00") return rate;
  }
  return undefined;
}

function roomTypeNonRefundableRate(
  raw: Record<string, unknown>,
  baseRate: string,
  currency: string,
): PmsMoney | null {
  const explicit = moneyDecimal(raw.nonRefundableRate);
  if (explicit && explicit !== "0.00") return { amountDecimal: explicit, currency };

  const discount = optionalNumber(raw.nonRefundableDiscount);
  if (discount === undefined || discount <= 0 || discount >= 100) return null;
  const discounted = Number(baseRate) * (1 - discount / 100);
  return { amountDecimal: discounted.toFixed(2), currency };
}

function roomTypeAttributes(
  raw: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const attributes: Record<string, string | number | boolean | null> = {};
  for (const key of [
    "shortDescription",
    "bedType",
    "cancellationPolicy",
    "nonRefundableCancellationPolicy",
  ]) {
    const value = optionalStringField(raw[key]);
    if (value !== undefined) attributes[key] = value;
  }
  for (const key of [
    "bedrooms",
    "bathrooms",
    "size",
    "nonRefundableRate",
    "nonRefundableDiscount",
    "minimumAdvanceDays",
    "partialRefundCancelWindowDays",
    "partialRefundAmountPercent",
  ]) {
    const value = optionalNumber(raw[key]);
    if (value !== undefined) attributes[key] = value;
  }
  for (const key of ["flexibleRateEnabled", "nonRefundableEnabled"]) {
    if (typeof raw[key] === "boolean") attributes[key] = raw[key] as boolean;
  }
  return attributes;
}

function roomTypeLocationAttributes(
  raw: Record<string, unknown>,
  action: string,
): { value: Record<string, string | number | boolean | null> } | { error: string } {
  const attributes: Record<string, string | number | boolean | null> = {};
  if (Object.hasOwn(raw, "locationAddress")) {
    const value = raw.locationAddress;
    const address = nullableStringField(value);
    if (value !== null && value !== "" && address === undefined) {
      return { error: `${action} locationAddress must be a string or null.` };
    }
    attributes.locationAddress = address ?? null;
  }

  const latitude = optionalCoordinate(raw.latitude, "latitude", -90, 90, action);
  if ("error" in latitude) return latitude;
  if (latitude.present) attributes.latitude = latitude.value;

  const longitude = optionalCoordinate(raw.longitude, "longitude", -180, 180, action);
  if ("error" in longitude) return longitude;
  if (longitude.present) attributes.longitude = longitude.value;

  return { value: attributes };
}

function optionalCoordinate(
  value: unknown,
  field: "latitude" | "longitude",
  min: number,
  max: number,
  action: string,
): { present: false } | { present: true; value: number | null } | { error: string } {
  if (value === undefined) return { present: false };
  if (value === null || value === "") return { present: true, value: null };
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { error: `${action} ${field} must be between ${min} and ${max}.` };
  }
  return { present: true, value: parsed };
}

function roomTypeMedia(value: unknown): PmsRoomType["media"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      const url = stringField(item);
      return url ? [{ url }] : [];
    }
    const raw = objectBody(item);
    if (!raw) return [];
    const url = stringField(raw.url);
    if (!url) return [];
    const altText = nullableStringField(raw.altText);
    return [{ url, ...(altText !== undefined ? { altText } : {}) }];
  });
}

function moneyDecimal(value: unknown): string | undefined {
  const raw =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!raw || !isMoneyAmount(raw)) return undefined;
  return Number(raw).toFixed(2);
}

function toCheckoutChargeMarkPaidCommandMetadata(body: PmsCheckoutChargeMarkPaidBody):
  | {
      value: {
        commandId: string;
        idempotencyKey: string;
      };
    }
  | { error: PmsOperationsError } {
  const raw = objectBody(body);
  if (!raw) return { error: invalidBody("Checkout charge mark-paid body must be an object.") };
  const commandId = nonEmptyString(raw.commandId);
  const idempotencyKey = nonEmptyString(raw.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return { error: invalidBody("Checkout charge mark-paid requires command metadata.") };
  }

  return {
    value: {
      commandId,
      idempotencyKey,
    },
  };
}

function toCheckoutChargeCreateCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsCheckoutChargeCreateCommand } | { error: PmsOperationsError } {
  const metadata = toCheckoutChargeCommandMetadata(request.body, "Checkout charge create");
  if ("error" in metadata) return metadata;
  const raw = metadata.body;
  const assignmentId = optionalStringField(raw.assignmentId);
  const label = stringField(raw.label);
  const amountDecimal = stringField(raw.amountDecimal) ?? stringField(raw.amount);
  const currency = stringField(raw.currency)?.toUpperCase();

  if (assignmentId && !isUuid(assignmentId)) {
    return { error: invalidBody("assignmentId must be a UUID.") };
  }
  if (!label || label.length > 200) {
    return { error: invalidBody("Checkout charge create requires a label up to 200 characters.") };
  }
  if (!amountDecimal || !isMoneyAmount(amountDecimal)) {
    return { error: invalidBody("Checkout charge create requires a valid amountDecimal.") };
  }
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    return { error: invalidBody("Checkout charge create requires a three-letter currency.") };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      commandId: metadata.value.commandId,
      idempotencyKey: metadata.value.idempotencyKey,
      assignmentId,
      label,
      amountDecimal,
      currency,
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, "Create checkout charge"),
    },
  };
}

function toCheckoutChargeWaiveCommand(
  propertyId: string,
  guestBookingId: string,
  chargeId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsCheckoutChargeWaiveCommand } | { error: PmsOperationsError } {
  if (!isUuid(chargeId)) return { error: invalidBody("chargeId must be a UUID.") };
  const metadata = toCheckoutChargeCommandMetadata(request.body, "Checkout charge waive");
  if ("error" in metadata) return metadata;

  return {
    value: {
      propertyId,
      guestBookingId,
      chargeId,
      commandId: metadata.value.commandId,
      idempotencyKey: metadata.value.idempotencyKey,
      reason: optionalStringField(metadata.body.reason),
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, "Waive checkout charge"),
    },
  };
}

function toCheckoutChargeCommandMetadata(
  body: unknown,
  commandName: string,
):
  | {
      body: Record<string, unknown>;
      value: { commandId: string; idempotencyKey: string };
    }
  | { error: PmsOperationsError } {
  const raw = objectBody(body);
  if (!raw) return { error: invalidBody(`${commandName} body must be an object.`) };
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return { error: invalidBody(`${commandName} requires commandId and idempotencyKey.`) };
  }
  return { body: raw, value: { commandId, idempotencyKey } };
}

function isMoneyAmount(value: string): boolean {
  return /^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value);
}

function invalidBody(message: string): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toPrivateNoteCreateCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsPrivateNoteCreateCommand } | { error: PmsOperationsError } {
  const body = objectBody(request.body);
  if (!body) return { error: invalidBody("Private note create body must be an object.") };

  const commandId = stringField(body.commandId);
  const idempotencyKey = stringField(body.idempotencyKey);
  const noteBody = stringField(body.body);
  if (!commandId || !idempotencyKey || !noteBody) {
    return {
      error: invalidBody("Private note create requires commandId, idempotencyKey, and body."),
    };
  }

  if (noteBody.length > 5000) {
    return { error: invalidBody("Private note body cannot exceed 5000 characters.") };
  }

  const context = request.authContext!;
  return {
    value: {
      propertyId,
      guestBookingId,
      commandId,
      idempotencyKey,
      body: noteBody,
      actorUserId: context.actor.internalUserId,
      authorDisplayName: context.actor.email,
    },
  };
}

function toOperationalTemplateUpdateCommand(
  propertyId: string,
  templateKind: PmsOperationalTemplateKind,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsOperationalTemplateUpdateCommand } | { error: PmsOperationsError } {
  const body = objectBody(request.body);
  if (!body) return { error: invalidBody("Template update body must be an object.") };

  const commandId = stringField(body.commandId);
  const idempotencyKey = stringField(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return { error: invalidBody("Template update requires commandId and idempotencyKey.") };
  }

  const steps = toOperationalTemplateSteps(body.steps);
  if ("error" in steps) return steps;

  return {
    value: {
      propertyId,
      templateKind,
      commandId,
      idempotencyKey,
      steps: steps.value,
      actorUserId: request.authContext!.actor.internalUserId,
    },
  };
}

function toOperationalTemplateSteps(
  value: unknown,
): { value: PmsTemplateStep[] } | { error: PmsOperationsError } {
  if (!Array.isArray(value)) {
    return { error: invalidBody("Template steps must be an array.") };
  }
  if (value.length > 50) {
    return { error: invalidBody("Template steps cannot exceed 50 items.") };
  }

  const steps: PmsTemplateStep[] = [];
  const seenStepIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    const raw = objectBody(item);
    if (!raw) {
      return { error: invalidBody(`Template step ${index + 1} must be an object.`) };
    }

    const stepId = stringField(raw.stepId);
    const label = stringField(raw.label);
    if (!stepId) {
      return { error: invalidBody(`Template step ${index + 1} requires stepId.`) };
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(stepId)) {
      return {
        error: invalidBody(
          `Template step ${index + 1} stepId must use letters, numbers, dots, underscores, colons, or hyphens.`,
        ),
      };
    }
    if (seenStepIds.has(stepId)) {
      return { error: invalidBody(`Template stepId ${stepId} is duplicated.`) };
    }
    if (!label) {
      return { error: invalidBody(`Template step ${index + 1} requires label.`) };
    }
    if (label.length > 200) {
      return {
        error: invalidBody(`Template step ${index + 1} label cannot exceed 200 characters.`),
      };
    }
    if (raw.required !== undefined && typeof raw.required !== "boolean") {
      return { error: invalidBody(`Template step ${index + 1} required must be a boolean.`) };
    }

    seenStepIds.add(stepId);
    steps.push({ stepId, label, required: raw.required === true });
  }

  return { value: steps };
}

function toPrivateNoteDeleteCommand(
  propertyId: string,
  guestBookingId: string,
  noteId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsPrivateNoteDeleteCommand } | { error: PmsOperationsError } {
  if (!isUuid(noteId)) return { error: invalidBody("noteId must be a UUID.") };

  const body = objectBody(request.body);
  if (!body) return { error: invalidBody("Private note delete body must be an object.") };

  const commandId = stringField(body.commandId);
  const idempotencyKey = stringField(body.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return {
      error: invalidBody("Private note delete requires commandId and idempotencyKey."),
    };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      noteId,
      commandId,
      idempotencyKey,
      actorUserId: request.authContext!.actor.internalUserId,
    },
  };
}

function toAdditionalGuestCreateCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: BookingAdditionalGuestCreateCommand } | { error: PmsOperationsError } {
  const metadata = toBookingGuestPiiCommandMetadata(request.body, "Additional guest create");
  if ("error" in metadata) return metadata;
  const guest = toAdditionalGuestInput(metadata.body.guest, true);
  if ("error" in guest) return guest;

  return {
    value: {
      propertyId,
      guestBookingId,
      commandId: metadata.value.commandId,
      idempotencyKey: metadata.value.idempotencyKey,
      guest: guest.value,
      audit: bookingGuestPiiAudit(request, metadata.value.commandId, "Create additional guest"),
    },
  };
}

function toAdditionalGuestUpdateCommand(
  propertyId: string,
  guestBookingId: string,
  guestId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: BookingAdditionalGuestUpdateCommand } | { error: PmsOperationsError } {
  if (!isUuid(guestId)) return { error: invalidBody("guestId must be a UUID.") };

  const metadata = toBookingGuestPiiCommandMetadata(request.body, "Additional guest update");
  if ("error" in metadata) return metadata;
  const guest = toAdditionalGuestInput(metadata.body.guest, false);
  if ("error" in guest) return guest;

  return {
    value: {
      propertyId,
      guestBookingId,
      guestId,
      commandId: metadata.value.commandId,
      idempotencyKey: metadata.value.idempotencyKey,
      guest: guest.value,
      audit: bookingGuestPiiAudit(request, metadata.value.commandId, "Update additional guest"),
    },
  };
}

function toAdditionalGuestDeleteCommand(
  propertyId: string,
  guestBookingId: string,
  guestId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: BookingAdditionalGuestDeleteCommand } | { error: PmsOperationsError } {
  if (!isUuid(guestId)) return { error: invalidBody("guestId must be a UUID.") };

  const metadata = toBookingGuestPiiCommandMetadata(request.body, "Additional guest delete");
  if ("error" in metadata) return metadata;

  return {
    value: {
      propertyId,
      guestBookingId,
      guestId,
      commandId: metadata.value.commandId,
      idempotencyKey: metadata.value.idempotencyKey,
      audit: bookingGuestPiiAudit(request, metadata.value.commandId, "Delete additional guest"),
    },
  };
}

function toBookingGuestPiiCommandMetadata(
  body: unknown,
  commandName: string,
):
  | {
      body: Record<string, unknown>;
      value: { commandId: string; idempotencyKey: string };
    }
  | { error: PmsOperationsError } {
  const raw = objectBody(body);
  if (!raw) return { error: invalidBody(`${commandName} body must be an object.`) };
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  if (!commandId || !idempotencyKey) {
    return { error: invalidBody(`${commandName} requires commandId and idempotencyKey.`) };
  }
  return { body: raw, value: { commandId, idempotencyKey } };
}

function toAdditionalGuestInput(
  value: unknown,
  requireNames: boolean,
): { value: BookingAdditionalGuestInput } | { error: PmsOperationsError } {
  const raw = objectBody(value);
  if (!raw) return { error: invalidBody("Additional guest payload must include a guest object.") };

  const guest: BookingAdditionalGuestInput = {
    firstName: stringField(raw.firstName) ?? "",
    lastName: stringField(raw.lastName) ?? "",
    email: nullableStringField(raw.email),
    phone: nullableStringField(raw.phone),
    countryCode: nullableStringField(raw.countryCode),
    arrivalTime: nullableStringField(raw.arrivalTime),
    specialRequests: nullableStringField(raw.specialRequests),
  };

  if (requireNames && (!guest.firstName || !guest.lastName)) {
    return { error: invalidBody("Additional guest requires firstName and lastName.") };
  }
  if (!requireNames) {
    const suppliedKeys = Object.keys(raw).filter((key) =>
      [
        "firstName",
        "lastName",
        "email",
        "phone",
        "countryCode",
        "arrivalTime",
        "specialRequests",
      ].includes(key),
    );
    if (suppliedKeys.length === 0) {
      return { error: invalidBody("Additional guest update requires at least one guest field.") };
    }
    return {
      value: Object.fromEntries(
        Object.entries(guest).filter(([key]) => suppliedKeys.includes(key)),
      ) as BookingAdditionalGuestInput,
    };
  }

  return { value: guest };
}

function objectBody(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

async function withAdditionalGuestProjection(
  reservation: PmsOperationalReservation,
  bookingGuestPiiPort: BookingGuestPiiPort | undefined,
  propertyId: string,
  guestBookingId: string,
): Promise<PmsOperationalReservationDetail> {
  if (!bookingGuestPiiPort) return reservation;
  const projection = await bookingGuestPiiPort.listGuestPiiForPmsOperations({
    propertyId,
    guestBookingId,
  });
  return applyAdditionalGuestProjection(reservation, projection);
}

async function reservationWithAdditionalGuestProjection(
  repository: PmsOperationsReadRepository,
  propertyId: string,
  guestBookingId: string,
  projection: BookingGuestPiiProjection,
): Promise<PmsOperationalReservationDetail | null> {
  const reservation = await repository.findReservationByGuestBookingId(propertyId, guestBookingId);
  return reservation ? applyAdditionalGuestProjection(reservation, projection) : null;
}

function applyAdditionalGuestProjection(
  reservation: PmsOperationalReservation,
  projection: BookingGuestPiiProjection | null,
): PmsOperationalReservationDetail {
  if (!projection) return { ...reservation, additionalGuests: [] };
  return {
    ...reservation,
    additionalGuestCount: projection.additionalGuests.length,
    additionalGuests: projection.additionalGuests,
  };
}

function readModelUnavailable(message: string): PmsOperationsError {
  return {
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    message,
  };
}

function toCalendarRange(
  query: PmsCalendarQuery,
): { value: { from: string; to: string } } | { error: PmsOperationsError } {
  if (!query.from || !query.to) {
    return {
      error: {
        statusCode: 400,
        code: "invalid_query",
        category: "validation",
        message: "Calendar requires from and to date query parameters.",
      },
    };
  }

  const range = toRequiredDateRange(query.from, query.to);
  if ("error" in range) return range;

  const days = daysInclusive(range.value.from, range.value.to);
  if (days > PMS_CALENDAR_MAX_RANGE_DAYS) {
    return {
      error: {
        statusCode: 400,
        code: "invalid_date_range",
        category: "validation",
        message: "Calendar date range cannot exceed 370 days.",
      },
    };
  }

  return range;
}

function toOptionalDateRange(
  query: PmsRoomBlocksQuery,
): { value: { from?: string; to?: string } | undefined } | { error: PmsOperationsError } {
  const from = query.from?.trim() || undefined;
  const to = query.to?.trim() || undefined;
  if (!from && !to) return { value: undefined };

  if (from && !isDateOnly(from)) {
    return { error: invalidDateRangeError() };
  }
  if (to && !isDateOnly(to)) {
    return { error: invalidDateRangeError() };
  }
  if (from && to && daysInclusive(from, to) < 1) {
    return { error: invalidDateRangeError() };
  }

  return { value: { from, to } };
}

function toRequiredDateRange(
  rawFrom: string,
  rawTo: string,
): { value: { from: string; to: string } } | { error: PmsOperationsError } {
  const from = rawFrom.trim();
  const to = rawTo.trim();
  if (!isDateOnly(from) || !isDateOnly(to) || daysInclusive(from, to) < 1) {
    return { error: invalidDateRangeError() };
  }

  return { value: { from, to } };
}

function invalidDateRangeError(): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_date_range",
    category: "validation",
    message: "Invalid PMS operations date range.",
  };
}

function toReservationFilters(
  query: PmsReservationListQuery,
): { value: PmsReservationListFilters } | { error: PmsOperationsError } {
  const arrivalFrom = query.arrivalFrom?.trim() || undefined;
  const arrivalTo = query.arrivalTo?.trim() || undefined;

  if (arrivalFrom && !isDateOnly(arrivalFrom)) {
    return { error: invalidReservationQueryError() };
  }
  if (arrivalTo && !isDateOnly(arrivalTo)) {
    return { error: invalidReservationQueryError() };
  }
  if (arrivalFrom && arrivalTo && daysInclusive(arrivalFrom, arrivalTo) < 1) {
    return { error: invalidReservationQueryError() };
  }

  return {
    value: {
      status: query.status?.trim() || undefined,
      arrivalFrom,
      arrivalTo,
      search: query.search?.trim() || undefined,
      limit: clampInteger(
        query.limit,
        PMS_RESERVATION_LIST_DEFAULT_LIMIT,
        PMS_RESERVATION_LIST_MIN_LIMIT,
        PMS_RESERVATION_LIST_MAX_LIMIT,
      ),
      offset: clampInteger(
        query.offset,
        PMS_RESERVATION_LIST_DEFAULT_OFFSET,
        PMS_RESERVATION_LIST_DEFAULT_OFFSET,
        Number.MAX_SAFE_INTEGER,
      ),
    },
  };
}

function toReservationStayRange(
  query: PmsReservationListQuery,
): { value?: { from: string; to: string } } | { error: PmsOperationsError } {
  const from = query.stayFrom?.trim() || undefined;
  const to = query.stayTo?.trim() || undefined;
  if (!from && !to) return {};
  if (!from || !to) return { error: invalidReservationQueryError() };
  if (!isDateOnly(from) || !isDateOnly(to)) return { error: invalidReservationQueryError() };
  if (daysInclusive(from, to) < 1) return { error: invalidReservationQueryError() };
  return { value: { from, to } };
}

function hasReservationListFilters(filters: PmsReservationListFilters): boolean {
  return Boolean(filters.status || filters.arrivalFrom || filters.arrivalTo || filters.search);
}

function invalidReservationQueryError(): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_query",
    category: "validation",
    message: "Invalid PMS reservations query.",
  };
}

function toAssignmentCommand(
  propertyId: string,
  guestBookingId: string,
  body: unknown,
): { value: PmsAssignmentCommand } | { error: PmsOperationsError } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: invalidAssignmentBodyError("Assignment command body must be an object.") };
  }

  const raw = body as Record<string, unknown>;
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  const expectedVersion = optionalStringField(raw.expectedVersion);
  const explicitAction = optionalStringField(raw.action);
  const inferredAction = inferAssignmentAction(raw, explicitAction);

  if (!commandId || !idempotencyKey || !inferredAction) {
    return {
      error: invalidAssignmentBodyError(
        "Assignment command requires commandId, idempotencyKey, and a valid action.",
      ),
    };
  }

  const assignmentId = optionalStringField(raw.assignmentId);
  const targetAssignmentId = optionalStringField(raw.targetAssignmentId);
  const position = optionalPositiveInteger(raw.position);
  const targetPosition = optionalPositiveInteger(raw.targetPosition);
  const roomId = nullableStringField(raw.roomId);

  for (const [field, value] of [
    ["assignmentId", assignmentId],
    ["targetAssignmentId", targetAssignmentId],
    ["roomId", roomId],
  ] as const) {
    if (value !== undefined && value !== null && !isUuid(value)) {
      return { error: invalidAssignmentBodyError(`${field} must be a UUID.`) };
    }
  }

  if ((inferredAction === "assign" || inferredAction === "move") && !roomId) {
    return { error: invalidAssignmentBodyError("Assign and move commands require roomId.") };
  }
  if (inferredAction === "unassign" && roomId !== null) {
    return { error: invalidAssignmentBodyError("Unassign commands must not include roomId.") };
  }
  if (inferredAction === "swap" && !targetAssignmentId && !targetPosition) {
    return {
      error: invalidAssignmentBodyError(
        "Swap commands require targetAssignmentId or targetPosition.",
      ),
    };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      commandId,
      idempotencyKey,
      expectedVersion,
      action: inferredAction,
      assignmentId,
      position,
      roomId,
      targetAssignmentId,
      targetPosition,
    },
  };
}

function toOperationalStatusCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsOperationalStatusCommand } | { error: PmsOperationsError } {
  const metadata = toOperationalCommandMetadata(request.body, "Operational status command");
  if ("error" in metadata) return metadata;
  const raw = request.body as Record<string, unknown>;
  const status = optionalStringField(raw.status);
  if (!isOperationalStatus(status)) {
    return { error: invalidBody("Operational status command requires a valid status.") };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      status,
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, "Update PMS status"),
    },
  };
}

function toBookingLifecycleCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: unknown }>,
  action: string,
): { value: PmsBookingLifecycleCommand } | { error: PmsOperationsError } {
  const metadata = toOperationalCommandMetadata(request.body, `${action} command`);
  if ("error" in metadata) return metadata;
  return {
    value: {
      propertyId,
      guestBookingId,
      commandId: metadata.value.commandId,
      idempotencyKey: metadata.value.idempotencyKey,
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, action),
    },
  };
}

function toCheckInCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsCheckInCommand } | { error: PmsOperationsError } {
  const metadata = toOperationalCommandMetadata(request.body, "Check-in command");
  if ("error" in metadata) return metadata;
  const raw = request.body as Record<string, unknown>;
  const assignmentId = optionalStringField(raw.assignmentId);
  if (assignmentId && !isUuid(assignmentId)) {
    return { error: invalidBody("assignmentId must be a UUID.") };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      assignmentId,
      stepResults: Array.isArray(raw.stepResults) ? raw.stepResults : [],
      pendingFlags: toStringArray(raw.pendingFlags),
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, "Check in guest"),
    },
  };
}

function toCheckOutCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: PmsCheckOutCommandBody }>,
): { value: PmsCheckOutCommand } | { error: PmsOperationsError } {
  const metadata = toOperationalCommandMetadata(request.body, "Check-out command");
  if ("error" in metadata) return metadata;
  const raw = request.body as Record<string, unknown>;
  const assignmentId = optionalStringField(raw.assignmentId);
  const checkoutNotes = optionalStringField(raw.checkoutNotes);

  if (assignmentId && !isUuid(assignmentId)) {
    return { error: invalidBody("assignmentId must be a UUID.") };
  }
  if (!Array.isArray(raw.inspectionResults)) {
    return { error: invalidBody("Check-out command requires inspectionResults as an array.") };
  }
  if (!Array.isArray(raw.chargesSettled)) {
    return { error: invalidBody("Check-out command requires chargesSettled as an array.") };
  }
  if (
    !raw.chargesSettled.every(
      (chargeId): chargeId is string => typeof chargeId === "string" && isUuid(chargeId.trim()),
    )
  ) {
    return { error: invalidBody("chargesSettled entries must be UUIDs.") };
  }
  const chargesSettled = raw.chargesSettled.map((chargeId) => chargeId.trim());
  if (checkoutNotes && checkoutNotes.length > 5000) {
    return { error: invalidBody("checkoutNotes must be 5000 characters or fewer.") };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      assignmentId,
      inspectionResults: raw.inspectionResults,
      chargesSettled,
      pendingFlags: toStringArray(raw.pendingFlags),
      checkoutNotes,
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, "Check out guest"),
    },
  };
}

function toNoShowCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Body: unknown }>,
): { value: PmsNoShowCommand } | { error: PmsOperationsError } {
  const metadata = toOperationalCommandMetadata(request.body, "No-show command");
  if ("error" in metadata) return metadata;
  const raw = request.body as Record<string, unknown>;
  const assignmentId = optionalStringField(raw.assignmentId);
  if (assignmentId) {
    return {
      error: invalidBody("No-show commands are reservation-wide and do not accept assignmentId."),
    };
  }

  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      reason: optionalStringField(raw.reason),
      audit: pmsOperationsCommandAudit(
        request,
        metadata.value.commandId,
        "Mark reservation no-show",
      ),
    },
  };
}

function toManualCancellationCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Querystring: unknown; Body: unknown }>,
): { value: PmsManualCancellationCommand } | { error: PmsOperationsError } {
  if (!objectBody(request.query) || Object.keys(request.query as object).length)
    return { error: invalidBody("Cancellation query fields are not supported.") };
  const metadata = toOperationalCommandMetadata(request.body, "Cancellation command");
  if ("error" in metadata) return metadata;
  if (
    metadata.value.commandId.length > 200 ||
    metadata.value.idempotencyKey.length > 200 ||
    (metadata.value.expectedVersion?.length ?? 0) > 200
  )
    return { error: invalidBody("Cancellation command metadata is too long.") };
  const raw = request.body as Record<string, unknown>;
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "commandId",
          "idempotencyKey",
          "expectedVersion",
          "reason",
          "accountingDate",
          "retainedCharges",
        ].includes(key),
    ) ||
    !Array.isArray(raw.retainedCharges) ||
    raw.retainedCharges.length > 20 * 366
  )
    return { error: invalidBody("Cancellation command contains unknown or invalid fields.") };
  const accountingDate = raw.accountingDate === null ? null : stringField(raw.accountingDate);
  const reason = optionalStringField(raw.reason);
  const retainedCharges = raw.retainedCharges.map((value) => {
    const charge = objectBody(value);
    const amount = objectBody(charge?.amount);
    if (
      !charge ||
      Object.keys(charge).some((key) => !["linePosition", "stayDate", "amount"].includes(key)) ||
      !amount ||
      Object.keys(amount).some((key) => !["amountDecimal", "currency"].includes(key))
    )
      return null;
    const amountDecimal = stringField(amount.amountDecimal);
    const currency = stringField(amount.currency);
    return Number.isInteger(charge.linePosition) &&
      Number(charge.linePosition) > 0 &&
      typeof charge.stayDate === "string" &&
      isDateOnly(charge.stayDate) &&
      amountDecimal &&
      isMoneyAmount(amountDecimal) &&
      !/^0(?:\.0+)?$/.test(amountDecimal) &&
      currency &&
      /^[A-Z]{3}$/.test(currency)
      ? {
          linePosition: Number(charge.linePosition),
          stayDate: charge.stayDate,
          amount: { amountDecimal, currency },
        }
      : null;
  });
  const chargeKeys = retainedCharges.map(
    (charge) => charge && `${charge.stayDate}:${charge.linePosition}`,
  );
  if (
    retainedCharges.some((charge) => !charge) ||
    new Set(chargeKeys).size !== chargeKeys.length ||
    (retainedCharges.length === 0
      ? accountingDate !== null
      : !accountingDate || !isDateOnly(accountingDate)) ||
    (reason?.length ?? 0) > 1000
  )
    return { error: invalidBody("Cancellation retained-charge evidence is invalid.") };
  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      reason,
      accountingDate: accountingDate ?? null,
      retainedCharges: retainedCharges as PmsManualCancellationCommand["retainedCharges"],
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, "Cancel manual booking"),
    },
  };
}

function toManualRefundCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Querystring: unknown; Body: unknown }>,
): { value: PmsManualRefundCommand } | { error: PmsOperationsError } {
  if (!objectBody(request.query) || Object.keys(request.query as object).length)
    return { error: invalidBody("Refund query fields are not supported.") };
  const metadata = toOperationalCommandMetadata(request.body, "Refund command");
  if ("error" in metadata) return metadata;
  const raw = request.body as Record<string, unknown>;
  if (
    metadata.value.commandId.length > 200 ||
    metadata.value.idempotencyKey.length > 200 ||
    (metadata.value.expectedVersion?.length ?? 0) > 200 ||
    Object.keys(raw).some(
      (key) =>
        ![
          "commandId",
          "idempotencyKey",
          "expectedVersion",
          "paymentEvidenceId",
          "accountingDate",
          "reason",
          "allocations",
        ].includes(key),
    ) ||
    !Array.isArray(raw.allocations) ||
    raw.allocations.length < 1 ||
    raw.allocations.length > 20 * 366
  )
    return { error: invalidBody("Refund command contains unknown or invalid fields.") };
  const paymentEvidenceId = stringField(raw.paymentEvidenceId);
  const accountingDate = stringField(raw.accountingDate);
  const reason = optionalStringField(raw.reason);
  const allocations = raw.allocations.map((value) => {
    const allocation = objectBody(value);
    const amount = objectBody(allocation?.amount);
    if (
      !allocation ||
      Object.keys(allocation).some((key) => !["evidenceId", "amount"].includes(key)) ||
      !amount ||
      Object.keys(amount).some((key) => !["amountDecimal", "currency"].includes(key))
    )
      return null;
    const evidenceId = stringField(allocation.evidenceId);
    const amountDecimal = stringField(amount.amountDecimal);
    const currency = stringField(amount.currency);
    return evidenceId &&
      isUuid(evidenceId) &&
      amountDecimal &&
      isMoneyAmount(amountDecimal) &&
      !/^0(?:\.0+)?$/.test(amountDecimal) &&
      currency &&
      /^[A-Z]{3}$/.test(currency)
      ? { evidenceId, amount: { amountDecimal, currency } }
      : null;
  });
  if (
    !paymentEvidenceId ||
    !isUuid(paymentEvidenceId) ||
    !accountingDate ||
    !isDateOnly(accountingDate) ||
    (raw.reason !== undefined && reason === undefined) ||
    (reason?.length ?? 0) > 1000 ||
    allocations.some((allocation) => !allocation) ||
    new Set(allocations.map((allocation) => allocation?.evidenceId)).size !== allocations.length
  )
    return { error: invalidBody("Refund payment or allocation evidence is invalid.") };
  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      paymentEvidenceId,
      accountingDate,
      reason,
      allocations: allocations as PmsManualRefundCommand["allocations"],
      audit: pmsOperationsCommandAudit(request, metadata.value.commandId, "Refund manual booking"),
    },
  };
}

function toManualStayCorrectionCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Querystring: unknown; Body: unknown }>,
): { value: PmsManualStayCorrectionCommand } | { error: PmsOperationsError } {
  if (!objectBody(request.query) || Object.keys(request.query as object).length)
    return { error: invalidBody("Stay-correction query fields are not supported.") };
  const metadata = toOperationalCommandMetadata(request.body, "Stay-correction command");
  if ("error" in metadata) return metadata;
  const raw = request.body as Record<string, unknown>;
  if (
    metadata.value.commandId.length > 200 ||
    metadata.value.idempotencyKey.length > 200 ||
    (metadata.value.expectedVersion?.length ?? 0) > 200 ||
    Object.keys(raw).some(
      (key) =>
        !["commandId", "idempotencyKey", "expectedVersion", "accountingDate", "stays"].includes(
          key,
        ),
    ) ||
    !Array.isArray(raw.stays) ||
    raw.stays.length < 1 ||
    raw.stays.length > 20
  )
    return { error: invalidBody("Stay-correction command contains unknown or invalid fields.") };
  const accountingDate = stringField(raw.accountingDate);
  const stays = raw.stays.map((value) => {
    const stay = objectBody(value);
    if (
      !stay ||
      Object.keys(stay).some(
        (key) =>
          !["assignmentId", "position", "roomId", "checkIn", "checkOut", "nightly"].includes(key),
      ) ||
      !Array.isArray(stay.nightly)
    )
      return null;
    const assignmentId = stringField(stay.assignmentId);
    const roomId = stringField(stay.roomId);
    const checkIn = stringField(stay.checkIn);
    const checkOut = stringField(stay.checkOut);
    if (
      !assignmentId ||
      !isUuid(assignmentId) ||
      !roomId ||
      !isUuid(roomId) ||
      !checkIn ||
      !checkOut ||
      !isDateOnly(checkIn) ||
      !isDateOnly(checkOut) ||
      !Number.isInteger(stay.position) ||
      Number(stay.position) < 1
    )
      return null;
    const nights = daysInclusive(checkIn, checkOut) - 1;
    if (nights < 1 || nights > 366 || stay.nightly.length !== nights) return null;
    const nightly = stay.nightly.map((entry, index) => {
      const night = objectBody(entry);
      if (
        !night ||
        Object.keys(night).some(
          (key) => !["stayDate", "amount", "evidenceQuality"].includes(key),
        ) ||
        night.stayDate !== dateOffset(checkIn, index) ||
        !["exact", "inferred", "missing"].includes(String(night.evidenceQuality))
      )
        return null;
      const evidenceQuality = night.evidenceQuality as "exact" | "inferred" | "missing";
      if (evidenceQuality === "missing")
        return night.amount === null
          ? { stayDate: night.stayDate as string, amount: null, evidenceQuality }
          : null;
      const amount = objectBody(night.amount);
      const amountDecimal = stringField(amount?.amountDecimal);
      const currency = stringField(amount?.currency);
      return amount &&
        Object.keys(amount).every((key) => ["amountDecimal", "currency"].includes(key)) &&
        amountDecimal &&
        isMoneyAmount(amountDecimal) &&
        currency &&
        /^[A-Z]{3}$/.test(currency)
        ? {
            stayDate: night.stayDate as string,
            amount: { amountDecimal, currency },
            evidenceQuality,
          }
        : null;
    });
    return nightly.some((night) => !night)
      ? null
      : {
          assignmentId,
          position: Number(stay.position),
          roomId,
          checkIn,
          checkOut,
          nightly: nightly as PmsManualStayCorrectionCommand["stays"][number]["nightly"],
        };
  });
  const positions = stays.map((stay) => stay?.position).sort((a, b) => (a ?? 0) - (b ?? 0));
  if (
    !accountingDate ||
    !isDateOnly(accountingDate) ||
    stays.some((stay) => !stay) ||
    positions.some((position, index) => position !== index + 1) ||
    new Set(stays.map((stay) => stay?.assignmentId)).size !== stays.length
  )
    return { error: invalidBody("Stay-correction stay or nightly evidence is invalid.") };
  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      accountingDate,
      stays: stays as PmsManualStayCorrectionCommand["stays"],
      audit: pmsOperationsCommandAudit(
        request,
        metadata.value.commandId,
        "Correct manual booking stays",
      ),
    },
  };
}

function toManualPriceCorrectionCommand(
  propertyId: string,
  guestBookingId: string,
  request: FastifyRequest<{ Querystring: unknown; Body: unknown }>,
): { value: PmsManualPriceCorrectionCommand } | { error: PmsOperationsError } {
  if (!objectBody(request.query) || Object.keys(request.query as object).length)
    return { error: invalidBody("Price-correction query fields are not supported.") };
  const metadata = toOperationalCommandMetadata(request.body, "Price-correction command");
  if ("error" in metadata) return metadata;
  const raw = request.body as Record<string, unknown>;
  if (
    metadata.value.commandId.length > 200 ||
    metadata.value.idempotencyKey.length > 200 ||
    (metadata.value.expectedVersion?.length ?? 0) > 200 ||
    Object.keys(raw).some(
      (key) =>
        ![
          "commandId",
          "idempotencyKey",
          "expectedVersion",
          "accountingDate",
          "reason",
          "pricing",
        ].includes(key),
    )
  )
    return { error: invalidBody("Price-correction command contains unknown or invalid fields.") };
  const accountingDate = stringField(raw.accountingDate);
  const reason = optionalStringField(raw.reason);
  const pricing = objectBody(raw.pricing);
  const parsed = pricing && parseManualPriceCorrectionPricing(pricing);
  if (
    !accountingDate ||
    !isDateOnly(accountingDate) ||
    (raw.reason !== undefined && reason === undefined) ||
    (reason?.length ?? 0) > 1000 ||
    !parsed
  )
    return { error: invalidBody("Price-correction pricing evidence is invalid.") };
  return {
    value: {
      propertyId,
      guestBookingId,
      ...metadata.value,
      accountingDate,
      reason,
      pricing: parsed,
      audit: pmsOperationsCommandAudit(
        request,
        metadata.value.commandId,
        "Correct manual booking prices",
      ),
    },
  };
}

function parseManualPriceCorrectionPricing(
  pricing: Record<string, unknown>,
): PmsManualPriceCorrectionCommand["pricing"] | null {
  if (pricing.kind === "exact") {
    if (
      Object.keys(pricing).some((key) => !["kind", "nights"].includes(key)) ||
      !Array.isArray(pricing.nights) ||
      pricing.nights.length < 1 ||
      pricing.nights.length > 20 * 366
    )
      return null;
    const nights = pricing.nights.map((value) => {
      const night = objectBody(value);
      if (
        !night ||
        Object.keys(night).some((key) => !["targetEvidenceId", "replacementAmount"].includes(key))
      )
        return null;
      const targetEvidenceId = stringField(night.targetEvidenceId);
      const replacementAmount = parsePriceCorrectionMoney(night.replacementAmount);
      return targetEvidenceId && isUuid(targetEvidenceId) && replacementAmount
        ? { targetEvidenceId, replacementAmount }
        : null;
    });
    if (
      nights.some((night) => !night) ||
      new Set(nights.map((night) => night?.targetEvidenceId)).size !== nights.length
    )
      return null;
    return { kind: "exact", nights: nights as NonNullable<(typeof nights)[number]>[] };
  }
  if (
    pricing.kind !== "equal_inferred" ||
    Object.keys(pricing).some(
      (key) => !["kind", "targetEvidenceIds", "replacementTotal"].includes(key),
    ) ||
    !Array.isArray(pricing.targetEvidenceIds) ||
    pricing.targetEvidenceIds.length < 1 ||
    pricing.targetEvidenceIds.length > 20 * 366
  )
    return null;
  const targetEvidenceIds = pricing.targetEvidenceIds.map(stringField);
  const replacementTotal = parsePriceCorrectionMoney(pricing.replacementTotal);
  return targetEvidenceIds.every((id) => id && isUuid(id)) &&
    new Set(targetEvidenceIds).size === targetEvidenceIds.length &&
    replacementTotal
    ? { kind: "equal_inferred", targetEvidenceIds: targetEvidenceIds as string[], replacementTotal }
    : null;
}

function parsePriceCorrectionMoney(value: unknown): PmsMoney | null {
  const money = objectBody(value);
  if (!money || Object.keys(money).some((key) => !["amountDecimal", "currency"].includes(key)))
    return null;
  const amountDecimal = stringField(money.amountDecimal);
  const currency = stringField(money.currency);
  return amountDecimal &&
    /^(0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(amountDecimal) &&
    currency &&
    /^[A-Z]{3}$/.test(currency)
    ? { amountDecimal, currency }
    : null;
}

function dateOffset(from: string, days: number): string {
  const date = new Date(`${from}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function requestsRetainedCharge(body: unknown): boolean {
  const charges = objectBody(body)?.retainedCharges;
  return !Array.isArray(charges) || charges.length > 0;
}

function toOperationalCommandMetadata(
  body: unknown,
  commandName: string,
):
  | { value: { commandId: string; idempotencyKey: string; expectedVersion?: string } }
  | { error: PmsOperationsError } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: invalidBody(`${commandName} body must be an object.`) };
  }
  const raw = body as Record<string, unknown>;
  const commandId = stringField(raw.commandId);
  const idempotencyKey = stringField(raw.idempotencyKey);
  const expectedVersion = optionalStringField(raw.expectedVersion);
  if (
    !commandId ||
    !idempotencyKey ||
    (raw.expectedVersion !== undefined && expectedVersion === undefined)
  ) {
    return { error: invalidBody(`${commandName} requires commandId and idempotencyKey.`) };
  }
  return {
    value: {
      commandId,
      idempotencyKey,
      expectedVersion,
    },
  };
}

function pmsOperationsCommandAudit(
  request: FastifyRequest,
  commandId: string,
  reason: string,
): PmsOperationsCommandAudit {
  const authContext = request.authContext;
  const now = new Date().toISOString();
  return {
    actor: authContext
      ? {
          kind: "user",
          userId: authContext.actor.internalUserId,
          organizationId: authContext.selectedOrganization.organizationId,
        }
      : { kind: "system", service: "apps/api" },
    requestId: authContext?.audit.requestId ?? commandId,
    correlationId: authContext?.audit.correlationId,
    reason,
    requestedAt: authContext?.audit.receivedAt ?? now,
  };
}

function bookingGuestPiiAudit(
  request: FastifyRequest,
  commandId: string,
  reason: string,
): BookingAdditionalGuestCreateCommand["audit"] {
  const authContext = request.authContext!;
  return {
    actorUserId: authContext.actor.internalUserId,
    actorOrganizationId: authContext.selectedOrganization.organizationId,
    requestId: authContext.audit.requestId,
    correlationId: authContext.audit.correlationId ?? commandId,
    source: "pms_operations",
    reason,
  };
}

function isOperationalStatus(value: string | undefined): value is PmsOperationalStatus {
  return (
    value === "assigned" ||
    value === "checked_in" ||
    value === "in_house" ||
    value === "checked_out"
  );
}

function inferAssignmentAction(
  raw: Record<string, unknown>,
  explicitAction: string | undefined,
): PmsAssignmentCommandAction | undefined {
  if (
    explicitAction === "assign" ||
    explicitAction === "move" ||
    explicitAction === "unassign" ||
    explicitAction === "swap"
  ) {
    return explicitAction;
  }
  if (raw.roomId === null) return "unassign";
  if (typeof raw.targetAssignmentId === "string" || typeof raw.targetPosition === "number") {
    return "swap";
  }
  if (typeof raw.roomId === "string" && raw.roomId.trim()) return "assign";
  return undefined;
}

function invalidAssignmentBodyError(message: string): PmsOperationsError {
  return {
    statusCode: 400,
    code: "invalid_body",
    category: "validation",
    message,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringField(value: unknown): string | undefined {
  return value === undefined ? undefined : stringField(value);
}

function nullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalStringField(value);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function clampInteger(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(max, Math.max(min, parsed));
}

function hasBalancedCalendarCounts(day: PmsCalendarDay): boolean {
  return day.availableCount + day.assignedCount + day.blockedCount === day.totalCount;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysInclusive(from: string, to: string): number {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 0;
  return Math.floor((toTime - fromTime) / 86_400_000) + 1;
}

function toPmsOperationsAccessError(
  error: unknown,
  request: FastifyRequest,
  propertyId: string,
): PmsOperationsError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toPmsOperationsAuthorizationCode(error.message, request, propertyId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toPmsOperationsAuthorizationMessage(code),
  };
}

function toPmsOperationsAuthorizationCode(
  message: string,
  request: FastifyRequest,
  propertyId: string,
): PmsOperationsAuthorizationErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactivePmsOperationsEntitlement(request, propertyId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toPmsOperationsAuthorizationMessage(code: PmsOperationsAuthorizationErrorCode): string {
  switch (code) {
    case "missing_permission":
      return "Missing required PMS operations permission.";
    case "inactive_entitlement":
      return "PMS property-management entitlement is not active.";
    case "missing_entitlement":
      return "Missing active PMS property-management entitlement.";
    case "missing_resource_access":
      return "Missing PMS property access.";
  }
}

function hasInactivePmsOperationsEntitlement(request: FastifyRequest, propertyId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "pms" || entitlement.key !== "property-management") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "pms" &&
        entitlement.resource.resourceType === "pms_property" &&
        entitlement.resource.resourceId === propertyId
      );
    }) ?? false
  );
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}
