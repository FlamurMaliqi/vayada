import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  buildRoomTypeInventoryHorizon,
  createTargetPmsOperationsCommandRepository,
  type PmsOperationsCommandPool,
} from "./domains/pmsOperationsCommandRepository.js";
import type {
  PmsCheckoutCharge,
  PmsCheckoutChargeCreateCommand,
  PmsCheckoutChargeMarkPaidCommand,
  PmsCheckoutChargeWaiveCommand,
  PmsOperationalTemplate,
  PmsOperationalTemplateUpdateCommand,
  PmsOperationsReadRepository,
  PmsPrivateNote,
  PmsPrivateNoteCreateCommand,
  PmsPrivateNoteUpdateCommand,
  PmsRoomType,
  PmsRoomTypeCreateCommand,
  PmsRoomTypeUpdateCommand,
} from "./routes/pmsOperations.js";

describe("PMS operations command repository", () => {
  it("edits a private note without replacing its creation evidence and replays safely", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });
    const created = await repository.createPrivateNote(privateNoteCreateCommand());
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("private note create unexpectedly failed");
    const command: PmsPrivateNoteUpdateCommand = {
      propertyId: defaultPropertyId,
      guestBookingId: defaultGuestBookingId,
      noteId: created.note.noteId,
      commandId: "cmd-private-note-update",
      idempotencyKey: "client-private-note-update",
      body: "Corrected private note",
      actorUserId: "f6852000-0000-4000-8000-000000000002",
      editorDisplayName: "Editor Host",
    };

    const updated = await repository.updatePrivateNote(command);
    const replay = await repository.updatePrivateNote(command);

    expect(updated).toMatchObject({
      ok: true,
      note: {
        body: "Corrected private note",
        authorDisplayName: created.note.authorDisplayName,
        createdAt: created.note.createdAt,
        auditMetadata: {
          editedByUserId: command.actorUserId,
          editedByDisplayName: "Editor Host",
        },
      },
    });
    expect(replay).toMatchObject({ ok: true, replayed: true, note: updated.ok && updated.note });
    expect(
      target.auditEvents.filter((event) => event.action === "pms.private_note.edited"),
    ).toHaveLength(1);
  });

  it("replays a private-note create from idempotency metadata after the note is hard-deleted", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });
    const createCommand = privateNoteCreateCommand({
      idempotencyKey: "client-private-note-create-replay",
    });

    const created = await repository.createPrivateNote(createCommand);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("private note create unexpectedly failed");
    target.stripPrivateNoteReplayEditMetadata();

    const deleted = await repository.deletePrivateNote({
      propertyId: createCommand.propertyId,
      guestBookingId: createCommand.guestBookingId,
      noteId: created.note.noteId,
      actorUserId: createCommand.actorUserId,
      commandId: "cmd-private-note-delete-replay-test",
      idempotencyKey: "client-private-note-delete-replay-test",
    });
    expect(deleted.ok).toBe(true);
    expect(target.notes).toHaveLength(0);

    const replay = await repository.createPrivateNote(createCommand);

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("private note create replay unexpectedly failed");
    expect(replay.note).toEqual(created.note);
    expect(replay.commandMeta).toEqual(created.commandMeta);
    expect(target.notes).toHaveLength(0);
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.booking_notes_private")),
    ).toHaveLength(1);
    expect(
      target.auditEvents.filter((event) => event.action === "pms.private_note.created"),
    ).toHaveLength(1);
    expect(target.auditEvents).toHaveLength(2);
  });

  it("scopes private-note audit keys by property and note when client idempotency keys are reused", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });
    const idempotencyKey = "client-reused-private-note-key";
    const otherPropertyId = "f6853000-0000-0000-0000-000000000002";

    const first = await repository.createPrivateNote(privateNoteCreateCommand({ idempotencyKey }));
    const second = await repository.createPrivateNote(
      privateNoteCreateCommand({
        propertyId: otherPropertyId,
        guestBookingId: "f6854000-0000-0000-0000-000000000002",
        commandId: "cmd-private-note-create-other-property",
        idempotencyKey,
      }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(target.auditEvents).toHaveLength(2);
    expect(target.auditEvents.map((event) => event.auditKey)).toEqual([
      expect.stringContaining(`property.${defaultPropertyId}.note.`),
      expect.stringContaining(`property.${otherPropertyId}.note.`),
    ]);
    expect(new Set(target.auditEvents.map((event) => event.auditKey)).size).toBe(2);
    for (const event of target.auditEvents) {
      expect(event.auditKey).toContain(`key.${sha256(idempotencyKey)}.v1`);
      expect(event.auditKey).not.toBe(`pms.private_note.created.${idempotencyKey}.v1`);
    }
  });

  it("reads and upserts PMS operational templates into the owned template tables", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });

    const emptyChecklist = await repository.getOperationalTemplate(
      defaultPropertyId,
      "check_in_checklist",
    );
    expect(emptyChecklist).toMatchObject({
      propertyId: defaultPropertyId,
      templateKind: "check_in_checklist",
      steps: [],
      updatedAt: null,
    });

    const checklist = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_in_checklist"),
    );
    const inspection = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_out_inspection", {
        commandId: "cmd-inspection-template",
        idempotencyKey: "client-inspection-template",
      }),
    );

    expect(checklist.ok).toBe(true);
    expect(inspection.ok).toBe(true);
    if (!checklist.ok || !inspection.ok) {
      throw new Error("template update unexpectedly failed");
    }
    expect(checklist.template).toMatchObject({
      propertyId: defaultPropertyId,
      templateKind: "check_in_checklist",
      steps: [{ stepId: "passport", label: "Verify passport", required: true }],
      updatedByUserId: "f6851000-0000-0000-0000-000000000001",
    });
    expect(inspection.template.templateKind).toBe("check_out_inspection");

    const replayedRead = await repository.getOperationalTemplate(
      defaultPropertyId,
      "check_in_checklist",
    );
    const replayedWrite = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_in_checklist"),
    );
    const conflictingWrite = await repository.updateOperationalTemplate(
      templateUpdateCommand("check_in_checklist", {
        steps: [{ stepId: "deposit", label: "Review deposit", required: false }],
      }),
    );

    expect(replayedRead.steps).toEqual(checklist.template.steps);
    expect(replayedWrite).toEqual(checklist);
    expect(conflictingWrite).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "idempotency_conflict",
    });
    expect(target.calls.some((call) => call.text.includes("pms.checkin_checklist_templates"))).toBe(
      true,
    );
    expect(
      target.calls.some((call) => call.text.includes("pms.checkout_inspection_templates")),
    ).toBe(true);
    expect(target.auditEvents.map((event) => event.action)).toEqual([
      "pms.check_in_checklist.updated",
      "pms.check_out_inspection.updated",
    ]);
    expect(
      target.calls.filter((call) =>
        call.text.includes("INSERT INTO pms.checkin_checklist_templates"),
      ),
    ).toHaveLength(1);
  });

  it("persists checkout charge operational commands without finance writes or outbox side effects", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });

    const create = await repository.createCheckoutCharge(checkoutChargeCreateCommand());
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error("checkout charge create unexpectedly failed");

    const listed = await repository.listCheckoutCharges(defaultPropertyId, defaultGuestBookingId);
    const paid = await repository.markCheckoutChargePaid(
      checkoutChargeMarkPaidCommand({ chargeId: create.charge.chargeId }),
    );
    const waived = await repository.waiveCheckoutCharge(
      checkoutChargeWaiveCommand({ chargeId: create.charge.chargeId }),
    );
    const replay = await repository.createCheckoutCharge(checkoutChargeCreateCommand());

    expect(listed).toHaveLength(1);
    expect(paid.ok).toBe(true);
    expect(waived.ok).toBe(true);
    expect(replay).toEqual({ ...create, replayed: true });
    if (!paid.ok || !waived.ok) {
      throw new Error("checkout charge state command unexpectedly failed");
    }
    expect(create.charge).toMatchObject({
      label: "Minibar",
      amount: { amountDecimal: "12.00", currency: "EUR" },
      status: "pending",
      operationalOwnership: {
        owner: "pms",
        financeSettlementOwner: "finance",
        providerSettlement: false,
      },
    });
    expect(paid.charge).toMatchObject({
      status: "paid",
      settledAt: "2026-08-14T17:01:00.000Z",
      operationalOwnership: { financeSettlementOwner: "finance", providerSettlement: false },
    });
    expect(waived.charge).toMatchObject({
      status: "waived",
      waivedAt: "2026-08-14T17:02:00.000Z",
      operationalOwnership: { financeSettlementOwner: "finance", providerSettlement: false },
    });
    expect(create.commandMeta.sideEffects).toEqual(["audit_event"]);
    expect(paid.commandMeta.sideEffects).toEqual(["audit_event"]);
    expect(waived.commandMeta.sideEffects).toEqual(["audit_event"]);
    expect(target.auditEvents.map((event) => event.action)).toEqual([
      "pms.checkout_charge.created",
      "pms.checkout_charge.marked_paid",
      "pms.checkout_charge.waived",
    ]);
    expect(target.calls.some((call) => call.text.includes("finance."))).toBe(false);
    expect(target.calls.some((call) => call.text.includes("platform.outbox_events"))).toBe(false);
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.booking_checkout_charges")),
    ).toHaveLength(1);
  });

  it("creates PMS room types with replay-safe inventory and distribution side effects", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });
    const command = roomTypeCreateCommand();

    const created = await repository.createRoomType(command);
    const replayed = await repository.createRoomType(command);
    const conflicting = await repository.createRoomType(
      roomTypeCreateCommand({
        name: "Junior Suite",
        idempotencyKey: command.idempotencyKey,
      }),
    );

    expect(created.ok).toBe(true);
    expect(replayed.ok).toBe(true);
    if (!created.ok || !replayed.ok) throw new Error("room type create unexpectedly failed");
    expect(created.roomType).toMatchObject({
      name: "Deluxe Double",
      category: "double",
      baseRate: { amountDecimal: "149.00", currency: "EUR" },
      roomCount: 2,
    });
    expect(created.roomType.ratePlans[0]).toMatchObject({
      ratePlanId: "f6855200-0000-0000-0000-000000000001",
      code: "FLEX",
    });
    expect(created.roomType.ratePlans[1]).toMatchObject({
      ratePlanId: "f6855200-0000-0000-0000-000000000002",
      code: "NRF",
      rateType: "non_refundable",
      baseRate: { amountDecimal: "129.00", currency: "EUR" },
    });
    expect(replayed).toEqual({ ...created, replayed: true });
    expect(conflicting).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "idempotency_conflict",
    });
    expect(created.commandMeta.sideEffects).toEqual([
      "ari_changed",
      "distribution_refresh",
      "audit_event",
    ]);
    expect(target.roomTypes).toHaveLength(1);
    expect(target.generatedRooms.map((room) => room.roomNumber)).toEqual([
      "Deluxe Double 1",
      "Deluxe Double 2",
    ]);
    expect(target.auditEvents.map((event) => event.action)).toEqual(["pms.room_type.created"]);
    const keyHash = sha256(command.idempotencyKey);
    const domainEventCalls = target.calls.filter((call) =>
      call.text.includes("platform.domain_events"),
    );
    const outboxCalls = target.calls.filter((call) => call.text.includes("platform.outbox_events"));
    const auditCall = target.calls.find((call) =>
      call.text.includes("INSERT INTO platform.product_audit_events"),
    );
    expect(domainEventCalls[0]?.values?.[0]).toBe(
      `pms.inventory.changed.room_type.property.${command.propertyId}.key.${keyHash}.v1`,
    );
    expect(outboxCalls[0]?.values?.[1]).toBe(
      `pms.ari_changed.room_type.property.${command.propertyId}.key.${keyHash}.v1`,
    );
    expect(outboxCalls[1]?.values?.[1]).toBe(
      `distribution.inventory_changed.room_type.property.${command.propertyId}.key.${keyHash}.v1`,
    );
    expect(auditCall?.text).toMatch(/'property',\s+NULL,\s+\$3::uuid/);
    expect(auditCall?.values?.[2]).toBe(command.propertyId);
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.room_types")),
    ).toHaveLength(1);
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.rate_plans")),
    ).toHaveLength(2);
    expect(target.calls.filter((call) => call.text.includes("INSERT INTO pms.rooms"))).toHaveLength(
      1,
    );
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.rate_rules")),
    ).toHaveLength(1);
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.inventory_days")),
    ).toHaveLength(1);
    expect(domainEventCalls).toHaveLength(1);
    expect(outboxCalls).toHaveLength(2);
  });

  it("serializes first-run room setup and rejects a second initial room type", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });

    const created = await repository.createRoomType(
      roomTypeCreateCommand({ initialSetupOnly: true }),
    );
    const competing = await repository.createRoomType(
      roomTypeCreateCommand({
        initialSetupOnly: true,
        commandId: "cmd-room-type-create-competing",
        idempotencyKey: "client-room-type-create-competing",
        name: "Competing Suite",
      }),
    );

    expect(created.ok).toBe(true);
    expect(competing).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "room_type_conflict",
    });
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO pms.room_types")),
    ).toHaveLength(1);
    expect(
      target.calls.some(
        (call) =>
          call.text.includes("pg_advisory_xact_lock") &&
          call.text.includes("pms-initial-room-setup:"),
      ),
    ).toBe(true);
    const lockCallIndex = target.calls.findIndex((call) =>
      call.text.includes("pg_advisory_xact_lock"),
    );
    const existenceCallIndex = target.calls.findIndex(
      (call) =>
        call.text.includes("SELECT EXISTS") && call.text.includes("FROM pms.room_types room_type"),
    );
    expect(lockCallIndex).toBeGreaterThanOrEqual(0);
    expect(existenceCallIndex).toBeGreaterThan(lockCallIndex);
  });

  it("materializes only the bounded explicit operating and season horizon", () => {
    const horizon = buildRoomTypeInventoryHorizon(
      roomTypeCreateCommand({
        roomCount: 3,
        operatingPeriods: [{ from: "08-01", to: "08-31" }],
        seasons: [
          {
            name: "Summer",
            tier: "high",
            from: "08-10",
            to: "08-20",
            rate: { amountDecimal: "210.00", currency: "EUR" },
            minStayNights: 2,
            maxStayNights: 7,
          },
        ],
      }),
      "2026-08-14T17:00:00.000Z",
    );

    expect(horizon).toHaveLength(366);
    expect(horizon[0]).toEqual({
      stayDate: "2026-08-14",
      status: "open",
      totalCount: 3,
      availableCount: 3,
      seasonIndex: 0,
      rateAmountDecimal: "210.00",
      minStayNights: 2,
      maxStayNights: 7,
    });
    expect(horizon.find((day) => day.stayDate === "2026-08-21")).toMatchObject({
      status: "closed",
      availableCount: 0,
      rateAmountDecimal: null,
    });
    expect(horizon.find((day) => day.stayDate === "2026-09-01")).toMatchObject({
      status: "closed",
      availableCount: 0,
    });
    expect(horizon.at(-1)?.stayDate).toBe("2027-08-14");
  });

  it("updates PMS room-type location with replay-safe idempotency", async () => {
    const target = targetPrivateNotesPool();
    const readRepository: PmsOperationsReadRepository = {
      ...unusedReadRepository,
      async findRoomTypeById(propertyId, roomTypeId) {
        const record = target.roomTypes.find(
          (item) => item.propertyId === propertyId && item.roomType.roomTypeId === roomTypeId,
        );
        return record ? structuredClone(record.roomType) : null;
      },
    };
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository,
      now: target.now,
    });
    const created = await repository.createRoomType(roomTypeCreateCommand());
    if (!created.ok) throw new Error("room type create unexpectedly failed");
    const command = roomTypeUpdateCommand(created.roomType.roomTypeId);

    const updated = await repository.updateRoomTypeLocation(command);
    const replayed = await repository.updateRoomTypeLocation(command);

    expect(updated.ok).toBe(true);
    expect(replayed.ok).toBe(true);
    if (!updated.ok || !replayed.ok) throw new Error("room type update unexpectedly failed");
    expect(updated.roomType.attributes).toMatchObject({
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
    });
    expect(replayed).toEqual({ ...updated, replayed: true });
    expect(updated.commandMeta.sideEffects).toEqual(["audit_event"]);
    expect(target.roomTypes[0]!.roomType.attributes).toMatchObject(updated.roomType.attributes);
    expect(target.auditEvents.map((event) => event.action)).toEqual([
      "pms.room_type.created",
      "pms.room_type.updated",
    ]);
    const updateAuditCall = target.calls.find((call) =>
      call.text.includes("'pms.room_type.updated'"),
    );
    expect(updateAuditCall?.text).toMatch(/'property',\s+NULL,\s+\$3::uuid/);
    expect(updateAuditCall?.values?.[2]).toBe(command.propertyId);
    expect(target.calls.filter((call) => call.text.includes("UPDATE pms.room_types"))).toHaveLength(
      1,
    );
  });

  it("rejects PMS room-type creates when generated room numbers collide", async () => {
    const target = targetPrivateNotesPool({ generatedRoomConflicts: 1 });
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });

    const result = await repository.createRoomType(
      roomTypeCreateCommand({
        commandId: "cmd-room-type-create-collision",
        idempotencyKey: "client-room-type-create-collision",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "room_type_conflict",
    });
    expect(target.auditEvents).toHaveLength(0);
    expect(target.calls.some((call) => call.text.includes("platform.outbox_events"))).toBe(false);
  });

  it("rejects checkout charge assignment IDs outside the reservation before insert", async () => {
    const target = targetPrivateNotesPool();
    const repository = createTargetPmsOperationsCommandRepository({
      connectionString: "postgresql://pms-target",
      pool: target.pool,
      readRepository: unusedReadRepository,
      now: target.now,
    });

    const result = await repository.createCheckoutCharge(
      checkoutChargeCreateCommand({
        commandId: "cmd-checkout-charge-stale-assignment",
        idempotencyKey: "client-checkout-charge-stale-assignment",
        assignmentId: "f6855500-0000-0000-0000-000000009999",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 400,
      code: "invalid_body",
    });
    expect(
      target.calls.some((call) => call.text.includes("INSERT INTO pms.booking_checkout_charges")),
    ).toBe(false);
    expect(target.auditEvents).toHaveLength(0);
  });
});

const defaultPropertyId = "f6853000-0000-0000-0000-000000000001";
const defaultGuestBookingId = "f6854000-0000-0000-0000-000000000001";

type QueryCall = {
  text: string;
  values?: readonly unknown[];
};

type PrivateNoteRecord = {
  propertyId: string;
  guestBookingId: string;
  note: PmsPrivateNote;
};

type TemplateRecord = {
  propertyId: string;
  template: PmsOperationalTemplate;
};

type CheckoutChargeRecord = {
  propertyId: string;
  guestBookingId: string;
  charge: PmsCheckoutCharge;
};

type RoomTypeRecord = {
  propertyId: string;
  roomType: PmsRoomType;
};

type GeneratedRoomRecord = {
  propertyId: string;
  roomTypeId: string;
  roomNumber: string;
};

type IdempotencyRecord = {
  status: "in_progress" | "completed";
  requestFingerprintHash: string;
  metadata: Record<string, unknown> | null;
};

function targetPrivateNotesPool(options: { generatedRoomConflicts?: number } = {}): {
  auditEvents: Array<{ auditKey: string; action: string }>;
  calls: QueryCall[];
  generatedRooms: GeneratedRoomRecord[];
  notes: PrivateNoteRecord[];
  now(): Date;
  pool: PmsOperationsCommandPool;
  roomTypes: RoomTypeRecord[];
  stripPrivateNoteReplayEditMetadata(): void;
} {
  const calls: QueryCall[] = [];
  const auditEvents: Array<{ auditKey: string; action: string }> = [];
  const auditKeys = new Set<string>();
  const idempotencyRows = new Map<string, IdempotencyRecord>();
  const notes = new Map<string, PrivateNoteRecord>();
  const roomTypes = new Map<string, RoomTypeRecord>();
  const generatedRooms: GeneratedRoomRecord[] = [];
  const templates = new Map<string, TemplateRecord>();
  const checkoutCharges = new Map<string, CheckoutChargeRecord>();
  const assignments = new Set([
    `${defaultPropertyId}:${defaultGuestBookingId}:f6855500-0000-0000-0000-000000000001`,
  ]);
  const reservations = new Set([
    `${defaultPropertyId}:${defaultGuestBookingId}`,
    `${"f6853000-0000-0000-0000-000000000002"}:${"f6854000-0000-0000-0000-000000000002"}`,
  ]);
  let noteSequence = 1;
  let checkoutChargeSequence = 1;
  let roomTypeSequence = 1;
  let ratePlanSequence = 1;
  let domainEventSequence = 1;
  let nowSequence = 0;

  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> => {
    calls.push({ text, values });

    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return emptyRows<T>();

    if (text.includes("FROM booking.guest_bookings")) {
      return reservations.has(`${String(values?.[0])}:${String(values?.[1])}`)
        ? rows([{ exists: 1 } as unknown as T])
        : emptyRows<T>();
    }

    if (text.includes("FROM platform.idempotency_keys")) {
      const key = idempotencyRecordKey(
        String(values?.[0]),
        String(values?.[2]),
        String(values?.[1]),
      );
      const record = idempotencyRows.get(key);
      return record
        ? rows([
            {
              status: record.status,
              requestFingerprintHash: record.requestFingerprintHash,
              idempotencyMetadata: record.metadata,
            } as unknown as T,
          ])
        : emptyRows<T>();
    }

    if (text.includes("FROM pms.operational_booking_assignments assignment")) {
      const [assignmentId, propertyId, guestBookingId] = values ?? [];
      return assignments.has(
        `${String(propertyId)}:${String(guestBookingId)}:${String(assignmentId)}`,
      )
        ? rows([{ exists: 1 } as unknown as T])
        : emptyRows<T>();
    }

    if (text.includes("pms-initial-room-setup:")) {
      return emptyRows<T>();
    }

    if (text.includes("SELECT EXISTS") && text.includes("FROM pms.room_types room_type")) {
      return rows([
        {
          roomSetupExists: [...roomTypes.values()].some(
            ({ propertyId }) => propertyId === String(values?.[0]),
          ),
        } as unknown as T,
      ]);
    }

    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      const key = idempotencyRecordKey(
        String(values?.[0]),
        String(values?.[3]),
        String(values?.[1]),
      );
      if (idempotencyRows.has(key)) return emptyRows<T>();
      idempotencyRows.set(key, {
        status: "in_progress",
        requestFingerprintHash: String(values?.[2]),
        metadata: JSON.parse(String(values?.[6])) as Record<string, unknown>,
      });
      return rows([{ id: `idem-${idempotencyRows.size}` } as unknown as T]);
    }

    if (text.includes("INSERT INTO pms.booking_notes_private")) {
      const noteId = `f6855900-0000-0000-0000-${String(noteSequence).padStart(12, "0")}`;
      noteSequence += 1;
      const note: PmsPrivateNote = {
        noteId,
        body: String(values?.[4]),
        authorUserId: String(values?.[2]),
        authorDisplayName: String(values?.[3]),
        createdAt: String(values?.[5]),
        auditMetadata: {
          source: "pms",
          createdByUserId: String(values?.[2]),
          createdByDisplayName: String(values?.[3]),
          createdAt: String(values?.[5]),
          editedByUserId: null,
          editedByDisplayName: null,
          editedAt: null,
          privacyScope: "internal",
        },
      };
      notes.set(noteId, {
        propertyId: String(values?.[0]),
        guestBookingId: String(values?.[1]),
        note,
      });
      return rows([
        {
          noteId,
          body: note.body,
          authorUserId: note.authorUserId,
          authorDisplayName: note.authorDisplayName,
          source: "pms",
          createdAt: note.createdAt,
          editedByUserId: null,
          editedByDisplayName: null,
          editedAt: null,
        } as unknown as T,
      ]);
    }

    if (text.includes("UPDATE pms.booking_notes_private")) {
      const record = notes.get(String(values?.[0]));
      if (
        !record ||
        record.propertyId !== String(values?.[1]) ||
        record.guestBookingId !== String(values?.[2])
      ) {
        return emptyRows<T>();
      }
      record.note.body = String(values?.[3]);
      record.note.auditMetadata.editedByUserId = String(values?.[4]);
      record.note.auditMetadata.editedByDisplayName = String(values?.[5]);
      record.note.auditMetadata.editedAt = String(values?.[6]);
      return rows([
        {
          noteId: record.note.noteId,
          body: record.note.body,
          authorUserId: record.note.authorUserId,
          authorDisplayName: record.note.authorDisplayName,
          source: "pms",
          createdAt: record.note.createdAt,
          editedByUserId: record.note.auditMetadata.editedByUserId,
          editedByDisplayName: record.note.auditMetadata.editedByDisplayName,
          editedAt: record.note.auditMetadata.editedAt,
        } as unknown as T,
      ]);
    }

    if (text.includes("INSERT INTO pms.room_types")) {
      const roomTypeId = `f6855100-0000-0000-0000-${String(roomTypeSequence).padStart(12, "0")}`;
      roomTypeSequence += 1;
      const roomType: PmsRoomType = {
        roomTypeId,
        name: String(values?.[1]),
        description: String(values?.[2]),
        category: values?.[3] ? String(values[3]) : null,
        occupancyLimits: JSON.parse(String(values?.[4])) as Record<string, number>,
        attributes: JSON.parse(String(values?.[5])) as PmsRoomType["attributes"],
        amenities: JSON.parse(String(values?.[6])) as string[],
        media: JSON.parse(String(values?.[7])) as PmsRoomType["media"],
        baseRate: { amountDecimal: String(values?.[8]), currency: String(values?.[9]) },
        active: Boolean(values?.[10]),
        sortOrder: Number(values?.[11]),
        ratePlans: [
          {
            ratePlanId: "pending",
            code: "FLEX",
            name: "Flexible",
            rateType: "flexible",
            mealPlan: null,
            baseRate: { amountDecimal: String(values?.[8]), currency: String(values?.[9]) },
            active: true,
          },
        ],
        rateRulesSummary: {
          minStayNights: null,
          maxStayNights: null,
          closedToArrival: false,
          closedToDeparture: false,
          activeRuleCount: 0,
        },
        roomCount: 0,
      };
      roomTypes.set(roomTypeId, { propertyId: String(values?.[0]), roomType });
      return rows([
        {
          roomTypeId,
          name: roomType.name,
          description: roomType.description,
          category: roomType.category,
          occupancyLimits: roomType.occupancyLimits,
          attributes: roomType.attributes,
          amenities: roomType.amenities,
          media: roomType.media,
          baseRateAmount: roomType.baseRate.amountDecimal,
          currency: roomType.baseRate.currency,
          active: roomType.active,
          sortOrder: roomType.sortOrder,
          roomCount: 0,
        } as unknown as T,
      ]);
    }

    if (text.includes("UPDATE pms.room_types")) {
      const [propertyId, roomTypeId, attributes] = values ?? [];
      const record = roomTypes.get(String(roomTypeId));
      if (!record || record.propertyId !== propertyId) return emptyRows<T>();
      record.roomType.attributes = {
        ...record.roomType.attributes,
        ...(JSON.parse(String(attributes)) as PmsRoomType["attributes"]),
      };
      return { rows: [] as T[], rowCount: 1 };
    }

    if (text.includes("INSERT INTO pms.rate_plans")) {
      const ratePlanId = `f6855200-0000-0000-0000-${String(ratePlanSequence).padStart(12, "0")}`;
      ratePlanSequence += 1;
      return rows([{ ratePlanId } as unknown as T]);
    }

    if (text.includes("INSERT INTO pms.rooms")) {
      const propertyId = String(values?.[0]);
      const roomTypeId = String(values?.[1]);
      const roomTypeName = String(values?.[2]);
      const count = Number(values?.[3]);
      const insertedCount = Math.max(0, count - (options.generatedRoomConflicts ?? 0));
      const createdRooms: Array<{ id: string }> = [];
      for (let position = 1; position <= insertedCount; position += 1) {
        const id = `f6855300-0000-0000-0000-${String(generatedRooms.length + 1).padStart(12, "0")}`;
        generatedRooms.push({
          propertyId,
          roomTypeId,
          roomNumber: `${roomTypeName} ${position}`,
        });
        createdRooms.push({ id });
      }
      return rows(createdRooms as unknown as T[]);
    }

    if (text.includes("FROM pms.booking_checkout_charges charge")) {
      if (text.includes("charge.id = $1::uuid")) {
        const [chargeId, propertyId, guestBookingId] = values ?? [];
        const record = checkoutCharges.get(String(chargeId));
        return record &&
          record.propertyId === propertyId &&
          record.guestBookingId === guestBookingId
          ? rows([toCheckoutChargeRow(record.charge) as unknown as T])
          : emptyRows<T>();
      }
      const [propertyId, guestBookingId] = values ?? [];
      return rows(
        [...checkoutCharges.values()]
          .filter(
            (record) =>
              record.propertyId === propertyId && record.guestBookingId === guestBookingId,
          )
          .map((record) => toCheckoutChargeRow(record.charge) as unknown as T),
      );
    }

    if (text.includes("INSERT INTO pms.booking_checkout_charges")) {
      const chargeId = `f6855700-0000-0000-0000-${String(checkoutChargeSequence).padStart(12, "0")}`;
      checkoutChargeSequence += 1;
      const charge: PmsCheckoutCharge = {
        chargeId,
        propertyId: String(values?.[0]),
        guestBookingId: String(values?.[1]),
        assignmentId: values?.[2] ? String(values[2]) : null,
        label: String(values?.[3]),
        amount: { amountDecimal: String(values?.[4]), currency: String(values?.[5]) },
        originalAmount: { amountDecimal: String(values?.[4]), currency: String(values?.[5]) },
        status: "pending",
        createdByUserId: values?.[6] ? String(values[6]) : null,
        createdAt: String(values?.[7]),
        settledAt: null,
        waivedAt: null,
        operationalOwnership: {
          owner: "pms",
          financeSettlementOwner: "finance",
          providerSettlement: false,
        },
      };
      checkoutCharges.set(chargeId, {
        propertyId: charge.propertyId,
        guestBookingId: charge.guestBookingId,
        charge,
      });
      return rows([toCheckoutChargeRow(charge) as unknown as T]);
    }

    if (text.includes("UPDATE pms.booking_checkout_charges")) {
      const [status, chargeId, propertyId, guestBookingId, acceptedAt] = values ?? [];
      const record = checkoutCharges.get(String(chargeId));
      if (!record || record.propertyId !== propertyId || record.guestBookingId !== guestBookingId) {
        return emptyRows<T>();
      }
      record.charge.status = status as PmsCheckoutCharge["status"];
      record.charge.settledAt = status === "paid" ? String(acceptedAt) : null;
      record.charge.waivedAt = status === "waived" ? String(acceptedAt) : null;
      return rows([toCheckoutChargeRow(record.charge) as unknown as T]);
    }

    if (text.includes("DELETE FROM pms.booking_notes_private")) {
      const [noteId, propertyId, guestBookingId] = values ?? [];
      const record = notes.get(String(noteId));
      if (!record || record.propertyId !== propertyId || record.guestBookingId !== guestBookingId) {
        return emptyRows<T>();
      }
      notes.delete(String(noteId));
      return rows([{ noteId } as unknown as T]);
    }

    if (
      text.includes("FROM pms.checkin_checklist_templates") ||
      text.includes("FROM pms.checkout_inspection_templates")
    ) {
      const templateKind = text.includes("pms.checkin_checklist_templates")
        ? "check_in_checklist"
        : "check_out_inspection";
      const record = templates.get(`${templateKind}:${String(values?.[0])}`);
      return record
        ? rows([
            {
              propertyId: record.propertyId,
              steps: record.template.steps,
              updatedByUserId: record.template.updatedByUserId,
              updatedAt: record.template.updatedAt,
            } as unknown as T,
          ])
        : emptyRows<T>();
    }

    if (
      text.includes("INSERT INTO pms.checkin_checklist_templates") ||
      text.includes("INSERT INTO pms.checkout_inspection_templates")
    ) {
      const templateKind = text.includes("pms.checkin_checklist_templates")
        ? "check_in_checklist"
        : "check_out_inspection";
      const propertyId = String(values?.[0]);
      const template: PmsOperationalTemplate = {
        propertyId,
        templateKind,
        steps: JSON.parse(String(values?.[1])) as PmsOperationalTemplate["steps"],
        updatedByUserId: String(values?.[2]),
        updatedAt: String(values?.[3]),
      };
      templates.set(`${templateKind}:${propertyId}`, { propertyId, template });
      return rows([
        {
          propertyId,
          steps: template.steps,
          updatedByUserId: template.updatedByUserId,
          updatedAt: template.updatedAt,
        } as unknown as T,
      ]);
    }

    if (text.includes("platform.domain_events")) {
      const eventId = `f6855e00-0000-0000-0000-${String(domainEventSequence).padStart(12, "0")}`;
      domainEventSequence += 1;
      return rows([{ eventId } as unknown as T]);
    }

    if (text.includes("INSERT INTO platform.outbox_events")) {
      return emptyRows<T>();
    }

    if (text.includes("INSERT INTO platform.product_audit_events")) {
      const auditKey = String(values?.[0]);
      if (!auditKeys.has(auditKey)) {
        auditKeys.add(auditKey);
        const action = text.includes("'pms.room_type.created'")
          ? "pms.room_type.created"
          : text.includes("'pms.room_type.updated'")
            ? "pms.room_type.updated"
            : String(values?.[1]);
        auditEvents.push({ auditKey, action });
      }
      return emptyRows<T>();
    }

    if (text.includes("UPDATE platform.idempotency_keys")) {
      const key = idempotencyRecordKey(
        String(values?.[4]),
        String(values?.[6]),
        String(values?.[5]),
      );
      const record = idempotencyRows.get(key);
      if (record) {
        record.status = "completed";
        record.metadata = JSON.parse(String(values?.[3])) as Record<string, unknown>;
      }
      return emptyRows<T>();
    }

    return emptyRows<T>();
  };

  const client = {
    query,
    release() {},
  };

  return {
    auditEvents,
    calls,
    get generatedRooms() {
      return generatedRooms;
    },
    get notes() {
      return [...notes.values()];
    },
    now() {
      const date = new Date(Date.UTC(2026, 7, 14, 17, nowSequence, 0));
      nowSequence += 1;
      return date;
    },
    pool: {
      async connect() {
        return client;
      },
      async end() {},
    },
    get roomTypes() {
      return [...roomTypes.values()];
    },
    stripPrivateNoteReplayEditMetadata() {
      for (const record of idempotencyRows.values()) {
        const note = record.metadata?.["note"] as PmsPrivateNote | undefined;
        if (!note) continue;
        const audit = note.auditMetadata as Partial<PmsPrivateNote["auditMetadata"]>;
        delete audit.editedByUserId;
        delete audit.editedByDisplayName;
        delete audit.editedAt;
      }
    },
  };
}

function roomTypeCreateCommand(
  overrides: Partial<PmsRoomTypeCreateCommand> = {},
): PmsRoomTypeCreateCommand {
  const command: PmsRoomTypeCreateCommand = {
    propertyId: defaultPropertyId,
    commandId: "cmd-room-type-create",
    idempotencyKey: "client-room-type-create",
    name: "Deluxe Double",
    description: "Upper-floor double room",
    category: "double",
    occupancyLimits: { maxAdults: 2, maxChildren: 1, maxOccupancy: 3 },
    attributes: { bedType: "queen", smoking: false },
    amenities: ["wifi", "breakfast"],
    media: [{ url: "https://cdn.example.test/deluxe.jpg", altText: "Deluxe Double" }],
    baseRate: { amountDecimal: "149.00", currency: "EUR" },
    nonRefundableRate: { amountDecimal: "129.00", currency: "EUR" },
    operatingPeriods: [{ from: "01-01", to: "12-31" }],
    seasons: [
      {
        name: "Default",
        tier: "mid",
        from: "01-01",
        to: "12-31",
        rate: { amountDecimal: "149.00", currency: "EUR" },
        minStayNights: 1,
        maxStayNights: null,
      },
    ],
    active: true,
    sortOrder: 10,
    roomCount: 2,
    audit: roomTypeAudit("cmd-room-type-create", "Create room type"),
  };
  return {
    ...command,
    ...overrides,
    operatingPeriods: overrides.operatingPeriods ?? command.operatingPeriods,
    seasons: overrides.seasons ?? command.seasons,
  };
}

function roomTypeUpdateCommand(
  roomTypeId: string,
  overrides: Partial<PmsRoomTypeUpdateCommand> = {},
): PmsRoomTypeUpdateCommand {
  return {
    propertyId: defaultPropertyId,
    roomTypeId,
    commandId: "cmd-room-type-location-update",
    idempotencyKey: "client-room-type-location-update",
    attributes: {
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
    },
    audit: roomTypeAudit("cmd-room-type-location-update", "Update room type location"),
    ...overrides,
  };
}

function roomTypeAudit(commandId: string, reason: string): PmsRoomTypeCreateCommand["audit"] {
  return {
    actor: {
      kind: "user",
      userId: "f6851000-0000-0000-0000-000000000001",
      organizationId: "f6852000-0000-0000-0000-000000000001",
    },
    requestId: commandId,
    correlationId: commandId,
    reason,
    requestedAt: "2026-08-14T17:00:00.000Z",
  };
}

function checkoutChargeCreateCommand(
  overrides: Partial<PmsCheckoutChargeCreateCommand> = {},
): PmsCheckoutChargeCreateCommand {
  return {
    propertyId: defaultPropertyId,
    guestBookingId: defaultGuestBookingId,
    commandId: "cmd-checkout-charge-create",
    idempotencyKey: "client-checkout-charge-create",
    label: "Minibar",
    amountDecimal: "12.00",
    currency: "EUR",
    audit: checkoutChargeAudit("cmd-checkout-charge-create", "Create checkout charge"),
    ...overrides,
  };
}

function checkoutChargeMarkPaidCommand(
  overrides: Partial<PmsCheckoutChargeMarkPaidCommand> = {},
): PmsCheckoutChargeMarkPaidCommand {
  return {
    propertyId: defaultPropertyId,
    guestBookingId: defaultGuestBookingId,
    chargeId: "f6855700-0000-0000-0000-000000000001",
    commandId: "cmd-checkout-charge-paid",
    idempotencyKey: "client-checkout-charge-paid",
    audit: checkoutChargeAudit("cmd-checkout-charge-paid", "Mark checkout charge paid"),
    ...overrides,
  };
}

function checkoutChargeWaiveCommand(
  overrides: Partial<PmsCheckoutChargeWaiveCommand> = {},
): PmsCheckoutChargeWaiveCommand {
  return {
    propertyId: defaultPropertyId,
    guestBookingId: defaultGuestBookingId,
    chargeId: "f6855700-0000-0000-0000-000000000001",
    commandId: "cmd-checkout-charge-waive",
    idempotencyKey: "client-checkout-charge-waive",
    reason: "service recovery",
    audit: checkoutChargeAudit("cmd-checkout-charge-waive", "Waive checkout charge"),
    ...overrides,
  };
}

function checkoutChargeAudit(
  commandId: string,
  reason: string,
): PmsCheckoutChargeCreateCommand["audit"] {
  return {
    actor: {
      kind: "user",
      userId: "f6851000-0000-0000-0000-000000000001",
      organizationId: "f6852000-0000-0000-0000-000000000001",
    },
    requestId: commandId,
    correlationId: commandId,
    reason,
    requestedAt: "2026-08-14T17:00:00.000Z",
  };
}

function toCheckoutChargeRow(charge: PmsCheckoutCharge): Record<string, unknown> {
  return {
    chargeId: charge.chargeId,
    propertyId: charge.propertyId,
    guestBookingId: charge.guestBookingId,
    assignmentId: charge.assignmentId,
    label: charge.label,
    amountDecimal: charge.amount.amountDecimal,
    originalAmountDecimal: charge.originalAmount.amountDecimal,
    currency: charge.amount.currency,
    status: charge.status,
    createdByUserId: charge.createdByUserId,
    createdAt: charge.createdAt,
    settledAt: charge.settledAt,
    waivedAt: charge.waivedAt,
  };
}

function privateNoteCreateCommand(
  overrides: Partial<PmsPrivateNoteCreateCommand> = {},
): PmsPrivateNoteCreateCommand {
  return {
    propertyId: defaultPropertyId,
    guestBookingId: defaultGuestBookingId,
    actorUserId: "f6851000-0000-0000-0000-000000000001",
    authorDisplayName: "owner@example.com",
    commandId: "cmd-private-note-create-replay-test",
    idempotencyKey: "client-private-note-create",
    body: "Sentinel private note body: do not expose the anniversary surprise.",
    ...overrides,
  };
}

function templateUpdateCommand(
  templateKind: PmsOperationalTemplateUpdateCommand["templateKind"],
  overrides: Partial<PmsOperationalTemplateUpdateCommand> = {},
): PmsOperationalTemplateUpdateCommand {
  return {
    propertyId: defaultPropertyId,
    templateKind,
    actorUserId: "f6851000-0000-0000-0000-000000000001",
    commandId: "cmd-checklist-template",
    idempotencyKey: "client-checklist-template",
    steps: [{ stepId: "passport", label: "Verify passport", required: true }],
    ...overrides,
  };
}

function idempotencyRecordKey(operation: string, propertyId: string, keyHash: string): string {
  return `${operation}:${propertyId}:${keyHash}`;
}

function rows<T extends QueryResultRow>(items: T[]): { rows: T[]; rowCount: number } {
  return { rows: items, rowCount: items.length };
}

function emptyRows<T extends QueryResultRow>(): { rows: T[]; rowCount: number } {
  return rows<T>([]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const unusedReadRepository = {} as PmsOperationsReadRepository;
