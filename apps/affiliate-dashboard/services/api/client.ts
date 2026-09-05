/**
 * API client for the affiliate dashboard.
 *
 * Auth: protected target routes receive the AuthKit access token resolved by
 * apps/api. Tokens are kept in memory only and are never persisted to
 * localStorage.
 */

import { authService } from "@/services/auth";
import { clearAuthData, getAuthBearerToken } from "@/services/auth/storage";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.localhost";

export interface ApiError {
  detail:
    | string
    | Array<{
        loc: (string | number)[];
        msg: string;
        type: string;
      }>;
}

export class ApiErrorResponse extends Error {
  status: number;
  data: ApiError;

  constructor(status: number, data: ApiError) {
    super((data.detail as string) || `API Error: ${status}`);
    this.name = "ApiErrorResponse";
    this.status = status;
    this.data = data;
  }
}

export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiErrorResponse) {
    if (typeof err.data.detail === "string" && err.data.detail) return err.data.detail;
    if (Array.isArray(err.data.detail) && err.data.detail.length > 0) {
      return err.data.detail[0].msg;
    }
    return err.message || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export class ApiClient {
  private baseURL: string;

  constructor(baseURL: string = API_BASE_URL) {
    this.baseURL = baseURL;
  }

  private handleUnauthorized(error: ApiErrorResponse): void {
    clearAuthData();

    if (typeof window !== "undefined") {
      const errorMessage = (typeof error.data.detail === "string" ? error.data.detail : "") || "";
      const isExpired = errorMessage.includes("expired") || errorMessage.includes("Expired");
      window.location.href = isExpired ? "/login?expired=true" : "/login";
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit & { redirectOnUnauthorized?: boolean } = {},
  ): Promise<T> {
    const { redirectOnUnauthorized = true, ...fetchOptions } = options;
    const url = `${this.baseURL}${endpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };
    let token = getAuthBearerToken();
    if (!token && !endpoint.startsWith("/auth/")) {
      const refreshed = await authService.ensureSession();
      token = refreshed ? getAuthBearerToken() : null;
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...fetchOptions,
      headers,
    });

    if (response.status === 204) {
      if (!response.ok) {
        throw new ApiErrorResponse(response.status, { detail: "No Content" });
      }
      return undefined as T;
    }

    const contentType = response.headers.get("content-type");
    const isJson = contentType?.includes("application/json") ?? false;
    const text = await response.text();

    let data: unknown;
    if (isJson) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
    } else {
      data = text || null;
    }

    if (!response.ok) {
      const errorData: ApiError = isApiError(data)
        ? (data as ApiError)
        : { detail: typeof data === "string" && data ? data : `API Error: ${response.status}` };
      const error = new ApiErrorResponse(response.status, errorData);

      if (redirectOnUnauthorized && response.status === 401 && !endpoint.startsWith("/auth/")) {
        this.handleUnauthorized(error);
      }

      throw error;
    }

    return data as T;
  }

  async get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: "GET" });
  }

  async post<T>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit & { redirectOnUnauthorized?: boolean },
  ): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: "POST",
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
}

export const apiClient = new ApiClient();

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "detail" in value;
}
