import { createVayadaApiClient, VAYADA_API_BASE_URL } from "./client";
import { targetApiClient } from "./targetClient";

export const HOTEL_ACCOUNT_INVITE_STORAGE_KEY = "vayada.hotel-account-invite.v1";
export type HotelAccountInviteTrack = "hotel_operations" | "creator_marketplace";

export type HotelAccountInviteLookup = {
  contractVersion: "hotel-account-invite.v1";
  identity: { emailHint: string };
  organization: { displayName: string };
  property: { displayName: string };
  selectedTracks: HotelAccountInviteTrack[];
  handoffPath: "/setup";
  expiresAt: string;
};

export type HotelAccountInviteRedemption = {
  contractVersion: "hotel-account-invite.v1";
  status: "redeemed" | "already_redeemed";
  selectedTracks: HotelAccountInviteTrack[];
  handoffPath: "/setup";
};

const publicApiClient = createVayadaApiClient(VAYADA_API_BASE_URL, () => null);

export const hotelAccountInvitesService = {
  lookup(code: string): Promise<HotelAccountInviteLookup> {
    return publicApiClient.post<HotelAccountInviteLookup>(
      "/api/marketplace/hotel-account-invites/lookup",
      { code },
    );
  },

  redeem(code: string): Promise<HotelAccountInviteRedemption> {
    return targetApiClient.post<HotelAccountInviteRedemption>(
      "/api/marketplace/hotel-account-invites/redeem",
      { code },
    );
  },
};

export function captureHotelAccountInviteCode(): string | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const hashCode = normalizeInviteCode(hash.get("code"));
  if (hashCode) {
    window.sessionStorage.setItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY, hashCode);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return hashCode;
  }
  return pendingHotelAccountInviteCode();
}

export function storeHotelAccountInviteCode(code: string): string | null {
  if (typeof window === "undefined") return null;
  const normalized = normalizeInviteCode(code);
  if (!normalized) return null;
  window.sessionStorage.setItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY, normalized);
  return normalized;
}

export function pendingHotelAccountInviteCode(): string | null {
  if (typeof window === "undefined") return null;
  return normalizeInviteCode(window.sessionStorage.getItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY));
}

export function hasPendingHotelAccountInvite(): boolean {
  return Boolean(pendingHotelAccountInviteCode());
}

export function clearPendingHotelAccountInvite(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(HOTEL_ACCOUNT_INVITE_STORAGE_KEY);
}

function normalizeInviteCode(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return /^VAY-[A-Za-z0-9_-]{8,252}$/.test(normalized) ? normalized : null;
}
