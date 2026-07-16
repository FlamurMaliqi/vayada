export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
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
const SELECTED_SHARED_PROPERTY_ID_KEY = "selectedSharedPropertyId";
const SELECTED_SHARED_PROPERTY_ORG_ID_KEY = "selectedSharedPropertyOrganizationId";

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
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", session.user.id);
  localStorage.setItem("userEmail", session.user.email);
  localStorage.setItem("userName", userName);
  localStorage.setItem("userType", "hotel");
  localStorage.setItem("userStatus", session.user.status);
  localStorage.setItem("isSuperAdmin", "false");
  localStorage.setItem(
    "user",
    JSON.stringify({
      id: session.user.id,
      email: session.user.email,
      name: userName,
      phone: session.user.phone ?? null,
      type: "hotel",
      status: session.user.status,
      is_superadmin: false,
      workos_user_id: session.user.workosUserId,
    }),
  );
}

export function setLegacyCompatibilityToken(token: string, expiresIn: number): void {
  legacyCompatibilityToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
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
    is_superadmin?: boolean;
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
  localStorage.setItem("isSuperAdmin", input.user.is_superadmin ? "true" : "false");
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
  localStorage.removeItem("selectedHotelId");
  localStorage.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
  localStorage.removeItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY);
  localStorage.removeItem("isSuperAdmin");
  localStorage.setItem("isLoggedIn", "false");
}

export function getAuthCsrfToken(): string | null {
  return pendingOrganizationSelectionCsrfToken ?? authKitSession?.csrfToken ?? null;
}

export function getAuthKitAccessToken(): string | null {
  return authKitSession?.accessToken ?? null;
}

export function getAuthSessionUser(): AuthUser | null {
  return authKitSession?.user ?? null;
}

export function getAuthBearerToken(): string | null {
  if (authKitSession?.accessToken) return authKitSession.accessToken;
  return getLegacyPasswordToken();
}

export function getLegacyCompatibilityToken(): string | null {
  return currentCompatibilityToken();
}

export function getScopedBookingHotelIds(): string[] {
  const sessionScope = authKitSession?.resources?.["booking:booking_hotel"];
  const bookingHotelIds = new Set(
    Array.isArray(sessionScope)
      ? sessionScope.filter((resourceId): resourceId is string => typeof resourceId === "string")
      : [],
  );
  const tokens = [getAuthBearerToken(), getAuthKitAccessToken()].filter((token): token is string =>
    Boolean(token),
  );

  for (const token of tokens) {
    const payload = decodeJwtPayload(token);
    const resources = isRecord(payload?.resources) ? payload.resources : null;
    const scopedIds = resources?.["booking:booking_hotel"];
    if (!Array.isArray(scopedIds)) continue;
    for (const resourceId of scopedIds) {
      if (typeof resourceId === "string") bookingHotelIds.add(resourceId);
    }
  }

  return Array.from(bookingHotelIds);
}

export function getSelectedOrganizationId(): string | null {
  if (isCompatibilityTokenEnabled()) {
    const token = currentCompatibilityToken() ?? getLegacyPasswordToken();
    const payload = token ? decodeJwtPayload(token) : null;
    if (typeof payload?.org === "string") return payload.org;
  }

  return authKitSession?.organizationId ?? null;
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

export function hasHotelAccessMarker(): boolean {
  if (authKitSession) return true;
  if (typeof window === "undefined") return false;
  return (
    localStorage.getItem("userType") === "hotel" || localStorage.getItem("isSuperAdmin") === "true"
  );
}

export function isAuthOrganizationSelectionResponse(
  response: AuthSessionResponse,
): response is AuthOrganizationSelectionResponse {
  return "organizationSelectionRequired" in response && response.organizationSelectionRequired;
}

function currentCompatibilityToken(): string | null {
  if (!legacyCompatibilityToken) return null;
  return Date.now() < legacyCompatibilityToken.expiresAt - 30_000
    ? legacyCompatibilityToken.token
    : null;
}

function clearSharedPropertySelectionIfOrganizationChanged(organizationId?: string): void {
  const storedOrganizationId = localStorage.getItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY);
  const hasSelectedProperty = Boolean(localStorage.getItem(SELECTED_SHARED_PROPERTY_ID_KEY));

  if (!organizationId) {
    if (hasSelectedProperty) localStorage.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
    localStorage.removeItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY);
    return;
  }

  if (hasSelectedProperty && storedOrganizationId !== organizationId) {
    localStorage.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
  }
  localStorage.setItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY, organizationId);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload || typeof globalThis.atob !== "function") return null;

  try {
    const normalized = encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
