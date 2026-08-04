import type { PropertySetupRouteReadModel, PropertySetupStepDraft } from "@vayada/domain-hotels";
import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsCanonicalIanaTimeZone,
} from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import {
  CALENDAR_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE,
  buildCalendarDraftRequest,
  buildCalendarProposal,
  calendarDraftRevisionContext,
  hydrateCalendarDraft,
  validateCalendarDraft,
  type CalendarDraft,
  type CalendarWorkspace,
} from "./calendarState";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomA = "33333333-3333-4333-8333-333333333333";
const roomB = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-04T12:00:00.000Z";
const registry = {
  ownerDomain: "hotel_catalog" as const,
  registryVersion: "test.v1",
  isCanonicalIanaTimeZone: (value: string) => value === "Europe/Berlin",
};
const timeZone = parsePmsCanonicalIanaTimeZone("Europe/Berlin", registry)!;

describe("calendarState", () => {
  it("hydrates a first visit only after owner reads and prefills explicit safe defaults", () => {
    const draft = hydrateCalendarDraft(workspace(null), null);

    expect(draft).toMatchObject({
      mode: "",
      periods: [],
      defaultMinimumStayNights: "1",
      confirmed: false,
      rooms: [
        { roomTypeId: roomA, startingSellableLimit: "4" },
        { roomTypeId: roomB, startingSellableLimit: "2" },
      ],
    });
    expect(validateCalendarDraft(draft)).toMatchObject({ mode: expect.any(String) });
  });

  it("resumes draft values, clears stale confirmation, and leaves new rooms uninitialized", () => {
    const routeDraft = calendarDraft({
      "rate.operating_periods": {
        mode: "recurring",
        periods: [{ startMonthDay: "12-01", endMonthDay: "03-31" }],
      },
      "rate.minimum_stay": 3,
      "rate.initial_availability": {
        limits: { [roomA]: 2 },
        confirmed: true,
      },
    });
    const draft = hydrateCalendarDraft(workspace(currentWorkspace()), routeDraft);

    expect(draft).toMatchObject({
      mode: "recurring",
      periods: [{ startsOn: "12-01", endsOn: "03-31" }],
      defaultMinimumStayNights: "3",
      confirmed: false,
      rooms: [
        { roomTypeId: roomA, startingSellableLimit: "2" },
        { roomTypeId: roomB, startingSellableLimit: "" },
      ],
    });
  });

  it("resumes explicitly cleared values without restoring canonical settings", () => {
    const routeDraft = calendarDraft({
      "rate.operating_periods": { mode: null, periods: [] },
      "rate.minimum_stay": null,
      "rate.initial_availability": {
        limits: { [roomA]: null },
        confirmed: false,
      },
    });
    const draft = hydrateCalendarDraft(workspace(currentWorkspace()), routeDraft);

    expect(draft).toMatchObject({
      mode: "",
      periods: [],
      defaultMinimumStayNights: "",
      rooms: [
        { roomTypeId: roomA, startingSellableLimit: "" },
        { roomTypeId: roomB, startingSellableLimit: "" },
      ],
    });
  });

  it("accepts adjacent cross-year periods for later server canonicalization", () => {
    const draft = completeDraft({
      mode: "recurring",
      periods: [
        { id: "one", startsOn: "12-01", endsOn: "02-28" },
        { id: "two", startsOn: "03-01", endsOn: "03-31" },
      ],
    });
    expect(validateCalendarDraft(draft)).toEqual({});
  });

  it("rejects overlaps, full-year aliases, leap-day boundaries, and over-capacity limits", () => {
    const overlapping = completeDraft({
      mode: "recurring",
      periods: [
        { id: "one", startsOn: "01-01", endsOn: "06-30" },
        { id: "two", startsOn: "06-30", endsOn: "12-30" },
      ],
      rooms: [
        { ...workspace(null).rooms[0]!, startingSellableLimit: "5" },
        { ...workspace(null).rooms[1]!, startingSellableLimit: "2" },
      ],
    });
    expect(validateCalendarDraft(overlapping)).toMatchObject({
      periods: expect.stringContaining("overlap"),
      [`rooms.${roomA}`]: expect.any(String),
    });

    const fullYear = completeDraft({
      mode: "recurring",
      periods: [{ id: "one", startsOn: "01-01", endsOn: "12-31" }],
    });
    expect(validateCalendarDraft(fullYear).periods).toContain("complete year");

    const leapDay = completeDraft({
      mode: "recurring",
      periods: [{ id: "one", startsOn: "02-29", endsOn: "03-31" }],
    });
    expect(validateCalendarDraft(leapDay)["periods.0.startsOn"]).toBeTruthy();
  });

  it("uses the exact VAY-1049 manifest and fails closed when it is absent", () => {
    const route = setupRoute(calendarDraft({}));
    const calendarStep = route.steps.find(({ stepId }) => stepId === "calendar")!;
    const context = calendarDraftRevisionContext(route, calendarStep);
    const request = buildCalendarDraftRequest(completeDraft(), context);

    expect(request.expectedBaseRevisions).toEqual({
      "pms.operating_calendar": "calendar:1",
      "pms.inventory": "inventory:1",
      "pms.room_types": "types:3",
      "hotel_catalog.location": "location:7",
    });
    expect(request.payload).toMatchObject({
      "rate.operating_periods": { mode: "year_round", periods: [] },
      "rate.minimum_stay": 1,
      "rate.initial_availability": {
        limits: { [roomA]: 4, [roomB]: 2 },
        confirmed: true,
      },
    });

    expect(() =>
      buildCalendarDraftRequest(completeDraft(), {
        ...context,
        baseRevisions: null,
      }),
    ).toThrow(CALENDAR_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE);
  });

  it("builds the exact browser-safe impact proposal without scope or audit fields", () => {
    const draft = completeDraft({ confirmed: false });
    expect(validateCalendarDraft(draft, { requireConfirmation: false })).toEqual({});

    const proposal = buildCalendarProposal(draft, workspace(currentWorkspace()));

    expect(proposal).toEqual({
      expectedCalendarRevision: 1,
      expectedPropertyProfileRevision: 7,
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
      roomTypeLimits: [
        {
          roomTypeId: roomA,
          expectedRoomFactsRevision: 3,
          expectedRoomUnitsRevision: 5,
          startingSellableLimitCount: 4,
        },
        {
          roomTypeId: roomB,
          expectedRoomFactsRevision: 2,
          expectedRoomUnitsRevision: 4,
          startingSellableLimitCount: 2,
        },
      ],
    });
    expect(proposal).not.toHaveProperty("organizationId");
    expect(proposal).not.toHaveProperty("propertyId");
    expect(proposal).not.toHaveProperty("audit");
    expect(proposal).not.toHaveProperty("impactConfirmation");
  });
});

function workspace(current: CalendarWorkspace["current"]): CalendarWorkspace {
  return {
    propertyProfileRevision: 7,
    propertyTimeZone: "Europe/Berlin",
    current,
    rooms: [
      {
        roomTypeId: roomA,
        name: "Garden Suite",
        roomFactsRevision: 3,
        roomUnitsRevision: 5,
        physicalCapacityCount: 4,
      },
      {
        roomTypeId: roomB,
        name: "Courtyard Double",
        roomFactsRevision: 2,
        roomUnitsRevision: 4,
        physicalCapacityCount: 2,
      },
    ],
  };
}

function currentWorkspace(): NonNullable<CalendarWorkspace["current"]> {
  return {
    sourceStatus: "stale",
    sourceConflicts: [{ code: "room_type_set_conflict", currentRoomTypeIds: [roomA, roomB] }],
    configuration: {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      propertyId,
      calendarRevision: 1,
      source: createPmsOperatingCalendarSourceRevision(propertyId, 1),
      sourceInputs: {
        propertyProfile: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: "profile:7",
        },
        propertyTimeZone: timeZone,
        roomBindings: [
          {
            roomTypeId: roomA,
            sourceRoomFactsRevision: 3,
            sourceRoomUnitsRevision: 5,
            physicalCapacityCount: 4,
            startingSellableLimitCount: 3,
          },
        ],
      },
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 2,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function completeDraft(overrides: Partial<CalendarDraft> = {}): CalendarDraft {
  return {
    mode: "year_round",
    periods: [],
    defaultMinimumStayNights: "1",
    rooms: workspace(null).rooms.map((room) => ({
      ...room,
      startingSellableLimit: String(room.physicalCapacityCount),
    })),
    confirmed: true,
    dirty: true,
    ...overrides,
  };
}

function calendarDraft(
  payload: Extract<PropertySetupStepDraft, { stepId: "calendar" }>["payload"],
): Extract<PropertySetupStepDraft, { stepId: "calendar" }> {
  return {
    stepId: "calendar",
    payload,
    dirtyFields: [],
    baseRevisions: {
      "pms.operating_calendar": "calendar:1",
      "pms.inventory": "inventory:1",
      "pms.room_types": "types:3",
      "hotel_catalog.location": "location:7",
    },
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: "2026-11-02T12:00:00.000Z",
    revision: 2,
    updatedAt: now,
  };
}

function setupRoute(
  draft: Extract<PropertySetupStepDraft, { stepId: "calendar" }>,
): PropertySetupRouteReadModel {
  const stepIds = [
    "present_hotel",
    "booking_design",
    "rooms",
    "pricing",
    "calendar",
    "guest_experience",
    "payments",
    "review",
  ] as const;
  return {
    contractVersion: "property-setup-route.v1",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations"],
    trackRevision: 4,
    sessionId: "55555555-5555-4555-8555-555555555555",
    sessionRevision: 8,
    resumeStepId: "calendar",
    progress: { complete: 4, total: stepIds.length },
    steps: stepIds.map((stepId, index) => ({
      stepId,
      position: index + 1,
      state: stepId === "calendar" ? "draft" : index < 4 ? "complete" : "not_started",
      sourceRevision: null,
      draft: stepId === "calendar" ? draft : null,
      blockers: [],
    })),
  };
}
