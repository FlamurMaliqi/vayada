"use client";

import { ExclamationTriangleIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  PmsOperatingCalendarImpactPreview,
  PmsOperatingCalendarImpactPreviewRequest,
} from "@vayada/domain-pms";

import { ApiErrorResponse } from "@/services/api/client";
import { CalendarOwnerError, calendarApi } from "@/services/api/calendarApiClient";
import {
  PropertySetupDraftResetError,
  propertySetupDraftResetApi,
} from "@/services/api/propertySetupDraftResetClient";
import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  CALENDAR_MAX_PERIODS,
  CALENDAR_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE,
  buildCalendarDraftResetRequest,
  buildCalendarDraftRequest,
  buildCalendarProposal,
  calendarDraftManifestIsCurrent,
  calendarDraftRevisionContext,
  hydrateCalendarDraft,
  mergeCalendarLocalInput,
  validateCalendarDraft,
  type CalendarDraft,
  type CalendarDraftRevisionContext,
  type CalendarValidationErrors,
  type CalendarWorkspace,
} from "./calendarState";

type WorkspaceState = "loading" | "ready" | "error";

type CalendarImpactReview = Readonly<{
  proposal: PmsOperatingCalendarImpactPreviewRequest;
  preview: PmsOperatingCalendarImpactPreview;
}>;

export function CalendarStep(props: AdaptiveSetupStepComponentProps) {
  const {
    propertyId,
    registerBeforeLeave,
    registerStaleRecovery,
    reportRevisionConflict,
    refreshRoute,
    route,
    saveAndContinue,
    step,
    interfaceLocale,
  } = props;
  const routeRevision = useMemo(() => calendarDraftRevisionContext(route, step), [route, step]);
  const revisionRef = useRef<CalendarDraftRevisionContext>(routeRevision);
  const revisionIdentityRef = useRef(
    `${propertyId}:${routeRevision.sessionId ?? "none"}:${step.stepId}`,
  );
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const draftRef = useRef<CalendarDraft | null>(null);
  const impactReviewRef = useRef<CalendarImpactReview | null>(null);
  const retainLocalOnReloadRef = useRef(false);
  const discardHistoricalOnReloadRef = useRef(false);
  const [draft, setDraft] = useState<CalendarDraft | null>(null);
  const [impactReview, setImpactReview] = useState<CalendarImpactReview | null>(null);
  const [workspace, setWorkspace] = useState<CalendarWorkspace | null>(null);
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>("loading");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceReload, setWorkspaceReload] = useState(0);
  const [errors, setErrors] = useState<CalendarValidationErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const mounted = useRef(true);
  const manifestMissing = routeRevision.baseRevisions === null;
  const manifestStale = !calendarDraftManifestIsCurrent(step);
  const scopeInvalid = propertyId.toLowerCase() !== route.scope.propertyId;

  useEffect(() => {
    const identity = `${propertyId}:${routeRevision.sessionId ?? "none"}:${step.stepId}`;
    const current = revisionRef.current;
    const routeIsNewer =
      routeRevision.trackRevision > current.trackRevision ||
      routeRevision.sessionRevision > current.sessionRevision ||
      routeRevision.draftRevision > current.draftRevision;
    if (identity !== revisionIdentityRef.current || routeIsNewer) {
      revisionIdentityRef.current = identity;
      revisionRef.current = routeRevision;
    }
  }, [propertyId, routeRevision, step.stepId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const commitDraft = useCallback((next: CalendarDraft) => {
    draftRef.current = next;
    if (mounted.current) setDraft(next);
  }, []);

  const commitImpactReview = useCallback((next: CalendarImpactReview | null) => {
    impactReviewRef.current = next;
    if (mounted.current) setImpactReview(next);
  }, []);

  const persistDraft = useCallback(async () => {
    if (saveInFlightRef.current) await saveInFlightRef.current;
    const current = draftRef.current;
    if (!current?.dirty) return;
    if (manifestMissing || scopeInvalid) {
      throw new Error(CALENDAR_DRAFT_MANIFEST_UNAVAILABLE_MESSAGE);
    }
    if (manifestStale) {
      const message = "Start from the current calendar before saving this historical draft.";
      reportRevisionConflict(message);
      throw new Error(message);
    }
    const save = (async () => {
      setSaving(true);
      setSaveError(null);
      try {
        const revision = revisionRef.current;
        const request = buildCalendarDraftRequest(current, revision);
        const receipt = await calendarApi.saveDraft(propertyId, request, revision.sessionId);
        revisionRef.current = {
          ...revisionRef.current,
          sessionId: receipt.sessionId,
          trackRevision: receipt.trackRevision,
          sessionRevision: receipt.sessionRevision,
          draftRevision: receipt.draftRevision,
        };
        const hasNewerEdits = draftRef.current !== current;
        if (!hasNewerEdits) commitDraft({ ...current, dirty: false });
        if (mounted.current) {
          setAnnouncement(
            hasNewerEdits
              ? "Earlier calendar changes saved. Your latest edits still need to be saved."
              : "Calendar draft saved.",
          );
        }
      } catch (error) {
        if (error instanceof CalendarOwnerError && error.requiresRefresh) {
          reportRevisionConflict(
            "This calendar draft changed in another tab or session. Refresh it before continuing.",
          );
        }
        if (mounted.current) setSaveError(errorMessage(error));
        throw error;
      } finally {
        if (mounted.current) setSaving(false);
      }
    })();
    saveInFlightRef.current = save;
    try {
      await save;
    } finally {
      if (saveInFlightRef.current === save) saveInFlightRef.current = null;
    }
  }, [
    commitDraft,
    manifestMissing,
    manifestStale,
    propertyId,
    reportRevisionConflict,
    scopeInvalid,
  ]);

  useEffect(() => registerBeforeLeave(persistDraft), [persistDraft, registerBeforeLeave]);

  useEffect(() => {
    const controller = new AbortController();
    if (manifestMissing || scopeInvalid || step.stepId !== "calendar") {
      setWorkspaceState("ready");
      setWorkspaceError(null);
      return () => controller.abort();
    }
    setWorkspaceState("loading");
    setWorkspaceError(null);
    void calendarApi
      .loadWorkspace(propertyId, { signal: controller.signal, cache: "no-store" })
      .then((loaded) => {
        if (controller.signal.aborted) return;
        const hydrated = hydrateCalendarDraft(loaded, step.draft);
        const next = discardHistoricalOnReloadRef.current
          ? hydrated
          : retainLocalOnReloadRef.current && draftRef.current
            ? mergeCalendarLocalInput(draftRef.current, hydrated)
            : hydrated;
        discardHistoricalOnReloadRef.current = false;
        retainLocalOnReloadRef.current = false;
        setWorkspace(loaded);
        commitDraft(next);
        commitImpactReview(null);
        setErrors({});
        setSaveError(null);
        setWorkspaceState("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setWorkspaceState("error");
        setWorkspaceError(errorMessage(error));
      });
    return () => controller.abort();
  }, [
    commitDraft,
    commitImpactReview,
    manifestMissing,
    propertyId,
    scopeInvalid,
    step.draft,
    step.stepId,
    workspaceReload,
  ]);

  const updateDraft = (
    update: (current: CalendarDraft) => CalendarDraft,
    options?: { preserveConfirmation?: boolean },
  ) => {
    const current = draftRef.current;
    if (!current) return;
    const next = update(current);
    const confirmationCleared = current.confirmed && !options?.preserveConfirmation;
    commitDraft({
      ...next,
      confirmed: options?.preserveConfirmation ? next.confirmed : false,
      dirty: true,
    });
    if (!options?.preserveConfirmation) commitImpactReview(null);
    setSaveError(null);
    if (confirmationCleared) setAnnouncement("Calendar confirmation cleared after a change.");
  };

  const chooseMode = (mode: "year_round" | "recurring") => {
    updateDraft((current) => ({
      ...current,
      mode,
      periods:
        mode === "year_round"
          ? []
          : current.periods.length > 0
            ? current.periods
            : [{ id: periodId(), startsOn: "", endsOn: "" }],
    }));
    clearErrors(setErrors, ["mode", "periods"]);
  };

  const addPeriod = () => {
    const current = draftRef.current;
    if (!current || current.periods.length >= CALENDAR_MAX_PERIODS) return;
    const id = periodId();
    updateDraft((value) => ({
      ...value,
      periods: [...value.periods, { id, startsOn: "", endsOn: "" }],
    }));
    setAnnouncement("Open period added.");
    requestAnimationFrame(() => document.getElementById(`${id}-start-month`)?.focus());
  };

  const removePeriod = (id: string, label: string) => {
    updateDraft((current) => ({
      ...current,
      periods: current.periods.filter((period) => period.id !== id),
    }));
    clearErrorPrefix(setErrors, "periods");
    setAnnouncement(`${label} removed.`);
  };

  const resetStaleDraft = useCallback(async () => {
    if (resetting) return;
    retainLocalOnReloadRef.current = true;
    setResetting(true);
    setSaveError(null);
    commitImpactReview(null);
    try {
      const request = buildCalendarDraftResetRequest(route, step);
      await propertySetupDraftResetApi.reset(propertyId, request);
      discardHistoricalOnReloadRef.current = true;
      retainLocalOnReloadRef.current = false;
      await refreshRoute();
      if (mounted.current) {
        setAnnouncement("The stale saved draft was removed. Review the current calendar.");
      }
    } catch (error) {
      if (error instanceof PropertySetupDraftResetError && error.requiresRefresh) {
        reportRevisionConflict(error.message);
      }
      if (mounted.current) setSaveError(errorMessage(error));
      throw error;
    } finally {
      if (mounted.current) setResetting(false);
    }
  }, [
    commitImpactReview,
    propertyId,
    refreshRoute,
    reportRevisionConflict,
    resetting,
    route,
    step,
  ]);

  const refreshCurrentCalendar = useCallback(async () => {
    if (!discardHistoricalOnReloadRef.current) retainLocalOnReloadRef.current = true;
    setSaveError(null);
    commitImpactReview(null);
    try {
      await refreshRoute();
      if (mounted.current) setWorkspaceReload((value) => value + 1);
    } catch (error) {
      if (mounted.current) setSaveError(errorMessage(error));
      throw error;
    }
  }, [commitImpactReview, refreshRoute]);

  const recoverStaleDraft = useCallback(
    () => (step.draft ? resetStaleDraft() : refreshCurrentCalendar()),
    [refreshCurrentCalendar, resetStaleDraft, step.draft],
  );

  useEffect(
    () => registerStaleRecovery?.(recoverStaleDraft, step.draft ? "reset" : "refresh"),
    [recoverStaleDraft, registerStaleRecovery, step.draft],
  );

  const reportCalendarError = (error: unknown) => {
    if (error instanceof CalendarOwnerError) {
      if (error.requiresPreview) {
        commitImpactReview(null);
        const current = draftRef.current;
        if (current?.confirmed) commitDraft({ ...current, confirmed: false, dirty: true });
        setAnnouncement("Calendar impact confirmation cleared. Review the current impact again.");
      }
      if (error.requiresRefresh) reportRevisionConflict(error.message);
    }
    if (mounted.current) setSaveError(errorMessage(error));
  };

  const reviewImpact = async () => {
    const current = draftRef.current;
    if (!current || !workspace || saving || previewing || applying) return;
    const nextErrors = validateCalendarDraft(current, { requireConfirmation: false });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstCalendarError(nextErrors);
      return;
    }
    let proposal: PmsOperatingCalendarImpactPreviewRequest;
    try {
      proposal = buildCalendarProposal(current, workspace);
    } catch (error) {
      setSaveError(errorMessage(error));
      return;
    }
    setPreviewing(true);
    setSaveError(null);
    commitImpactReview(null);
    try {
      await persistDraft();
      const afterDraftSave = draftRef.current;
      if (
        !afterDraftSave ||
        !sameProposal(proposal, buildCalendarProposal(afterDraftSave, workspace))
      ) {
        setAnnouncement("Your latest calendar edits are saved. Review their impact when ready.");
        return;
      }
      const preview = await calendarApi.previewImpact(propertyId, proposal);
      const latest = draftRef.current;
      if (!latest || !sameProposal(proposal, buildCalendarProposal(latest, workspace))) {
        setAnnouncement("Calendar settings changed during review. Review the latest impact again.");
        return;
      }
      commitImpactReview({ proposal, preview });
      if (latest.confirmed) commitDraft({ ...latest, confirmed: false, dirty: true });
      setAnnouncement("Calendar impact is ready to review.");
    } catch (error) {
      reportCalendarError(error);
    } finally {
      if (mounted.current) setPreviewing(false);
    }
  };

  const applyCalendar = async () => {
    const current = draftRef.current;
    const review = impactReviewRef.current;
    if (!current || !workspace || !review || saving || previewing || applying) return;
    const nextErrors = validateCalendarDraft(current);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstCalendarError(nextErrors);
      return;
    }
    if (!sameProposal(review.proposal, buildCalendarProposal(current, workspace))) {
      commitImpactReview(null);
      setSaveError("Calendar settings changed after the impact review. Review the impact again.");
      return;
    }
    setApplying(true);
    setSaveError(null);
    try {
      await persistDraft();
      const latest = draftRef.current;
      if (
        impactReviewRef.current !== review ||
        !latest ||
        !sameProposal(review.proposal, buildCalendarProposal(latest, workspace))
      ) {
        setAnnouncement("Your latest edits remain saved as a draft. Review their impact again.");
        return;
      }
      const saved = await calendarApi.applyCalendar(
        propertyId,
        review.proposal,
        review.preview.confirmation,
      );
      if (!mounted.current) return;
      setWorkspace(saved);
      commitDraft(hydrateCalendarDraft(saved, null));
      commitImpactReview(null);
      setAnnouncement("Starting calendar saved.");
      await refreshRoute();
      await saveAndContinue();
    } catch (error) {
      reportCalendarError(error);
    } finally {
      if (mounted.current) setApplying(false);
    }
  };

  if (manifestMissing || scopeInvalid || step.stepId !== "calendar") {
    return (
      <StatusPanel
        title="Calendar setup data is unavailable"
        message="The exact server revision manifest is missing. Refresh setup before entering calendar settings."
        actionLabel="Refresh setup"
        onAction={() => void refreshRoute()}
      />
    );
  }

  if (workspaceState === "loading") return <CalendarSkeleton />;
  if (workspaceState === "error" || !workspace || !draft) {
    return (
      <StatusPanel
        title="Calendar could not be loaded"
        message={workspaceError ?? "Protected calendar data is unavailable."}
        actionLabel="Retry"
        onAction={() => setWorkspaceReload((value) => value + 1)}
      />
    );
  }

  const sourceStale = workspace.current?.sourceStatus === "stale";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-10">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {saveError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4" role="alert">
          <p className="text-sm font-semibold text-red-900">Calendar draft was not saved</p>
          <p className="mt-1 text-sm leading-6 text-red-800">{saveError}</p>
          <button
            type="button"
            disabled={resetting}
            className={`${secondaryButtonClass} mt-3`}
            onClick={() =>
              void (manifestStale ? resetStaleDraft() : refreshCurrentCalendar()).catch(
                () => undefined,
              )
            }
          >
            {manifestStale
              ? resetting
                ? "Starting from latest..."
                : "Start from latest calendar"
              : "Refresh current calendar"}
          </button>
        </div>
      )}

      {manifestStale && (
        <StatusPanel
          title="Calendar sources changed since this draft was started"
          message="The saved draft keeps its historical revision manifest and cannot overwrite newer calendar data. Starting from the current calendar discards the historical saved values after fresh owner data loads."
          actionLabel={resetting ? "Starting from latest..." : "Start from latest calendar"}
          onAction={() => void resetStaleDraft().catch(() => undefined)}
        />
      )}

      {sourceStale && !manifestStale && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4" role="status">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 text-amber-700" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-amber-950">
                Room or property details changed
              </p>
              <p className="mt-1 text-sm leading-6 text-amber-900">
                Review the current room capacities and run a fresh impact review before saving. Your
                protected draft remains available while you decide.
              </p>
              <button
                type="button"
                className={`${secondaryButtonClass} mt-3`}
                onClick={() => void refreshCurrentCalendar().catch(() => undefined)}
              >
                Refresh current calendar
              </button>
            </div>
          </div>
        </div>
      )}

      <section aria-labelledby="calendar-schedule-heading" className="space-y-5">
        <div>
          <h2 id="calendar-schedule-heading" className="text-lg font-semibold text-gray-950">
            When is your hotel open for stays?
          </h2>
          <p className="mt-1 text-sm leading-6 text-gray-600">
            Choose all year or recurring open periods in {workspace.propertyTimeZone}.
          </p>
        </div>
        <fieldset aria-describedby={errors.mode ? "calendar-mode-error" : undefined}>
          <legend className="sr-only">Operating calendar</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <RadioChoice
              id="calendar-mode-year-round"
              checked={draft.mode === "year_round"}
              label="All year"
              description="Accept stays throughout the year."
              onChange={() => chooseMode("year_round")}
            />
            <RadioChoice
              id="calendar-mode-recurring"
              checked={draft.mode === "recurring"}
              label="Only during parts of the year"
              description="Set open periods that repeat every year."
              onChange={() => chooseMode("recurring")}
            />
          </div>
          <FieldError id="calendar-mode-error" message={errors.mode} />
        </fieldset>

        {draft.mode === "recurring" && (
          <div className="space-y-4">
            {draft.periods.map((period, index) => (
              <fieldset
                key={period.id}
                className="relative rounded-2xl border border-gray-200 bg-white p-4 sm:p-5"
                aria-describedby={errors.periods ? "calendar-periods-error" : undefined}
              >
                <legend className="pr-14 text-sm font-semibold text-gray-950">
                  Open period {index + 1}
                </legend>
                <button
                  type="button"
                  className={`${iconButtonClass} absolute right-3 top-2 sm:right-4 sm:top-3`}
                  aria-label={`Remove open period ${index + 1}`}
                  onClick={() => removePeriod(period.id, `Open period ${index + 1}`)}
                >
                  <TrashIcon className="h-5 w-5" aria-hidden="true" />
                </button>
                <p className="mt-2 pr-12 text-sm leading-6 text-gray-600">
                  Both dates are stay nights. Guests may check out the following day. Dates repeat
                  every year.
                </p>
                <div className="mt-4 grid gap-5 sm:grid-cols-2">
                  <MonthDayField
                    id={`${period.id}-start`}
                    label="First open night"
                    value={period.startsOn}
                    locale={interfaceLocale}
                    error={errors[`periods.${index}.startsOn`]}
                    onChange={(startsOn) =>
                      updateDraft((current) => ({
                        ...current,
                        periods: current.periods.map((candidate) =>
                          candidate.id === period.id ? { ...candidate, startsOn } : candidate,
                        ),
                      }))
                    }
                  />
                  <MonthDayField
                    id={`${period.id}-end`}
                    label="Last open night"
                    value={period.endsOn}
                    locale={interfaceLocale}
                    error={errors[`periods.${index}.endsOn`]}
                    onChange={(endsOn) =>
                      updateDraft((current) => ({
                        ...current,
                        periods: current.periods.map((candidate) =>
                          candidate.id === period.id ? { ...candidate, endsOn } : candidate,
                        ),
                      }))
                    }
                  />
                </div>
              </fieldset>
            ))}
            <FieldError id="calendar-periods-error" message={errors.periods} />
            <button
              id="calendar-add-period"
              type="button"
              className={secondaryButtonClass}
              onClick={addPeriod}
              disabled={draft.periods.length >= CALENDAR_MAX_PERIODS}
            >
              <PlusIcon className="h-5 w-5" aria-hidden="true" />
              Add another period
            </button>
          </div>
        )}
      </section>

      <section
        aria-labelledby="calendar-availability-heading"
        className="border-t border-gray-200 pt-9"
      >
        <h2 id="calendar-availability-heading" className="text-lg font-semibold text-gray-950">
          Starting availability
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">
          Set how many rooms can be sold on each open date. Bookings and room blocks reduce
          availability automatically.
        </p>
        <div className="mt-5 space-y-3">
          {draft.rooms.map((room) => {
            const error = errors[`rooms.${room.roomTypeId}`];
            return (
              <div
                key={room.roomTypeId}
                className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end"
              >
                <div>
                  <p className="text-sm font-semibold text-gray-950">{room.name}</p>
                  <p className="mt-1 text-sm text-gray-600">
                    {room.physicalCapacityCount}{" "}
                    {room.physicalCapacityCount === 1 ? "room" : "rooms"} total
                  </p>
                </div>
                <TextField
                  id={`calendar-room-${room.roomTypeId}`}
                  label={`Available ${room.name} rooms`}
                  value={room.startingSellableLimit}
                  suffix="rooms"
                  error={error}
                  onChange={(startingSellableLimit) => {
                    updateDraft((current) => ({
                      ...current,
                      rooms: current.rooms.map((candidate) =>
                        candidate.roomTypeId === room.roomTypeId
                          ? { ...candidate, startingSellableLimit }
                          : candidate,
                      ),
                    }));
                    clearErrors(setErrors, [`rooms.${room.roomTypeId}`]);
                  }}
                />
              </div>
            );
          })}
        </div>
        <FieldError id="calendar-rooms-error" message={errors.rooms} />
      </section>

      <section
        aria-labelledby="calendar-minimum-stay-heading"
        className="border-t border-gray-200 pt-9"
      >
        <h2 id="calendar-minimum-stay-heading" className="text-lg font-semibold text-gray-950">
          Default minimum stay
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">
          Applies to every room and rate unless you add a date-specific rule later.
        </p>
        <div className="mt-4 max-w-xs">
          <TextField
            id="calendar-minimum-stay"
            label="Minimum stay"
            value={draft.defaultMinimumStayNights}
            suffix={draft.defaultMinimumStayNights === "1" ? "night" : "nights"}
            error={errors.defaultMinimumStayNights}
            onChange={(defaultMinimumStayNights) => {
              updateDraft((current) => ({ ...current, defaultMinimumStayNights }));
              clearErrors(setErrors, ["defaultMinimumStayNights"]);
            }}
          />
        </div>
      </section>

      <section aria-labelledby="calendar-impact-heading" className="border-t border-gray-200 pt-9">
        <h2 id="calendar-impact-heading" className="text-lg font-semibold text-gray-950">
          Review the impact before saving
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">
          We compare these settings with current inventory, accepted bookings, room blocks, and
          owner overrides. The review contains totals only, never guest details.
        </p>

        {impactReview ? (
          <div className="mt-5 space-y-5">
            <CalendarImpactPanel
              review={impactReview}
              rooms={draft.rooms}
              locale={interfaceLocale}
            />
            <fieldset
              aria-describedby={errors.confirmed ? "calendar-confirmation-error" : undefined}
            >
              <legend className="sr-only">Starting calendar confirmation</legend>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-800 focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2">
                <input
                  id="calendar-confirmation"
                  type="checkbox"
                  checked={draft.confirmed}
                  aria-invalid={Boolean(errors.confirmed)}
                  onChange={(event) => {
                    updateDraft((current) => ({ ...current, confirmed: event.target.checked }), {
                      preserveConfirmation: true,
                    });
                    clearErrors(setErrors, ["confirmed"]);
                  }}
                  className="mt-0.5 h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
                />
                <span>
                  <span className="font-semibold text-gray-950">
                    I reviewed this impact and want to create the starting calendar.
                  </span>
                  <span className="mt-1 block leading-6 text-gray-600">
                    This confirmation applies only to the exact settings and source revisions shown
                    above. It expires at{" "}
                    {formatDateTime(impactReview.preview.confirmation.expiresAt, interfaceLocale)}.
                  </span>
                </span>
              </label>
              <FieldError id="calendar-confirmation-error" message={errors.confirmed} />
            </fieldset>
          </div>
        ) : (
          <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 text-sm leading-6 text-gray-700">
            Save the protected draft and run an impact review to unlock final confirmation.
          </div>
        )}
      </section>

      <div className="border-t border-gray-200 pt-6">
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          <button
            type="button"
            className={`${secondaryButtonClass} justify-center`}
            disabled={
              saving || previewing || applying || resetting || manifestStale || !draft.dirty
            }
            onClick={() => void persistDraft().catch(() => undefined)}
          >
            {saving ? "Saving..." : "Save draft"}
          </button>
          <button
            type="button"
            className={`${secondaryButtonClass} justify-center`}
            disabled={saving || previewing || applying || resetting || manifestStale}
            onClick={() => void reviewImpact()}
          >
            {previewing
              ? "Reviewing impact..."
              : impactReview
                ? "Review impact again"
                : "Review impact"}
          </button>
          <button
            type="button"
            className={`${primaryButtonClass} justify-center`}
            disabled={
              saving ||
              previewing ||
              applying ||
              resetting ||
              manifestStale ||
              !impactReview ||
              !draft.confirmed
            }
            onClick={() => void applyCalendar()}
          >
            {applying ? "Saving calendar..." : "Save and continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CalendarImpactPanel({
  review,
  rooms,
  locale,
}: {
  review: CalendarImpactReview;
  rooms: readonly Readonly<{ roomTypeId: string; name: string }>[];
  locale: string;
}) {
  const { impact } = review.preview;
  const { summary } = impact;
  const number = new Intl.NumberFormat(locale);
  const roomNames = new Map(rooms.map(({ roomTypeId, name }) => [roomTypeId, name]));
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-4 py-4 sm:px-5">
        <p className="text-sm font-semibold text-gray-950">Current impact</p>
        <p className="mt-1 text-sm leading-6 text-gray-600">
          Generated {formatDateTime(review.preview.generatedAt, locale)} from the exact current
          calendar, room, profile, and inventory revisions.
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-gray-200 sm:grid-cols-4">
        <ImpactMetric label="Dates closing" value={summary.closingDateCount} number={number} />
        <ImpactMetric label="Dates opening" value={summary.openingDateCount} number={number} />
        <ImpactMetric
          label="Room nights removed"
          value={summary.availableRoomNightsRemoved}
          number={number}
        />
        <ImpactMetric
          label="Room nights added"
          value={summary.availableRoomNightsAdded}
          number={number}
        />
      </dl>

      {summary.defaultMinimumStayChanged && (
        <div className="border-t border-sky-200 bg-sky-50 px-4 py-4 text-sm leading-6 text-sky-950 sm:px-5">
          <p className="font-semibold">Default minimum stay changes</p>
          <p className="mt-1">
            The new minimum will apply by default across the operating calendar.
          </p>
        </div>
      )}

      {impact.categories.length > 0 && (
        <div className="border-t border-gray-200 px-4 py-4 sm:px-5">
          <p className="text-sm font-semibold text-gray-950">Changes included in this review</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-gray-700">
            {impact.categories.map((category) => (
              <li key={category}>{impactCategoryLabel(category)}</li>
            ))}
          </ul>
        </div>
      )}

      {(summary.acceptedBookingCount > 0 ||
        summary.blockedRoomNights > 0 ||
        summary.ownerOverrideDateCount > 0) && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-950 sm:px-5">
          <p className="font-semibold">Existing activity needs your attention</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {summary.acceptedBookingCount > 0 && (
              <li>
                {number.format(summary.acceptedBookingCount)} accepted{" "}
                {summary.acceptedBookingCount === 1 ? "booking" : "bookings"} across{" "}
                {number.format(summary.acceptedBookedRoomNights)} room nights
              </li>
            )}
            {summary.blockedRoomNights > 0 && (
              <li>{number.format(summary.blockedRoomNights)} blocked room nights</li>
            )}
            {summary.ownerOverrideDateCount > 0 && (
              <li>{number.format(summary.ownerOverrideDateCount)} dates with owner overrides</li>
            )}
          </ul>
        </div>
      )}

      {impact.roomTypeChanges.length > 0 && (
        <div className="border-t border-gray-200 px-4 py-4 sm:px-5">
          <p className="text-sm font-semibold text-gray-950">Starting availability by room</p>
          <ul className="mt-3 divide-y divide-gray-100 text-sm">
            {impact.roomTypeChanges.map((change) => (
              <li
                key={change.roomTypeId}
                className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="font-medium text-gray-900">
                  {roomNames.get(change.roomTypeId) ?? "Room type"}
                </span>
                <span className="text-gray-600">
                  {change.previousStartingSellableLimitCount === null
                    ? "Not configured"
                    : number.format(change.previousStartingSellableLimitCount)}{" "}
                  → {number.format(change.proposedStartingSellableLimitCount)} rooms;{" "}
                  {signedNumber(change.availableRoomNightsDelta, number)} room nights
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {impact.affectedDates.length > 0 && (
        <details className="border-t border-gray-200 px-4 py-4 sm:px-5">
          <summary className="cursor-pointer text-sm font-semibold text-gray-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2">
            Review {number.format(impact.affectedDates.length)} affected{" "}
            {impact.affectedDates.length === 1 ? "date" : "dates"}
          </summary>
          <div className="mt-4 max-h-80 overflow-auto rounded-xl border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
              <caption className="sr-only">Affected calendar dates and availability</caption>
              <thead className="sticky top-0 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-600">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Change
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Availability
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Bookings
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white text-gray-700">
                {impact.affectedDates.map((date) => (
                  <tr key={date.stayDate}>
                    <th
                      scope="row"
                      className="whitespace-nowrap px-3 py-2 font-medium text-gray-950"
                    >
                      {formatStayDate(date.stayDate, locale)}
                    </th>
                    <td className="whitespace-nowrap px-3 py-2">
                      {impactStatusLabel(date.statusChange)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {number.format(date.availableCountBefore)} →{" "}
                      {number.format(date.availableCountAfter)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {number.format(date.acceptedBookingCount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function ImpactMetric({
  label,
  value,
  number,
}: {
  label: string;
  value: number;
  number: Intl.NumberFormat;
}) {
  return (
    <div className="bg-white px-4 py-4">
      <dt className="text-xs font-medium text-gray-600">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-gray-950">{number.format(value)}</dd>
    </div>
  );
}

function MonthDayField({
  id,
  label,
  value,
  locale,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  locale: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const [month = "", day = ""] = value.split("-");
  const maximumDay = month ? daysInMonth(Number(month)) : 0;
  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => ({
        value: String(index + 1).padStart(2, "0"),
        label: new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
          new Date(Date.UTC(2024, index, 1)),
        ),
      })),
    [locale],
  );
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div>
      <p className="text-sm font-semibold text-gray-900">{label}</p>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
        <label className="text-xs font-medium text-gray-700">
          Month
          <select
            id={`${id}-month`}
            aria-label={`${label} month`}
            value={month}
            aria-invalid={Boolean(error)}
            aria-describedby={errorId}
            className={inputClass(Boolean(error))}
            onChange={(event) => {
              const nextMonth = event.target.value;
              if (!nextMonth) return onChange("");
              const nextMaximum = daysInMonth(Number(nextMonth));
              const nextDay = day && Number(day) <= nextMaximum ? day : "01";
              onChange(`${nextMonth}-${nextDay}`);
            }}
          >
            <option value="">Choose</option>
            {months.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-gray-700">
          Day
          <select
            id={`${id}-day`}
            aria-label={`${label} day`}
            value={day}
            disabled={!month}
            aria-invalid={Boolean(error)}
            aria-describedby={errorId}
            className={inputClass(Boolean(error))}
            onChange={(event) => onChange(`${month}-${event.target.value}`)}
          >
            {!month && <option value="">Day</option>}
            {Array.from({ length: maximumDay }, (_, index) => {
              const item = String(index + 1).padStart(2, "0");
              return (
                <option key={item} value={item}>
                  {index + 1}
                </option>
              );
            })}
          </select>
        </label>
      </div>
      <FieldError id={errorId ?? `${id}-error`} message={error} />
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  suffix,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  suffix: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-gray-900">
        {label}
      </label>
      <div className="mt-2 flex items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error)}
          aria-describedby={errorId}
          className={inputClass(Boolean(error))}
        />
        <span className="shrink-0 text-sm text-gray-600">{suffix}</span>
      </div>
      <FieldError id={errorId ?? `${id}-error`} message={error} />
    </div>
  );
}

function RadioChoice({
  id,
  checked,
  label,
  description,
  onChange,
}: {
  id: string;
  checked: boolean;
  label: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2">
      <input
        id={id}
        type="radio"
        name="calendar-mode"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-5 w-5 border-gray-300 text-primary-600 focus:ring-primary-600"
      />
      <span>
        <span className="block text-sm font-semibold text-gray-950">{label}</span>
        <span className="mt-1 block text-sm leading-6 text-gray-600">{description}</span>
      </span>
    </label>
  );
}

function StatusPanel({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div
      className="mx-auto max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-6"
      role="status"
    >
      <div className="flex items-start gap-3">
        <ExclamationTriangleIcon
          className="mt-0.5 h-6 w-6 shrink-0 text-amber-700"
          aria-hidden="true"
        />
        <div>
          <h2 className="text-base font-semibold text-gray-950">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-gray-700">{message}</p>
          <button type="button" className={`${secondaryButtonClass} mt-4`} onClick={onAction}>
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function CalendarSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-5xl space-y-8"
      aria-busy="true"
      aria-label="Loading calendar settings"
    >
      <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
      <div className="space-y-3 border-t border-gray-200 pt-8">
        {[0, 1].map((item) => (
          <div key={item} className="h-20 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
      <span className="sr-only">Loading calendar settings</span>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="mt-2 text-sm font-medium text-red-700">
      {message}
    </p>
  ) : null;
}

function clearErrors(
  setErrors: Dispatch<SetStateAction<CalendarValidationErrors>>,
  keys: readonly string[],
) {
  setErrors((current) => {
    if (!keys.some((key) => current[key])) return current;
    const next = { ...current };
    keys.forEach((key) => delete next[key]);
    return next;
  });
}

function clearErrorPrefix(
  setErrors: Dispatch<SetStateAction<CalendarValidationErrors>>,
  prefix: string,
) {
  setErrors((current) => {
    const keys = Object.keys(current).filter(
      (key) => key === prefix || key.startsWith(`${prefix}.`),
    );
    if (keys.length === 0) return current;
    const next = { ...current };
    keys.forEach((key) => delete next[key]);
    return next;
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiErrorResponse && isRecord(error.data)) {
    const detail = error.data.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Calendar setup is unavailable. Try again.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameProposal(
  left: PmsOperatingCalendarImpactPreviewRequest,
  right: PmsOperatingCalendarImpactPreviewRequest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function focusFirstCalendarError(errors: CalendarValidationErrors): void {
  requestAnimationFrame(() => {
    const selector = errors.periods
      ? 'select[id$="-start-month"], #calendar-add-period'
      : '[aria-invalid="true"], #calendar-confirmation, #calendar-mode-year-round';
    document.querySelector<HTMLElement>(selector)?.focus();
  });
}

function formatDateTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatStayDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value + "T00:00:00.000Z"));
}

function impactStatusLabel(value: string): string {
  switch (value) {
    case "open_to_closed":
      return "Closes";
    case "closed_to_open":
      return "Opens";
    default:
      return "Availability changes";
  }
}

function impactCategoryLabel(value: string): string {
  switch (value) {
    case "accepted_bookings_on_closing_dates":
      return "Accepted bookings fall on dates that will close";
    case "default_minimum_stay_changes":
      return "Default minimum stay changes";
    case "operating_dates_close":
      return "Operating dates close";
    case "operating_dates_open":
      return "Operating dates open";
    case "owner_overrides_on_changed_dates":
      return "Owner overrides exist on changed dates";
    case "room_blocks_on_closing_dates":
      return "Room blocks exist on dates that will close";
    case "starting_availability_decreases":
      return "Starting room availability decreases";
    case "starting_availability_increases":
      return "Starting room availability increases";
    default:
      return "Calendar configuration changes";
  }
}

function signedNumber(value: number, number: Intl.NumberFormat): string {
  return value > 0 ? "+" + number.format(value) : number.format(value);
}

function daysInMonth(month: number): number {
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function periodId(): string {
  return `calendar-period-${crypto.randomUUID()}`;
}

const primaryButtonClass =
  "inline-flex min-h-11 items-center whitespace-nowrap rounded-full bg-primary-600 px-5 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-primary-300";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
const iconButtonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-gray-600 outline-none hover:bg-gray-100 hover:text-gray-950 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2";
function inputClass(error: boolean) {
  return `min-h-11 w-full rounded-xl border bg-white px-3 py-2 text-sm text-gray-950 outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-gray-100 ${error ? "border-red-500" : "border-gray-300"}`;
}
