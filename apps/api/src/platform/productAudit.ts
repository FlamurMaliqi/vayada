import type { ProductAuditEvent, ProductAuditSink } from "../routes/authSession.js";
import pg from "pg";

type PgProductAuditSinkConfig = {
  connectionString: string;
  max?: number;
};

export function createPgProductAuditSink(config: PgProductAuditSinkConfig): ProductAuditSink {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async record(event) {
      await insertProductAuditEvent(pool, event);
    },
  };
}

async function insertProductAuditEvent(pool: pg.Pool, event: ProductAuditEvent): Promise<void> {
  await pool.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         organization_id,
         actor_type,
         actor_user_id,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         correlation_id,
         redacted_payload,
         private_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       ($1, 'identity', $2, $3, $4, $5, $6, $7,
        'identity', 'workos_session', $8, $9, $10, '{}'::jsonb, $11,
        'security', 'confidential')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `${event.action}:${event.surface ?? "default"}:${event.workosSessionId ?? event.requestId}`,
      event.action,
      event.occurredAt,
      event.organizationId ? "organization" : "platform",
      event.organizationId ?? null,
      event.actorUserId ? "user" : "provider",
      event.actorUserId ?? null,
      event.workosSessionId ?? "unknown",
      event.workosSessionId ?? event.requestId,
      JSON.stringify({
        workosUserId: event.workosUserId,
        workosOrgId: event.workosOrgId,
        workosSessionId: event.workosSessionId,
        surface: event.surface,
        authFlow: event.authFlow,
        signupIntent: event.signupIntent,
        resourceScope: event.resourceScope,
      }),
      JSON.stringify({
        requestId: event.requestId,
        source: "apps/api-authkit",
      }),
    ],
  );
}
