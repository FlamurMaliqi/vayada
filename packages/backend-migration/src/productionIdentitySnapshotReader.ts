import { createHash } from "node:crypto";
import type pg from "pg";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { RETIRED_AUTH_TABLES } from "./productionIdentityConsentSource.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type SourceDatabase = IdentitySourceRow["sourceDatabase"];
type SourceEvidence = {
  sourceDatabase: SourceDatabase;
  snapshotIdentifier: string;
  expectedFingerprint: string;
  actualFingerprint: string | null;
  status: string;
  rowCount: string | null;
  checksum: string | null;
};
type TableEvidence = {
  sourceDatabase: SourceDatabase;
  sourceSchema: string;
  sourceTable: string;
  status: string;
  rowCount: string | null;
  checksum: string | null;
};

export const PRODUCTION_IDENTITY_SOURCE_TABLES: Record<SourceDatabase, readonly string[]> = {
  auth: ["users", "cookie_consent", "consent_history", "gdpr_requests", "login_audit_log"],
  booking: ["booking_hotels"],
  marketplace: ["creators", "hotel_profiles"],
  pms: ["affiliates", "hotels", "property_module_activations"],
};
export const VAY_1350_ACTIVE_SOURCE_TABLES: Record<SourceDatabase, readonly string[]> = {
  auth: [
    "public.schema_migrations",
    "public.consent_history",
    "public.cookie_consent",
    "public.email_change_tokens",
    "public.email_verification_codes",
    "public.email_verification_tokens",
    "public.gdpr_requests",
    "public.login_audit_log",
    "public.login_rate_limit",
    "public.password_reset_tokens",
    "public.totp_recovery_codes",
    "public.totp_secrets",
    "public.users",
  ],
  booking: [
    "public.schema_migrations",
    "public.booking_addons",
    "public.booking_events",
    "public.booking_hotel_translations",
    "public.booking_hotels",
    "public.booking_promo_codes",
    "public.booking_promo_redemptions",
    "public.commission_rate_changes",
  ],
  marketplace: [
    "public.schema_migrations",
    "public.chat_messages",
    "public.collaboration_deliverables",
    "public.collaborations",
    "public.creator_platforms",
    "public.creator_ratings",
    "public.creators",
    "public.external_collaborations",
    "public.hotel_listings",
    "public.hotel_profiles",
    "public.invite_codes",
    "public.listing_collaboration_offerings",
    "public.listing_creator_requirements",
    "public.newsletter_preferences",
    "public.notifications",
    "public.trips",
  ],
  pms: [
    "public.schema_migrations",
    "public.affiliate_clicks",
    "public.affiliate_payout_settings",
    "public.affiliates",
    "public.booking_additional_guests",
    "public.booking_change_requests",
    "public.booking_checkin_records",
    "public.booking_checkout_charges",
    "public.booking_checkout_records",
    "public.booking_drafts",
    "public.booking_events",
    "public.booking_notes",
    "public.booking_notification_deliveries",
    "public.booking_promo_usage_state",
    "public.booking_rooms",
    "public.bookings",
    "public.cancellation_policies",
    "public.channex_booking_mappings",
    "public.channex_channel_markups",
    "public.channex_connections",
    "public.channex_rate_plan_mappings",
    "public.channex_room_type_mappings",
    "public.channex_webhook_events",
    "public.checkin_checklist_templates",
    "public.checkout_inspection_templates",
    "public.hotel_payment_settings",
    "public.hotels",
    "public.message_attachments",
    "public.message_threads",
    "public.messages",
    "public.payments",
    "public.payouts",
    "public.property_module_activations",
    "public.room_blocks",
    "public.room_types",
    "public.rooms",
    "public.stripe_billing_webhook_events",
    "platform.media_objects",
    "platform.media_variants",
  ],
};

export async function readProductionIdentitySnapshot(
  client: QueryClient,
  runId: string,
): Promise<IdentitySourceRow[]> {
  if (!/^vay1351-[0-9a-f]{24}$/.test(runId))
    throw new Error("sourceRunId must be an immutable VAY-1351 extraction run ID");
  const run = await client.query<{ status: string; revision: string }>(
    `SELECT status, source_schema_revision AS revision
     FROM platform.source_extraction_runs WHERE run_id = $1`,
    [runId],
  );
  if (run.rows.length !== 1 || run.rows[0]?.status !== "completed")
    throw new Error(`Source extraction ${runId} is not completed`);
  if (run.rows[0]!.revision !== VAY_1350_INVENTORY_REVISION)
    throw new Error(`Source extraction ${runId} uses an unsupported schema revision`);

  const sourceResult = await client.query<SourceEvidence>(
    `SELECT source_database AS "sourceDatabase", snapshot_identifier AS "snapshotIdentifier",
            expected_schema_fingerprint AS "expectedFingerprint",
            actual_schema_fingerprint AS "actualFingerprint", status,
            row_count::text AS "rowCount", checksum_sha256 AS checksum
     FROM platform.source_extraction_sources WHERE run_id = $1 ORDER BY source_database`,
    [runId],
  );
  const sources = new Map(sourceResult.rows.map((row) => [row.sourceDatabase, row]));
  for (const database of databases()) {
    const source = sources.get(database);
    if (
      !source ||
      source.status !== "completed" ||
      !source.snapshotIdentifier ||
      source.actualFingerprint !== source.expectedFingerprint ||
      !count(source.rowCount) ||
      !sha256(source.checksum)
    )
      throw new Error(`Source extraction ${runId} has incomplete ${database} evidence`);
  }
  if (sources.size !== databases().length)
    throw new Error(`Source extraction ${runId} does not contain exactly four sources`);

  const tableResult = await client.query<TableEvidence>(
    `SELECT source_database AS "sourceDatabase", source_schema AS "sourceSchema",
            source_table AS "sourceTable", status,
            row_count::text AS "rowCount", checksum_sha256 AS checksum
     FROM platform.source_extraction_tables
     WHERE run_id = $1 ORDER BY source_database, source_schema, source_table`,
    [runId],
  );
  const evidence = new Map(
    tableResult.rows.map((row) => [
      `${row.sourceDatabase}:${row.sourceSchema}.${row.sourceTable}`,
      row,
    ]),
  );
  for (const database of databases()) {
    const aggregate = createHash("sha256");
    let aggregateCount = 0;
    for (const qualifiedTable of VAY_1350_ACTIVE_SOURCE_TABLES[database]) {
      const ledger = evidence.get(`${database}:${qualifiedTable}`);
      if (ledger?.status !== "completed" || !count(ledger.rowCount) || !sha256(ledger.checksum))
        throw new Error(
          `Source extraction ${runId} has incomplete ${database}.${qualifiedTable} ledger`,
        );
      aggregateCount += Number(ledger.rowCount);
      aggregate.update(`${qualifiedTable}|${ledger.rowCount}|${ledger.checksum}\n`);
    }
    const source = sources.get(database)!;
    if (aggregateCount !== Number(source.rowCount) || aggregate.digest("hex") !== source.checksum)
      throw new Error(`Source extraction ${runId} mismatches ${database} source aggregate`);
  }
  if (evidence.size !== Object.values(VAY_1350_ACTIVE_SOURCE_TABLES).flat().length)
    throw new Error(`Source extraction ${runId} has an unexpected table ledger set`);
  const retiredResult = await client.query<{
    sourceTable: string;
    rowCount: string;
    snapshotMatches: boolean;
    ordinalsValid: boolean;
    rowsValid: boolean;
    tableChecksum: string;
  }>(
    `SELECT source_table AS "sourceTable", count(*)::text AS "rowCount",
            bool_and(snapshot_identifier = $3) AS "snapshotMatches",
            min(row_ordinal) = 1 AND max(row_ordinal) = count(*) AS "ordinalsValid",
            bool_and(row_checksum_sha256 = encode(sha256(convert_to(row_data::text, 'UTF8')), 'hex'))
              AS "rowsValid",
            encode(sha256(convert_to(
              string_agg(row_checksum_sha256 || E'\\n', '' ORDER BY row_ordinal),
              'UTF8'
            )), 'hex') AS "tableChecksum"
     FROM migration_source_auth.snapshot_rows
     WHERE run_id = $1 AND source_schema = 'public' AND source_table = ANY($2::text[])
     GROUP BY source_table ORDER BY source_table`,
    [runId, RETIRED_AUTH_TABLES, sources.get("auth")!.snapshotIdentifier],
  );
  const retiredCounts = new Map(retiredResult.rows.map((row) => [row.sourceTable, row]));
  for (const table of RETIRED_AUTH_TABLES) {
    const actual = retiredCounts.get(table);
    const expected = evidence.get(`auth:public.${table}`)!;
    const expectedCount = Number(expected.rowCount);
    if (
      Number(actual?.rowCount ?? 0) !== expectedCount ||
      (expectedCount === 0 && expected.checksum !== createHash("sha256").digest("hex")) ||
      (actual !== undefined &&
        (actual.snapshotMatches !== true ||
          actual.ordinalsValid !== true ||
          actual.rowsValid !== true ||
          actual.tableChecksum !== expected.checksum))
    )
      throw new Error(`Source extraction ${runId} mismatches count-only auth.${table}`);
  }

  const loaded: IdentitySourceRow[] = [];
  for (const database of databases()) {
    const tables = PRODUCTION_IDENTITY_SOURCE_TABLES[database];
    const snapshot = await client.query<{
      snapshotIdentifier: string;
      sourceTable: string;
      rowOrdinal: string;
      rowChecksum: string;
      rowData: string;
    }>(
      `SELECT snapshot_identifier AS "snapshotIdentifier", source_table AS "sourceTable",
              row_ordinal::text AS "rowOrdinal", row_checksum_sha256 AS "rowChecksum",
              row_data::text AS "rowData"
       FROM migration_source_${database}.snapshot_rows
       WHERE run_id = $1 AND source_schema = 'public' AND source_table = ANY($2::text[])
       ORDER BY source_table, row_ordinal`,
      [runId, tables],
    );
    const grouped = new Map(tables.map((table) => [table, [] as typeof snapshot.rows]));
    for (const row of snapshot.rows) grouped.get(row.sourceTable)?.push(row);
    for (const table of tables) {
      const ledger = evidence.get(`${database}:public.${table}`);
      if (ledger?.status !== "completed" || !count(ledger.rowCount) || !sha256(ledger.checksum))
        throw new Error(`Source extraction ${runId} has incomplete ${database}.${table} ledger`);
      const rows = grouped.get(table)!;
      const tableChecksum = createHash("sha256");
      for (const [index, row] of rows.entries()) {
        const expectedOrdinal = index + 1;
        const checksum = createHash("sha256").update(row.rowData).digest("hex");
        if (
          row.snapshotIdentifier !== sources.get(database)!.snapshotIdentifier ||
          Number(row.rowOrdinal) !== expectedOrdinal ||
          row.rowChecksum !== checksum
        )
          throw new Error(`Source extraction ${runId} has corrupt ${database}.${table} rows`);
        tableChecksum.update(`${checksum}\n`);
        const data: unknown = JSON.parse(row.rowData);
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error(`Source extraction ${runId} has invalid ${database}.${table} JSON`);
        loaded.push({
          sourceDatabase: database,
          sourceTable: table,
          rowOrdinal: expectedOrdinal,
          data: data as Record<string, unknown>,
        });
      }
      if (
        rows.length !== Number(ledger.rowCount) ||
        tableChecksum.digest("hex") !== ledger.checksum
      )
        throw new Error(`Source extraction ${runId} mismatches ${database}.${table} ledger`);
    }
  }
  for (const table of RETIRED_AUTH_TABLES) {
    const rowCountOnly = Number(retiredCounts.get(table)?.rowCount ?? 0);
    if (rowCountOnly > 0)
      loaded.push({
        sourceDatabase: "auth",
        sourceTable: table,
        rowOrdinal: 0,
        data: {},
        rowCountOnly,
      });
  }
  return loaded;
}

const databases = (): SourceDatabase[] => ["auth", "booking", "marketplace", "pms"];
const sha256 = (value: string | null): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function count(value: string | null): value is string {
  if (value === null || !/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
}
