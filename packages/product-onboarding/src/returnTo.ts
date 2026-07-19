export type ReturnToParam = string | string[] | null | undefined;

const SAME_ORIGIN_RETURN_TO_BASE = "https://vayada.local";

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
    return new URL(decoded, SAME_ORIGIN_RETURN_TO_BASE).origin === SAME_ORIGIN_RETURN_TO_BASE;
  } catch {
    return false;
  }
}

export function safeRelativeReturnTo(value: ReturnToParam, fallback: string): string {
  const raw = firstSearchParam(value);
  return isSafeRelativeReturnTo(raw) ? raw : fallback;
}

export function handoffReturnToForOrganization(
  returnTo: string,
  organization: {
    organizationId?: string;
    workosOrganizationId?: string;
  },
): string {
  if (!isSafeRelativeReturnTo(returnTo)) return returnTo;

  const url = new URL(returnTo, SAME_ORIGIN_RETURN_TO_BASE);
  if (url.pathname !== "/handoff") return returnTo;

  const hash = new URLSearchParams(url.hash.slice(1));
  const organizationId = organization.organizationId?.trim();
  const workosOrganizationId = organization.workosOrganizationId?.trim();
  if (organizationId) hash.set("organization_id", organizationId);
  if (workosOrganizationId) hash.set("workos_organization_id", workosOrganizationId);

  return `${url.pathname}${url.search}${hash.size > 0 ? `#${hash.toString()}` : ""}`;
}

export function organizationSelectionLoginPath(
  pathname: string,
  search: string,
  hash: string,
): string {
  const currentHash = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const safeHash = new URLSearchParams();
  for (const key of ["organization_id", "workos_organization_id", "property_id", "hotel_id"]) {
    const value = currentHash.get(key)?.trim();
    if (value) safeHash.set(key, value);
  }

  const returnTo = `${pathname}${search}${safeHash.size > 0 ? `#${safeHash.toString()}` : ""}`;
  return `/login?${new URLSearchParams({ auth: "callback", returnTo }).toString()}`;
}

export function missingOrganizationHandoffLoginPath(): string {
  return `/login?${new URLSearchParams({
    auth_error:
      "This handoff is missing hotel-group context. Return to the previous app and try again.",
  }).toString()}`;
}
