import { randomBytes, randomUUID } from "node:crypto";
import { requireAuthContext, type RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export const COOKIE_CONSENT_UPSERT_CONTRACT = {
  method: "POST",
  path: "/api/identity/consent/cookies",
  owner: "identity",
  public: true,
} as const;

export const COOKIE_CONSENT_READ_CONTRACT = {
  method: "GET",
  path: "/api/identity/consent/cookies",
  owner: "identity",
  public: true,
} as const;

export const USER_CONSENT_STATUS_CONTRACT = {
  method: "GET",
  path: "/api/identity/consent/me",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const USER_MARKETING_CONSENT_UPDATE_CONTRACT = {
  method: "PUT",
  path: "/api/identity/consent/me",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const USER_CONSENT_HISTORY_CONTRACT = {
  method: "GET",
  path: "/api/identity/consent/history",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const GDPR_EXPORT_REQUEST_CONTRACT = {
  method: "POST",
  path: "/api/identity/gdpr/export-request",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const GDPR_EXPORT_STATUS_CONTRACT = {
  method: "GET",
  path: "/api/identity/gdpr/export-status",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const GDPR_EXPORT_DOWNLOAD_CONTRACT = {
  method: "GET",
  path: "/api/identity/gdpr/export-download",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const GDPR_DELETION_REQUEST_CONTRACT = {
  method: "POST",
  path: "/api/identity/gdpr/delete-request",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const GDPR_DELETION_CANCEL_CONTRACT = {
  method: "POST",
  path: "/api/identity/gdpr/delete-cancel",
  owner: "identity",
  auth: "RequestContext",
} as const;

export const GDPR_DELETION_STATUS_CONTRACT = {
  method: "GET",
  path: "/api/identity/gdpr/delete-status",
  owner: "identity",
  auth: "RequestContext",
} as const;

export type CookieConsentRequest = {
  visitor_id: string;
  necessary?: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
};

export type CookieConsentResponse = {
  id: string;
  visitor_id: string;
  user_id: string | null;
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
  created_at: string;
  updated_at: string;
};

export type ConsentStatusResponse = {
  terms_accepted: boolean;
  terms_accepted_at: string | null;
  terms_version: string | null;
  privacy_accepted: boolean;
  privacy_accepted_at: string | null;
  privacy_version: string | null;
  marketing_consent: boolean;
  marketing_consent_at: string | null;
};

export type UpdateMarketingConsentRequest = {
  marketing_consent: boolean;
};

export type UpdateMarketingConsentResponse = {
  marketing_consent: boolean;
  marketing_consent_at: string;
  message: string;
};

export type ConsentHistoryItem = {
  id: string;
  consent_type: string;
  consent_given: boolean;
  version: string | null;
  created_at: string;
};

export type ConsentHistoryResponse = {
  history: ConsentHistoryItem[];
  total: number;
};

export type GdprRequestStatus = "pending" | "processing" | "completed" | "cancelled" | "expired";

export type GdprRequestStatusResponse = {
  id: string;
  request_type: "export" | "deletion";
  status: GdprRequestStatus;
  requested_at: string;
  processed_at: string | null;
  expires_at: string | null;
  download_token?: string | null;
};

export type GdprExportRequestResponse = {
  id: string;
  status: GdprRequestStatus;
  requested_at: string;
  expires_at: string | null;
  download_token: string | null;
  message: string;
};

export type GdprDeletionRequestResponse = {
  id: string;
  status: GdprRequestStatus;
  requested_at: string;
  scheduled_deletion_at: string;
  message: string;
};

export type GdprDeletionCancelResponse = {
  message: string;
  cancelled: boolean;
};

export type IdentityPrivacyRepository = {
  upsertCookieConsent(input: {
    visitorId: string;
    functional: boolean;
    analytics: boolean;
    marketing: boolean;
  }): Promise<CookieConsentResponse>;
  findCookieConsent(visitorId: string): Promise<CookieConsentResponse | null>;
  getConsentStatus(userId: string): Promise<ConsentStatusResponse | null>;
  updateMarketingConsent(input: {
    userId: string;
    marketingConsent: boolean;
    ipAddress: string;
    userAgent: string;
  }): Promise<UpdateMarketingConsentResponse | null>;
  listConsentHistory(input: {
    userId: string;
    limit: number;
    offset: number;
  }): Promise<ConsentHistoryResponse>;
  createGdprExportRequest(input: {
    userId: string;
    ipAddress: string;
    expiresAt: string;
    downloadToken: string;
  }): Promise<GdprExportRequestResponse>;
  findLatestGdprRequest(
    userId: string,
    requestType: "export" | "deletion",
  ): Promise<GdprRequestStatusResponse | null>;
  findGdprExportByToken(input: {
    userId: string;
    token: string;
  }): Promise<GdprRequestStatusResponse | null>;
  collectExportData(userId: string): Promise<Record<string, unknown>>;
  createGdprDeletionRequest(input: {
    userId: string;
    ipAddress: string;
    scheduledDeletionAt: string;
  }): Promise<GdprDeletionRequestResponse>;
  cancelGdprDeletionRequest(input: {
    userId: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<boolean>;
  close?(): Promise<void>;
};

export type IdentityPrivacyPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  connect(): Promise<Pick<IdentityPrivacyPool, "query"> & { release(): void }>;
  end(): Promise<void>;
};

export function createPgIdentityPrivacyRepository(config: {
  connectionString: string;
  max?: number;
  pool?: IdentityPrivacyPool;
}): IdentityPrivacyRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Identity privacy repository connectionString must not be empty");
  }

  const pool: IdentityPrivacyPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async upsertCookieConsent(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize creation as well as updates; a row lock alone cannot lock a missing row.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `identity.cookie-consent:${input.visitorId}`,
        ]);
        const current = await client.query<CookieConsentRow>(
          "SELECT * FROM identity.cookie_consents WHERE visitor_id = $1",
          [input.visitorId],
        );
        const previous = current.rows[0];
        if (
          previous &&
          previous.necessary === true &&
          previous.functional === input.functional &&
          previous.analytics === input.analytics &&
          previous.marketing === input.marketing
        ) {
          await client.query("COMMIT");
          return serializeCookieConsent(previous);
        }
        const result = await client.query<CookieConsentRow>(
          `INSERT INTO identity.cookie_consents
             (visitor_id, necessary, functional, analytics, marketing)
           VALUES ($1, TRUE, $2, $3, $4)
           ON CONFLICT (visitor_id) DO UPDATE SET
             necessary = TRUE, functional = EXCLUDED.functional,
             analytics = EXCLUDED.analytics, marketing = EXCLUDED.marketing,
             updated_at = clock_timestamp()
           RETURNING *`,
          [input.visitorId, input.functional, input.analytics, input.marketing],
        );
        await recordConsent(client, {
          visitorId: input.visitorId,
          consentType: "cookies",
          // This is a choice event, not a blanket grant of the optional purposes.
          consentGiven: input.functional || input.analytics || input.marketing,
          version: "1",
          metadata: {
            functional: input.functional,
            analytics: input.analytics,
            marketing: input.marketing,
          },
        });
        await client.query("COMMIT");
        return serializeCookieConsent(result.rows[0]!);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async findCookieConsent(visitorId) {
      const result = await pool.query<CookieConsentRow>(
        `SELECT id, visitor_id, user_id, necessary, functional, analytics, marketing, created_at, updated_at
         FROM identity.cookie_consents
         WHERE visitor_id = $1`,
        [visitorId],
      );
      return result.rows[0] ? serializeCookieConsent(result.rows[0]) : null;
    },
    async getConsentStatus(userId) {
      const result = await pool.query<ConsentStatusRow>(
        `SELECT terms_accepted_at, terms_version, privacy_accepted_at, privacy_version,
                marketing_consent, marketing_consent_at
         FROM identity.user_consent_status
         WHERE user_id = $1`,
        [userId],
      );
      return result.rows[0] ? serializeConsentStatus(result.rows[0]) : null;
    },
    async updateMarketingConsent(input) {
      const result = await pool.query<MarketingConsentRow>(
        `INSERT INTO identity.user_consent_status
           (user_id, marketing_consent, marketing_consent_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id)
         DO UPDATE SET
           marketing_consent = EXCLUDED.marketing_consent,
           marketing_consent_at = now(),
           updated_at = now()
         RETURNING marketing_consent, marketing_consent_at`,
        [input.userId, input.marketingConsent],
      );
      await recordConsent(pool, {
        userId: input.userId,
        consentType: "marketing",
        consentGiven: input.marketingConsent,
        metadata: {
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
      });
      const row = result.rows[0];
      if (!row) return null;
      const action = row.marketing_consent ? "given" : "withdrawn";
      return {
        marketing_consent: row.marketing_consent,
        marketing_consent_at: toIso(row.marketing_consent_at),
        message: `Marketing consent ${action} successfully`,
      };
    },
    async listConsentHistory(input) {
      const [history, count] = await Promise.all([
        pool.query<ConsentHistoryRow>(
          `SELECT id, consent_type, consent_given, version, created_at
           FROM identity.consent_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [input.userId, input.limit, input.offset],
        ),
        pool.query<{ total: string }>(
          `SELECT count(*)::text AS total
           FROM identity.consent_history
           WHERE user_id = $1`,
          [input.userId],
        ),
      ]);
      return {
        history: history.rows.map(serializeConsentHistoryItem),
        total: Number(count.rows[0]?.total ?? 0),
      };
    },
    async createGdprExportRequest(input) {
      const result = await pool.query<GdprRequestRow>(
        `INSERT INTO identity.gdpr_requests
           (user_id, request_type, status, download_token, requested_at, processed_at, expires_at, ip_address)
         VALUES ($1, 'export', 'completed', $2, now(), now(), $3, $4)
         RETURNING id, request_type, status, requested_at, processed_at, expires_at, download_token`,
        [input.userId, input.downloadToken, input.expiresAt, input.ipAddress],
      );
      const row = result.rows[0]!;
      return {
        id: row.id,
        status: row.status,
        requested_at: toIso(row.requested_at),
        expires_at: row.expires_at ? toIso(row.expires_at) : null,
        download_token: row.download_token ?? null,
        message: "Your data export is ready for download.",
      };
    },
    async findLatestGdprRequest(userId, requestType) {
      const result = await pool.query<GdprRequestRow>(
        `SELECT id, request_type, status, requested_at, processed_at, expires_at, download_token
         FROM identity.gdpr_requests
         WHERE user_id = $1 AND request_type = $2
         ORDER BY requested_at DESC
         LIMIT 1`,
        [userId, requestType],
      );
      return result.rows[0] ? serializeGdprRequest(result.rows[0]) : null;
    },
    async findGdprExportByToken(input) {
      const result = await pool.query<GdprRequestRow>(
        `SELECT id, request_type, status, requested_at, processed_at, expires_at, download_token
         FROM identity.gdpr_requests
         WHERE user_id = $1
           AND request_type = 'export'
           AND download_token = $2
         ORDER BY requested_at DESC
         LIMIT 1`,
        [input.userId, input.token],
      );
      return result.rows[0] ? serializeGdprRequest(result.rows[0]) : null;
    },
    async collectExportData(userId) {
      const [user, consent, history, cookies] = await Promise.all([
        pool.query(
          `SELECT id, email, name, status, created_at, updated_at
           FROM identity.users
           WHERE id = $1`,
          [userId],
        ),
        pool.query(
          `SELECT terms_accepted_at, terms_version, privacy_accepted_at, privacy_version,
                  marketing_consent, marketing_consent_at
           FROM identity.user_consent_status
           WHERE user_id = $1`,
          [userId],
        ),
        pool.query(
          `SELECT id, consent_type, consent_given, version, created_at
           FROM identity.consent_history
           WHERE user_id = $1
           ORDER BY created_at DESC`,
          [userId],
        ),
        pool.query(
          `SELECT id, visitor_id, necessary, functional, analytics, marketing, created_at, updated_at
           FROM identity.cookie_consents
           WHERE user_id = $1
           ORDER BY updated_at DESC`,
          [userId],
        ),
      ]);
      return {
        export_date: new Date().toISOString(),
        user: user.rows[0] ?? null,
        consent_status: consent.rows[0] ?? null,
        consent_history: history.rows,
        cookie_consent: cookies.rows,
      };
    },
    async createGdprDeletionRequest(input) {
      const existing = await this.findLatestGdprRequest(input.userId, "deletion");
      if (existing?.status === "pending") {
        return {
          id: existing.id,
          status: existing.status,
          requested_at: existing.requested_at,
          scheduled_deletion_at: existing.expires_at ?? input.scheduledDeletionAt,
          message: "You already have a pending deletion request.",
        };
      }
      const result = await pool.query<GdprRequestRow>(
        `INSERT INTO identity.gdpr_requests
           (user_id, request_type, status, expires_at, ip_address)
         VALUES ($1, 'deletion', 'pending', $2, $3)
         RETURNING id, request_type, status, requested_at, processed_at, expires_at`,
        [input.userId, input.scheduledDeletionAt, input.ipAddress],
      );
      await recordConsent(pool, {
        userId: input.userId,
        consentType: "deletion_request",
        consentGiven: true,
        metadata: { ipAddress: input.ipAddress },
      });
      const row = result.rows[0]!;
      const scheduledDeletionAt = row.expires_at ?? input.scheduledDeletionAt;
      return {
        id: row.id,
        status: row.status,
        requested_at: toIso(row.requested_at),
        scheduled_deletion_at: toIso(scheduledDeletionAt),
        message: `Your account deletion request has been received. Your account will be deleted on ${toIso(scheduledDeletionAt).slice(0, 10)}. You can cancel this request before then.`,
      };
    },
    async cancelGdprDeletionRequest(input) {
      const result = await pool.query<{ id: string }>(
        `UPDATE identity.gdpr_requests
         SET status = 'cancelled', processed_at = now(), updated_at = now()
         WHERE id = (
           SELECT id
           FROM identity.gdpr_requests
           WHERE user_id = $1 AND request_type = 'deletion' AND status = 'pending'
           ORDER BY requested_at DESC
           LIMIT 1
         )
         RETURNING id`,
        [input.userId],
      );
      if (!result.rows[0]) return false;
      await recordConsent(pool, {
        userId: input.userId,
        consentType: "deletion_cancelled",
        consentGiven: false,
        metadata: {
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
      });
      return true;
    },
    async close() {
      await pool.end();
    },
  };
}

export type IdentityPrivacyRoutesOptions = {
  repository: IdentityPrivacyRepository;
  allowedOrigins?: string[];
  now?: () => Date;
};

type CookieConsentQuery = {
  visitor_id?: string | string[];
};

type HistoryQuery = {
  limit?: string | string[];
  offset?: string | string[];
};

type ExportDownloadQuery = {
  token?: string | string[];
};

export async function registerIdentityPrivacyRoutes(
  app: FastifyInstance,
  options: IdentityPrivacyRoutesOptions,
): Promise<void> {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const now = options.now ?? (() => new Date());

  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    }
  });

  app.options("/*", async (_request, reply) => reply.status(204).send());

  app.post<{ Body: CookieConsentRequest }>("/consent/cookies", async (request, reply) => {
    const body = request.body;
    if (
      !validVisitorId(body?.visitor_id) ||
      [body.functional, body.analytics, body.marketing].some(
        (value) => typeof value !== "boolean",
      ) ||
      (body.necessary !== undefined && body.necessary !== true)
    ) {
      return sendPrivacyError(
        reply,
        422,
        "invalid_payload",
        "A valid visitor_id and boolean cookie choices are required.",
      );
    }
    return options.repository.upsertCookieConsent({
      visitorId: body.visitor_id,
      functional: body.functional,
      analytics: body.analytics,
      marketing: body.marketing,
    });
  });

  app.get<{ Querystring: CookieConsentQuery }>("/consent/cookies", async (request, reply) => {
    const visitorId = firstQueryValue(request.query.visitor_id);
    if (!validVisitorId(visitorId)) {
      return sendPrivacyError(reply, 422, "invalid_query", "A valid visitor_id is required.");
    }
    return options.repository.findCookieConsent(visitorId);
  });

  app.get("/consent/me", async (request, reply) => {
    const context = requireAuthContext(request);
    const status = await options.repository.getConsentStatus(context.actor.internalUserId);
    return status ?? defaultConsentStatus();
  });

  app.put<{ Body: UpdateMarketingConsentRequest }>("/consent/me", async (request, reply) => {
    const context = requireAuthContext(request);
    if (typeof request.body?.marketing_consent !== "boolean") {
      return sendPrivacyError(reply, 422, "invalid_payload", "marketing_consent is required.");
    }
    const response = await options.repository.updateMarketingConsent({
      userId: context.actor.internalUserId,
      marketingConsent: request.body.marketing_consent,
      ipAddress: clientIp(request),
      userAgent: request.headers["user-agent"] ?? "unknown",
    });
    if (!response) {
      return sendPrivacyError(reply, 404, "not_found", "User was not found.");
    }
    return response;
  });

  app.get<{ Querystring: HistoryQuery }>("/consent/history", async (request) => {
    const context = requireAuthContext(request);
    const page = parsePage(request.query);
    return options.repository.listConsentHistory({
      userId: context.actor.internalUserId,
      ...page,
    });
  });

  app.post("/gdpr/export-request", async (request, reply) => {
    const context = requireAuthContext(request);
    const expiresAt = addDays(now(), 7).toISOString();
    const response = await options.repository.createGdprExportRequest({
      userId: context.actor.internalUserId,
      ipAddress: clientIp(request),
      expiresAt,
      downloadToken: randomBytes(32).toString("base64url"),
    });
    return reply.status(201).send(response);
  });

  app.get("/gdpr/export-status", async (request, reply) => {
    return latestRequestOr404(request, reply, options.repository, "export");
  });

  app.get<{ Querystring: ExportDownloadQuery }>("/gdpr/export-download", async (request, reply) => {
    const context = requireAuthContext(request);
    const token = firstQueryValue(request.query.token);
    if (!token) {
      return sendPrivacyError(reply, 422, "invalid_query", "token is required.");
    }
    const latest = await options.repository.findGdprExportByToken({
      userId: context.actor.internalUserId,
      token,
    });
    if (!latest) {
      return sendPrivacyError(reply, 404, "not_found", "No export request found.");
    }
    if (latest.status !== "completed") {
      return sendPrivacyError(reply, 202, "not_ready", "Your export is still being processed.");
    }
    const data = await options.repository.collectExportData(context.actor.internalUserId);
    reply.header(
      "Content-Disposition",
      `attachment; filename=vayada-data-export-${context.actor.internalUserId}.json`,
    );
    return data;
  });

  app.post("/gdpr/delete-request", async (request, reply) => {
    const context = requireAuthContext(request);
    const scheduledDeletionAt = addDays(now(), 30).toISOString();
    const response = await options.repository.createGdprDeletionRequest({
      userId: context.actor.internalUserId,
      ipAddress: clientIp(request),
      scheduledDeletionAt,
    });
    return reply.status(201).send(response);
  });

  app.post("/gdpr/delete-cancel", async (request, reply) => {
    const context = requireAuthContext(request);
    const cancelled = await options.repository.cancelGdprDeletionRequest({
      userId: context.actor.internalUserId,
      ipAddress: clientIp(request),
      userAgent: request.headers["user-agent"] ?? "unknown",
    });
    if (!cancelled) {
      return sendPrivacyError(reply, 404, "not_found", "No pending deletion request found.");
    }
    return {
      message: "Your account deletion request has been cancelled. Your account will remain active.",
      cancelled: true,
    };
  });

  app.get("/gdpr/delete-status", async (request, reply) => {
    return latestRequestOr404(request, reply, options.repository, "deletion");
  });
}

async function latestRequestOr404(
  request: Parameters<typeof requireAuthContext>[0],
  reply: FastifyReply,
  repository: IdentityPrivacyRepository,
  requestType: "export" | "deletion",
) {
  const context: RequestContext = requireAuthContext(request);
  const result = await repository.findLatestGdprRequest(context.actor.internalUserId, requestType);
  if (!result) {
    return sendPrivacyError(reply, 404, "not_found", `No ${requestType} request found.`);
  }
  return result;
}

type CookieConsentRow = {
  id: string;
  visitor_id: string;
  user_id: string | null;
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

type ConsentStatusRow = {
  terms_accepted_at: Date | string | null;
  terms_version: string | null;
  privacy_accepted_at: Date | string | null;
  privacy_version: string | null;
  marketing_consent: boolean;
  marketing_consent_at: Date | string | null;
};

type MarketingConsentRow = {
  marketing_consent: boolean;
  marketing_consent_at: Date | string;
};

type ConsentHistoryRow = {
  id: string;
  consent_type: string;
  consent_given: boolean;
  version: string | null;
  created_at: Date | string;
};

type GdprRequestRow = {
  id: string;
  request_type: "export" | "deletion";
  status: GdprRequestStatus;
  requested_at: Date | string;
  processed_at: Date | string | null;
  expires_at: Date | string | null;
  download_token?: string | null;
};

function serializeCookieConsent(row: CookieConsentRow): CookieConsentResponse {
  return {
    id: row.id,
    visitor_id: row.visitor_id,
    user_id: null,
    necessary: row.necessary,
    functional: row.functional,
    analytics: row.analytics,
    marketing: row.marketing,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function serializeConsentStatus(row: ConsentStatusRow): ConsentStatusResponse {
  return {
    terms_accepted: row.terms_accepted_at !== null,
    terms_accepted_at: row.terms_accepted_at ? toIso(row.terms_accepted_at) : null,
    terms_version: row.terms_version,
    privacy_accepted: row.privacy_accepted_at !== null,
    privacy_accepted_at: row.privacy_accepted_at ? toIso(row.privacy_accepted_at) : null,
    privacy_version: row.privacy_version,
    marketing_consent: row.marketing_consent,
    marketing_consent_at: row.marketing_consent_at ? toIso(row.marketing_consent_at) : null,
  };
}

function defaultConsentStatus(): ConsentStatusResponse {
  return {
    terms_accepted: false,
    terms_accepted_at: null,
    terms_version: null,
    privacy_accepted: false,
    privacy_accepted_at: null,
    privacy_version: null,
    marketing_consent: false,
    marketing_consent_at: null,
  };
}

function serializeConsentHistoryItem(row: ConsentHistoryRow): ConsentHistoryItem {
  return {
    id: row.id,
    consent_type: row.consent_type,
    consent_given: row.consent_given,
    version: row.version,
    created_at: toIso(row.created_at),
  };
}

function serializeGdprRequest(row: GdprRequestRow): GdprRequestStatusResponse {
  return {
    id: row.id,
    request_type: row.request_type,
    status: row.status,
    requested_at: toIso(row.requested_at),
    processed_at: row.processed_at ? toIso(row.processed_at) : null,
    expires_at: row.expires_at ? toIso(row.expires_at) : null,
    download_token: row.status === "completed" ? (row.download_token ?? null) : null,
  };
}

async function recordConsent(
  pool: Pick<IdentityPrivacyPool, "query">,
  input: {
    userId?: string;
    visitorId?: string;
    consentType: string;
    consentGiven: boolean;
    version?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await pool.query(
    `INSERT INTO identity.consent_history
       (user_id, visitor_id, consent_type, consent_given, version, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
    [
      input.userId ?? null,
      input.visitorId ?? null,
      input.consentType,
      input.consentGiven,
      input.version ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

function validVisitorId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function sendPrivacyError(
  reply: FastifyReply,
  statusCode: 202 | 404 | 422,
  code: string,
  message: string,
) {
  return reply.status(statusCode).send({
    statusCode,
    code,
    category: statusCode === 422 ? "validation" : "privacy",
    message,
  });
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePage(query: HistoryQuery): { limit: number; offset: number } {
  const limit = Number(firstQueryValue(query.limit) ?? 50);
  const offset = Number(firstQueryValue(query.offset) ?? 0);
  return {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
    offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
  };
}

function clientIp(request: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip ?? "unknown";
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function makePrivacyCommandId(): string {
  return randomUUID();
}
