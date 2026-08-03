import { describe, expect, it } from "vitest";

import {
  PMS_OPERATING_CALENDAR_AUTHORIZATION,
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_OPERATING_CALENDAR_IDEMPOTENCY,
  PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION,
  PMS_OPERATING_CALENDAR_OUTBOX_METADATA,
  PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE,
  PMS_OPERATING_CALENDAR_SOURCE_OWNER_DOMAIN,
  createPmsOperatingCalendarSourceRevision,
  parsePmsCanonicalIanaTimeZone,
  parsePmsOperatingCalendarCommandResult,
  parsePmsOperatingCalendarConfigurationSnapshot,
  parsePmsOperatingCalendarCurrentReadResult,
  parsePmsOperatingCalendarPropertyProfileEvidence,
  parsePmsOperatingCalendarSourceRevision,
  parsePmsOperatingSchedule,
  parsePmsRecurringMonthDay,
  parseUpsertPmsOperatingCalendarCommand,
  serializePmsOperatingCalendarFingerprint,
  serializePmsOperatingCalendarSourceRevision,
  sortPmsOperatingCalendarStaleSourceConflicts,
  type PmsOperatingCalendarPropertyProfileEvidencePort,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
  type PmsOperatingCalendarRoomEvidencePorts,
} from "./operatingCalendar.js";

const ORGANIZATION_ID = "a1000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "a2000000-0000-4000-8000-000000000002";
const USER_ID = "a3000000-0000-4000-8000-000000000003";
const ROOM_A = "a4000000-0000-4000-8000-000000000004";
const ROOM_B = "a5000000-0000-4000-8000-000000000005";
const NOW = "2026-08-03T12:00:00.000Z";
const CANONICAL_TIME_ZONES = new Set([
  "Etc/UTC",
  "Europe/Berlin",
  "Europe/Kyiv",
  "Asia/Kolkata",
  "America/Nuuk",
]);
const timeZoneRegistry: PmsOperatingCalendarCanonicalTimeZoneRegistry = {
  ownerDomain: "hotel_catalog",
  registryVersion: "test-iana-current.v1",
  isCanonicalIanaTimeZone: (value) => CANONICAL_TIME_ZONES.has(value),
};
const canonicalBerlin = parsePmsCanonicalIanaTimeZone("Europe/Berlin", timeZoneRegistry)!;

const command = {
  organizationId: ORGANIZATION_ID,
  propertyId: PROPERTY_ID,
  expectedCalendarRevision: 0,
  expectedPropertyProfileRevision: 7,
  schedule: { mode: "year_round", periods: [] },
  defaultMinimumStayNights: 2,
  roomTypeLimits: [
    {
      roomTypeId: ROOM_B,
      expectedRoomFactsRevision: 6,
      expectedRoomUnitsRevision: 4,
      startingSellableLimitCount: 2,
    },
    {
      roomTypeId: ROOM_A,
      expectedRoomFactsRevision: 5,
      expectedRoomUnitsRevision: 3,
      startingSellableLimitCount: 8,
    },
  ],
  idempotencyKey: "calendar-create-1",
  audit: {
    actor: { kind: "user", userId: USER_ID },
    requestId: "request-1",
    correlationId: "correlation-1",
    requestedAt: NOW,
  },
} as const;

const roomBindings = [
  {
    roomTypeId: ROOM_A,
    sourceRoomFactsRevision: 5,
    sourceRoomUnitsRevision: 3,
    physicalCapacityCount: 10,
    startingSellableLimitCount: 8,
  },
  {
    roomTypeId: ROOM_B,
    sourceRoomFactsRevision: 6,
    sourceRoomUnitsRevision: 4,
    physicalCapacityCount: 2,
    startingSellableLimitCount: 2,
  },
] as const;

const source = createPmsOperatingCalendarSourceRevision(PROPERTY_ID, 1);
const snapshot = {
  contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  propertyId: PROPERTY_ID,
  calendarRevision: 1,
  source,
  sourceInputs: {
    propertyProfile: {
      ownerDomain: "hotel_catalog",
      entityType: "property_profile",
      entityId: PROPERTY_ID,
      revision: "profile:7",
    },
    propertyTimeZone: canonicalBerlin,
    roomBindings,
  },
  schedule: { mode: "year_round", periods: [] },
  defaultMinimumStayNights: 2,
  createdAt: NOW,
  updatedAt: NOW,
} as const;

describe("PMS operating calendar contract", () => {
  it("declares authorization, source identity, and source-read-required outbox routing", () => {
    expect(PMS_OPERATING_CALENDAR_AUTHORIZATION).toEqual({
      permission: "pms.operations.manage",
      readPermission: "pms.operations.read",
      entitlement: { product: "pms", key: "property-management" },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        allowedRelationships: ["owner", "operator"],
      },
    });
    expect(PMS_OPERATING_CALENDAR_SOURCE_OWNER_DOMAIN).toBe("pms");
    expect(PMS_OPERATING_CALENDAR_SOURCE_ENTITY_TYPE).toBe("pms_operating_calendar.v1");
    expect(PMS_OPERATING_CALENDAR_OUTBOX_DESTINATION).toBe("pms.inventory-source");
    expect(PMS_OPERATING_CALENDAR_OUTBOX_METADATA).toEqual({ sourceReadRequired: true });
    expect(PMS_OPERATING_CALENDAR_IDEMPOTENCY).toEqual({
      operationScope: "pms",
      operation: "pms.operating_calendar.upsert",
      keyScope: "property",
      exactReplay: "original_response",
      replaySideEffects: "none",
      changedFingerprint: "idempotency_key_conflict",
      inProgress: "command_in_progress",
    });
    expect(createPmsOperatingCalendarSourceRevision(PROPERTY_ID.toUpperCase(), 1)).toEqual({
      ownerDomain: "pms",
      entityType: "pms_operating_calendar.v1",
      entityId: PROPERTY_ID,
      revision: "calendar:1",
    });
  });

  it("keeps year-round explicit and rejects hidden periods", () => {
    expect(parsePmsOperatingSchedule({ mode: "year_round", periods: [] })).toEqual({
      mode: "year_round",
      periods: [],
    });
    expect(
      parsePmsOperatingSchedule({
        mode: "year_round",
        periods: [{ startsOn: "01-01", endsOn: "12-31" }],
      }),
    ).toBeNull();
  });

  it("canonicalizes adjacency, cross-year periods, and ordering", () => {
    expect(
      parsePmsOperatingSchedule({
        mode: "recurring",
        periods: [
          { startsOn: "01-01", endsOn: "03-31" },
          { startsOn: "12-01", endsOn: "12-31" },
          { startsOn: "06-01", endsOn: "06-30" },
        ],
      }),
    ).toEqual({
      mode: "recurring",
      periods: [
        { startsOn: "06-01", endsOn: "06-30" },
        { startsOn: "12-01", endsOn: "03-31" },
      ],
    });
  });

  it.each([
    {
      mode: "recurring",
      periods: [
        { startsOn: "04-01", endsOn: "10-31" },
        { startsOn: "10-01", endsOn: "11-30" },
      ],
    },
    {
      mode: "recurring",
      periods: [
        { startsOn: "04-01", endsOn: "10-31" },
        { startsOn: "04-01", endsOn: "10-31" },
      ],
    },
    { mode: "recurring", periods: [{ startsOn: "01-01", endsOn: "12-31" }] },
    { mode: "recurring", periods: [] },
  ])("rejects overlapping, duplicate, full-year, and empty recurring unions", (schedule) => {
    expect(parsePmsOperatingSchedule(schedule)).toBeNull();
  });

  it("rejects invalid boundaries and accepts periods spanning leap day", () => {
    expect(parsePmsRecurringMonthDay("02-29")).toBeNull();
    expect(parsePmsRecurringMonthDay("04-31")).toBeNull();
    expect(
      parsePmsOperatingSchedule({
        mode: "recurring",
        periods: [{ startsOn: "02-28", endsOn: "03-01" }],
      }),
    ).not.toBeNull();
  });

  it("accepts only canonical IANA timezones and typed exact profile evidence", () => {
    for (const currentName of ["Europe/Kyiv", "Asia/Kolkata", "America/Nuuk", "Etc/UTC"]) {
      expect(parsePmsCanonicalIanaTimeZone(currentName, timeZoneRegistry)).toBe(currentName);
    }
    for (const backwardLink of ["Europe/Kiev", "Asia/Calcutta", "America/Godthab", "US/Eastern"]) {
      expect(parsePmsCanonicalIanaTimeZone(backwardLink, timeZoneRegistry)).toBeNull();
    }
    expect(parsePmsCanonicalIanaTimeZone("Not/AZone", timeZoneRegistry)).toBeNull();
    expect(
      parsePmsOperatingCalendarPropertyProfileEvidence(
        {
          source: snapshot.sourceInputs.propertyProfile,
          timeZone: "Europe/Berlin",
        },
        timeZoneRegistry,
      ),
    ).toEqual({ source: snapshot.sourceInputs.propertyProfile, timeZone: "Europe/Berlin" });
  });

  it("sorts the complete room binding and fingerprints facts, units, limits, and profile", () => {
    const parsed = parseUpsertPmsOperatingCalendarCommand(command)!;
    const reordered = parseUpsertPmsOperatingCalendarCommand({
      ...command,
      roomTypeLimits: [...command.roomTypeLimits].reverse(),
      audit: { ...command.audit, requestId: "different-request" },
      idempotencyKey: "different-key",
    })!;
    expect(parsed.roomTypeLimits.map(({ roomTypeId }) => roomTypeId)).toEqual([ROOM_A, ROOM_B]);
    expect(serializePmsOperatingCalendarFingerprint(parsed)).toBe(
      serializePmsOperatingCalendarFingerprint(reordered),
    );
    for (const patch of [
      { expectedRoomFactsRevision: 9 },
      { expectedRoomUnitsRevision: 9 },
      { startingSellableLimitCount: 9 },
    ]) {
      const changed = parseUpsertPmsOperatingCalendarCommand({
        ...command,
        roomTypeLimits: [{ ...command.roomTypeLimits[0], ...patch }, command.roomTypeLimits[1]],
      })!;
      expect(serializePmsOperatingCalendarFingerprint(changed)).not.toBe(
        serializePmsOperatingCalendarFingerprint(parsed),
      );
    }
  });

  it("fingerprints the canonical annual union instead of draft grouping", () => {
    const adjacent = parseUpsertPmsOperatingCalendarCommand({
      ...command,
      schedule: {
        mode: "recurring",
        periods: [
          { startsOn: "04-01", endsOn: "06-30" },
          { startsOn: "07-01", endsOn: "10-31" },
        ],
      },
    })!;
    const merged = parseUpsertPmsOperatingCalendarCommand({
      ...command,
      schedule: {
        mode: "recurring",
        periods: [{ startsOn: "04-01", endsOn: "10-31" }],
      },
    })!;
    expect(serializePmsOperatingCalendarFingerprint(adjacent)).toBe(
      serializePmsOperatingCalendarFingerprint(merged),
    );
  });

  it.each([
    { roomTypeLimits: [] },
    { defaultMinimumStayNights: 0 },
    { defaultMinimumStayNights: 367 },
    { expectedPropertyProfileRevision: 0 },
    {
      roomTypeLimits: [
        command.roomTypeLimits[0],
        { ...command.roomTypeLimits[0], startingSellableLimitCount: 1 },
      ],
    },
    {
      roomTypeLimits: [
        { ...command.roomTypeLimits[0], expectedRoomFactsRevision: undefined },
        command.roomTypeLimits[1],
      ],
    },
    { audit: { ...command.audit, requestedAt: "0" } },
  ])("rejects partial, duplicate, or out-of-bounds commands", (patch) => {
    expect(parseUpsertPmsOperatingCalendarCommand({ ...command, ...patch })).toBeNull();
  });

  it("serializes a bounded immutable source identity without duplicating its manifest", () => {
    expect(serializePmsOperatingCalendarSourceRevision(1)).toBe("calendar:1");
    expect(() => serializePmsOperatingCalendarSourceRevision(0)).toThrow(RangeError);
    expect(source).toEqual({
      ownerDomain: "pms",
      entityType: "pms_operating_calendar.v1",
      entityId: PROPERTY_ID,
      revision: "calendar:1",
    });
    expect(parsePmsOperatingCalendarSourceRevision(source)).toEqual(source);
    expect(parsePmsOperatingCalendarSourceRevision({ ...source, entityId: ROOM_A })).not.toBeNull();
    expect(
      parsePmsOperatingCalendarSourceRevision({ ...source, revision: "calendar:0" }),
    ).toBeNull();
  });

  it("round-trips the profile, room facts, unit, capacity, limit, and source bindings", () => {
    expect(parsePmsOperatingCalendarConfigurationSnapshot(snapshot, timeZoneRegistry)).toEqual(
      snapshot,
    );
  });

  it.each([
    { source: { ...source, revision: "calendar:2" } },
    { sourceInputs: { ...snapshot.sourceInputs, propertyTimeZone: "US/Eastern" } },
    {
      sourceInputs: {
        ...snapshot.sourceInputs,
        roomBindings: [
          snapshot.sourceInputs.roomBindings[0],
          { ...snapshot.sourceInputs.roomBindings[0] },
        ],
      },
    },
    {
      sourceInputs: {
        ...snapshot.sourceInputs,
        roomBindings: [
          { ...snapshot.sourceInputs.roomBindings[0], startingSellableLimitCount: 11 },
          snapshot.sourceInputs.roomBindings[1],
        ],
      },
    },
    {
      sourceInputs: {
        ...snapshot.sourceInputs,
        roomBindings: [...snapshot.sourceInputs.roomBindings].reverse(),
      },
    },
    { createdAt: "0" },
    { pricingCoverageRevision: 1 },
    { availableCount: 0 },
  ])("fails closed on stale, malformed, or transiently coupled snapshots", (patch) => {
    expect(
      parsePmsOperatingCalendarConfigurationSnapshot({ ...snapshot, ...patch }, timeZoneRegistry),
    ).toBeNull();
  });

  it("round-trips accepted and typed source-conflict results", () => {
    const accepted = {
      ok: true,
      response: {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        outcome: "created",
        configuration: snapshot,
        acceptedAt: NOW,
      },
    } as const;
    expect(parsePmsOperatingCalendarCommandResult(accepted, timeZoneRegistry)).toEqual(accepted);
    expect(
      parsePmsOperatingCalendarCommandResult(
        {
          ok: false,
          error: { code: "room_facts_revision_conflict", roomTypeId: ROOM_A, currentRevision: 6 },
        },
        timeZoneRegistry,
      ),
    ).toEqual({
      ok: false,
      error: { code: "room_facts_revision_conflict", roomTypeId: ROOM_A, currentRevision: 6 },
    });
    expect(
      parsePmsOperatingCalendarCommandResult(
        {
          ok: false,
          error: { code: "property_profile_revision_conflict", currentRevision: 0 },
        },
        timeZoneRegistry,
      ),
    ).toBeNull();
  });

  it("distinguishes a current source from an immutable configuration with stale evidence", () => {
    expect(
      parsePmsOperatingCalendarCurrentReadResult(
        {
          configuration: snapshot,
          sourceStatus: "current",
          sourceConflicts: [],
        },
        timeZoneRegistry,
      ),
    ).toEqual({ configuration: snapshot, sourceStatus: "current", sourceConflicts: [] });
    expect(
      parsePmsOperatingCalendarCurrentReadResult(
        {
          configuration: snapshot,
          sourceStatus: "stale",
          sourceConflicts: [
            { code: "property_profile_revision_conflict", currentRevision: 8 },
            { code: "room_units_revision_conflict", roomTypeId: ROOM_A, currentRevision: 4 },
          ],
        },
        timeZoneRegistry,
      ),
    ).toEqual({
      configuration: snapshot,
      sourceStatus: "stale",
      sourceConflicts: [
        { code: "property_profile_revision_conflict", currentRevision: 8 },
        { code: "room_units_revision_conflict", roomTypeId: ROOM_A, currentRevision: 4 },
      ],
    });
    expect(
      parsePmsOperatingCalendarCurrentReadResult(
        {
          configuration: snapshot,
          sourceStatus: "stale",
          sourceConflicts: [
            { code: "room_units_revision_conflict", roomTypeId: ROOM_A, currentRevision: 4 },
            { code: "property_profile_revision_conflict", currentRevision: 8 },
          ],
        },
        timeZoneRegistry,
      ),
    ).toBeNull();
    expect(() =>
      sortPmsOperatingCalendarStaleSourceConflicts([
        { code: "property_timezone_missing" },
        { code: "property_timezone_missing" },
      ]),
    ).toThrow(TypeError);
    expect(
      parsePmsOperatingCalendarCurrentReadResult(
        {
          configuration: snapshot,
          sourceStatus: "stale",
          sourceConflicts: [
            { code: "property_profile_revision_conflict", currentRevision: 8 },
            { code: "property_profile_revision_conflict", currentRevision: 9 },
          ],
        },
        timeZoneRegistry,
      ),
    ).toBeNull();
  });

  it("exposes injected guarded profile evidence and existing room source ports", async () => {
    const calls: string[] = [];
    const profileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort = {
      ...timeZoneRegistry,
      async runWithPropertyProfileEvidence(input, guarded) {
        calls.push(`lock:${input.propertyId}`);
        const result = await guarded({
          source: snapshot.sourceInputs.propertyProfile,
          timeZone: snapshot.sourceInputs.propertyTimeZone,
        });
        calls.push(`unlock:${input.propertyId}`);
        return result;
      },
    };
    const roomEvidence = {} as PmsOperatingCalendarRoomEvidencePorts;
    const result = await profileEvidence.runWithPropertyProfileEvidence(
      { propertyId: PROPERTY_ID, expectedProfileRevision: 7 },
      async (evidence) => evidence?.source.revision,
    );
    expect(result).toBe("profile:7");
    expect(calls).toEqual([`lock:${PROPERTY_ID}`, `unlock:${PROPERTY_ID}`]);
    expect(roomEvidence).toBeDefined();
  });
});
