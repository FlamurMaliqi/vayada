import type pg from "pg";

import type {
  ExistingAuditReference,
  PlannedIdentityAuditEvent,
} from "./productionIdentityAudit.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { ProductionIdentityExistingState } from "./productionIdentityPlan.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type AuditTargetRow = Omit<PlannedIdentityAuditEvent, "product"> & { product: string };

export async function readProductionIdentityTargetState(
  client: QueryClient,
  sourceRows: IdentitySourceRow[],
): Promise<ProductionIdentityExistingState> {
  const users = await client.query<ProductionIdentityExistingState["users"][number]>(
    `SELECT id::text, email, name, status, updated_at::text AS "updatedAt"
     FROM identity.users ORDER BY id`,
  );
  const workosIdentities = await client.query<
    ProductionIdentityExistingState["workosIdentities"][number]
  >(
    `SELECT user_id::text AS "userId", provider_user_id AS "providerUserId"
     FROM identity.external_identities
     WHERE provider = 'workos' AND provider_user_id IS NOT NULL
     ORDER BY user_id, provider_user_id`,
  );
  const organizations = await client.query<
    ProductionIdentityExistingState["ownership"]["organizations"][number]
  >(
    `SELECT id::text, kind, name, slug, status, updated_at::text AS "updatedAt"
     FROM identity.organizations ORDER BY id`,
  );
  const memberships = await client.query<
    ProductionIdentityExistingState["ownership"]["memberships"][number]
  >(
    `SELECT organization_id::text AS "organizationId", user_id::text AS "userId", status,
            role_key AS "roleKey", property_access_mode AS "propertyAccessMode",
            access_origin AS "accessOrigin", updated_at::text AS "updatedAt"
     FROM identity.organization_memberships ORDER BY organization_id, user_id`,
  );
  const resourceLinks = await client.query<
    ProductionIdentityExistingState["ownership"]["resourceLinks"][number]
  >(
    `SELECT organization_id::text AS "organizationId", product,
            resource_type AS "resourceType", resource_id AS "resourceId", relationship, status,
            updated_at::text AS "updatedAt"
     FROM identity.organization_resource_links
     ORDER BY organization_id, product, resource_type, resource_id, relationship`,
  );
  const entitlements = await client.query<ProductionIdentityExistingState["entitlements"][number]>(
    `SELECT organization_id::text AS "organizationId", product,
            entitlement_key AS "entitlementKey", status,
            resource_product AS "resourceProduct", resource_type AS "resourceType",
            resource_id AS "resourceId", starts_at::text AS "startsAt",
            expires_at::text AS "expiresAt", metadata,
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM identity.product_entitlements
     ORDER BY organization_id, product, entitlement_key, resource_product, resource_type, resource_id`,
  );
  const userConsents = await client.query<
    ProductionIdentityExistingState["privacy"]["userConsents"][number]
  >(
    `SELECT user_id::text AS "userId", terms_accepted_at::text AS "termsAcceptedAt",
            terms_version AS "termsVersion", privacy_accepted_at::text AS "privacyAcceptedAt",
            privacy_version AS "privacyVersion", marketing_consent AS "marketingConsent",
            marketing_consent_at::text AS "marketingConsentAt",
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM identity.user_consent_status ORDER BY user_id`,
  );
  const cookieConsents = await client.query<
    ProductionIdentityExistingState["privacy"]["cookieConsents"][number]
  >(
    `SELECT id::text, visitor_id AS "visitorId", user_id::text AS "userId", necessary,
            functional, analytics, marketing, created_at::text AS "createdAt",
            updated_at::text AS "updatedAt"
     FROM identity.cookie_consents ORDER BY visitor_id`,
  );
  const consentHistory = await client.query<
    ProductionIdentityExistingState["privacy"]["consentHistory"][number]
  >(
    `SELECT id::text, user_id::text AS "userId", visitor_id AS "visitorId",
            consent_type AS "consentType", consent_given AS "consentGiven", version, metadata,
            created_at::text AS "createdAt"
     FROM identity.consent_history ORDER BY id`,
  );
  const gdprRequests = await client.query<
    ProductionIdentityExistingState["privacy"]["gdprRequests"][number]
  >(
    `SELECT id::text, user_id::text AS "userId", request_type AS "requestType", status,
            download_token AS "downloadToken", requested_at::text AS "requestedAt",
            processed_at::text AS "processedAt", expires_at::text AS "expiresAt",
            ip_address AS "ipAddress", metadata, created_at::text AS "createdAt",
            updated_at::text AS "updatedAt"
     FROM identity.gdpr_requests ORDER BY id`,
  );

  const auditIds = [
    ...new Set(
      sourceRows.flatMap((row) => {
        if (row.sourceDatabase !== "auth" || row.sourceTable !== "login_audit_log") return [];
        const id = row.data["id"];
        return typeof id === "string" && UUID.test(id) ? [id.toLowerCase()] : [];
      }),
    ),
  ].sort();
  const auditKeys = auditIds.map((id) => `legacy-auth-login:${id}`);
  const auditRows = new Map<string, AuditTargetRow>();
  for (let offset = 0; offset < auditIds.length; offset += AUDIT_QUERY_BATCH_SIZE) {
    const ids = auditIds.slice(offset, offset + AUDIT_QUERY_BATCH_SIZE);
    const keys = ids.map((id) => `legacy-auth-login:${id}`);
    const result = await client.query<AuditTargetRow>(
      `SELECT id::text, audit_key AS "auditKey", product, action,
            action_version AS "actionVersion", occurred_at::text AS "occurredAt",
            recorded_at::text AS "recordedAt", tenant_scope AS "tenantScope",
            organization_id::text AS "organizationId", property_id::text AS "propertyId",
            actor_type AS "actorType", actor_user_id::text AS "actorUserId",
            target_resource_product AS "targetResourceProduct",
            target_resource_type AS "targetResourceType",
            target_resource_id AS "targetResourceId", redacted_payload AS "redactedPayload",
            secondary_resource_product AS "secondaryResourceProduct",
            secondary_resource_type AS "secondaryResourceType",
            secondary_resource_id AS "secondaryResourceId",
            domain_event_id::text AS "domainEventId",
            external_webhook_event_id::text AS "externalWebhookEventId",
            job_id::text AS "jobId", idempotency_key_id::text AS "idempotencyKeyId",
            correlation_id AS "correlationId", causation_id AS "causationId",
            private_payload AS "privatePayload", audit_metadata AS "auditMetadata",
            retention_class AS "retentionClass", privacy_scope AS "privacyScope",
            ai_visible AS "aiVisible"
     FROM platform.product_audit_events
     WHERE (product = 'identity' AND audit_key = ANY($1::text[]))
        OR id = ANY($2::uuid[])
     ORDER BY product, audit_key, id`,
      [keys, ids],
    );
    for (const row of result.rows) auditRows.set(`${row.product}:${row.auditKey}:${row.id}`, row);
  }
  const auditKeySet = new Set(auditKeys);
  const auditEvents: Array<PlannedIdentityAuditEvent | ExistingAuditReference> = [
    ...auditRows.values(),
  ].map((row) =>
    row.product === "identity" && auditKeySet.has(row.auditKey)
      ? (row as PlannedIdentityAuditEvent)
      : { id: row.id, product: row.product, auditKey: row.auditKey },
  );
  return {
    users: users.rows,
    workosIdentities: workosIdentities.rows,
    ownership: {
      organizations: organizations.rows,
      memberships: memberships.rows,
      resourceLinks: resourceLinks.rows,
    },
    entitlements: entitlements.rows,
    privacy: {
      userConsents: userConsents.rows,
      cookieConsents: cookieConsents.rows,
      consentHistory: consentHistory.rows,
      gdprRequests: gdprRequests.rows,
    },
    auditEvents,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIT_QUERY_BATCH_SIZE = 5_000;
