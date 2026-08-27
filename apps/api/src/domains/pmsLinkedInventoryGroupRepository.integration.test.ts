import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgPmsLinkedInventoryGroupCommandRepository } from "./pmsLinkedInventoryGroupRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13381100-0000-4000-8000-000000000001";
const GROUP = "13381100-0000-4000-8000-000000000002";
const TYPES = [
  "13381100-0000-4000-8000-000000000011",
  "13381100-0000-4000-8000-000000000012",
  "13381100-0000-4000-8000-000000000013",
];
const BLOCKS = ["13381100-0000-4000-8000-000000000021", "13381100-0000-4000-8000-000000000022"];
const AT = "2026-09-01T00:00:00.000Z";

if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname)) {
  throw new Error("Unsafe test database");
}

describe.skipIf(!URL)("PostgreSQL linked inventory group management", () => {
  const control = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const repository = createPgPmsLinkedInventoryGroupCommandRepository({
    connectionString: URL ?? "postgresql://disabled",
    now: () => new Date(AT),
    createId: () => GROUP,
  });

  beforeAll(async () => {
    await control.connect();
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await repository.close();
    await cleanup();
    await control.end();
  });

  it("creates, replays, replaces, deletes, and rejects overlapping members", async () => {
    const create = command("create", {
      name: "Convertible rooms",
      memberRoomTypeIds: TYPES.slice(0, 2),
    });
    await expect(repository.create(create)).resolves.toMatchObject({
      ok: true,
      group: { groupId: GROUP, revision: 1, memberRoomTypeIds: TYPES.slice(0, 2) },
    });
    await expect(repository.create(create)).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(linkedState()).resolves.toMatchObject({
      activeBlocks: 1,
      stoppedDays: 2,
      ariIntents: 2,
      distributionIntents: 2,
    });

    await expect(
      repository.replace(
        command("stale", {
          groupId: GROUP,
          name: "Convertible rooms",
          memberRoomTypeIds: TYPES,
          expectedRevision: 2,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "revision_conflict" });
    await expect(
      repository.replace(
        command("replace", {
          groupId: GROUP,
          name: "Flexible family inventory",
          memberRoomTypeIds: TYPES,
          expectedRevision: 1,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      group: { name: "Flexible family inventory", revision: 2, memberRoomTypeIds: TYPES },
    });
    await expect(linkedState()).resolves.toMatchObject({ activeBlocks: 2, stoppedDays: 3 });

    await expect(repository.delete(deleteCommand("delete", 1))).resolves.toMatchObject({
      ok: false,
      code: "revision_conflict",
    });
    await expect(repository.delete(deleteCommand("delete-current", 2))).resolves.toEqual({
      ok: true,
      group: null,
    });
    await expect(linkedState()).resolves.toMatchObject({ activeBlocks: 0, stoppedDays: 0 });

    await control.query(
      `INSERT INTO pms.room_blocks
         (id,property_id,room_type_id,starts_on,ends_on,reason)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'2026-09-01','2026-09-01','Second source')`,
      [BLOCKS[1], PROPERTY, TYPES[1]],
    );
    await expect(
      repository.create(
        command("overlap", {
          name: "Invalid overlap",
          memberRoomTypeIds: TYPES.slice(0, 2),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "linked_inventory_overlap_conflict" });
  });

  function command(
    key: string,
    input: {
      groupId?: string;
      name: string;
      memberRoomTypeIds: string[];
      expectedRevision?: number;
    },
  ) {
    return {
      propertyId: PROPERTY,
      commandId: `linked-group-${key}`,
      idempotencyKey: `linked-group-${key}`,
      audit: {
        actor: { kind: "system" as const, service: "integration-test" },
        requestId: `request-${key}`,
        reason: "Verify linked inventory group management",
        requestedAt: AT,
      },
      ...input,
    };
  }

  function deleteCommand(key: string, expectedRevision: number) {
    return {
      propertyId: PROPERTY,
      groupId: GROUP,
      expectedRevision,
      commandId: `linked-group-${key}`,
      idempotencyKey: `linked-group-${key}`,
      audit: {
        actor: { kind: "system" as const, service: "integration-test" },
        requestId: `request-${key}`,
        reason: "Verify linked inventory group deletion",
        requestedAt: AT,
      },
    };
  }

  async function linkedState() {
    const result = await control.query<{
      activeBlocks: number;
      stoppedDays: number;
      ariIntents: number;
      distributionIntents: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM pms.room_blocks WHERE property_id=$1::uuid
          AND block_kind<>'manual' AND status='active') AS "activeBlocks",
        (SELECT count(*)::int FROM pms.inventory_days WHERE property_id=$1::uuid
          AND linked_stop_sell) AS "stoppedDays",
        (SELECT count(*)::int FROM platform.outbox_events WHERE property_id=$1::uuid
          AND destination='pms.channel-manager') AS "ariIntents",
        (SELECT count(*)::int FROM platform.outbox_events WHERE property_id=$1::uuid
          AND destination='distribution.public-bookability') AS "distributionIntents"`,
      [PROPERTY],
    );
    return result.rows[0];
  }

  async function seed() {
    await control.query(
      `INSERT INTO hotel_catalog.properties (id,public_id,display_name)
       VALUES ($1::uuid,'linked-group-command-test','Linked group command test')`,
      [PROPERTY],
    );
    await control.query(
      `INSERT INTO pms.room_types (id,property_id,name,base_rate_amount,currency,sort_order)
       VALUES ($2::uuid,$1::uuid,'Double',100,'EUR',1),
              ($3::uuid,$1::uuid,'Twin',100,'EUR',2),
              ($4::uuid,$1::uuid,'Family',150,'EUR',3)`,
      [PROPERTY, ...TYPES],
    );
    await control.query("SET session_replication_role=replica");
    try {
      await control.query(
        `INSERT INTO pms.inventory_days
         (property_id,room_type_id,stay_date,total_count,available_count,assigned_count,
          blocked_count,status,source_freshness,calendar_revision,inventory_revision,
          generated_sellable_limit_count,effective_sellable_limit_count,
          generated_source_revision,channel_source_revision,manual_source_revision,
          block_source_revision,booking_source_revision,linked_stop_sell,linked_source_revision)
       SELECT $1::uuid,room_type_id,'2026-09-01',1,1,0,0,'open','{}',1,1,1,1,1,0,0,0,0,false,0
       FROM unnest(ARRAY[$2::uuid,$3::uuid,$4::uuid]) room_type_id`,
        [PROPERTY, ...TYPES],
      );
    } finally {
      await control.query("SET session_replication_role=origin");
    }
    await control.query(
      `INSERT INTO pms.room_blocks
         (id,property_id,room_type_id,starts_on,ends_on,reason)
       VALUES ($3::uuid,$1::uuid,$2::uuid,'2026-09-01','2026-09-01','Convertible source')`,
      [PROPERTY, TYPES[0], BLOCKS[0]],
    );
  }

  async function cleanup() {
    await control.query("BEGIN");
    try {
      await control.query("SET LOCAL session_replication_role=replica");
      for (const sql of [
        "DELETE FROM platform.outbox_events WHERE property_id=$1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id=$1::uuid",
        "DELETE FROM platform.product_audit_events WHERE property_id=$1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id=$1::uuid",
        "DELETE FROM pms.room_blocks WHERE property_id=$1::uuid",
        "DELETE FROM pms.inventory_days WHERE property_id=$1::uuid",
        "DELETE FROM pms.room_types WHERE property_id=$1::uuid",
        "DELETE FROM pms.linked_inventory_groups WHERE property_id=$1::uuid",
        "DELETE FROM hotel_catalog.properties WHERE id=$1::uuid",
      ]) {
        await control.query(sql, [PROPERTY]);
      }
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      throw error;
    }
  }
});
