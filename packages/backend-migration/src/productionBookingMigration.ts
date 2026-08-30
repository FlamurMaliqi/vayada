import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import { buildProductionBookingPlan } from "./productionBookingPlan.js";
import { readProductionBookingSnapshot } from "./productionBookingSnapshotReader.js";
import {
  readProductionBookingOwnership,
  readProductionBookingTargetState,
} from "./productionBookingTargetReader.js";
import type {
  BookingTargetRecord,
  ProductionBookingPlan,
  ProductionBookingTargetState,
} from "./productionBookingTypes.js";
import {
  writeProductionBookingRecords,
  writeProductionMigrationProvenance,
} from "./productionBookingWriter.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type ProductionBookingMigrationMode = "dry-run" | "apply";
export type ProductionBookingMigrationReport = {
  sourceRunId: string;
  mode: ProductionBookingMigrationMode;
  applied: boolean;
  checksum: string;
  counts: ProductionBookingPlan["counts"];
  parity: ProductionBookingPlan["parity"];
  blockers: ProductionBookingPlan["blockers"];
};
export type ProductionBookingMigrationServices = {
  readSnapshot: typeof readProductionBookingSnapshot;
  readOwnership: typeof readProductionBookingOwnership;
  readTarget: typeof readProductionBookingTargetState;
  buildPlan: typeof buildProductionBookingPlan;
  writeRecords: typeof writeProductionBookingRecords;
  writeProvenance: typeof writeProductionMigrationProvenance;
};
const productionServices: ProductionBookingMigrationServices = {
  readSnapshot: readProductionBookingSnapshot,
  readOwnership: readProductionBookingOwnership,
  readTarget: readProductionBookingTargetState,
  buildPlan: buildProductionBookingPlan,
  writeRecords: writeProductionBookingRecords,
  writeProvenance: writeProductionMigrationProvenance,
};

export async function runProductionBookingMigration(config: {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionBookingMigrationMode;
  max?: number;
}): Promise<ProductionBookingMigrationReport> {
  assertMode(config.mode);
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max ?? 1,
  });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return await runProductionBookingTransaction(client, config);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runProductionBookingTransaction(
  client: QueryClient,
  input: { sourceRunId: string; mode: ProductionBookingMigrationMode },
  services: ProductionBookingMigrationServices = productionServices,
): Promise<ProductionBookingMigrationReport> {
  assertMode(input.mode);
  let finished = false;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    if (input.mode === "apply") await lockBookingTargets(client);
    const snapshot = await services.readSnapshot(client, input.sourceRunId);
    const ownership = await services.readOwnership(client);
    const emptyTarget: ProductionBookingTargetState = {
      ...ownership,
      records: [],
      provenance: [],
    };
    const preliminary = services.buildPlan({
      sourceRunId: input.sourceRunId,
      completedAt: snapshot.completedAt,
      rows: snapshot.rows,
      target: emptyTarget,
    });
    const target = await services.readTarget(client, preliminary.records, ownership);
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
        `Booking provenance writer applied ${provenanceCount} of ${plan.provenance.length} planned rows`,
      );
    const verifiedTarget = await services.readTarget(client, plan.records, ownership);
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
      throw new Error("Post-write Booking verification does not match the migration plan");
    await client.query("COMMIT");
    finished = true;
    return report(input, plan, true);
  } catch (error) {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertWriteCounts(planned: BookingTargetRecord[], actual: Record<string, number>): void {
  const expected = new Map<string, number>();
  for (const row of planned)
    expected.set(row.targetTable, (expected.get(row.targetTable) ?? 0) + 1);
  for (const [targetTable, count] of expected)
    if (actual[targetTable] !== count)
      throw new Error(
        `Booking ${targetTable} writer applied ${actual[targetTable] ?? 0} of ${count} planned rows`,
      );
}

async function lockBookingTargets(client: QueryClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query(
    `LOCK TABLE booking.booking_settings, booking.quote_sessions, booking.checkout_contexts,
                booking.guest_bookings, booking.booking_guests, booking.addon_definitions,
                booking.booking_addon_selections, booking.promo_definitions,
                booking.promo_applications, booking.booking_status_events,
                booking.booking_change_requests, booking.direct_booking_summary_read_model,
                platform.product_audit_events, platform.production_migration_source_links
     IN SHARE ROW EXCLUSIVE MODE`,
  );
}
function assertMode(mode: unknown): asserts mode is ProductionBookingMigrationMode {
  if (mode !== "dry-run" && mode !== "apply")
    throw new Error("Booking migration mode must be dry-run or apply");
}
function report(
  input: { sourceRunId: string; mode: ProductionBookingMigrationMode },
  plan: ProductionBookingPlan,
  applied: boolean,
): ProductionBookingMigrationReport {
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
