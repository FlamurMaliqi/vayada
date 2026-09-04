import {
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "@/services/api/pmsOperationsClient";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";

export type ChannexCapabilityMode = "observe_only" | "mutating";
export type ChannexOperationType =
  | "enable"
  | "disable"
  | "provision"
  | "setup_google"
  | "sync_ari"
  | "sync_bookings"
  | "update_markups"
  | "install_messaging";
export type ChannexOperationStatus =
  | "queued"
  | "running"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "dead_lettered";

export interface ChannexOperation {
  contractVersion: "pms-channex-management.v1";
  operationId: string;
  propertyId: string;
  operationType: ChannexOperationType;
  status: ChannexOperationStatus;
  commandId: string;
  idempotencyKey: string;
  acceptedAt: string;
  attemptsMade: number;
  maxAttempts: number;
  retryAfter: string | null;
  lastError: { code: string; message: string } | null;
}

export interface ChannexSyncDomainState {
  status: "pending" | "ok" | "degraded" | "failed" | "idle";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  retryAfter: string | null;
}

export interface ChannexRoomTypeMapping {
  mappingId: string;
  roomTypeId: string;
  roomTypeName: string;
  externalRoomTypeId: string;
  status: "active" | "disabled" | "stale";
}

export interface ChannexRatePlanMapping {
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
}

export interface ConnectedChannel {
  key: string;
  application: string;
  title: string | null;
  isActive: boolean;
}

export interface GoogleFreeBookingLinks {
  status: "disabled" | "pending" | "active" | "manual_confirmation_required" | "error";
  bookingUrlTemplate: string | null;
  currency: string | null;
  businessProfileConfirmedAt: string | null;
  preflight: {
    propertyName: boolean;
    address: boolean;
    phone: boolean;
    bookingEngine: boolean;
    activeRatesAndAvailability: boolean;
  };
}

export interface ChannexSnapshot {
  contractVersion: "pms-channex-management.v1";
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
  channels: ConnectedChannel[];
  googleFreeBookingLinks: GoogleFreeBookingLinks;
  markups: Array<{ channel: string; markupPercent: number }>;
  sync: Record<"booking" | "ari" | "message" | "mapping", ChannexSyncDomainState>;
  capabilityModes: {
    connection: ChannexCapabilityMode;
    provisioning: ChannexCapabilityMode;
    ariSync: ChannexCapabilityMode;
    bookingSync: ChannexCapabilityMode;
    markups: ChannexCapabilityMode;
    messaging: ChannexCapabilityMode;
    iframe: ChannexCapabilityMode;
  };
  activeOperation: ChannexOperation | null;
}

export interface ChannelMarkup {
  channel: string;
  markupPct: number;
}

async function endpoint(action: string, suffix = "channex") {
  const propertyId = await resolveSelectedPmsPropertyId(action);
  return `/api/pms/properties/${encodeURIComponent(propertyId)}/${suffix}`;
}

async function command(
  operationType: Exclude<ChannexOperationType, "update_markups">,
  extra?: Record<string, unknown>,
) {
  return pmsOperationsClient.post<ChannexOperation>(
    await endpoint(`starting Channex ${operationType}`, "channex/commands"),
    { ...identity(operationType), ...extra },
    pmsOperationsRequestOptions,
  );
}

function identity(operationType: ChannexOperationType) {
  const commandId = crypto.randomUUID();
  return { commandId, idempotencyKey: `${operationType}:${commandId}`, operationType };
}

export const channexService = {
  async getSnapshot() {
    return pmsOperationsClient.get<ChannexSnapshot>(
      await endpoint("loading channel management"),
      pmsOperationsRequestOptions,
    );
  },

  async getOperation(operationId: string) {
    return pmsOperationsClient.get<ChannexOperation>(
      await endpoint(
        "loading a Channex operation",
        `channex/operations/${encodeURIComponent(operationId)}`,
      ),
      pmsOperationsRequestOptions,
    );
  },

  enable: () => command("enable"),
  disable: () => command("disable"),
  provision: () => command("provision"),
  setupGoogle: (businessProfileConfirmed = false) =>
    command("setup_google", { businessProfileConfirmed }),
  syncAri: () => command("sync_ari"),
  syncBookings: () => command("sync_bookings"),
  installMessagingApp: () => command("install_messaging"),

  async getIframeUrl(channel?: "google_hotel", businessProfileConfirmed?: boolean) {
    const session = await pmsOperationsClient.post<{ iframeUrl: string; expiresAt: string }>(
      await endpoint("opening Channex channel settings", "channex/iframe-session"),
      channel ? { channel, businessProfileConfirmed } : undefined,
      pmsOperationsRequestOptions,
    );
    return { iframe_url: session.iframeUrl, expiresAt: session.expiresAt };
  },

  async updateMarkups(markups: ChannelMarkup[]) {
    const request = identity("update_markups");
    return pmsOperationsClient.put<ChannexOperation>(
      await endpoint("updating channel markups", "channex/markups"),
      {
        commandId: request.commandId,
        idempotencyKey: request.idempotencyKey,
        markups: markups.map(({ channel, markupPct }) => ({
          channel,
          markupPercent: markupPct,
        })),
      },
      pmsOperationsRequestOptions,
    );
  },

  async listChannels() {
    return { channels: (await this.getSnapshot()).channels };
  },
};
