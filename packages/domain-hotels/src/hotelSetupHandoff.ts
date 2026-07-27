import {
  SETUP_TASK_DESTINATION_ROUTE_KEYS,
  SETUP_TASK_IDS,
  type SetupTaskId,
} from "./adaptiveHotelSetup.js";

export type CreateHotelSetupHandoffRequest = {
  propertyId: string;
  taskId: SetupTaskId;
  planRevision: string;
};

export type CreateHotelSetupHandoffResponse = {
  launchUrl: string;
  expiresAt: string;
};

export type ExchangeHotelSetupHandoffRequest = {
  code: string;
};

export type ExchangeHotelSetupHandoffResponse = {
  propertyId: string;
  taskId: SetupTaskId;
  issuedPlanRevision: string;
  destinationRouteKey: string;
  returnUrl: string;
};

export type HotelSetupHandoffError = {
  code: "invalid_handoff" | "refresh_plan";
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PLAN_REVISION_LENGTH = 8_192;

export function parseCreateHotelSetupHandoffRequest(
  value: unknown,
): CreateHotelSetupHandoffRequest | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["propertyId", "taskId", "planRevision"]) ||
    !isUuid(value["propertyId"]) ||
    !isSetupTaskId(value["taskId"]) ||
    !isPlanRevision(value["planRevision"])
  ) {
    return null;
  }
  return value as CreateHotelSetupHandoffRequest;
}

export function parseCreateHotelSetupHandoffResponse(
  value: unknown,
): CreateHotelSetupHandoffResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["launchUrl", "expiresAt"]) ||
    !isIsoTimestamp(value["expiresAt"]) ||
    !isHandoffLaunchUrl(value["launchUrl"])
  ) {
    return null;
  }
  return value as CreateHotelSetupHandoffResponse;
}

export function parseExchangeHotelSetupHandoffRequest(
  value: unknown,
): ExchangeHotelSetupHandoffRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["code"]) || !isOpaqueHandoffCode(value["code"])) {
    return null;
  }
  return value as ExchangeHotelSetupHandoffRequest;
}

export function parseExchangeHotelSetupHandoffResponse(
  value: unknown,
): ExchangeHotelSetupHandoffResponse | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "propertyId",
      "taskId",
      "issuedPlanRevision",
      "destinationRouteKey",
      "returnUrl",
    ]) ||
    !isUuid(value["propertyId"]) ||
    !isSetupTaskId(value["taskId"]) ||
    !isPlanRevision(value["issuedPlanRevision"]) ||
    value["destinationRouteKey"] !==
      SETUP_TASK_DESTINATION_ROUTE_KEYS[value["taskId"] as SetupTaskId] ||
    !isCanonicalReturnUrl(value["returnUrl"], value["propertyId"])
  ) {
    return null;
  }
  return value as ExchangeHotelSetupHandoffResponse;
}

export function parseHotelSetupHandoffError(value: unknown): HotelSetupHandoffError | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["code"]) ||
    (value["code"] !== "invalid_handoff" && value["code"] !== "refresh_plan")
  ) {
    return null;
  }
  return value as HotelSetupHandoffError;
}

export function isOpaqueHotelSetupHandoffCode(value: unknown): value is string {
  return isOpaqueHandoffCode(value);
}

function isSetupTaskId(value: unknown): value is SetupTaskId {
  return typeof value === "string" && (SETUP_TASK_IDS as readonly string[]).includes(value);
}

function isPlanRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PLAN_REVISION_LENGTH &&
    value.trim() === value
  );
}

function isOpaqueHandoffCode(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_CODE_PATTERN.test(value);
}

function isHandoffLaunchUrl(value: unknown): value is string {
  const url = parseWebUrl(value);
  if (!url || url.pathname !== "/handoff" || url.hash || url.username || url.password) {
    return false;
  }
  return (
    [...url.searchParams.keys()].every((key) => key === "code") &&
    url.searchParams.getAll("code").length === 1 &&
    isOpaqueHandoffCode(url.searchParams.get("code"))
  );
}

function isCanonicalReturnUrl(value: unknown, propertyId: unknown): value is string {
  const url = parseWebUrl(value);
  return Boolean(
    url &&
    typeof propertyId === "string" &&
    url.pathname === "/setup" &&
    !url.hash &&
    !url.username &&
    !url.password &&
    [...url.searchParams.keys()].every((key) => key === "propertyId") &&
    url.searchParams.getAll("propertyId").length === 1 &&
    url.searchParams.get("propertyId") === propertyId,
  );
}

function parseWebUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname.endsWith(".localhost")))
      ? url
      : null;
  } catch {
    return null;
  }
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
