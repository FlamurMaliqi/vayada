export type AuthUser = {
  id: string;
  email: string;
  status: string;
  workosUserId?: string;
};

export type AuthKitSessionResponse = {
  accessToken: string;
  csrfToken?: string;
  organizationId?: string;
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
const SELECTED_PMS_PROPERTY_ID_KEY = "selectedHotelId";
const SELECTED_SHARED_PROPERTY_ID_KEY = "selectedSharedPropertyId";
const SELECTED_SHARED_PROPERTY_ORG_ID_KEY = "selectedSharedPropertyOrganizationId";
const PMS_PROPERTY_RESOURCE_KEY = "pms:pms_property";

let authKitSession: AuthKitSessionResponse | null = null;
let pendingOrganizationSelectionCsrfToken: string | null = null;
let legacyCompatibilityToken: { token: string; expiresAt: number } | null = null;

export function isAuthKitLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED !== "false";
}

export function isLegacyPasswordFallbackEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LEGACY_FALLBACK_ENABLED === "true";
}

export function isCompatibilityTokenEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED === "true";
}

export function setAuthKitSession(session: AuthKitSessionResponse): void {
  authKitSession = session;
  pendingOrganizationSelectionCsrfToken = null;
  if (typeof window === "undefined") return;
  clearSharedPropertySelectionIfOrganizationChanged(session.organizationId);
  persistPmsResourceSelection(session);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", session.user.id);
  localStorage.setItem("userEmail", session.user.email);
  localStorage.setItem("userType", "hotel");
  localStorage.setItem("userStatus", session.user.status);
  localStorage.setItem(
    "user",
    JSON.stringify({
      id: session.user.id,
      email: session.user.email,
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
  pendingOrganizationSelectionCsrfToken = selection.csrfToken ?? null;
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
  localStorage.setItem("isLoggedIn", "false");
}

export function getAuthCsrfToken(): string | null {
  return pendingOrganizationSelectionCsrfToken ?? authKitSession?.csrfToken ?? null;
}

export function getAuthBearerToken(): string | null {
  const compatibilityToken = currentCompatibilityToken();
  if (isCompatibilityTokenEnabled() && compatibilityToken) return compatibilityToken;
  if (authKitSession?.accessToken) return authKitSession.accessToken;
  return getLegacyPasswordToken();
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
  if (authKitSession?.accessToken) {
    return Boolean(getAuthBearerToken());
  }
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
  const propertyId = session.resources?.[PMS_PROPERTY_RESOURCE_KEY]?.find((id) => id.trim());
  if (!propertyId) return;
  localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, propertyId.trim());
  localStorage.setItem(SELECTED_PMS_PROPERTY_ID_KEY, propertyId.trim());
  if (session.organizationId) {
    localStorage.setItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY, session.organizationId);
  }
}
