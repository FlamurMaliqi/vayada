type RequestHeaders = Pick<Headers, "get">;

/**
 * Return the browser-facing host. Reverse proxies may append internal hosts to
 * x-forwarded-host, so the first value is the original request host.
 */
export function getRequestHost(headers: RequestHeaders): string {
  const forwardedHost = headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  return forwardedHost || headers.get("host")?.trim() || "";
}
