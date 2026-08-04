import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parseRoomTypeFactsSnapshot,
  type PmsOperatingCalendarPropertyProfileEvidenceResult,
  type PmsOperatingCalendarRoomEvidencePorts,
  type RoomTypeCapacitySnapshot,
  type RoomTypeFactsSnapshot,
} from "@vayada/domain-pms";
import { describe, expect, it, vi } from "vitest";

import {
  createPgPmsOperatingCalendarReadModel,
  loadPmsOperatingCalendarConfigurationByRevision,
  type PmsOperatingCalendarReadClient,
  type PmsOperatingCalendarReadPool,
  type PmsOperatingCalendarRecurringPeriodRow,
  type PmsOperatingCalendarRevisionRow,
  type PmsOperatingCalendarRoomBindingRow,
} from "./domains/pmsOperatingCalendarReadModel.js";

const propertyId = "a5000000-0000-4000-8000-000000000001";
const roomTypeA = "a5000000-0000-4000-8000-000000000002";
const roomTypeB = "a5000000-0000-4000-8000-000000000003";
const roomTypeC = "a5000000-0000-4000-8000-000000000004";
const now = "2026-08-04T08:30:00.000Z";

describe("PMS operating-calendar read model", () => {
  it("loads one exact immutable source with its canonical child manifest", async () => {
    const fixture = readFixture();

    await expect(
      loadPmsOperatingCalendarConfigurationByRevision(
        fixture.pool,
        propertyId.toUpperCase(),
        2,
        fixture.profileEvidence,
      ),
    ).resolves.toEqual(expectedConfiguration());

    const source = createPmsOperatingCalendarSourceRevision(propertyId, 2);
    await expect(fixture.read.getOperatingCalendarConfigurationBySource(source)).resolves.toEqual(
      expectedConfiguration(),
    );
    expect(
      fixture.calls.filter(({ text }) => text.includes("operating_calendar_revisions revision")),
    ).toHaveLength(2);
    expect(fixture.calls.some(({ text }) => text.includes("ORDER BY period_index"))).toBe(true);
    expect(fixture.calls.some(({ text }) => text.includes("ORDER BY room_type_id"))).toBe(true);
  });

  it("selects current=max under owner, room-facts, and sorted unit guards", async () => {
    const fixture = readFixture();

    await expect(
      fixture.read.getCurrentOperatingCalendarConfiguration(propertyId.toUpperCase()),
    ).resolves.toEqual({
      configuration: expectedConfiguration(),
      sourceStatus: "current",
      sourceConflicts: [],
    });

    expect(fixture.profileCalls).toEqual([{ propertyId, expectedProfileRevision: 7 }]);
    const transaction = fixture.calls
      .map(({ text }) => text)
      .slice(fixture.calls.findIndex(({ text }) => text === "BEGIN"));
    expect(transaction[0]).toBe("BEGIN");
    expect(transaction[1]).toContain("hashtext('pms.room_facts')");
    const physicalLocks = fixture.calls.filter(({ text }) =>
      text.includes("pms.physical-room-unit:"),
    );
    expect(physicalLocks.map(({ values }) => values)).toEqual([
      [propertyId, roomTypeA],
      [propertyId, roomTypeB],
    ]);
    expect(transaction.at(-1)).toBe("COMMIT");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("returns canonically sorted, source-only owner and room conflicts", async () => {
    const fixture = readFixture({
      profileResult: profileResult("timezone_missing", 7),
      facts: [facts(roomTypeA, 4), facts(roomTypeB, 3)],
      capacities: new Map([
        [roomTypeA, capacity(roomTypeA, 6, 2)],
        [roomTypeB, null],
      ]),
    });

    await expect(
      fixture.read.getCurrentOperatingCalendarConfiguration(propertyId),
    ).resolves.toEqual({
      configuration: expectedConfiguration(),
      sourceStatus: "stale",
      sourceConflicts: [
        { code: "property_timezone_missing" },
        { code: "room_facts_revision_conflict", roomTypeId: roomTypeA, currentRevision: 4 },
        { code: "room_units_revision_conflict", roomTypeId: roomTypeA, currentRevision: 6 },
        { code: "room_capacity_unavailable", roomTypeId: roomTypeB },
      ],
    });
    expect(
      JSON.stringify(await fixture.read.getCurrentOperatingCalendarConfiguration(propertyId)),
    ).not.toContain("raw");
  });

  it("reports exact active-set changes without inventing a global room-set revision", async () => {
    const fixture = readFixture({
      facts: [facts(roomTypeA, 3), facts(roomTypeC, 1)],
      capacities: new Map([
        [roomTypeA, capacity(roomTypeA, 5, 2)],
        [roomTypeC, capacity(roomTypeC, 1, 1)],
      ]),
    });

    await expect(
      fixture.read.getCurrentOperatingCalendarConfiguration(propertyId),
    ).resolves.toMatchObject({
      sourceStatus: "stale",
      sourceConflicts: [
        { code: "room_type_set_conflict", currentRoomTypeIds: [roomTypeA, roomTypeC] },
      ],
    });
  });

  it("distinguishes empty active rooms, unavailable zero capacity, and profile precedence", async () => {
    const empty = readFixture({ facts: [facts(roomTypeA, 3, "inactive")], capacities: new Map() });
    await expect(
      empty.read.getCurrentOperatingCalendarConfiguration(propertyId),
    ).resolves.toMatchObject({
      sourceStatus: "stale",
      sourceConflicts: [{ code: "active_room_type_set_empty" }],
    });

    const zero = readFixture({
      capacities: new Map([
        [roomTypeA, capacity(roomTypeA, 5, 0)],
        [roomTypeB, capacity(roomTypeB, 8, 3)],
      ]),
    });
    await expect(
      zero.read.getCurrentOperatingCalendarConfiguration(propertyId),
    ).resolves.toMatchObject({
      sourceStatus: "stale",
      sourceConflicts: [{ code: "room_capacity_unavailable", roomTypeId: roomTypeA }],
    });

    const changedProfile = readFixture({
      profileResult: profileResult("timezone_invalid", 8),
    });
    await expect(
      changedProfile.read.getCurrentOperatingCalendarConfiguration(propertyId),
    ).resolves.toMatchObject({
      sourceStatus: "stale",
      sourceConflicts: [{ code: "property_profile_revision_conflict", currentRevision: 8 }],
    });
  });

  it("fails closed on partial, duplicate, escaped, or silently changed evidence", async () => {
    const cases: Array<[ReturnType<typeof readFixture>, string]> = [
      [readFixture({ facts: [facts(roomTypeA, 3), facts(roomTypeA, 3)] }), "duplicate room types"],
      [
        readFixture({
          facts: [{ ...facts(roomTypeA, 3), propertyId: roomTypeC }],
        }),
        "escaped its property scope",
      ],
      [
        readFixture({
          capacities: new Map([
            [roomTypeA, capacity(roomTypeA, 5, 1)],
            [roomTypeB, capacity(roomTypeB, 8, 3)],
          ]),
        }),
        "changed without advancing",
      ],
      [
        readFixture({ profileResult: availableProfile(7, "America/Nuuk") }),
        "timezone changed without advancing",
      ],
    ];
    for (const [fixture, message] of cases) {
      await expect(
        fixture.read.getCurrentOperatingCalendarConfiguration(propertyId),
      ).rejects.toThrow(message);
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.calls.at(-1)?.text).toBe("ROLLBACK");
    }
  });

  it("rejects malformed exact sources and incomplete database manifests", async () => {
    const fixture = readFixture();
    await expect(
      fixture.read.getOperatingCalendarConfigurationBySource({
        ...createPmsOperatingCalendarSourceRevision(propertyId, 2),
        entityId: propertyId.toUpperCase(),
      }),
    ).rejects.toThrow("source scope is malformed");

    const missing = readFixture({ root: null });
    await expect(
      missing.read.getOperatingCalendarConfigurationBySource(
        createPmsOperatingCalendarSourceRevision(propertyId, 2),
      ),
    ).resolves.toBeNull();

    const partial = readFixture({ periods: [] });
    await expect(
      partial.read.getOperatingCalendarConfigurationBySource(
        createPmsOperatingCalendarSourceRevision(propertyId, 2),
      ),
    ).rejects.toThrow("manifest count is incomplete");
  });

  it("confirms an empty current read under the shared lock and closes only owned pools", async () => {
    const empty = readFixture({ root: null });
    await expect(
      empty.read.getCurrentOperatingCalendarConfiguration(propertyId),
    ).resolves.toBeNull();
    expect(empty.calls.some(({ text }) => text.includes("hashtext('pms.room_facts')"))).toBe(true);
    expect(empty.profileCalls).toEqual([]);
    await empty.read.close();
    expect(empty.end).not.toHaveBeenCalled();

    expect(() =>
      createPgPmsOperatingCalendarReadModel({
        propertyProfileEvidence: empty.profileEvidence,
        roomEvidence: empty.roomEvidence,
      }),
    ).toThrow("connectionString must not be empty");
  });
});

type ReadFixtureOptions = {
  root?: PmsOperatingCalendarRevisionRow | null;
  periods?: readonly PmsOperatingCalendarRecurringPeriodRow[];
  rooms?: readonly PmsOperatingCalendarRoomBindingRow[];
  profileResult?: PmsOperatingCalendarPropertyProfileEvidenceResult;
  facts?: readonly RoomTypeFactsSnapshot[];
  capacities?: ReadonlyMap<string, RoomTypeCapacitySnapshot | null>;
};

function readFixture(options: ReadFixtureOptions = {}) {
  const root = options.root === undefined ? revisionRow() : options.root;
  const periods = options.periods ?? periodRows();
  const rooms = options.rooms ?? roomRows();
  const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    calls.push({ text, values });
    if (text.includes("ORDER BY calendar_revision DESC")) {
      return {
        rows: root ? [{ calendarRevision: root.calendarRevision }] : [],
        rowCount: root ? 1 : 0,
      };
    }
    if (text.includes("SELECT property_profile_revision")) {
      return { rows: root ? [{ profileRevision: 7 }] : [], rowCount: root ? 1 : 0 };
    }
    if (text.includes("operating_calendar_revisions revision")) {
      return { rows: root ? [root] : [], rowCount: root ? 1 : 0 };
    }
    if (text.includes("operating_calendar_recurring_periods")) {
      return { rows: periods, rowCount: periods.length };
    }
    if (text.includes("operating_calendar_room_bindings")) {
      return { rows: rooms, rowCount: rooms.length };
    }
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PmsOperatingCalendarReadClient;
  const connect = vi.fn(async () => client);
  const end = vi.fn(async () => undefined);
  const pool = { query, connect, end } as unknown as PmsOperatingCalendarReadPool;
  const profileCalls: Array<{ propertyId: string; expectedProfileRevision: number }> = [];
  const profileResult = options.profileResult ?? availableProfile(7, "Europe/Berlin");
  const profileEvidence = {
    ownerDomain: "hotel_catalog" as const,
    registryVersion: "test-iana.v1",
    isCanonicalIanaTimeZone: (value: string) =>
      ["Europe/Berlin", "America/Nuuk", "Etc/UTC"].includes(value),
    async runWithPropertyProfileEvidence<Result>(
      input: { propertyId: string; expectedProfileRevision: number },
      guarded: (result: PmsOperatingCalendarPropertyProfileEvidenceResult) => Promise<Result>,
    ) {
      profileCalls.push(input);
      return guarded(profileResult);
    },
  };
  const factsValues = options.facts ?? [facts(roomTypeA, 3), facts(roomTypeB, 3)];
  const capacityValues =
    options.capacities ??
    new Map<string, RoomTypeCapacitySnapshot | null>([
      [roomTypeA, capacity(roomTypeA, 5, 2)],
      [roomTypeB, capacity(roomTypeB, 8, 3)],
    ]);
  const roomEvidence: PmsOperatingCalendarRoomEvidencePorts = {
    roomFacts: { listRoomTypeFacts: async () => factsValues },
    roomCapacity: {
      getRoomTypeCapacity: async (_propertyId, roomTypeId) =>
        capacityValues.get(roomTypeId) ?? null,
    },
  };
  const read = createPgPmsOperatingCalendarReadModel({
    pool,
    propertyProfileEvidence: profileEvidence,
    roomEvidence,
  });
  return {
    read,
    pool,
    calls,
    release,
    end,
    profileCalls,
    profileEvidence,
    roomEvidence,
  };
}

function revisionRow(): PmsOperatingCalendarRevisionRow {
  return {
    propertyId,
    calendarRevision: 2,
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    sourceOwnerDomain: "pms",
    sourceEntityType: "pms_operating_calendar.v1",
    sourceEntityId: propertyId,
    sourceRevision: "calendar:2",
    propertyProfileOwnerDomain: "hotel_catalog",
    propertyProfileEntityType: "property_profile",
    propertyProfileEntityId: propertyId,
    propertyProfileSourceRevision: "profile:7",
    propertyTimeZone: "Europe/Berlin",
    scheduleMode: "recurring",
    recurringPeriodCount: 1,
    roomBindingCount: 2,
    defaultMinimumStayNights: 2,
    createdAt: now,
    updatedAt: now,
  };
}

function periodRows(): readonly PmsOperatingCalendarRecurringPeriodRow[] {
  return [
    {
      propertyId,
      calendarRevision: 2,
      periodIndex: 0,
      startMonth: 11,
      startDay: 1,
      endMonth: 3,
      endDay: 31,
    },
  ];
}

function roomRows(): readonly PmsOperatingCalendarRoomBindingRow[] {
  return [
    {
      propertyId,
      calendarRevision: 2,
      roomTypeId: roomTypeA,
      sourceRoomFactsRevision: 3,
      sourceRoomUnitsRevision: 5,
      physicalCapacityCount: 2,
      startingSellableLimitCount: 2,
    },
    {
      propertyId,
      calendarRevision: 2,
      roomTypeId: roomTypeB,
      sourceRoomFactsRevision: 3,
      sourceRoomUnitsRevision: 8,
      physicalCapacityCount: 3,
      startingSellableLimitCount: 2,
    },
  ];
}

function expectedConfiguration() {
  return {
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    propertyId,
    calendarRevision: 2,
    source: createPmsOperatingCalendarSourceRevision(propertyId, 2),
    sourceInputs: {
      propertyProfile: {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: propertyId,
        revision: "profile:7",
      },
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
          sourceRoomFactsRevision: 3,
          sourceRoomUnitsRevision: 8,
          physicalCapacityCount: 3,
          startingSellableLimitCount: 2,
        },
      ],
    },
    schedule: {
      mode: "recurring",
      periods: [{ startsOn: "11-01", endsOn: "03-31" }],
    },
    defaultMinimumStayNights: 2,
    createdAt: now,
    updatedAt: now,
  };
}

function facts(
  roomTypeId: string,
  roomFactsRevision: number,
  lifecycle: "active" | "inactive" = "active",
): RoomTypeFactsSnapshot {
  const parsed = parseRoomTypeFactsSnapshot({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomFactsRevision,
    lifecycle,
    facts: {
      name: `Room ${roomTypeId.slice(-1)}`,
      description: "A stable room facts fixture.",
      category: "deluxe",
      occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 },
      beds: [{ type: "queen", quantity: 1 }],
      bedrooms: 1,
      bathrooms: 1,
      bathroomType: "private",
      size: { value: 30, unit: "sqm" },
    },
    createdAt: now,
    updatedAt: now,
  });
  if (!parsed) throw new Error("invalid room facts fixture");
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
    capturedAt: now,
  };
}

function availableProfile(revision: number, timeZone: "Europe/Berlin" | "America/Nuuk") {
  return {
    status: "available" as const,
    evidence: {
      source: profileSource(revision),
      timeZone: timeZone as never,
    },
  };
}

function profileResult(status: "timezone_missing" | "timezone_invalid", revision: number) {
  return { status, source: profileSource(revision) } as const;
}

function profileSource(revision: number) {
  return {
    ownerDomain: "hotel_catalog" as const,
    entityType: "property_profile" as const,
    entityId: propertyId,
    revision: `profile:${revision}`,
  };
}
