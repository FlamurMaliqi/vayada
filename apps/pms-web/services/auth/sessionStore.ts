import {
  SELECTED_PMS_PROPERTY_ID_KEY,
  SELECTED_SHARED_PROPERTY_ID_KEY,
  SELECTED_SHARED_PROPERTY_ORG_ID_KEY,
} from "@/lib/utils/pmsPropertySelectionKeys";

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
  status: string;
  workosUserId?: string;
};

export type AuthKitSessionResponse = {
  accessToken: string;
  csrfToken?: string;
  organizationId?: string;
  workosOrganizationId?: string;
  resources?: Record<string, string[]>;
  user: AuthUser;
};

export type AuthOrganizationOption = {
  organizationId: string;
  workosOrganizationId: string;
  displayName: string;
  kind: "platform" | "hotel_group" | "creator_workspace" | "affiliate_partner";
};

export type AuthOrganizationSelectionResponse = {
  organizationSelectionRequired: true;
  csrfToken?: string;
  organizations: AuthOrganizationOption[];
  user: AuthUser;
};

export type AuthSessionResponse = AuthKitSessionResponse | AuthOrganizationSelectionResponse;

const LEGACY_TOKEN_KEY = "access_token";
const LEGACY_EXPIRES_AT_KEY = "token_expires_at";
const PMS_PROPERTY_RESOURCE_KEY = "pms:pms_property";
const SELECTED_WORKOS_ORGANIZATION_ID_KEY = "selectedWorkosOrganizationId";

let authKitSession: AuthKitSessionResponse | null = null;
let pendingOrganizationSelectionCsrfToken: string | null = null;
let legacyCompatibilityToken: { token: string; expiresAt: number } | null = null;

export function isAuthKitLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED !== "false";
}

export function isCompatibilityTokenEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED === "true";
}

export function setAuthKitSession(session: AuthKitSessionResponse): void {
  authKitSession = session;
  pendingOrganizationSelectionCsrfToken = null;
  if (typeof window === "undefined") return;
  const userName = session.user.name ?? "";
  clearSharedPropertySelectionIfOrganizationChanged(session.organizationId);
  persistPmsResourceSelection(session);
  if (session.workosOrganizationId) {
    localStorage.setItem(SELECTED_WORKOS_ORGANIZATION_ID_KEY, session.workosOrganizationId);
  } else {
    localStorage.removeItem(SELECTED_WORKOS_ORGANIZATION_ID_KEY);
  }
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", session.user.id);
  localStorage.setItem("userEmail", session.user.email);
  localStorage.setItem("userName", userName);
  localStorage.setItem("userType", "hotel");
  localStorage.setItem("userStatus", session.user.status);
  localStorage.setItem(
    "user",
    JSON.stringify({
      id: session.user.id,
      email: session.user.email,
      name: userName,
      phone: session.user.phone ?? null,
      profilePictureUrl: session.user.profilePictureUrl ?? null,
      profilePictureMediaObjectId: session.user.profilePictureMediaObjectId ?? null,
      type: "hotel",
      status: session.user.status,
      workos_user_id: session.user.workosUserId,
    }),
  );
}

export function setLegacyCompatibilityToken(token: string, expiresIn: number): void {
  legacyCompatibilityToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  if (typeof window === "undefined") return;
  localStorage.setItem(LEGACY_TOKEN_KEY, token);
  localStorage.setItem(LEGACY_EXPIRES_AT_KEY, String(legacyCompatibilityToken.expiresAt));
}

export function setPendingOrganizationSelection(
  selection: AuthOrganizationSelectionResponse,
): void {
  authKitSession = null;
  legacyCompatibilityToken = null;
  pendingOrganizationSelectionCsrfToken = selection.csrfToken ?? null;
  if (typeof window === "undefined") return;
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
}

export function setLegacyPasswordSession(input: {
  token: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string;
    type: string;
    status: string;
  };
}): void {
  if (typeof window === "undefined") return;

  localStorage.removeItem(SELECTED_WORKOS_ORGANIZATION_ID_KEY);
  localStorage.setItem(LEGACY_TOKEN_KEY, input.token);
  localStorage.setItem(LEGACY_EXPIRES_AT_KEY, String(Date.now() + input.expiresIn * 1000));
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", input.user.id);
  localStorage.setItem("userEmail", input.user.email);
  localStorage.setItem("userName", input.user.name);
  localStorage.setItem("userType", input.user.type);
  localStorage.setItem("userStatus", input.user.status);
  localStorage.setItem("user", JSON.stringify(input.user));
}

export function clearAuthData(): void {
  authKitSession = null;
  pendingOrganizationSelectionCsrfToken = null;
  legacyCompatibilityToken = null;
  if (typeof window === "undefined") return;

  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.removeItem("userId");
  localStorage.removeItem("userEmail");
  localStorage.removeItem("userName");
  localStorage.removeItem("userType");
  localStorage.removeItem("userStatus");
  localStorage.removeItem("user");
  localStorage.removeItem(SELECTED_PMS_PROPERTY_ID_KEY);
  localStorage.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
  localStorage.removeItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY);
  localStorage.removeItem(SELECTED_WORKOS_ORGANIZATION_ID_KEY);
  localStorage.setItem("isLoggedIn", "false");
}

export function getAuthCsrfToken(): string | null {
  return pendingOrganizationSelectionCsrfToken ?? authKitSession?.csrfToken ?? null;
}

export function getAuthBearerToken(): string | null {
  if (authKitSession?.accessToken) return authKitSession.accessToken;
  if (isAuthKitLoginEnabled()) return null;
  const compatibilityToken = currentCompatibilityToken();
  if (isCompatibilityTokenEnabled() && compatibilityToken) return compatibilityToken;
  return getLegacyPasswordToken();
}

export function getAuthSessionUser(): AuthUser | null {
  return authKitSession?.user ?? null;
}

export function getAuthWorkosOrganizationId(): string | null {
  if (authKitSession?.workosOrganizationId) return authKitSession.workosOrganizationId;
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SELECTED_WORKOS_ORGANIZATION_ID_KEY)?.trim() || null;
}

export function getLegacyPasswordToken(): string | null {
  if (typeof window === "undefined") return null;

  const token = localStorage.getItem(LEGACY_TOKEN_KEY);
  const expiresAt = localStorage.getItem(LEGACY_EXPIRES_AT_KEY);

  if (!token || !expiresAt) return null;

  if (Date.now() >= Number(expiresAt)) {
    clearAuthData();
    return null;
  }

  return token;
}

export function hasAuthenticatedSession(): boolean {
  if (authKitSession?.accessToken) return true;
  if (isAuthKitLoginEnabled()) return false;
  return Boolean(getLegacyPasswordToken());
}

function currentCompatibilityToken(): string | null {
  if (!legacyCompatibilityToken) return null;
  return Date.now() < legacyCompatibilityToken.expiresAt - 30_000
    ? legacyCompatibilityToken.token
    : null;
}

export function hasHotelAccessMarker(): boolean {
  if (authKitSession) return true;
  if (typeof window === "undefined") return false;
  return localStorage.getItem("userType") === "hotel";
}

export function isAuthOrganizationSelectionResponse(
  response: AuthSessionResponse,
): response is AuthOrganizationSelectionResponse {
  return "organizationSelectionRequired" in response && response.organizationSelectionRequired;
}

function clearSharedPropertySelectionIfOrganizationChanged(organizationId?: string): void {
  const storedOrganizationId = localStorage.getItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY);
  const hasSelectedProperty = Boolean(
    localStorage.getItem(SELECTED_SHARED_PROPERTY_ID_KEY) ||
    localStorage.getItem(SELECTED_PMS_PROPERTY_ID_KEY),
  );

  if (!organizationId) {
    if (hasSelectedProperty) {
      localStorage.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
      localStorage.removeItem(SELECTED_PMS_PROPERTY_ID_KEY);
    }
    localStorage.removeItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY);
    return;
  }

  if (hasSelectedProperty && storedOrganizationId !== organizationId) {
    localStorage.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
    localStorage.removeItem(SELECTED_PMS_PROPERTY_ID_KEY);
  }
  localStorage.setItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY, organizationId);
}

function persistPmsResourceSelection(session: AuthKitSessionResponse): void {
  const propertyIds = (session.resources?.[PMS_PROPERTY_RESOURCE_KEY] ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const storedPropertyId = [
    localStorage.getItem(SELECTED_PMS_PROPERTY_ID_KEY),
    localStorage.getItem(SELECTED_SHARED_PROPERTY_ID_KEY),
  ].find((id): id is string => Boolean(id && propertyIds.includes(id)));
  const propertyId = storedPropertyId ?? propertyIds[0];
  if (!propertyId) return;
  localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, propertyId);
  localStorage.setItem(SELECTED_PMS_PROPERTY_ID_KEY, propertyId);
  if (session.organizationId) {
    localStorage.setItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY, session.organizationId);
  }
}
