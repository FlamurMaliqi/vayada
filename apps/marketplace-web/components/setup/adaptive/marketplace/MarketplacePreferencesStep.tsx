"use client";

import { CheckIcon } from "@heroicons/react/24/outline";
import {
  MARKETPLACE_PREFERENCE_AVAILABILITY_MODES,
  MARKETPLACE_PREFERENCE_COMPENSATION_TYPES,
  MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS,
  MARKETPLACE_PREFERENCE_CONTENT_TYPES,
  type MarketplaceHotelCollaborationPreferencesReadModel,
  type MarketplacePreferenceAvailability,
  type MarketplacePreferenceCompensationType,
  type MarketplacePreferenceContentPlatform,
  type MarketplacePreferenceContentType,
} from "@vayada/domain-marketplace";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import type { AdaptiveSetupStepComponentProps } from "../AdaptiveSetupStepFormDispatcher";
import {
  AdaptiveSaveError,
  AdaptiveStepCard,
  AdaptiveStepSkeleton,
  adaptivePrimaryButtonClass,
} from "../AdaptiveStepPrimitives";
import {
  adaptiveStepDraftRevision,
  adaptiveStepErrorMessage,
  draftRequest,
  exactSourceRevision,
  isAdaptiveRevisionConflict,
  withDraftReceipt,
} from "../adaptiveSetupStepState";
import { adaptiveSetupDraftClient } from "@/services/api/adaptiveSetupDraftClient";
import { marketplacePreferencesClient } from "@/services/api/marketplacePreferencesClient";

type PreferenceForm = {
  compensationTypes: MarketplacePreferenceCompensationType[];
  contentPlatforms: MarketplacePreferenceContentPlatform[];
  contentTypes: MarketplacePreferenceContentType[];
  availabilityMode: MarketplacePreferenceAvailability["mode"] | "";
  selectedMonths: number[];
};
type PreferenceErrors = Partial<
  Record<
    "compensationTypes" | "contentPlatforms" | "contentTypes" | "availability" | "months",
    string
  >
>;

const COMPENSATION_LABELS: Record<MarketplacePreferenceCompensationType, string> = {
  free_stay: "Complimentary stay",
  paid: "Paid collaboration",
  discount: "Discounted stay",
  affiliate: "Affiliate commission",
};
const PLATFORM_LABELS: Record<MarketplacePreferenceContentPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  blog: "Blog",
  x: "X",
  other: "Other",
};
const CONTENT_LABELS: Record<MarketplacePreferenceContentType, string> = {
  post: "Post",
  story: "Story",
  short_form_video: "Short-form video",
  long_form_video: "Long-form video",
  photography: "Photography",
  other: "Other",
};
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const DRAFT_FIELDS = [
  "marketplace.preferences.compensation_types",
  "marketplace.preferences.content_platforms",
  "marketplace.preferences.content_types",
  "marketplace.preferences.availability",
] as const;
type PreferenceField = (typeof DRAFT_FIELDS)[number];

export function MarketplacePreferencesStep(props: AdaptiveSetupStepComponentProps) {
  const {
    propertyId,
    route,
    step,
    registerBeforeLeave,
    refreshRoute,
    saveAndContinue,
    reportRevisionConflict,
  } = props;
  const [form, setForm] = useState<PreferenceForm | null>(null);
  const formRef = useRef<PreferenceForm | null>(null);
  const ownerRef = useRef<MarketplaceHotelCollaborationPreferencesReadModel | null>(null);
  const revisionRef = useRef(adaptiveStepDraftRevision(route, step, "marketplace_preferences"));
  const dirtyRef = useRef(false);
  const dirtyFieldsRef = useRef<Set<PreferenceField>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<PreferenceErrors>({});
  const [reload, setReload] = useState(0);
  const compensationRef = useRef<HTMLInputElement>(null);
  const platformRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLInputElement>(null);
  const availabilityRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const next = adaptiveStepDraftRevision(route, step, "marketplace_preferences");
    if (next.baseRevisions || next.draftRevision > revisionRef.current.draftRevision)
      revisionRef.current = next;
  }, [route, step]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void marketplacePreferencesClient
      .load(propertyId, { signal: controller.signal, cache: "no-store" })
      .then((read) => {
        if (controller.signal.aborted) return;
        const next = hydrate(read, step.draft);
        ownerRef.current = read;
        formRef.current = next;
        setForm(next);
        dirtyFieldsRef.current = new Set(
          step.draft?.stepId === "marketplace_preferences"
            ? (step.draft.dirtyFields as PreferenceField[])
            : [],
        );
        dirtyRef.current = false;
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(adaptiveStepErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // Explicit retry only; a local selection never refetches canonical preferences.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, reload]);

  const update = useCallback((change: Partial<PreferenceForm>, field: PreferenceField) => {
    const current = formRef.current;
    if (!current) return;
    dirtyFieldsRef.current.add(field);
    const next = { ...current, ...change };
    formRef.current = next;
    dirtyRef.current = true;
    setForm(next);
  }, []);

  const persistDraft = useCallback(async () => {
    const current = formRef.current;
    if (!current || !dirtyRef.current) return;
    const receipt = await adaptiveSetupDraftClient.save(
      propertyId,
      draftRequest(revisionRef.current, {
        stepId: "marketplace_preferences",
        payload: {
          "marketplace.preferences.compensation_types": current.compensationTypes,
          "marketplace.preferences.content_platforms": current.contentPlatforms,
          "marketplace.preferences.content_types": current.contentTypes,
          "marketplace.preferences.availability": current.availabilityMode
            ? { mode: current.availabilityMode, selectedMonths: current.selectedMonths }
            : null,
        },
        dirtyFields: Array.from(dirtyFieldsRef.current),
      }),
    );
    revisionRef.current = withDraftReceipt(revisionRef.current, receipt);
    dirtyRef.current = false;
    setSaveError(null);
  }, [propertyId]);

  useEffect(
    () =>
      registerBeforeLeave(async () => {
        try {
          await persistDraft();
          await refreshRoute();
        } catch (error) {
          setSaveError(adaptiveStepErrorMessage(error));
          throw error;
        }
      }),
    [persistDraft, refreshRoute, registerBeforeLeave],
  );

  const submit = async () => {
    const current = formRef.current;
    const owner = ownerRef.current;
    if (!current || !owner) return;
    const nextErrors = validate(current);
    setErrors(nextErrors);
    const first = [
      [nextErrors.compensationTypes, compensationRef],
      [nextErrors.contentPlatforms, platformRef],
      [nextErrors.contentTypes, contentRef],
      [nextErrors.availability, availabilityRef],
      [nextErrors.months, monthRef],
    ].find(([message]) => !!message) as [string, RefObject<HTMLInputElement>] | undefined;
    if (first) {
      first[1].current?.focus();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await persistDraft();
      const source = revisionRef.current.baseRevisions?.["marketplace.collaboration_preferences"];
      const expectedRevision = source ? exactSourceRevision(source, "preferences") : null;
      if (expectedRevision === null || source !== owner.sourceRevision)
        throw new RevisionMismatchError();
      const availability: MarketplacePreferenceAvailability =
        current.availabilityMode === "year_round"
          ? { mode: "year_round", selectedMonths: [] }
          : { mode: "selected_months", selectedMonths: current.selectedMonths };
      const saved = await marketplacePreferencesClient.save(propertyId, {
        expectedRevision,
        compensationTypes: current.compensationTypes,
        contentPlatforms: current.contentPlatforms,
        contentTypes: current.contentTypes,
        availability,
      });
      ownerRef.current = saved;
      await saveAndContinue();
    } catch (error) {
      if (error instanceof RevisionMismatchError || isAdaptiveRevisionConflict(error))
        reportRevisionConflict();
      else setSaveError(adaptiveStepErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <AdaptiveStepSkeleton />;
  if (loadError || !form) {
    return (
      <div className="mx-auto max-w-5xl">
        <AdaptiveSaveError
          message={loadError ?? "Marketplace preferences could not be loaded."}
          onRetry={() => setReload((value) => value + 1)}
        />
      </div>
    );
  }

  return (
    <form
      className="mx-auto max-w-5xl"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      noValidate
    >
      {saveError && <AdaptiveSaveError message={saveError} onRetry={() => void submit()} />}
      <AdaptiveStepCard>
        <PreferenceFieldset
          legend="What could you generally provide? *"
          help="Select all that you may be open to discussing."
          error={errors.compensationTypes}
          errorId="preferences-compensation-error"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {MARKETPLACE_PREFERENCE_COMPENSATION_TYPES.map((value, index) => (
              <CheckboxRow
                key={value}
                inputRef={index === 0 ? compensationRef : undefined}
                label={COMPENSATION_LABELS[value]}
                checked={form.compensationTypes.includes(value)}
                describedBy={
                  errors.compensationTypes ? "preferences-compensation-error" : undefined
                }
                onChange={() => {
                  update(
                    { compensationTypes: toggle(form.compensationTypes, value) },
                    "marketplace.preferences.compensation_types",
                  );
                  setErrors((current) => ({ ...current, compensationTypes: undefined }));
                }}
              />
            ))}
          </div>
        </PreferenceFieldset>

        <PreferenceFieldset
          legend="Which creator platforms interest you? *"
          help="Select the platforms where you would like to build visibility."
          error={errors.contentPlatforms}
          errorId="preferences-platform-error"
        >
          <div className="flex flex-wrap gap-2">
            {MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS.map((value, index) => (
              <PillCheckbox
                key={value}
                inputRef={index === 0 ? platformRef : undefined}
                label={PLATFORM_LABELS[value]}
                checked={form.contentPlatforms.includes(value)}
                describedBy={errors.contentPlatforms ? "preferences-platform-error" : undefined}
                onChange={() => {
                  update(
                    { contentPlatforms: toggle(form.contentPlatforms, value) },
                    "marketplace.preferences.content_platforms",
                  );
                  setErrors((current) => ({ ...current, contentPlatforms: undefined }));
                }}
              />
            ))}
          </div>
        </PreferenceFieldset>

        <PreferenceFieldset
          legend="What kinds of content interest you? *"
          help="Keep this broad. You will agree exact deliverables with each creator."
          error={errors.contentTypes}
          errorId="preferences-content-error"
        >
          <div className="flex flex-wrap gap-2">
            {MARKETPLACE_PREFERENCE_CONTENT_TYPES.map((value, index) => (
              <PillCheckbox
                key={value}
                inputRef={index === 0 ? contentRef : undefined}
                label={CONTENT_LABELS[value]}
                checked={form.contentTypes.includes(value)}
                describedBy={errors.contentTypes ? "preferences-content-error" : undefined}
                onChange={() => {
                  update(
                    { contentTypes: toggle(form.contentTypes, value) },
                    "marketplace.preferences.content_types",
                  );
                  setErrors((current) => ({ ...current, contentTypes: undefined }));
                }}
              />
            ))}
          </div>
        </PreferenceFieldset>

        <PreferenceFieldset
          legend="When are you generally open to collaborations? *"
          help="This is a planning signal, not a confirmed travel window."
          error={errors.availability}
          errorId="preferences-availability-error"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {MARKETPLACE_PREFERENCE_AVAILABILITY_MODES.map((mode, index) => (
              <label
                key={mode}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${form.availabilityMode === mode ? "border-primary-500 bg-primary-50 text-primary-950" : "border-gray-200 text-gray-700"}`}
              >
                <input
                  ref={index === 0 ? availabilityRef : undefined}
                  type="radio"
                  name="availability"
                  value={mode}
                  checked={form.availabilityMode === mode}
                  aria-describedby={
                    errors.availability ? "preferences-availability-error" : undefined
                  }
                  onChange={() => {
                    update(
                      {
                        availabilityMode: mode,
                        selectedMonths: mode === "year_round" ? [] : form.selectedMonths,
                      },
                      "marketplace.preferences.availability",
                    );
                    setErrors((current) => ({ ...current, availability: undefined }));
                  }}
                  className="h-4 w-4 border-gray-300 text-primary-600 focus:ring-primary-600"
                />
                {mode === "year_round" ? "Year-round" : "Selected months"}
              </label>
            ))}
          </div>
          {form.availabilityMode === "selected_months" && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium text-gray-700">Choose at least one month</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {MONTHS.map((label, index) => {
                  const month = index + 1;
                  return (
                    <PillCheckbox
                      key={label}
                      inputRef={index === 0 ? monthRef : undefined}
                      label={label}
                      checked={form.selectedMonths.includes(month)}
                      describedBy={errors.months ? "preferences-months-error" : undefined}
                      onChange={() => {
                        update(
                          {
                            selectedMonths: toggle(form.selectedMonths, month).sort(
                              (a, b) => a - b,
                            ),
                          },
                          "marketplace.preferences.availability",
                        );
                        setErrors((current) => ({ ...current, months: undefined }));
                      }}
                    />
                  );
                })}
              </div>
              {errors.months && (
                <p id="preferences-months-error" className="mt-2 text-sm text-red-700">
                  {errors.months}
                </p>
              )}
            </div>
          )}
        </PreferenceFieldset>
      </AdaptiveStepCard>
      <div className="mt-5 flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className={`${adaptivePrimaryButtonClass} w-full sm:w-auto`}
        >
          {saving ? "Saving…" : "Save and continue"}
        </button>
      </div>
    </form>
  );
}

function PreferenceFieldset({
  legend,
  help,
  error,
  errorId,
  children,
}: {
  legend: string;
  help: string;
  error?: string;
  errorId: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="border-b border-gray-100 py-7 first:pt-0 last:border-0 last:pb-0">
      <legend className="text-sm font-semibold text-gray-900">{legend}</legend>
      <p className="mb-4 mt-1 text-sm text-gray-500">{help}</p>
      {children}
      {error && (
        <p id={errorId} className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}
function CheckboxRow({ inputRef, label, checked, describedBy, onChange }: ChoiceProps) {
  return (
    <label
      className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm ${checked ? "border-primary-500 bg-primary-50 text-primary-950" : "border-gray-200 text-gray-700"}`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        aria-describedby={describedBy}
        onChange={onChange}
        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-600"
      />
      {checked && <CheckIcon className="h-4 w-4 text-primary-700" aria-hidden="true" />}
      <span className="font-medium">{label}</span>
    </label>
  );
}
function PillCheckbox({ inputRef, label, checked, describedBy, onChange }: ChoiceProps) {
  return (
    <label
      className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold outline-none focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 ${checked ? "border-primary-500 bg-primary-50 text-primary-950" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={onChange}
        className="sr-only peer"
      />
      <span
        className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? "border-primary-600 bg-primary-600 text-white" : "border-gray-400"}`}
      >
        {checked && <CheckIcon className="h-3 w-3" aria-hidden="true" />}
      </span>
      {label}
    </label>
  );
}
type ChoiceProps = {
  inputRef?: RefObject<HTMLInputElement>;
  label: string;
  checked: boolean;
  describedBy?: string;
  onChange: () => void;
};
function validate(form: PreferenceForm): PreferenceErrors {
  return {
    ...(!form.compensationTypes.length ? { compensationTypes: "Choose at least one option." } : {}),
    ...(!form.contentPlatforms.length ? { contentPlatforms: "Choose at least one platform." } : {}),
    ...(!form.contentTypes.length ? { contentTypes: "Choose at least one content type." } : {}),
    ...(!form.availabilityMode ? { availability: "Choose when you are generally available." } : {}),
    ...(form.availabilityMode === "selected_months" && !form.selectedMonths.length
      ? { months: "Choose at least one month." }
      : {}),
  };
}
function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function hydrate(
  read: MarketplaceHotelCollaborationPreferencesReadModel,
  routeDraft: AdaptiveSetupStepComponentProps["step"]["draft"],
): PreferenceForm {
  const base = read.preferences;
  const form: PreferenceForm = {
    compensationTypes: base ? [...base.compensationTypes] : [],
    contentPlatforms: base ? [...base.contentPlatforms] : [],
    contentTypes: base ? [...base.contentTypes] : [],
    availabilityMode: base?.availability.mode ?? "",
    selectedMonths: base ? [...base.availability.selectedMonths] : [],
  };
  const draft = routeDraft?.stepId === "marketplace_preferences" ? routeDraft : null;
  if (!draft) return form;
  const dirty = new Set(draft.dirtyFields);
  const payload = draft.payload;
  if (
    dirty.has("marketplace.preferences.compensation_types") &&
    selection(
      payload["marketplace.preferences.compensation_types"],
      MARKETPLACE_PREFERENCE_COMPENSATION_TYPES,
    )
  )
    form.compensationTypes = payload["marketplace.preferences.compensation_types"];
  if (
    dirty.has("marketplace.preferences.content_platforms") &&
    selection(
      payload["marketplace.preferences.content_platforms"],
      MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS,
    )
  )
    form.contentPlatforms = payload["marketplace.preferences.content_platforms"];
  if (
    dirty.has("marketplace.preferences.content_types") &&
    selection(
      payload["marketplace.preferences.content_types"],
      MARKETPLACE_PREFERENCE_CONTENT_TYPES,
    )
  )
    form.contentTypes = payload["marketplace.preferences.content_types"];
  if (
    dirty.has("marketplace.preferences.availability") &&
    availability(payload["marketplace.preferences.availability"])
  ) {
    form.availabilityMode = payload["marketplace.preferences.availability"].mode;
    form.selectedMonths = [...payload["marketplace.preferences.availability"].selectedMonths];
  }
  return form;
}
function selection<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && allowed.includes(item as T))
  );
}
function availability(
  value: unknown,
): value is { mode: MarketplacePreferenceAvailability["mode"]; selectedMonths: number[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    MARKETPLACE_PREFERENCE_AVAILABILITY_MODES.includes(
      item.mode as MarketplacePreferenceAvailability["mode"],
    ) &&
    Array.isArray(item.selectedMonths) &&
    item.selectedMonths.every((month) => Number.isInteger(month) && month >= 1 && month <= 12)
  );
}
class RevisionMismatchError extends Error {}
