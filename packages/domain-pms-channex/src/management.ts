import type { ChannexUtcDateTime } from "./index.js";

export const CHANNEX_MANAGEMENT_CONTRACT_VERSION = "pms-channex-management.v1" as const;

export type ChannexManagementMode = "observe_only" | "mutating";

export const CHANNEX_MANAGEMENT_OPERATION_TYPES = [
  "enable",
  "disable",
  "provision",
  "setup_google",
  "sync_ari",
  "sync_bookings",
  "update_markups",
  "install_messaging",
] as const;

export type ChannexManagementOperationType = (typeof CHANNEX_MANAGEMENT_OPERATION_TYPES)[number];

export type ChannexManagementOperationStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "dead_lettered";

export type ChannexManagementCapabilityModes = {
  connection: ChannexManagementMode;
  provisioning: ChannexManagementMode;
  ariSync: ChannexManagementMode;
  bookingSync: ChannexManagementMode;
  markups: ChannexManagementMode;
  messaging: ChannexManagementMode;
  iframe: ChannexManagementMode;
};

export type ChannexSyncDomainState = {
  status: "pending" | "ok" | "degraded" | "failed" | "idle";
  lastAttemptAt: ChannexUtcDateTime | null;
  lastSuccessAt: ChannexUtcDateTime | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  retryAfter: ChannexUtcDateTime | null;
};

export type ChannexRoomTypeMapping = {
  mappingId: string;
  roomTypeId: string;
  roomTypeName: string;
  externalRoomTypeId: string;
  status: "active" | "disabled" | "stale";
};

export type ChannexRatePlanMapping = {
  mappingId: string;
  roomTypeId: string;
  ratePlanId: string;
  ratePlanName: string;
  channel: string;
  externalRoomTypeId: string;
  externalRatePlanId: string;
  sellMode: "per_room" | "per_person";
  markupPercent: number;
  status: "active" | "disabled" | "stale";
};

export type ChannexConnectedChannel = {
  key: string;
  application: string;
  title: string | null;
  isActive: boolean;
};

export type GoogleFreeBookingLinksPreflight = {
  propertyName: boolean;
  address: boolean;
  phone: boolean;
  bookingEngine: boolean;
  activeRatesAndAvailability: boolean;
};

export type GoogleFreeBookingLinksStatus =
  | "disabled"
  | "pending"
  | "active"
  | "manual_confirmation_required"
  | "error";

export type ChannexManagementOperation = {
  contractVersion: typeof CHANNEX_MANAGEMENT_CONTRACT_VERSION;
  operationId: string;
  propertyId: string;
  operationType: ChannexManagementOperationType;
  status: ChannexManagementOperationStatus;
  commandId: string;
  idempotencyKey: string;
  acceptedAt: ChannexUtcDateTime;
  attemptsMade: number;
  maxAttempts: number;
  retryAfter: ChannexUtcDateTime | null;
  lastError: { code: string; message: string } | null;
};

export type ChannexManagementSnapshot = {
  contractVersion: typeof CHANNEX_MANAGEMENT_CONTRACT_VERSION;
  propertyId: string;
  connection: {
    status: "connected" | "disconnected" | "suspended" | "degraded" | "setup_incomplete";
    externalPropertyId: string | null;
    messagingAppInstalled: boolean;
  };
  mappings: {
    roomTypes: ChannexRoomTypeMapping[];
    ratePlans: ChannexRatePlanMapping[];
  };
  channels: ChannexConnectedChannel[];
  googleFreeBookingLinks: {
    status: GoogleFreeBookingLinksStatus;
    bookingUrlTemplate: string | null;
    currency: string | null;
    businessProfileConfirmedAt: ChannexUtcDateTime | null;
    preflight: GoogleFreeBookingLinksPreflight;
  };
  markups: Array<{ channel: string; markupPercent: number }>;
  sync: Record<"booking" | "ari" | "message" | "mapping", ChannexSyncDomainState>;
  capabilityModes: ChannexManagementCapabilityModes;
  activeOperation: ChannexManagementOperation | null;
};

export type ChannexManagementCommandRequest = {
  commandId: string;
  idempotencyKey: string;
  operationType: Exclude<ChannexManagementOperationType, "update_markups">;
  businessProfileConfirmed?: boolean;
};

export function buildChannexManagementJobKey(input: {
  propertyId: string;
  operationType: ChannexManagementOperationType;
  idempotencyKey: string;
}): string {
  return `channex.management:${input.operationType}:property:${input.propertyId}:${input.idempotencyKey}:v1`;
}
