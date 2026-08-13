import { createHash } from "node:crypto";

import type {
  FinanceAffiliateCommissionCommand,
  FinanceAffiliateCommissionRepository,
  FinanceAffiliateCommissionResult,
  FinanceAffiliateCommissionView,
} from "@vayada/domain-finance";
import pg, { type PoolClient, type QueryResultRow } from "pg";

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

type RuleRow = QueryResultRow & { id: string; percentageRate: string };
type IdempotencyRow = QueryResultRow & {
  id: string;
  status: string;
  requestFingerprintHash: string;
  metadata: { response?: FinanceAffiliateCommissionResult };
};

export function createPgFinanceAffiliateCommissionRepository(config: {
  connectionString: string;
  max?: number;
  pool?: Pick<pg.Pool, "query" | "connect" | "end">;
}): FinanceAffiliateCommissionRepository {
  if (!config.connectionString.trim()) throw new Error("Finance database URL is required");
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    getCommission(propertyId, affiliateId = null) {
      return readCommission(pool, propertyId, affiliateId);
    },

    async setCommission(command) {
      const percentageRate = normalizeRate(command.percentageRate);
      if (command.affiliateId === null && percentageRate === null) {
        throw new Error("Property default affiliate commission cannot be cleared");
      }
      const normalizedCommand = { ...command, percentageRate };
      const keyHash = sha256(command.idempotencyKey);
      const fingerprint = sha256(
        JSON.stringify({
          propertyId: command.propertyId,
          affiliateId: command.affiliateId,
          commandId: command.commandId,
          percentageRate,
        }),
      );
      const client = await pool.connect();
      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `${command.propertyId}:${keyHash}`,
        ]);
        const prior = await readIdempotency(client, command.propertyId, keyHash);
        if (prior) {
          await client.query("COMMIT");
          transactionOpen = false;
          if (prior.requestFingerprintHash !== fingerprint) {
            return { outcome: "idempotency_conflict" };
          }
          const response = prior.metadata.response;
          if (prior.status !== "completed" || !response || response.outcome !== "applied") {
            throw new Error("Finance affiliate commission idempotency evidence is incomplete");
          }
          return { ...response, outcome: "replayed" };
        }

        const idempotencyId = await reserveIdempotency(
          client,
          normalizedCommand,
          keyHash,
          fingerprint,
        );
        const current = await readActiveRule(client, command.propertyId, command.affiliateId);
        const previousRate = current ? normalizeRate(current.percentageRate) : null;
        let ruleId = current?.id ?? null;
        if (current && previousRate !== percentageRate) {
          await client.query(
            percentageRate === null
              ? `UPDATE finance.commission_rules SET status = 'retired', ends_at = $2::timestamptz,
                   updated_at = $2::timestamptz WHERE id = $1::uuid`
              : `UPDATE finance.commission_rules SET percentage_rate = $2::numeric,
                   updated_at = $3::timestamptz WHERE id = $1::uuid`,
            percentageRate === null
              ? [current.id, command.occurredAt]
              : [current.id, percentageRate, command.occurredAt],
          );
        } else if (!current && percentageRate !== null) {
          ruleId = await insertRule(client, normalizedCommand);
        }
        if (ruleId && previousRate !== percentageRate) {
          await insertRateChange(client, {
            ruleId,
            command: normalizedCommand,
            previousRate,
            percentageRate,
            keyHash,
          });
        }

        const commission = await readCommission(client, command.propertyId, command.affiliateId);
        const result = {
          outcome: "applied" as const,
          commandId: command.commandId,
          commission,
        };
        await insertAudit(client, normalizedCommand, idempotencyId, keyHash, previousRate);
        await completeIdempotency(client, {
          idempotencyId,
          fingerprint,
          command: normalizedCommand,
          result,
        });
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

async function readCommission(
  queryable: Queryable,
  propertyId: string,
  affiliateId: string | null,
): Promise<FinanceAffiliateCommissionView> {
  const result = await queryable.query<{
    defaultRate: string | null;
    overrideRate: string | null;
    updatedAt: Date | string | null;
  }>(
    `SELECT default_rule.percentage_rate::text AS "defaultRate",
            override_rule.percentage_rate::text AS "overrideRate",
            GREATEST(default_rule.updated_at, override_rule.updated_at) AS "updatedAt"
     FROM (SELECT 1) seed
     LEFT JOIN LATERAL (
       SELECT percentage_rate, updated_at FROM finance.commission_rules
       WHERE property_id = $1::uuid AND product = 'affiliate'
         AND rule_scope = 'property' AND affiliate_id IS NULL AND status = 'active'
       LIMIT 1
     ) default_rule ON TRUE
     LEFT JOIN LATERAL (
       SELECT percentage_rate, updated_at FROM finance.commission_rules
       WHERE $2::text IS NOT NULL AND property_id = $1::uuid AND affiliate_id = $2
         AND product = 'affiliate' AND rule_scope = 'affiliate' AND status = 'active'
       LIMIT 1
     ) override_rule ON TRUE`,
    [propertyId, affiliateId],
  );
  const row = result.rows[0];
  const defaultRate = normalizeRate(row?.defaultRate) ?? "0";
  const overrideRate = normalizeRate(row?.overrideRate);
  return {
    contractVersion: "finance-affiliate-commission.v1",
    propertyId,
    affiliateId,
    defaultPercentageRate: defaultRate,
    overridePercentageRate: overrideRate,
    effectivePercentageRate: overrideRate ?? defaultRate,
    updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

async function readIdempotency(
  client: PoolClient,
  propertyId: string,
  keyHash: string,
): Promise<IdempotencyRow | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status, request_fingerprint_hash AS "requestFingerprintHash",
            idempotency_metadata AS metadata
     FROM platform.idempotency_keys
     WHERE operation_scope = 'finance' AND operation = 'affiliate_commission.update'
       AND key_hash = $2 AND tenant_scope = 'property' AND property_id = $1::uuid
     LIMIT 1 FOR UPDATE`,
    [propertyId, keyHash],
  );
  return result.rows[0] ?? null;
}

async function reserveIdempotency(
  client: PoolClient,
  command: FinanceAffiliateCommissionCommand,
  keyHash: string,
  fingerprint: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, property_id, correlation_id, first_seen_at, last_seen_at,
       expires_at, idempotency_metadata
     ) VALUES ('finance', 'affiliate_commission.update', $2, $3, 'in_progress',
       'property', $1::uuid, $4, $5::timestamptz, $5::timestamptz,
       $5::timestamptz + interval '24 hours', $6::jsonb)
     RETURNING id::text AS id`,
    [
      command.propertyId,
      keyHash,
      fingerprint,
      command.commandId,
      command.occurredAt,
      JSON.stringify({ commandId: command.commandId, affiliateId: command.affiliateId }),
    ],
  );
  return result.rows[0].id;
}

async function readActiveRule(
  client: PoolClient,
  propertyId: string,
  affiliateId: string | null,
): Promise<RuleRow | null> {
  const result = await client.query<RuleRow>(
    `SELECT id::text AS id, percentage_rate::text AS "percentageRate"
     FROM finance.commission_rules
     WHERE property_id = $1::uuid AND product = 'affiliate' AND status = 'active'
       AND (($2::text IS NULL AND rule_scope = 'property' AND affiliate_id IS NULL)
         OR ($2::text IS NOT NULL AND rule_scope = 'affiliate' AND affiliate_id = $2))
     LIMIT 1 FOR UPDATE`,
    [propertyId, affiliateId],
  );
  return result.rows[0] ?? null;
}

async function insertRule(
  client: PoolClient,
  command: FinanceAffiliateCommissionCommand,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO finance.commission_rules (
       property_id, affiliate_id, rule_scope, product, commission_type,
       percentage_rate, status, starts_at, source_system, rule_metadata
     ) VALUES ($1::uuid, $2, $3, 'affiliate', 'percentage', $4::numeric,
       'active', $5::timestamptz, 'finance', $6::jsonb)
     RETURNING id::text AS id`,
    [
      command.propertyId,
      command.affiliateId,
      command.affiliateId ? "affiliate" : "property",
      command.percentageRate,
      command.occurredAt,
      JSON.stringify({ contractVersion: "finance-affiliate-commission.v1" }),
    ],
  );
  return result.rows[0].id;
}

async function insertRateChange(
  client: PoolClient,
  input: {
    ruleId: string;
    command: FinanceAffiliateCommissionCommand;
    previousRate: string | null;
    percentageRate: string | null;
    keyHash: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO finance.commission_rate_changes (
       commission_rule_id, changed_by_user_id, previous_percentage_rate,
       new_percentage_rate, reason, effective_at, changed_at, change_metadata
     ) VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric,
       'booking_admin_affiliate_commission', $5::timestamptz, $5::timestamptz, $6::jsonb)`,
    [
      input.ruleId,
      input.command.actorUserId,
      input.previousRate,
      input.percentageRate,
      input.command.occurredAt,
      JSON.stringify({ commandId: input.command.commandId, idempotencyKeyHash: input.keyHash }),
    ],
  );
}

async function insertAudit(
  client: PoolClient,
  command: FinanceAffiliateCommissionCommand,
  idempotencyId: string,
  keyHash: string,
  previousRate: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       actor_user_id, target_resource_product, target_resource_type, target_resource_id,
       idempotency_key_id, correlation_id, redacted_payload, retention_class, privacy_scope
     ) VALUES ($1, 'finance', $2, $3::timestamptz, 'property', $4::uuid, 'user', $5::uuid,
       'finance', 'affiliate_commission', $6, $7::uuid, $8, $9::jsonb, 'financial', 'confidential')`,
    [
      `finance.affiliate_commission.${command.propertyId}.${keyHash}.v1`,
      command.affiliateId
        ? "finance.affiliate_commission.override_updated"
        : "finance.affiliate_commission.default_updated",
      command.occurredAt,
      command.propertyId,
      command.actorUserId,
      command.affiliateId ?? "property-default",
      idempotencyId,
      command.commandId,
      JSON.stringify({
        previousPercentageRate: previousRate,
        newPercentageRate: command.percentageRate,
      }),
    ],
  );
}

async function completeIdempotency(
  client: PoolClient,
  input: {
    idempotencyId: string;
    fingerprint: string;
    command: FinanceAffiliateCommissionCommand;
    result: {
      outcome: "applied";
      commandId: string;
      commission: FinanceAffiliateCommissionView;
    };
  },
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys SET status = 'completed',
       request_fingerprint_hash = $2, response_status_code = 200,
       response_body_hash = $3, response_resource_product = 'finance',
       response_resource_type = 'affiliate_commission', response_resource_id = $4,
       completed_at = $5::timestamptz, last_seen_at = $5::timestamptz,
       idempotency_metadata = idempotency_metadata || $6::jsonb
     WHERE id = $1::uuid`,
    [
      input.idempotencyId,
      input.fingerprint,
      sha256(JSON.stringify(input.result)),
      input.command.affiliateId ?? "property-default",
      input.command.occurredAt,
      JSON.stringify({ response: input.result }),
    ],
  );
}

function normalizeRate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value.trim() === "") throw new Error("Affiliate commission percentage is required");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("Affiliate commission percentage must be between 0 and 100");
  }
  return String(parsed);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
