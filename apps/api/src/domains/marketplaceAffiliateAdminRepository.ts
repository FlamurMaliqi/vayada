import { createHash } from "node:crypto";

import type {
  MarketplaceAffiliateAdminRecord,
  MarketplaceAffiliateAdminRepository,
  MarketplaceAffiliateLifecycleAction,
  MarketplaceAffiliateLifecycleStatus,
} from "@vayada/domain-marketplace";
import pg, { type PoolClient, type QueryResultRow } from "pg";

type AffiliateRow = QueryResultRow & {
  id: string;
  affiliateId: string;
  propertyId: string;
  referralCode: string;
  displayName: string | null;
  contactEmail: string | null;
  socialMedia: string | null;
  affiliateType: "guest" | "creator";
  lifecycleStatus: MarketplaceAffiliateLifecycleStatus;
  applicationSource: "public_registration" | "collaboration" | "migration";
  appliedAt: Date | string;
  updatedAt: Date | string;
};

const AFFILIATE_SELECT = `SELECT
  affiliate.id::text AS id,
  affiliate.affiliate_id AS "affiliateId",
  affiliate.property_id::text AS "propertyId",
  affiliate.referral_code AS "referralCode",
  affiliate.display_name AS "displayName",
  affiliate.contact_email AS "contactEmail",
  affiliate.social_media AS "socialMedia",
  affiliate.affiliate_type AS "affiliateType",
  affiliate.lifecycle_status AS "lifecycleStatus",
  affiliate.application_source AS "applicationSource",
  affiliate.applied_at AS "appliedAt",
  affiliate.updated_at AS "updatedAt"
FROM marketplace.property_affiliates affiliate`;

export function createPgMarketplaceAffiliateAdminRepository(config: {
  connectionString: string;
  max?: number;
  pool?: Pick<pg.Pool, "query" | "connect" | "end">;
}): MarketplaceAffiliateAdminRepository {
  if (!config.connectionString.trim()) throw new Error("Marketplace database URL is required");
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async listAffiliates(input) {
      const values: unknown[] = [input.propertyId];
      const filters = [`affiliate.property_id = $1::uuid`];
      if (input.status) {
        values.push(input.status);
        filters.push(`affiliate.lifecycle_status = $${values.length}`);
      }
      if (input.affiliateType) {
        values.push(input.affiliateType);
        filters.push(`affiliate.affiliate_type = $${values.length}`);
      }
      if (input.search) {
        values.push(`%${input.search.toLocaleLowerCase()}%`);
        filters.push(`lower(concat_ws(' ', affiliate.display_name, affiliate.contact_email,
          affiliate.referral_code, affiliate.affiliate_id)) LIKE $${values.length}`);
      }
      const where = `WHERE ${filters.join(" AND ")}`;
      const rows = await pool.query<AffiliateRow>(
        `${AFFILIATE_SELECT} ${where}
         ORDER BY affiliate.applied_at DESC, affiliate.affiliate_id ASC
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, input.limit, input.offset],
      );
      const count = await pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM marketplace.property_affiliates affiliate ${where}`,
        values,
      );
      return { affiliates: rows.rows.map(mapAffiliate), total: Number(count.rows[0]?.total ?? 0) };
    },

    async getAffiliate(propertyId, affiliateId) {
      const result = await pool.query<AffiliateRow>(
        `${AFFILIATE_SELECT}
         WHERE affiliate.property_id = $1::uuid AND affiliate.affiliate_id = $2
         LIMIT 1`,
        [propertyId, affiliateId],
      );
      return result.rows[0] ? mapAffiliate(result.rows[0]) : null;
    },

    async applyLifecycle(command) {
      const client = await pool.connect();
      let transactionOpen = false;
      const keyHash = sha256(command.idempotencyKey);
      const fingerprint = sha256(
        JSON.stringify({
          propertyId: command.propertyId,
          affiliateId: command.affiliateId,
          commandId: command.commandId,
          action: command.action,
        }),
      );
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `${command.propertyId}:${keyHash}`,
        ]);
        const replay = await client.query<{
          requestFingerprintHash: string;
          resultSnapshot: { commandId: string; affiliate: MarketplaceAffiliateAdminRecord };
        }>(
          `SELECT request_fingerprint_hash AS "requestFingerprintHash",
                  result_snapshot AS "resultSnapshot"
           FROM marketplace.affiliate_lifecycle_changes
           WHERE property_id = $1::uuid AND idempotency_key_hash = $2`,
          [command.propertyId, keyHash],
        );
        if (replay.rows[0]) {
          await client.query("COMMIT");
          transactionOpen = false;
          if (replay.rows[0].requestFingerprintHash !== fingerprint) {
            return { outcome: "idempotency_conflict" };
          }
          return { outcome: "replayed", ...replay.rows[0].resultSnapshot };
        }

        const current = await client.query<AffiliateRow>(
          `${AFFILIATE_SELECT}
           WHERE affiliate.property_id = $1::uuid AND affiliate.affiliate_id = $2
           FOR UPDATE`,
          [command.propertyId, command.affiliateId],
        );
        const row = current.rows[0];
        if (!row) {
          await client.query("COMMIT");
          transactionOpen = false;
          return { outcome: "not_found" };
        }
        const nextStatus = nextLifecycleStatus(row.lifecycleStatus, command.action);
        if (!nextStatus) {
          await client.query("COMMIT");
          transactionOpen = false;
          return {
            outcome: "invalid_transition" as const,
            currentStatus: row.lifecycleStatus,
          };
        }

        const updated = await client.query<AffiliateRow>(
          `UPDATE marketplace.property_affiliates affiliate
           SET lifecycle_status = $3, updated_at = $4::timestamptz
           WHERE affiliate.property_id = $1::uuid AND affiliate.affiliate_id = $2
           RETURNING affiliate.id::text AS id, affiliate.affiliate_id AS "affiliateId",
             affiliate.property_id::text AS "propertyId", affiliate.referral_code AS "referralCode",
             affiliate.display_name AS "displayName", affiliate.contact_email AS "contactEmail",
             affiliate.social_media AS "socialMedia", affiliate.affiliate_type AS "affiliateType",
             affiliate.lifecycle_status AS "lifecycleStatus",
             affiliate.application_source AS "applicationSource",
             affiliate.applied_at AS "appliedAt", affiliate.updated_at AS "updatedAt"`,
          [command.propertyId, command.affiliateId, nextStatus, command.occurredAt],
        );
        const affiliate = mapAffiliate(updated.rows[0]);
        const audit = await insertAudit(client, command, row.lifecycleStatus, nextStatus, keyHash);
        const result = { outcome: "applied" as const, commandId: command.commandId, affiliate };
        await client.query(
          `INSERT INTO marketplace.affiliate_lifecycle_changes (
             property_affiliate_id, property_id, affiliate_id, command_id, idempotency_key_hash,
             request_fingerprint_hash, actor_user_id, previous_status, new_status, outcome,
             result_snapshot, audit_event_id, occurred_at
           ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, 'applied',
             $10::jsonb, $11::uuid, $12::timestamptz)`,
          [
            row.id,
            command.propertyId,
            command.affiliateId,
            command.commandId,
            keyHash,
            fingerprint,
            command.actorUserId,
            row.lifecycleStatus,
            nextStatus,
            JSON.stringify({ commandId: command.commandId, affiliate }),
            audit,
            command.occurredAt,
          ],
        );
        await client.query("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK");
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

function nextLifecycleStatus(
  current: MarketplaceAffiliateLifecycleStatus,
  action: MarketplaceAffiliateLifecycleAction,
): MarketplaceAffiliateLifecycleStatus | null {
  if (current === "pending" && action === "approve") return "approved";
  if (current === "pending" && action === "reject") return "rejected";
  if (current === "approved" && action === "suspend") return "suspended";
  if (current === "suspended" && action === "restore") return "approved";
  return null;
}

async function insertAudit(
  client: PoolClient,
  command: Parameters<MarketplaceAffiliateAdminRepository["applyLifecycle"]>[0],
  previousStatus: MarketplaceAffiliateLifecycleStatus,
  newStatus: MarketplaceAffiliateLifecycleStatus,
  keyHash: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       actor_user_id, target_resource_product, target_resource_type, target_resource_id,
       correlation_id, causation_id, redacted_payload, retention_class, privacy_scope
     ) VALUES ($1, 'marketplace', $2, $3::timestamptz, 'property', $4::uuid, 'user', $5::uuid,
       'marketplace', 'affiliate', $6, $7, $8, $9::jsonb, 'standard', 'confidential')
     RETURNING id::text AS id`,
    [
      `marketplace.affiliate.lifecycle.${command.propertyId}.${keyHash}.v1`,
      `marketplace.affiliate.${command.action}`,
      command.occurredAt,
      command.propertyId,
      command.actorUserId,
      command.affiliateId,
      command.commandId,
      keyHash,
      JSON.stringify({ previousStatus, newStatus }),
    ],
  );
  return result.rows[0].id;
}

function mapAffiliate(row: AffiliateRow): MarketplaceAffiliateAdminRecord {
  return {
    contractVersion: "marketplace-affiliate-admin.v1",
    affiliateId: row.affiliateId,
    propertyId: row.propertyId,
    referralCode: row.referralCode,
    displayName: row.displayName,
    contactEmail: row.contactEmail,
    socialMedia: row.socialMedia,
    affiliateType: row.affiliateType,
    lifecycleStatus: row.lifecycleStatus,
    applicationSource: row.applicationSource,
    appliedAt: new Date(row.appliedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
