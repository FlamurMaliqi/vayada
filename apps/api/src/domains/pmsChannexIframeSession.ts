import type { RequestContext } from "@vayada/backend-auth";
import pg from "pg";

type Pool = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

export type PmsChannexIframeSessionResult =
  | { ok: true; iframeUrl: string; expiresAt: string }
  | { ok: false; code: "connection_required" | "provider_rejected"; message: string };

export type PmsChannexIframeSessionPort = {
  createSession(
    context: RequestContext,
    propertyId: string,
  ): Promise<PmsChannexIframeSessionResult>;
  close?(): Promise<void>;
};

export function createPgPmsChannexIframeSessionPort(config: {
  connectionString: string;
  apiBaseUrl: string;
  apiKey: string;
  pool?: Pool;
  fetch?: typeof fetch;
  now?: () => Date;
}): PmsChannexIframeSessionPort {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 3 });
  const baseUrl = secureBaseUrl(config.apiBaseUrl);
  const apiKey = required(config.apiKey);
  const fetcher = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  return {
    async createSession(context, propertyId) {
      const connection = await pool.query<{ externalPropertyId: string | null }>(
        `SELECT external_property_id AS "externalPropertyId"
         FROM pms.channel_connections
         WHERE property_id = $1::uuid AND provider = 'channex'
           AND connection_status IN ('connected', 'degraded')`,
        [propertyId],
      );
      const externalPropertyId = connection.rows[0]?.externalPropertyId;
      if (!externalPropertyId) {
        return { ok: false, code: "connection_required", message: "Enable Channex first." };
      }
      let response: Response;
      try {
        response = await fetcher(new URL("/api/v1/auth/one_time_token", baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", "user-api-key": apiKey },
          body: JSON.stringify({
            one_time_token: {
              property_id: externalPropertyId,
              username: `pms_${context.actor.internalUserId}`,
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        return { ok: false, code: "provider_rejected", message: safeMessage(error) };
      }
      if (!response.ok) {
        return {
          ok: false,
          code: "provider_rejected",
          message: `Channex iframe session failed with HTTP ${response.status}`,
        };
      }
      const body = (await response.json()) as { data?: { token?: unknown } };
      const token = body.data?.token;
      if (typeof token !== "string" || !token) {
        return {
          ok: false,
          code: "provider_rejected",
          message: "Channex iframe session omitted its token.",
        };
      }
      const createdAt = now();
      await pool.query(
        `INSERT INTO platform.product_audit_events (
           audit_key, product, action, occurred_at, tenant_scope, property_id,
           actor_type, actor_user_id, target_resource_product, target_resource_type,
           target_resource_id, correlation_id, redacted_payload, audit_metadata
         ) VALUES ($1, 'pms', 'pms.channex.iframe_session.created', $2::timestamptz,
           'property', $3::uuid, 'user', $4::uuid, 'pms', 'channex_connection', $3,
           $5, '{}'::jsonb, jsonb_build_object('expiresInSeconds', 900))`,
        [
          `channex.iframe-session:${context.audit.requestId}`,
          createdAt.toISOString(),
          propertyId,
          context.actor.internalUserId,
          context.audit.correlationId ?? context.audit.requestId,
        ],
      );
      return {
        ok: true,
        iframeUrl: iframeUrl(baseUrl, token, externalPropertyId, context.locale),
        expiresAt: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function iframeUrl(baseUrl: string, token: string, propertyId: string, locale: string): string {
  const url = new URL("/auth/exchange", baseUrl);
  url.searchParams.set("oauth_session_key", token);
  url.searchParams.set("app_mode", "headless");
  url.searchParams.set("redirect_to", "/channels");
  url.searchParams.set("property_id", propertyId);
  url.searchParams.set("lng", locale || "en");
  return url.toString();
}

function secureBaseUrl(value: string): string {
  const url = new URL(required(value));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    throw new Error("Channex apiBaseUrl must use HTTPS");
  }
  return url.toString();
}

function safeMessage(error: unknown) {
  return (error instanceof Error ? error.message : "Channex iframe session failed").slice(0, 500);
}

function required(value: string) {
  if (!value.trim()) throw new Error("Channex iframe configuration must not be empty");
  return value;
}
