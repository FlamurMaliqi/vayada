import { getAuthKitAccessToken } from "@/services/auth/sessionStore";

import { ApiErrorResponse, createVayadaApiClient } from "./client";

const TARGET_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const client = createVayadaApiClient(TARGET_API_BASE_URL, getAuthKitAccessToken);
let coldSessionFlight: { promise: Promise<boolean>; signal?: AbortSignal } | null = null;
const authenticatedOptions = (options?: RequestInit): RequestInit => ({
  ...options,
  credentials: "include",
});

export const targetApiClient = {
  async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    await requireAuthKitSession(options?.signal ?? undefined);
    return client.get<T>(endpoint, authenticatedOptions(options));
  },

  async put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    await requireAuthKitSession(options?.signal ?? undefined);
    return client.put<T>(endpoint, data, authenticatedOptions(options));
  },

  async post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    await requireAuthKitSession(options?.signal ?? undefined);
    return client.post<T>(endpoint, data, authenticatedOptions(options));
  },

  async delete<T>(endpoint: string, options?: RequestInit): Promise<T> {
    await requireAuthKitSession(options?.signal ?? undefined);
    return client.delete<T>(endpoint, authenticatedOptions(options));
  },
};

async function requireAuthKitSession(signal?: AbortSignal): Promise<void> {
  if (getAuthKitAccessToken()) return;
  const flight = coldSessionFlight ?? startColdSessionFlight(signal);
  try {
    await waitForSessionFlight(flight.promise, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (flight.signal?.aborted && !getAuthKitAccessToken()) {
      await requireAuthKitSession(signal);
      return;
    }
    throw error;
  }
  if (!getAuthKitAccessToken()) {
    throw new ApiErrorResponse(401, { detail: "Not authenticated" });
  }
}

function startColdSessionFlight(signal?: AbortSignal): {
  promise: Promise<boolean>;
  signal?: AbortSignal;
} {
  const flight = {
    promise: import("@/services/auth/auth").then(({ authService }) =>
      authService.ensureSession(signal),
    ),
    ...(signal ? { signal } : {}),
  };
  coldSessionFlight = flight;
  const clear = () => {
    if (coldSessionFlight === flight) coldSessionFlight = null;
  };
  void flight.promise.then(clear, clear);
  return flight;
}

function waitForSessionFlight(promise: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
