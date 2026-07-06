import { getAuthKitAccessToken } from "@/services/auth/sessionStore";

import { ApiErrorResponse } from "./client";

const TARGET_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";

async function targetRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = await getOrRefreshAuthKitAccessToken();
  if (!token) throw new ApiErrorResponse(401, { detail: "Not authenticated" });

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${TARGET_API_BASE_URL}${endpoint}`, {
    ...options,
    credentials: "include",
    headers,
  });

  const contentType = response.headers.get("content-type");
  const body =
    contentType?.includes("application/json") && response.status !== 204
      ? await response.json()
      : null;

  if (!response.ok) {
    throw new ApiErrorResponse(response.status, {
      detail: body?.detail ?? body?.message ?? body?.error ?? `API Error: ${response.status}`,
    });
  }

  return body as T;
}

async function getOrRefreshAuthKitAccessToken(): Promise<string | null> {
  const token = getAuthKitAccessToken();
  if (token) return token;

  const { authService } = await import("@/services/auth/auth");
  const refreshed = await authService.ensureSession();
  return refreshed ? getAuthKitAccessToken() : null;
}

export const targetApiClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return targetRequest<T>(endpoint, { ...options, method: "GET" });
  },

  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T> {
    return targetRequest<T>(endpoint, {
      ...options,
      method: "PUT",
      body: JSON.stringify(data),
    });
  },
};
