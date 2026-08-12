import { ApiErrorResponse } from "./client";

export type BookingSettingsClientOperation = "read" | "write";

export type BookingSettingsClientErrorStatusCode = 401 | 403 | 404 | 409 | 422 | 500;

export type BookingSettingsClientErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "read_model"
  | "write_model";

export type BookingSettingsClientErrorCode =
  | "unauthenticated"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "invalid_payload"
  | "plan_limit_reached"
  | "conflict"
  | "not_found"
  | "read_model_unavailable"
  | "write_model_unavailable";

export interface BookingSettingsClientErrorInput {
  statusCode: BookingSettingsClientErrorStatusCode;
  code: BookingSettingsClientErrorCode;
  category: BookingSettingsClientErrorCategory;
  detail: string;
  details?: unknown;
}

export function toBookingSettingsClientErrorInput(
  error: unknown,
  input: {
    operation: BookingSettingsClientOperation;
    fallbackDetail: string;
    readNotFound: boolean;
  },
): BookingSettingsClientErrorInput {
  if (error instanceof ApiErrorResponse) {
    return mapApiError(error, input);
  }

  const fallback = toFallbackUnavailable(input.operation);
  return {
    statusCode: 500,
    code: fallback.code,
    category: fallback.category,
    detail: error instanceof Error ? error.message : input.fallbackDetail,
  };
}

function mapApiError(
  error: ApiErrorResponse,
  input: {
    operation: BookingSettingsClientOperation;
    fallbackDetail: string;
    readNotFound: boolean;
  },
): BookingSettingsClientErrorInput {
  const contractError = readContractErrorBody(error, input);
  if (contractError) {
    return contractError;
  }

  const detail = readApiErrorDetail(error, input.fallbackDetail);

  if (error.status === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      detail,
    };
  }

  if (error.status === 403) {
    return {
      statusCode: 403,
      code: toAuthorizationErrorCode(detail),
      category: "authorization",
      detail,
    };
  }

  if (error.status === 404 && (input.operation === "write" || input.readNotFound)) {
    return {
      statusCode: 404,
      code: "not_found",
      category: input.operation === "write" ? "write_model" : "read_model",
      detail,
    };
  }

  if (error.status === 409 && input.operation === "write") {
    return {
      statusCode: 409,
      code: "conflict",
      category: "validation",
      detail,
    };
  }

  if (error.status === 422 && input.operation === "write") {
    return {
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      detail,
    };
  }

  const fallback = toFallbackUnavailable(input.operation);
  return {
    statusCode: 500,
    code: fallback.code,
    category: fallback.category,
    detail,
  };
}

function readContractErrorBody(
  error: ApiErrorResponse,
  input: {
    operation: BookingSettingsClientOperation;
    fallbackDetail: string;
    readNotFound: boolean;
  },
): BookingSettingsClientErrorInput | null {
  const data = error.data as Partial<{
    statusCode: unknown;
    code: unknown;
    category: unknown;
    message: unknown;
    details: unknown;
  }> | null;
  if (!data) return null;
  if (!isBookingSettingsClientErrorCode(data.code)) return null;
  if (!isBookingSettingsClientErrorCategory(data.category)) return null;
  if (!isErrorAllowedForOperation(data.code, data.category, input)) return null;

  return {
    statusCode: toContractStatusCode(data.statusCode, error.status),
    code: data.code,
    category: data.category,
    detail:
      typeof data.message === "string" && data.message.trim() ? data.message : input.fallbackDetail,
    details: data.details,
  };
}

function isErrorAllowedForOperation(
  code: BookingSettingsClientErrorCode,
  category: BookingSettingsClientErrorCategory,
  input: {
    operation: BookingSettingsClientOperation;
    readNotFound: boolean;
  },
): boolean {
  if (input.operation === "write") {
    return category !== "read_model" && code !== "read_model_unavailable";
  }

  if (category === "validation" || category === "write_model") return false;
  if (code === "invalid_payload" || code === "write_model_unavailable") return false;
  if (code === "not_found" && !input.readNotFound) return false;
  return true;
}

function readApiErrorDetail(error: ApiErrorResponse, fallbackDetail: string): string {
  const data = error.data as Partial<{ detail: unknown; message: unknown }> | null;
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const message = detail.map(readApiErrorDetailEntry).filter(Boolean).join(", ");
    if (message) return message;
  }
  if (typeof data?.message === "string") return data.message;
  return error.message || fallbackDetail;
}

function readApiErrorDetailEntry(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "msg" in entry) {
    const message = (entry as { msg?: unknown }).msg;
    return typeof message === "string" ? message : "";
  }
  return "";
}

function toAuthorizationErrorCode(
  detail: string,
): Extract<
  BookingSettingsClientErrorCode,
  "missing_permission" | "missing_entitlement" | "inactive_entitlement" | "missing_resource_access"
> {
  const normalized = detail.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (
    normalized.includes("inactive") ||
    normalized.includes("suspended") ||
    normalized.includes("disabled") ||
    normalized.includes("not active")
  ) {
    return "inactive_entitlement";
  }
  if (normalized.includes("entitlement")) return "missing_entitlement";
  return "missing_resource_access";
}

function toContractStatusCode(
  bodyStatusCode: unknown,
  responseStatus: number,
): BookingSettingsClientErrorStatusCode {
  if (
    bodyStatusCode === 401 ||
    bodyStatusCode === 403 ||
    bodyStatusCode === 404 ||
    bodyStatusCode === 409 ||
    bodyStatusCode === 422 ||
    bodyStatusCode === 500
  ) {
    return bodyStatusCode;
  }
  if (
    responseStatus === 401 ||
    responseStatus === 403 ||
    responseStatus === 404 ||
    responseStatus === 409 ||
    responseStatus === 422
  ) {
    return responseStatus;
  }
  return 500;
}

function isBookingSettingsClientErrorCode(value: unknown): value is BookingSettingsClientErrorCode {
  return (
    value === "unauthenticated" ||
    value === "missing_permission" ||
    value === "missing_entitlement" ||
    value === "inactive_entitlement" ||
    value === "missing_resource_access" ||
    value === "not_found" ||
    value === "invalid_payload" ||
    value === "plan_limit_reached" ||
    value === "conflict" ||
    value === "read_model_unavailable" ||
    value === "write_model_unavailable"
  );
}

function isBookingSettingsClientErrorCategory(
  value: unknown,
): value is BookingSettingsClientErrorCategory {
  return (
    value === "authentication" ||
    value === "authorization" ||
    value === "validation" ||
    value === "read_model" ||
    value === "write_model"
  );
}

function toFallbackUnavailable(operation: BookingSettingsClientOperation): {
  code: "read_model_unavailable" | "write_model_unavailable";
  category: "read_model" | "write_model";
} {
  return operation === "write"
    ? { code: "write_model_unavailable", category: "write_model" }
    : { code: "read_model_unavailable", category: "read_model" };
}
