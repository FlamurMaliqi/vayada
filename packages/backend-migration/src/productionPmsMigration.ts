import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import { writeProductionMigrationProvenance } from "./productionBookingWriter.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import { readProductionPmsSnapshot } from "./productionPmsSnapshotReader.js";
import {
  readProductionPmsPrerequisites,
  readProductionPmsTargetState,
} from "./productionPmsTargetReader.js";
import type {
  PmsTargetRecord,
  ProductionPmsPlan,
  ProductionPmsTargetState,
} from "./productionPmsTypes.js";
import { writeProductionPmsRecords } from "./productionPmsWriter.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type ProductionPmsMigrationMode = "dry-run" | "apply";
export type ProductionPmsMigrationReport = {
  sourceRunId: string;
  mode: ProductionPmsMigrationMode;
  applied: boolean;
  checksum: string;
  counts: ProductionPmsPlan["counts"];
  parity: ProductionPmsPlan["parity"];
  blockers: ProductionPmsPlan["blockers"];
};
export type ProductionPmsMigrationServices = {
  readSnapshot: typeof readProductionPmsSnapshot;
  readPrerequisites: typeof readProductionPmsPrerequisites;
  readTarget: typeof readProductionPmsTargetState;
  buildPlan: typeof buildProductionPmsPlan;
  writeRecords: typeof writeProductionPmsRecords;
  writeProvenance: typeof writeProductionMigrationProvenance;
};

const productionServices: ProductionPmsMigrationServices = {
  readSnapshot: readProductionPmsSnapshot,
  readPrerequisites: readProductionPmsPrerequisites,
  readTarget: readProductionPmsTargetState,
  buildPlan: buildProductionPmsPlan,
  writeRecords: writeProductionPmsRecords,
  writeProvenance: writeProductionMigrationProvenance,
};

export async function runProductionPmsMigration(config: {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionPmsMigrationMode;
  max?: number;
}): Promise<ProductionPmsMigrationReport> {
  assertMode(config.mode);
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max ?? 1,
  });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return await runProductionPmsTransaction(client, config);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runProductionPmsTransaction(
  client: QueryClient,
  input: { sourceRunId: string; mode: ProductionPmsMigrationMode },
  services: ProductionPmsMigrationServices = productionServices,
): Promise<ProductionPmsMigrationReport> {
  assertMode(input.mode);
  let finished = false;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    if (input.mode === "apply") await lockPmsTargets(client);
    const snapshot = await services.readSnapshot(client, input.sourceRunId);
    const prerequisites = await services.readPrerequisites(client);
    const emptyTarget: ProductionPmsTargetState = {
      ...prerequisites,
      records: [],
      provenance: [],
    };
    const preliminary = services.buildPlan({
      sourceRunId: input.sourceRunId,
      completedAt: snapshot.completedAt,
      rows: snapshot.rows,
      target: emptyTarget,
    });
    const target = await services.readTarget(client, preliminary.records, prerequisites);
    const plan = services.buildPlan({
      sourceRunId: input.sourceRunId,
      completedAt: snapshot.completedAt,
      rows: snapshot.rows,
      target,
    });
    if (input.mode === "dry-run" || plan.blockers.length > 0) {
      await client.query("ROLLBACK");
      finished = true;
      return report(input, plan, false);
    }
    const written = await services.writeRecords(client, plan.writes);
    assertWriteCounts(plan.writes, written);
    const provenanceCount = await services.writeProvenance(
      client,
      plan.provenance,
      input.sourceRunId,
    );
    if (provenanceCount !== plan.provenance.length)
      throw new Error(
        `PMS provenance writer applied ${provenanceCount} of ${plan.provenance.length} planned rows`,
      );
    const verifiedTarget = await services.readTarget(client, plan.records, prerequisites);
    const verified = services.buildPlan({
      sourceRunId: input.sourceRunId,
      completedAt: snapshot.completedAt,
      rows: snapshot.rows,
      target: verifiedTarget,
    });
    if (
      verified.blockers.length > 0 ||
      verified.checksum !== plan.checksum ||
      verified.writes.length > 0
    )
      throw new Error("Post-write PMS verification does not match the migration plan");
    await client.query("COMMIT");
    finished = true;
    return report(input, plan, true);
  } catch (error) {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertWriteCounts(planned: PmsTargetRecord[], actual: Record<string, number>): void {
  const expected = new Map<string, number>();
  for (const row of planned)
    expected.set(row.targetTable, (expected.get(row.targetTable) ?? 0) + 1);
  for (const [targetTable, count] of expected)
    if (actual[targetTable] !== count)
      throw new Error(
        `PMS ${targetTable} writer applied ${actual[targetTable] ?? 0} of ${count} planned rows`,
      );
}

async function lockPmsTargets(client: QueryClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query(
    `LOCK TABLE pms.linked_inventory_groups, pms.room_types, pms.rooms,
                pms.rate_plans, pms.rate_rules, pms.operational_booking_assignments,
                pms.room_blocks, pms.inventory_days, pms.checkin_checklist_templates,
                pms.checkout_inspection_templates, pms.booking_checkin_records,
                pms.booking_checkout_charges, pms.booking_checkout_records,
                pms.booking_notes_private, pms.message_threads, pms.messages,
                pms.message_attachments, pms.channel_connections,
                pms.channel_room_type_mappings, pms.channel_rate_plan_mappings,
                pms.channel_booking_mappings, pms.channel_sync_status,
                platform.external_webhook_events, platform.product_audit_events,
                platform.production_migration_source_links
     IN SHARE ROW EXCLUSIVE MODE`,
  );
}

function assertMode(mode: unknown): asserts mode is ProductionPmsMigrationMode {
  if (mode !== "dry-run" && mode !== "apply")
    throw new Error("PMS migration mode must be dry-run or apply");
}

function report(
  input: { sourceRunId: string; mode: ProductionPmsMigrationMode },
  plan: ProductionPmsPlan,
  applied: boolean,
): ProductionPmsMigrationReport {
  return {
    sourceRunId: input.sourceRunId,
    mode: input.mode,
    applied,
    checksum: plan.checksum,
    counts: plan.counts,
    parity: plan.parity,
    blockers: plan.blockers,
  };
}
