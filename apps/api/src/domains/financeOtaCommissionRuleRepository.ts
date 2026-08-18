import { createHash } from "node:crypto";

import {
  normalizeFinanceOtaCommissionInstant,
  normalizeFinanceOtaCommissionRate,
  resolveFinanceOtaCommissionRule,
  type FinanceCommandAudit,
  type FinanceOtaCommissionRule,
  type FinanceOtaCommissionRate,
  type FinanceOtaChannel,
} from "@vayada/domain-finance";
import pg from "pg";

type RuleRow = Omit<FinanceOtaCommissionRule, "effectiveFrom" | "effectiveTo"> & {
  effectiveFrom: Date | string;
  effectiveTo: Date | string | null;
};
type IdempotencyRow = { status: string; fp: string; hash: string | null; metadata: unknown };
export type SetFinanceOtaCommissionRuleCommand = {
  commandId: string;
  idempotencyKey: string;
  propertyId: string;
  channel: FinanceOtaChannel;
  percentageRate: FinanceOtaCommissionRate;
  effectiveFrom: string;
  audit: FinanceCommandAudit;
};
const OPERATION = "finance.ota_commission_rule.set";
const RULE_COLUMNS = `id::text AS "ruleId", property_id::text AS "propertyId",
  ota_channel AS channel, percentage_rate::text AS "percentageRate",
  starts_at AS "effectiveFrom", ends_at AS "effectiveTo", revision`;

export function createPgFinanceOtaCommissionRuleRepository(connectionString: string) {
  const pool = new pg.Pool({ connectionString });

  const list = async (propertyId: string) => {
    const result = await pool.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM finance.commission_rules
       WHERE property_id = $1::uuid AND ota_channel IS NOT NULL
       ORDER BY ota_channel, starts_at, revision`,
      [propertyId],
    );
    return result.rows.map(rule);
  };

  return {
    list,
    async resolve(input: Parameters<typeof resolveFinanceOtaCommissionRule>[1]) {
      const rules = await list(input.propertyId);
      return resolveFinanceOtaCommissionRule(rules, input);
    },
    async setRule(rawCommand: SetFinanceOtaCommissionRuleCommand) {
      const actor = rawCommand.audit.actor;
      const effectiveFrom = normalizeFinanceOtaCommissionInstant(rawCommand.effectiveFrom);
      const validRate = normalizeFinanceOtaCommissionRate(rawCommand.percentageRate);
      if (!effectiveFrom || validRate !== rawCommand.percentageRate || actor.kind !== "user")
        throw new Error("OTA commission command failed contract validation");
      const command = { ...rawCommand, effectiveFrom };
      const keyHash = hash(command.idempotencyKey);
      const correlationId = command.audit.correlationId ?? command.audit.requestId;
      const fingerprint = hash(
        `${command.propertyId}|${command.channel}|${command.percentageRate}|${command.effectiveFrom}`,
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        const property = await client.query(
          "SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE",
          [command.propertyId],
        );
        if (property.rowCount !== 1) throw new Error("OTA commission property does not exist");
        const acceptedAt = new Date();

        const existing = await client.query<IdempotencyRow>(
          `SELECT status, request_fingerprint_hash AS fp, response_body_hash AS hash,
                  idempotency_metadata AS metadata
           FROM platform.idempotency_keys
           WHERE operation_scope = 'finance' AND operation = $1 AND key_hash = $2
             AND tenant_scope = 'property' AND property_id = $3::uuid
           FOR UPDATE`,
          [OPERATION, keyHash, command.propertyId],
        );
        const replay = existing.rows[0];
        if (replay) {
          const result = replayResult(replay, command, fingerprint);
          await client.query("ROLLBACK");
          return result;
        }

        const reserved = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope, operation, key_hash, request_fingerprint_hash, status,
              tenant_scope, property_id, correlation_id, expires_at)
           VALUES ('finance', $1, $2, $3, 'in_progress', 'property', $4::uuid, $5,
                   'infinity'::timestamptz)
           ON CONFLICT DO NOTHING RETURNING id::text AS id`,
          [OPERATION, keyHash, fingerprint, command.propertyId, correlationId],
        );
        const reservation = reserved.rows[0]!;

        const priorRows = await client.query<RuleRow>(
          `SELECT ${RULE_COLUMNS} FROM finance.commission_rules
           WHERE property_id = $1::uuid AND ota_channel = $2
           ORDER BY starts_at DESC, revision DESC LIMIT 1 FOR UPDATE`,
          [command.propertyId, command.channel],
        );
        const previous = priorRows.rows[0] ? rule(priorRows.rows[0]) : null;
        if (previous && Date.parse(previous.effectiveFrom) >= Date.parse(command.effectiveFrom)) {
          await client.query("ROLLBACK");
          return { status: "conflict" as const, reason: "effective_window_conflict" as const };
        }
        if (
          previous &&
          (previous.effectiveTo === null ||
            Date.parse(command.effectiveFrom) < Date.parse(previous.effectiveTo))
        ) {
          await client.query(
            "UPDATE finance.commission_rules SET ends_at = $2::timestamptz, updated_at = $3::timestamptz WHERE id = $1::uuid",
            [previous.ruleId, command.effectiveFrom, acceptedAt.toISOString()],
          );
        }
        const revision = (previous?.revision ?? 0) + 1;
        const inserted = await client.query<RuleRow>(
          `INSERT INTO finance.commission_rules
             (property_id, rule_scope, product, commission_type, percentage_rate,
              starts_at, source_system, ota_channel, revision)
           VALUES ($1::uuid, 'property', 'pms', 'percentage', $2::numeric,
                   $3::timestamptz, 'finance', $4, $5)
           RETURNING ${RULE_COLUMNS}`,
          [command.propertyId, validRate, effectiveFrom, command.channel, revision],
        );
        const created = rule(inserted.rows[0]!);
        const previousRuleId = previous?.ruleId ?? null;
        const result = { status: "applied" as const, rule: created, previousRuleId };
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key, product, action, occurred_at, tenant_scope, property_id,
              actor_type, actor_user_id, target_resource_product, target_resource_type,
              target_resource_id, idempotency_key_id, correlation_id, causation_id,
              redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
           VALUES ($1, 'finance', $2, $3::timestamptz, 'property', $4::uuid,
                   'user', $5::uuid, 'finance', 'ota_commission_rule', $6,
                   $7::uuid, $8, $9, $10::jsonb, jsonb_build_object('reason',$11::text),
                   jsonb_build_object('requestId',$9::text,'requestedAt',$12::text,'actorOrganizationId',$13::text),
                   'financial', 'confidential')`,
          [
            `finance.ota_commission_rule.property.${command.propertyId}.channel.${command.channel}.key.${keyHash}.v1`,
            OPERATION,
            acceptedAt.toISOString(),
            command.propertyId,
            actor.userId,
            created.ruleId,
            reservation.id,
            correlationId,
            command.audit.requestId,
            JSON.stringify({
              commandId: command.commandId,
              propertyId: command.propertyId,
              channel: command.channel,
              oldRule: previous,
              newRule: created,
            }),
            command.audit.reason,
            command.audit.requestedAt,
            actor.organizationId,
          ],
        );
        const responseHash = resultHash(created, previousRuleId);
        const completed = await client.query(
          `UPDATE platform.idempotency_keys SET status = 'completed', response_status_code = 200,
             response_body_hash = $2, completed_at = $3::timestamptz,
             idempotency_metadata = jsonb_build_object('result', $4::jsonb)
           WHERE id = $1::uuid AND status = 'in_progress'`,
          [reservation.id, responseHash, acceptedAt.toISOString(), JSON.stringify(result)],
        );
        if (completed.rowCount !== 1)
          throw new Error("OTA commission idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function replayResult(
  existing: IdempotencyRow,
  command: SetFinanceOtaCommissionRuleCommand,
  fingerprint: string,
) {
  if (existing.fp !== fingerprint)
    return { status: "conflict" as const, reason: "idempotency_key_reused" as const };
  if (existing.status !== "completed")
    return { status: "conflict" as const, reason: "command_in_progress" as const };
  const metadata = record(existing.metadata) ? existing.metadata["result"] : null;
  const storedRule = record(metadata) ? metadata["rule"] : null;
  const previousRuleId = record(metadata) ? metadata["previousRuleId"] : undefined;
  if (
    !record(storedRule) ||
    typeof storedRule["ruleId"] !== "string" ||
    (previousRuleId !== null && typeof previousRuleId !== "string")
  )
    throw new Error("OTA commission replay evidence is invalid");
  const resolution = resolveFinanceOtaCommissionRule([storedRule as FinanceOtaCommissionRule], {
    propertyId: command.propertyId,
    channel: command.channel,
    effectiveAt: command.effectiveFrom,
  });
  if (resolution.status !== "applied") throw new Error("OTA commission replay rule is invalid");
  if (existing.hash !== resultHash(resolution.rule, previousRuleId))
    throw new Error("OTA commission replay hash is invalid");
  return { status: "replayed" as const, rule: resolution.rule, previousRuleId };
}

function rule(row: RuleRow): FinanceOtaCommissionRule {
  const percentageRate = normalizeFinanceOtaCommissionRate(row.percentageRate);
  if (!percentageRate) throw new Error("Invalid OTA commission rate evidence");
  return {
    ruleId: row.ruleId,
    propertyId: row.propertyId,
    channel: row.channel,
    percentageRate,
    effectiveFrom: new Date(row.effectiveFrom).toISOString(),
    effectiveTo: row.effectiveTo === null ? null : new Date(row.effectiveTo).toISOString(),
    revision: row.revision,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function resultHash(rule: FinanceOtaCommissionRule, previousRuleId: string | null): string {
  return hash(
    `${rule.ruleId}|${rule.propertyId}|${rule.channel}|${rule.percentageRate}|${rule.effectiveFrom}|${rule.effectiveTo}|${rule.revision}|${previousRuleId}`,
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
