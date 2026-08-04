import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsCanonicalIanaTimeZone,
  type PmsOperatingCalendarCurrentReadResult,
} from "@vayada/domain-pms";
import type { PropertyProfileResponse } from "@vayada/domain-hotels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCalendarDraftRequest,
  type CalendarDraftRevisionContext,
} from "@/components/setup/adaptive/calendar/calendarState";
import { ApiErrorResponse } from "./client";
import {
  CalendarOwnerError,
  createCalendarApiClient,
  type CalendarHttpClient,
  type CalendarPropertyProfileReader,
} from "./calendarApiClient";

const propertyId = "11111111-1111-4111-8111-111111111111";
const roomA = "22222222-2222-4222-8222-222222222222";
const roomB = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-04T12:00:00.000Z";
const calls = vi.hoisted(() => ({
  get: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>(),
  put: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
  profile: vi.fn<(propertyId: string, options?: RequestInit) => Promise<PropertyProfileResponse>>(),
}));
const http: CalendarHttpClient = {
  get: calls.get as CalendarHttpClient["get"],
  put: calls.put as CalendarHttpClient["put"],
};
const profiles: CalendarPropertyProfileReader = {
  getPropertyProfile: calls.profile,
};

describe("calendarApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.profile.mockResolvedValue(profile());
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/operating-calendar")) return currentCalendar();
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith(`/${roomA}/capacity`)) return capacity(roomA, 5, 4);
      if (endpoint.endsWith(`/${roomB}/capacity`)) return capacity(roomB, 3, 2);
      throw new Error(`Unexpected GET ${endpoint}`);
    });
  });

  it("loads the exact current calendar plus complete active room facts and physical capacity", async () => {
    const client = createCalendarApiClient(http, profiles);
    const workspace = await client.loadWorkspace(propertyId, { cache: "no-store" });

    expect(workspace).toMatchObject({
      propertyProfileRevision: 7,
      propertyTimeZone: "Europe/Berlin",
      current: { sourceStatus: "stale" },
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
          roomUnitsRevision: 3,
          physicalCapacityCount: 2,
        },
      ],
    });
    expect(calls.get).toHaveBeenCalledWith(`/api/pms/properties/${propertyId}/operating-calendar`, {
      cache: "no-store",
    });
  });

  it("distinguishes a first visit only from the exact not-configured owner response", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/operating-calendar")) {
        throw new ApiErrorResponse(404, { code: "operating_calendar_not_configured" });
      }
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith(`/${roomA}/capacity`)) return capacity(roomA, 5, 4);
      if (endpoint.endsWith(`/${roomB}/capacity`)) return capacity(roomB, 3, 2);
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    const client = createCalendarApiClient(http, profiles);

    await expect(client.loadWorkspace(propertyId)).resolves.toMatchObject({ current: null });

    calls.get.mockRejectedValueOnce(new ApiErrorResponse(404, { code: "different_missing" }));
    await expect(client.loadWorkspace(propertyId)).rejects.toBeInstanceOf(ApiErrorResponse);
  });

  it("fails closed for an invalid timezone, incomplete capacity, or empty active room set", async () => {
    calls.profile.mockResolvedValue(profile({ timezone: "UTC" }));
    await expect(createCalendarApiClient(http, profiles).loadWorkspace(propertyId)).rejects.toThrow(
      /property timezone adapter returned invalid data/i,
    );

    calls.profile.mockResolvedValue(profile());
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/operating-calendar")) return currentCalendar();
      if (endpoint.endsWith("/room-types")) return roomList();
      if (endpoint.endsWith(`/${roomA}/capacity`)) return capacity(roomA, 5, 0);
      if (endpoint.endsWith(`/${roomB}/capacity`)) return capacity(roomB, 3, 2);
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    await expect(createCalendarApiClient(http, profiles).loadWorkspace(propertyId)).rejects.toThrow(
      /room capacity adapter returned invalid data/i,
    );

    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/operating-calendar")) return currentCalendar();
      if (endpoint.endsWith("/room-types")) return { ...roomList(), items: [] };
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    await expect(
      createCalendarApiClient(http, profiles).loadWorkspace(propertyId),
    ).rejects.toBeInstanceOf(CalendarOwnerError);
  });

  it.each(["Etc/UTC", "Europe/Kyiv", "Asia/Kolkata", "America/Nuuk"])(
    "accepts Hotel Catalog canonical timezone %s even when a browser resolves an old alias",
    async (timeZoneName) => {
      calls.profile.mockResolvedValue(profile({ timezone: timeZoneName }));
      calls.get.mockImplementation(async (endpoint) => {
        if (endpoint.endsWith("/operating-calendar")) return currentCalendar(timeZoneName);
        if (endpoint.endsWith("/room-types")) return roomList();
        if (endpoint.endsWith(`/${roomA}/capacity`)) return capacity(roomA, 5, 4);
        if (endpoint.endsWith(`/${roomB}/capacity`)) return capacity(roomB, 3, 2);
        throw new Error(`Unexpected GET ${endpoint}`);
      });

      await expect(
        createCalendarApiClient(http, profiles).loadWorkspace(propertyId),
      ).resolves.toMatchObject({ propertyTimeZone: timeZoneName });
    },
  );

  it("saves only the exact resumable draft with a stable request fingerprint", async () => {
    calls.put.mockResolvedValue(draftReceipt());
    const client = createCalendarApiClient(http, profiles);
    const request = buildCalendarDraftRequest(
      {
        mode: "year_round",
        periods: [],
        defaultMinimumStayNights: "2",
        rooms: [
          {
            roomTypeId: roomA,
            name: "Garden Suite",
            roomFactsRevision: 3,
            roomUnitsRevision: 5,
            physicalCapacityCount: 4,
            startingSellableLimit: "3",
          },
        ],
        confirmed: true,
        dirty: true,
      },
      revisionContext(),
    );

    await client.saveDraft(propertyId, request);
    await client.saveDraft(propertyId, request);

    expect(calls.put).toHaveBeenCalledTimes(2);
    expect(calls.put.mock.calls[0]?.[0]).toBe(
      `/api/hotel-setup/properties/${propertyId}/setup-drafts/calendar`,
    );
    expect(calls.put.mock.calls[0]?.[1]).toEqual(request);
    const firstKey = new Headers(calls.put.mock.calls[0]?.[2]?.headers).get("Idempotency-Key");
    const secondKey = new Headers(calls.put.mock.calls[1]?.[2]?.headers).get("Idempotency-Key");
    expect(firstKey).toMatch(/^calendar-draft:/);
    expect(secondKey).toBe(firstKey);
    expect(Object.keys(client).sort()).toEqual(["loadWorkspace", "saveDraft"]);
    expect(calls.put.mock.calls.flatMap(([endpoint]) => endpoint)).not.toContain(
      `/api/pms/properties/${propertyId}/operating-calendar`,
    );
  });

  it("rejects extra keys on local room-list and draft-receipt envelopes", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/operating-calendar")) return currentCalendar();
      if (endpoint.endsWith("/room-types")) return { ...roomList(), unexpected: true };
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    const client = createCalendarApiClient(http, profiles);

    await expect(client.loadWorkspace(propertyId)).rejects.toThrow(
      /room facts list adapter returned invalid data/i,
    );

    const request = calendarDraftRequest();
    calls.put.mockResolvedValue({ ...draftReceipt(), unexpected: true });
    await expect(client.saveDraft(propertyId, request)).rejects.toThrow(
      /calendar draft receipt adapter returned invalid data/i,
    );
  });

  it("rejects duplicate room IDs in the owner room-list envelope", async () => {
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/operating-calendar")) return currentCalendar();
      if (endpoint.endsWith("/room-types")) {
        return {
          ...roomList(),
          items: [factsSnapshot(roomA, "Garden Suite", 3), factsSnapshot(roomA, "Duplicate", 4)],
        };
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });

    await expect(createCalendarApiClient(http, profiles).loadWorkspace(propertyId)).rejects.toThrow(
      /room facts list adapter returned invalid data/i,
    );
  });

  it("rejects malformed selected tracks and timestamps in draft receipts", async () => {
    const client = createCalendarApiClient(http, profiles);
    const request = calendarDraftRequest();

    calls.put.mockResolvedValue({
      ...draftReceipt(),
      selectedTracks: ["hotel_operations", "hotel_operations"],
    });
    await expect(client.saveDraft(propertyId, request)).rejects.toThrow(
      /calendar draft receipt adapter returned invalid data/i,
    );

    calls.put.mockResolvedValue({ ...draftReceipt(), updatedAt: "August 4, 2026" });
    await expect(client.saveDraft(propertyId, request)).rejects.toThrow(
      /calendar draft receipt adapter returned invalid data/i,
    );
  });
});

function profile(overrides: { timezone?: string } = {}): PropertyProfileResponse {
  return {
    propertyId,
    profileRevision: 7,
    profile: {
      displayName: "Hotel Lindenhof",
      propertyType: "hotel",
      location: {
        streetAddress: "Lindenstrasse 4",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        timezone: overrides.timezone ?? "Europe/Berlin",
        latitude: 52.52,
        longitude: 13.405,
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "approximate",
      },
      contacts: [],
    },
  };
}

function roomList() {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    items: [factsSnapshot(roomA, "Garden Suite", 3), factsSnapshot(roomB, "Courtyard Double", 2)],
  };
}

function factsSnapshot(roomTypeId: string, name: string, roomFactsRevision: number) {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomFactsRevision,
    lifecycle: "active",
    facts: {
      name,
      description: "",
      category: null,
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 2 },
      beds: [{ type: "queen", quantity: 1 }],
      bedrooms: null,
      bathrooms: 1,
      bathroomType: "private",
      size: null,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function capacity(roomTypeId: string, roomUnitsRevision: number, activeUnitCount: number) {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomUnitsRevision,
    activeUnitCount,
    capturedAt: now,
  };
}

function currentCalendar(timeZoneName = "Europe/Berlin"): PmsOperatingCalendarCurrentReadResult {
  const timeZone = parsePmsCanonicalIanaTimeZone(timeZoneName, {
    ownerDomain: "hotel_catalog",
    registryVersion: "test.v1",
    isCanonicalIanaTimeZone: (value) => value === timeZoneName,
  })!;
  return {
    sourceStatus: "stale",
    sourceConflicts: [
      { code: "room_units_revision_conflict", roomTypeId: roomA, currentRevision: 5 },
    ],
    configuration: {
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
        propertyTimeZone: timeZone,
        roomBindings: [
          {
            roomTypeId: roomA,
            sourceRoomFactsRevision: 3,
            sourceRoomUnitsRevision: 4,
            physicalCapacityCount: 4,
            startingSellableLimitCount: 3,
          },
          {
            roomTypeId: roomB,
            sourceRoomFactsRevision: 2,
            sourceRoomUnitsRevision: 3,
            physicalCapacityCount: 2,
            startingSellableLimitCount: 2,
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

function revisionContext(): CalendarDraftRevisionContext {
  return {
    sessionId: "44444444-4444-4444-8444-444444444444",
    trackRevision: 4,
    sessionRevision: 8,
    draftRevision: 2,
    baseRevisions: {
      "pms.operating_calendar": "calendar:2",
      "pms.inventory": "inventory:2",
      "pms.room_types": "types:3",
      "hotel_catalog.location": "location:7",
    },
  };
}

function calendarDraftRequest() {
  return buildCalendarDraftRequest(
    {
      mode: "year_round",
      periods: [],
      defaultMinimumStayNights: "2",
      rooms: [
        {
          roomTypeId: roomA,
          name: "Garden Suite",
          roomFactsRevision: 3,
          roomUnitsRevision: 5,
          physicalCapacityCount: 4,
          startingSellableLimit: "3",
        },
      ],
      confirmed: true,
      dirty: true,
    },
    revisionContext(),
  );
}

function draftReceipt() {
  return {
    contractVersion: "property-setup-draft.v1",
    sessionId: "44444444-4444-4444-8444-444444444444",
    stepId: "calendar",
    selectedTracks: ["hotel_operations"],
    trackRevision: 4,
    sessionRevision: 9,
    draftRevision: 3,
    retentionExpiresAt: "2026-11-02T12:00:00.000Z",
    updatedAt: now,
    replayed: false,
  };
}
