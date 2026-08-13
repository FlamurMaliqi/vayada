/**
 * One ApiClient class, instantiated once per backend:
 *   - bookingWebPublic: TypeScript public Booking Web API
 *   - bookingEngine:   booking API for remaining non-BFF reads
 */

class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export type ApiRequestInit = RequestInit & {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
};

class ApiClient {
  constructor(private baseUrl: string) {}

  get baseURL(): string {
    return this.baseUrl;
  }

  async get<T>(path: string, init?: ApiRequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    return parse<T>(res);
  }

  async post<T>(path: string, body?: unknown, init?: ApiRequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method: "POST",
      headers: { "Content-Type": "application/json", ...init?.headers },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return parse<T>(res);
  }
}

// Pull a human-readable string out of an error body. FastAPI returns
// `{detail: "..."}` for raised HTTPExceptions but `{detail: [{loc,msg,...}]}`
// for request-validation (422) errors — the list shape is why the old code
// fell back to a raw "API error: POST 422".
function messageFromDetail(detail: unknown): string | null {
  if (!detail || typeof detail !== "object" || !("detail" in detail)) return null;
  const d = (detail as { detail: unknown }).detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    const msgs = d
      .map((e) =>
        e && typeof e === "object" && "msg" in e ? String((e as { msg: unknown }).msg) : "",
      )
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  return null;
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {}
    // Never surface a raw "API error: POST 422" to the user. Callers that
    // render errors (e.g. the checkout payment step) classify on
    // err.status / err.detail and map to friendly localized copy; this
    // message is only the last-resort copy.
    const message = messageFromDetail(detail) || "Something went wrong. Please try again.";
    throw new ApiError(message, res.status, detail);
  }
  return res.json();
}

// Browser requests stay same-origin and are proxied by Next.js. This keeps
// verified hotel custom domains functional without trusting arbitrary origins
// in the public API's CORS policy.
export const bookingWebPublic = new ApiClient("");
export const bookingEngine = new ApiClient("");
export { ApiError };
