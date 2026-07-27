export type ReturnToParam = string | string[] | null | undefined;
export type HandoffError = {
  message: string;
  refreshPlan: boolean;
};

export type OpaqueHandoffLocation = {
  pathname: string;
  search: string;
  hash: string;
};

const SAME_ORIGIN_RETURN_TO_BASE = "https://vayada.local";
const OPAQUE_HANDOFF_CODE = /^[A-Za-z0-9_-]{43}$/;
const OPAQUE_HANDOFF_RETURN_TO = /^\/handoff\?code=([A-Za-z0-9_-]{43})$/;

export function firstSearchParam(value: ReturnToParam): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

export function isSafeRelativeReturnTo(value: string | null | undefined): value is string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return false;

  let decoded = value;
  try {
    for (let index = 0; index < 4; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return false;
  }

  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) {
    return false;
  }

  try {
    const rawUrl = new URL(value, SAME_ORIGIN_RETURN_TO_BASE);
    const decodedUrl = new URL(decoded, SAME_ORIGIN_RETURN_TO_BASE);
    if (
      rawUrl.origin !== SAME_ORIGIN_RETURN_TO_BASE ||
      decodedUrl.origin !== SAME_ORIGIN_RETURN_TO_BASE
    ) {
      return false;
    }

    if (
      rawUrl.pathname === "/handoff" ||
      rawUrl.pathname === "/handoff/" ||
      decodedUrl.pathname === "/handoff" ||
      decodedUrl.pathname === "/handoff/"
    ) {
      return OPAQUE_HANDOFF_RETURN_TO.test(value);
    }

    return true;
  } catch {
    return false;
  }
}

export function safeRelativeReturnTo(value: ReturnToParam, fallback: string): string {
  const raw = firstSearchParam(value);
  return isSafeRelativeReturnTo(raw) ? raw : fallback;
}

export function isOpaqueHandoffCode(value: string | null | undefined): value is string {
  return typeof value === "string" && OPAQUE_HANDOFF_CODE.test(value);
}

export function opaqueHandoffReturnTo(code: string | null | undefined): string | null {
  return isOpaqueHandoffCode(code) ? `/handoff?code=${code}` : null;
}

export function handoffLoginPath(code: string | null | undefined): string | null {
  const returnTo = opaqueHandoffReturnTo(code);
  return returnTo
    ? `/login?${new URLSearchParams({ auth: "callback", returnTo }).toString()}`
    : null;
}

export function resolveOpaqueHandoffLocation(
  location: OpaqueHandoffLocation,
): { code: string; loginPath: string } | null {
  const code = new URLSearchParams(location.search).get("code");
  const returnTo = opaqueHandoffReturnTo(code);
  const loginPath = handoffLoginPath(code);
  if (
    !isOpaqueHandoffCode(code) ||
    !returnTo ||
    !loginPath ||
    location.hash ||
    `${location.pathname}${location.search}` !== returnTo
  ) {
    return null;
  }
  return { code, loginPath };
}

export function canonicalSetupReturnUrl(
  value: string,
  propertyId: string,
  marketplaceOrigin: string,
): string | null {
  try {
    const url = new URL(value);
    const expectedOrigin = new URL(marketplaceOrigin).origin;
    if (
      url.origin !== expectedOrigin ||
      url.pathname !== "/setup" ||
      url.hash ||
      url.username ||
      url.password ||
      url.searchParams.getAll("propertyId").length !== 1 ||
      url.searchParams.get("propertyId") !== propertyId ||
      !Array.from(url.searchParams.keys()).every((key) => key === "propertyId")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function errorForHandoffFailure(error: unknown): HandoffError {
  const code = handoffErrorCode(error);
  return {
    refreshPlan: code === "refresh_plan",
    message:
      code === "refresh_plan"
        ? "Your setup plan changed. Refresh it to continue with the current next step."
        : code === "invalid_handoff"
          ? invalidHandoffError().message
          : error instanceof Error && error.message
            ? error.message
            : "We couldn't open this setup task.",
  };
}

export function invalidHandoffError(): HandoffError {
  return {
    refreshPlan: false,
    message: "This setup link is invalid, expired, or has already been used.",
  };
}

function handoffErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const directCode = "code" in error ? error.code : null;
  if (typeof directCode === "string") return directCode;
  const data = "data" in error ? error.data : null;
  if (!data || typeof data !== "object") return null;
  const nestedCode = "code" in data ? data.code : null;
  return typeof nestedCode === "string" ? nestedCode : null;
}
