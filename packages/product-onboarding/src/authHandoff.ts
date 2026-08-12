import { isSafeRelativeReturnTo } from "./returnTo";

export type BrowserAuthSurface =
  | "platform-admin"
  | "booking-admin"
  | "pms-web"
  | "affiliate-dashboard"
  | "marketplace-web";

export type BrowserAuthHandoffRoutingHints = {
  hotelId?: string;
  organizationId?: string;
  propertyId?: string;
  workosOrganizationId?: string;
};

export type RedeemedBrowserAuthHandoff = {
  routingHints: BrowserAuthHandoffRoutingHints;
  targetPath: string;
};

export class BrowserAuthHandoffError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BrowserAuthHandoffError";
  }
}

export async function createBrowserAuthHandoff(input: {
  csrfToken: string;
  routingHints?: BrowserAuthHandoffRoutingHints;
  sourceSurface: BrowserAuthSurface;
  targetPath: string;
  targetSurface: BrowserAuthSurface;
  fetcher?: typeof fetch;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher("/auth/handoff/create", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-vayada-csrf": input.csrfToken,
      },
      body: JSON.stringify({
        routingHints: input.routingHints ?? {},
        sourceSurface: input.sourceSurface,
        targetPath: input.targetPath,
        targetSurface: input.targetSurface,
      }),
    });
  } catch {
    throw retryableHandoffError();
  }
  if (!response.ok) throw await handoffError(response);

  const payload = (await parseSuccessfulHandoffResponse(response)) as { destination?: unknown };
  if (typeof payload.destination !== "string" || !isValidHandoffDestination(payload.destination)) {
    throw new BrowserAuthHandoffError("Authentication handoff returned an invalid target.", false);
  }
  return payload.destination;
}

export async function redeemBrowserAuthHandoff(input: {
  code: string;
  targetSurface: BrowserAuthSurface;
  fetcher?: typeof fetch;
}): Promise<RedeemedBrowserAuthHandoff> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.code)) {
    throw new BrowserAuthHandoffError("Authentication handoff code is invalid.", false);
  }
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher("/auth/handoff/redeem", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: input.code, targetSurface: input.targetSurface }),
    });
  } catch {
    throw retryableHandoffError();
  }
  if (!response.ok) throw await handoffError(response);

  const payload = (await parseSuccessfulHandoffResponse(response)) as {
    routingHints?: unknown;
    targetPath?: unknown;
  };
  if (
    typeof payload.targetPath !== "string" ||
    !isSafeRelativeReturnTo(payload.targetPath) ||
    !isRoutingHints(payload.routingHints)
  ) {
    throw new BrowserAuthHandoffError("Authentication handoff response is invalid.", false);
  }
  return { routingHints: payload.routingHints, targetPath: payload.targetPath };
}

export function crossAppReauthenticationUrl(baseUrl: string, returnTo: string): string {
  let url: URL;
  try {
    url = new URL("/login", baseUrl);
  } catch {
    throw invalidReauthenticationTargetError();
  }
  if (!isSafeRelativeReturnTo(returnTo) || !["http:", "https:"].includes(url.protocol)) {
    throw invalidReauthenticationTargetError();
  }
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

async function parseSuccessfulHandoffResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw retryableHandoffError();
  }
}

function invalidReauthenticationTargetError(): BrowserAuthHandoffError {
  return new BrowserAuthHandoffError("Cross-app reauthentication target is invalid.", false);
}

function isValidHandoffDestination(value: string): boolean {
  try {
    const url = new URL(value);
    const code = new URLSearchParams(url.hash.slice(1)).get("code");
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/handoff" &&
      !url.search &&
      Boolean(code && /^[A-Za-z0-9_-]{32,128}$/.test(code))
    );
  } catch {
    return false;
  }
}

function isRoutingHints(value: unknown): value is BrowserAuthHandoffRoutingHints {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.entries(input).every(
    ([key, candidate]) =>
      ["hotelId", "organizationId", "propertyId", "workosOrganizationId"].includes(key) &&
      typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= 256,
  );
}

async function handoffError(response: Response): Promise<BrowserAuthHandoffError> {
  let error: unknown;
  try {
    error = ((await response.json()) as { error?: unknown }).error;
  } catch {
    // A safe generic error is enough when the gateway returns a non-JSON failure.
  }
  const retryable =
    error === "handoff_retryable" || response.status === 429 || response.status >= 500;
  return retryable
    ? retryableHandoffError()
    : new BrowserAuthHandoffError("Authentication handoff expired or is no longer valid.", false);
}

function retryableHandoffError(): BrowserAuthHandoffError {
  return new BrowserAuthHandoffError(
    "Authentication handoff is temporarily unavailable. Please try again.",
    true,
  );
}
