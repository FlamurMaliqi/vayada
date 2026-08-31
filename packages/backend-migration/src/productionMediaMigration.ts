import { createHash } from "node:crypto";

import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import {
  buildProductionMediaPlan,
  type ProductionMediaPlan,
  type ProductionMediaReference,
} from "./productionMediaPlan.js";
import { readProductionMediaSnapshot } from "./productionMediaSnapshotReader.js";
import {
  createS3ProductionMediaStorage,
  ProductionMediaSourceError,
  type ImportedProductionMedia,
  type ProductionMediaStorage,
} from "./productionMediaStorage.js";
import { readProductionMediaTargetState } from "./productionMediaTargetReader.js";
import { stableJson } from "./productionBookingValues.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export const PRODUCTION_MEDIA_MIGRATION_LOCK_ID = 1_055_001;
export type ProductionMediaMigrationMode = "dry-run" | "apply";

export type ProductionMediaMigrationConfig = {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionMediaMigrationMode;
  targetBucket: string;
  cdnBaseUrl: string;
  allowedLegacyBuckets: string[];
  legacyPmsBucket: string;
  region?: string;
};

export type ProductionMediaMigrationReport = {
  sourceRunId: string;
  mode: ProductionMediaMigrationMode;
  applied: boolean;
  checksum: string;
  inventoryChecksumSha256: string;
  counts: ProductionMediaPlan["counts"] & {
    completed: number;
    missing: number;
    corrupt: number;
    failed: number;
  };
  blockers: IdentityMigrationBlocker[];
};

export type ProductionMediaMigrationServices = {
  readSnapshot: typeof readProductionMediaSnapshot;
  readTarget: typeof readProductionMediaTargetState;
  buildPlan: typeof buildProductionMediaPlan;
  storage: ProductionMediaStorage;
};

export async function runProductionMediaMigration(
  config: ProductionMediaMigrationConfig,
  services?: Partial<ProductionMediaMigrationServices>,
): Promise<ProductionMediaMigrationReport> {
  assertMode(config.mode);
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: 2,
  });
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [PRODUCTION_MEDIA_MIGRATION_LOCK_ID],
    );
    if (!lock.rows[0]?.acquired) throw new Error("Another production media migration is active");
    locked = true;
    const active: ProductionMediaMigrationServices = {
      readSnapshot: services?.readSnapshot ?? readProductionMediaSnapshot,
      readTarget: services?.readTarget ?? readProductionMediaTargetState,
      buildPlan: services?.buildPlan ?? buildProductionMediaPlan,
      storage:
        services?.storage ??
        createS3ProductionMediaStorage({
          targetBucket: config.targetBucket,
          cdnBaseUrl: config.cdnBaseUrl,
          allowedLegacyBuckets: config.allowedLegacyBuckets,
          region: config.region,
        }),
    };
    return await runWithClient(client, config, active);
  } finally {
    if (locked)
      await client
        .query("SELECT pg_advisory_unlock($1)", [PRODUCTION_MEDIA_MIGRATION_LOCK_ID])
        .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function runWithClient(
  client: QueryClient,
  config: ProductionMediaMigrationConfig,
  services: ProductionMediaMigrationServices,
): Promise<ProductionMediaMigrationReport> {
  const snapshot = await services.readSnapshot(client, config.sourceRunId);
  const target = await services.readTarget(client, config.sourceRunId);
  const plan = services.buildPlan({
    sourceRunId: config.sourceRunId,
    completedAt: snapshot.completedAt,
    rows: snapshot.rows,
    target,
    legacyPmsBucket: config.legacyPmsBucket,
    targetBucket: config.targetBucket,
    cdnBaseUrl: config.cdnBaseUrl,
  });
  if (config.mode === "dry-run") return dryRunReport(config, plan);

  const configSha256 = sha256({
    targetBucket: config.targetBucket,
    cdnBaseUrl: config.cdnBaseUrl,
    allowedLegacyBuckets: [...config.allowedLegacyBuckets].sort(),
    legacyPmsBucket: config.legacyPmsBucket,
    region: config.region ?? null,
  });
  await prepareRun(client, config.sourceRunId, plan, configSha256);
  if (plan.blockers.length === 0) {
    await markReused(client, config.sourceRunId, plan.reused);
    for (const reference of plan.pending) {
      await markProcessing(client, config.sourceRunId, reference);
      let imported: ImportedProductionMedia | undefined;
      try {
        imported = await services.storage.importReference(reference);
        await registerImported(client, config.sourceRunId, imported);
      } catch (error) {
        let failure = sourceFailure(error);
        if (imported && services.storage.discardImported)
          try {
            await services.storage.discardImported(imported);
          } catch {
            failure = { status: "failed", code: "TARGET_CLEANUP_FAILED" };
          }
        await recordFailure(client, config.sourceRunId, reference, failure);
      }
    }
  }

  const finalTarget = await services.readTarget(client, config.sourceRunId);
  const finalPlan = services.buildPlan({
    sourceRunId: config.sourceRunId,
    completedAt: snapshot.completedAt,
    rows: snapshot.rows,
    target: finalTarget,
    legacyPmsBucket: config.legacyPmsBucket,
    targetBucket: config.targetBucket,
    cdnBaseUrl: config.cdnBaseUrl,
  });
  const itemState = await readItemState(client, config.sourceRunId);
  const incomplete =
    finalPlan.references.length -
    itemState.completed -
    itemState.missing -
    itemState.corrupt -
    itemState.failed;
  const blockers = [
    ...finalPlan.blockers,
    ...itemState.failures.map((item) => ({
      code: `MEDIA_${item.errorCode ?? "FAILED"}`,
      source: `${item.sourceSystem}.${item.sourceTable}`,
      sourceId: item.sourceRowId,
      message: "Legacy media import did not complete; inspect the redacted migration item evidence",
    })),
    ...(incomplete === 0
      ? []
      : [
          {
            code: "MEDIA_ITEM_INCOMPLETE",
            source: "platform.production_media_migration_items",
            sourceId: config.sourceRunId,
            message: `${incomplete} planned media item(s) have no terminal evidence`,
          },
        ]),
  ].sort((left, right) =>
    `${left.code}:${left.source}:${left.sourceId}`.localeCompare(
      `${right.code}:${right.source}:${right.sourceId}`,
    ),
  );
  const counts = {
    ...finalPlan.counts,
    completed: itemState.completed,
    missing: itemState.missing,
    corrupt: itemState.corrupt,
    failed: itemState.failed,
  };
  const material = {
    sourceRunId: config.sourceRunId,
    inventoryChecksumSha256: finalPlan.inventoryChecksumSha256,
    counts,
    blockers,
  };
  const checksum = sha256(material);
  const applied = blockers.length === 0 && itemState.completed === finalPlan.references.length;
  await finishRun(client, config.sourceRunId, applied, counts, blockers.length, checksum);
  return {
    sourceRunId: config.sourceRunId,
    mode: config.mode,
    applied,
    checksum,
    inventoryChecksumSha256: finalPlan.inventoryChecksumSha256,
    counts,
    blockers,
  };
}

async function prepareRun(
  client: QueryClient,
  sourceRunId: string,
  plan: ProductionMediaPlan,
  configSha256: string,
): Promise<void> {
  await transaction(client, async () => {
    const current = await client.query<{ inventory: string; config: string }>(
      `SELECT inventory_sha256 AS inventory, config_sha256 AS config
         FROM platform.production_media_migration_runs
        WHERE source_run_id = $1 FOR UPDATE`,
      [sourceRunId],
    );
    if (
      current.rows[0] &&
      (current.rows[0].inventory !== plan.inventoryChecksumSha256 ||
        current.rows[0].config !== configSha256)
    )
      throw new Error("Existing media migration run uses different immutable inputs");
    await client.query(
      `INSERT INTO platform.production_media_migration_runs
         (source_run_id, inventory_sha256, config_sha256, status, planned_count, blocker_count)
       VALUES ($1,$2,$3,'running',$4,$5)
       ON CONFLICT (source_run_id) DO UPDATE SET
         status = 'running', planned_count = EXCLUDED.planned_count,
         blocker_count = EXCLUDED.blocker_count, report_checksum_sha256 = NULL,
         completed_at = NULL, updated_at = now()`,
      [
        sourceRunId,
        plan.inventoryChecksumSha256,
        configSha256,
        plan.references.length,
        plan.blockers.length,
      ],
    );
    for (const reference of plan.references) {
      const prepared = await client.query(
        `INSERT INTO platform.production_media_migration_items
           (source_run_id, source_system, source_table, source_row_id, purpose,
            source_field, source_url, source_updated_at, source_reference_sha256, item_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned')
         ON CONFLICT (source_run_id, source_system, source_table, source_row_id, purpose)
         DO UPDATE SET updated_at = now()
         WHERE platform.production_media_migration_items.source_reference_sha256 =
               EXCLUDED.source_reference_sha256`,
        item(reference, sourceRunId),
      );
      if (prepared.rowCount !== 1)
        throw new Error("Existing media migration item uses different immutable source evidence");
    }
  });
}

async function markReused(
  client: QueryClient,
  sourceRunId: string,
  references: ProductionMediaReference[],
): Promise<void> {
  for (const reference of references) {
    const reused = await client.query(
      `UPDATE platform.production_media_migration_items item
          SET media_object_id = media.id, item_status = 'completed',
              content_checksum_sha256 = COALESCE(item.content_checksum_sha256, media.checksum_sha256),
              size_bytes = COALESCE(item.size_bytes, media.size_bytes), error_code = NULL,
              evidence = jsonb_build_object('reused', true),
              completed_at = COALESCE(item.completed_at, now()), updated_at = now()
         FROM platform.media_objects media
        WHERE item.source_run_id = $1 AND item.source_system = $2
          AND item.source_table = $3 AND item.source_row_id = $4 AND item.purpose = $5
          AND media.id = $6 AND media.checksum_sha256 ~ '^[0-9a-f]{64}$'`,
      [
        sourceRunId,
        reference.sourceSystem,
        reference.sourceTable,
        reference.sourceRowId,
        reference.purpose,
        reference.mediaObjectId,
      ],
    );
    if (reused.rowCount !== 1) throw new Error("Reusable media object has incomplete evidence");
  }
}

async function markProcessing(
  client: QueryClient,
  sourceRunId: string,
  reference: ProductionMediaReference,
): Promise<void> {
  await client.query(
    `UPDATE platform.production_media_migration_items
        SET item_status = 'processing', attempt_count = attempt_count + 1,
            error_code = NULL, evidence = '{}'::jsonb, updated_at = now()
      WHERE source_run_id = $1 AND source_system = $2 AND source_table = $3
        AND source_row_id = $4 AND purpose = $5 AND item_status <> 'completed'`,
    [
      sourceRunId,
      reference.sourceSystem,
      reference.sourceTable,
      reference.sourceRowId,
      reference.purpose,
    ],
  );
}

async function registerImported(
  client: QueryClient,
  sourceRunId: string,
  imported: ImportedProductionMedia,
): Promise<void> {
  const reference = imported.reference;
  await transaction(client, async () => {
    const media = await client.query(
      `INSERT INTO platform.media_objects
         (id, bucket, storage_key, storage_kind, visibility, purpose,
          owner_organization_id, property_id, resource_product, resource_type, resource_id,
          lifecycle_status, content_type, size_bytes, checksum_sha256, width_px, height_px,
          original_filename, source_url, source_system, source_table, source_row_id,
          source_metadata, retained_until, public_approved, created_at, updated_at)
       VALUES ($1,$2,$3,'vayada_managed',$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$24)
       ON CONFLICT (source_system, source_table, source_row_id, purpose) DO NOTHING`,
      [
        reference.mediaObjectId,
        imported.bucket,
        imported.storageKey,
        reference.visibility,
        reference.purpose,
        reference.ownerOrganizationId,
        reference.propertyId,
        reference.resourceProduct,
        reference.resourceType,
        reference.resourceId,
        imported.contentType,
        imported.sizeBytes,
        imported.checksumSha256,
        imported.widthPx,
        imported.heightPx,
        reference.originalFilename,
        reference.sourceUrl,
        reference.sourceSystem,
        reference.sourceTable,
        reference.sourceRowId,
        JSON.stringify({
          migrationRunId: sourceRunId,
          migrationTicket: "VAY-1055",
          ...(reference.purpose === "marketplace.collaboration_chat.attachment"
            ? {
                migrationCase: "media-url-migration",
                retentionPolicy: "chat-message-created-at-plus-2-years",
              }
            : {}),
          sourceField: reference.sourceField,
          sourceReferenceSha256: reference.sourceReferenceSha256,
          sortOrder: reference.sortOrder,
        }),
        reference.retainedUntil,
        reference.publicApproved,
        reference.sourceUpdatedAt,
      ],
    );
    if (media.rowCount !== 1)
      throw new Error("Platform media source identity changed during import");
    for (const variant of imported.variants) {
      const written = await client.query(
        `INSERT INTO platform.media_variants
           (id, media_object_id, variant_name, visibility, storage_key, content_type,
            width_px, height_px, size_bytes, checksum_sha256, public_cdn_url, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          variant.id,
          variant.mediaObjectId,
          variant.variantName,
          variant.visibility,
          variant.storageKey,
          variant.contentType,
          variant.widthPx,
          variant.heightPx,
          variant.sizeBytes,
          variant.checksumSha256,
          variant.publicCdnUrl,
          reference.sourceUpdatedAt,
        ],
      );
      if (written.rowCount !== 1) throw new Error("Platform media variant registration failed");
    }
    const completed = await client.query(
      `UPDATE platform.production_media_migration_items
          SET media_object_id = $6, item_status = 'completed', error_code = NULL,
              content_checksum_sha256 = $7, size_bytes = $8,
              evidence = jsonb_build_object(
                'variantCount', $9::integer,
                'targetBucketSha256', $10::text
              ),
              completed_at = now(), updated_at = now()
        WHERE source_run_id = $1 AND source_system = $2 AND source_table = $3
          AND source_row_id = $4 AND purpose = $5 AND item_status = 'processing'`,
      [
        sourceRunId,
        reference.sourceSystem,
        reference.sourceTable,
        reference.sourceRowId,
        reference.purpose,
        reference.mediaObjectId,
        imported.sourceChecksumSha256,
        imported.sourceSizeBytes,
        imported.variants.length,
        sha256(imported.bucket),
      ],
    );
    if (completed.rowCount !== 1) throw new Error("Media migration item completion failed");
  });
}

async function recordFailure(
  client: QueryClient,
  sourceRunId: string,
  reference: ProductionMediaReference,
  failure: { status: "missing" | "corrupt" | "failed"; code: string },
): Promise<void> {
  await client.query(
    `UPDATE platform.production_media_migration_items
        SET item_status = $6, error_code = $7,
            evidence = jsonb_build_object('reviewRequired', true), updated_at = now()
      WHERE source_run_id = $1 AND source_system = $2 AND source_table = $3
        AND source_row_id = $4 AND purpose = $5 AND item_status <> 'completed'`,
    [
      sourceRunId,
      reference.sourceSystem,
      reference.sourceTable,
      reference.sourceRowId,
      reference.purpose,
      failure.status,
      failure.code,
    ],
  );
}

async function readItemState(
  client: QueryClient,
  sourceRunId: string,
): Promise<{
  completed: number;
  missing: number;
  corrupt: number;
  failed: number;
  failures: Array<{
    sourceSystem: string;
    sourceTable: string;
    sourceRowId: string;
    errorCode: string | null;
  }>;
}> {
  const counts = await client.query<{ status: string; count: string }>(
    `SELECT item_status AS status, count(*)::text AS count
       FROM platform.production_media_migration_items
      WHERE source_run_id = $1 GROUP BY item_status`,
    [sourceRunId],
  );
  const values = new Map(counts.rows.map((row) => [row.status, Number(row.count)]));
  const failures = await client.query<{
    sourceSystem: string;
    sourceTable: string;
    sourceRowId: string;
    errorCode: string | null;
  }>(
    `SELECT source_system AS "sourceSystem", source_table AS "sourceTable",
            source_row_id AS "sourceRowId", error_code AS "errorCode"
       FROM platform.production_media_migration_items
      WHERE source_run_id = $1 AND item_status IN ('missing', 'corrupt', 'failed')
      ORDER BY source_system, source_table, source_row_id, purpose`,
    [sourceRunId],
  );
  return {
    completed: values.get("completed") ?? 0,
    missing: values.get("missing") ?? 0,
    corrupt: values.get("corrupt") ?? 0,
    failed: values.get("failed") ?? 0,
    failures: failures.rows,
  };
}

async function finishRun(
  client: QueryClient,
  sourceRunId: string,
  applied: boolean,
  counts: ProductionMediaMigrationReport["counts"],
  blockerCount: number,
  checksum: string,
): Promise<void> {
  await client.query(
    `UPDATE platform.production_media_migration_runs
        SET status = $2, completed_count = $3, missing_count = $4,
            corrupt_count = $5, failed_count = $6, blocker_count = $7,
            report_checksum_sha256 = $8,
            completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE source_run_id = $1`,
    [
      sourceRunId,
      applied ? "completed" : "blocked",
      counts.completed,
      counts.missing,
      counts.corrupt,
      counts.failed,
      blockerCount,
      checksum,
    ],
  );
}

function dryRunReport(
  config: ProductionMediaMigrationConfig,
  plan: ProductionMediaPlan,
): ProductionMediaMigrationReport {
  const counts = {
    ...plan.counts,
    completed: plan.reused.length,
    missing: 0,
    corrupt: 0,
    failed: 0,
  };
  return {
    sourceRunId: config.sourceRunId,
    mode: config.mode,
    applied: false,
    checksum: sha256({
      sourceRunId: config.sourceRunId,
      inventoryChecksumSha256: plan.inventoryChecksumSha256,
      counts,
      blockers: plan.blockers,
    }),
    inventoryChecksumSha256: plan.inventoryChecksumSha256,
    counts,
    blockers: plan.blockers,
  };
}

function item(reference: ProductionMediaReference, sourceRunId: string): unknown[] {
  return [
    sourceRunId,
    reference.sourceSystem,
    reference.sourceTable,
    reference.sourceRowId,
    reference.purpose,
    reference.sourceField,
    reference.sourceUrl,
    reference.sourceUpdatedAt,
    reference.sourceReferenceSha256,
  ];
}

function sourceFailure(error: unknown): { status: "missing" | "corrupt" | "failed"; code: string } {
  if (error instanceof ProductionMediaSourceError)
    return {
      status:
        error.code === "SOURCE_MISSING"
          ? "missing"
          : error.code === "SOURCE_CORRUPT"
            ? "corrupt"
            : "failed",
      code: error.code,
    };
  if (error && typeof error === "object") {
    const databaseError = error as { code?: unknown; constraint?: unknown };
    const sqlState = safeEvidenceLabel(databaseError.code);
    const constraint = safeEvidenceLabel(databaseError.constraint);
    if (sqlState)
      return {
        status: "failed",
        code: ["TARGET_WRITE", sqlState, constraint].filter(Boolean).join(":"),
      };
  }
  return { status: "failed", code: "SOURCE_FAILED" };
}

function safeEvidenceLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
}

async function transaction(client: QueryClient, action: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await action();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertMode(mode: unknown): asserts mode is ProductionMediaMigrationMode {
  if (mode !== "dry-run" && mode !== "apply")
    throw new Error("Media migration mode must be dry-run or apply");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
