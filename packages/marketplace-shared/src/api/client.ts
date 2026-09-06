/**
 * API client configuration
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.marketplace.localhost";
export const VAYADA_API_BASE_URL =
  process.env.NEXT_PUBLIC_VAYADA_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.localhost";
let bearerTokenProvider: (() => string | null) | null = null;
type VayadaBearerTokenProvider = (
  signal?: AbortSignal,
  forceRefresh?: boolean,
) => string | null | Promise<string | null>;
let vayadaBearerTokenProvider: VayadaBearerTokenProvider | null = null;
let vayadaSessionRecoveryHandlers: ApiSessionRecoveryHandlers | null = null;

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

const sessionRecoveryStates = new WeakMap<ApiSessionRecoveryHandlers, ApiSessionRecoveryState>();

export type ApiSessionRefreshResult =
  | { status: "session_refreshed" }
  | { status: "organization_selection_required" };

export type ApiSessionRecoveryHandlers = {
  refresh: () => Promise<ApiSessionRefreshResult | void>;
  onOrganizationSelectionRequired?: () => Promise<void> | void;
  signOut: () => Promise<void> | void;
};

export function setApiBearerTokenProvider(provider: (() => string | null) | null): void {
  bearerTokenProvider = provider;
}

export function setVayadaApiBearerTokenProvider(provider: VayadaBearerTokenProvider | null): void {
  vayadaBearerTokenProvider = provider;
}

export function getVayadaApiBearerToken(
  signal?: AbortSignal,
  forceRefresh = false,
): string | null | Promise<string | null> {
  return vayadaBearerTokenProvider?.(signal, forceRefresh) ?? null;
}

export function setVayadaApiSessionRecoveryHandlers(
  handlers: ApiSessionRecoveryHandlers | null,
): void {
  vayadaSessionRecoveryHandlers = handlers;
}

export function getApiBearerToken(): string | null {
  if (bearerTokenProvider) {
    const token = bearerTokenProvider();
    if (token) return token;
  }
  return getStoredLegacyToken();
}

function getStoredLegacyToken(): string | null {
  if (typeof window === "undefined") return null;

  const token = localStorage.getItem("access_token");
  const expiresAt = localStorage.getItem("token_expires_at");

  if (!token || !expiresAt) return null;

  if (Date.now() >= Number(expiresAt)) {
    localStorage.removeItem("access_token");
    localStorage.removeItem("token_expires_at");
    return null;
  }

  return token;
}

export interface ApiError {
  detail?:
    | string
    | Array<{
        loc: (string | number)[];
        msg: string;
        type: string;
      }>;
  message?: string;
  error?: string;
  code?: string;
  category?: string;
}

export class ApiErrorResponse extends Error {
  status: number;
  data: ApiError;

  constructor(status: number, data: ApiError) {
    super(
      (typeof data.detail === "string" ? data.detail : null) ||
        data.message ||
        data.error ||
        `API Error: ${status}`,
    );
    this.name = "ApiErrorResponse";
    this.status = status;
    this.data = data;
  }
}

function wasRequestAborted(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    signal?.aborted === true &&
    (error === signal.reason ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"))
  );
}

export class ApiClient {
  private baseURL: string;
  private tokenProvider?: VayadaBearerTokenProvider;
  private sessionRecoveryProvider?: () => ApiSessionRecoveryHandlers | null;
  private retryUnauthorizedWithTokenProvider: boolean;

  constructor(
    baseURL: string = API_BASE_URL,
    tokenProvider?: VayadaBearerTokenProvider,
    sessionRecoveryProvider?: () => ApiSessionRecoveryHandlers | null,
    retryUnauthorizedWithTokenProvider = false,
  ) {
    this.baseURL = baseURL;
    this.tokenProvider = tokenProvider;
    this.sessionRecoveryProvider = sessionRecoveryProvider;
    this.retryUnauthorizedWithTokenProvider = retryUnauthorizedWithTokenProvider;
  }

  /**
   * Get JWT token from localStorage if not expired
   */
  private async getToken(signal?: AbortSignal, forceRefresh = false): Promise<string | null> {
    if (this.tokenProvider) return this.tokenProvider(signal, forceRefresh);
    return getApiBearerToken();
  }

  /**
   * Clear token from localStorage
   */
  private clearToken(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem("access_token");
    localStorage.removeItem("token_expires_at");
  }

  /**
   * Handle 401 errors (token expired/invalid)
   */
  private handleUnauthorized(error: ApiErrorResponse): void {
    this.clearToken();

    if (typeof window !== "undefined") {
      const errorMessage = (error.data.detail as string) || "";
      const isExpired = errorMessage.includes("expired") || errorMessage.includes("Expired");

      if (isExpired) {
        window.location.href = "/login?expired=true";
      } else {
        window.location.href = "/login";
      }
    }
  }

  private async fetchWithSessionRecovery(
    url: string,
    endpoint: string,
    config: RequestInit,
    failedToken: string | null,
  ): Promise<Response> {
    const response = await fetch(url, config);
    const handlers = this.sessionRecoveryProvider?.() ?? null;
    if (response.status !== 401 || endpoint.startsWith("/auth/")) {
      return response;
    }

    if (!handlers && this.retryUnauthorizedWithTokenProvider && this.tokenProvider) {
      const refreshedToken = await this.getToken(config.signal ?? undefined, true);
      if (!refreshedToken) return response;
      await response.body?.cancel().catch(() => undefined);
      return fetch(url, {
        ...config,
        headers: {
          ...(config.headers as Record<string, string>),
          Authorization: `Bearer ${refreshedToken}`,
        },
      });
    }

    if (!handlers) return response;

    const recovery = await this.recoverSession(failedToken, handlers);
    if (!recovery.token) {
      if (recovery.refreshResult?.status === "organization_selection_required") {
        await this.notifyOrganizationSelectionRequired(handlers);
      } else if (
        isDefinitiveAuthenticationFailure(recovery.refreshError) ||
        recovery.refreshError === undefined
      ) {
        await this.signOut(handlers);
      }
      return response;
    }

    const retryResponse = await fetch(url, {
      ...config,
      headers: {
        ...(config.headers as Record<string, string>),
        Authorization: `Bearer ${recovery.token}`,
      },
    });
    if (retryResponse.status === 401) {
      await this.signOut(handlers);
    }
    return retryResponse;
  }

  private async recoverSession(
    failedToken: string | null,
    handlers: ApiSessionRecoveryHandlers,
  ): Promise<SessionRecoveryResult> {
    const state = getSessionRecoveryState(handlers);
    const currentToken = await this.getToken();
    if (currentToken && currentToken !== failedToken) return { token: currentToken };

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
    const refreshedToken = await this.getToken();
    return {
      refreshResult,
      token: refreshedToken && refreshedToken !== failedToken ? refreshedToken : null,
    };
  }

  private async notifyOrganizationSelectionRequired(
    handlers: ApiSessionRecoveryHandlers,
  ): Promise<void> {
    if (!handlers.onOrganizationSelectionRequired) return;
    const state = getSessionRecoveryState(handlers);
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

  private async signOut(handlers: ApiSessionRecoveryHandlers): Promise<void> {
    const state = getSessionRecoveryState(handlers);
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

  async request<T>(
    endpoint: string,
    options: RequestInit = {},
    responseType: "json" | "blob" = "json",
  ): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;

    // Get token for authenticated requests (skip for auth endpoints)
    const token = !endpoint.startsWith("/auth/")
      ? await this.getToken(options.signal ?? undefined)
      : null;

    const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
    const headers: Record<string, string> = {
      ...(options.body !== undefined && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(options.headers as Record<string, string>),
    };

    // Add Authorization header if token exists
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const config: RequestInit = {
      ...options,
      headers,
    };

    try {
      if (config.signal?.aborted) {
        throw config.signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      const response = await this.fetchWithSessionRecovery(url, endpoint, config, token);

      if (response.ok && responseType === "blob") return response.blob() as Promise<T>;

      // Handle 204 No Content responses (no body to parse)
      if (response.status === 204) {
        if (!response.ok) {
          // Shouldn't happen, but handle it just in case
          throw new ApiErrorResponse(response.status, { detail: "No Content" });
        }
        return undefined as T;
      }

      // Check if response has content to parse
      const contentType = response.headers.get("content-type");
      const hasJsonContent = contentType && contentType.includes("application/json");

      let data: unknown;
      if (hasJsonContent) {
        const text = await response.text();
        // Only parse JSON if there's actual content
        data = text ? JSON.parse(text) : null;
      } else {
        // For non-JSON responses, try to get text or return null
        const text = await response.text();
        data = text || null;
      }

      if (!response.ok) {
        const error = new ApiErrorResponse(
          response.status,
          data && typeof data === "object"
            ? (data as ApiError)
            : {
                detail: typeof data === "string" && data ? data : `API Error: ${response.status}`,
              },
        );

        // Handle 401 errors (token expired/invalid)
        // Skip redirect for auth endpoints (login/register) - let them handle errors
        if (
          response.status === 401 &&
          !endpoint.startsWith("/auth/") &&
          !this.retryUnauthorizedWithTokenProvider &&
          !this.sessionRecoveryProvider?.()
        ) {
          this.handleUnauthorized(error);
        }

        throw error;
      }

      return data as T;
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error;
      }
      // Handle JSON parse errors (e.g., empty response)
      if (error instanceof SyntaxError && error.message.includes("JSON")) {
        // If it's a successful response but JSON parse failed, return undefined
        // This handles edge cases where response is empty but status is OK
        return undefined as T;
      }
      if (!wasRequestAborted(error, config.signal)) {
        console.error("API request failed:", error);
      }
      throw error;
    }
  }

  async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "GET" });
  }

  async post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async patch<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async delete<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "DELETE" });
  }

  /**
   * Upload file(s) using multipart/form-data
   * Supports POST, PUT, and PATCH methods
   */
  async upload<T>(endpoint: string, formData: FormData, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: options?.method || "POST",
      body: formData,
    });
  }
}

function isDefinitiveAuthenticationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function getSessionRecoveryState(handlers: ApiSessionRecoveryHandlers): ApiSessionRecoveryState {
  const existing = sessionRecoveryStates.get(handlers);
  if (existing) return existing;
  const created: ApiSessionRecoveryState = {
    organizationSelectionPromise: null,
    refreshPromise: null,
    signOutPromise: null,
  };
  sessionRecoveryStates.set(handlers, created);
  return created;
}

export function createVayadaApiClient(
  baseURL: string = VAYADA_API_BASE_URL,
  tokenProvider: VayadaBearerTokenProvider = getVayadaApiBearerToken,
): ApiClient {
  return new ApiClient(baseURL, tokenProvider, () => vayadaSessionRecoveryHandlers, true);
}

export const apiClient = new ApiClient(
  API_BASE_URL,
  getApiBearerToken,
  () => vayadaSessionRecoveryHandlers,
);
export const vayadaApiClient = createVayadaApiClient();
