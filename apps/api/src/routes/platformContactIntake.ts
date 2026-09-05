import { requireAuthContext } from "@vayada/backend-auth";

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export const PL1_NON_MEDIA_CONTRACT_VERSION = "pl1-non-media.v1" as const;

export type PlatformContactIntakeRequest = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  company?: unknown;
  country?: unknown;
  userType?: unknown;
  user_type?: unknown;
  message?: unknown;
};

export type PlatformContactIntakeCommand = {
  contractVersion: typeof PL1_NON_MEDIA_CONTRACT_VERSION;
  idempotencyKey: string;
  receivedAt: string;
};

export type PlatformContactIntakeResponse = {
  contractVersion: typeof PL1_NON_MEDIA_CONTRACT_VERSION;
  command: PlatformContactIntakeCommand;
  intakeId: string;
  eventId: string;
  jobId: string;
  status: "accepted";
};

export type PlatformContactIntakePayload = {
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  country: string | null;
  userType: string | null;
  message: string;
};

export type PlatformContactIntakeRepository = {
  submitContact(input: {
    payload: PlatformContactIntakePayload;
    requestId: string;
    receivedAt: string;
  }): Promise<PlatformContactIntakeResponse>;
  close?(): Promise<void>;
};

export type PlatformContactIntakePool = {
  connect(): Promise<PoolClient>;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

export type PlatformContactIntakeRoutesOptions = {
  repository: PlatformContactIntakeRepository;
  allowedOrigins?: string[];
};

type ContactIntakeRouteError = {
  code: "invalid_request" | "intake_unavailable";
  category: "validation" | "write_model";
  message: string;
};

type ContactIntakeRow = {
  eventId: string;
};

type ContactJobRow = {
  jobId: string;
};

export function registerPlatformContactIntakeRoutes(
  app: FastifyInstance,
  options: PlatformContactIntakeRoutesOptions,
): void {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?", 1)[0] !== "/api/contact") return;
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "Content-Type");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
  });

  app.options("/contact", async (_request, reply) => reply.status(204).send());

  app.post<{ Body: { kind?: unknown; message?: unknown; page?: unknown; product?: unknown } }>(
    "/support",
    { bodyLimit: 24_000 },
    async (request, reply) => {
      // Identity-only exception: support must remain available without product permissions,
      // entitlements or linked resources, including when users report access problems.
      const context = requireAuthContext(request);
      const { kind, message, page, product } = request.body ?? {};
      if (
        (kind !== "support" && kind !== "bug") ||
        typeof message !== "string" ||
        !message.trim() ||
        message.trim().length > 4000 ||
        typeof page !== "string" ||
        page.length > 500 ||
        !/^\/(?!\/)[^?#\\\s]*$/.test(page) ||
        typeof product !== "string" ||
        !["marketplace", "booking", "pms", "affiliate"].includes(product)
      ) {
        return sendContactIntakeError(reply, 400, {
          code: "invalid_request",
          category: "validation",
          message: "Choose a request type and enter a message (up to 4000 characters).",
        });
      }
      try {
        const result = await options.repository.submitContact({
          requestId: request.id,
          receivedAt: new Date().toISOString(),
          payload: {
            name: context.actor.name || context.actor.email,
            email: context.actor.email,
            phone: null,
            company: null,
            country: null,
            userType: kind,
            message: JSON.stringify({
              kind,
              message: message.trim(),
              page,
              product,
              userId: context.actor.internalUserId,
              organizationId: context.selectedOrganization.organizationId,
            }),
          },
        });
        return reply.status(201).send({ status: result.status, reference: result.intakeId });
      } catch {
        request.log.error({ requestId: request.id }, "Support intake failed");
        return sendContactIntakeError(reply, 503, {
          code: "intake_unavailable",
          category: "write_model",
          message: "We could not save your request. Please try again.",
        });
      }
    },
  );

  app.post<{ Body: PlatformContactIntakeRequest }>("/contact", async (request, reply) => {
    const parsed = parseContactPayload(request.body);
    if (!parsed.ok) return sendContactIntakeError(reply, 400, parsed.error);

    try {
      return await options.repository.submitContact({
        payload: parsed.value,
        requestId: request.id,
        receivedAt: new Date().toISOString(),
      });
    } catch (error) {
      request.log.error({ err: error }, "Platform contact intake failed");
      return sendContactIntakeError(reply, 500, {
        code: "intake_unavailable",
        category: "write_model",
        message: "Contact intake is temporarily unavailable.",
      });
    }
  });
}

export function createPgPlatformContactIntakeRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PlatformContactIntakePool;
}): PlatformContactIntakeRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Platform contact intake connectionString must not be empty");
  }
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async submitContact({ payload, requestId, receivedAt }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await persistContactIntake(client, payload, requestId, receivedAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function persistContactIntake(
  client: Pick<PlatformContactIntakePool, "query">,
  payload: PlatformContactIntakePayload,
  requestId: string,
  receivedAt: string,
): Promise<PlatformContactIntakeResponse> {
  const fingerprint = sha256(stableJson(payload));
  const idempotencyKey = contactIntakeIdempotencyKey(payload.email, fingerprint, receivedAt);
  const intakeId = `contact_${fingerprint.slice(0, 24)}`;
  const redactedPayload = contactRedactedPayload(payload);
  const privatePayload = {
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    company: payload.company,
    country: payload.country,
    userType: payload.userType,
    message: payload.message,
  };

  const event = await client.query<ContactIntakeRow>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events (
         source_system,
         event_key,
         event_type,
         event_version,
         occurred_at,
         tenant_scope,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         idempotency_key_hash,
         payload,
         event_metadata,
         privacy_scope
       )
       VALUES (
         'platform',
         $1,
         'platform.contact_submission.received',
         1,
         $2::timestamptz,
         'platform',
         'platform',
         'contact_submission',
         $3,
         'system',
         $4,
         $5,
         $6::jsonb,
         $7::jsonb,
         'confidential'
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id::text AS "eventId"
     )
     SELECT "eventId" FROM inserted
     UNION ALL
     SELECT id::text AS "eventId"
     FROM platform.domain_events
     WHERE source_system = 'platform'
       AND event_key = $1
     LIMIT 1`,
    [
      idempotencyKey,
      receivedAt,
      intakeId,
      requestId,
      sha256(idempotencyKey),
      JSON.stringify(privatePayload),
      JSON.stringify({
        contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION,
        redacted: redactedPayload,
      }),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("Contact intake domain event was not persisted.");

  const job = await client.query<ContactJobRow>(
    `WITH inserted AS (
       INSERT INTO platform.jobs (
         job_key,
         queue_name,
         job_type,
         source_domain_event_id,
         tenant_scope,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
       VALUES (
         $1,
         'platform.email',
         'email.platform-contact-notification',
         $2::uuid,
         'platform',
         'platform',
         'contact_submission',
         $3,
         $4,
         $5,
         $6::jsonb,
         $7::jsonb
       )
       ON CONFLICT (queue_name, job_key) DO NOTHING
       RETURNING id::text AS "jobId"
     )
     SELECT "jobId" FROM inserted
     UNION ALL
     SELECT id::text AS "jobId"
     FROM platform.jobs
     WHERE queue_name = 'platform.email'
       AND job_key = $1
     LIMIT 1`,
    [
      idempotencyKey,
      eventId,
      intakeId,
      requestId,
      sha256(idempotencyKey),
      JSON.stringify(privatePayload),
      JSON.stringify({ contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION }),
    ],
  );
  const jobId = job.rows[0]?.jobId;
  if (!jobId) throw new Error("Contact notification job was not persisted.");

  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,
       product,
       action,
       action_version,
       occurred_at,
       tenant_scope,
       actor_type,
       target_resource_product,
       target_resource_type,
       target_resource_id,
       domain_event_id,
       job_id,
       correlation_id,
       causation_id,
       redacted_payload,
       private_payload,
       audit_metadata,
       retention_class,
       privacy_scope
     )
     VALUES (
       $1,
       'platform',
       'platform.contact_submission.received',
       1,
       $2::timestamptz,
       'platform',
       'system',
       'platform',
       'contact_submission',
       $3,
       $4::uuid,
       $5::uuid,
       $6,
       $1,
       $7::jsonb,
       $8::jsonb,
       $9::jsonb,
       'standard',
       'confidential'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      idempotencyKey,
      receivedAt,
      intakeId,
      eventId,
      jobId,
      requestId,
      JSON.stringify(redactedPayload),
      JSON.stringify(privatePayload),
      JSON.stringify({ contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION }),
    ],
  );

  return {
    contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION,
    command: {
      contractVersion: PL1_NON_MEDIA_CONTRACT_VERSION,
      idempotencyKey,
      receivedAt,
    },
    intakeId,
    eventId,
    jobId,
    status: "accepted",
  };
}

function parseContactPayload(
  body: PlatformContactIntakeRequest | undefined,
):
  | { ok: true; value: PlatformContactIntakePayload }
  | { ok: false; error: ContactIntakeRouteError } {
  const value = body && typeof body === "object" ? body : {};
  const name = readRequiredString(value.name);
  const email = normalizeEmail(value.email);
  const message = readRequiredString(value.message);

  if (!name || !email || !message) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        category: "validation",
        message: "name, email, and message are required.",
      },
    };
  }

  return {
    ok: true,
    value: {
      name,
      email,
      phone: readOptionalString(value.phone),
      company: readOptionalString(value.company),
      country: readOptionalString(value.country),
      userType: readOptionalString(value.userType ?? value.user_type),
      message,
    },
  };
}

function contactRedactedPayload(payload: PlatformContactIntakePayload): Record<string, unknown> {
  return {
    emailDomain: payload.email.split("@")[1] ?? "unknown",
    hasPhone: Boolean(payload.phone),
    hasCompany: Boolean(payload.company),
    country: payload.country,
    userType: payload.userType,
    messageLength: payload.message.length,
  };
}

function contactIntakeIdempotencyKey(
  email: string,
  fingerprint: string,
  receivedAt: string,
): string {
  const hourWindow = receivedAt.slice(0, 13);
  return `platform.contact_submission:${sha256(`${email}:${fingerprint}:${hourWindow}`).slice(
    0,
    32,
  )}:v1`;
}

function readRequiredString(value: unknown): string | null {
  const normalized = readOptionalString(value);
  return normalized && normalized.length <= 4000 ? normalized : null;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeEmail(value: unknown): string | null {
  const email = readOptionalString(value)?.toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function sendContactIntakeError(
  reply: FastifyReply,
  statusCode: 400 | 500 | 503,
  error: ContactIntakeRouteError,
): FastifyReply {
  return reply.status(statusCode).send({ ...error, statusCode });
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original write error.
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
