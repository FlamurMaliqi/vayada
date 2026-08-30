import type { QueryResult, QueryResultRow } from "pg";

import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

export type PmsLinkedInventoryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export type PmsLinkedInventoryChange = {
  roomTypeId: string;
  stayDate: string;
};

export type PmsLinkedInventoryDirtyRange = {
  roomTypeId: string;
  startsOn: string;
  endsOn: string;
};

type InventoryRange = {
  sourceRoomTypeId: string;
  targetRoomTypeId: string;
  startsOn: string;
  endsOn: string;
};

type DerivedRange = InventoryRange & { blockId: string };

export class PmsLinkedInventoryNotCanonicalError extends Error {}

export async function reconcilePmsLinkedInventory(
  client: PmsLinkedInventoryClient,
  propertyId: string,
  changedAt: string,
  requestedRanges: readonly PmsLinkedInventoryDirtyRange[] = [],
): Promise<PmsLinkedInventoryChange[]> {
  await lockPmsInventoryMutationScope(client, propertyId);
  const groups = await client.query(
    `WITH locked_groups AS MATERIALIZED (
       SELECT group_row.id
       FROM pms.linked_inventory_groups group_row
       WHERE group_row.property_id = $1::uuid
       ORDER BY group_row.id
       FOR UPDATE
     )
     SELECT id FROM locked_groups
     UNION ALL
     SELECT NULL::uuid
     WHERE NOT EXISTS (SELECT 1 FROM locked_groups)
       AND (EXISTS (
         SELECT 1 FROM pms.room_blocks
         WHERE property_id=$1::uuid AND block_kind <> 'manual'
       ) OR EXISTS (
         SELECT 1 FROM pms.inventory_days
         WHERE property_id=$1::uuid AND linked_stop_sell
       ))`,
    [propertyId],
  );
  if (groups.rows.length === 0) return [];
  const linkedRoomTypes = await client.query<{ roomTypeId: string }>(
    `SELECT room_type.id::text AS "roomTypeId"
     FROM pms.room_types room_type
     WHERE room_type.property_id = $1::uuid
       AND room_type.linked_inventory_group_id IS NOT NULL
     ORDER BY room_type.id
     FOR UPDATE`,
    [propertyId],
  );
  const linkedRoomTypeIds = new Set(linkedRoomTypes.rows.map(({ roomTypeId }) => roomTypeId));
  const legacy = await client.query(
    `SELECT 1
     FROM pms.inventory_days inventory
     JOIN pms.room_types room_type
       ON room_type.id = inventory.room_type_id
      AND room_type.property_id = inventory.property_id
     WHERE inventory.property_id = $1::uuid
       AND room_type.linked_inventory_group_id IS NOT NULL
       AND inventory.calendar_revision IS NULL
     LIMIT 1`,
    [propertyId],
  );
  if (legacy.rows.length > 0) {
    const work = await client.query(
      `SELECT 1 FROM (
         SELECT block.room_type_id FROM pms.room_blocks block
         WHERE block.property_id=$1::uuid AND block.block_kind<>'manual'
           AND block.status='active'
         UNION ALL
         SELECT block.room_type_id FROM pms.room_blocks block
         JOIN pms.room_types room_type
           ON room_type.id=block.room_type_id AND room_type.property_id=block.property_id
         WHERE block.property_id=$1::uuid AND block.block_kind='manual'
           AND block.status='active' AND room_type.linked_inventory_group_id IS NOT NULL
         UNION ALL
         SELECT receipt.room_type_id FROM pms.inventory_reservation_receipts receipt
         JOIN pms.inventory_reservation_statuses status USING (receipt_id)
         JOIN pms.room_types room_type
           ON room_type.id=receipt.room_type_id AND room_type.property_id=receipt.property_id
         WHERE receipt.property_id=$1::uuid AND status.lifecycle_state='reserved'
           AND room_type.linked_inventory_group_id IS NOT NULL
         UNION ALL
         SELECT assignment.room_type_id FROM pms.operational_booking_assignments assignment
         JOIN pms.room_types room_type
           ON room_type.id=assignment.room_type_id
          AND room_type.property_id=assignment.property_id
         WHERE assignment.property_id=$1::uuid AND assignment.stay_evidence_kind='exact'
           AND assignment.assignment_status NOT IN ('canceled','released')
           AND room_type.linked_inventory_group_id IS NOT NULL
       ) linked_work LIMIT 1`,
      [propertyId],
    );
    if (
      work.rows.length === 0 &&
      !requestedRanges.some(({ roomTypeId }) => linkedRoomTypeIds.has(roomTypeId))
    ) {
      return [];
    }
    throw new PmsLinkedInventoryNotCanonicalError(
      "Linked inventory requires canonical inventory materialization.",
    );
  }
  await client.query(
    `SELECT inventory.room_type_id, inventory.stay_date
     FROM pms.inventory_days inventory
     JOIN pms.room_types room_type
       ON room_type.id = inventory.room_type_id
      AND room_type.property_id = inventory.property_id
     WHERE inventory.property_id = $1::uuid
       AND room_type.linked_inventory_group_id IS NOT NULL
     ORDER BY inventory.room_type_id, inventory.stay_date
     FOR UPDATE OF inventory`,
    [propertyId],
  );

  const before = await client.query<DerivedRange>(
    `SELECT id::text AS "blockId",
            source_room_type_id::text AS "sourceRoomTypeId",
            room_type_id::text AS "targetRoomTypeId",
            starts_on::text AS "startsOn", ends_on::text AS "endsOn"
     FROM pms.room_blocks
     WHERE property_id=$1::uuid AND block_kind <> 'manual'`,
    [propertyId],
  );
  const changedBlocks = await upsertDerivedBlocks(client, propertyId, changedAt);
  const releasedBlocks = await releaseStaleDerivedBlocks(client, propertyId, changedAt);
  const oldById = new Map(before.rows.map((range) => [range.blockId, range]));
  const dirtyRanges: InventoryRange[] = [...changedBlocks, ...releasedBlocks].flatMap((range) => {
    const old = oldById.get(range.blockId);
    return old ? [old, range] : [range];
  });
  dirtyRanges.push(
    ...requestedRanges
      .filter((range) => linkedRoomTypeIds.has(range.roomTypeId))
      .map((range) => ({
        sourceRoomTypeId: range.roomTypeId,
        targetRoomTypeId: range.roomTypeId,
        startsOn: range.startsOn,
        endsOn: range.endsOn,
      })),
  );
  if (dirtyRanges.length === 0) return [];

  const changed = await client.query<PmsLinkedInventoryChange>(
    `WITH dirty_dates AS (
       SELECT DISTINCT range.source_room_type_id, range.target_room_type_id,
              generate_series(range.starts_on, range.ends_on, interval '1 day')::date
                AS stay_date
       FROM jsonb_to_recordset($3::jsonb) AS range(
         source_room_type_id uuid, target_room_type_id uuid, starts_on date, ends_on date
       )
     ), desired AS (
       SELECT inventory.room_type_id, inventory.stay_date,
              LEAST(
                COALESCE(SUM(block.blocked_count) FILTER (WHERE block.id IS NOT NULL), 0),
                GREATEST(inventory.total_count - inventory.assigned_count, 0)
              )::integer AS blocked_count,
              EXISTS (
                SELECT 1
                FROM pms.room_types source_type
                LEFT JOIN pms.inventory_reservation_receipts receipt
                  ON receipt.property_id = source_type.property_id
                 AND receipt.room_type_id = source_type.id
                 AND inventory.stay_date >= receipt.check_in
                 AND inventory.stay_date < receipt.check_out
                LEFT JOIN pms.inventory_reservation_statuses receipt_status
                  ON receipt_status.receipt_id = receipt.receipt_id
                 AND receipt_status.lifecycle_state = 'reserved'
                LEFT JOIN pms.operational_booking_assignments assignment
                  ON assignment.property_id = source_type.property_id
                 AND assignment.room_type_id = source_type.id
                 AND assignment.stay_evidence_kind = 'exact'
                 AND assignment.assignment_status NOT IN ('canceled', 'released')
                 AND inventory.stay_date >= assignment.check_in
                 AND inventory.stay_date < assignment.check_out
                LEFT JOIN pms.room_blocks source_block
                  ON source_block.property_id = source_type.property_id
                 AND source_block.room_type_id = source_type.id
                 AND source_block.block_kind = 'manual' AND source_block.status = 'active'
                 AND inventory.stay_date BETWEEN source_block.starts_on AND source_block.ends_on
                WHERE source_type.property_id = inventory.property_id
                  AND source_type.linked_inventory_group_id = room_type.linked_inventory_group_id
                  AND (receipt_status.receipt_id IS NOT NULL
                    OR assignment.id IS NOT NULL OR source_block.id IS NOT NULL)
              ) AS linked_stop_sell
       FROM pms.inventory_days inventory
       JOIN pms.room_types room_type
         ON room_type.id = inventory.room_type_id
        AND room_type.property_id = inventory.property_id
       LEFT JOIN pms.room_blocks block
         ON block.property_id = inventory.property_id
        AND block.room_type_id = inventory.room_type_id
        AND block.status = 'active'
        AND inventory.stay_date BETWEEN block.starts_on AND block.ends_on
       WHERE inventory.property_id = $1::uuid
         AND EXISTS (
           SELECT 1
           FROM dirty_dates dirty
           JOIN pms.room_types dirty_source
             ON dirty_source.id = dirty.source_room_type_id
            AND dirty_source.property_id = inventory.property_id
           JOIN pms.room_types dirty_target
             ON dirty_target.id = dirty.target_room_type_id
            AND dirty_target.property_id = inventory.property_id
           WHERE dirty.stay_date = inventory.stay_date
             AND (inventory.room_type_id IN (
                    dirty.source_room_type_id, dirty.target_room_type_id
                  )
               OR (dirty_source.linked_inventory_group_id IS NOT NULL
                 AND room_type.linked_inventory_group_id =
                   dirty_source.linked_inventory_group_id)
               OR (dirty_target.linked_inventory_group_id IS NOT NULL
                 AND room_type.linked_inventory_group_id =
                   dirty_target.linked_inventory_group_id))
         )
       GROUP BY inventory.property_id, inventory.room_type_id, inventory.stay_date,
                inventory.total_count, inventory.assigned_count,
                room_type.linked_inventory_group_id
     )
     UPDATE pms.inventory_days inventory
     SET blocked_count = desired.blocked_count,
         linked_stop_sell = desired.linked_stop_sell,
         available_count = CASE WHEN inventory.status = 'closed' OR desired.linked_stop_sell
           THEN 0 ELSE GREATEST(0, inventory.effective_sellable_limit_count
             - inventory.assigned_count - desired.blocked_count) END,
         inventory_revision = inventory.inventory_revision + 1,
         linked_source_revision = inventory.linked_source_revision + 1,
         block_source_revision = inventory.block_source_revision
           + CASE WHEN inventory.blocked_count IS DISTINCT FROM desired.blocked_count THEN 1 ELSE 0 END,
         updated_at = $2::timestamptz
     FROM desired
     WHERE inventory.property_id = $1::uuid
       AND inventory.room_type_id = desired.room_type_id
       AND inventory.stay_date = desired.stay_date
     RETURNING inventory.room_type_id::text AS "roomTypeId",
               inventory.stay_date::text AS "stayDate"`,
    [
      propertyId,
      changedAt,
      JSON.stringify(
        dirtyRanges.map(({ sourceRoomTypeId, targetRoomTypeId, startsOn, endsOn }) => ({
          source_room_type_id: sourceRoomTypeId,
          target_room_type_id: targetRoomTypeId,
          starts_on: startsOn,
          ends_on: endsOn,
        })),
      ),
    ],
  );
  return changed.rows;
}

async function upsertDerivedBlocks(
  client: PmsLinkedInventoryClient,
  propertyId: string,
  changedAt: string,
): Promise<DerivedRange[]> {
  const changed: DerivedRange[] = [];
  for (const source of ["receipt", "assignment", "manual"] as const) {
    const causeColumn =
      source === "receipt"
        ? "source_inventory_reservation_receipt_id"
        : source === "assignment"
          ? "source_assignment_id"
          : "source_room_block_id";
    const sourceSql =
      source === "receipt"
        ? `SELECT receipt.property_id, receipt.room_type_id, receipt.receipt_id AS cause_id,
                  receipt.check_in AS starts_on, receipt.check_out - 1 AS ends_on
           FROM pms.inventory_reservation_receipts receipt
           JOIN pms.inventory_reservation_statuses status USING (receipt_id)
           WHERE status.lifecycle_state = 'reserved'`
        : source === "assignment"
          ? `SELECT property_id, room_type_id, id AS cause_id, check_in AS starts_on,
                    check_out - 1 AS ends_on
             FROM pms.operational_booking_assignments
             WHERE stay_evidence_kind = 'exact'
               AND assignment_status NOT IN ('canceled', 'released')`
          : `SELECT property_id, room_type_id, id AS cause_id, starts_on, ends_on
             FROM pms.room_blocks
             WHERE block_kind = 'manual' AND status = 'active'`;
    const kind = source === "manual" ? "linked_manual_block" : "linked_booking";
    const result = await client.query<DerivedRange>(
      `INSERT INTO pms.room_blocks
         (property_id, room_type_id, starts_on, ends_on, blocked_count, reason,
          status, block_kind, source_room_type_id, ${causeColumn}, created_at, updated_at)
       SELECT source.property_id, target.id, source.starts_on, source.ends_on, 1,
              'Linked inventory', 'active', '${kind}', source.room_type_id,
              source.cause_id, $2::timestamptz, $2::timestamptz
       FROM (${sourceSql}) source
       JOIN pms.room_types source_type
         ON source_type.id = source.room_type_id
        AND source_type.property_id = source.property_id
       JOIN pms.room_types target
         ON target.property_id = source.property_id
        AND target.linked_inventory_group_id = source_type.linked_inventory_group_id
        AND target.id <> source.room_type_id
       WHERE source.property_id = $1::uuid
         AND source_type.linked_inventory_group_id IS NOT NULL
       ON CONFLICT (property_id, ${causeColumn}, room_type_id)
         WHERE block_kind = '${kind}' AND ${causeColumn} IS NOT NULL
       DO UPDATE SET starts_on=EXCLUDED.starts_on, ends_on=EXCLUDED.ends_on,
                     source_room_type_id=EXCLUDED.source_room_type_id, status='active',
                     released_at=NULL, updated_at=$2::timestamptz
       WHERE (pms.room_blocks.starts_on, pms.room_blocks.ends_on,
              pms.room_blocks.source_room_type_id, pms.room_blocks.status)
         IS DISTINCT FROM (EXCLUDED.starts_on, EXCLUDED.ends_on,
                           EXCLUDED.source_room_type_id, 'active')
       RETURNING id::text AS "blockId",
                 source_room_type_id::text AS "sourceRoomTypeId",
                 room_type_id::text AS "targetRoomTypeId",
                 starts_on::text AS "startsOn", ends_on::text AS "endsOn"`,
      [propertyId, changedAt],
    );
    changed.push(...result.rows);
  }
  return changed;
}

async function releaseStaleDerivedBlocks(
  client: PmsLinkedInventoryClient,
  propertyId: string,
  changedAt: string,
): Promise<DerivedRange[]> {
  const result = await client.query<DerivedRange>(
    `UPDATE pms.room_blocks derived
     SET status='released', released_at=$2::timestamptz, updated_at=$2::timestamptz
     WHERE derived.property_id=$1::uuid AND derived.status='active'
       AND derived.block_kind <> 'manual'
       AND NOT EXISTS (
         SELECT 1 FROM pms.room_types source_type
         JOIN pms.room_types target
           ON target.property_id=source_type.property_id
          AND target.linked_inventory_group_id=source_type.linked_inventory_group_id
         WHERE source_type.id=derived.source_room_type_id
           AND target.id=derived.room_type_id
           AND source_type.linked_inventory_group_id IS NOT NULL
           AND ((derived.source_inventory_reservation_receipt_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM pms.inventory_reservation_statuses status
             WHERE status.receipt_id=derived.source_inventory_reservation_receipt_id
               AND status.lifecycle_state='reserved'))
           OR (derived.source_assignment_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM pms.operational_booking_assignments assignment
             WHERE assignment.id=derived.source_assignment_id
               AND assignment.property_id=derived.property_id
               AND assignment.room_type_id=derived.source_room_type_id
               AND assignment.stay_evidence_kind='exact'
               AND assignment.assignment_status NOT IN ('canceled','released')))
           OR (derived.source_room_block_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM pms.room_blocks source
             WHERE source.id=derived.source_room_block_id AND source.status='active'
               AND source.block_kind='manual')))
       )
     RETURNING derived.id::text AS "blockId",
               derived.source_room_type_id::text AS "sourceRoomTypeId",
               derived.room_type_id::text AS "targetRoomTypeId",
               derived.starts_on::text AS "startsOn", derived.ends_on::text AS "endsOn"`,
    [propertyId, changedAt],
  );
  return result.rows;
}
