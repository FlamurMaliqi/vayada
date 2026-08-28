import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PmsLinkedInventoryNotCanonicalError,
  reconcilePmsLinkedInventory,
} from "./pmsLinkedInventoryReconciler.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13380000-0000-4000-8000-000000000001";
const ORGANIZATION = "13380000-0000-4000-8000-000000000002";
const GROUP = "13380000-0000-4000-8000-000000000003";
const OTHER_GROUP = "13380000-0000-4000-8000-000000000004";
const ROOM_TYPES = [
  "13380000-0000-4000-8000-000000000011",
  "13380000-0000-4000-8000-000000000012",
  "13380000-0000-4000-8000-000000000013",
];
const OTHER_ROOM_TYPES = [
  "13380000-0000-4000-8000-000000000014",
  "13380000-0000-4000-8000-000000000015",
];
const ALL_ROOM_TYPES = [...ROOM_TYPES, ...OTHER_ROOM_TYPES];
const RECEIPT = "13380000-0000-4000-8000-000000000021";
const ASSIGNMENT = "13380000-0000-4000-8000-000000000022";
const MANUAL_BLOCK = "13380000-0000-4000-8000-000000000023";
const CHANGED_AT = "2026-09-01T00:00:00.000Z";

if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname)) {
  throw new Error("Unsafe test database");
}

describe.skipIf(!URL)("PostgreSQL linked inventory reconciliation", () => {
  const client = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });

  beforeAll(async () => client.connect());
  afterEach(async () => client.query("ROLLBACK"));
  afterAll(async () => client.end());

  it("reconciles causes, handoffs, date changes, and releases idempotently", async () => {
    await client.query("BEGIN");
    await seed(client);

    await setLegacyInventory(client, true);
    await expect(reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT)).rejects.toBeInstanceOf(
      PmsLinkedInventoryNotCanonicalError,
    );
    await setLegacyInventory(client, false);

    await expect(reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT)).resolves.toHaveLength(
      9,
    );
    await expect(reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT)).resolves.toEqual([]);
    await expect(activeDerivedCounts(client)).resolves.toEqual({
      assignment: 2,
      manual: 2,
      receipt: 2,
    });
    await expect(inventory(client)).resolves.toMatchObject([
      { stayDate: "2026-09-01", stopped: true, available: 0 },
      { stayDate: "2026-09-02", stopped: true, available: 0 },
      { stayDate: "2026-09-03", stopped: true, available: 0, blocked: 1 },
      { stayDate: "2026-09-04", stopped: false, available: 1 },
      { stayDate: "2026-09-05", stopped: false, available: 1 },
    ]);

    await client.query(
      `UPDATE pms.inventory_reservation_statuses
       SET lifecycle_state='handed_off', lifecycle_revision=2, handed_off_at=$2
       WHERE receipt_id=$1`,
      [RECEIPT, CHANGED_AT],
    );
    await expect(reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT)).resolves.toHaveLength(
      6,
    );
    await expect(activeDerivedCounts(client)).resolves.toEqual({
      assignment: 2,
      manual: 2,
      receipt: 0,
    });

    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(
      `UPDATE pms.operational_booking_assignments
       SET check_in='2026-09-04', check_out='2026-09-06'
       WHERE id=$1`,
      [ASSIGNMENT],
    );
    await client.query("SET LOCAL session_replication_role=origin");
    const moved = await reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT);
    expect(new Set(moved.map(({ stayDate }) => stayDate))).toEqual(
      new Set(["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]),
    );
    await expect(
      client.query(
        `SELECT starts_on::text AS "startsOn", ends_on::text AS "endsOn"
         FROM pms.room_blocks WHERE source_assignment_id=$1 AND status='active'
         ORDER BY room_type_id`,
        [ASSIGNMENT],
      ),
    ).resolves.toMatchObject({
      rows: [
        { startsOn: "2026-09-04", endsOn: "2026-09-05" },
        { startsOn: "2026-09-04", endsOn: "2026-09-05" },
      ],
    });

    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(
      `UPDATE pms.operational_booking_assignments
       SET stay_evidence_kind='summary_only', check_in=NULL, check_out=NULL,
           adults=NULL, children=NULL
       WHERE id=$1`,
      [ASSIGNMENT],
    );
    await client.query("SET LOCAL session_replication_role=origin");
    await expect(reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT)).resolves.toHaveLength(
      6,
    );
    await client.query(`UPDATE pms.room_blocks SET status='released', released_at=$2 WHERE id=$1`, [
      MANUAL_BLOCK,
      CHANGED_AT,
    ]);
    await expect(reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT)).resolves.toHaveLength(
      3,
    );
    await expect(activeDerivedCounts(client)).resolves.toEqual({
      assignment: 0,
      manual: 0,
      receipt: 0,
    });
    await expect(inventory(client)).resolves.toMatchObject(
      Array.from({ length: 5 }, () => ({ stopped: false, available: 1, blocked: 0 })),
    );
    await expect(
      client.query<{ changed: number }>(
        `SELECT count(*) FILTER (WHERE inventory_revision <> 1
          OR linked_source_revision <> 0 OR linked_stop_sell)::int AS changed
         FROM pms.inventory_days WHERE property_id=$1
           AND room_type_id=ANY($2::uuid[])`,
        [PROPERTY, OTHER_ROOM_TYPES],
      ),
    ).resolves.toMatchObject({ rows: [{ changed: 0 }] });

    await client.query(
      `INSERT INTO pms.room_blocks
         (property_id, room_type_id, starts_on, ends_on, reason)
       VALUES ($1, $2, '2026-09-01', '2026-09-01', 'Final group cleanup')`,
      [PROPERTY, ROOM_TYPES[2]],
    );
    await reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT);
    await client.query(
      "UPDATE pms.room_types SET linked_inventory_group_id=NULL WHERE property_id=$1",
      [PROPERTY],
    );
    await client.query("DELETE FROM pms.linked_inventory_groups WHERE property_id=$1", [PROPERTY]);
    await reconcilePmsLinkedInventory(client, PROPERTY, CHANGED_AT);
    await expect(activeDerivedCounts(client)).resolves.toEqual({
      assignment: 0,
      manual: 0,
      receipt: 0,
    });
    await expect(inventory(client)).resolves.toMatchObject(
      Array.from({ length: 5 }, () => ({ stopped: false, available: 1, blocked: 0 })),
    );
  });
});

async function setLegacyInventory(client: pg.Client, legacy: boolean): Promise<void> {
  await client.query("SET LOCAL session_replication_role=replica");
  await client.query(
    `UPDATE pms.inventory_days SET
       calendar_revision=$3, inventory_revision=$3,
       generated_sellable_limit_count=$3, channel_sellable_limit_count=NULL,
       manual_sellable_limit_count=NULL, effective_sellable_limit_count=$3,
       generated_source_revision=$3, channel_source_revision=$4,
       manual_source_revision=$4, block_source_revision=$4, booking_source_revision=$4
     WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2026-09-05'`,
    [PROPERTY, OTHER_ROOM_TYPES[0], legacy ? null : 1, legacy ? null : 0],
  );
  await client.query("SET LOCAL session_replication_role=origin");
}

async function seed(client: pg.Client): Promise<void> {
  await client.query(
    `SET LOCAL session_replication_role=replica;
     INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ('${PROPERTY}', 'linked-inventory-test', 'Linked inventory test');
     INSERT INTO pms.linked_inventory_groups (id, property_id, name)
       VALUES ('${GROUP}', '${PROPERTY}', 'Convertible rooms'),
              ('${OTHER_GROUP}', '${PROPERTY}', 'Other rooms');
     INSERT INTO pms.room_types
       (id, property_id, name, base_rate_amount, currency, linked_inventory_group_id) VALUES
       ('${ROOM_TYPES[0]}', '${PROPERTY}', 'Double', 0, 'EUR', '${GROUP}'),
       ('${ROOM_TYPES[1]}', '${PROPERTY}', 'Twin', 0, 'EUR', '${GROUP}'),
       ('${ROOM_TYPES[2]}', '${PROPERTY}', 'Family', 0, 'EUR', '${GROUP}'),
       ('${OTHER_ROOM_TYPES[0]}', '${PROPERTY}', 'Suite', 0, 'EUR', '${OTHER_GROUP}'),
       ('${OTHER_ROOM_TYPES[1]}', '${PROPERTY}', 'Loft', 0, 'EUR', '${OTHER_GROUP}');
     INSERT INTO pms.operating_calendar_revisions
       (organization_id, property_id, calendar_revision, contract_version,
        property_profile_revision, property_time_zone, schedule_mode,
        recurring_period_count, room_binding_count, default_minimum_stay_nights,
        idempotency_key_id, domain_event_id, outbox_event_id, created_by_user_id,
        created_at, updated_at)
       VALUES ('${ORGANIZATION}', '${PROPERTY}', 1, 'pms-operating-calendar.v1',
        1, 'Europe/Berlin', 'year_round', 0, 5, 1, gen_random_uuid(),
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${CHANGED_AT}', '${CHANGED_AT}');
     INSERT INTO pms.operating_calendar_room_bindings
       (property_id, calendar_revision, room_type_id, source_room_facts_revision,
        source_room_units_revision, physical_capacity_count, starting_sellable_limit_count)
     SELECT '${PROPERTY}', 1, room_type_id, 1, 1, 1, 1
     FROM unnest(ARRAY['${ALL_ROOM_TYPES.join("','")}']::uuid[]) room_type_id;
     INSERT INTO pms.inventory_days
       (property_id, room_type_id, stay_date, total_count, available_count,
        assigned_count, blocked_count, status, source_freshness, calendar_revision,
        inventory_revision, generated_sellable_limit_count, effective_sellable_limit_count,
        generated_source_revision, channel_source_revision, manual_source_revision,
        block_source_revision, booking_source_revision, linked_stop_sell,
        linked_source_revision)
     SELECT '${PROPERTY}', room_type_id, stay_date, 1, 1, 0, 0, 'open', '{}',
            1, 1, 1, 1, 1, 0, 0, 0, 0, false, 0
     FROM unnest(ARRAY['${ALL_ROOM_TYPES.join("','")}']::uuid[]) room_type_id
     CROSS JOIN generate_series('2026-09-01'::date, '2026-09-05', '1 day') stay_date;
     INSERT INTO pms.inventory_reservation_receipts
       (receipt_id, contract_version, receipt_owner, organization_id, property_id,
        room_type_id, check_in, check_out, room_count, quote_session_id,
        public_offer_key, calendar_revision, materialized_revision,
        reserve_fingerprint_hash, reserve_idempotency_key_id, reserve_domain_event_id,
        reserve_outbox_event_id, reserved_at)
       VALUES ('${RECEIPT}', 'pms-inventory-reservation-lifecycle.v1', 'pms',
        '${ORGANIZATION}', '${PROPERTY}', '${ROOM_TYPES[0]}', '2026-09-01', '2026-09-03',
        1, 'quote', 'offer', 1, 1, 'sha256:${"0".repeat(64)}',
        gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '${CHANGED_AT}');
     INSERT INTO pms.inventory_reservation_statuses
       (receipt_id, organization_id, property_id, lifecycle_state, lifecycle_revision)
       VALUES ('${RECEIPT}', '${ORGANIZATION}', '${PROPERTY}', 'reserved', 1);
     INSERT INTO pms.operational_booking_assignments
       (id, property_id, guest_booking_id, room_type_id, stay_evidence_kind,
        check_in, check_out, adults, children, assignment_status)
       VALUES ('${ASSIGNMENT}', '${PROPERTY}', gen_random_uuid(), '${ROOM_TYPES[1]}',
        'exact', '2026-09-02', '2026-09-04', 1, 0, 'assigned');
     INSERT INTO pms.room_blocks
       (id, property_id, room_type_id, starts_on, ends_on, reason)
       VALUES ('${MANUAL_BLOCK}', '${PROPERTY}', '${ROOM_TYPES[2]}',
        '2026-09-03', '2026-09-03', 'Maintenance');
     SET LOCAL session_replication_role=origin;`,
  );
}

async function activeDerivedCounts(client: pg.Client) {
  const result = await client.query<{ cause: string; count: number }>(
    `SELECT CASE WHEN source_inventory_reservation_receipt_id IS NOT NULL THEN 'receipt'
                 WHEN source_assignment_id IS NOT NULL THEN 'assignment' ELSE 'manual' END AS cause,
            count(*)::int AS count
     FROM pms.room_blocks WHERE property_id=$1 AND block_kind <> 'manual' AND status='active'
     GROUP BY cause`,
    [PROPERTY],
  );
  return Object.fromEntries(
    ["assignment", "manual", "receipt"].map((cause) => [
      cause,
      result.rows.find((row) => row.cause === cause)?.count ?? 0,
    ]),
  );
}

async function inventory(client: pg.Client) {
  const result = await client.query(
    `SELECT stay_date::text AS "stayDate", linked_stop_sell AS stopped,
            available_count AS available, blocked_count AS blocked
     FROM pms.inventory_days WHERE property_id=$1 AND room_type_id=$2
     ORDER BY stay_date`,
    [PROPERTY, ROOM_TYPES[0]],
  );
  return result.rows;
}
