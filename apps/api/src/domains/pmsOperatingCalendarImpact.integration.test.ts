import {
  parsePreviewPmsOperatingCalendarImpactCommand,
  parseUpsertPmsOperatingCalendarCommand,
  type PreviewPmsOperatingCalendarImpactCommand,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "./hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { createPgPmsOperatingCalendarCommandRepository } from "./pmsOperatingCalendarCommandRepository.js";
import {
  createPgPmsOperatingCalendarImpactService,
  type PmsOperatingCalendarImpactClient,
} from "./pmsOperatingCalendarImpact.js";
import { createPgPmsOperatingCalendarReadModel } from "./pmsOperatingCalendarReadModel.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const organizationId = "a7200000-0000-4000-8000-000000000001";
const propertyId = "a7200000-0000-4000-8000-000000000002";
const otherPropertyId = "a7200000-0000-4000-8000-000000000030";
const actorUserId = "a7200000-0000-4000-8000-000000000003";
const roomTypeA = "a7200000-0000-4000-8000-000000000004";
const roomTypeB = "a7200000-0000-4000-8000-000000000005";
const roomTypeC = "a7200000-0000-4000-8000-000000000006";
const acceptedAt = "2026-08-04T10:00:00.000Z";
const roleKey = "vay1117_calendar_impact_integration";
const secret = "vay1117-test-impact-confirmation-secret-32-bytes";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS operating-calendar impact confirmation", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const admin = new pg.Client({ connectionString });
  const profileEvidence = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString,
    max: 6,
  });
  const roomEvidence = createPgPmsRoomFactsReadModel({
    connectionString,
    max: 6,
    now: () => new Date(acceptedAt),
  });
  const impact = createPgPmsOperatingCalendarImpactService({
    connectionString,
    max: 6,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
    confirmationSecret: secret,
    now: () => new Date(acceptedAt),
  });
  const calendar = createPgPmsOperatingCalendarCommandRepository({
    connectionString,
    max: 6,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
    impactConfirmation: impact,
    now: () => new Date(acceptedAt),
  });
  const calendarRead = createPgPmsOperatingCalendarReadModel({
    connectionString,
    max: 6,
    propertyProfileEvidence: profileEvidence,
    roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
  });
  beforeAll(async () => {
    assertSafeTestDatabase(connectionString);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedProperty();
    await seedRooms();
  });

  afterAll(async () => {
    await cleanup();
    await calendarRead.close();
    await calendar.close();
    await impact.close();
    await roomEvidence.close();
    await profileEvidence.close();
    await admin.end();
  });

  it("returns aggregate-only booking, block, override, capacity, and coverage impacts", async () => {
    await configureAndSeedInventory();
    await reserveRoom("impact-booking", roomTypeA, "2026-08-05", "2026-08-06", 1);
    await addBlock(roomTypeA, "2026-08-05");
    await setManualLimit(roomTypeB, "2026-08-06", 1);

    const result = await impact.previewOperatingCalendarImpact(
      previewCommand("update-impact", {
        expectedCalendarRevision: 1,
        schedule: { mode: "recurring", periods: [{ startsOn: "08-04", endsOn: "08-04" }] },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      preview: {
        sourceRevisions: {
          calendarRevision: 1,
          propertyProfile: { revision: 7, timeZone: "Europe/Berlin" },
          inventory: { materializedRevision: 1, dayCount: 6, activeReservationCount: 1 },
        },
        impact: {
          categories: [
            "accepted_bookings_on_closing_dates",
            "operating_dates_close",
            "owner_overrides_on_changed_dates",
            "room_blocks_on_closing_dates",
          ],
          summary: {
            closingDateCount: 2,
            acceptedBookingCount: 1,
            acceptedBookedRoomNights: 1,
            blockedRoomNights: 1,
            ownerOverrideDateCount: 1,
          },
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("receiptId");
    expect(serialized).not.toContain("quoteSessionId");
    expect(serialized).not.toContain("guest");
  });

  it("previews initial setup over pristine onboarding inventory without treating it as canonical", async () => {
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count,
         assigned_count, blocked_count, available_count, status, source_freshness
       )
       SELECT $1::uuid, room_type_id, DATE '2026-08-04', total_count,
              0, 0, total_count, 'open',
              jsonb_build_object('pms', jsonb_build_object(
                'status', 'fresh', 'generatedAt', $4::timestamptz, 'horizonDays', 366
              ))
       FROM (VALUES ($2::uuid, 2), ($3::uuid, 3)) room(room_type_id, total_count)`,
      [propertyId, roomTypeA, roomTypeB, acceptedAt],
    );

    await expect(
      impact.previewOperatingCalendarImpact(previewCommand("legacy")),
    ).resolves.toMatchObject({
      ok: true,
      preview: {
        sourceRevisions: { calendarRevision: 0, inventory: { materializedRevision: null } },
        impact: { summary: { availableRoomNightsAdded: 0 } },
      },
    });
    const stored = await admin.query(
      `SELECT calendar_revision FROM pms.inventory_days WHERE property_id = $1::uuid`,
      [propertyId],
    );
    expect(stored.rows).toEqual([{ calendar_revision: null }, { calendar_revision: null }]);

    await admin.query(
      `UPDATE pms.inventory_days SET total_count = 3, available_count = 3
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeA],
    );
    await expect(
      impact.previewOperatingCalendarImpact(previewCommand("wrong-legacy-capacity")),
    ).rejects.toThrow("Canonical inventory exists without coverage");
    await admin.query(
      `UPDATE pms.inventory_days SET total_count = 2, available_count = 2
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeA],
    );
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id, room_type_id, stay_date, total_count,
         assigned_count, blocked_count, available_count, status, source_freshness
       ) VALUES (
         $1::uuid, $2::uuid, DATE '2026-08-04', 1, 0, 0, 1, 'open',
         jsonb_build_object('pms', jsonb_build_object(
           'status', 'fresh', 'generatedAt', $3::timestamptz, 'horizonDays', 366
         ))
       )`,
      [propertyId, roomTypeC, acceptedAt],
    );
    await expect(
      impact.previewOperatingCalendarImpact(previewCommand("unexpected-legacy-room")),
    ).rejects.toThrow("Canonical inventory exists without coverage");
    await admin.query(`DELETE FROM pms.inventory_days WHERE room_type_id = $1::uuid`, [roomTypeC]);

    await admin.query(
      `UPDATE pms.inventory_days SET source_freshness = source_freshness || '{"other":{}}'
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeA],
    );
    await expect(
      impact.previewOperatingCalendarImpact(previewCommand("malformed-legacy-freshness")),
    ).rejects.toThrow("Canonical inventory exists without coverage");
    await admin.query(
      `UPDATE pms.inventory_days SET source_freshness = source_freshness - 'other'
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeA],
    );

    await admin.query(
      `UPDATE pms.inventory_days
       SET assigned_count = 1, available_count = total_count - 1
       WHERE property_id = $1::uuid AND room_type_id = $2::uuid`,
      [propertyId, roomTypeA],
    );
    await expect(
      impact.previewOperatingCalendarImpact(previewCommand("occupied-legacy")),
    ).rejects.toThrow("Canonical inventory exists without coverage");
  });

  it("previews a fresh active-room-set change against the current calendar coverage", async () => {
    await configureAndSeedInventory();
    await admin.query(
      `UPDATE pms.room_types
       SET active = FALSE, room_facts_revision = room_facts_revision + 1
       WHERE property_id = $1::uuid AND id = $2::uuid`,
      [propertyId, roomTypeB],
    );
    const limits = [roomLimits()[0]!];
    const preview = await requiredPreview(
      previewCommand("fresh-room-set", {
        expectedCalendarRevision: 1,
        roomTypeLimits: limits,
      }),
    );
    expect(preview).toMatchObject({
      sourceRevisions: {
        calendarRevision: 1,
        roomTypes: [{ roomTypeId: roomTypeA }],
        inventory: { materializedRevision: 1, dayCount: 6 },
      },
      impact: {
        categories: ["starting_availability_decreases"],
        summary: { availableRoomNightsRemoved: 6 },
      },
    });
    await expect(
      calendar.upsertOperatingCalendar(
        finalCommand("fresh-room-set", preview.confirmation, {
          expectedCalendarRevision: 1,
          roomTypeLimits: limits,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, response: { configuration: { calendarRevision: 2 } } });
    await expect(
      impact.previewOperatingCalendarImpact(
        previewCommand("awaiting-materialization", {
          expectedCalendarRevision: 2,
          roomTypeLimits: limits,
        }),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "materialization_not_current" } });
  });

  it("waits for a booking/override writer and rejects the now-stale confirmation", async () => {
    await configureAndSeedInventory();
    const preview = await requiredPreview(
      previewCommand("stale-race", {
        expectedCalendarRevision: 1,
        schedule: { mode: "recurring", periods: [{ startsOn: "08-04", endsOn: "08-04" }] },
      }),
    );
    const command = finalCommand("stale-race", preview.confirmation, {
      expectedCalendarRevision: 1,
      schedule: { mode: "recurring", periods: [{ startsOn: "08-04", endsOn: "08-04" }] },
    });
    const writer = new pg.Client({ connectionString });
    await writer.connect();
    try {
      await writer.query("BEGIN");
      await lockPmsInventoryMutationScope(writer, propertyId);
      await mutateManualLimit(writer, roomTypeA, "2026-08-05", 1);
      const pending = calendar.upsertOperatingCalendar(command);
      await waitForAdvisoryWaiters(1);
      await writer.query("COMMIT");
      await expect(pending).resolves.toEqual({
        ok: false,
        error: { code: "impact_confirmation_stale" },
      });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await writer.end();
    }
    await expect(
      calendarRead.getCurrentOperatingCalendarConfiguration(propertyId),
    ).resolves.toMatchObject({ configuration: { calendarRevision: 1 } });
  });

  it("holds the shared inventory lock through final recomputation and safely replays acceptance", async () => {
    await configureAndSeedInventory();
    const preview = await requiredPreview(
      previewCommand("accepted-race", {
        expectedCalendarRevision: 1,
        schedule: { mode: "recurring", periods: [{ startsOn: "08-04", endsOn: "08-06" }] },
        defaultMinimumStayNights: 3,
      }),
    );
    const command = finalCommand("accepted-race", preview.confirmation, {
      expectedCalendarRevision: 1,
      schedule: { mode: "recurring", periods: [{ startsOn: "08-04", endsOn: "08-06" }] },
      defaultMinimumStayNights: 3,
    });
    let releaseVerification!: () => void;
    let signalVerification!: () => void;
    const reachedVerification = new Promise<void>((resolve) => {
      signalVerification = resolve;
    });
    const verificationReleased = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const gated = createPgPmsOperatingCalendarCommandRepository({
      connectionString,
      max: 4,
      propertyProfileEvidence: profileEvidence,
      roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
      impactConfirmation: {
        async verifyLockedImpactConfirmation(input) {
          signalVerification();
          await verificationReleased;
          return impact.verifyLockedImpactConfirmation(input);
        },
      },
      now: () => new Date(acceptedAt),
    });
    const writer = new pg.Client({ connectionString });
    await writer.connect();
    try {
      const pending = gated.upsertOperatingCalendar(command);
      await reachedVerification;
      await writer.query("BEGIN");
      const pendingWriterLock = lockPmsInventoryMutationScope(writer, propertyId);
      await waitForAdvisoryWaiters(1);
      releaseVerification();
      await expect(pending).resolves.toMatchObject({
        ok: true,
        response: { outcome: "updated", configuration: { calendarRevision: 2 } },
      });
      await pendingWriterLock;
      await mutateManualLimit(writer, roomTypeA, "2026-08-05", 1);
      await writer.query("COMMIT");
      await expect(gated.upsertOperatingCalendar(command)).resolves.toMatchObject({
        ok: true,
        response: { configuration: { calendarRevision: 2 } },
      });
    } finally {
      releaseVerification?.();
      await writer.query("ROLLBACK").catch(() => undefined);
      await writer.end();
      await gated.close();
    }
  });

  it("rejects an expired confirmation before writing a new calendar revision", async () => {
    const preview = await requiredPreview(previewCommand("expired"));
    const expiredCalendar = createPgPmsOperatingCalendarCommandRepository({
      connectionString,
      max: 4,
      propertyProfileEvidence: profileEvidence,
      roomEvidence: { roomFacts: roomEvidence, roomCapacity: roomEvidence },
      impactConfirmation: impact,
      now: () => new Date("2026-08-04T10:15:00.000Z"),
    });
    try {
      await expect(
        expiredCalendar.upsertOperatingCalendar(finalCommand("expired", preview.confirmation)),
      ).resolves.toEqual({ ok: false, error: { code: "impact_confirmation_expired" } });
    } finally {
      await expiredCalendar.close();
    }
  });

  it("rejects a confirmation replayed across property scope before source reads", async () => {
    const preview = await requiredPreview(previewCommand("cross-property"));
    const command = Object.freeze({
      ...finalCommand("cross-property", preview.confirmation),
      propertyId: otherPropertyId,
    });
    await expect(
      impact.verifyLockedImpactConfirmation({
        client: admin as unknown as PmsOperatingCalendarImpactClient,
        proposal: command,
        command,
        acceptedAt: new Date(acceptedAt),
        profile: {
          source: {
            ownerDomain: "hotel_catalog",
            entityType: "property_profile",
            entityId: otherPropertyId,
            revision: "profile:7",
          },
          timeZone: "Europe/Berlin" as never,
        },
        roomBindings: [],
        currentConfiguration: null,
      }),
    ).resolves.toEqual({ code: "impact_confirmation_invalid" });
  });

  it("invalidates confirmations for every named mutable source", async () => {
    const cases = [
      {
        name: "booking",
        expectedCode: "impact_confirmation_stale",
        mutate: () => reserveRoom("stale-booking", roomTypeA, "2026-08-05", "2026-08-06", 1),
      },
      {
        name: "block",
        expectedCode: "impact_confirmation_stale",
        mutate: () => addBlock(roomTypeA, "2026-08-05"),
      },
      {
        name: "override",
        expectedCode: "impact_confirmation_stale",
        mutate: () => setManualLimit(roomTypeA, "2026-08-05", 1),
      },
      {
        name: "room facts",
        expectedCode: "room_facts_revision_conflict",
        mutate: async () => {
          await admin.query(
            `UPDATE pms.room_types SET room_facts_revision = room_facts_revision + 1
             WHERE property_id = $1::uuid AND id = $2::uuid`,
            [propertyId, roomTypeA],
          );
        },
      },
      {
        name: "room capacity revision",
        expectedCode: "room_units_revision_conflict",
        mutate: async () => {
          await admin.query(
            `UPDATE pms.room_types SET room_units_revision = room_units_revision + 1
             WHERE property_id = $1::uuid AND id = $2::uuid`,
            [propertyId, roomTypeA],
          );
        },
      },
      {
        name: "active room set",
        expectedCode: "room_type_set_conflict",
        mutate: async () => {
          await admin.query(
            `UPDATE pms.room_types SET active = FALSE, room_facts_revision = room_facts_revision + 1
             WHERE property_id = $1::uuid AND id = $2::uuid`,
            [propertyId, roomTypeB],
          );
        },
      },
      {
        name: "property profile",
        expectedCode: "property_profile_revision_conflict",
        mutate: async () => {
          await admin.query(
            `UPDATE hotel_catalog.properties SET profile_revision = profile_revision + 1
             WHERE id = $1::uuid`,
            [propertyId],
          );
        },
      },
      {
        name: "property timezone",
        expectedCode: "impact_confirmation_stale",
        mutate: async () => {
          await admin.query(
            `UPDATE hotel_catalog.property_locations SET timezone = 'Europe/Paris'
             WHERE property_id = $1::uuid`,
            [propertyId],
          );
        },
      },
      {
        name: "calendar",
        expectedCode: "calendar_revision_conflict",
        expectedRevision: 2,
        mutate: async () => {
          const winner = await requiredPreview(
            previewCommand("source-calendar-winner", {
              expectedCalendarRevision: 1,
              defaultMinimumStayNights: 4,
            }),
          );
          await expect(
            calendar.upsertOperatingCalendar(
              finalCommand("source-calendar-winner", winner.confirmation, {
                expectedCalendarRevision: 1,
                defaultMinimumStayNights: 4,
              }),
            ),
          ).resolves.toMatchObject({ ok: true });
        },
      },
    ] as const;

    for (const [index, source] of cases.entries()) {
      if (index > 0) {
        await cleanup();
        await seedAuthorizedProperty();
        await seedRooms();
      }
      await configureAndSeedInventory();
      const preview = await requiredPreview(
        previewCommand(`source-${source.name}`, {
          expectedCalendarRevision: 1,
          defaultMinimumStayNights: 3,
        }),
      );
      await source.mutate();
      const result = await calendar.upsertOperatingCalendar(
        finalCommand(`source-${source.name}`, preview.confirmation, {
          expectedCalendarRevision: 1,
          defaultMinimumStayNights: 3,
        }),
      );
      expect(result, source.name).toMatchObject({
        ok: false,
        error: { code: source.expectedCode },
      });
      await expect(latestCalendarRevision()).resolves.toBe(
        "expectedRevision" in source ? source.expectedRevision : 1,
      );
    }
  });

  it("rejects changed proposals and signature-altered confirmations", async () => {
    const preview = await requiredPreview(previewCommand("binding"));
    await expect(
      calendar.upsertOperatingCalendar(
        finalCommand("changed-proposal", preview.confirmation, {
          defaultMinimumStayNights: 3,
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "impact_confirmation_configuration_mismatch" },
    });

    const [claims, signature] = preview.confirmation.token.split(".");
    if (!claims || !signature) throw new Error("Invalid impact token fixture");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = alphabet.indexOf(signature.at(-1)!);
    if (finalIndex < 0) throw new Error("Invalid impact signature fixture");
    const equivalentLastCharacter = alphabet[finalIndex ^ 1];
    const tampered = {
      ...preview.confirmation,
      token: `${claims}.${signature.slice(0, -1)}${equivalentLastCharacter}`,
    };
    expect(Buffer.from(tampered.token.split(".")[1]!, "base64url")).toEqual(
      Buffer.from(signature, "base64url"),
    );
    await expect(
      calendar.upsertOperatingCalendar(finalCommand("tampered-signature", tampered)),
    ).resolves.toEqual({ ok: false, error: { code: "impact_confirmation_invalid" } });
    await expect(latestCalendarRevision()).resolves.toBe(0);
  });

  async function configureAndSeedInventory(): Promise<void> {
    const preview = await requiredPreview(previewCommand("initial"));
    await expect(
      calendar.upsertOperatingCalendar(finalCommand("initial", preview.confirmation)),
    ).resolves.toMatchObject({ ok: true, response: { configuration: { calendarRevision: 1 } } });
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `INSERT INTO pms.inventory_days (
           property_id, room_type_id, stay_date, total_count,
           assigned_count, blocked_count, available_count, status, source_freshness,
           calendar_revision, inventory_revision,
           generated_sellable_limit_count, effective_sellable_limit_count,
           generated_source_revision, channel_source_revision, manual_source_revision,
           block_source_revision, booking_source_revision
         )
         SELECT $1::uuid, room_type_id, stay_date, total_count,
                0, 0, 2, 'open', '{}'::jsonb,
                1, 1, 2, 2, 1, 0, 0, 0, 0
         FROM (VALUES ($2::uuid, 2), ($3::uuid, 3)) room(room_type_id, total_count)
         CROSS JOIN (VALUES
           (DATE '2026-08-04'), (DATE '2026-08-05'), (DATE '2026-08-06')
         ) day(stay_date)`,
        [propertyId, roomTypeA, roomTypeB],
      );
      await admin.query(
        `INSERT INTO pms.inventory_materialization_coverage (
           property_id, organization_id, calendar_revision, materialized_revision,
           coverage_from, coverage_through, room_type_count,
           expected_day_count, materialized_day_count,
           last_changed_materialization_idempotency_key_id,
           last_changed_materialization_domain_event_id,
           last_changed_materialization_outbox_event_id, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, 1, 1, DATE '2026-08-04', DATE '2026-08-06',
           2, 6, 6,
           'a7200000-0000-4000-8000-000000000021'::uuid,
           'a7200000-0000-4000-8000-000000000022'::uuid,
           'a7200000-0000-4000-8000-000000000023'::uuid,
           TIMESTAMPTZ '2026-08-04T10:00:00Z'
         )`,
        [propertyId, organizationId],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function requiredPreview(command: PreviewPmsOperatingCalendarImpactCommand) {
    const result = await impact.previewOperatingCalendarImpact(command);
    if (!result.ok) throw new Error(`Expected impact preview: ${result.error.code}`);
    return result.preview;
  }

  async function reserveRoom(
    suffix: string,
    roomTypeId: string,
    checkIn: string,
    checkOut: string,
    roomCount: number,
  ): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `INSERT INTO pms.inventory_reservation_receipts (
           receipt_id, contract_version, receipt_owner,
           organization_id, property_id, room_type_id,
           check_in, check_out, room_count, quote_session_id, public_offer_key,
           calendar_revision, materialized_revision, reserve_fingerprint_hash,
           reserve_idempotency_key_id, reserve_domain_event_id, reserve_outbox_event_id,
           reserved_at
         ) VALUES (
           'a7200000-0000-4000-8000-000000000020'::uuid,
           'pms-inventory-reservation-lifecycle.v1', 'pms',
           $1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6,
           $7, $8, 1, 1,
           'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'a7200000-0000-4000-8000-000000000024'::uuid,
           'a7200000-0000-4000-8000-000000000025'::uuid,
           'a7200000-0000-4000-8000-000000000026'::uuid,
           TIMESTAMPTZ '2026-08-04T09:00:00Z'
         )`,
        [
          organizationId,
          propertyId,
          roomTypeId,
          checkIn,
          checkOut,
          roomCount,
          `quote-${suffix}`,
          `offer-${suffix}`,
        ],
      );
      await admin.query(
        `INSERT INTO pms.inventory_reservation_statuses (
           receipt_id, organization_id, property_id, lifecycle_state, lifecycle_revision
         ) VALUES (
           'a7200000-0000-4000-8000-000000000020'::uuid,
           $1::uuid, $2::uuid, 'reserved', 1
         )`,
        [organizationId, propertyId],
      );
      await admin.query("SET LOCAL session_replication_role = origin");
      await admin.query(
        `UPDATE pms.inventory_days
         SET assigned_count = assigned_count + $5,
             available_count = GREATEST(0, effective_sellable_limit_count - assigned_count - $5 - blocked_count),
             inventory_revision = inventory_revision + 1,
             booking_source_revision = booking_source_revision + 1,
             updated_at = updated_at + interval '1 microsecond'
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid
           AND stay_date >= $3::date AND stay_date < $4::date`,
        [propertyId, roomTypeId, checkIn, checkOut, roomCount],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function addBlock(roomTypeId: string, stayDate: string): Promise<void> {
    await admin.query("BEGIN");
    try {
      await lockPmsInventoryMutationScope(admin, propertyId);
      await admin.query(
        `UPDATE pms.inventory_days
         SET blocked_count = blocked_count + 1,
             available_count = CASE WHEN status = 'closed' THEN 0
               ELSE GREATEST(0, effective_sellable_limit_count - assigned_count - blocked_count - 1)
             END,
             inventory_revision = inventory_revision + 1,
             block_source_revision = block_source_revision + 1,
             updated_at = updated_at + interval '1 microsecond'
         WHERE property_id = $1::uuid AND room_type_id = $2::uuid AND stay_date = $3::date`,
        [propertyId, roomTypeId, stayDate],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function setManualLimit(
    roomTypeId: string,
    stayDate: string,
    limit: number,
  ): Promise<void> {
    await admin.query("BEGIN");
    try {
      await lockPmsInventoryMutationScope(admin, propertyId);
      await mutateManualLimit(admin, roomTypeId, stayDate, limit);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1117@example.test', 'VAY-1117', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1117', 'vay1117', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_revision)
       VALUES ($1::uuid, 'vay1117', 'VAY-1117', 7)`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
       VALUES ($1::uuid, 'Europe/Berlin')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
      [organizationId, actorUserId, roleKey],
    );
    await admin.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
       VALUES ('hotel_group', $1, 'pms.operations.manage') ON CONFLICT DO NOTHING`,
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

  async function seedRooms(): Promise<void> {
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, occupancy_limits, room_attributes,
         active, room_facts_revision, room_units_revision
       ) VALUES
       ($1::uuid, $3::uuid, 'Garden Suite', '',
        '{"total":3,"adults":2,"children":1}'::jsonb,
        '{"beds":[{"type":"queen","quantity":1}],"bedrooms":1,"bathrooms":1,
          "bathroomType":"private","size":{"value":30,"unit":"sqm"}}'::jsonb,
        TRUE, 3, 5),
       ($2::uuid, $3::uuid, 'Loft Suite', '',
        '{"total":4,"adults":3,"children":1}'::jsonb,
        '{"beds":[{"type":"king","quantity":1}],"bedrooms":1,"bathrooms":1,
          "bathroomType":"private","size":{"value":40,"unit":"sqm"}}'::jsonb,
        TRUE, 4, 8),
       ($4::uuid, $3::uuid, 'Inactive Legacy Room', '',
        '{"total":1,"adults":1,"children":0}'::jsonb,
        '{"beds":[{"type":"single","quantity":1}],"bedrooms":1,"bathrooms":1,
          "bathroomType":"private","size":{"value":15,"unit":"sqm"}}'::jsonb,
        FALSE, 1, 1)`,
      [roomTypeA, roomTypeB, propertyId, roomTypeC],
    );
    for (const [roomId, roomTypeId, number] of [
      ["a7200000-0000-4000-8000-000000000011", roomTypeA, "A-101"],
      ["a7200000-0000-4000-8000-000000000012", roomTypeA, "A-102"],
      ["a7200000-0000-4000-8000-000000000013", roomTypeB, "B-201"],
      ["a7200000-0000-4000-8000-000000000014", roomTypeB, "B-202"],
      ["a7200000-0000-4000-8000-000000000015", roomTypeB, "B-203"],
    ] as const) {
      await admin.query(
        `INSERT INTO pms.rooms
           (id, property_id, room_type_id, room_number, status, operational_label_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'available', 'verified')`,
        [roomId, propertyId, roomTypeId, number],
      );
    }
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const statement of [
        "DELETE FROM pms.inventory_reservation_day_watermarks WHERE property_id = $1::uuid",
        "DELETE FROM pms.inventory_reservation_statuses WHERE property_id = $1::uuid",
        "DELETE FROM pms.inventory_reservation_receipts WHERE property_id = $1::uuid",
        "DELETE FROM pms.inventory_coverage_validation_queue WHERE property_id = $1::uuid",
        "DELETE FROM pms.inventory_materialization_coverage WHERE property_id = $1::uuid",
        "DELETE FROM pms.inventory_days WHERE property_id = $1::uuid",
        "DELETE FROM pms.operating_calendar_recurring_periods WHERE property_id = $1::uuid",
        "DELETE FROM pms.operating_calendar_room_bindings WHERE property_id = $1::uuid",
        "DELETE FROM pms.operating_calendar_revisions WHERE property_id = $1::uuid",
        "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
        "DELETE FROM pms.rooms WHERE property_id = $1::uuid",
        "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
        "DELETE FROM identity.product_entitlements WHERE organization_id = $2::uuid",
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $2::uuid",
        "DELETE FROM identity.organization_memberships WHERE organization_id = $2::uuid",
        "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
        "DELETE FROM hotel_catalog.properties WHERE id = $1::uuid",
        "DELETE FROM identity.organizations WHERE id = $2::uuid",
        "DELETE FROM identity.users WHERE id = $3::uuid",
      ]) {
        const parameter = statement.includes("$3")
          ? actorUserId
          : statement.includes("$2")
            ? organizationId
            : propertyId;
        await admin.query(statement.replaceAll(/\$[123]/g, "$1"), [parameter]);
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

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted`,
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for VAY-1117 lock contender");
  }

  async function latestCalendarRevision(): Promise<number> {
    const result = await admin.query<{ revision: number | string | null }>(
      `SELECT max(calendar_revision) AS revision
       FROM pms.operating_calendar_revisions WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return Number(result.rows[0]?.revision ?? 0);
  }
});

function previewCommand(
  suffix: string,
  overrides: Record<string, unknown> = {},
): PreviewPmsOperatingCalendarImpactCommand {
  const parsed = parsePreviewPmsOperatingCalendarImpactCommand({
    organizationId,
    propertyId,
    expectedCalendarRevision: 0,
    expectedPropertyProfileRevision: 7,
    schedule: { mode: "year_round", periods: [] },
    defaultMinimumStayNights: 2,
    roomTypeLimits: roomLimits(),
    audit: audit(`preview-${suffix}`),
    ...overrides,
  });
  if (!parsed) throw new Error("Invalid impact preview fixture");
  return parsed;
}

function finalCommand(
  suffix: string,
  impactConfirmation: UpsertPmsOperatingCalendarCommand["impactConfirmation"],
  overrides: Record<string, unknown> = {},
): UpsertPmsOperatingCalendarCommand {
  const parsed = parseUpsertPmsOperatingCalendarCommand({
    organizationId,
    propertyId,
    expectedCalendarRevision: 0,
    expectedPropertyProfileRevision: 7,
    schedule: { mode: "year_round", periods: [] },
    defaultMinimumStayNights: 2,
    roomTypeLimits: roomLimits(),
    impactConfirmation,
    idempotencyKey: `vay1117-calendar-${suffix}`,
    audit: audit(`calendar-${suffix}`),
    ...overrides,
  });
  if (!parsed) throw new Error("Invalid final calendar fixture");
  return parsed;
}

function roomLimits() {
  return [
    {
      roomTypeId: roomTypeA,
      expectedRoomFactsRevision: 3,
      expectedRoomUnitsRevision: 5,
      startingSellableLimitCount: 2,
    },
    {
      roomTypeId: roomTypeB,
      expectedRoomFactsRevision: 4,
      expectedRoomUnitsRevision: 8,
      startingSellableLimitCount: 2,
    },
  ];
}

function audit(suffix: string) {
  return {
    actor: { kind: "user" as const, userId: actorUserId },
    requestId: `request-${suffix}`,
    correlationId: `correlation-${suffix}`,
    requestedAt: acceptedAt,
  };
}

async function mutateManualLimit(
  client: pg.Client,
  roomTypeId: string,
  stayDate: string,
  limit: number,
): Promise<void> {
  const result = await client.query(
    `UPDATE pms.inventory_days
     SET manual_sellable_limit_count = $4,
         effective_sellable_limit_count = $4,
         available_count = CASE WHEN status = 'closed' THEN 0
           ELSE GREATEST(0, $4 - assigned_count - blocked_count)
         END,
         inventory_revision = inventory_revision + 1,
         manual_source_revision = manual_source_revision + 1,
         updated_at = updated_at + interval '1 microsecond'
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid AND stay_date = $3::date`,
    [propertyId, roomTypeId, stayDate, limit],
  );
  if (result.rowCount !== 1) throw new Error("Manual inventory source fixture did not update");
}

function assertSafeTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!/(test|vayada_ci)/.test(database)) {
    throw new Error("Refusing to run VAY-1117 integration tests against a non-test database");
  }
}
