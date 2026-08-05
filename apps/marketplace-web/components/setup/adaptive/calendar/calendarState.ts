import {
  parsePmsOperatingCalendarImpactPreviewRequest,
  parsePmsOperatingCalendarMonthDay,
  parsePmsOperatingSchedule,
  type PmsOperatingCalendarCurrentReadResult,
  type PmsOperatingCalendarImpactPreviewRequest,
} from "@vayada/domain-pms";
import {
  isPropertySetupBaseRevisionManifest,
  type PropertySetupRouteReadModel,
  type ResetPropertySetupDraftRequest,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";

const CALENDAR_DRAFT_FIELDS = [
  "rate.operating_periods",
  "rate.minimum_stay",
  "rate.initial_availability",
] as const;
export const CALENDAR_MAX_PERIODS = 12;

export type CalendarWorkspaceRoom = {
  roomTypeId: string;
  name: string;
  roomFactsRevision: number;
  roomUnitsRevision: number;
  physicalCapacityCount: number;
};

export type CalendarWorkspace = {
  propertyProfileRevision: number;
  propertyTimeZone: string;
  rooms: CalendarWorkspaceRoom[];
  current: PmsOperatingCalendarCurrentReadResult | null;
};

type CalendarPeriodDraft = {
  id: string;
  startsOn: string;
  endsOn: string;
};

type CalendarRoomLimitDraft = CalendarWorkspaceRoom & {
  startingSellableLimit: string;
};

export type CalendarDraft = {
  mode: "" | "year_round" | "recurring";
  periods: CalendarPeriodDraft[];
  defaultMinimumStayNights: string;
  rooms: CalendarRoomLimitDraft[];
  confirmed: boolean;
  dirty: boolean;
};

export type CalendarDraftRevisionContext = {
  sessionId: string | null;
  trackRevision: number;
  sessionRevision: number;
  draftRevision: number;
  baseRevisions: {
    "pms.operating_calendar": string;
    "pms.inventory": string;
    "pms.room_types": string;
    "hotel_catalog.location": string;
  } | null;
};

export type CalendarValidationErrors = Record<string, string>;

export const CALENDAR_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE =
  "This calendar draft is missing its server revision manifest. Refresh setup and try again.";

export function calendarDraftRevisionContext(
  route: PropertySetupRouteReadModel,
  step: PropertySetupRouteReadModel["steps"][number],
): CalendarDraftRevisionContext {
  const draft = step.stepId === "calendar" ? step.draft : null;
  const candidate = draft?.stepId === "calendar" ? draft.baseRevisions : step.currentBaseRevisions;
  const base = isPropertySetupBaseRevisionManifest("calendar", candidate) ? candidate : null;
  return {
    sessionId: route.sessionId,
    trackRevision: route.trackRevision,
    sessionRevision: route.sessionRevision ?? 0,
    draftRevision: draft?.stepId === "calendar" ? draft.revision : 0,
    baseRevisions: base
      ? {
          "pms.operating_calendar": base["pms.operating_calendar"]!,
          "pms.inventory": base["pms.inventory"]!,
          "pms.room_types": base["pms.room_types"]!,
          "hotel_catalog.location": base["hotel_catalog.location"]!,
        }
      : null,
  };
}

export function hydrateCalendarDraft(
  workspace: CalendarWorkspace,
  routeDraft: PropertySetupRouteReadModel["steps"][number]["draft"],
): CalendarDraft {
  const calendarDraft = routeDraft?.stepId === "calendar" ? routeDraft : null;
  const payload = calendarDraft?.payload ?? {};
  const current = workspace.current?.configuration ?? null;
  const savedBindings = new Map(
    current?.sourceInputs.roomBindings.map((binding) => [binding.roomTypeId, binding]) ?? [],
  );
  const hasOperatingPeriodsDraft = Object.hasOwn(payload, "rate.operating_periods");
  const hasMinimumStayDraft = Object.hasOwn(payload, "rate.minimum_stay");
  const hasInitialAvailabilityDraft = Object.hasOwn(payload, "rate.initial_availability");
  const operatingPeriods = record(payload["rate.operating_periods"]);
  const initialAvailability = record(payload["rate.initial_availability"]);
  const draftLimits = record(initialAvailability?.limits);
  const savedSchedule = current?.schedule;
  const draftMode = operatingPeriods?.mode;
  const mode = hasOperatingPeriodsDraft
    ? draftMode === "year_round" || draftMode === "recurring"
      ? draftMode
      : ""
    : savedSchedule?.mode === "year_round" || savedSchedule?.mode === "recurring"
      ? savedSchedule.mode
      : "";
  const rawPeriods = hasOperatingPeriodsDraft
    ? Array.isArray(operatingPeriods?.periods)
      ? operatingPeriods.periods
      : []
    : savedSchedule?.mode === "recurring"
      ? savedSchedule.periods.map(({ startsOn, endsOn }) => ({
          startMonthDay: startsOn,
          endMonthDay: endsOn,
        }))
      : [];
  const periods = rawPeriods.map((value, index) => {
    const item = record(value);
    return {
      id: `calendar-period-${index + 1}`,
      startsOn: typeof item?.startMonthDay === "string" ? item.startMonthDay : "",
      endsOn: typeof item?.endMonthDay === "string" ? item.endMonthDay : "",
    };
  });
  const draftMinimumStay = payload["rate.minimum_stay"];
  const defaultMinimumStayNights = hasMinimumStayDraft
    ? typeof draftMinimumStay === "number"
      ? String(draftMinimumStay)
      : ""
    : current
      ? String(current.defaultMinimumStayNights)
      : "1";
  const rooms = workspace.rooms.map((room) => {
    const draftLimit = draftLimits?.[room.roomTypeId];
    const saved = savedBindings.get(room.roomTypeId);
    return {
      ...room,
      startingSellableLimit: hasInitialAvailabilityDraft
        ? typeof draftLimit === "number"
          ? String(draftLimit)
          : ""
        : saved
          ? String(saved.startingSellableLimitCount)
          : current
            ? ""
            : String(room.physicalCapacityCount),
    };
  });

  return {
    mode,
    periods,
    defaultMinimumStayNights,
    rooms,
    // The server impact token is intentionally not stored in a resumable setup draft.
    // Every mount requires a fresh impact review before final confirmation.
    confirmed: false,
    dirty: false,
  };
}

export function mergeCalendarLocalInput(
  local: CalendarDraft,
  latest: CalendarDraft,
): CalendarDraft {
  const localLimits = new Map(
    local.rooms.map(({ roomTypeId, startingSellableLimit }) => [roomTypeId, startingSellableLimit]),
  );
  return {
    ...latest,
    mode: local.mode,
    periods: local.periods,
    defaultMinimumStayNights: local.defaultMinimumStayNights,
    rooms: latest.rooms.map((room) => ({
      ...room,
      startingSellableLimit: localLimits.get(room.roomTypeId) ?? room.startingSellableLimit,
    })),
    confirmed: false,
    dirty: true,
  };
}

export function calendarDraftManifestIsCurrent(
  step: PropertySetupRouteReadModel["steps"][number],
): boolean {
  if (step.stepId !== "calendar" || step.draft?.stepId !== "calendar") return true;
  const current = step.currentBaseRevisions;
  const historical = step.draft.baseRevisions;
  if (
    !isPropertySetupBaseRevisionManifest("calendar", current) ||
    !isPropertySetupBaseRevisionManifest("calendar", historical)
  ) {
    return false;
  }
  const keys = [
    "pms.operating_calendar",
    "pms.inventory",
    "pms.room_types",
    "hotel_catalog.location",
  ] as const;
  return keys.every((key) => current[key] === historical[key]);
}

export function buildCalendarDraftResetRequest(
  route: PropertySetupRouteReadModel,
  step: PropertySetupRouteReadModel["steps"][number],
): Extract<ResetPropertySetupDraftRequest, { stepId: "calendar" }> {
  const draft = step.stepId === "calendar" && step.draft?.stepId === "calendar" ? step.draft : null;
  if (
    !draft ||
    !route.sessionId ||
    route.sessionRevision === null ||
    !isPropertySetupBaseRevisionManifest("calendar", draft.baseRevisions)
  ) {
    throw new Error("The stale calendar draft cannot be reset without its historical manifest.");
  }
  return {
    sessionId: route.sessionId,
    stepId: "calendar",
    expectedTrackRevision: route.trackRevision,
    expectedSessionRevision: route.sessionRevision,
    expectedDraftRevision: draft.revision,
    expectedBaseRevisions: {
      "pms.operating_calendar": draft.baseRevisions["pms.operating_calendar"]!,
      "pms.inventory": draft.baseRevisions["pms.inventory"]!,
      "pms.room_types": draft.baseRevisions["pms.room_types"]!,
      "hotel_catalog.location": draft.baseRevisions["hotel_catalog.location"]!,
    },
  };
}

export function validateCalendarDraft(
  draft: CalendarDraft,
  options: Readonly<{ requireConfirmation?: boolean }> = {},
): CalendarValidationErrors {
  const errors: CalendarValidationErrors = {};
  if (!draft.mode) {
    errors.mode = "Choose when your hotel is open for stays.";
  } else if (draft.mode === "recurring") {
    if (draft.periods.length === 0) {
      errors.periods = "Add at least one recurring open period.";
    }
    draft.periods.forEach((period, index) => {
      if (!parsePmsOperatingCalendarMonthDay(period.startsOn)) {
        errors[`periods.${index}.startsOn`] = "Choose a valid first open night.";
      }
      if (!parsePmsOperatingCalendarMonthDay(period.endsOn)) {
        errors[`periods.${index}.endsOn`] = "Choose a valid last open night.";
      }
    });
    if (draft.periods.length > CALENDAR_MAX_PERIODS) {
      errors.periods = `Use no more than ${CALENDAR_MAX_PERIODS} open periods.`;
    } else if (
      draft.periods.length > 0 &&
      !parsePmsOperatingSchedule({
        mode: "recurring",
        periods: draft.periods.map(({ startsOn, endsOn }) => ({ startsOn, endsOn })),
      })
    ) {
      errors.periods =
        "Open periods cannot overlap or cover the complete year. Merge adjacent dates or choose All year.";
    }
  }

  if (!wholeNumber(draft.defaultMinimumStayNights, 1, 366)) {
    errors.defaultMinimumStayNights = "Enter a whole number from 1 to 366.";
  }
  if (draft.rooms.length === 0) {
    errors.rooms = "Add at least one complete room type before opening the calendar.";
  }
  for (const room of draft.rooms) {
    if (!wholeNumber(room.startingSellableLimit, 1, room.physicalCapacityCount)) {
      errors[`rooms.${room.roomTypeId}`] =
        `Enter a whole number from 1 to ${room.physicalCapacityCount}.`;
    }
  }
  if (options.requireConfirmation !== false && !draft.confirmed) {
    errors.confirmed = "Confirm the starting calendar settings before continuing.";
  }
  return errors;
}

export function buildCalendarProposal(
  draft: CalendarDraft,
  workspace: CalendarWorkspace,
): PmsOperatingCalendarImpactPreviewRequest {
  const proposal = parsePmsOperatingCalendarImpactPreviewRequest({
    expectedCalendarRevision: workspace.current?.configuration.calendarRevision ?? 0,
    expectedPropertyProfileRevision: workspace.propertyProfileRevision,
    schedule:
      draft.mode === "recurring"
        ? {
            mode: "recurring",
            periods: draft.periods.map(({ startsOn, endsOn }) => ({ startsOn, endsOn })),
          }
        : { mode: "year_round", periods: [] },
    defaultMinimumStayNights: Number(draft.defaultMinimumStayNights),
    roomTypeLimits: draft.rooms.map((room) => ({
      roomTypeId: room.roomTypeId,
      expectedRoomFactsRevision: room.roomFactsRevision,
      expectedRoomUnitsRevision: room.roomUnitsRevision,
      startingSellableLimitCount: Number(room.startingSellableLimit),
    })),
  });
  if (!proposal) {
    throw new Error("The calendar proposal is invalid. Review every calendar field and try again.");
  }
  return proposal;
}

export function buildCalendarDraftRequest(
  draft: CalendarDraft,
  revision: CalendarDraftRevisionContext,
): Extract<SavePropertySetupDraftRequest, { stepId: "calendar" }> {
  if (revision.baseRevisions === null) {
    throw new Error(CALENDAR_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE);
  }
  return {
    stepId: "calendar",
    payload: {
      "rate.operating_periods": {
        mode: draft.mode || null,
        periods: draft.periods.map(({ startsOn, endsOn }) => ({
          startMonthDay: parsePmsOperatingCalendarMonthDay(startsOn) ? startsOn : null,
          endMonthDay: parsePmsOperatingCalendarMonthDay(endsOn) ? endsOn : null,
        })),
      },
      "rate.minimum_stay": wholeNumber(draft.defaultMinimumStayNights, 1, 366)
        ? Number(draft.defaultMinimumStayNights)
        : null,
      "rate.initial_availability": {
        limits: Object.fromEntries(
          draft.rooms.map((room) => [
            room.roomTypeId,
            wholeNumber(room.startingSellableLimit, 1, 500)
              ? Number(room.startingSellableLimit)
              : null,
          ]),
        ),
        confirmed: draft.confirmed,
      },
    },
    dirtyFields: [...CALENDAR_DRAFT_FIELDS],
    expectedBaseRevisions: revision.baseRevisions,
    expectedTrackRevision: revision.trackRevision,
    expectedSessionRevision: revision.sessionRevision,
    expectedDraftRevision: revision.draftRevision,
  };
}

function wholeNumber(value: string, minimum: number, maximum: number): boolean {
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
