import type pg from "pg";

import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";
import { PRODUCTION_FINANCE_TABLES } from "./productionFinanceTables.js";
import type {
  ExistingFinanceTargetRecord,
  FinanceTargetRecord,
  ProductionFinancePrerequisites,
  ProductionFinanceTargetState,
} from "./productionFinanceTypes.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function readProductionFinancePrerequisites(
  client: QueryClient,
  sourceRunId: string,
): Promise<ProductionFinancePrerequisites> {
  const propertyLinks = await client.query<ProductionFinancePrerequisites["propertyLinks"][number]>(
    `SELECT source_system AS "sourceSystem", source_table AS "sourceTable", source_id AS "sourceId",
            property_id::text AS "propertyId", relationship, status,
            metadata ->> 'migrationRunId' AS "migrationRunId"
     FROM hotel_catalog.property_source_links
     WHERE ((source_system = 'booking' AND source_table = 'booking_hotels')
         OR (source_system = 'pms' AND source_table = 'hotels'))
       AND metadata ->> 'migrationRunId' = $1
     ORDER BY source_system, source_table, source_id, property_id`,
    [sourceRunId],
  );
  const resourceLinks = await client.query<ProductionFinancePrerequisites["resourceLinks"][number]>(
    `SELECT organization_id::text AS "organizationId", product, resource_type AS "resourceType",
            resource_id AS "resourceId", relationship, status
     FROM identity.organization_resource_links
     WHERE (product = 'booking' AND resource_type = 'booking_hotel')
        OR (product = 'pms' AND resource_type = 'pms_hotel')
        OR (product = 'affiliate' AND resource_type = 'affiliate')
     ORDER BY product, resource_type, resource_id, organization_id`,
  );
  const guestBookings = await client.query<ProductionFinancePrerequisites["guestBookings"][number]>(
    `SELECT id::text, property_id::text AS "propertyId", source_booking_id AS "sourceBookingId", currency
     FROM booking.guest_bookings
     WHERE source_system = 'pms' AND source_booking_id IS NOT NULL
     ORDER BY source_booking_id, id`,
  );
  const users = await client.query<{ id: string }>(
    `SELECT id::text FROM identity.users ORDER BY id`,
  );
  return {
    propertyLinks: propertyLinks.rows,
    resourceLinks: resourceLinks.rows,
    guestBookings: guestBookings.rows,
    userIds: users.rows.map((row) => row.id),
  };
}

export async function readProductionFinanceTargetState(
  client: QueryClient,
  candidates: FinanceTargetRecord[],
  prerequisites: ProductionFinancePrerequisites,
): Promise<ProductionFinanceTargetState> {
  const records: ExistingFinanceTargetRecord[] = [];
  const grouped = new Map<string, string[]>();
  for (const candidate of candidates) {
    const ids = grouped.get(candidate.targetTable);
    if (ids) ids.push(candidate.targetId);
    else grouped.set(candidate.targetTable, [candidate.targetId]);
  }
  for (const [targetTable, ids] of grouped) {
    const definition = PRODUCTION_FINANCE_TABLES[targetTable];
    if (!definition) throw new Error(`Unsupported Finance target table ${targetTable}`);
    const primary = `${definition.key[0]}::text`;
    const result = await client.query<{ targetId: string; updatedAt: string; rowData: string }>(
      `SELECT ${primary} AS "targetId", (${definition.freshness})::text AS "updatedAt", to_jsonb(target_row)::text AS "rowData"
       FROM ${definition.table} AS target_row WHERE ${primary} = ANY($1::text[]) ORDER BY ${primary}`,
      [[...new Set(ids)]],
    );
    records.push(
      ...result.rows.map((row) => ({
        targetProduct: "finance" as const,
        targetTable,
        targetId: row.targetId,
        updatedAt: requiredTimestamp(row.updatedAt, `${definition.table}.${definition.freshness}`),
        row: camelize(JSON.parse(row.rowData) as Record<string, unknown>),
      })),
    );
  }
  const requested = new Set(candidates.map(provenanceIdentity));
  const cohort = await client.query<ProductionMigrationSourceLink>(
    `SELECT source_database AS "sourceDatabase", source_table AS "sourceTable", source_id AS "sourceId",
            target_product AS "targetProduct", target_table AS "targetTable", target_id AS "targetId",
            source_checksum AS "sourceChecksum", source_updated_at::text AS "sourceUpdatedAt",
            last_migrated_at::text AS "lastMigratedAt"
     FROM platform.production_migration_source_links
     WHERE source_database = ANY($1::text[]) AND target_product = 'finance' AND target_table = ANY($2::text[])
     ORDER BY source_database, source_table, source_id, target_table, target_id`,
    [["booking", "pms"], Object.keys(PRODUCTION_FINANCE_TABLES)],
  );
  const normalized = cohort.rows.map((row) => ({
    ...row,
    sourceUpdatedAt: normalizeTimestamp(row.sourceUpdatedAt, "source_updated_at"),
    lastMigratedAt: requiredTimestamp(row.lastMigratedAt, "last_migrated_at"),
  }));
  const provenance = normalized.filter((row) => requested.has(provenanceIdentity(row)));
  const stale = normalized.filter((row) => !requested.has(provenanceIdentity(row)));
  return {
    ...prerequisites,
    records,
    provenance,
    blockers: [
      ...(await readFinanceCollisions(client, candidates)),
      ...(await readStaleFinanceTargets(client, stale)),
    ],
  };
}

async function readStaleFinanceTargets(
  client: QueryClient,
  stale: ProductionMigrationSourceLink[],
): Promise<IdentityMigrationBlocker[]> {
  const blockers: IdentityMigrationBlocker[] = [];
  const grouped = new Map<string, ProductionMigrationSourceLink[]>();
  for (const link of stale) {
    if (!PRODUCTION_FINANCE_TABLES[link.targetTable]) continue;
    const rows = grouped.get(link.targetTable);
    if (rows) rows.push(link);
    else grouped.set(link.targetTable, [link]);
  }
  for (const [targetTable, links] of grouped) {
    const definition = PRODUCTION_FINANCE_TABLES[targetTable]!;
    const primary = `${definition.key[0]}::text`;
    const result = await client.query<{ targetId: string }>(
      `SELECT ${primary} AS "targetId" FROM ${definition.table} WHERE ${primary} = ANY($1::text[]) ORDER BY ${primary}`,
      [[...new Set(links.map((link) => link.targetId))]],
    );
    const active = new Set(result.rows.map((row) => row.targetId));
    for (const link of links)
      if (active.has(link.targetId))
        blockers.push({
          code: "SOURCE_ABSENT_MIGRATED_FINANCE_TARGET",
          source: `${link.sourceDatabase}.${link.sourceTable}`,
          sourceId: link.sourceId,
          message: `finance.${link.targetTable} ${link.targetId} remains active but its immutable source row is absent`,
        });
  }
  return blockers;
}

async function readFinanceCollisions(
  client: QueryClient,
  candidates: FinanceTargetRecord[],
): Promise<IdentityMigrationBlocker[]> {
  if (!candidates.length) return [];
  const rows = candidates.map((candidate) => ({
    targetTable: candidate.targetTable,
    targetId: candidate.targetId,
    ...candidate.row,
  }));
  const result = await client.query<IdentityMigrationBlocker>(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS source(
         "targetTable" text, "targetId" text, "sourceSystem" text,
         "sourceSettingsId" text, "sourcePaymentId" text, "sourcePayoutId" text,
         "sourceRuleId" text, "sourceEntitlementId" text,
         "provider" text, "providerAccountId" text, "providerTransactionId" text,
         "providerPaymentIntentId" text,
         "propertyProviderAccountId" uuid, "organizationProviderAccountId" uuid,
         "providerPayoutId" text, "organizationId" uuid, "propertyId" uuid,
         "product" text, "entitlementKey" text, "checkoutSessionRef" text,
         "billingSubscriptionRef" text
       )
     )
     SELECT 'TARGET_UNIQUE_CONFLICT' AS code, 'finance.payment_provider_accounts' AS source,
            target.id::text AS "sourceId", 'Another provider account owns this external provider identity' AS message
       FROM requested JOIN finance.payment_provider_accounts target
         ON requested."targetTable" = 'payment_provider_accounts'
        AND target.id::text <> requested."targetId"
        AND target.provider = requested."provider" AND target.provider_account_id = requested."providerAccountId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'finance.payment_settings', target.property_id::text,
            'Another payment setting row owns this source identity'
       FROM requested JOIN finance.payment_settings target
         ON requested."targetTable" = 'payment_settings' AND target.property_id::text <> requested."targetId"
        AND target.source_system = requested."sourceSystem" AND target.source_settings_id = requested."sourceSettingsId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'finance.payout_settings', target.id::text,
            'Another payout setting owns this source identity'
       FROM requested JOIN finance.payout_settings target
         ON requested."targetTable" = 'payout_settings' AND target.id::text <> requested."targetId"
        AND target.source_system = requested."sourceSystem" AND target.source_settings_id = requested."sourceSettingsId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'finance.payments', target.id::text,
            'Another payment owns this source or provider transaction identity'
       FROM requested JOIN finance.payments target
         ON requested."targetTable" = 'payments' AND target.id::text <> requested."targetId"
        AND ((target.source_system = requested."sourceSystem" AND target.source_payment_id = requested."sourcePaymentId")
          OR (requested."providerAccountId" IS NOT NULL AND requested."providerTransactionId" IS NOT NULL
              AND target.provider_account_id::text = requested."providerAccountId" AND target.provider_transaction_id = requested."providerTransactionId"))
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'finance.payments', target.id::text,
            'Another payment owns this provider PaymentIntent identity'
       FROM requested JOIN finance.payments target
         ON requested."targetTable" = 'payments' AND target.id::text <> requested."targetId"
        AND requested."providerPaymentIntentId" IS NOT NULL
        AND target.provider_payment_intent_id = requested."providerPaymentIntentId"
     UNION ALL
     SELECT 'QUARANTINED_STRIPE_PROVIDER_ACCOUNT',
            'finance.stripe_provider_account_compensation_claims', claim.provider_account_id,
            'Stripe provider account has a compensation claim and cannot be migrated'
       FROM requested JOIN finance.stripe_provider_account_compensation_claims claim
         ON requested."targetTable" = 'payment_provider_accounts'
        AND requested."provider" = 'stripe'
        AND claim.provider_account_id = requested."providerAccountId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'finance.payouts', target.id::text,
            'Another payout owns this source or provider payout identity'
       FROM requested JOIN finance.payouts target
         ON requested."targetTable" = 'payouts' AND target.id::text <> requested."targetId"
        AND ((target.source_system = requested."sourceSystem" AND target.source_payout_id = requested."sourcePayoutId")
          OR (requested."providerPayoutId" IS NOT NULL AND target.provider_payout_id = requested."providerPayoutId"
              AND (target.property_provider_account_id = requested."propertyProviderAccountId"
                OR target.organization_provider_account_id = requested."organizationProviderAccountId")))
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'finance.commission_rules', target.id::text,
            'Another commission rule owns this source identity'
       FROM requested JOIN finance.commission_rules target
         ON requested."targetTable" = 'commission_rules' AND target.id::text <> requested."targetId"
        AND target.source_system = requested."sourceSystem" AND target.source_rule_id = requested."sourceRuleId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'finance.billing_entitlements', target.id::text,
            'Another billing entitlement owns this source or billing scope'
       FROM requested JOIN finance.billing_entitlements target
         ON requested."targetTable" = 'billing_entitlements' AND target.id::text <> requested."targetId"
        AND ((target.source_system = requested."sourceSystem" AND target.source_entitlement_id = requested."sourceEntitlementId")
          OR (target.organization_id = requested."organizationId" AND target.product = requested."product"
              AND target.entitlement_key = requested."entitlementKey"
              AND COALESCE(target.property_id::text, '') = COALESCE(requested."propertyId"::text, ''))
          OR (requested."checkoutSessionRef" IS NOT NULL
              AND target.checkout_session_ref = requested."checkoutSessionRef")
          OR (requested."billingSubscriptionRef" IS NOT NULL
              AND target.billing_subscription_ref = requested."billingSubscriptionRef"))
     ORDER BY source, "sourceId"`,
    [JSON.stringify(rows)],
  );
  return result.rows;
}

function provenanceIdentity(value: {
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  targetProduct: string;
  targetTable: string;
  targetId: string;
}): string {
  return [
    value.sourceDatabase,
    value.sourceTable,
    value.sourceId,
    value.targetProduct,
    value.targetTable,
    value.targetId,
  ].join(":");
}

function normalizeTimestamp(value: string | null | undefined, field: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${field} timestamp: ${value}`);
  return new Date(timestamp).toISOString();
}

function requiredTimestamp(value: string | null | undefined, field: string): string {
  const result = normalizeTimestamp(value, field);
  if (!result) throw new Error(`Missing required ${field} timestamp`);
  return result;
}

function camelize(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()),
      entry,
    ]),
  );
}
