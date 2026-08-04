import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parsePmsCanonicalIanaTimeZone,
  parsePmsOperatingCalendarCurrentReadResult,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
} from "@vayada/domain-pms";
import {
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  SETUP_TRACKS,
  type PropertyProfileResponse,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";
import { availableTimezones } from "@vayada/product-onboarding";

import type {
  CalendarWorkspace,
  CalendarWorkspaceRoom,
} from "@/components/setup/adaptive/calendar/calendarState";
import { ApiErrorResponse } from "./client";
import { sharedHotelSetupApi } from "./sharedHotelSetupClient";
import { targetApiClient } from "./targetClient";

export type CalendarHttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export type CalendarPropertyProfileReader = {
  getPropertyProfile(propertyId: string, options?: RequestInit): Promise<PropertyProfileResponse>;
};

export type CalendarApiClient = {
  loadWorkspace(propertyId: string, options?: RequestInit): Promise<CalendarWorkspace>;
  saveDraft(
    propertyId: string,
    request: Extract<SavePropertySetupDraftRequest, { stepId: "calendar" }>,
  ): Promise<SavePropertySetupDraftReceipt>;
};

const canonicalTimeZones = new Set(availableTimezones());
const timeZoneRegistry: PmsOperatingCalendarCanonicalTimeZoneRegistry = {
  ownerDomain: "hotel_catalog",
  registryVersion: "countries-and-timezones@3.9.0",
  isCanonicalIanaTimeZone(value) {
    return canonicalTimeZones.has(value);
  },
};

export function createCalendarApiClient(
  http: CalendarHttpClient,
  profiles: CalendarPropertyProfileReader,
): CalendarApiClient {
  const loadWorkspace = async (
    propertyId: string,
    options?: RequestInit,
  ): Promise<CalendarWorkspace> => {
    const normalizedPropertyId = propertyId.toLowerCase();
    const [profile, factsValue, current] = await Promise.all([
      profiles.getPropertyProfile(propertyId, options),
      http.get<unknown>(`/api/pms/properties/${encoded(propertyId)}/room-types`, options),
      readCurrentCalendar(http, propertyId, options),
    ]);
    if (
      profile.propertyId.toLowerCase() !== normalizedPropertyId ||
      !parsePmsCanonicalIanaTimeZone(profile.profile.location.timezone, timeZoneRegistry)
    ) {
      throw invalidOwnerContract("property timezone");
    }
    const facts = parseRoomFactsList(factsValue, normalizedPropertyId);
    if (!facts) throw invalidOwnerContract("room facts list");
    const activeFacts = facts.filter(({ lifecycle }) => lifecycle === "active");
    if (activeFacts.length === 0) {
      throw new Error("Add at least one complete room type before opening the calendar.");
    }
    const rooms = await Promise.all(
      activeFacts.map(async (snapshot): Promise<CalendarWorkspaceRoom> => {
        const capacityValue = await http.get<unknown>(
          `/api/pms/properties/${encoded(propertyId)}/room-types/${encoded(snapshot.roomTypeId)}/capacity`,
          options,
        );
        const capacity = parseRoomTypeCapacitySnapshot(capacityValue);
        if (
          !capacity ||
          capacity.propertyId !== normalizedPropertyId ||
          capacity.roomTypeId !== snapshot.roomTypeId ||
          capacity.activeUnitCount < 1
        ) {
          throw invalidOwnerContract("room capacity");
        }
        return {
          roomTypeId: snapshot.roomTypeId,
          name: snapshot.facts.name,
          roomFactsRevision: snapshot.roomFactsRevision,
          roomUnitsRevision: capacity.roomUnitsRevision,
          physicalCapacityCount: capacity.activeUnitCount,
        };
      }),
    );
    const propertyTimeZone = profile.profile.location.timezone;
    if (
      current &&
      (current.configuration.propertyId !== normalizedPropertyId ||
        current.configuration.sourceInputs.propertyTimeZone !== propertyTimeZone)
    ) {
      throw invalidOwnerContract("operating calendar scope");
    }
    return {
      propertyProfileRevision: profile.profileRevision,
      propertyTimeZone,
      rooms,
      current,
    };
  };

  const saveDraft = async (
    propertyId: string,
    request: Extract<SavePropertySetupDraftRequest, { stepId: "calendar" }>,
  ): Promise<SavePropertySetupDraftReceipt> => {
    const key = await sha256Key("calendar-draft", propertyId, request);
    const value = await http.put<unknown>(
      `/api/hotel-setup/properties/${encoded(propertyId)}/setup-drafts/calendar`,
      request,
      { headers: { "Idempotency-Key": key } },
    );
    const receipt = parseDraftReceipt(value, request);
    if (!receipt) throw invalidOwnerContract("calendar draft receipt");
    return receipt;
  };

  return { loadWorkspace, saveDraft };
}

export const calendarApi = createCalendarApiClient(targetApiClient, sharedHotelSetupApi);

async function readCurrentCalendar(
  http: CalendarHttpClient,
  propertyId: string,
  options?: RequestInit,
) {
  try {
    const value = await http.get<unknown>(
      `/api/pms/properties/${encoded(propertyId)}/operating-calendar`,
      options,
    );
    const current = parsePmsOperatingCalendarCurrentReadResult(value, timeZoneRegistry);
    if (!current || current.configuration.propertyId !== propertyId.toLowerCase()) {
      throw invalidOwnerContract("operating calendar");
    }
    return current;
  } catch (error) {
    if (
      error instanceof ApiErrorResponse &&
      error.status === 404 &&
      isRecord(error.data) &&
      error.data.code === "operating_calendar_not_configured"
    ) {
      return null;
    }
    throw error;
  }
}

function parseRoomFactsList(value: unknown, propertyId: string) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contractVersion", "propertyId", "items"]) ||
    value.contractVersion !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    value.propertyId !== propertyId ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const items = value.items.map(parseRoomTypeFactsSnapshot);
  const roomTypeIds = items.flatMap((item) => (item ? [item.roomTypeId] : []));
  return items.some((item) => !item || item.propertyId !== propertyId) ||
    new Set(roomTypeIds).size !== roomTypeIds.length
    ? null
    : (items as NonNullable<(typeof items)[number]>[]);
}

function parseDraftReceipt(
  value: unknown,
  request: Extract<SavePropertySetupDraftRequest, { stepId: "calendar" }>,
): SavePropertySetupDraftReceipt | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "sessionId",
      "stepId",
      "selectedTracks",
      "trackRevision",
      "sessionRevision",
      "draftRevision",
      "retentionExpiresAt",
      "updatedAt",
      "replayed",
    ]) ||
    value.contractVersion !== PROPERTY_SETUP_DRAFT_CONTRACT_VERSION ||
    value.stepId !== "calendar" ||
    typeof value.sessionId !== "string" ||
    !Array.isArray(value.selectedTracks) ||
    value.selectedTracks.length === 0 ||
    new Set(value.selectedTracks).size !== value.selectedTracks.length ||
    value.selectedTracks.some(
      (track) =>
        typeof track !== "string" || !SETUP_TRACKS.includes(track as (typeof SETUP_TRACKS)[number]),
    ) ||
    !value.selectedTracks.includes("hotel_operations") ||
    !revision(value.trackRevision) ||
    !revision(value.sessionRevision) ||
    !revision(value.draftRevision) ||
    !isoTimestamp(value.retentionExpiresAt) ||
    !isoTimestamp(value.updatedAt) ||
    typeof value.replayed !== "boolean" ||
    value.trackRevision < request.expectedTrackRevision ||
    value.sessionRevision < request.expectedSessionRevision ||
    value.draftRevision < request.expectedDraftRevision
  ) {
    return null;
  }
  return value as SavePropertySetupDraftReceipt;
}

async function sha256Key(label: string, propertyId: string, value: unknown): Promise<string> {
  const source = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${label}:${propertyId}:${hash.slice(0, 40)}`;
}

function invalidOwnerContract(label: string): Error {
  return new Error(`The protected ${label} adapter returned invalid data.`);
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
