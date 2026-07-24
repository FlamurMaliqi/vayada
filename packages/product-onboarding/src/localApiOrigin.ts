type BrowserLocation = Pick<Location, "hostname" | "port">;

const DEFAULT_LOCAL_API_ORIGIN = "https://api.localhost";

export function resolveLocalApiOrigin(
  configuredOrigin: string | undefined,
  location: BrowserLocation | undefined = typeof window === "undefined"
    ? undefined
    : window.location,
): string {
  const origin = configuredOrigin || DEFAULT_LOCAL_API_ORIGIN;
  if (!location?.port || !location.hostname.endsWith(".localhost")) return origin;

  try {
    const apiUrl = new URL(origin);
    if (apiUrl.port || !apiUrl.hostname.endsWith("api.localhost")) return origin;
    apiUrl.port = location.port;
    return apiUrl.origin;
  } catch {
    return origin;
  }
}
