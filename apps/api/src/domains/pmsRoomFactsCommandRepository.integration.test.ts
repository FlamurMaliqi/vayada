import {
  parseCreateRoomTypeFactsCommand,
  parseSafeDeleteRoomTypeCommand,
  parseUpdateRoomTypeFactsCommand,
  type CreateRoomTypeFactsCommand,
  type RoomTypeFacts,
  type SafeDeleteRoomTypeCommand,
  type UpdateRoomTypeFactsCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsRoomFactsCommandRepository } from "./pmsRoomFactsCommandRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "16800000-0000-4000-8000-000000000001";
const organizationId = "16800000-0000-4000-8000-000000000002";
const propertyId = "16800000-0000-4000-8000-000000000003";
const mediaObjectId = "16800000-0000-4000-8000-000000000004";
const activeUnitId = "16800000-0000-4000-8000-000000000005";
const retiredUnitId = "16800000-0000-4000-8000-000000000006";
const verifiedUnitId = "16800000-0000-4000-8000-000000000007";
const guestBookingId = "16800000-0000-4000-8000-000000000008";
const quoteSessionId = "16800000-0000-4000-8000-000000000009";
const ratePlanId = "16800000-0000-4000-8000-000000000010";
const roomBlockId = "16800000-0000-4000-8000-000000000011";
const assignmentId = "16800000-0000-4000-8000-000000000012";
const channelConnectionId = "16800000-0000-4000-8000-000000000013";
const channelMappingId = "16800000-0000-4000-8000-000000000014";
const publicationRevisionId = "16800000-0000-4000-8000-000000000015";
const domainEventId = "16800000-0000-4000-8000-000000000016";
const outboxEventId = "16800000-0000-4000-8000-000000000017";
const jobId = "16800000-0000-4000-8000-000000000018";
const inactivePublicationRevisionId = "16800000-0000-4000-8000-000000000019";
const failedPublicationAttemptId = "16800000-0000-4000-8000-000000000020";
const failedPublicationIdempotencyId = "16800000-0000-4000-8000-000000000021";
const failedPublicationDomainEventId = "16800000-0000-4000-8000-000000000022";
const failedPublicationOutboxEventId = "16800000-0000-4000-8000-000000000023";
const expiredQuoteSessionId = "16800000-0000-4000-8000-000000000024";
const unavailableQuoteSessionId = "16800000-0000-4000-8000-000000000025";
const activeRecurringSourceId = "16800000-0000-4000-8000-000000000026";
const disabledRecurringSourceId = "16800000-0000-4000-8000-000000000027";
const invalidRecurringSourceId = "16800000-0000-4000-8000-000000000028";
const nonRefundableRecurringSourceId = "16800000-0000-4000-8000-000000000029";
const recurringMaterializationReceiptId = "16800000-0000-4000-8000-000000000030";
const acceptedAt = "2026-08-03T13:00:00.000Z";
const roleKey = "vay1068_room_facts_integration";
const unexpectedReferenceTable = "pms.vay1068_unexpected_room_reference";
const auditFailureFunction = "platform.vay1068_fail_room_facts_audit";
const auditFailureTrigger = "trg_vay1068_fail_room_facts_audit";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS room-facts command repository", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createPgPmsRoomFactsCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date(acceptedAt),
    vocabularyValidator: {
      async validateRoomFactsVocabulary() {
        return { ok: true };
      },
    },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedProperty();
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("creates, exactly replays, updates by CAS, and safely tombstones independent facts", async () => {
    const create = createCommand("create-main", "setup-room-main", facts("Garden Suite"));
    const created = await repository.createRoomTypeFacts(create);
    expect(created).toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        roomType: { propertyId, roomFactsRevision: 1, lifecycle: "active" },
        draftRoomBinding: { propertyId, draftRoomId: "setup-room-main" },
      },
    });
    if (!created.ok) throw new Error("Expected room facts to be created");
    const roomTypeId = created.response.roomType.roomTypeId;

    await expect(repository.createRoomTypeFacts(create)).resolves.toEqual(created);
    await expect(auditCount("pms.room_facts.create")).resolves.toBe(1);
    await expect(idempotencyRows("pms.room_facts.create")).resolves.toEqual([
      { status: "completed", attempt: 1 },
    ]);

    await admin.query(
      `UPDATE pms.room_types
       SET occupancy_limits = occupancy_limits || '{"legacyOccupancy":"keep"}'::jsonb,
           room_attributes = room_attributes || '{"legacyAttribute":{"keep":true}}'::jsonb
       WHERE property_id = $1::uuid AND id = $2::uuid`,
      [propertyId, roomTypeId],
    );
    const update = updateCommand(
      "update-main",
      roomTypeId,
      1,
      facts("Updated Garden Suite", { maxGuests: 3, maxAdults: 2, maxChildren: 1 }),
    );
    await expect(repository.updateRoomTypeFacts(update)).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", roomType: { roomFactsRevision: 2 } },
    });
    await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
      name: "Updated Garden Suite",
      roomFactsRevision: "2",
      occupancyLimits: {
        total: 3,
        adults: 2,
        children: 1,
        legacyOccupancy: "keep",
      },
      roomAttributes: {
        bedrooms: 1,
        legacyAttribute: { keep: true },
      },
    });
    await expect(
      repository.updateRoomTypeFacts(
        updateCommand("update-stale", roomTypeId, 1, facts("Stale Update")),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "room_facts_revision_conflict", currentRevision: 2 },
    });
    await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
      name: "Updated Garden Suite",
      roomFactsRevision: "2",
    });

    await seedEligibleDeleteState(roomTypeId);
    await expect(
      repository.safeDeleteRoomType(safeDeleteCommand("delete-main", roomTypeId, 2)),
    ).resolves.toMatchObject({
      ok: true,
      response: { outcome: "deleted", roomTypeId, deletedRevision: 3, lifecycle: "inactive" },
    });
    await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
      name: "Updated Garden Suite",
      active: false,
      setupDraftRoomId: "setup-room-main",
      roomFactsRevision: "3",
      roomMediaRevision: "2",
      roomUnitsRevision: "2",
      occupancyLimits: { legacyOccupancy: "keep" },
      roomAttributes: { legacyAttribute: { keep: true } },
    });
    await expect(readUnitStates(roomTypeId)).resolves.toEqual([
      { roomUnitId: activeUnitId, status: "retired" },
      { roomUnitId: retiredUnitId, status: "retired" },
    ]);
    await expect(mediaState(roomTypeId)).resolves.toEqual({
      assignmentCount: "0",
      mediaObjectCount: "1",
    });

    const replacement = await repository.createRoomTypeFacts(
      createCommand("create-name-reuse", "setup-room-replacement", facts("Updated Garden Suite")),
    );
    expect(replacement).toMatchObject({
      ok: true,
      response: { outcome: "created", roomType: { lifecycle: "active" } },
    });
    if (!replacement.ok) throw new Error("Expected the inactive room name to be reusable");
    expect(replacement.response.roomType.roomTypeId).not.toBe(roomTypeId);
    await expect(readBinding("setup-room-main")).resolves.toEqual({
      roomTypeId,
      active: false,
    });

    const noAssets = await repository.createRoomTypeFacts(
      createCommand("create-no-assets", "setup-room-no-assets", facts("No Assets Room")),
    );
    if (!noAssets.ok) throw new Error("Expected no-assets room to be created");
    const noAssetsId = noAssets.response.roomType.roomTypeId;
    await expect(
      repository.safeDeleteRoomType(safeDeleteCommand("delete-no-assets", noAssetsId, 1)),
    ).resolves.toMatchObject({ ok: true, response: { deletedRevision: 2 } });
    await expect(readRoomType(noAssetsId)).resolves.toMatchObject({
      roomMediaRevision: "1",
      roomUnitsRevision: "1",
    });
  });

  it("rechecks authorization before replay after the committed scope is removed", async () => {
    const command = createCommand("scope-before-replay", "scope-draft", facts("Scope Room"));
    await expect(repository.createRoomTypeFacts(command)).resolves.toMatchObject({ ok: true });
    await expect(auditCount("pms.room_facts.create")).resolves.toBe(1);

    await admin.query(
      `UPDATE identity.organization_resource_links
       SET status = 'suspended'
       WHERE organization_id = $1::uuid
         AND product = 'pms'
         AND resource_type = 'pms_property'
         AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );

    await expect(repository.createRoomTypeFacts(command)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(auditCount("pms.room_facts.create")).resolves.toBe(1);
    await expect(idempotencyRows("pms.room_facts.create")).resolves.toEqual([
      { status: "completed", attempt: 1 },
    ]);
    await expect(roomTypeCount()).resolves.toBe(1);
  });

  it("serializes concurrent stale CAS commands with durable idempotency evidence", async () => {
    const created = await repository.createRoomTypeFacts(
      createCommand("create-concurrent", "concurrent-draft", facts("Concurrent Room")),
    );
    if (!created.ok) throw new Error("Expected concurrent fixture room to be created");
    const roomTypeId = created.response.roomType.roomTypeId;

    await admin.query("BEGIN");
    await admin.query(
      `SELECT pg_advisory_xact_lock(
         hashtext('pms.room_facts'),
         hashtext($1::uuid::text)
       )`,
      [propertyId],
    );
    const first = repository.updateRoomTypeFacts(
      updateCommand("concurrent-first", roomTypeId, 1, facts("Concurrent First")),
    );
    const second = repository.updateRoomTypeFacts(
      updateCommand("concurrent-second", roomTypeId, 1, facts("Concurrent Second")),
    );
    try {
      await waitForAdvisoryWaiters(propertyId, 2);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      await Promise.allSettled([first, second]);
      throw error;
    }

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: { code: "room_facts_revision_conflict", currentRevision: 2 },
      },
    ]);
    await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
      name: expect.stringMatching(/^Concurrent (First|Second)$/),
      roomFactsRevision: "2",
    });
    await expect(auditCount("pms.room_facts.update")).resolves.toBe(2);
    await expect(idempotencyRows("pms.room_facts.update")).resolves.toEqual([
      { status: "completed", attempt: 1 },
      { status: "completed", attempt: 1 },
    ]);
  });

  it("reports JSON, unit, pricing, calendar, block, and channel references as blockers", async () => {
    const created = await repository.createRoomTypeFacts(
      createCommand("create-blocked", "blocked-draft", facts("Blocked Room")),
    );
    if (!created.ok) throw new Error("Expected blocker fixture room to be created");
    const roomTypeId = created.response.roomType.roomTypeId;
    await seedDeleteBlockers(roomTypeId);
    await seedOperationalWorkReferences(roomTypeId);

    await expect(
      repository.safeDeleteRoomType(safeDeleteCommand("delete-blocked", roomTypeId, 1)),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "room_type_delete_blocked",
        currentRevision: 1,
        blockers: [
          { code: "published_reference", affectedCount: 1 },
          { code: "booking_reference", affectedCount: 3 },
          { code: "assigned_physical_unit", affectedCount: 1 },
          { code: "verified_physical_unit", affectedCount: 1 },
          { code: "rate_plan_or_rule", affectedCount: 1 },
          { code: "calendar_or_inventory", affectedCount: 1 },
          { code: "room_block", affectedCount: 1 },
          { code: "channel_mapping", affectedCount: 1 },
          { code: "other_operational_reference", affectedCount: 2 },
        ],
      },
    });
    await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
      active: true,
      roomFactsRevision: "1",
    });
    await expect(auditCount("pms.room_facts.safe_delete")).resolves.toBe(1);
    await expect(idempotencyRows("pms.room_facts.safe_delete")).resolves.toEqual([
      { status: "completed", attempt: 1 },
    ]);
  });

  it("aggregates every recurring pricing room reference and allows deletion after removal", async () => {
    const created = await repository.createRoomTypeFacts(
      createCommand("create-recurring-references", "recurring-draft", facts("Recurring Room")),
    );
    if (!created.ok) throw new Error("Expected recurring-reference fixture room to be created");
    const roomTypeId = created.response.roomType.roomTypeId;
    await seedRecurringPricingDeleteReferences(roomTypeId);

    const lifecycleCounts = await admin.query<{ lifecycle: string; count: string }>(
      `SELECT source.lifecycle, count(*)::text AS count
       FROM pms.recurring_pricing_source_room_values binding
       JOIN pms.recurring_pricing_sources source
         ON source.id = binding.source_id
        AND source.property_id = binding.property_id
        AND source.source_kind = binding.source_kind
       WHERE binding.property_id = $1::uuid AND binding.room_type_id = $2::uuid
       GROUP BY source.lifecycle
       ORDER BY CASE source.lifecycle
         WHEN 'active' THEN 1 WHEN 'disabled' THEN 2 WHEN 'invalid' THEN 3 ELSE 4 END`,
      [propertyId, roomTypeId],
    );
    expect(lifecycleCounts.rows).toEqual([
      { lifecycle: "active", count: "1" },
      { lifecycle: "disabled", count: "1" },
      { lifecycle: "invalid", count: "1" },
    ]);

    await expect(
      repository.safeDeleteRoomType(
        safeDeleteCommand("delete-recurring-references-blocked", roomTypeId, 1),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "room_type_delete_blocked",
        currentRevision: 1,
        blockers: [{ code: "rate_plan_or_rule", affectedCount: 6 }],
      },
    });
    await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
      active: true,
      roomFactsRevision: "1",
    });

    await admin.query(
      `DELETE FROM pms.recurring_pricing_materialized_rows
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeId],
    );
    await admin.query(
      `DELETE FROM pms.non_refundable_rate_plan_source_rooms
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeId],
    );
    await admin.query(
      `DELETE FROM pms.recurring_pricing_source_room_values
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeId],
    );
    await admin.query(
      `DELETE FROM pms.rate_plans
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeId],
    );
    const retainedEvidence = await admin.query<{
      sources: string;
      receipts: string;
      sourceReceipts: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM pms.recurring_pricing_sources
          WHERE property_id = $1::uuid) AS sources,
         (SELECT count(*)::text FROM pms.recurring_pricing_materialization_receipts
          WHERE property_id = $1::uuid) AS receipts,
         (SELECT count(*)::text FROM pms.recurring_pricing_materialization_source_receipts
          WHERE property_id = $1::uuid) AS "sourceReceipts"`,
      [propertyId],
    );
    expect(retainedEvidence.rows).toEqual([{ sources: "4", receipts: "1", sourceReceipts: "1" }]);

    await expect(
      repository.safeDeleteRoomType(
        safeDeleteCommand("delete-recurring-references-eligible", roomTypeId, 1),
      ),
    ).resolves.toMatchObject({
      ok: true,
      response: { outcome: "deleted", roomTypeId, deletedRevision: 2, lifecycle: "inactive" },
    });
  });

  it("ignores unactivated failed publication history and non-actionable quotes", async () => {
    const created = await repository.createRoomTypeFacts(
      createCommand("create-non-actionable", "non-actionable-draft", facts("Removable Room")),
    );
    if (!created.ok) throw new Error("Expected removable fixture room to be created");
    const roomTypeId = created.response.roomType.roomTypeId;
    await seedNonActionablePublicationHistory(roomTypeId);

    await expect(
      repository.safeDeleteRoomType(safeDeleteCommand("delete-non-actionable", roomTypeId, 1)),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "deleted",
        roomTypeId,
        deletedRevision: 2,
        lifecycle: "inactive",
      },
    });
    await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
      active: false,
      roomFactsRevision: "2",
    });
  });

  it("rolls back domain and idempotency state when the audit insert fails", async () => {
    await installAuditFailureTrigger();
    try {
      await expect(
        repository.createRoomTypeFacts(
          createCommand("audit-failure", "audit-failure-draft", facts("Audit Failure Room")),
        ),
      ).rejects.toThrow("injected VAY-1068 audit failure");
      await expect(roomTypeCount()).resolves.toBe(0);
      await expect(auditCount("pms.room_facts.create")).resolves.toBe(0);
      await expect(idempotencyRows("pms.room_facts.create")).resolves.toEqual([]);
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  it("rolls back an unavailable reference scan without audit or completed idempotency", async () => {
    const created = await repository.createRoomTypeFacts(
      createCommand("create-reference-check", "reference-check-draft", facts("Reference Check")),
    );
    if (!created.ok) throw new Error("Expected reference-check fixture room to be created");
    const roomTypeId = created.response.roomType.roomTypeId;
    const command = safeDeleteCommand("delete-reference-check", roomTypeId, 1);

    await admin.query(
      `CREATE TABLE ${unexpectedReferenceTable} (
         id UUID PRIMARY KEY,
         property_id UUID NOT NULL,
         room_type_id UUID NOT NULL,
         CONSTRAINT fk_vay1068_unexpected_room_reference
           FOREIGN KEY (room_type_id, property_id)
           REFERENCES pms.room_types(id, property_id)
       )`,
    );
    try {
      await expect(repository.safeDeleteRoomType(command)).resolves.toEqual({
        ok: false,
        error: {
          code: "room_type_delete_blocked",
          currentRevision: 1,
          blockers: [{ code: "reference_check_unavailable" }],
        },
      });
      await expect(auditCount("pms.room_facts.safe_delete")).resolves.toBe(0);
      await expect(idempotencyRows("pms.room_facts.safe_delete")).resolves.toEqual([]);
      await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
        active: true,
        roomFactsRevision: "1",
      });
    } finally {
      await admin.query(`DROP TABLE IF EXISTS ${unexpectedReferenceTable}`);
    }

    await expect(repository.safeDeleteRoomType(command)).resolves.toMatchObject({
      ok: true,
      response: { outcome: "deleted", deletedRevision: 2 },
    });
    await expect(auditCount("pms.room_facts.safe_delete")).resolves.toBe(1);
    await expect(idempotencyRows("pms.room_facts.safe_delete")).resolves.toEqual([
      { status: "completed", attempt: 1 },
    ]);
  });

  it("fails closed within the bounded wait when a shared reference table is contended", async () => {
    const created = await repository.createRoomTypeFacts(
      createCommand("create-lock-timeout", "lock-timeout-draft", facts("Lock Timeout Room")),
    );
    if (!created.ok) throw new Error("Expected lock-timeout fixture room to be created");
    const roomTypeId = created.response.roomType.roomTypeId;
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE booking.guest_bookings IN ACCESS EXCLUSIVE MODE");
    const startedAt = Date.now();
    try {
      await expect(
        repository.safeDeleteRoomType(safeDeleteCommand("delete-lock-timeout", roomTypeId, 1)),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: "room_type_delete_blocked",
          currentRevision: 1,
          blockers: [{ code: "reference_check_unavailable" }],
        },
      });
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      await expect(auditCount("pms.room_facts.safe_delete")).resolves.toBe(0);
      await expect(idempotencyRows("pms.room_facts.safe_delete")).resolves.toEqual([]);
      await expect(readRoomType(roomTypeId)).resolves.toMatchObject({
        active: true,
        roomFactsRevision: "1",
      });
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }

    await expect(
      repository.safeDeleteRoomType(safeDeleteCommand("delete-lock-timeout", roomTypeId, 1)),
    ).resolves.toMatchObject({
      ok: true,
      response: { outcome: "deleted", deletedRevision: 2 },
    });
    await expect(auditCount("pms.room_facts.safe_delete")).resolves.toBe(1);
    await expect(idempotencyRows("pms.room_facts.safe_delete")).resolves.toEqual([
      { status: "completed", attempt: 1 },
    ]);
  });

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1068-room-facts@example.test', 'VAY-1068 Room Facts', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1068 Room Facts', 'vay1068-room-facts', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1068-room-facts', 'VAY-1068 Room Facts')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key)
       VALUES ($1::uuid, $2::uuid, 'active', $3)`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
       VALUES ('hotel_group', $1, 'pms.operations.manage')
       ON CONFLICT DO NOTHING`,
      [roleKey],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [organizationId, propertyId],
    );
  }

  async function seedEligibleDeleteState(roomTypeId: string): Promise<void> {
    await admin.query(
      `INSERT INTO pms.rooms (
         id, property_id, room_type_id, source_system, room_number,
         status, operational_label_status
       ) VALUES
         ($1::uuid, $3::uuid, $4::uuid, 'pms', NULL, 'available', 'unverified'),
         ($2::uuid, $3::uuid, $4::uuid, 'pms', NULL, 'retired', 'unverified')`,
      [activeUnitId, retiredUnitId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO platform.media_objects (
         id, bucket, storage_key, storage_kind, visibility, purpose,
         owner_organization_id, property_id, resource_product, resource_type,
         resource_id, lifecycle_status, public_approved, created_by_user_id
       ) VALUES (
         $1::uuid, 'vayada-media-test', $2, 'vayada_managed', 'private',
         'pms.room_type.media', $3::uuid, $4::uuid, 'pms', 'room_type',
         $5, 'staged', FALSE, $6::uuid
       )`,
      [
        mediaObjectId,
        `private/media/${mediaObjectId}/original.webp`,
        organizationId,
        propertyId,
        roomTypeId,
        actorUserId,
      ],
    );
    await admin.query(
      `INSERT INTO pms.room_type_media (
         property_id, room_type_id, platform_media_object_id, alt_text, sort_order
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'Garden suite', 0)`,
      [propertyId, roomTypeId, mediaObjectId],
    );
  }

  async function seedRecurringPricingDeleteReferences(roomTypeId: string): Promise<void> {
    await admin.query(
      `INSERT INTO pms.property_pricing_settings (
         property_id, currency, pricing_currency_revision, optional_pricing_aggregate_revision
       ) VALUES ($1::uuid, 'EUR', 1, 0)`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.rate_plans (
         id, property_id, room_type_id, code, name, rate_type, meal_plan,
         payment_policy, deposit_policy, cancellation_policy_snapshot,
         base_rate_amount, currency, active, pricing_contract_version,
         flexible_rate_plan_revision, source_room_facts_revision,
         source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'ONB16-FLEX', 'Flexible', 'flexible', NULL,
         '{}'::jsonb, '{}'::jsonb,
         '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,
           "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
         100.00, 'EUR', TRUE, 'pms-pricing.v1', 1, 1, 1
       )`,
      [ratePlanId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.recurring_pricing_sources (
         id, property_id, source_kind, source_revision, configured_state,
         validation_state, validation_revision, validated_at, invalid_reasons,
         materialization_revision, currency, source_pricing_currency_revision,
         season_name, season_start_month, season_start_day, season_end_month, season_end_day,
         weekend_days, discount_percent, cancellation_terms_type,
         refund_policy, no_show_penalty, payment_timing
       ) VALUES
         (
           $1::uuid, $5::uuid, 'season', 1, 'active', 'valid', 1, $6::timestamptz,
           '[]'::jsonb, 1, 'EUR', 1, 'Winter', 1, 1, 1, 31,
           NULL, NULL, NULL, NULL, NULL, NULL
         ),
         (
           $2::uuid, $5::uuid, 'additional_guest', 1, 'disabled', 'valid', 1,
           $6::timestamptz, '[]'::jsonb, 0, 'EUR', 1,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
         ),
         (
           $3::uuid, $5::uuid, 'weekend_surcharge', 1, 'active', 'invalid', 1,
           $6::timestamptz, '[{"code":"dependency_unavailable"}]'::jsonb,
           0, 'EUR', 1, NULL, NULL, NULL, NULL, NULL,
           ARRAY['friday', 'saturday']::text[], NULL, NULL, NULL, NULL, NULL
         ),
         (
           $4::uuid, $5::uuid, 'non_refundable', 1, 'active', 'valid', 1,
           $6::timestamptz, '[]'::jsonb, 0, 'EUR', 1,
           NULL, NULL, NULL, NULL, NULL, NULL, 10, 'non_refundable',
           'no_refund', 'full_booking_amount', 'prepay_full'
         )`,
      [
        activeRecurringSourceId,
        disabledRecurringSourceId,
        invalidRecurringSourceId,
        nonRefundableRecurringSourceId,
        propertyId,
        acceptedAt,
      ],
    );
    await admin.query(
      `INSERT INTO pms.recurring_pricing_source_room_values (
         source_id, property_id, source_kind, room_type_id, source_room_facts_revision,
         flexible_rate_plan_id, flexible_pricing_contract_version,
         source_flexible_plan_revision, currency, source_pricing_currency_revision,
         seasonal_nightly_amount, weekend_surcharge_amount, maximum_adult_guests,
         included_guest_count, additional_guest_amount
       ) VALUES
         (
           $1::uuid, $4::uuid, 'season', $5::uuid, 1, $6::uuid,
           'pms-pricing.v1', 1, 'EUR', 1, 150.00, NULL, NULL, NULL, NULL
         ),
         (
           $2::uuid, $4::uuid, 'additional_guest', $5::uuid, 1, $6::uuid,
           'pms-pricing.v1', 1, 'EUR', 1, NULL, NULL, 2, 1, 25.00
         ),
         (
           $3::uuid, $4::uuid, 'weekend_surcharge', $5::uuid, 1, $6::uuid,
           'pms-pricing.v1', 1, 'EUR', 1, NULL, 15.00, NULL, NULL, NULL
         )`,
      [
        activeRecurringSourceId,
        disabledRecurringSourceId,
        invalidRecurringSourceId,
        propertyId,
        roomTypeId,
        ratePlanId,
      ],
    );
    await admin.query(
      `INSERT INTO pms.non_refundable_rate_plan_source_rooms (
         source_id, property_id, source_kind, room_type_id, flexible_rate_plan_id,
         flexible_pricing_contract_version, source_flexible_plan_revision,
         source_room_facts_revision, currency, source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, 'non_refundable', $3::uuid, $4::uuid,
         'pms-pricing.v1', 1, 1, 'EUR', 1
       )`,
      [nonRefundableRecurringSourceId, propertyId, roomTypeId, ratePlanId],
    );
    await admin.query(
      `INSERT INTO pms.recurring_pricing_materialization_receipts (
         id, property_id, horizon_start, horizon_end,
         optional_pricing_aggregate_revision, accepted_at
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-01-01', DATE '2026-01-01', 0, $3::timestamptz
       )`,
      [recurringMaterializationReceiptId, propertyId, acceptedAt],
    );
    await admin.query(
      `INSERT INTO pms.recurring_pricing_materialization_source_receipts (
         receipt_id, property_id, horizon_start, horizon_end,
         optional_pricing_aggregate_revision, source_id, source_kind, source_revision,
         configured_state, validation_state, validation_revision, validated_at,
         invalid_reasons, source_lifecycle, materialization_revision,
         currency, source_pricing_currency_revision, result, materialized_row_count,
         materialized_rows_sha256
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-01-01', DATE '2026-01-01', 0,
         $3::uuid, 'season', 1, 'active', 'valid', 1, $4::timestamptz,
         '[]'::jsonb, 'active', 1, 'EUR', 1, 'materialized', 1, repeat('a', 64)
       )`,
      [recurringMaterializationReceiptId, propertyId, activeRecurringSourceId, acceptedAt],
    );
    await admin.query(
      `INSERT INTO pms.recurring_pricing_materialized_rows (
         receipt_id, property_id, horizon_start, horizon_end,
         optional_pricing_aggregate_revision, source_id, source_kind, source_revision,
         source_lifecycle, materialization_revision, currency,
         source_pricing_currency_revision, room_type_id, stay_date,
         seasonal_nightly_amount
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-01-01', DATE '2026-01-01', 0,
         $3::uuid, 'season', 1, 'active', 1, 'EUR', 1,
         $4::uuid, DATE '2026-01-01', 150.00
       )`,
      [recurringMaterializationReceiptId, propertyId, activeRecurringSourceId, roomTypeId],
    );
  }

  async function seedDeleteBlockers(roomTypeId: string): Promise<void> {
    await admin.query(
      `INSERT INTO booking.quote_sessions (
         id, property_id, request_hash, public_quote_reference,
         requested_check_in, requested_check_out, currency,
         selected_offer_snapshot, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, 'quote-hash', 'VAY1068-QUOTE',
         DATE '2026-09-01', DATE '2026-09-02', 'EUR',
         jsonb_build_object('offer', jsonb_build_object('roomTypeId', $3::text)),
         TIMESTAMPTZ '2026-09-01T00:00:00Z'
       )`,
      [quoteSessionId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO booking.guest_bookings (
         id, property_id, public_reference, lifecycle_status,
         check_in, check_out, currency, booking_metadata
       ) VALUES (
         $1::uuid, $2::uuid, 'VAY1068-BOOKING', 'confirmed',
         DATE '2026-09-01', DATE '2026-09-02', 'EUR',
         jsonb_build_object('selection', jsonb_build_object('roomTypeId', $3::text))
       )`,
      [guestBookingId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.rooms (
         id, property_id, room_type_id, source_system, room_number,
         status, operational_label_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'pms', '101', 'available', 'verified')`,
      [verifiedUnitId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.operational_booking_assignments (
         id, property_id, guest_booking_id, room_type_id, room_id,
         position, assignment_status
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, 'assigned')`,
      [assignmentId, propertyId, guestBookingId, roomTypeId, verifiedUnitId],
    );
    await admin.query(
      `INSERT INTO pms.rate_plans (
         id, property_id, room_type_id, code, name, base_rate_amount, currency
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'FLEX', 'Flexible', 120, 'EUR')`,
      [ratePlanId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date,
         total_count, assigned_count, blocked_count, available_count
       ) VALUES ($1::uuid, $2::uuid, DATE '2026-09-01', 1, 0, 0, 1)`,
      [propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.room_blocks (
         id, property_id, room_type_id, starts_on, ends_on, blocked_count, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid,
         DATE '2026-09-01', DATE '2026-09-01', 1, 'Maintenance'
       )`,
      [roomBlockId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.channel_connections (id, property_id, provider, connection_status)
       VALUES ($1::uuid, $2::uuid, 'custom', 'connected')`,
      [channelConnectionId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.channel_room_type_mappings (
         id, property_id, connection_id, room_type_id, external_room_type_id
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'external-room-1')`,
      [channelMappingId, propertyId, channelConnectionId, roomTypeId],
    );
    const sourceManifest = {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [
        {
          ownerDomain: "pms",
          entityType: "room_type",
          entityId: roomTypeId,
          revision: "room-facts:1",
        },
      ],
    };
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, 1, 'onboarding-product-readiness.v1',
         $3::jsonb, $4, $5, 'booking', 'ready',
         jsonb_build_object('offers', jsonb_build_array(jsonb_build_object('roomTypeId', $6::text))),
         $7::uuid
       )`,
      [
        publicationRevisionId,
        propertyId,
        JSON.stringify(sourceManifest),
        `sha256:${"a".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        roomTypeId,
        actorUserId,
      ],
    );
    await admin.query(
      `INSERT INTO distribution.active_public_booking_revision (
         property_id, content_revision_id, activated_by_user_id, activated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)`,
      [propertyId, publicationRevisionId, actorUserId, acceptedAt],
    );
  }

  async function seedNonActionablePublicationHistory(roomTypeId: string): Promise<void> {
    const sourceManifest = {
      contractVersion: "onboarding-source-manifest.v1",
      propertyId,
      sources: [
        {
          ownerDomain: "pms",
          entityType: "room_type",
          entityId: roomTypeId,
          revision: "room-facts:1",
        },
      ],
    };
    await admin.query(
      `INSERT INTO distribution.public_booking_content_revisions (
         id, property_id, revision_number, readiness_contract_version,
         source_manifest, source_manifest_hash, readiness_hash,
         readiness_product, readiness_status, public_content, built_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, 1, 'onboarding-product-readiness.v1',
         $3::jsonb, $4, $5, 'booking', 'ready',
         jsonb_build_object('rooms', jsonb_build_array(jsonb_build_object('roomTypeId', $6::text))),
         $7::uuid
       )`,
      [
        inactivePublicationRevisionId,
        propertyId,
        JSON.stringify(sourceManifest),
        `sha256:${"c".repeat(64)}`,
        `sha256:${"d".repeat(64)}`,
        roomTypeId,
        actorUserId,
      ],
    );
    await admin.query(
      `INSERT INTO booking.quote_sessions (
         id, property_id, request_hash, public_quote_reference,
         requested_check_in, requested_check_out, currency, status,
         selected_offer_snapshot, expires_at
       ) VALUES
       (
         $1::uuid, $3::uuid, 'expired-quote-hash', 'VAY1068-EXPIRED-QUOTE',
         DATE '2026-09-01', DATE '2026-09-02', 'EUR', 'active',
         jsonb_build_object('roomTypeId', $4::text),
         $5::timestamptz - interval '1 second'
       ),
       (
         $2::uuid, $3::uuid, 'unavailable-quote-hash', 'VAY1068-UNAVAILABLE-QUOTE',
         DATE '2026-09-01', DATE '2026-09-02', 'EUR', 'unavailable',
         jsonb_build_object('roomTypeId', $4::text),
         $5::timestamptz + interval '1 day'
       )`,
      [expiredQuoteSessionId, unavailableQuoteSessionId, propertyId, roomTypeId, acceptedAt],
    );
    await admin.query(
      `INSERT INTO platform.idempotency_keys (
         id, operation_scope, operation, key_hash, request_fingerprint_hash,
         status, tenant_scope, property_id, response_status_code,
         response_body_hash, first_seen_at, last_seen_at, completed_at, expires_at
       ) VALUES (
         $1::uuid, 'booking', 'booking.publication.request',
         'vay1068-failed-publication-key', $2, 'completed', 'property', $3::uuid,
         202, $4, $5::timestamptz, $5::timestamptz, $5::timestamptz,
         $5::timestamptz + interval '24 hours'
       )`,
      [
        failedPublicationIdempotencyId,
        `sha256:${"e".repeat(64)}`,
        propertyId,
        `sha256:${"f".repeat(64)}`,
        acceptedAt,
      ],
    );
    await admin.query(
      `INSERT INTO platform.domain_events (
         id, source_system, event_key, event_type, occurred_at,
         tenant_scope, property_id, resource_product, resource_type, resource_id,
         actor_type, actor_user_id, payload
       ) VALUES (
         $1::uuid, 'booking', 'vay1068-failed-publication',
         'booking.publication.requested', $2::timestamptz,
         'property', $3::uuid, 'booking', 'booking_publication_attempt', $4,
         'user', $5::uuid, jsonb_build_object('sourceManifest', $6::jsonb)
       )`,
      [
        failedPublicationDomainEventId,
        acceptedAt,
        propertyId,
        failedPublicationAttemptId,
        actorUserId,
        JSON.stringify(sourceManifest),
      ],
    );
    await admin.query(
      `INSERT INTO platform.outbox_events (
         id, domain_event_id, outbox_key, destination, event_type,
         tenant_scope, property_id, resource_product, resource_type, resource_id,
         status, attempts_count, max_attempts, payload
       ) VALUES (
         $1::uuid, $2::uuid, 'vay1068-failed-publication',
         'distribution.booking-publication-projector', 'booking.publication.requested',
         'property', $3::uuid, 'booking', 'booking_publication_attempt', $4,
         'failed', 5, 5, jsonb_build_object('sourceManifest', $5::jsonb)
       )`,
      [
        failedPublicationOutboxEventId,
        failedPublicationDomainEventId,
        propertyId,
        failedPublicationAttemptId,
        JSON.stringify(sourceManifest),
      ],
    );
    await admin.query(
      `INSERT INTO booking.booking_publication_attempts (
         id, organization_id, property_id, idempotency_key_id,
         domain_event_id, outbox_event_id, request_fingerprint_hash,
         expected_active_content_revision_id, source_manifest,
         source_manifest_hash, readiness_hash, readiness_product, readiness_status,
         status, failure_code, requested_by_user_id, requested_at, updated_at, completed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7, NULL, $8::jsonb,
         $9, $10, 'booking', 'ready', 'failed', 'projection_failed',
         $11::uuid, $12::timestamptz, $12::timestamptz, $12::timestamptz
       )`,
      [
        failedPublicationAttemptId,
        organizationId,
        propertyId,
        failedPublicationIdempotencyId,
        failedPublicationDomainEventId,
        failedPublicationOutboxEventId,
        `sha256:${"1".repeat(64)}`,
        JSON.stringify(sourceManifest),
        `sha256:${"c".repeat(64)}`,
        `sha256:${"d".repeat(64)}`,
        actorUserId,
        acceptedAt,
      ],
    );
  }

  async function seedOperationalWorkReferences(roomTypeId: string): Promise<void> {
    await admin.query(
      `INSERT INTO platform.domain_events (
         id, source_system, event_key, event_type, occurred_at,
         tenant_scope, property_id, resource_product, resource_type, resource_id,
         actor_type, actor_user_id, payload
       ) VALUES (
         $1::uuid, 'pms', 'vay1068-room-work', 'pms.room.work.requested', $2::timestamptz,
         'property', $3::uuid, 'pms', 'room_type', $4,
         'user', $5::uuid,
         jsonb_build_object('sourceManifest', jsonb_build_object('roomTypeId', $4::text))
       )`,
      [domainEventId, acceptedAt, propertyId, roomTypeId, actorUserId],
    );
    await admin.query(
      `INSERT INTO platform.outbox_events (
         id, domain_event_id, outbox_key, destination, event_type,
         tenant_scope, property_id, resource_product, resource_type, resource_id,
         status, attempts_count, max_attempts, payload
       ) VALUES (
         $1::uuid, $2::uuid, 'vay1068-room-work', 'pms.room-work',
         'pms.room.work.requested', 'property', $3::uuid,
         'pms', 'room_type', $4, 'failed', 1, 5,
         jsonb_build_object('sourceManifest', jsonb_build_object('roomTypeId', $4::text))
       )`,
      [outboxEventId, domainEventId, propertyId, roomTypeId],
    );
    await admin.query(
      `INSERT INTO platform.jobs (
         id, job_key, queue_name, job_type,
         source_domain_event_id, source_outbox_event_id,
         status, locked_at, locked_by,
         tenant_scope, property_id, resource_product, resource_type, resource_id,
         payload
       ) VALUES (
         $1::uuid, 'vay1068-room-work', 'pms.room-work', 'pms.room.work',
         $2::uuid, $3::uuid, 'running', $4::timestamptz, 'vay1068-test-worker',
         'property', $5::uuid, 'pms', 'room_type', $6,
         jsonb_build_object('roomTypeId', $6::text)
       )`,
      [jobId, domainEventId, outboxEventId, acceptedAt, propertyId, roomTypeId],
    );
  }

  async function waitForAdvisoryWaiters(lockedPropertyId: string, expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_locks
         WHERE locktype = 'advisory'
           AND granted = FALSE
           AND mode = 'ExclusiveLock'
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid = hashtext('pms.room_facts')::oid
           AND objid = hashtext($1::uuid::text)::oid
           AND objsubid = 2`,
        [lockedPropertyId],
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Concurrent room-facts commands did not reach the advisory lock");
  }

  async function installAuditFailureTrigger(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query(
      `CREATE FUNCTION ${auditFailureFunction}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$
       BEGIN
         IF NEW.property_id = '${propertyId}'::uuid
            AND NEW.action = 'pms.room_facts.create' THEN
           RAISE EXCEPTION 'injected VAY-1068 audit failure';
         END IF;
         RETURN NEW;
       END;
       $function$`,
    );
    await admin.query(
      `CREATE TRIGGER ${auditFailureTrigger}
       BEFORE INSERT ON platform.product_audit_events
       FOR EACH ROW EXECUTE FUNCTION ${auditFailureFunction}()`,
    );
  }

  async function removeAuditFailureTrigger(): Promise<void> {
    await admin.query(
      `DROP TRIGGER IF EXISTS ${auditFailureTrigger} ON platform.product_audit_events`,
    );
    await admin.query(`DROP FUNCTION IF EXISTS ${auditFailureFunction}()`);
  }

  async function cleanup(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query(`DROP TABLE IF EXISTS ${unexpectedReferenceTable}`);
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      const deletes: Array<[string, string[]]> = [
        [
          "DELETE FROM pms.recurring_pricing_materialized_rows WHERE property_id = $1::uuid",
          [propertyId],
        ],
        [
          "DELETE FROM pms.recurring_pricing_materialization_source_receipts WHERE property_id = $1::uuid",
          [propertyId],
        ],
        [
          "DELETE FROM pms.recurring_pricing_materialization_receipts WHERE property_id = $1::uuid",
          [propertyId],
        ],
        [
          "DELETE FROM pms.non_refundable_rate_plan_source_rooms WHERE property_id = $1::uuid",
          [propertyId],
        ],
        [
          "DELETE FROM pms.recurring_pricing_source_room_values WHERE property_id = $1::uuid",
          [propertyId],
        ],
        ["DELETE FROM pms.recurring_pricing_sources WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.channel_room_type_mappings WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.channel_rate_plan_mappings WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.channel_connections WHERE property_id = $1::uuid", [propertyId]],
        [
          "DELETE FROM pms.operational_booking_assignments WHERE property_id = $1::uuid",
          [propertyId],
        ],
        ["DELETE FROM pms.room_blocks WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.inventory_days WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.rate_rules WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.rate_plans WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.room_type_media WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.rooms WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM pms.room_types WHERE property_id = $1::uuid", [propertyId]],
        [
          "DELETE FROM booking.booking_publication_attempts WHERE property_id = $1::uuid",
          [propertyId],
        ],
        ["DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM booking.quote_sessions WHERE property_id = $1::uuid", [propertyId]],
        [
          "DELETE FROM distribution.active_public_booking_revision WHERE property_id = $1::uuid",
          [propertyId],
        ],
        [
          "DELETE FROM distribution.public_booking_content_revisions WHERE property_id = $1::uuid",
          [propertyId],
        ],
        [
          "DELETE FROM distribution.public_room_offer_snapshots WHERE property_id = $1::uuid",
          [propertyId],
        ],
        [
          `DELETE FROM platform.job_attempts
           WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = $1::uuid)`,
          [propertyId],
        ],
        ["DELETE FROM platform.jobs WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [propertyId]],
        ["DELETE FROM platform.media_objects WHERE property_id = $1::uuid", [propertyId]],
        [
          "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
          [organizationId],
        ],
        [
          "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
          [organizationId],
        ],
        [
          "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
          [organizationId],
        ],
        ["DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]],
        ["DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]],
        ["DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]],
      ];
      for (const [statement, parameters] of deletes) {
        await admin.query(statement, parameters);
      }
      await admin.query(
        `DELETE FROM identity.role_permission_grants
         WHERE organization_kind = 'hotel_group' AND role_key = $1`,
        [roleKey],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function auditCount(operation: string): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid AND action = $2`,
      [propertyId, operation],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function idempotencyRows(
    operation: string,
  ): Promise<Array<{ status: string; attempt: number }>> {
    const result = await admin.query<{ status: string; attempt: number | string }>(
      `SELECT status, (idempotency_metadata ->> 'attempt')::integer AS attempt
       FROM platform.idempotency_keys
       WHERE property_id = $1::uuid AND operation = $2
       ORDER BY first_seen_at, id`,
      [propertyId, operation],
    );
    return result.rows.map(({ status, attempt }) => ({ status, attempt: Number(attempt) }));
  }

  async function roomTypeCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM pms.room_types WHERE property_id = $1::uuid",
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function readRoomType(roomTypeId: string) {
    const result = await admin.query(
      `SELECT
         name,
         active,
         setup_draft_room_id AS "setupDraftRoomId",
         room_facts_revision::text AS "roomFactsRevision",
         room_media_revision::text AS "roomMediaRevision",
         room_units_revision::text AS "roomUnitsRevision",
         occupancy_limits AS "occupancyLimits",
         room_attributes AS "roomAttributes"
       FROM pms.room_types
       WHERE property_id = $1::uuid AND id = $2::uuid`,
      [propertyId, roomTypeId],
    );
    return result.rows[0] ?? null;
  }

  async function readBinding(draftRoomId: string) {
    const result = await admin.query<{ roomTypeId: string; active: boolean }>(
      `SELECT id::text AS "roomTypeId", active
       FROM pms.room_types
       WHERE property_id = $1::uuid AND setup_draft_room_id = $2`,
      [propertyId, draftRoomId],
    );
    return result.rows[0] ?? null;
  }

  async function readUnitStates(roomTypeId: string) {
    const result = await admin.query<{ roomUnitId: string; status: string }>(
      `SELECT id::text AS "roomUnitId", status
       FROM pms.rooms
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       ORDER BY id`,
      [propertyId, roomTypeId],
    );
    return result.rows;
  }

  async function mediaState(roomTypeId: string) {
    const result = await admin.query<{ assignmentCount: string; mediaObjectCount: string }>(
      `SELECT
         (SELECT count(*)::text FROM pms.room_type_media
          WHERE property_id = $1::uuid AND room_type_id = $2::uuid) AS "assignmentCount",
         (SELECT count(*)::text FROM platform.media_objects
          WHERE property_id = $1::uuid AND id = $3::uuid) AS "mediaObjectCount"`,
      [propertyId, roomTypeId, mediaObjectId],
    );
    return result.rows[0]!;
  }
});

function facts(
  name: string,
  occupancy: RoomTypeFacts["occupancy"] = { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
): RoomTypeFacts {
  return {
    name,
    description: "A room facts integration fixture",
    category: "suite" as RoomTypeFacts["category"],
    occupancy,
    beds: [{ type: "queen" as RoomTypeFacts["beds"][number]["type"], quantity: 1 }],
    bedrooms: 1,
    bathrooms: 1,
    bathroomType: "private",
    size: { value: 28, unit: "sqm" },
  };
}

function createCommand(
  idempotencyKey: string,
  draftRoomId: string,
  roomFacts: RoomTypeFacts,
): CreateRoomTypeFactsCommand {
  const parsed = parseCreateRoomTypeFactsCommand({
    ...commandContext(idempotencyKey),
    draftRoomId,
    expectedRevision: 0,
    facts: roomFacts,
  });
  if (!parsed) throw new Error("Invalid create-room-facts integration command");
  return parsed;
}

function updateCommand(
  idempotencyKey: string,
  roomTypeId: string,
  expectedRevision: number,
  roomFacts: RoomTypeFacts,
): UpdateRoomTypeFactsCommand {
  const parsed = parseUpdateRoomTypeFactsCommand({
    ...commandContext(idempotencyKey),
    roomTypeId,
    expectedRevision,
    facts: roomFacts,
  });
  if (!parsed) throw new Error("Invalid update-room-facts integration command");
  return parsed;
}

function safeDeleteCommand(
  idempotencyKey: string,
  roomTypeId: string,
  expectedRevision: number,
): SafeDeleteRoomTypeCommand {
  const parsed = parseSafeDeleteRoomTypeCommand({
    ...commandContext(idempotencyKey),
    roomTypeId,
    expectedRevision,
  });
  if (!parsed) throw new Error("Invalid safe-delete integration command");
  return parsed;
}

function commandContext(idempotencyKey: string) {
  return {
    organizationId,
    propertyId,
    idempotencyKey,
    audit: {
      actor: { kind: "user" as const, userId: actorUserId },
      requestId: `request-${idempotencyKey}`,
      correlationId: `correlation-${idempotencyKey}`,
      requestedAt: acceptedAt,
    },
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
