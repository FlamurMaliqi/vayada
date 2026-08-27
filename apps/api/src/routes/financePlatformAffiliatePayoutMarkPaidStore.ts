import {
  FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION,
  type FinanceAffiliatePayoutPaymentEvidence,
  type NormalizedFinanceAffiliatePayoutMarkPaid,
} from "@vayada/domain-finance";
import type { QueryResult, QueryResultRow } from "pg";

export type AffiliatePayoutWriteClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type AffiliatePayoutIdempotency = {
  id: string;
  requestFingerprintHash: string;
  status: string;
};

export type AffiliatePayoutCandidate = {
  payoutId: string;
  amount: string;
  payoutStatus: string;
  providerPayoutId: string | null;
  payoutMethod: string;
};

type EvidenceRow = Omit<
  FinanceAffiliatePayoutPaymentEvidence,
  "payoutIds" | "paidAt" | "recordedAt"
> & {
  payoutIds: string[];
  paidAt: string | Date;
  recordedAt: string | Date;
};

export async function resolveAffiliateOrganization(
  client: AffiliatePayoutWriteClient,
  affiliateId: string,
  currency: string,
  payoutIds: string[],
): Promise<string | null> {
  const result = await client.query<{ organizationId: string }>(
    `SELECT payout.organization_id::text AS "organizationId"
     FROM finance.payouts payout
     JOIN identity.organizations organization
       ON organization.id = payout.organization_id
      AND organization.kind = 'affiliate_partner'
     LEFT JOIN finance.payout_settings settings
       ON settings.id = payout.payout_setting_id
      AND settings.organization_id = payout.organization_id
     WHERE payout.id = ANY($1::uuid[])
       AND payout.owner_scope = 'organization'
       AND payout.currency = $2
       AND COALESCE(
         payout.payout_metadata ->> 'affiliateId',
         payout.payout_metadata ->> 'affiliate_id',
         settings.payout_preferences ->> 'affiliateId',
         settings.payout_preferences ->> 'affiliate_id',
         payout.payout_metadata ->> 'resourceId'
       ) = $3
     GROUP BY payout.organization_id
     HAVING COUNT(*) = cardinality($1::uuid[])`,
    [payoutIds, currency, affiliateId],
  );
  return result.rows.length === 1 ? result.rows[0]!.organizationId : null;
}

export async function reserveAffiliatePayoutIdempotency(
  client: AffiliatePayoutWriteClient,
  command: NormalizedFinanceAffiliatePayoutMarkPaid,
  keyHash: string,
  fingerprint: string,
): Promise<AffiliatePayoutIdempotency> {
  await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, correlation_id, first_seen_at, last_seen_at, expires_at,
       idempotency_metadata
     ) VALUES (
       'finance', 'affiliate_payout_mark_paid', $1, $2, 'in_progress', 'platform',
       $3, $4::timestamptz, $4::timestamptz, $4::timestamptz + interval '30 days', $5::jsonb
     ) ON CONFLICT DO NOTHING`,
    [
      keyHash,
      fingerprint,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestedAt,
      JSON.stringify({ commandId: command.commandId, affiliateId: command.affiliateId }),
    ],
  );
  const result = await client.query<AffiliatePayoutIdempotency>(
    `SELECT id::text, request_fingerprint_hash AS "requestFingerprintHash", status
     FROM platform.idempotency_keys
     WHERE operation_scope = 'finance'
       AND operation = 'affiliate_payout_mark_paid'
       AND key_hash = $1
       AND tenant_scope = 'platform'
     FOR UPDATE`,
    [keyHash],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Affiliate payout idempotency reservation failed.");
  return row;
}

export async function lockAffiliatePayouts(
  client: AffiliatePayoutWriteClient,
  affiliateId: string,
  organizationId: string,
  currency: string,
  payoutIds: string[],
): Promise<AffiliatePayoutCandidate[]> {
  const result = await client.query<AffiliatePayoutCandidate>(
    `SELECT
       payout.id::text AS "payoutId",
       payout.amount::text, payout.payout_status AS "payoutStatus",
       payout.provider_payout_id AS "providerPayoutId",
       CASE COALESCE(account.provider, settings.payout_method, 'manual')
         WHEN 'bank' THEN 'bank_transfer'
         WHEN 'bank_account' THEN 'bank_transfer'
         ELSE COALESCE(account.provider, settings.payout_method, 'manual')
       END AS "payoutMethod"
     FROM finance.payouts payout
     LEFT JOIN finance.payout_settings settings
       ON settings.id = payout.payout_setting_id
      AND settings.organization_id = payout.organization_id
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id = payout.organization_provider_account_id
      AND account.organization_id = payout.organization_id
     WHERE payout.owner_scope = 'organization'
       AND payout.id = ANY($4::uuid[])
       AND payout.organization_id = $1::uuid
       AND payout.currency = $2
       AND COALESCE(
         payout.payout_metadata ->> 'affiliateId',
         payout.payout_metadata ->> 'affiliate_id',
         settings.payout_preferences ->> 'affiliateId',
         settings.payout_preferences ->> 'affiliate_id',
         payout.payout_metadata ->> 'resourceId'
       ) = $3
     ORDER BY payout.id
     FOR UPDATE OF payout`,
    [organizationId, currency, affiliateId, payoutIds],
  );
  return result.rows;
}

export async function insertAffiliatePayoutEvidence(
  client: AffiliatePayoutWriteClient,
  command: NormalizedFinanceAffiliatePayoutMarkPaid,
  organizationId: string,
  idempotencyId: string,
  fingerprint: string,
  payoutIds: string[],
): Promise<{ evidenceId: string; amount: string } | null> {
  const result = await client.query<{ evidenceId: string; amount: string }>(
    `INSERT INTO finance.affiliate_payout_payment_evidence (
       organization_id, affiliate_id, recorded_by_organization_id, recorded_by_user_id,
       idempotency_key_id, command_id, request_fingerprint_hash, payment_method,
       external_reference, evidence_reference, note, amount, currency, payout_count, paid_at
     )
     SELECT
       $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11,
       SUM(amount), $12, COUNT(*)::int, $13::timestamptz
     FROM finance.payouts
     WHERE id = ANY($14::uuid[])
       AND organization_id = $1::uuid
     ON CONFLICT DO NOTHING
     RETURNING id::text AS "evidenceId", amount::text`,
    [
      organizationId,
      command.affiliateId,
      command.audit.actor.organizationId,
      command.audit.actor.userId,
      idempotencyId,
      command.commandId,
      fingerprint,
      command.payload.paymentMethod,
      command.payload.externalReference,
      command.payload.evidenceReference,
      command.payload.note,
      command.currency,
      command.payload.paidAt,
      payoutIds,
    ],
  );
  return result.rows[0] ?? null;
}

export async function applyAffiliatePayoutPaidState(
  client: AffiliatePayoutWriteClient,
  command: NormalizedFinanceAffiliatePayoutMarkPaid,
  organizationId: string,
  evidenceId: string,
  payoutIds: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO finance.affiliate_payout_payment_evidence_items (
       evidence_id, organization_id, payout_id, amount, currency
     )
     SELECT $1::uuid, organization_id, id, amount, currency
     FROM finance.payouts
     WHERE id = ANY($2::uuid[])
       AND organization_id = $3::uuid`,
    [evidenceId, payoutIds, organizationId],
  );
  const updated = await client.query(
    `WITH eligible AS (
       SELECT payout.id
       FROM finance.payouts payout
       LEFT JOIN finance.payout_settings settings
         ON settings.id = payout.payout_setting_id
        AND settings.organization_id = payout.organization_id
       LEFT JOIN finance.payment_provider_accounts account
         ON account.id = payout.organization_provider_account_id
        AND account.organization_id = payout.organization_id
       WHERE payout.id = ANY($4::uuid[])
         AND payout.organization_id = $5::uuid
         AND payout.payout_status IN ('pending', 'scheduled')
         AND payout.provider_payout_id IS NULL
         AND COALESCE(
           payout.payout_metadata ->> 'affiliateId',
           payout.payout_metadata ->> 'affiliate_id',
           settings.payout_preferences ->> 'affiliateId',
           settings.payout_preferences ->> 'affiliate_id',
           payout.payout_metadata ->> 'resourceId'
         ) = $6
         AND payout.currency = $7
         AND CASE COALESCE(account.provider, settings.payout_method, 'manual')
           WHEN 'bank' THEN 'bank_transfer'
           WHEN 'bank_account' THEN 'bank_transfer'
           ELSE COALESCE(account.provider, settings.payout_method, 'manual')
         END IN ('manual', 'bank_transfer')
     )
     UPDATE finance.payouts payout
     SET payout_status = 'paid', paid_at = $1::timestamptz, updated_at = $2::timestamptz,
         payout_metadata = payout.payout_metadata || $3::jsonb
     FROM eligible
     WHERE payout.id = eligible.id`,
    [
      command.payload.paidAt,
      command.audit.requestedAt,
      JSON.stringify({
        manualPaymentEvidenceId: evidenceId,
        manualMarkedPaidCommandId: command.commandId,
      }),
      payoutIds,
      organizationId,
      command.affiliateId,
      command.currency,
    ],
  );
  if (updated.rowCount !== payoutIds.length) {
    throw new Error("Affiliate payout mark-paid update lost its locked candidate set.");
  }
}

export async function cancelPendingAffiliatePayoutJobs(
  client: AffiliatePayoutWriteClient,
  command: NormalizedFinanceAffiliatePayoutMarkPaid,
  payoutIds: string[],
): Promise<void> {
  await client.query(
    `UPDATE platform.jobs
     SET status = 'canceled', finished_at = $1::timestamptz, updated_at = $1::timestamptz,
         job_metadata = job_metadata || $2::jsonb
     WHERE queue_name = 'finance-affiliate-payout-dispatch'
       AND status = 'pending'
       AND job_key IN (
         SELECT 'finance.dispatch-affiliate-payout:affiliate:' || $3 || ':payout:' || id || ':v1'
         FROM unnest($4::uuid[]) id
       )`,
    [
      command.audit.requestedAt,
      JSON.stringify({ canceledByCommandId: command.commandId, reason: "manual_mark_paid" }),
      command.affiliateId,
      payoutIds,
    ],
  );
}

export async function recordAffiliatePayoutPaidAudit(
  client: AffiliatePayoutWriteClient,
  command: NormalizedFinanceAffiliatePayoutMarkPaid,
  organizationId: string,
  idempotencyId: string,
  evidenceId: string,
  amount: string,
  payoutIds: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, secondary_resource_product, secondary_resource_type,
       secondary_resource_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope
     ) VALUES (
       $1, 'finance', 'finance.affiliate_payout.marked_paid', $2::timestamptz,
       'platform', NULL, 'user', $3::uuid, 'finance', 'affiliate', $4,
       'finance', 'affiliate_payout_payment_evidence', $5, $6::uuid, $7, $8,
       $9::jsonb, $10::jsonb, $11::jsonb, 'financial', 'confidential'
     ) ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `finance.affiliate-payout.mark-paid.affiliate.${command.affiliateId}.evidence.${evidenceId}.v1`,
      command.audit.requestedAt,
      command.audit.actor.userId,
      command.affiliateId,
      evidenceId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        contractVersion: FINANCE_PLATFORM_AFFILIATE_PAYOUT_CONTRACT_VERSION,
        currency: command.currency,
        paymentMethod: command.payload.paymentMethod,
        payoutCount: payoutIds.length,
        amount,
      }),
      JSON.stringify({
        affiliateOrganizationId: organizationId,
        recordedByOrganizationId: command.audit.actor.organizationId,
        externalReference: command.payload.externalReference,
        evidenceReference: command.payload.evidenceReference,
        note: command.payload.note,
      }),
      JSON.stringify({ payoutIds }),
    ],
  );
}

export async function completeAffiliatePayoutIdempotency(
  client: AffiliatePayoutWriteClient,
  command: NormalizedFinanceAffiliatePayoutMarkPaid,
  idempotencyId: string,
  evidenceId: string,
  responseHash: string,
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = 200,
         response_resource_product = 'finance',
         response_resource_type = 'affiliate_payout_payment_evidence',
         response_resource_id = $1, response_body_hash = $2,
         completed_at = $3::timestamptz, last_seen_at = $3::timestamptz
     WHERE id = $4::uuid`,
    [evidenceId, responseHash, command.audit.requestedAt, idempotencyId],
  );
}

export async function loadAffiliatePayoutEvidence(
  client: AffiliatePayoutWriteClient,
  idempotencyId: string,
): Promise<FinanceAffiliatePayoutPaymentEvidence | null> {
  const result = await client.query<EvidenceRow>(
    `SELECT evidence.id::text AS "evidenceId", evidence.affiliate_id AS "affiliateId",
       evidence.organization_id::text AS "organizationId",
       ARRAY_AGG(item.payout_id::text ORDER BY item.payout_id) AS "payoutIds",
       evidence.amount::text, evidence.currency, evidence.payment_method AS "paymentMethod",
       evidence.external_reference AS "externalReference",
       evidence.evidence_reference AS "evidenceReference", evidence.note,
       evidence.paid_at AS "paidAt", evidence.recorded_at AS "recordedAt"
     FROM finance.affiliate_payout_payment_evidence evidence
     JOIN finance.affiliate_payout_payment_evidence_items item
       ON item.evidence_id = evidence.id AND item.organization_id = evidence.organization_id
     WHERE evidence.idempotency_key_id = $1::uuid
     GROUP BY evidence.id`,
    [idempotencyId],
  );
  const row = result.rows[0];
  return row
    ? {
        ...row,
        paidAt: row.paidAt instanceof Date ? row.paidAt.toISOString() : row.paidAt,
        recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
      }
    : null;
}
