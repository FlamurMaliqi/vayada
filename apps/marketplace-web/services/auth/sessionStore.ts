import {
  setVayadaApiBearerTokenProvider,
  setVayadaApiSessionRecoveryHandlers,
} from "@vayada/marketplace-shared/api/client";
import { redirectToOrganizationSelection } from "@vayada/product-onboarding/apiSessionRecovery";
import { STORAGE_KEYS } from "@/lib/constants";
import type { UserType } from "@/lib/types";

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
  organizationKind?: "creator_workspace" | "hotel_group" | "platform" | "affiliate_partner";
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

// Migrated API calls use AuthKit. The legacy client, retained only for the
// disabled-AuthKit rollback path, reads its own stored legacy token.
setVayadaApiBearerTokenProvider(() => getAuthKitAccessToken());
setVayadaApiSessionRecoveryHandlers({
  async refresh() {
    const { authService } = await import("./auth");
    const response = await authService.refreshSession();
    return isAuthOrganizationSelectionResponse(response)
      ? { status: "organization_selection_required" }
      : { status: "session_refreshed" };
  },
  onOrganizationSelectionRequired: redirectToOrganizationSelection,
  async signOut() {
    const { authService } = await import("./auth");
    await authService.logout();
  },
});

export function setAuthKitSession(session: AuthKitSessionResponse): void {
  authKitSession = session;
  pendingOrganizationSelectionCsrfToken = null;
  if (typeof window === "undefined") return;

  clearSharedPropertySelectionIfOrganizationChanged(session.organizationId);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);

  const userType = userTypeForOrganizationKind(session.organizationKind);
  const userName = session.user.name ?? "";
  localStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");
  localStorage.setItem(STORAGE_KEYS.USER_ID, session.user.id);
  localStorage.setItem(STORAGE_KEYS.USER_EMAIL, session.user.email);
  localStorage.setItem(STORAGE_KEYS.USER_NAME, userName);
  localStorage.setItem(STORAGE_KEYS.USER_STATUS, session.user.status);
  localStorage.setItem(STORAGE_KEYS.IS_SUPERADMIN, "false");
  if (userType) {
    localStorage.setItem(STORAGE_KEYS.USER_TYPE, userType);
  } else {
    localStorage.removeItem(STORAGE_KEYS.USER_TYPE);
  }
  localStorage.setItem(
    STORAGE_KEYS.USER,
    JSON.stringify({
      id: session.user.id,
      email: session.user.email,
      name: userName,
      phone: session.user.phone ?? null,
      profilePictureUrl: session.user.profilePictureUrl ?? null,
      profilePictureMediaObjectId: session.user.profilePictureMediaObjectId ?? null,
      type: userType,
      status: session.user.status,
      is_superadmin: false,
      workos_user_id: session.user.workosUserId,
      organization_kind: session.organizationKind,
    }),
  );
}

export function setPendingOrganizationSelection(
  selection: AuthOrganizationSelectionResponse,
): void {
  authKitSession = null;
  pendingOrganizationSelectionCsrfToken = selection.csrfToken ?? null;
  if (typeof window === "undefined") return;
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
}

export function clearAuthData(): void {
  authKitSession = null;
  pendingOrganizationSelectionCsrfToken = null;
  if (typeof window === "undefined") return;

  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.removeItem(STORAGE_KEYS.USER_ID);
  localStorage.removeItem(STORAGE_KEYS.USER_EMAIL);
  localStorage.removeItem(STORAGE_KEYS.USER_NAME);
  localStorage.removeItem(STORAGE_KEYS.USER_TYPE);
  localStorage.removeItem(STORAGE_KEYS.USER_STATUS);
  localStorage.removeItem(STORAGE_KEYS.IS_SUPERADMIN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY);
  localStorage.removeItem(SELECTED_SHARED_PROPERTY_ORG_ID_KEY);
  localStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "false");
  localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
  localStorage.setItem(STORAGE_KEYS.HAS_PROFILE, "false");
}

export function getAuthCsrfToken(): string | null {
  return pendingOrganizationSelectionCsrfToken ?? authKitSession?.csrfToken ?? null;
}

export function getAuthSessionUser(): AuthUser | null {
  return authKitSession?.user ?? null;
}

export function getAuthOrganizationId(): string | null {
  return authKitSession?.organizationId ?? null;
}

export function getAuthWorkosOrganizationId(): string | null {
  return authKitSession?.workosOrganizationId ?? null;
}

export function getAuthKitAccessToken(): string | null {
  return authKitSession?.accessToken ?? null;
}

export function hasAuthenticatedSession(): boolean {
  return Boolean(authKitSession?.accessToken);
}

export function currentUserType(): UserType | null {
  return userTypeForOrganizationKind(authKitSession?.organizationKind);
}

export function isAuthOrganizationSelectionResponse(
  response: AuthSessionResponse,
): response is AuthOrganizationSelectionResponse {
  return "organizationSelectionRequired" in response && response.organizationSelectionRequired;
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

function userTypeForOrganizationKind(
  organizationKind: AuthKitSessionResponse["organizationKind"] | undefined,
): UserType | null {
  if (organizationKind === "creator_workspace") return "creator";
  if (organizationKind === "hotel_group") return "hotel";
  return null;
}
