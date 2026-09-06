import { ApiErrorResponse, getVayadaApiBearerToken } from "./client";

const IDENTITY_PRIVACY_API_BASE_URL =
  process.env.NEXT_PUBLIC_IDENTITY_API_URL ??
  process.env.NEXT_PUBLIC_AUTH_API_URL ??
  "https://api.localhost";

export const identityPrivacyEndpoints = {
  cookieConsent: (visitorId?: string) =>
    `/api/identity/consent/cookies${visitorId ? `?visitor_id=${encodeURIComponent(visitorId)}` : ""}`,
  consentStatus: "/api/identity/consent/me",
  consentHistory: (limit = 50, offset = 0) =>
    `/api/identity/consent/history?limit=${limit}&offset=${offset}`,
  gdprExportRequest: "/api/identity/gdpr/export-request",
  gdprExportStatus: "/api/identity/gdpr/export-status",
  gdprExportDownload: (token: string) =>
    `/api/identity/gdpr/export-download?token=${encodeURIComponent(token)}`,
  gdprDeletionRequest: "/api/identity/gdpr/delete-request",
  gdprDeletionCancel: "/api/identity/gdpr/delete-cancel",
  gdprDeletionStatus: "/api/identity/gdpr/delete-status",
} as const;

export type CookieConsentRequest = {
  visitor_id: string;
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
};

export type CookieConsentResponse = {
  id: string;
  visitor_id: string;
  user_id: string | null;
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
  created_at: string;
  updated_at: string;
};

export type ConsentStatusResponse = {
  terms_accepted: boolean;
  terms_accepted_at: string | null;
  terms_version: string | null;
  privacy_accepted: boolean;
  privacy_accepted_at: string | null;
  privacy_version: string | null;
  marketing_consent: boolean;
  marketing_consent_at: string | null;
};

export type UpdateMarketingConsentRequest = {
  marketing_consent: boolean;
};

export type UpdateMarketingConsentResponse = {
  marketing_consent: boolean;
  marketing_consent_at: string;
  message: string;
};

export type ConsentHistoryItem = {
  id: string;
  consent_type: string;
  consent_given: boolean;
  version: string | null;
  created_at: string;
};

export type ConsentHistoryResponse = {
  history: ConsentHistoryItem[];
  total: number;
};

export type GdprExportRequestResponse = {
  id: string;
  status: string;
  requested_at: string;
  expires_at: string | null;
  download_token: string | null;
  message: string;
};

export type GdprRequestStatusResponse = {
  id: string;
  request_type: "export" | "deletion";
  status: "pending" | "processing" | "completed" | "cancelled" | "expired";
  requested_at: string;
  processed_at: string | null;
  expires_at: string | null;
  download_token?: string | null;
};

export type GdprDeletionRequestResponse = {
  id: string;
  status: string;
  requested_at: string;
  scheduled_deletion_at: string;
  message: string;
};

export type GdprDeletionCancelResponse = {
  message: string;
  cancelled: boolean;
};

export async function saveCookieConsent(
  data: CookieConsentRequest,
): Promise<CookieConsentResponse> {
  return requestIdentityPrivacy<CookieConsentResponse>(identityPrivacyEndpoints.cookieConsent(), {
    method: "POST",
    body: JSON.stringify(data),
    includeAuth: false,
    signal: AbortSignal.timeout(10_000),
  });
}

export async function getCookieConsent(visitorId: string): Promise<CookieConsentResponse | null> {
  return requestIdentityPrivacy<CookieConsentResponse | null>(
    identityPrivacyEndpoints.cookieConsent(visitorId),
    { method: "GET", includeAuth: false, signal: AbortSignal.timeout(10_000) },
  );
}

export async function getConsentStatus(): Promise<ConsentStatusResponse> {
  return requestIdentityPrivacy<ConsentStatusResponse>(identityPrivacyEndpoints.consentStatus);
}

export async function updateMarketingConsent(
  data: UpdateMarketingConsentRequest,
): Promise<UpdateMarketingConsentResponse> {
  return requestIdentityPrivacy<UpdateMarketingConsentResponse>(
    identityPrivacyEndpoints.consentStatus,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
}

export async function getConsentHistory(limit = 50, offset = 0): Promise<ConsentHistoryResponse> {
  return requestIdentityPrivacy<ConsentHistoryResponse>(
    identityPrivacyEndpoints.consentHistory(limit, offset),
  );
}

export async function requestDataExport(): Promise<GdprExportRequestResponse> {
  return requestIdentityPrivacy<GdprExportRequestResponse>(
    identityPrivacyEndpoints.gdprExportRequest,
    { method: "POST" },
  );
}

export async function getExportStatus(): Promise<GdprRequestStatusResponse> {
  return requestIdentityPrivacy<GdprRequestStatusResponse>(
    identityPrivacyEndpoints.gdprExportStatus,
  );
}

export async function downloadExport(token: string): Promise<Blob> {
  return requestIdentityPrivacy<Blob>(identityPrivacyEndpoints.gdprExportDownload(token), {
    responseType: "blob",
  });
}

export async function requestAccountDeletion(): Promise<GdprDeletionRequestResponse> {
  return requestIdentityPrivacy<GdprDeletionRequestResponse>(
    identityPrivacyEndpoints.gdprDeletionRequest,
    { method: "POST" },
  );
}

export async function cancelAccountDeletion(): Promise<GdprDeletionCancelResponse> {
  return requestIdentityPrivacy<GdprDeletionCancelResponse>(
    identityPrivacyEndpoints.gdprDeletionCancel,
    { method: "POST" },
  );
}

export async function getDeletionStatus(): Promise<GdprRequestStatusResponse> {
  return requestIdentityPrivacy<GdprRequestStatusResponse>(
    identityPrivacyEndpoints.gdprDeletionStatus,
  );
}

async function requestIdentityPrivacy<T>(
  endpoint: string,
  options: RequestInit & {
    includeAuth?: boolean;
    responseType?: "json" | "blob";
  } = {},
  retryUnauthorized = true,
  forceRefreshToken = false,
): Promise<T> {
  const { includeAuth = true, responseType = "json", ...fetchOptions } = options;
  const headers: Record<string, string> = {
    Accept: responseType === "blob" ? "application/octet-stream" : "application/json",
    ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
    ...(fetchOptions.headers as Record<string, string>),
  };
  const token = includeAuth
    ? await getVayadaApiBearerToken(fetchOptions.signal ?? undefined, forceRefreshToken)
    : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${IDENTITY_PRIVACY_API_BASE_URL}${endpoint}`, {
    ...fetchOptions,
    method: fetchOptions.method ?? "GET",
    headers,
  });

  if (response.status === 401 && includeAuth && retryUnauthorized) {
    if (fetchOptions.signal?.aborted) {
      throw (
        fetchOptions.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
      );
    }
    await response.body?.cancel().catch(() => undefined);
    return requestIdentityPrivacy<T>(endpoint, options, false, true);
  }

  if (responseType === "blob") {
    if (!response.ok) {
      throw await readApiError(response);
    }
    return response.blob() as Promise<T>;
  }

  const body = await readJsonOrText(response);
  if (!response.ok) {
    throw new ApiErrorResponse(response.status, {
      detail: readErrorMessage(response.status, body),
    });
  }
  return body as T;
}

async function readApiError(response: Response): Promise<ApiErrorResponse> {
  const body = await readJsonOrText(response);
  return new ApiErrorResponse(response.status, {
    detail: readErrorMessage(response.status, body),
  });
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) return text;
  return JSON.parse(text);
}

function readErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    if ("message" in body && typeof body.message === "string") return body.message;
    if ("detail" in body && typeof body.detail === "string") return body.detail;
  }
  if (typeof body === "string" && body) return body;
  return `Identity privacy request failed: ${status}`;
}
