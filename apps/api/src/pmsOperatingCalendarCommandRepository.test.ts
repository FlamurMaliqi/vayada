import { createHash } from "node:crypto";

import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseRoomTypeFactsSnapshot,
  parseUpsertPmsOperatingCalendarCommand,
  type PmsOperatingCalendarCommandResult,
  type PmsOperatingCalendarPropertyProfileEvidenceResult,
  type PmsOperatingCalendarRoomEvidencePorts,
  type RoomTypeCapacitySnapshot,
  type RoomTypeFactsSnapshot,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  createPgPmsOperatingCalendarCommandRepository,
  type PmsOperatingCalendarCommandClient,
  type PmsOperatingCalendarCommandPool,
} from "./domains/pmsOperatingCalendarCommandRepository.js";

const organizationId = "a5200000-0000-4000-8000-000000000001";
const propertyId = "a5200000-0000-4000-8000-000000000002";
const actorUserId = "a5200000-0000-4000-8000-000000000003";
const roomTypeA = "a5200000-0000-4000-8000-000000000004";
const roomTypeB = "a5200000-0000-4000-8000-000000000005";
const acceptedAt = "2026-08-04T09:30:00.000Z";

describe("PMS operating-calendar command repository", () => {
  it("creates one immutable revision under owner, facts, and sorted unit locks", async () => {
    const fixture = repositoryFixture();

    await expect(fixture.repository.upsertOperatingCalendar(command())).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        configuration: {
          calendarRevision: 1,
          source: { revision: "calendar:1" },
          sourceInputs: {
            propertyProfile: { revision: "profile:7" },
            propertyTimeZone: "Europe/Berlin",
            roomBindings: [
              {
                roomTypeId: roomTypeA,
                sourceRoomFactsRevision: 3,
                sourceRoomUnitsRevision: 5,
                physicalCapacityCount: 2,
                startingSellableLimitCount: 2,
              },
              {
                roomTypeId: roomTypeB,
                sourceRoomFactsRevision: 4,
                sourceRoomUnitsRevision: 8,
                physicalCapacityCount: 3,
                startingSellableLimitCount: 2,
              },
            ],
          },
        },
      },
    });

    expect(fixture.events[0]).toBe("owner:start");
    expect(fixture.events.at(-1)).toBe("owner:end");
    const sql = fixture.calls.map(({ text }) => text);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("FROM identity.organizations");
    expect(sql.findIndex((text) => text.includes("FROM platform.idempotency_keys"))).toBeLessThan(
      sql.findIndex((text) => text.includes("hashtext('pms.room_facts')")),
    );
    expect(
      fixture.calls
        .filter(({ text }) => text.includes("pms.physical-room-unit:"))
        .map(({ values }) => values),
    ).toEqual([
      [propertyId, roomTypeA],
      [propertyId, roomTypeB],
    ]);
    expect(fixture.events).toEqual([
      "owner:start",
      `capacity:${roomTypeA}`,
      `capacity:${roomTypeB}`,
      "owner:end",
    ]);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.some((text) => text.includes("hotel_catalog"))).toBe(false);

    const eventInsert = fixture.calls.find(({ text }) =>
      text.includes("INSERT INTO platform.domain_events"),
    );
    expect(JSON.parse(String(eventInsert?.values?.[7]))).toEqual({
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      eventType: "pms.operating_calendar.changed",
      destination: "pms.inventory-source",
      metadata: { sourceReadRequired: true },
      propertyId,
      calendarRevision: 1,
      sourceRevision: "calendar:1",
    });
  });

  it("authorizes before exact replay and emits no second audit, event, outbox, or revision", async () => {
    const fixture = repositoryFixture();
    const input = command();
    const first = await fixture.repository.upsertOperatingCalendar(input);
    expect(first.ok).toBe(true);
    const sideEffectCount = countSideEffects(fixture.calls);
    fixture.events.length = 0;

    await expect(fixture.repository.upsertOperatingCalendar(input)).resolves.toEqual(first);

    expect(countSideEffects(fixture.calls)).toEqual(sideEffectCount);
    const secondBegin = fixture.calls.map(({ text }) => text).lastIndexOf("BEGIN");
    const second = fixture.calls.slice(secondBegin).map(({ text }) => text);
    expect(second[1]).toContain("FROM identity.organizations");
    expect(second.some((text) => text.includes("FROM platform.idempotency_keys"))).toBe(true);
    expect(second.at(-1)).toBe("ROLLBACK");
    expect(fixture.events).toEqual([]);
  });

  it("rejects a changed fingerprint and unfinished reservation without source reads", async () => {
    const changed = repositoryFixture();
    const first = command();
    await changed.repository.upsertOperatingCalendar(first);
    changed.events.length = 0;

    await expect(
      changed.repository.upsertOperatingCalendar(
        command({ defaultMinimumStayNights: 4, idempotencyKey: first.idempotencyKey }),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    expect(changed.events).toEqual([]);

    const unfinished = repositoryFixture({
      replay: {
        status: "in_progress",
        requestFingerprintHash: fingerprintFor(first),
        responseStatusCode: null,
        responseBodyHash: null,
        idempotencyMetadata: {},
        expiresAt: "2026-08-05T09:30:00.000Z",
      },
    });
    await expect(unfinished.repository.upsertOperatingCalendar(first)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    expect(unfinished.events).toEqual([]);
  });

  it("preserves profile revision conflict precedence before timezone status and room locks", async () => {
    const fixture = repositoryFixture({
      profileResult: {
        status: "timezone_invalid",
        source: profileSource(8),
      },
    });

    await expect(fixture.repository.upsertOperatingCalendar(command())).resolves.toEqual({
      ok: false,
      error: { code: "property_profile_revision_conflict", currentRevision: 8 },
    });
    expect(fixture.calls.some(({ text }) => text.includes("hashtext('pms.room_facts')"))).toBe(
      false,
    );
    expect(countSql(fixture.calls, "INSERT INTO platform.product_audit_events")).toBe(1);
    expect(countSql(fixture.calls, "INSERT INTO platform.domain_events")).toBe(0);
  });

  it.each([
    {
      name: "room set",
      options: { facts: [facts(roomTypeA, 3)] },
      error: { code: "room_type_set_conflict", currentRoomTypeIds: [roomTypeA] },
    },
    {
      name: "facts revision",
      options: { facts: [facts(roomTypeA, 9), facts(roomTypeB, 4)] },
      error: { code: "room_facts_revision_conflict", roomTypeId: roomTypeA, currentRevision: 9 },
    },
    {
      name: "zero capacity",
      options: {
        capacities: new Map([
          [roomTypeA, capacity(roomTypeA, 5, 0)],
          [roomTypeB, capacity(roomTypeB, 8, 3)],
        ]),
      },
      error: { code: "room_capacity_unavailable", roomTypeId: roomTypeA },
    },
    {
      name: "unit revision",
      options: {
        capacities: new Map([
          [roomTypeA, capacity(roomTypeA, 6, 2)],
          [roomTypeB, capacity(roomTypeB, 8, 3)],
        ]),
      },
      error: { code: "room_units_revision_conflict", roomTypeId: roomTypeA, currentRevision: 6 },
    },
    {
      name: "sellable limit",
      options: {
        capacities: new Map([
          [roomTypeA, capacity(roomTypeA, 5, 1)],
          [roomTypeB, capacity(roomTypeB, 8, 3)],
        ]),
      },
      error: {
        code: "starting_sellable_limit_exceeds_capacity",
        roomTypeId: roomTypeA,
        physicalCapacityCount: 1,
      },
    },
  ])("returns the canonical $name conflict without a changed event", async ({ options, error }) => {
    const fixture = repositoryFixture(options);

    await expect(fixture.repository.upsertOperatingCalendar(command())).resolves.toEqual({
      ok: false,
      error,
    });
    expect(countSql(fixture.calls, "INSERT INTO platform.domain_events")).toBe(0);
    expect(countSql(fixture.calls, "INSERT INTO platform.product_audit_events")).toBe(1);
  });

  it("checks calendar CAS before reading rooms and records an unchanged canonical update", async () => {
    const stale = repositoryFixture({ latestRevision: 3 });
    await expect(stale.repository.upsertOperatingCalendar(command())).resolves.toEqual({
      ok: false,
      error: { code: "calendar_revision_conflict", currentRevision: 3 },
    });
    expect(stale.events.some((event) => event.startsWith("capacity:"))).toBe(false);

    const unchangedCommand = command({ expectedCalendarRevision: 1 });
    const unchanged = repositoryFixture({ latestRevision: 1, current: currentRows() });
    await expect(unchanged.repository.upsertOperatingCalendar(unchangedCommand)).resolves.toEqual({
      ok: false,
      error: { code: "operating_calendar_unchanged" },
    });
    expect(countSql(unchanged.calls, "INSERT INTO platform.domain_events")).toBe(0);
    expect(countSql(unchanged.calls, "INSERT INTO platform.product_audit_events")).toBe(1);
  });

  it("fails unauthorized scope before replay and preserves rollback/release error identity", async () => {
    const unauthorized = repositoryFixture({ authorized: false });
    await expect(unauthorized.repository.upsertOperatingCalendar(command())).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(
      unauthorized.calls.some(({ text }) => text.includes("FROM platform.idempotency_keys")),
    ).toBe(false);
    expect(unauthorized.events).toEqual([]);
    expect(unauthorized.calls.at(-1)?.text).toBe("ROLLBACK");

    const failure = new Error("capacity adapter failed");
    const broken = repositoryFixture({ capacityFailure: failure });
    await expect(broken.repository.upsertOperatingCalendar(command())).rejects.toBe(failure);
    expect(broken.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(broken.release).toHaveBeenCalledTimes(2);
  });

  it("closes only its owned pool and rejects an empty owned connection string", async () => {
    const fixture = repositoryFixture();
    await fixture.repository.close();
    expect(fixture.end).not.toHaveBeenCalled();

    expect(() =>
      createPgPmsOperatingCalendarCommandRepository({
        propertyProfileEvidence: fixture.profileEvidence,
        roomEvidence: fixture.roomEvidence,
      }),
    ).toThrow("connectionString must not be empty");
  });
});

type FakeReplay = {
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: string;
};

type FixtureOptions = {
  authorized?: boolean;
  latestRevision?: number;
  profileResult?: PmsOperatingCalendarPropertyProfileEvidenceResult;
  facts?: readonly RoomTypeFactsSnapshot[];
  capacities?: ReadonlyMap<string, RoomTypeCapacitySnapshot | null>;
  capacityFailure?: Error;
  replay?: FakeReplay;
  current?: ReturnType<typeof currentRows>;
};

function repositoryFixture(options: FixtureOptions = {}) {
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const events: string[] = [];
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  let replay = options.replay;
  const current = options.current;
  const client: PmsOperatingCalendarCommandClient = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("FROM identity.organizations")) {
        return dbResult(options.authorized === false ? [] : [{ id: propertyId }]);
      }
      if (text.includes("FROM identity.product_entitlements")) {
        return dbResult([{ status: "active", startsAt: null, expiresAt: null }]);
      }
      if (text.includes("FROM platform.idempotency_keys")) return dbResult(replay ? [replay] : []);
      if (text.includes("INSERT INTO platform.idempotency_keys")) {
        return dbResult([{ id: "a5200000-0000-4000-8000-000000000021", attempt: 1 }]);
      }
      if (text.includes("ORDER BY calendar_revision DESC LIMIT 1")) {
        const latestRevision = options.latestRevision ?? 0;
        return dbResult(latestRevision ? [{ calendarRevision: latestRevision }] : []);
      }
      if (text.includes("operating_calendar_revisions revision")) {
        return dbResult(current ? [current.root] : []);
      }
      if (text.includes("FROM pms.operating_calendar_recurring_periods")) {
        return dbResult(current?.periods ?? []);
      }
      if (text.includes("FROM pms.operating_calendar_room_bindings")) {
        return dbResult(current?.rooms ?? []);
      }
      if (text.includes("INSERT INTO platform.domain_events")) {
        return dbResult([{ domainEventId: "a5200000-0000-4000-8000-000000000022" }]);
      }
      if (text.includes("INSERT INTO platform.outbox_events")) {
        return dbResult([{ outboxEventId: "a5200000-0000-4000-8000-000000000023" }]);
      }
      if (text.includes("UPDATE platform.idempotency_keys")) {
        replay = {
          status: "completed",
          requestFingerprintHash: fingerprintFor(command()),
          responseStatusCode: Number(values?.[1]),
          responseBodyHash: String(values?.[2]),
          idempotencyMetadata: { resultJson: String(values?.[4]) },
          expiresAt: "2026-08-05T09:30:00.000Z",
        };
        return dbResult([{}]);
      }
      return dbResult([]);
    },
    release,
  };
  const pool: PmsOperatingCalendarCommandPool = {
    async connect() {
      return client;
    },
    end,
  };
  const profileEvidence = {
    ownerDomain: "hotel_catalog" as const,
    registryVersion: "test@1",
    isCanonicalIanaTimeZone: (value: string) => value === "Europe/Berlin",
    async runWithPropertyProfileEvidence<Result>(
      _input: Readonly<{ propertyId: string; expectedProfileRevision: number }>,
      guarded: (value: PmsOperatingCalendarPropertyProfileEvidenceResult) => Promise<Result>,
    ) {
      events.push("owner:start");
      const output = await guarded(options.profileResult ?? availableProfile());
      events.push("owner:end");
      return output;
    },
  };
  const defaultCapacities = new Map([
    [roomTypeA, capacity(roomTypeA, 5, 2)],
    [roomTypeB, capacity(roomTypeB, 8, 3)],
  ]);
  const roomEvidence: PmsOperatingCalendarRoomEvidencePorts = {
    roomFacts: {
      async listRoomTypeFacts() {
        return options.facts ?? [facts(roomTypeB, 4), facts(roomTypeA, 3)];
      },
    },
    roomCapacity: {
      async getRoomTypeCapacity(_propertyId, roomTypeId) {
        events.push(`capacity:${roomTypeId}`);
        if (options.capacityFailure) throw options.capacityFailure;
        return (options.capacities ?? defaultCapacities).get(roomTypeId) ?? null;
      },
    },
  };
  const repository = createPgPmsOperatingCalendarCommandRepository({
    pool,
    propertyProfileEvidence: profileEvidence,
    roomEvidence,
    now: () => new Date(acceptedAt),
  });
  return { repository, calls, events, release, end, profileEvidence, roomEvidence };
}

function command(
  overrides: Partial<UpsertPmsOperatingCalendarCommand> = {},
): UpsertPmsOperatingCalendarCommand {
  const parsed = parseUpsertPmsOperatingCalendarCommand({
    organizationId,
    propertyId,
    expectedCalendarRevision: 0,
    expectedPropertyProfileRevision: 7,
    schedule: { mode: "recurring", periods: [{ startsOn: "11-01", endsOn: "03-31" }] },
    defaultMinimumStayNights: 2,
    roomTypeLimits: [
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
    ],
    idempotencyKey: "vay1071-command-unit",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "req-vay1071-command-unit",
      correlationId: "corr-vay1071-command-unit",
      requestedAt: acceptedAt,
    },
    ...overrides,
  });
  if (!parsed) throw new Error("Invalid operating-calendar command fixture");
  return parsed;
}

function facts(roomTypeId: string, roomFactsRevision: number): RoomTypeFactsSnapshot {
  const parsed = parseRoomTypeFactsSnapshot({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomFactsRevision,
    lifecycle: "active",
    facts: {
      name: `Room ${roomTypeId.slice(-1)}`,
      description: "Stable room facts.",
      category: "suite",
      occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 },
      beds: [{ type: "queen", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 30, unit: "sqm" },
    },
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
  });
  if (!parsed) throw new Error("Invalid room facts fixture");
  return parsed;
}

function capacity(
  roomTypeId: string,
  roomUnitsRevision: number,
  activeUnitCount: number,
): RoomTypeCapacitySnapshot {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomUnitsRevision,
    activeUnitCount,
    capturedAt: acceptedAt,
  };
}

function availableProfile(): PmsOperatingCalendarPropertyProfileEvidenceResult {
  return {
    status: "available",
    evidence: { source: profileSource(7), timeZone: "Europe/Berlin" as never },
  };
}

function profileSource(revision: number) {
  return {
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile" as const,
    entityId: propertyId,
    revision: `profile:${revision}`,
  };
}

function currentRows() {
  return {
    root: {
      propertyId,
      calendarRevision: 1,
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      sourceOwnerDomain: "pms",
      sourceEntityType: "pms_operating_calendar.v1",
      sourceEntityId: propertyId,
      sourceRevision: "calendar:1",
      propertyProfileOwnerDomain: "hotel_catalog",
      propertyProfileEntityType: "property_profile",
      propertyProfileEntityId: propertyId,
      propertyProfileSourceRevision: "profile:7",
      propertyTimeZone: "Europe/Berlin",
      scheduleMode: "recurring",
      recurringPeriodCount: 1,
      roomBindingCount: 2,
      defaultMinimumStayNights: 2,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    },
    periods: [
      {
        propertyId,
        calendarRevision: 1,
        periodIndex: 0,
        startMonth: 11,
        startDay: 1,
        endMonth: 3,
        endDay: 31,
      },
    ],
    rooms: [
      {
        propertyId,
        calendarRevision: 1,
        roomTypeId: roomTypeA,
        sourceRoomFactsRevision: 3,
        sourceRoomUnitsRevision: 5,
        physicalCapacityCount: 2,
        startingSellableLimitCount: 2,
      },
      {
        propertyId,
        calendarRevision: 1,
        roomTypeId: roomTypeB,
        sourceRoomFactsRevision: 4,
        sourceRoomUnitsRevision: 8,
        physicalCapacityCount: 3,
        startingSellableLimitCount: 2,
      },
    ],
  };
}

function fingerprintFor(input: UpsertPmsOperatingCalendarCommand): string {
  const canonical = JSON.stringify({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    expectedCalendarRevision: input.expectedCalendarRevision,
    expectedPropertyProfileRevision: input.expectedPropertyProfileRevision,
    schedule: input.schedule,
    defaultMinimumStayNights: input.defaultMinimumStayNights,
    roomTypeLimits: input.roomTypeLimits,
  });
  return cryptoHash(canonical);
}

function cryptoHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function dbResult(rows: readonly object[]): never {
  return { rows, rowCount: rows.length } as never;
}

function countSql(calls: readonly { text: string }[], pattern: string): number {
  return calls.filter(({ text }) => text.includes(pattern)).length;
}

function countSideEffects(calls: readonly { text: string }[]) {
  return {
    event: countSql(calls, "INSERT INTO platform.domain_events"),
    outbox: countSql(calls, "INSERT INTO platform.outbox_events"),
    audit: countSql(calls, "INSERT INTO platform.product_audit_events"),
    revision: countSql(calls, "INSERT INTO pms.operating_calendar_revisions"),
  };
}
