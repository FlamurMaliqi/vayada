import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parsePmsCanonicalIanaTimeZone,
  parsePmsOperatingCalendarCommandResult,
  parsePmsOperatingCalendarCurrentReadResult,
  parsePmsOperatingCalendarImpactPreview,
  parsePmsOperatingCalendarImpactPreviewError,
  parsePmsOperatingCalendarImpactPreviewRequest,
  parsePmsOperatingCalendarUpsertRequest,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
  type PmsOperatingCalendarCommandError,
  type PmsOperatingCalendarCommandResponse,
  type PmsOperatingCalendarImpactConfirmation,
  type PmsOperatingCalendarImpactPreview,
  type PmsOperatingCalendarImpactPreviewError,
  type PmsOperatingCalendarImpactPreviewRequest,
  type PmsOperatingCalendarUpsertRequest,
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
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export type CalendarPropertyProfileReader = {
  getPropertyProfile(propertyId: string, options?: RequestInit): Promise<PropertyProfileResponse>;
};

export class CalendarOwnerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: unknown,
    readonly requiresRefresh: boolean,
    readonly requiresPreview: boolean,
  ) {
    super(message);
    this.name = "CalendarOwnerError";
  }
}

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
) {
  const loadWorkspace = async (
    propertyId: string,
    options?: RequestInit,
  ): Promise<CalendarWorkspace> => {
    const normalizedPropertyId = propertyId.toLowerCase();
    const [profile, factsValue, current] = await Promise.all([
      profiles.getPropertyProfile(propertyId, options),
      http.get<unknown>(
        `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types`,
        options,
      ),
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
          `/api/pms/properties/${encodeURIComponent(propertyId)}/room-types/${encodeURIComponent(snapshot.roomTypeId)}/capacity`,
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
      `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/setup-drafts/calendar`,
      request,
      { headers: { "Idempotency-Key": key } },
    );
    const receipt = parseDraftReceipt(value, request);
    if (!receipt) throw invalidOwnerContract("calendar draft receipt");
    return receipt;
  };

  const previewImpact = async (
    propertyId: string,
    proposal: PmsOperatingCalendarImpactPreviewRequest,
  ): Promise<PmsOperatingCalendarImpactPreview> => {
    const request = parsePmsOperatingCalendarImpactPreviewRequest(proposal);
    if (!request) throw invalidClientContract("operating calendar impact proposal");
    let value: unknown;
    try {
      value = await http.post<unknown>(
        `/api/pms/properties/${encodeURIComponent(propertyId)}/operating-calendar/impact-preview`,
        request,
      );
    } catch (error) {
      throw previewOwnerError(error);
    }
    const preview = parsePmsOperatingCalendarImpactPreview(value);
    if (!preview || preview.propertyId !== propertyId.toLowerCase()) {
      throw invalidOwnerContract("operating calendar impact preview");
    }
    return preview;
  };

  const applyCalendar = async (
    propertyId: string,
    proposal: PmsOperatingCalendarImpactPreviewRequest,
    confirmation: PmsOperatingCalendarImpactConfirmation,
  ): Promise<CalendarWorkspace> => {
    const request = parsePmsOperatingCalendarUpsertRequest({
      ...proposal,
      impactConfirmation: confirmation,
    });
    if (!request) throw invalidClientContract("operating calendar command");
    const idempotencyKey = await sha256Key("operating-calendar", propertyId.toLowerCase(), request);
    let value: unknown;
    try {
      value = await http.put<unknown>(
        `/api/pms/properties/${encodeURIComponent(propertyId)}/operating-calendar`,
        request,
        { headers: { "Idempotency-Key": idempotencyKey } },
      );
    } catch (error) {
      const ownerError = commandOwnerError(error);
      if (
        ownerError instanceof CalendarOwnerError &&
        ownerError.code === "operating_calendar_unchanged"
      ) {
        const workspace = await loadWorkspace(propertyId, { cache: "no-store" });
        if (workspaceMatchesProposal(propertyId, workspace, proposal)) return workspace;
      }
      throw ownerError;
    }
    const result = parsePmsOperatingCalendarCommandResult(
      { ok: true, response: value },
      timeZoneRegistry,
    );
    if (!result?.ok || !configurationMatchesRequest(propertyId, result.response, request)) {
      throw invalidOwnerContract("operating calendar command receipt");
    }
    const workspace = await loadWorkspace(propertyId, { cache: "no-store" });
    const currentRead = workspace.current;
    const current = currentRead?.configuration;
    if (
      !current ||
      currentRead.sourceStatus !== "current" ||
      current.calendarRevision !== result.response.configuration.calendarRevision ||
      JSON.stringify(current) !== JSON.stringify(result.response.configuration)
    ) {
      throw new CalendarOwnerError(
        "The calendar changed before the accepted revision could be verified. Reload the latest calendar.",
        "calendar_refetch_conflict",
        {
          acceptedRevision: result.response.configuration.calendarRevision,
          currentRevision: current?.calendarRevision ?? null,
          sourceStatus: currentRead?.sourceStatus ?? null,
        },
        true,
        true,
      );
    }
    return workspace;
  };

  return { loadWorkspace, saveDraft, previewImpact, applyCalendar };
}

export const calendarApi = createCalendarApiClient(targetApiClient, sharedHotelSetupApi);

async function readCurrentCalendar(
  http: CalendarHttpClient,
  propertyId: string,
  options?: RequestInit,
) {
  try {
    const value = await http.get<unknown>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/operating-calendar`,
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
    !isUuid(value.sessionId) ||
    !Array.isArray(value.selectedTracks) ||
    value.selectedTracks.length === 0 ||
    new Set(value.selectedTracks).size !== value.selectedTracks.length ||
    value.selectedTracks.some(
      (track) =>
        typeof track !== "string" || !SETUP_TRACKS.includes(track as (typeof SETUP_TRACKS)[number]),
    ) ||
    !value.selectedTracks.includes("hotel_operations") ||
    value.trackRevision !== request.expectedTrackRevision ||
    value.sessionRevision !== request.expectedSessionRevision + 1 ||
    value.draftRevision !== request.expectedDraftRevision + 1 ||
    !isoTimestamp(value.retentionExpiresAt) ||
    !isoTimestamp(value.updatedAt) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }
  return value as SavePropertySetupDraftReceipt;
}

function configurationMatchesRequest(
  propertyId: string,
  response: PmsOperatingCalendarCommandResponse,
  request: PmsOperatingCalendarUpsertRequest,
): boolean {
  const configuration = response.configuration;
  return (
    response.outcome === (request.expectedCalendarRevision === 0 ? "created" : "updated") &&
    configuration.calendarRevision === request.expectedCalendarRevision + 1 &&
    configurationMatchesProposal(propertyId, configuration, request)
  );
}

function workspaceMatchesProposal(
  propertyId: string,
  workspace: CalendarWorkspace,
  proposal: PmsOperatingCalendarImpactPreviewRequest,
): boolean {
  const currentRead = workspace.current;
  const configuration = currentRead?.configuration;
  return Boolean(
    configuration &&
    currentRead.sourceStatus === "current" &&
    configuration.calendarRevision === proposal.expectedCalendarRevision &&
    configurationMatchesProposal(propertyId, configuration, proposal),
  );
}

function configurationMatchesProposal(
  propertyId: string,
  configuration: PmsOperatingCalendarCommandResponse["configuration"],
  proposal: PmsOperatingCalendarImpactPreviewRequest,
): boolean {
  return (
    configuration.propertyId === propertyId.toLowerCase() &&
    configuration.sourceInputs.propertyProfile.entityId === propertyId.toLowerCase() &&
    configuration.sourceInputs.propertyProfile.revision ===
      `profile:${proposal.expectedPropertyProfileRevision}` &&
    configuration.defaultMinimumStayNights === proposal.defaultMinimumStayNights &&
    JSON.stringify(configuration.schedule) === JSON.stringify(proposal.schedule) &&
    configuration.sourceInputs.roomBindings.length === proposal.roomTypeLimits.length &&
    configuration.sourceInputs.roomBindings.every((binding, index) => {
      const expected = proposal.roomTypeLimits[index];
      return (
        expected !== undefined &&
        binding.roomTypeId === expected.roomTypeId &&
        binding.sourceRoomFactsRevision === expected.expectedRoomFactsRevision &&
        binding.sourceRoomUnitsRevision === expected.expectedRoomUnitsRevision &&
        binding.startingSellableLimitCount === expected.startingSellableLimitCount
      );
    })
  );
}

function previewOwnerError(error: unknown): Error {
  if (!(error instanceof ApiErrorResponse))
    return asError(error, "Calendar impact could not be previewed.");
  const parsed = parsePmsOperatingCalendarImpactPreviewError(error.data as unknown);
  return parsed && calendarErrorStatus(parsed.code) === error.status
    ? calendarOwnerError(parsed)
    : invalidOwnerContract("operating calendar impact error");
}

function commandOwnerError(error: unknown): Error {
  if (!(error instanceof ApiErrorResponse)) return asError(error, "Calendar could not be applied.");
  const result = parsePmsOperatingCalendarCommandResult(
    { ok: false, error: error.data },
    timeZoneRegistry,
  );
  return result && !result.ok && calendarErrorStatus(result.error.code) === error.status
    ? calendarOwnerError(result.error)
    : invalidOwnerContract("operating calendar command error");
}

function calendarErrorStatus(code: string): number {
  if (code === "setup_scope_unavailable") return 404;
  if (
    code === "property_timezone_missing" ||
    code === "property_timezone_invalid" ||
    code === "active_room_type_set_empty" ||
    code === "room_capacity_unavailable" ||
    code === "starting_sellable_limit_exceeds_capacity"
  ) {
    return 422;
  }
  return 409;
}

function calendarOwnerError(
  error: PmsOperatingCalendarImpactPreviewError | PmsOperatingCalendarCommandError,
): CalendarOwnerError {
  const messages: Partial<Record<typeof error.code, string>> = {
    setup_scope_unavailable: "Calendar access is no longer available for this hotel.",
    materialization_not_current:
      "Calendar availability is still being prepared. Reload the latest calendar and try again.",
    calendar_revision_conflict: "The operating calendar changed in another session.",
    property_timezone_missing: "Add a property timezone before configuring the calendar.",
    property_timezone_invalid: "The saved property timezone is not supported.",
    property_profile_revision_conflict: "The property timezone changed in another session.",
    active_room_type_set_empty: "Add at least one complete room type before opening the calendar.",
    room_type_set_conflict: "The active room types changed in another session.",
    room_facts_revision_conflict: "A room changed in another session.",
    room_units_revision_conflict: "Room capacity changed in another session.",
    room_capacity_unavailable: "Current room capacity is unavailable.",
    starting_sellable_limit_exceeds_capacity:
      "Starting availability is higher than the current room capacity.",
    operating_calendar_unchanged: "These settings already match the current operating calendar.",
    impact_confirmation_invalid: "The calendar impact confirmation is invalid. Preview it again.",
    impact_confirmation_expired: "The calendar impact confirmation expired. Preview it again.",
    impact_confirmation_configuration_mismatch:
      "Calendar settings changed after the impact preview. Preview them again.",
    impact_confirmation_stale:
      "Calendar source data changed after the impact preview. Reload and preview it again.",
    idempotency_key_conflict:
      "This calendar save key was reused for different settings. Reload the latest calendar.",
    command_in_progress: "This calendar save is still processing. Retry in a moment.",
  };
  const refreshCodes = new Set([
    "setup_scope_unavailable",
    "materialization_not_current",
    "calendar_revision_conflict",
    "property_timezone_missing",
    "property_timezone_invalid",
    "property_profile_revision_conflict",
    "active_room_type_set_empty",
    "room_type_set_conflict",
    "room_facts_revision_conflict",
    "room_units_revision_conflict",
    "room_capacity_unavailable",
    "starting_sellable_limit_exceeds_capacity",
    "operating_calendar_unchanged",
    "impact_confirmation_stale",
    "idempotency_key_conflict",
  ]);
  const confirmationCodes = new Set([
    "setup_scope_unavailable",
    "calendar_revision_conflict",
    "property_timezone_missing",
    "property_timezone_invalid",
    "property_profile_revision_conflict",
    "active_room_type_set_empty",
    "room_type_set_conflict",
    "room_facts_revision_conflict",
    "room_units_revision_conflict",
    "room_capacity_unavailable",
    "starting_sellable_limit_exceeds_capacity",
    "impact_confirmation_invalid",
    "impact_confirmation_expired",
    "impact_confirmation_configuration_mismatch",
    "impact_confirmation_stale",
    "idempotency_key_conflict",
  ]);
  return new CalendarOwnerError(
    messages[error.code] ?? "Calendar could not be saved. Try again.",
    error.code,
    error,
    refreshCodes.has(error.code),
    confirmationCodes.has(error.code),
  );
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
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

function invalidClientContract(label: string): TypeError {
  return new TypeError(`The ${label} is invalid.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
