export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthRouteContext = {
  params: Promise<{ path: string[] }>;
};

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "cookie",
  "origin",
  "user-agent",
  "x-correlation-id",
  "x-request-id",
  "x-vayada-csrf",
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "location",
  "retry-after",
  "www-authenticate",
  "x-correlation-id",
  "x-request-id",
] as const;

const MAX_AUTH_REQUEST_BODY_BYTES = 256 * 1024;
const AUTH_GATEWAY_UPSTREAM_TIMEOUT_MS = 10_000;

class AuthRequestBodyTooLargeError extends Error {}

async function proxyAuthRequest(request: Request, context: AuthRouteContext): Promise<Response> {
  let config: { upstreamOrigin: string; publicOrigin: string };
  try {
    config = readGatewayConfig();
  } catch {
    return jsonError(503, "auth_gateway_unavailable");
  }

  if (request.method !== "GET" && request.headers.get("origin") !== config.publicOrigin) {
    return jsonError(403, "origin_rejected");
  }

  const { path } = await context.params;
  if (!isSafeAuthPath(path)) {
    return jsonError(404, "auth_route_not_found");
  }

  const upstreamUrl = new URL(
    `/auth/${path.map(encodeURIComponent).join("/")}${new URL(request.url).search}`,
    config.upstreamOrigin,
  );
  const headers = forwardedRequestHeaders(request.headers, config.publicOrigin);
  let body: ArrayBuffer | undefined;
  try {
    body = request.method === "GET" ? undefined : await readAuthRequestBody(request);
  } catch (error) {
    return error instanceof AuthRequestBodyTooLargeError
      ? jsonError(413, "auth_request_too_large")
      : jsonError(400, "auth_request_invalid");
  }

  let upstreamResponse: Response;
  const upstreamTimeout = AbortSignal.timeout(AUTH_GATEWAY_UPSTREAM_TIMEOUT_MS);
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(body?.byteLength ? { body } : {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.any([request.signal, upstreamTimeout]),
    });
  } catch {
    if (upstreamTimeout.aborted && !request.signal.aborted) {
      return jsonError(504, "auth_gateway_upstream_timeout");
    }
    return jsonError(502, "auth_gateway_upstream_unavailable");
  }

  return new Response(responseCanHaveBody(upstreamResponse.status) ? upstreamResponse.body : null, {
    status: upstreamResponse.status,
    headers: forwardedResponseHeaders(upstreamResponse.headers),
  });
}

async function readAuthRequestBody(request: Request): Promise<ArrayBuffer | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(MAX_AUTH_REQUEST_BODY_BYTES)) {
      throw new AuthRequestBodyTooLargeError();
    }
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_AUTH_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AuthRequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  if (!totalBytes) return undefined;
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function readGatewayConfig(): { upstreamOrigin: string; publicOrigin: string } {
  return {
    upstreamOrigin: normalizeOrigin(
      process.env.AUTH_GATEWAY_UPSTREAM_ORIGIN,
      "AUTH_GATEWAY_UPSTREAM_ORIGIN",
    ),
    publicOrigin: normalizeOrigin(process.env.AUTH_PUBLIC_ORIGIN, "AUTH_PUBLIC_ORIGIN"),
  };
}

function normalizeOrigin(value: string | undefined, key: string): string {
  if (!value) throw new Error(`${key} is required`);
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${key} must be an absolute HTTP(S) origin`);
  }
  return url.origin;
}

function isSafeAuthPath(path: string[]): boolean {
  return path.length > 0 && path.every((segment) => segment && segment !== "." && segment !== "..");
}

function forwardedRequestHeaders(requestHeaders: Headers, publicOrigin: string): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  const publicUrl = new URL(publicOrigin);
  headers.set("x-forwarded-host", publicUrl.host);
  headers.set("x-forwarded-proto", publicUrl.protocol.slice(0, -1));
  return headers;
}

function forwardedResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const cookie of getSetCookieValues(upstreamHeaders)) {
    headers.append("set-cookie", cookie);
  }
  headers.set("cache-control", privateNoStore(upstreamHeaders.get("cache-control")));
  headers.set("vary", mergeVary(upstreamHeaders.get("vary"), "Cookie"));
  return headers;
}

function getSetCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) return getSetCookie.call(headers);
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function privateNoStore(value: string | null): string {
  const retained = (value ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive && !/^(?:public|private|no-store|max-age\s*=|s-maxage\s*=)/i.test(directive),
    );
  return [...retained, "private", "no-store"].join(", ");
}

function mergeVary(value: string | null, required: string): string {
  const values = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.includes("*")) return "*";
  if (!values.some((entry) => entry.toLowerCase() === required.toLowerCase())) {
    values.push(required);
  }
  return values.join(", ");
}

function responseCanHaveBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

function jsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        vary: "Cookie",
      },
    },
  );
}

export { proxyAuthRequest as GET, proxyAuthRequest as POST };
