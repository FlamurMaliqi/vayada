import { apiClient } from "./client";

export const HOTEL_SETUP_TRACKS = ["hotel_operations", "creator_marketplace"] as const;

export type HotelSetupTrack = (typeof HOTEL_SETUP_TRACKS)[number];

export type HotelAccountInviteCreateRequest = {
  identity: {
    email: string;
  };
  organization: {
    displayName: string;
  };
  property: {
    displayName: string;
  };
  selectedTracks: HotelSetupTrack[];
};

export interface InviteCode {
  contractVersion: "hotel-account-invite.v1";
  id: string;
  code: string;
  status: "pending" | "redeemed" | "expired";
  createdAt: string;
  expiresAt: string;
  identity: HotelAccountInviteCreateRequest["identity"] | null;
  organization: HotelAccountInviteCreateRequest["organization"] | null;
  property: HotelAccountInviteCreateRequest["property"] | null;
  selectedTracks: HotelSetupTrack[];
  handoffPath: "/setup";
  redeemedAt: string | null;
}

export const inviteCodesService = {
  async list(): Promise<InviteCode[]> {
    return apiClient.get<InviteCode[]>("/api/marketplace/admin/invite-codes");
  },

  async create(request: HotelAccountInviteCreateRequest): Promise<InviteCode> {
    return apiClient.post<InviteCode>("/api/marketplace/admin/invite-codes", request);
  },

  async delete(id: string): Promise<void> {
    return apiClient.delete(`/api/marketplace/admin/invite-codes/${id}`);
  },
};
