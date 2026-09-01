import type {
  CreatorPlatformGrant,
  CreatorPlatformMetric,
  CreatorPlatformProvider,
  CreatorPlatformUnavailableReason,
} from "./types.js";

const CREATOR_PLATFORM_REQUEST_TIMEOUT_MS = 30_000;

export class CreatorPlatformResponseError extends Error {
  constructor(provider: CreatorPlatformProvider, detail: string) {
    super(`${provider} returned an invalid response: ${detail}`);
    this.name = "CreatorPlatformResponseError";
  }
}

export class CreatorPlatformRequestError extends Error {
  readonly status: number;
  readonly category: CreatorPlatformRequestErrorCategory;
  readonly reason?: string;

  constructor(
    provider: CreatorPlatformProvider,
    status: number,
    category: CreatorPlatformRequestErrorCategory,
    reason?: string,
  ) {
    super(`${provider} request failed with status ${status}`);
    this.name = "CreatorPlatformRequestError";
    this.status = status;
    this.category = category;
    this.reason = reason;
  }
}

export type CreatorPlatformRequestErrorCategory =
  "authorization" | "permission" | "privacy" | "rate_limit" | "quota" | "transient" | "request";

export type CreatorPlatformOptionalResponse =
  | { ok: true; value: unknown }
  | {
      ok: false;
      unavailableReason: Extract<
        CreatorPlatformUnavailableReason,
        "privacy_threshold" | "missing_permission"
      >;
    };

export async function fetchJson(
  provider: CreatorPlatformProvider,
  fetcher: typeof fetch,
  input: string | URL,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetcher(input, boundedRequestInit(init));
  if (!response.ok) {
    throw await requestError(provider, response);
  }
  try {
    return await response.json();
  } catch (error) {
    if (isAbortLikeError(error)) throw error;
    throw new CreatorPlatformResponseError(provider, "expected JSON");
  }
}

export async function fetchOptionalJson(
  provider: CreatorPlatformProvider,
  fetcher: typeof fetch,
  input: string | URL,
  init?: RequestInit,
): Promise<CreatorPlatformOptionalResponse> {
  try {
    return { ok: true, value: await fetchJson(provider, fetcher, input, init) };
  } catch (error) {
    if (error instanceof CreatorPlatformRequestError && error.category === "privacy") {
      return { ok: false, unavailableReason: "privacy_threshold" };
    }
    if (error instanceof CreatorPlatformRequestError && error.category === "permission") {
      return { ok: false, unavailableReason: "missing_permission" };
    }
    throw error;
  }
}

export async function fetchOk(
  provider: CreatorPlatformProvider,
  fetcher: typeof fetch,
  input: string | URL,
  init?: RequestInit,
): Promise<void> {
  const response = await fetcher(input, boundedRequestInit(init));
  if (!response.ok) throw await requestError(provider, response);
}

export function withAbortSignal(
  init: RequestInit | undefined,
  signal: AbortSignal | undefined,
): RequestInit | undefined {
  return signal ? { ...init, signal } : init;
}

function boundedRequestInit(init: RequestInit | undefined): RequestInit {
  const timeout = AbortSignal.timeout(CREATOR_PLATFORM_REQUEST_TIMEOUT_MS);
  return {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  };
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function requestError(
  provider: CreatorPlatformProvider,
  response: Response,
): Promise<CreatorPlatformRequestError> {
  const reason = await providerErrorReason(response);
  return new CreatorPlatformRequestError(
    provider,
    response.status,
    requestErrorCategory(provider, response.status, reason),
    reason,
  );
}

async function providerErrorReason(response: Response): Promise<string | undefined> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  const nested =
    root.error && typeof root.error === "object" && !Array.isArray(root.error)
      ? (root.error as Record<string, unknown>)
      : undefined;
  const googleErrors = nested?.errors;
  const firstGoogleError =
    Array.isArray(googleErrors) &&
    googleErrors[0] &&
    typeof googleErrors[0] === "object" &&
    !Array.isArray(googleErrors[0])
      ? (googleErrors[0] as Record<string, unknown>)
      : undefined;
  const candidate =
    firstGoogleError?.reason ??
    nested?.reason ??
    nested?.code ??
    nested?.error_subcode ??
    (typeof root.error === "string" ? root.error : undefined) ??
    root.error_code ??
    root.code;
  const value = typeof candidate === "number" ? String(candidate) : candidate;
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
}

function requestErrorCategory(
  provider: CreatorPlatformProvider,
  status: number,
  reason?: string,
): CreatorPlatformRequestErrorCategory {
  const normalized = reason?.toLowerCase();
  if (normalized && ["privacythreshold", "privacy_threshold"].includes(normalized)) {
    return "privacy";
  }
  if (
    normalized &&
    ["quotaexceeded", "dailylimitexceeded", "usageratelimitexceeded"].includes(normalized)
  ) {
    return "quota";
  }
  if (
    status === 429 ||
    (normalized &&
      ["ratelimitexceeded", "userratelimitexceeded", "too_many_requests"].includes(normalized))
  ) {
    return "rate_limit";
  }
  if (
    status === 401 ||
    (normalized &&
      [
        "102",
        "190",
        "458",
        "459",
        "460",
        "463",
        "464",
        "467",
        "autherror",
        "invalidcredentials",
        "invalid_grant",
        "invalid_token",
        "access_token_invalid",
        "token_expired",
      ].includes(normalized))
  ) {
    return "authorization";
  }
  if (
    normalized &&
    [
      "10",
      "200",
      "299",
      "insufficientpermissions",
      "insufficient_scope",
      "scope_not_authorized",
    ].includes(normalized)
  ) {
    return "permission";
  }
  if (status >= 500) return "transient";
  if (status === 403) return "permission";
  if (provider === "youtube" && normalized === "forbidden") return "permission";
  return "request";
}

export function record(
  provider: CreatorPlatformProvider,
  value: unknown,
  detail = "expected object",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CreatorPlatformResponseError(provider, detail);
  }
  return value as Record<string, unknown>;
}

export function array(
  provider: CreatorPlatformProvider,
  value: unknown,
  detail = "expected array",
): unknown[] {
  if (!Array.isArray(value)) throw new CreatorPlatformResponseError(provider, detail);
  return value;
}

export function string(provider: CreatorPlatformProvider, value: unknown, detail: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CreatorPlatformResponseError(provider, detail);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function identifier(
  provider: CreatorPlatformProvider,
  value: unknown,
  detail: string,
): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return string(provider, value, detail);
}

export function scopes(value: unknown, fallback: readonly string[] = []): string[] {
  if (typeof value === "string") return value.split(/[ ,]+/).filter(Boolean);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  return [...fallback];
}

export function number(provider: CreatorPlatformProvider, value: unknown, detail: string): number {
  const parsed = typeof value === "string" && value !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new CreatorPlatformResponseError(provider, detail);
  }
  return parsed;
}

export function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeGenderBucket(value: string): "male" | "female" | "other" {
  switch (value.trim().toLowerCase()) {
    case "m":
    case "male":
      return "male";
    case "f":
    case "female":
      return "female";
    default:
      return "other";
  }
}

export function expiresAt(now: () => Date, seconds: number): string {
  return new Date(now().getTime() + seconds * 1_000).toISOString();
}

export function available(value: number): CreatorPlatformMetric<number> {
  return { value };
}

export function unavailable<T>(
  unavailableReason: CreatorPlatformUnavailableReason,
): CreatorPlatformMetric<T> {
  return { value: null, unavailableReason };
}

export function assertProvider<P extends CreatorPlatformProvider>(
  grant: CreatorPlatformGrant,
  provider: P,
): asserts grant is Extract<CreatorPlatformGrant, { provider: P }> {
  if (grant.provider !== provider) throw new Error(`Expected a ${provider} grant`);
}

export function assertAccountProvider(
  provider: CreatorPlatformProvider,
  accountProvider: CreatorPlatformProvider,
): void {
  if (accountProvider !== provider) throw new Error(`Expected a ${provider} account`);
}

export function assertImportWindow(window: { startDate: string; endDate: string }): void {
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(window.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(window.endDate) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end - start !== 30 * 86_400_000
  ) {
    throw new Error("Creator platform imports require an exact 30-day UTC date window");
  }
}

export function normalizeMetaApiVersion(value = "v25.0"): string {
  const version = value.replace(/^v/i, "");
  if (!/^\d+\.\d+$/.test(version)) throw new Error("Invalid Meta Graph API version");
  return `v${version}`;
}
