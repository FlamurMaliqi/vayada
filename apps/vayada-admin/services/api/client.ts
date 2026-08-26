/**
 * API client configuration
 */

import { getAuthBearerToken, clearAuthData } from "../auth/sessionStore";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.localhost";

export interface ApiError {
  detail?:
    | string
    | Array<{
        loc: (string | number)[];
        msg: string;
        type: string;
      }>;
  message?: string;
}

export class ApiErrorResponse extends Error {
  status: number;
  data: ApiError;

  constructor(status: number, data: ApiError) {
    const detail = typeof data.detail === "string" ? data.detail : data.message;
    super(detail || `API Error: ${status}`);
    this.name = "ApiErrorResponse";
    this.status = status;
    this.data = data;
  }
}

export class ApiClient {
  private baseURL: string;

  constructor(baseURL: string = API_BASE_URL) {
    this.baseURL = baseURL;
  }

  /**
   * Handle 401 errors (token expired/invalid)
   */
  private handleUnauthorized(error: ApiErrorResponse): void {
    clearAuthData();

    if (typeof window !== "undefined") {
      const isExpired = error.message.toLowerCase().includes("expired");

      if (isExpired) {
        window.location.href = "/login?expired=true";
      } else {
        window.location.href = "/login";
      }
    }
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseURL}${endpoint}`;

    // Skip token only for endpoints that don't require auth (exact path match)
    const PUBLIC_ENDPOINTS = [
      "/auth/login",
      "/auth/register",
      "/auth/forgot-password",
      "/auth/reset-password",
      "/auth/totp/verify",
    ];
    const normalizedEndpoint = endpoint.split("?")[0].split("#")[0];
    const isPublic = PUBLIC_ENDPOINTS.includes(normalizedEndpoint);
    const token = isPublic ? null : getAuthBearerToken();

    const headers = new Headers(options.headers);
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    // Add Authorization header if token exists
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const config: RequestInit = {
      ...options,
      headers,
    };

    try {
      const response = await fetch(url, config);

      // Handle 204 No Content responses (no body to parse)
      if (response.status === 204) {
        if (!response.ok) {
          throw new ApiErrorResponse(response.status, { detail: "No Content" });
        }
        return undefined as T;
      }

      // Check if response has content to parse
      const contentType = response.headers.get("content-type");
      const hasJsonContent = contentType && contentType.includes("application/json");

      let data: any;
      if (hasJsonContent) {
        const text = await response.text();
        data = text ? JSON.parse(text) : null;
      } else {
        const text = await response.text();
        data = text || null;
      }

      if (!response.ok) {
        const error = new ApiErrorResponse(response.status, data as ApiError);

        // Handle 401 errors (token expired/invalid)
        if (response.status === 401 && !isPublic) {
          this.handleUnauthorized(error);
        }

        throw error;
      }

      return data as T;
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error;
      }
      if (error instanceof SyntaxError && error.message.includes("JSON")) {
        return undefined as T;
      }
      console.error("API request failed:", error);
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
}

export const apiClient = new ApiClient();
