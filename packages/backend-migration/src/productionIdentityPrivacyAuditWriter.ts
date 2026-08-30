import type pg from "pg";

import type { ProductionIdentityPlan } from "./productionIdentityPlan.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type PrivacyAuditIdentityWritePlan = Pick<
  ProductionIdentityPlan,
  "userConsents" | "cookieConsents" | "consentHistory" | "gdprRequests" | "auditEvents" | "blockers"
>;

export async function writeProductionIdentityPrivacyAudit(
  client: QueryClient,
  plan: PrivacyAuditIdentityWritePlan,
): Promise<void> {
  if (plan.blockers.length > 0) throw new Error("Refusing to write a blocked identity plan");

  await write(
    client,
    plan.userConsents,
    `INSERT INTO identity.user_consent_status
       (user_id, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version,
        marketing_consent, marketing_consent_at, created_at, updated_at)
     SELECT "userId", "termsAcceptedAt", "termsVersion", "privacyAcceptedAt", "privacyVersion",
            "marketingConsent", "marketingConsentAt", "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source("userId" uuid, "termsAcceptedAt" timestamptz, "termsVersion" text,
                 "privacyAcceptedAt" timestamptz, "privacyVersion" text,
                 "marketingConsent" boolean, "marketingConsentAt" timestamptz,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (user_id) DO UPDATE
       SET terms_accepted_at = EXCLUDED.terms_accepted_at,
           terms_version = EXCLUDED.terms_version,
           privacy_accepted_at = EXCLUDED.privacy_accepted_at,
           privacy_version = EXCLUDED.privacy_version,
           marketing_consent = EXCLUDED.marketing_consent,
           marketing_consent_at = EXCLUDED.marketing_consent_at,
           updated_at = EXCLUDED.updated_at
     WHERE identity.user_consent_status.updated_at < EXCLUDED.updated_at`,
  );
  await write(
    client,
    plan.cookieConsents,
    `INSERT INTO identity.cookie_consents
       (id, visitor_id, user_id, necessary, functional, analytics, marketing,
        created_at, updated_at)
     SELECT id, "visitorId", "userId", necessary, functional, analytics, marketing,
            "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, "visitorId" text, "userId" uuid, necessary boolean,
                 functional boolean, analytics boolean, marketing boolean,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (visitor_id) DO UPDATE
       SET user_id = EXCLUDED.user_id, necessary = EXCLUDED.necessary,
           functional = EXCLUDED.functional, analytics = EXCLUDED.analytics,
           marketing = EXCLUDED.marketing, updated_at = EXCLUDED.updated_at
     WHERE identity.cookie_consents.updated_at < EXCLUDED.updated_at`,
  );
  await writeImmutable(
    client,
    plan.consentHistory,
    `INSERT INTO identity.consent_history
       (id, user_id, visitor_id, consent_type, consent_given, version, metadata, created_at)
     SELECT id, "userId", "visitorId", "consentType", "consentGiven", version,
            metadata, "createdAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, "userId" uuid, "visitorId" text, "consentType" text,
                 "consentGiven" boolean, version text, metadata jsonb,
                 "createdAt" timestamptz)
     ON CONFLICT (id) DO NOTHING`,
    `SELECT count(*)::integer AS "matchingCount"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, "userId" uuid, "visitorId" text, "consentType" text,
                 "consentGiven" boolean, version text, metadata jsonb,
                 "createdAt" timestamptz)
     JOIN identity.consent_history AS target ON target.id = source.id
     WHERE ROW(target.id, target.user_id, target.visitor_id, target.consent_type,
               target.consent_given, target.version, target.metadata, target.created_at)
       IS NOT DISTINCT FROM
           ROW(source.id, source."userId", source."visitorId", source."consentType",
               source."consentGiven", source.version, source.metadata, source."createdAt")`,
  );
  await write(
    client,
    plan.gdprRequests,
    `INSERT INTO identity.gdpr_requests
       (id, user_id, request_type, status, download_token, requested_at, processed_at,
        expires_at, ip_address, metadata, created_at, updated_at)
     SELECT id, "userId", "requestType", status, "downloadToken", "requestedAt", "processedAt",
            "expiresAt", "ipAddress", metadata, "createdAt", "updatedAt"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, "userId" uuid, "requestType" text, status text,
                 "downloadToken" text, "requestedAt" timestamptz, "processedAt" timestamptz,
                 "expiresAt" timestamptz, "ipAddress" text, metadata jsonb,
                 "createdAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status, download_token = EXCLUDED.download_token,
           processed_at = EXCLUDED.processed_at, expires_at = EXCLUDED.expires_at,
           ip_address = EXCLUDED.ip_address, metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at
     WHERE identity.gdpr_requests.updated_at < EXCLUDED.updated_at`,
  );
  await writeImmutable(
    client,
    plan.auditEvents,
    `INSERT INTO platform.product_audit_events
       (id, audit_key, product, action, action_version, occurred_at, recorded_at, tenant_scope,
        organization_id, property_id, actor_type, actor_user_id, target_resource_product,
        target_resource_type, target_resource_id, secondary_resource_product,
        secondary_resource_type, secondary_resource_id, domain_event_id,
        external_webhook_event_id, job_id, idempotency_key_id, correlation_id, causation_id,
        redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope, ai_visible)
     SELECT id, "auditKey", product, action, "actionVersion", "occurredAt", "recordedAt",
            "tenantScope", "organizationId", "propertyId", "actorType", "actorUserId",
            "targetResourceProduct", "targetResourceType", "targetResourceId",
            "secondaryResourceProduct", "secondaryResourceType", "secondaryResourceId",
            "domainEventId", "externalWebhookEventId", "jobId", "idempotencyKeyId",
            "correlationId", "causationId", "redactedPayload", "privatePayload",
            "auditMetadata", "retentionClass", "privacyScope", "aiVisible"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, "auditKey" text, product text, action text, "actionVersion" integer,
                 "occurredAt" timestamptz, "recordedAt" timestamptz, "tenantScope" text,
                 "organizationId" uuid, "propertyId" uuid, "actorType" text,
                 "actorUserId" uuid, "targetResourceProduct" text, "targetResourceType" text,
                 "targetResourceId" text, "secondaryResourceProduct" text,
                 "secondaryResourceType" text, "secondaryResourceId" text,
                 "domainEventId" uuid, "externalWebhookEventId" uuid, "jobId" uuid,
                 "idempotencyKeyId" uuid, "correlationId" text, "causationId" text,
                 "redactedPayload" jsonb, "privatePayload" jsonb, "auditMetadata" jsonb,
                 "retentionClass" text, "privacyScope" text, "aiVisible" boolean)
     ON CONFLICT (product, audit_key) DO NOTHING`,
    `SELECT count(*)::integer AS "matchingCount"
     FROM jsonb_to_recordset($1::jsonb)
       AS source(id uuid, "auditKey" text, product text, action text, "actionVersion" integer,
                 "occurredAt" timestamptz, "recordedAt" timestamptz, "tenantScope" text,
                 "organizationId" uuid, "propertyId" uuid, "actorType" text,
                 "actorUserId" uuid, "targetResourceProduct" text, "targetResourceType" text,
                 "targetResourceId" text, "secondaryResourceProduct" text,
                 "secondaryResourceType" text, "secondaryResourceId" text,
                 "domainEventId" uuid, "externalWebhookEventId" uuid, "jobId" uuid,
                 "idempotencyKeyId" uuid, "correlationId" text, "causationId" text,
                 "redactedPayload" jsonb, "privatePayload" jsonb, "auditMetadata" jsonb,
                 "retentionClass" text, "privacyScope" text, "aiVisible" boolean)
     JOIN platform.product_audit_events AS target
       ON target.product = source.product AND target.audit_key = source."auditKey"
     WHERE ROW(target.id, target.audit_key, target.product, target.action,
               target.action_version, target.occurred_at, target.recorded_at, target.tenant_scope,
               target.organization_id, target.property_id, target.actor_type, target.actor_user_id,
               target.target_resource_product, target.target_resource_type,
               target.target_resource_id, target.secondary_resource_product,
               target.secondary_resource_type, target.secondary_resource_id,
               target.domain_event_id, target.external_webhook_event_id, target.job_id,
               target.idempotency_key_id, target.correlation_id, target.causation_id,
               target.redacted_payload, target.private_payload, target.audit_metadata,
               target.retention_class, target.privacy_scope, target.ai_visible)
       IS NOT DISTINCT FROM
           ROW(source.id, source."auditKey", source.product, source.action,
               source."actionVersion", source."occurredAt", source."recordedAt",
               source."tenantScope", source."organizationId", source."propertyId",
               source."actorType", source."actorUserId", source."targetResourceProduct",
               source."targetResourceType", source."targetResourceId",
               source."secondaryResourceProduct", source."secondaryResourceType",
               source."secondaryResourceId", source."domainEventId",
               source."externalWebhookEventId", source."jobId", source."idempotencyKeyId",
               source."correlationId", source."causationId", source."redactedPayload",
               source."privatePayload", source."auditMetadata", source."retentionClass",
               source."privacyScope", source."aiVisible")`,
    500,
  );
}

async function write(client: QueryClient, rows: unknown[], sql: string): Promise<void> {
  if (rows.length === 0) return;
  await client.query(sql, [JSON.stringify(rows)]);
}

async function writeImmutable(
  client: QueryClient,
  rows: unknown[],
  insertSql: string,
  verificationSql: string,
  batchSize = rows.length,
): Promise<void> {
  if (rows.length === 0) return;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [JSON.stringify(batch)];
    await client.query(insertSql, values);
    const result = await client.query<{ matchingCount: number }>(verificationSql, values);
    if (result.rows[0]?.matchingCount !== batch.length)
      throw new Error("Immutable identity rows do not match the migration plan");
  }
}
