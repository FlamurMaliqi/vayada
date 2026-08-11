import pg from "pg";
import { WorkOS } from "@workos-inc/node";

import type {
  WorkosMembershipPayload,
  WorkosOrganizationPayload,
  WorkosUserPayload,
  WorkosWebhookEvent,
  WorkosWebhookReceiptInput,
  WorkosWebhookReceiptResult,
  WorkosWebhookStore,
  WorkosWebhookVerifier,
} from "../routes/workosWebhooks.js";

type PgWorkosWebhookStoreConfig = {
  connectionString: string;
  max?: number;
};

type WorkosOrganizationRow = {
  id: string;
  kind: WorkosOrganizationPayload["kind"];
};

export function mapWorkosMembershipRoleKey(input: {
  organizationKind: WorkosOrganizationPayload["kind"];
  roleKey: string;
  existingRoleKey?: string | null;
}): string {
  if (input.roleKey !== "admin") return input.roleKey;
  if (
    input.existingRoleKey === "platform_admin" ||
    input.existingRoleKey === "hotel_owner" ||
    input.existingRoleKey === "owner"
  ) {
    return input.existingRoleKey;
  }
  if (input.organizationKind === "platform") return "platform_admin";
  if (input.organizationKind === "hotel_group") return "hotel_owner";
  return input.roleKey;
}

export function createWorkosWebhookVerifier(config: {
  apiKey: string;
  secret: string;
}): WorkosWebhookVerifier {
  const workos = new WorkOS(config.apiKey);

  return {
    async verify(input) {
      const event = await workos.webhooks.constructEvent({
        payload: input.payload,
        sigHeader: input.signature,
        secret: config.secret,
      });
      return event as unknown as WorkosWebhookEvent;
    },
  };
}

export function createPgWorkosWebhookStore(
  config: PgWorkosWebhookStoreConfig,
): WorkosWebhookStore & { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async insertReceipt(input) {
      return insertReceipt(pool, input);
    },
    async markReceiptProcessed(input) {
      await pool.query(
        `INSERT INTO identity.auth_reconciliation_events
           (event_type, provider, provider_event_id, user_id, organization_id, payload, processed_at)
         VALUES ($1, 'workos', $2, $3, $4, $5, now())`,
        [
          `workos.webhook.${input.status}`,
          input.receiptId,
          input.userId ?? null,
          input.organizationId ?? null,
          JSON.stringify({ receiptId: input.receiptId, status: input.status }),
        ],
      );
    },
    async isReceiptProcessed(receiptId) {
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM identity.auth_reconciliation_events
           WHERE provider = 'workos'
             AND provider_event_id = $1
             AND event_type IN (
               'workos.webhook.normalized',
               'workos.webhook.ignored',
               'workos.webhook.dead_lettered'
             )
         )`,
        [receiptId],
      );
      return result.rows[0]?.exists ?? false;
    },
    async deadLetterReceipt(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const receipt = await client.query(
          `SELECT id
           FROM platform.external_webhook_events
           WHERE id = $1::uuid
           FOR UPDATE`,
          [input.receiptId],
        );
        if (receipt.rowCount !== 1) {
          throw new Error(`WorkOS webhook receipt ${input.receiptId} does not exist`);
        }

        await client.query(
          `INSERT INTO platform.dead_letter_events
             (
               source_kind,
               webhook_event_id,
               tenant_scope,
               resource_product,
               resource_type,
               resource_id,
               reason_code,
               failure_summary,
               failure_payload
             )
           SELECT
             'webhook', receipt.id, 'external', 'identity', 'workos_webhook',
             receipt.id::text, $2, $3, $4
           FROM platform.external_webhook_events AS receipt
           WHERE receipt.id = $1::uuid
             AND NOT EXISTS (
               SELECT 1
               FROM platform.dead_letter_events AS existing
               WHERE existing.source_kind = 'webhook'
                 AND existing.webhook_event_id = receipt.id
                 AND existing.reason_code = $2
             )`,
          [
            input.receiptId,
            input.reasonCode,
            input.failureSummary,
            JSON.stringify(input.failurePayload),
          ],
        );
        await client.query(
          `INSERT INTO identity.auth_reconciliation_events
             (event_type, provider, provider_event_id, payload, error, processed_at)
           SELECT 'workos.webhook.dead_lettered', 'workos', receipt.id::text, $2, $3, now()
           FROM platform.external_webhook_events AS receipt
           WHERE receipt.id = $1::uuid
             AND NOT EXISTS (
               SELECT 1
               FROM identity.auth_reconciliation_events AS existing
               WHERE existing.provider = 'workos'
                 AND existing.event_type = 'workos.webhook.dead_lettered'
                 AND existing.provider_event_id = receipt.id::text
             )`,
          [
            input.receiptId,
            JSON.stringify(input.failurePayload),
            `${input.reasonCode}: ${input.failureSummary}`,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the transaction failure when the connection cannot roll back.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async findUserIdByWorkosUserId(workosUserId) {
      return findUserIdByWorkosUserId(pool, workosUserId);
    },
    async findOrganizationIdByWorkosOrgId(workosOrgId) {
      return findOrganizationIdByWorkosOrgId(pool, workosOrgId);
    },
    async upsertWorkosUser(input) {
      return upsertWorkosUser(pool, input);
    },
    async upsertWorkosOrganization(input) {
      return upsertWorkosOrganization(pool, input);
    },
    async deactivateWorkosUser(workosUserId) {
      const result = await pool.query<{ id: string }>(
        `UPDATE identity.users AS users
         SET status = 'deleted', updated_at = now()
         FROM identity.external_identities AS external_identities
         WHERE external_identities.user_id = users.id
           AND external_identities.provider = 'workos'
           AND external_identities.provider_user_id = $1
         RETURNING users.id`,
        [workosUserId],
      );
      return {
        userId: result.rows[0]?.id,
      };
    },
    async archiveWorkosOrganization(workosOrgId) {
      const result = await pool.query<{ id: string }>(
        `UPDATE identity.organizations
         SET status = 'archived', updated_at = now()
         WHERE workos_org_id = $1
         RETURNING id`,
        [workosOrgId],
      );
      return {
        organizationId: result.rows[0]?.id,
      };
    },
    async deactivateDirectoryUser(input) {
      const result = await pool.query<{ user_id: string; organization_id: string }>(
        `UPDATE identity.organization_memberships AS memberships
         SET status = 'inactive', updated_at = now()
         FROM identity.organizations AS organizations, identity.users AS users
         WHERE memberships.organization_id = organizations.id
           AND memberships.user_id = users.id
           AND organizations.workos_org_id = $1
           AND lower(users.email) = lower($2)
           AND memberships.status IN ('active', 'pending')
         RETURNING memberships.user_id, memberships.organization_id`,
        [input.workosOrgId, input.email],
      );
      const row = result.rows[0];
      return {
        userId: row?.user_id,
        organizationId: row?.organization_id,
      };
    },
    async deactivateOrganizationDirectoryMemberships(workosOrgId) {
      const result = await pool.query<{ organization_id: string }>(
        `UPDATE identity.organization_memberships AS memberships
         SET status = 'inactive', updated_at = now()
         FROM identity.organizations AS organizations
         WHERE memberships.organization_id = organizations.id
           AND organizations.workos_org_id = $1
           AND memberships.status IN ('active', 'pending')
         RETURNING memberships.organization_id`,
        [workosOrgId],
      );
      return {
        organizationId: result.rows[0]?.organization_id,
      };
    },
    async upsertWorkosMembership(input) {
      return upsertWorkosMembership(pool, input);
    },
    async deactivateWorkosMembership(workosMembershipId) {
      const result = await pool.query<{ user_id: string; organization_id: string }>(
        `UPDATE identity.organization_memberships
         SET status = 'inactive', updated_at = now()
         WHERE workos_membership_id = $1
         RETURNING user_id, organization_id`,
        [workosMembershipId],
      );
      const row = result.rows[0];
      return {
        userId: row?.user_id,
        organizationId: row?.organization_id,
      };
    },
    async close() {
      await pool.end();
    },
  };
}

async function insertReceipt(
  pool: pg.Pool,
  input: WorkosWebhookReceiptInput,
): Promise<WorkosWebhookReceiptResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO platform.external_webhook_events
         (
           provider,
           provider_event_id,
           webhook_key_hash,
           event_type,
           delivery_status,
           signature_verified,
           payload_hash,
           raw_headers,
           raw_payload
         )
       VALUES ('workos', $1, $2, $3, 'validated', $4, $5, $6, $7)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id`,
      [
        input.providerEventId,
        input.webhookKeyHash,
        input.eventType,
        input.signatureVerified,
        input.payloadHash,
        JSON.stringify(input.rawHeaders),
        JSON.stringify(input.rawPayload),
      ],
    );
    const insertedId = inserted.rows[0]?.id;
    if (insertedId) {
      await client.query(
        `INSERT INTO platform.jobs
           (
             job_key,
             queue_name,
             job_type,
             tenant_scope,
             resource_product,
             resource_type,
             resource_id,
             idempotency_key_hash,
             payload
           )
         VALUES ($1, 'identity.webhooks', 'identity.workos_webhook.reconcile', 'external',
                 'identity', 'workos_webhook', $2, $3, $4)
         ON CONFLICT (queue_name, job_key) DO NOTHING`,
        [
          `workos-webhook:${input.providerEventId}`,
          insertedId,
          input.payloadHash,
          JSON.stringify({
            receiptId: insertedId,
            providerEventId: input.providerEventId,
            eventType: input.eventType,
          }),
        ],
      );
      await client.query("COMMIT");
      return { status: "inserted", receiptId: insertedId };
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const existing = await pool.query<{ id: string; delivery_status: string }>(
    `SELECT id, delivery_status
     FROM platform.external_webhook_events
     WHERE provider = 'workos' AND provider_event_id = $1
     LIMIT 1`,
    [input.providerEventId],
  );
  const row = existing.rows[0];
  if (!row) {
    throw new Error(`Unable to resolve WorkOS webhook receipt ${input.providerEventId}`);
  }
  return {
    status: "duplicate",
    receiptId: row.id,
    deliveryStatus: row.delivery_status,
  };
}

async function findUserIdByWorkosUserId(
  pool: pg.Pool | pg.PoolClient,
  workosUserId: string,
): Promise<string | null> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id
     FROM identity.external_identities
     WHERE provider = 'workos' AND provider_user_id = $1
     LIMIT 1`,
    [workosUserId],
  );
  return result.rows[0]?.user_id ?? null;
}

async function findOrganizationIdByWorkosOrgId(
  pool: pg.Pool | pg.PoolClient,
  workosOrgId: string,
): Promise<string | null> {
  return (await findOrganizationByWorkosOrgId(pool, workosOrgId))?.id ?? null;
}

async function findOrganizationByWorkosOrgId(
  pool: pg.Pool | pg.PoolClient,
  workosOrgId: string,
): Promise<WorkosOrganizationRow | null> {
  const result = await pool.query<WorkosOrganizationRow>(
    `SELECT id, kind
     FROM identity.organizations
     WHERE workos_org_id = $1
     LIMIT 1`,
    [workosOrgId],
  );
  return result.rows[0] ?? null;
}

async function upsertWorkosUser(pool: pg.Pool, input: WorkosUserPayload): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingUserId = await findUserIdByWorkosUserId(client, input.workosUserId);
    if (existingUserId) {
      await client.query(
        `UPDATE identity.users
         SET email = $1,
             name = COALESCE($2, name),
             status = CASE
               WHEN status IN ('suspended', 'deleted') AND $3 = 'active' THEN status
               ELSE $3
             END,
             updated_at = now()
         WHERE id = $4`,
        [input.email, input.name ?? null, input.status, existingUserId],
      );
      await client.query(
        `UPDATE identity.external_identities
         SET provider_email = $1,
             provider_email_verified = $2,
             raw_profile = $3,
             updated_at = now()
         WHERE provider = 'workos' AND provider_user_id = $4`,
        [input.email, input.emailVerified, JSON.stringify(input.rawProfile), input.workosUserId],
      );
      await client.query("COMMIT");
      return existingUserId;
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO identity.users (email, name, status)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [input.email, input.name ?? null, input.status],
    );
    const userId = created.rows[0]?.id;
    if (!userId) throw new Error("WorkOS user upsert did not return a user id");
    await client.query(
      `INSERT INTO identity.external_identities
         (user_id, provider, provider_user_id, provider_email, provider_email_verified, raw_profile)
       VALUES ($1, 'workos', $2, $3, $4, $5)`,
      [
        userId,
        input.workosUserId,
        input.email,
        input.emailVerified,
        JSON.stringify(input.rawProfile),
      ],
    );
    await client.query("COMMIT");
    return userId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertWorkosOrganization(
  pool: pg.Pool,
  input: WorkosOrganizationPayload,
): Promise<string> {
  const existing = await findOrganizationIdByWorkosOrgId(pool, input.workosOrgId);
  if (existing) {
    await pool.query(
      `UPDATE identity.organizations
       SET name = $1,
           slug = $2,
           status = CASE
             WHEN status IN ('suspended', 'archived') AND $3 = 'active' THEN status
             ELSE $3
           END,
           workos_external_id = COALESCE($4, workos_external_id),
           updated_at = now()
       WHERE id = $5`,
      [input.name, input.slug, input.status, input.externalId ?? null, existing],
    );
    return existing;
  }

  const created = await pool.query<{ id: string }>(
    `INSERT INTO identity.organizations
       (kind, name, slug, status, workos_org_id, workos_external_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.kind, input.name, input.slug, input.status, input.workosOrgId, input.externalId ?? null],
  );
  const organizationId = created.rows[0]?.id;
  if (!organizationId) throw new Error("WorkOS organization upsert did not return an id");
  return organizationId;
}

async function upsertWorkosMembership(
  pool: pg.Pool,
  input: WorkosMembershipPayload,
): Promise<{ userId: string; organizationId: string }> {
  const userId = await findUserIdByWorkosUserId(pool, input.workosUserId);
  const organization = await findOrganizationByWorkosOrgId(pool, input.workosOrgId);
  if (!userId || !organization) {
    throw new Error("WorkOS membership references an unknown user or organization");
  }
  const existingMembership = await pool.query<{ role_key: string }>(
    `SELECT role_key
     FROM identity.organization_memberships
     WHERE organization_id = $1 AND user_id = $2
     LIMIT 1`,
    [organization.id, userId],
  );
  const roleKey = mapWorkosMembershipRoleKey({
    organizationKind: organization.kind,
    roleKey: input.roleKey,
    existingRoleKey: existingMembership.rows[0]?.role_key,
  });

  await pool.query(
    `INSERT INTO identity.organization_memberships
       (
         organization_id,
         user_id,
         status,
         role_key,
         workos_membership_id,
         workos_role_slugs
       )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, user_id)
     DO UPDATE SET
       status = CASE
         WHEN identity.organization_memberships.status IN ('inactive', 'suspended')
          AND EXCLUDED.status = 'active'
         THEN identity.organization_memberships.status
         ELSE EXCLUDED.status
       END,
       role_key = EXCLUDED.role_key,
       workos_membership_id = EXCLUDED.workos_membership_id,
       workos_role_slugs = EXCLUDED.workos_role_slugs,
       updated_at = now()`,
    [
      organization.id,
      userId,
      input.status,
      roleKey,
      input.workosMembershipId,
      input.workosRoleSlugs,
    ],
  );
  return { userId, organizationId: organization.id };
}
