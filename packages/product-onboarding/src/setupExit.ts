const PMS_SETUP_EXIT_STATUS = "incomplete";
const PMS_SETUP_EXIT_ORIGIN = "https://pms.vayada.com";

export function pmsSetupExitPath(propertyId?: string | null): string {
  const selectedPropertyId = propertyId?.trim();
  if (!selectedPropertyId) return `/choose-property?setup=${PMS_SETUP_EXIT_STATUS}`;

  const query = new URLSearchParams({
    setup: PMS_SETUP_EXIT_STATUS,
    propertyId: selectedPropertyId,
  });
  return `/dashboard?${query.toString()}`;
}

export function isPmsSetupExitPath(path: string): boolean {
  try {
    const url = new URL(path, PMS_SETUP_EXIT_ORIGIN);
    if (url.origin !== PMS_SETUP_EXIT_ORIGIN) return false;
    if (url.searchParams.get("setup") !== PMS_SETUP_EXIT_STATUS) return false;
    if (url.pathname === "/choose-property") return true;
    return url.pathname === "/dashboard" && Boolean(pmsSetupExitPropertyId(path));
  } catch {
    return false;
  }
}

export function pmsSetupExitPropertyId(path: string): string | null {
  try {
    const url = new URL(path, PMS_SETUP_EXIT_ORIGIN);
    if (url.origin !== PMS_SETUP_EXIT_ORIGIN) return null;
    if (url.pathname !== "/dashboard" || url.searchParams.get("setup") !== PMS_SETUP_EXIT_STATUS) {
      return null;
    }
    return url.searchParams.get("propertyId")?.trim() || null;
  } catch {
    return null;
  }
}
