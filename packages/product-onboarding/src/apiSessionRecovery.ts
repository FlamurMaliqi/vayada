export type ApiSessionRefreshResult =
  | { status: "session_refreshed" }
  | { status: "organization_selection_required" };

export type ApiSessionRecoveryHandlers = {
  refresh: () => Promise<ApiSessionRefreshResult | void>;
  onOrganizationSelectionRequired?: () => Promise<void> | void;
  signOut: () => Promise<void> | void;
};

type ApiSessionRecoveryState = {
  organizationSelectionPromise: Promise<void> | null;
  refreshPromise: Promise<ApiSessionRefreshResult | void> | null;
  signOutPromise: Promise<void> | null;
};

type SessionRecoveryResult = {
  refreshError?: unknown;
  refreshResult?: ApiSessionRefreshResult | void;
  token: string | null;
};

const recoveryStates = new WeakMap<ApiSessionRecoveryHandlers, ApiSessionRecoveryState>();

export function redirectToOrganizationSelection(): void {
  if (typeof window === "undefined") return;
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const loginUrl = new URL("/login", window.location.origin);
  loginUrl.searchParams.set("auth", "callback");
  loginUrl.searchParams.set("returnTo", returnTo);
  window.location.href = loginUrl.toString();
}

export async function recoverUnauthorizedResponse(input: {
  response: Response;
  failedToken: string | null;
  getToken: () => string | null;
  retry: (token: string) => Promise<Response>;
  handlers: ApiSessionRecoveryHandlers;
}): Promise<Response> {
  if (input.response.status !== 401) return input.response;

  const recovery = await recoverSession(input.failedToken, input.getToken, input.handlers);
  if (!recovery.token) {
    if (recovery.refreshResult?.status === "organization_selection_required") {
      await notifyOrganizationSelectionRequiredOnce(input.handlers);
    } else if (
      isDefinitiveAuthenticationFailure(recovery.refreshError) ||
      recovery.refreshError === undefined
    ) {
      await signOutOnce(input.handlers);
    }
    return input.response;
  }

  const retryResponse = await input.retry(recovery.token);
  if (retryResponse.status === 401) {
    await signOutOnce(input.handlers);
  }
  return retryResponse;
}

async function recoverSession(
  failedToken: string | null,
  getToken: () => string | null,
  handlers: ApiSessionRecoveryHandlers,
): Promise<SessionRecoveryResult> {
  const currentToken = getToken();
  if (currentToken && currentToken !== failedToken) return { token: currentToken };

  const state = recoveryState(handlers);
  if (!state.refreshPromise) {
    state.refreshPromise = Promise.resolve()
      .then(() => handlers.refresh())
      .finally(() => {
        state.refreshPromise = null;
      });
  }

  let refreshResult: ApiSessionRefreshResult | void;
  try {
    refreshResult = await state.refreshPromise;
  } catch (refreshError) {
    return { refreshError, token: null };
  }

  const refreshedToken = getToken();
  return {
    refreshResult,
    token: refreshedToken && refreshedToken !== failedToken ? refreshedToken : null,
  };
}

async function notifyOrganizationSelectionRequiredOnce(
  handlers: ApiSessionRecoveryHandlers,
): Promise<void> {
  if (!handlers.onOrganizationSelectionRequired) return;
  const state = recoveryState(handlers);
  if (!state.organizationSelectionPromise) {
    state.organizationSelectionPromise = Promise.resolve()
      .then(() => handlers.onOrganizationSelectionRequired?.())
      .catch(() => undefined)
      .finally(() => {
        state.organizationSelectionPromise = null;
      });
  }
  await state.organizationSelectionPromise;
}

function isDefinitiveAuthenticationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

async function signOutOnce(handlers: ApiSessionRecoveryHandlers): Promise<void> {
  const state = recoveryState(handlers);
  if (!state.signOutPromise) {
    state.signOutPromise = Promise.resolve()
      .then(() => handlers.signOut())
      .catch(() => undefined)
      .finally(() => {
        state.signOutPromise = null;
      });
  }
  await state.signOutPromise;
}

function recoveryState(handlers: ApiSessionRecoveryHandlers): ApiSessionRecoveryState {
  const existing = recoveryStates.get(handlers);
  if (existing) return existing;
  const created: ApiSessionRecoveryState = {
    organizationSelectionPromise: null,
    refreshPromise: null,
    signOutPromise: null,
  };
  recoveryStates.set(handlers, created);
  return created;
}
