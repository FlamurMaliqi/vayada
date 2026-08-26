import type {
  FinanceAffiliatePayoutPaymentEvidence,
  FinancePlatformAffiliatePayoutDetailResponse,
  FinancePlatformAffiliatePayoutLine,
  FinancePlatformAffiliatePayoutRepository,
  FinancePlatformAffiliatePayoutSummary,
} from "@vayada/domain-finance";
import type { QueryResult, QueryResultRow } from "pg";

export type FinancePlatformAffiliatePayoutClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};

export type FinancePlatformAffiliatePayoutPool = Omit<
  FinancePlatformAffiliatePayoutClient,
  "release"
> & {
  connect(): Promise<FinancePlatformAffiliatePayoutClient>;
};

type SummaryRow = FinancePlatformAffiliatePayoutSummary & { total: string | number };

type EvidenceRow = Omit<FinanceAffiliatePayoutPaymentEvidence, "payoutIds"> & {
  payoutIds: string[];
};

const AFFILIATE_PAYOUT_FACTS = `
  WITH payout_facts AS (
    SELECT
      affiliation.affiliate_id,
      CASE WHEN organization.status = 'active' AND EXISTS (
        SELECT 1
        FROM identity.organization_resource_links link
        WHERE link.organization_id = payout.organization_id
          AND link.product = 'affiliate'
          AND link.resource_type = 'affiliate'
          AND link.resource_id = affiliation.affiliate_id
          AND link.status = 'active'
      ) THEN 'active' ELSE 'inactive' END AS affiliate_lifecycle_status,
      payout.*,
      CASE COALESCE(account.provider, settings.payout_method, 'manual')
        WHEN 'bank' THEN 'bank_transfer'
        WHEN 'bank_account' THEN 'bank_transfer'
        ELSE COALESCE(account.provider, settings.payout_method, 'manual')
      END AS payout_method,
      evidence_item.evidence_id
    FROM finance.payouts payout
    JOIN identity.organizations organization
      ON organization.id = payout.organization_id
     AND organization.kind = 'affiliate_partner'
    LEFT JOIN finance.payout_settings settings
      ON settings.id = payout.payout_setting_id
     AND settings.organization_id = payout.organization_id
     AND settings.owner_scope = 'organization'
    LEFT JOIN finance.payment_provider_accounts account
      ON account.id = payout.organization_provider_account_id
     AND account.organization_id = payout.organization_id
     AND account.account_scope = 'organization'
    LEFT JOIN finance.affiliate_payout_payment_evidence_items evidence_item
      ON evidence_item.payout_id = payout.id
     AND evidence_item.organization_id = payout.organization_id
    LEFT JOIN finance.affiliate_payout_payment_evidence evidence
      ON evidence.id = evidence_item.evidence_id
     AND evidence.organization_id = evidence_item.organization_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        evidence.affiliate_id,
        payout.payout_metadata ->> 'affiliateId',
        payout.payout_metadata ->> 'affiliate_id',
        settings.payout_preferences ->> 'affiliateId',
        settings.payout_preferences ->> 'affiliate_id',
        payout.payout_metadata ->> 'resourceId'
      ) AS affiliate_id
    ) affiliation
    WHERE payout.owner_scope = 'organization'
      AND affiliation.affiliate_id IS NOT NULL
  )`;

export function createFinancePlatformAffiliatePayoutReadRepository(
  pool: FinancePlatformAffiliatePayoutPool,
): Pick<
  FinancePlatformAffiliatePayoutRepository,
  "listPlatformAffiliatePayoutSummaries" | "getPlatformAffiliatePayoutDetail"
> {
  return {
    async listPlatformAffiliatePayoutSummaries(query) {
      const result = await pool.query<SummaryRow>(
        `${AFFILIATE_PAYOUT_FACTS}, summaries AS (
           SELECT
             affiliate_id AS "affiliateId",
             organization_id::text AS "organizationId",
             MIN(affiliate_lifecycle_status) AS "affiliateLifecycleStatus",
             currency,
             CASE COUNT(DISTINCT payout_method)
               WHEN 1 THEN MIN(payout_method)
               ELSE 'mixed'
             END AS "payoutMethod",
             COALESCE(SUM(amount) FILTER (
               WHERE payout_status IN ('pending', 'scheduled', 'processing', 'failed')
             ), 0)::text AS "outstandingAmount",
             COALESCE(SUM(amount) FILTER (
               WHERE payout_status IN ('pending', 'scheduled')
                 AND provider_payout_id IS NULL
                 AND payout_method IN ('manual', 'bank_transfer')
             ), 0)::text AS "payableAmount",
             COALESCE(SUM(amount) FILTER (WHERE payout_status = 'paid'), 0)::text AS "paidAmount",
             COUNT(*)::int AS "payoutCount",
             COUNT(*) FILTER (
               WHERE payout_status IN ('pending', 'scheduled')
                 AND provider_payout_id IS NULL
                 AND payout_method IN ('manual', 'bank_transfer')
             )::int AS "payableCount",
             MAX(paid_at) FILTER (WHERE payout_status = 'paid') AS "lastPaidAt"
           FROM payout_facts
           GROUP BY affiliate_id, organization_id, currency
         )
         SELECT summaries.*, COUNT(*) OVER () AS total
         FROM summaries
         ORDER BY "affiliateId", currency, "payoutMethod"
         LIMIT $1 OFFSET $2`,
        [query.limit, query.offset],
      );
      const total =
        result.rows.length > 0
          ? Number(result.rows[0]!.total)
          : query.offset > 0
            ? await countSummaries(pool)
            : 0;
      return {
        summaries: result.rows.map(toSummary),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    async getPlatformAffiliatePayoutDetail(affiliateId, currency) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const summaries = await client.query<SummaryRow>(
          `${AFFILIATE_PAYOUT_FACTS}
         SELECT
           affiliate_id AS "affiliateId",
           organization_id::text AS "organizationId",
           MIN(affiliate_lifecycle_status) AS "affiliateLifecycleStatus",
           currency,
           CASE COUNT(DISTINCT payout_method)
             WHEN 1 THEN MIN(payout_method)
             ELSE 'mixed'
           END AS "payoutMethod",
           COALESCE(SUM(amount) FILTER (
             WHERE payout_status IN ('pending', 'scheduled', 'processing', 'failed')
           ), 0)::text AS "outstandingAmount",
           COALESCE(SUM(amount) FILTER (
             WHERE payout_status IN ('pending', 'scheduled')
               AND provider_payout_id IS NULL
               AND payout_method IN ('manual', 'bank_transfer')
           ), 0)::text AS "payableAmount",
           COALESCE(SUM(amount) FILTER (WHERE payout_status = 'paid'), 0)::text AS "paidAmount",
           COUNT(*)::int AS "payoutCount",
           COUNT(*) FILTER (
             WHERE payout_status IN ('pending', 'scheduled')
               AND provider_payout_id IS NULL
               AND payout_method IN ('manual', 'bank_transfer')
           )::int AS "payableCount",
           MAX(paid_at) FILTER (WHERE payout_status = 'paid') AS "lastPaidAt",
           1 AS total
         FROM payout_facts
         WHERE affiliate_id = $1 AND currency = $2
         GROUP BY affiliate_id, organization_id, currency
         LIMIT 1`,
          [affiliateId, currency],
        );
        const summary = summaries.rows[0];
        if (!summary) {
          await client.query("COMMIT");
          return null;
        }

        const payouts = await loadPayoutLines(
          client,
          affiliateId,
          summary.organizationId,
          currency,
        );
        const history = await loadEvidenceHistory(
          client,
          affiliateId,
          summary.organizationId,
          currency,
        );
        await client.query("COMMIT");
        return { summary: toSummary(summary), payouts, history };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function countSummaries(pool: FinancePlatformAffiliatePayoutPool): Promise<number> {
  const result = await pool.query<{ total: string | number }>(
    `${AFFILIATE_PAYOUT_FACTS}
     SELECT COUNT(*) AS total
     FROM (
       SELECT 1
       FROM payout_facts
       GROUP BY affiliate_id, organization_id, currency
     ) summaries`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function loadPayoutLines(
  pool: Pick<FinancePlatformAffiliatePayoutClient, "query">,
  affiliateId: string,
  organizationId: string,
  currency: string,
): Promise<FinancePlatformAffiliatePayoutLine[]> {
  const result = await pool.query<FinancePlatformAffiliatePayoutLine>(
    `${AFFILIATE_PAYOUT_FACTS}
     SELECT
       id::text AS "payoutId",
       related_property_id::text AS "relatedPropertyId",
       guest_booking_id::text AS "guestBookingId",
       payout_status AS "payoutStatus",
       amount::text,
       fee_amount::text AS "feeAmount",
       net_amount::text AS "netAmount",
       currency,
       payout_method AS "payoutMethod",
       provider_payout_id AS "providerPayoutId",
       scheduled_at AS "scheduledAt",
       paid_at AS "paidAt",
       failed_at AS "failedAt",
       failure_code AS "failureCode",
       retry_count AS "retryCount",
       (
         payout_status IN ('pending', 'scheduled')
         AND provider_payout_id IS NULL
         AND payout_method IN ('manual', 'bank_transfer')
       ) AS "manualMarkPaidEligible",
       evidence_id::text AS "paymentEvidenceId"
     FROM payout_facts
     WHERE affiliate_id = $1
       AND organization_id = $2::uuid
       AND currency = $3
     ORDER BY COALESCE(scheduled_at, created_at) DESC, id DESC`,
    [affiliateId, organizationId, currency],
  );
  return result.rows.map((row) => ({
    ...row,
    scheduledAt: instant(row.scheduledAt),
    paidAt: instant(row.paidAt),
    failedAt: instant(row.failedAt),
  }));
}

async function loadEvidenceHistory(
  pool: Pick<FinancePlatformAffiliatePayoutClient, "query">,
  affiliateId: string,
  organizationId: string,
  currency: string,
): Promise<FinanceAffiliatePayoutPaymentEvidence[]> {
  const result = await pool.query<EvidenceRow>(
    `SELECT
       evidence.id::text AS "evidenceId",
       evidence.affiliate_id AS "affiliateId",
       evidence.organization_id::text AS "organizationId",
       ARRAY_AGG(item.payout_id::text ORDER BY item.payout_id) AS "payoutIds",
       evidence.amount::text,
       evidence.currency,
       evidence.payment_method AS "paymentMethod",
       evidence.external_reference AS "externalReference",
       evidence.evidence_reference AS "evidenceReference",
       evidence.note,
       evidence.paid_at AS "paidAt",
       evidence.recorded_at AS "recordedAt"
     FROM finance.affiliate_payout_payment_evidence evidence
     JOIN finance.affiliate_payout_payment_evidence_items item
       ON item.evidence_id = evidence.id
      AND item.organization_id = evidence.organization_id
     WHERE evidence.affiliate_id = $1
       AND evidence.organization_id = $2::uuid
       AND evidence.currency = $3
     GROUP BY evidence.id
     ORDER BY evidence.paid_at DESC, evidence.id DESC`,
    [affiliateId, organizationId, currency],
  );
  return result.rows.map((row) => ({
    ...row,
    paidAt: instant(row.paidAt)!,
    recordedAt: instant(row.recordedAt)!,
  }));
}

function toSummary(row: SummaryRow): FinancePlatformAffiliatePayoutSummary {
  return {
    affiliateId: row.affiliateId,
    organizationId: row.organizationId,
    affiliateLifecycleStatus: row.affiliateLifecycleStatus,
    currency: row.currency,
    payoutMethod: row.payoutMethod,
    outstandingAmount: row.outstandingAmount,
    payableAmount: row.payableAmount,
    paidAmount: row.paidAmount,
    payoutCount: Number(row.payoutCount),
    payableCount: Number(row.payableCount),
    lastPaidAt: instant(row.lastPaidAt),
  };
}

function instant(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}
