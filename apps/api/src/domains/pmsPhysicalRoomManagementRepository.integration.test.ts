import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ManagePhysicalRoomCommand } from "@vayada/domain-pms";
import { createPgPmsPhysicalRoomManagementRepository } from "./pmsPhysicalRoomManagementRepository.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("physical-room management PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: url });
  const repository = createPgPmsPhysicalRoomManagementRepository({ connectionString: url });
  let actorUserId: string, organizationId: string, propertyId: string, roomTypeId: string;
  beforeAll(async () => {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname))
      throw new Error("Test database required");
    await admin.connect();
  });
  beforeEach(async () => {
    [actorUserId, organizationId, propertyId, roomTypeId] = Array.from({ length: 4 }, () =>
      randomUUID(),
    ) as [string, string, string, string];
    await seed();
  });
  afterAll(async () => {
    await repository.close();
    await admin.end();
  });
  const command = (expectedRevision: number): ManagePhysicalRoomCommand => ({
    action: "create",
    organizationId,
    propertyId,
    roomTypeId,
    expectedRevision,
    idempotencyKey: randomUUID(),
    changes: { operationalLabel: "101", floor: "1" },
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: randomUUID(),
      correlationId: null,
      requestedAt: new Date().toISOString(),
    },
  });
  it("creates, renames and retires exactly one stable room, replaying each command", async () => {
    const create = command(1);
    const first = await repository.managePhysicalRoom(create);
    expect(first).toMatchObject({
      ok: true,
      response: { outcome: "created", roomUnitsRevision: 2 },
    });
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(await repository.managePhysicalRoom(create)).toEqual(first);
    const roomUnitId = first.response.roomUnitId;
    const update: ManagePhysicalRoomCommand = {
      ...create,
      action: "update",
      roomUnitId,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
      changes: { operationalLabel: "102" },
    };
    const changed = await repository.managePhysicalRoom(update);
    expect(changed).toMatchObject({ ok: true });
    expect(await repository.managePhysicalRoom(update)).toEqual(changed);
    const retire: ManagePhysicalRoomCommand = {
      ...create,
      action: "retire",
      roomUnitId,
      expectedRevision: 3,
      idempotencyKey: randomUUID(),
    };
    const retired = await repository.managePhysicalRoom(retire);
    expect(retired).toMatchObject({ ok: true, response: { outcome: "retired" } });
    expect(await repository.managePhysicalRoom(retire)).toEqual(retired);
    expect(
      (await admin.query("SELECT status,room_number FROM pms.rooms WHERE id=$1", [roomUnitId]))
        .rows,
    ).toEqual([{ status: "retired", room_number: "102" }]);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM platform.product_audit_events WHERE property_id=$1",
          [propertyId],
        )
      ).rows[0].count,
    ).toBe(3);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id=$1",
          [propertyId],
        )
      ).rows[0].count,
    ).toBe(9);
  });
  it("rejects stale writes, key reuse, duplicate labels and revoked access without extra rooms", async () => {
    const create = command(1);
    expect(await repository.managePhysicalRoom(create)).toMatchObject({ ok: true });
    expect(await repository.managePhysicalRoom(command(1))).toMatchObject({
      ok: false,
      error: { code: "room_units_revision_conflict" },
    });
    expect(await repository.managePhysicalRoom({ ...create, expectedRevision: 2 })).toMatchObject({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
    expect(await repository.managePhysicalRoom(command(2))).toMatchObject({
      ok: false,
      error: { code: "operational_label_conflict" },
    });
    await admin.query(
      "UPDATE identity.organization_memberships SET status='suspended' WHERE organization_id=$1",
      [organizationId],
    );
    expect(await repository.managePhysicalRoom(create)).toMatchObject({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM pms.rooms WHERE property_id=$1", [
          propertyId,
        ])
      ).rows[0].count,
    ).toBe(1);
  });
  it("serializes competing creates at the same revision", async () => {
    const results = await Promise.all([
      repository.managePhysicalRoom(command(1)),
      repository.managePhysicalRoom({
        ...command(1),
        action: "create",
        changes: { operationalLabel: "102" },
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { ok: false, error: { code: "room_units_revision_conflict" } },
    ]);
  });
  it("protects a room block atomically", async () => {
    const create = command(1);
    const result = await repository.managePhysicalRoom(create);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const roomUnitId = result.response.roomUnitId;
    await admin.query(
      `INSERT INTO pms.room_blocks(property_id,room_type_id,room_id,starts_on,ends_on,reason)
      VALUES($1,$2,$3,CURRENT_DATE,CURRENT_DATE+1,'maintenance')`,
      [propertyId, roomTypeId, roomUnitId],
    );
    expect(
      await repository.managePhysicalRoom({
        ...create,
        action: "retire",
        roomUnitId,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { blockers: ["block"] } });
    expect(
      (
        await admin.query(
          "SELECT room_units_revision::int AS room_units_revision FROM pms.room_types WHERE id=$1",
          [roomTypeId],
        )
      ).rows[0].room_units_revision,
    ).toBe(2);
  });

  it("advances immutable calendar and inventory together while preserving a closed day", async () => {
    const create = command(1);
    expect(await repository.managePhysicalRoom(create)).toMatchObject({ ok: true });
    await seedCalendar();
    expect(
      await repository.managePhysicalRoom({
        ...command(2),
        action: "create",
        changes: { operationalLabel: "102" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      (
        await admin.query(
          `SELECT total_count,available_count,status,calendar_revision FROM pms.inventory_days WHERE property_id=$1 ORDER BY stay_date`,
          [propertyId],
        )
      ).rows,
    ).toEqual([
      { total_count: 2, available_count: 2, status: "open", calendar_revision: 2 },
      { total_count: 2, available_count: 0, status: "closed", calendar_revision: 2 },
    ]);
    expect(
      (
        await admin.query(
          `SELECT calendar_revision,physical_capacity_count FROM pms.operating_calendar_room_bindings WHERE property_id=$1 ORDER BY calendar_revision`,
          [propertyId],
        )
      ).rows,
    ).toEqual([
      { calendar_revision: 1, physical_capacity_count: 1 },
      { calendar_revision: 2, physical_capacity_count: 2 },
    ]);
    expect(
      (
        await admin.query(
          "SELECT calendar_revision FROM pms.inventory_materialization_coverage WHERE property_id=$1",
          [propertyId],
        )
      ).rows[0].calendar_revision,
    ).toBe(2);
    expect(
      (
        await admin.query(
          `SELECT max(payload#>>'{dateRange,to}')=(CURRENT_DATE+401)::text AS complete
      FROM platform.outbox_events WHERE property_id=$1`,
          [propertyId],
        )
      ).rows[0].complete,
    ).toBe(true);
    const newRoom = (
      await admin.query("SELECT id FROM pms.rooms WHERE property_id=$1 AND room_number='102'", [
        propertyId,
      ])
    ).rows[0].id;
    await admin.query(
      `UPDATE pms.inventory_days SET manual_sellable_limit_count=2,manual_source_revision=1,inventory_revision=inventory_revision+1
      WHERE property_id=$1 AND status='open'`,
      [propertyId],
    );
    expect(
      await repository.managePhysicalRoom({ ...command(3), action: "retire", roomUnitId: newRoom }),
    ).toMatchObject({ ok: false, error: { code: "physical_room_protected" } });
    expect(
      (await admin.query("SELECT status FROM pms.rooms WHERE id=$1", [newRoom])).rows[0].status,
    ).toBe("available");
    await admin.query(
      `UPDATE pms.inventory_days SET manual_sellable_limit_count=NULL,manual_source_revision=2,inventory_revision=inventory_revision+1
      WHERE property_id=$1 AND status='open'`,
      [propertyId],
    );
    expect(
      await repository.managePhysicalRoom({ ...command(3), action: "retire", roomUnitId: newRoom }),
    ).toMatchObject({ ok: true });
    expect(
      (
        await admin.query(
          "SELECT total_count,available_count FROM pms.inventory_days WHERE property_id=$1 AND status='open'",
          [propertyId],
        )
      ).rows[0],
    ).toEqual({ total_count: 1, available_count: 1 });
  });
  async function seedCalendar() {
    const ids = (
      await admin.query(
        `SELECT keys.id AS key, event.id AS event, outbox.id AS outbox
      FROM platform.idempotency_keys keys JOIN platform.domain_events event ON event.property_id=keys.property_id
      JOIN platform.outbox_events outbox ON outbox.domain_event_id=event.id
      WHERE keys.property_id=$1 AND outbox.destination='pms.calendar-projection' LIMIT 1`,
        [propertyId],
      )
    ).rows[0];
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO pms.operating_calendar_revisions
      (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,schedule_mode,
       recurring_period_count,room_binding_count,default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,1,'pms-operating-calendar.v1',1,'Europe/Berlin','year_round',0,1,1,$3,$4,$5,$6,now(),now())`,
      [organizationId, propertyId, ids.key, ids.event, ids.outbox, actorUserId],
    );
    await admin.query(
      `INSERT INTO pms.operating_calendar_room_bindings
      (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count)
      VALUES($1,1,$2,1,2,1,1)`,
      [propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.inventory_days
      (property_id,room_type_id,stay_date,total_count,available_count,status,calendar_revision,inventory_revision,
       generated_sellable_limit_count,effective_sellable_limit_count,generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
      VALUES($1,$2,CURRENT_DATE+400,1,1,'open',1,1,1,1,1,0,0,0,0),($1,$2,CURRENT_DATE+401,1,0,'closed',1,1,0,0,1,0,0,0,0)`,
      [propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.inventory_materialization_coverage
      (property_id,organization_id,calendar_revision,materialized_revision,coverage_from,coverage_through,room_type_count,expected_day_count,materialized_day_count,
       last_changed_materialization_idempotency_key_id,last_changed_materialization_domain_event_id,last_changed_materialization_outbox_event_id,updated_at)
      VALUES($1,$2,1,1,CURRENT_DATE+400,CURRENT_DATE+401,1,2,2,$3,$4,$5,now())`,
      [propertyId, organizationId, ids.key, ids.event, ids.outbox],
    );
    await admin.query("COMMIT");
    return ids;
  }
  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, '${actorUserId}@example.test', 'VAY-1287', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1070', '${organizationId}', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, '${propertyId}', 'VAY-1070 Property')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       ) VALUES ($1::uuid, 'pms', 'pms_property', $2, 'front_desk', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key, access_origin
       ) VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner', 'agency')`,
      [organizationId, actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements (
         organization_id, product, entitlement_key, status,
         resource_product, resource_type, resource_id
       ) VALUES (
         $1::uuid, 'pms', 'property-management', 'active', 'pms', 'pms_property', $2
       )`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, active, room_facts_revision, room_units_revision
       ) VALUES ($1::uuid, $2::uuid, 'VAY-1070 Room Type', '', TRUE, 1, 1)`,
      [roomTypeId, propertyId],
    );
  }
});
