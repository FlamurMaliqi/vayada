import type { QueryResult, QueryResultRow } from "pg";

import type { PmsLinkedInventoryGroup } from "./pmsOperationsReadModel.js";

export type PmsLinkedInventoryGroupAudit = {
  actor:
    { kind: "user"; userId: string; organizationId: string } | { kind: "system"; service: string };
  requestId: string;
  correlationId?: string;
  reason: string;
  requestedAt: string;
};
type BaseCommand = {
  propertyId: string;
  commandId: string;
  idempotencyKey: string;
  audit: PmsLinkedInventoryGroupAudit;
};
export type PmsLinkedInventoryGroupPutCommand = BaseCommand & {
  groupId?: string;
  name: string;
  memberRoomTypeIds: string[];
  expectedRevision?: number;
};
export type PmsLinkedInventoryGroupDeleteCommand = BaseCommand & {
  groupId: string;
  expectedRevision: number;
};
export type PmsLinkedInventoryGroupCommandErrorCode =
  | "group_not_found"
  | "revision_conflict"
  | "idempotency_conflict"
  | "linked_inventory_group_invalid"
  | "linked_inventory_name_conflict"
  | "linked_inventory_membership_conflict"
  | "linked_inventory_overlap_conflict";
export type PmsLinkedInventoryGroupCommandResult =
  | { ok: true; group: PmsLinkedInventoryGroup | null; replayed?: boolean }
  | {
      ok: false;
      statusCode: 400 | 404 | 409;
      code: PmsLinkedInventoryGroupCommandErrorCode;
      message: string;
    };
export type PmsLinkedInventoryGroupClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

type GroupRow = {
  groupId: string;
  name: string;
  revision: number | string;
  memberRoomTypeIds: string[];
};
type ConflictRow = {
  leftRoomTypeId: string;
  rightRoomTypeId: string;
  startsOn: string;
  endsOn: string;
};

export async function putPmsLinkedInventoryGroup(
  client: PmsLinkedInventoryGroupClient,
  operation: "create" | "replace",
  command: PmsLinkedInventoryGroupPutCommand,
  createId: () => string,
): Promise<PmsLinkedInventoryGroupCommandResult> {
  const memberIds = [...new Set(command.memberRoomTypeIds)].sort();
  if (
    memberIds.length < 2 ||
    memberIds.length !== command.memberRoomTypeIds.length ||
    !command.name.trim()
  ) {
    return invalidLinkedInventoryGroup(
      "A linked inventory group requires a name and at least two distinct room types.",
    );
  }
  const groupId = operation === "create" ? createId() : command.groupId;
  if (!groupId) return invalidLinkedInventoryGroup("A linked inventory group ID is required.");
  if (operation === "replace") {
    const current = await lockPmsLinkedInventoryGroup(client, command.propertyId, groupId);
    if (!current) return linkedInventoryGroupNotFound();
    if (current.revision !== command.expectedRevision) {
      return linkedInventoryConflict(
        "revision_conflict",
        "Linked inventory group revision is stale.",
      );
    }
  }
  const members = await client.query<{ roomTypeId: string; linkedGroupId: string | null }>(
    `SELECT id::text AS "roomTypeId", linked_inventory_group_id::text AS "linkedGroupId"
     FROM pms.room_types WHERE property_id=$1::uuid AND id=ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [command.propertyId, memberIds],
  );
  if (members.rows.length !== memberIds.length) {
    return invalidLinkedInventoryGroup("Every linked room type must belong to this property.");
  }
  if (members.rows.some(({ linkedGroupId }) => linkedGroupId && linkedGroupId !== groupId)) {
    return linkedInventoryConflict(
      "linked_inventory_membership_conflict",
      "A room type already belongs to another linked inventory group.",
    );
  }
  const overlap = await findLinkedInventoryOverlap(client, command.propertyId, memberIds);
  if (overlap) {
    return linkedInventoryConflict(
      "linked_inventory_overlap_conflict",
      `Room types ${overlap.leftRoomTypeId} and ${overlap.rightRoomTypeId} overlap from ${overlap.startsOn} to ${overlap.endsOn}.`,
    );
  }
  if (operation === "create") {
    await client.query(
      `INSERT INTO pms.linked_inventory_groups (id,property_id,name)
       VALUES ($1::uuid,$2::uuid,$3)`,
      [groupId, command.propertyId, command.name.trim()],
    );
  } else {
    await client.query(
      `UPDATE pms.room_types SET linked_inventory_group_id=NULL
       WHERE property_id=$1::uuid AND linked_inventory_group_id=$2::uuid`,
      [command.propertyId, groupId],
    );
    await client.query(
      `UPDATE pms.linked_inventory_groups SET name=$3,revision=revision+1,updated_at=now()
       WHERE property_id=$1::uuid AND id=$2::uuid`,
      [command.propertyId, groupId, command.name.trim()],
    );
  }
  await client.query(
    `UPDATE pms.room_types SET linked_inventory_group_id=$2::uuid
     WHERE property_id=$1::uuid AND id=ANY($3::uuid[])`,
    [command.propertyId, groupId, memberIds],
  );
  return {
    ok: true,
    group: (await lockPmsLinkedInventoryGroup(client, command.propertyId, groupId))!,
  };
}

export async function deletePmsLinkedInventoryGroup(
  client: PmsLinkedInventoryGroupClient,
  command: PmsLinkedInventoryGroupDeleteCommand,
): Promise<PmsLinkedInventoryGroupCommandResult> {
  const group = await lockPmsLinkedInventoryGroup(client, command.propertyId, command.groupId);
  if (!group) return linkedInventoryGroupNotFound();
  if (group.revision !== command.expectedRevision) {
    return linkedInventoryConflict(
      "revision_conflict",
      "Linked inventory group revision is stale.",
    );
  }
  await client.query(
    `SELECT id FROM pms.room_types
     WHERE property_id=$1::uuid AND linked_inventory_group_id=$2::uuid
     ORDER BY id FOR UPDATE`,
    [command.propertyId, command.groupId],
  );
  await client.query(
    `UPDATE pms.room_types SET linked_inventory_group_id=NULL
     WHERE property_id=$1::uuid AND linked_inventory_group_id=$2::uuid`,
    [command.propertyId, command.groupId],
  );
  await client.query(
    `DELETE FROM pms.linked_inventory_groups WHERE property_id=$1::uuid AND id=$2::uuid`,
    [command.propertyId, command.groupId],
  );
  return { ok: true, group: null };
}

export async function lockPmsLinkedInventoryGroup(
  client: PmsLinkedInventoryGroupClient,
  propertyId: string,
  groupId: string,
): Promise<PmsLinkedInventoryGroup | null> {
  const result = await client.query<GroupRow>(
    `WITH locked_group AS MATERIALIZED (
       SELECT id,property_id,name,revision FROM pms.linked_inventory_groups
       WHERE property_id=$1::uuid AND id=$2::uuid FOR UPDATE
     ) SELECT group_row.id::text AS "groupId",group_row.name,group_row.revision,
       COALESCE(array_agg(room_type.id::text ORDER BY room_type.id)
         FILTER (WHERE room_type.id IS NOT NULL),ARRAY[]::text[]) AS "memberRoomTypeIds"
     FROM locked_group group_row LEFT JOIN pms.room_types room_type
       ON room_type.property_id=group_row.property_id
      AND room_type.linked_inventory_group_id=group_row.id
     GROUP BY group_row.id,group_row.name,group_row.revision`,
    [propertyId, groupId],
  );
  const row = result.rows[0];
  return row
    ? {
        groupId: row.groupId,
        name: row.name,
        revision: Number(row.revision),
        memberRoomTypeIds: row.memberRoomTypeIds,
      }
    : null;
}

async function findLinkedInventoryOverlap(
  client: PmsLinkedInventoryGroupClient,
  propertyId: string,
  memberIds: string[],
): Promise<ConflictRow | null> {
  const result = await client.query<ConflictRow>(
    `WITH causes AS (
       SELECT room_type_id,check_in AS starts_on,check_out AS ends_on
       FROM pms.inventory_reservation_receipts receipt
       JOIN pms.inventory_reservation_statuses status USING (receipt_id)
       WHERE receipt.property_id=$1::uuid AND receipt.room_type_id=ANY($2::uuid[])
        AND status.lifecycle_state='reserved'
       UNION ALL
       SELECT assignment.room_type_id,assignment.check_in,assignment.check_out
       FROM pms.operational_booking_assignments assignment
       WHERE assignment.property_id=$1::uuid AND assignment.room_type_id=ANY($2::uuid[])
        AND assignment.stay_evidence_kind='exact'
        AND assignment.assignment_status NOT IN ('canceled','released','checked_out')
       UNION ALL
       SELECT room_type_id,starts_on,ends_on+1 FROM pms.room_blocks
       WHERE property_id=$1::uuid AND room_type_id=ANY($2::uuid[])
        AND block_kind='manual' AND status='active'
     ) SELECT left_cause.room_type_id::text AS "leftRoomTypeId",
              right_cause.room_type_id::text AS "rightRoomTypeId",
              GREATEST(left_cause.starts_on,right_cause.starts_on)::text AS "startsOn",
              (LEAST(left_cause.ends_on,right_cause.ends_on)-1)::text AS "endsOn"
       FROM causes left_cause JOIN causes right_cause
        ON left_cause.room_type_id<right_cause.room_type_id
       AND left_cause.starts_on<right_cause.ends_on
       AND right_cause.starts_on<left_cause.ends_on LIMIT 1`,
    [propertyId, memberIds],
  );
  return result.rows[0] ?? null;
}

export const invalidLinkedInventoryGroup = (
  message: string,
): PmsLinkedInventoryGroupCommandResult => ({
  ok: false,
  statusCode: 400,
  code: "linked_inventory_group_invalid",
  message,
});
export const linkedInventoryGroupNotFound = (): PmsLinkedInventoryGroupCommandResult => ({
  ok: false,
  statusCode: 404,
  code: "group_not_found",
  message: "Linked inventory group not found.",
});
export const linkedInventoryConflict = (
  code: Exclude<
    PmsLinkedInventoryGroupCommandErrorCode,
    "group_not_found" | "linked_inventory_group_invalid"
  >,
  message: string,
): PmsLinkedInventoryGroupCommandResult => ({ ok: false, statusCode: 409, code, message });
