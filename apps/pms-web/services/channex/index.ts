import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { unsupportedPmsNextStackFeature } from "@/services/api/unsupported";

export interface ChannexSyncStatus {
  isConnected: boolean;
  channexPropertyId: string | null;
  roomTypesProvisioned: number;
  ratePlansProvisioned: number;
  lastBookingSyncAt: string | null;
  lastAriSyncAt: string | null;
  lastAriSyncError: string | null;
  lastAriSyncFailedAt: string | null;
  messagingAppInstalled: boolean;
}

export interface ChannexRoomTypeMapping {
  id: string;
  hotelId: string;
  roomTypeId: string;
  roomTypeName: string | null;
  channexRoomTypeId: string;
  createdAt: string;
}

export interface ChannexRatePlanMapping {
  id: string;
  hotelId: string;
  roomTypeId: string;
  channexRatePlanId: string;
  channexRoomTypeId: string;
  sellMode: string;
  createdAt: string;
}

export interface ChannexEnableResult {
  status: string;
  channexPropertyId: string;
  roomsCreated: number;
  ratesCreated: number;
}

export interface ChannelMarkup {
  channel: string;
  markupPct: number;
}

export interface ChannelMarkupsResponse {
  markups: ChannelMarkup[];
}

export interface ConnectedChannel {
  key: string;
  application: string;
  title: string | null;
  isActive: boolean;
}

export interface ConnectedChannelsResponse {
  channels: ConnectedChannel[];
}

export const channexService = {
  // Enable / disable
  enable: () => unsupportedPmsNextStackFeature<ChannexEnableResult>("Channex enablement"),

  disable: () => unsupportedPmsNextStackFeature("Channex disablement"),

  // Status
  getStatus: async () => {
    await resolveSelectedPmsPropertyId("loading channel manager status");
    return unsupportedPmsNextStackFeature<ChannexSyncStatus>("Channex status");
  },

  // Re-provision (after adding new room types)
  provision: () =>
    unsupportedPmsNextStackFeature<{
      channexPropertyId: string;
      roomsCreated: number;
      ratesCreated: number;
    }>("Channex provisioning"),

  // Mappings
  listRoomTypeMappings: () =>
    unsupportedPmsNextStackFeature<ChannexRoomTypeMapping[]>("Channex room type mappings"),

  listRatePlanMappings: () =>
    unsupportedPmsNextStackFeature<ChannexRatePlanMapping[]>("Channex rate plan mappings"),

  // Sync
  syncAri: () => unsupportedPmsNextStackFeature<{ status: string }>("Channex ARI sync"),

  syncBookings: () => unsupportedPmsNextStackFeature<{ status: string }>("Channex booking sync"),

  // Messaging app install (idempotent retry for the requesting hotel)
  installMessagingApp: () =>
    unsupportedPmsNextStackFeature<{ status: string }>("Channex messaging app install"),

  // Channel iframe
  getIframeUrl: () => unsupportedPmsNextStackFeature<{ iframe_url: string }>("Channex iframe"),

  // Channel pricing markups
  getMarkups: () => unsupportedPmsNextStackFeature<ChannelMarkupsResponse>("Channel markups"),

  updateMarkups: (_markups: ChannelMarkup[]) =>
    unsupportedPmsNextStackFeature<ChannelMarkupsResponse>("Channel markups"),

  // Connected OTA channels
  listChannels: async () => {
    await resolveSelectedPmsPropertyId("loading connected channels");
    return unsupportedPmsNextStackFeature<ConnectedChannelsResponse>("Connected OTA channels");
  },
};
