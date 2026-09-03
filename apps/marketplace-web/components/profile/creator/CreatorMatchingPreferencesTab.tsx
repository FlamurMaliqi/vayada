"use client";

import { useMemo, useState } from "react";
import {
  MARKETPLACE_CREATOR_COLLABORATION_GOALS,
  MARKETPLACE_CREATOR_CONTENT_CATEGORIES,
  MARKETPLACE_CREATOR_MATCHING_COMPENSATION_TYPES,
  MARKETPLACE_PREFERENCE_CONTENT_TYPES,
  type MarketplaceCreatorCodePreference,
  type MarketplaceCreatorMatchingPreferences,
  type MarketplaceCreatorMatchingPreferencesWrite,
} from "@vayada/domain-marketplace";
import { ArrowTopRightOnSquareIcon, InformationCircleIcon } from "@heroicons/react/24/outline";

type SelectionMode = "unknown" | "no_preference" | "selected";
type SelectionDraft = { mode: SelectionMode; values: string[] };

export type CreatorMatchingPreferencesDraft = {
  contentCategories: SelectionDraft;
  deliverableTypes: SelectionDraft;
  compensationTypes: SelectionDraft;
  collaborationGoals: SelectionDraft;
  travelMode: SelectionMode;
  flexibilityDaysBefore: string;
  flexibilityDaysAfter: string;
};

type PreferenceErrors = Partial<
  Record<
    keyof Omit<CreatorMatchingPreferencesDraft, "flexibilityDaysBefore" | "flexibilityDaysAfter">,
    string
  >
>;

type Option = { value: string; label: string };

const CONTENT_CATEGORY_LABELS: Record<
  (typeof MARKETPLACE_CREATOR_CONTENT_CATEGORIES)[number],
  string
> = {
  travel: "Travel",
  lifestyle: "Lifestyle",
  food_drink: "Food & drink",
  wellness_fitness: "Wellness & fitness",
  adventure_outdoors: "Adventure & outdoors",
  family: "Family travel",
  luxury: "Luxury",
  fashion_beauty: "Fashion & beauty",
  business_events: "Business & events",
  other: "Other",
};

const DELIVERABLE_LABELS: Record<(typeof MARKETPLACE_PREFERENCE_CONTENT_TYPES)[number], string> = {
  post: "Social post",
  story: "Story",
  short_form_video: "Short-form video",
  long_form_video: "Long-form video",
  photography: "Photography",
  other: "Other",
};

const COMPENSATION_LABELS: Record<
  (typeof MARKETPLACE_CREATOR_MATCHING_COMPENSATION_TYPES)[number],
  string
> = {
  free_stay: "Complimentary stay",
  paid: "Paid collaboration",
  discount: "Discounted stay",
  affiliate: "Affiliate commission",
};

const GOAL_LABELS: Record<(typeof MARKETPLACE_CREATOR_COLLABORATION_GOALS)[number], string> = {
  audience_distribution: "Reach my audience",
  ugc_creation: "Create content for hotels",
  affiliate_work: "Earn through referrals",
  other: "Other",
};

const options = (values: readonly string[], labels: Record<string, string>): Option[] =>
  values.map((value) => ({ value, label: labels[value] ?? humanizeCode(value) }));

const CONTENT_OPTIONS = options(MARKETPLACE_CREATOR_CONTENT_CATEGORIES, CONTENT_CATEGORY_LABELS);
const DELIVERABLE_OPTIONS = options(MARKETPLACE_PREFERENCE_CONTENT_TYPES, DELIVERABLE_LABELS);
const COMPENSATION_OPTIONS = options(
  MARKETPLACE_CREATOR_MATCHING_COMPENSATION_TYPES,
  COMPENSATION_LABELS,
);
const GOAL_OPTIONS = options(MARKETPLACE_CREATOR_COLLABORATION_GOALS, GOAL_LABELS);

export function creatorMatchingPreferencesDraft(
  preferences: MarketplaceCreatorMatchingPreferences | null,
): CreatorMatchingPreferencesDraft {
  return {
    contentCategories: selectionDraft(preferences?.contentCategories ?? null),
    deliverableTypes: selectionDraft(preferences?.deliverableTypes ?? null),
    compensationTypes: selectionDraft(preferences?.compensationTypes ?? null),
    collaborationGoals: selectionDraft(preferences?.collaborationGoals ?? null),
    travelMode:
      preferences?.travel?.mode === "planned_trips"
        ? "selected"
        : (preferences?.travel?.mode ?? "unknown"),
    flexibilityDaysBefore:
      preferences?.travel?.mode === "planned_trips"
        ? String(preferences.travel.flexibilityDaysBefore)
        : "0",
    flexibilityDaysAfter:
      preferences?.travel?.mode === "planned_trips"
        ? String(preferences.travel.flexibilityDaysAfter)
        : "0",
  };
}

export function creatorMatchingPreferencesWrite(draft: CreatorMatchingPreferencesDraft): {
  preferences: MarketplaceCreatorMatchingPreferencesWrite | null;
  errors: PreferenceErrors;
} {
  const errors: PreferenceErrors = {};
  const contentCategories = selectionWrite(
    draft.contentCategories,
    "Choose at least one content category.",
    (message) => (errors.contentCategories = message),
  );
  const deliverableTypes = selectionWrite(
    draft.deliverableTypes,
    "Choose at least one deliverable type.",
    (message) => (errors.deliverableTypes = message),
  );
  const compensationTypes = closedSelectionWrite(
    draft.compensationTypes,
    MARKETPLACE_CREATOR_MATCHING_COMPENSATION_TYPES,
    "Choose at least one compensation type.",
    (message) => (errors.compensationTypes = message),
  );
  const collaborationGoals = closedSelectionWrite(
    draft.collaborationGoals,
    MARKETPLACE_CREATOR_COLLABORATION_GOALS,
    "Choose at least one collaboration goal.",
    (message) => (errors.collaborationGoals = message),
  );

  let travel: MarketplaceCreatorMatchingPreferencesWrite["travel"] = null;
  if (draft.travelMode === "no_preference") travel = { mode: "no_preference" };
  if (draft.travelMode === "selected") {
    const before = boundedInteger(draft.flexibilityDaysBefore);
    const after = boundedInteger(draft.flexibilityDaysAfter);
    if (before === null || after === null) {
      errors.travelMode = "Enter whole numbers from 0 to 365 days.";
    } else {
      travel = {
        mode: "planned_trips",
        flexibilityDaysBefore: before,
        flexibilityDaysAfter: after,
      };
    }
  }

  if (Object.keys(errors).length > 0) return { preferences: null, errors };
  const preferences = {
    contentCategories,
    deliverableTypes,
    compensationTypes,
    collaborationGoals,
    travel,
  } satisfies MarketplaceCreatorMatchingPreferencesWrite;
  return {
    preferences: Object.values(preferences).every((value) => value === null) ? null : preferences,
    errors,
  };
}

type CreatorMatchingPreferencesTabProps = {
  initialPreferences: MarketplaceCreatorMatchingPreferences | null;
  onSave: (
    preferences: MarketplaceCreatorMatchingPreferencesWrite | null,
  ) => Promise<MarketplaceCreatorMatchingPreferences | null>;
  onManageTrips: () => void;
};

export function CreatorMatchingPreferencesTab({
  initialPreferences,
  onSave,
  onManageTrips,
}: CreatorMatchingPreferencesTabProps) {
  const initialDraft = useMemo(
    () => creatorMatchingPreferencesDraft(initialPreferences),
    [initialPreferences],
  );
  const [draft, setDraft] = useState(initialDraft);
  const [savedDraft, setSavedDraft] = useState(initialDraft);
  const [errors, setErrors] = useState<PreferenceErrors>({});
  const [saveError, setSaveError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = draftFingerprint(draft) !== draftFingerprint(savedDraft);

  const updateDraft = (next: CreatorMatchingPreferencesDraft) => {
    setDraft(next);
    setErrors({});
    setSaveError(false);
    setSaved(false);
  };

  const save = async () => {
    const result = creatorMatchingPreferencesWrite(draft);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;

    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      const updated = await onSave(result.preferences);
      const next = creatorMatchingPreferencesDraft(updated);
      setDraft(next);
      setSavedDraft(next);
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl" aria-busy={saving}>
      <header className="border-b border-gray-200 pb-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
          Optional preferences
        </p>
        <h2 className="mt-1 text-xl font-semibold text-gray-950">Better matches, on your terms</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
          Tell us what feels relevant. Your answers help prioritize compatible opportunities and
          avoid required terms you have ruled out. You can skip any question or choose no
          preference.
        </p>
      </header>

      <div className="mt-5 flex gap-3 rounded-lg border border-primary-100 bg-primary-50 px-4 py-3 text-sm text-primary-950">
        <InformationCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary-600" />
        <p>
          <span className="font-semibold">How matching uses this:</span> rules first check required
          terms, then rank suitable offers using your preferences. We never show an unexplained
          match percentage.
        </p>
      </div>

      <div className="divide-y divide-gray-200">
        <SelectionField
          id="content-categories"
          title="What do you create content about?"
          description="Choose the themes that best represent your work."
          draft={draft.contentCategories}
          options={withExistingOptions(CONTENT_OPTIONS, draft.contentCategories.values)}
          error={errors.contentCategories}
          disabled={saving}
          onChange={(contentCategories) => updateDraft({ ...draft, contentCategories })}
        />
        <SelectionField
          id="deliverable-types"
          title="What would you like to create?"
          description="Select the formats you are comfortable offering to hotels."
          draft={draft.deliverableTypes}
          options={withExistingOptions(DELIVERABLE_OPTIONS, draft.deliverableTypes.values)}
          error={errors.deliverableTypes}
          disabled={saving}
          onChange={(deliverableTypes) => updateDraft({ ...draft, deliverableTypes })}
        />
        <SelectionField
          id="compensation-types"
          title="Which offers work for you?"
          description="Choose every compensation type you are open to considering."
          draft={draft.compensationTypes}
          options={withExistingOptions(COMPENSATION_OPTIONS, draft.compensationTypes.values)}
          error={errors.compensationTypes}
          disabled={saving}
          onChange={(compensationTypes) => updateDraft({ ...draft, compensationTypes })}
        />
        <SelectionField
          id="collaboration-goals"
          title="What do you want from collaborations?"
          description="This helps hotels understand the kind of partnership you are looking for."
          draft={draft.collaborationGoals}
          options={withExistingOptions(GOAL_OPTIONS, draft.collaborationGoals.values)}
          error={errors.collaborationGoals}
          disabled={saving}
          onChange={(collaborationGoals) => updateDraft({ ...draft, collaborationGoals })}
        />
        <TravelField
          draft={draft}
          error={errors.travelMode}
          disabled={saving}
          manageTripsDisabled={dirty}
          onChange={updateDraft}
          onManageTrips={onManageTrips}
        />
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-6 text-gray-600">
        <p className="font-semibold text-gray-900">Connected platform data</p>
        <p>
          Matching may use your provider-authorized follower count and audience-country aggregates
          only while your connection and consent are active and the latest successful sync is no
          more than 30 days old. Age and gender targeting are not used in the MVP. Missing or stale
          metrics are unavailable, never treated as zero.
        </p>
      </div>

      {saveError && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <span>We could not save your preferences. Your changes are still here.</span>
          <button
            type="button"
            onClick={() => void save()}
            className="font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            Try again
          </button>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-5">
        <p aria-live="polite" className="text-sm text-gray-600">
          {saved
            ? "Preferences saved."
            : dirty
              ? "You have unsaved changes."
              : "Everything is up to date."}
        </p>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </div>
  );
}

function SelectionField({
  id,
  title,
  description,
  draft,
  options,
  error,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  draft: SelectionDraft;
  options: Option[];
  error?: string;
  disabled: boolean;
  onChange: (value: SelectionDraft) => void;
}) {
  return (
    <fieldset className="py-6" aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}>
      <legend className="text-base font-semibold text-gray-950">
        {title} <span className="text-sm font-normal text-gray-500">(optional)</span>
      </legend>
      <p id={`${id}-help`} className="mt-1 text-sm text-gray-600">
        {description}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(["unknown", "no_preference", "selected"] as const).map((mode) => (
          <label key={mode} className="cursor-pointer">
            <input
              type="radio"
              name={`${id}-mode`}
              value={mode}
              checked={draft.mode === mode}
              disabled={disabled}
              onChange={() => onChange({ mode, values: mode === "selected" ? draft.values : [] })}
              className="peer sr-only"
            />
            <span className="block rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors peer-checked:border-primary-600 peer-checked:bg-primary-50 peer-checked:text-primary-800 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-primary-300 peer-focus-visible:ring-offset-2">
              {mode === "unknown"
                ? "Not answered"
                : mode === "no_preference"
                  ? "No preference"
                  : "Choose"}
            </span>
          </label>
        ))}
      </div>
      {draft.mode === "selected" && (
        <div className="mt-4 flex flex-wrap gap-2">
          {options.map((option) => {
            const checked = draft.values.includes(option.value);
            return (
              <label key={option.value} className="cursor-pointer">
                <input
                  type="checkbox"
                  value={option.value}
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    onChange({
                      mode: "selected",
                      values: checked
                        ? draft.values.filter((value) => value !== option.value)
                        : [...draft.values, option.value],
                    })
                  }
                  className="peer sr-only"
                />
                <span className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 transition-colors peer-checked:border-primary-600 peer-checked:bg-primary-600 peer-checked:text-white peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-primary-300 peer-focus-visible:ring-offset-2">
                  {option.label}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}

function TravelField({
  draft,
  error,
  disabled,
  manageTripsDisabled,
  onChange,
  onManageTrips,
}: {
  draft: CreatorMatchingPreferencesDraft;
  error?: string;
  disabled: boolean;
  manageTripsDisabled: boolean;
  onChange: (value: CreatorMatchingPreferencesDraft) => void;
  onManageTrips: () => void;
}) {
  return (
    <fieldset className="py-6" aria-describedby={`travel-help${error ? " travel-error" : ""}`}>
      <legend className="text-base font-semibold text-gray-950">
        How flexible are your travel dates?{" "}
        <span className="text-sm font-normal text-gray-500">(optional)</span>
      </legend>
      <p id="travel-help" className="mt-1 text-sm text-gray-600">
        We use destinations and dates from your existing trips. Add flexibility around those dates
        if nearby offers would also work.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(["unknown", "no_preference", "selected"] as const).map((mode) => (
          <label key={mode} className="cursor-pointer">
            <input
              type="radio"
              name="travel-mode"
              value={mode}
              checked={draft.travelMode === mode}
              disabled={disabled}
              onChange={() => onChange({ ...draft, travelMode: mode })}
              className="peer sr-only"
            />
            <span className="block rounded-full border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors peer-checked:border-primary-600 peer-checked:bg-primary-50 peer-checked:text-primary-800 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 peer-focus-visible:ring-2 peer-focus-visible:ring-primary-300 peer-focus-visible:ring-offset-2">
              {mode === "unknown"
                ? "Not answered"
                : mode === "no_preference"
                  ? "No preference"
                  : "Use my trips"}
            </span>
          </label>
        ))}
      </div>
      {draft.travelMode === "selected" && (
        <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-700">
              Manage destinations and dates in your trip calendar.
            </p>
            <button
              type="button"
              onClick={onManageTrips}
              disabled={disabled || manageTripsDisabled}
              title={
                manageTripsDisabled ? "Save your preferences before managing trips" : undefined
              }
              className="inline-flex items-center gap-1 text-sm font-semibold text-primary-700 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              Manage trips <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <FlexibilityInput
              id="flexibility-before"
              label="Days before each trip"
              value={draft.flexibilityDaysBefore}
              error={Boolean(error)}
              disabled={disabled}
              onChange={(flexibilityDaysBefore) => onChange({ ...draft, flexibilityDaysBefore })}
            />
            <FlexibilityInput
              id="flexibility-after"
              label="Days after each trip"
              value={draft.flexibilityDaysAfter}
              error={Boolean(error)}
              disabled={disabled}
              onChange={(flexibilityDaysAfter) => onChange({ ...draft, flexibilityDaysAfter })}
            />
          </div>
          {error && (
            <p id="travel-error" role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

function FlexibilityInput({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="text-sm font-medium text-gray-800">
      {label}
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={365}
        step={1}
        value={value}
        aria-invalid={error}
        disabled={disabled}
        aria-describedby={error ? "travel-error" : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 disabled:cursor-not-allowed disabled:opacity-60"
      />
    </label>
  );
}

function selectionDraft(preference: MarketplaceCreatorCodePreference | null): SelectionDraft {
  if (!preference) return { mode: "unknown", values: [] };
  return preference.mode === "selected"
    ? { mode: "selected", values: [...preference.values] }
    : { mode: "no_preference", values: [] };
}

function selectionWrite(
  draft: SelectionDraft,
  emptyMessage: string,
  setError: (message: string) => void,
): MarketplaceCreatorCodePreference | null {
  if (draft.mode === "unknown") return null;
  if (draft.mode === "no_preference") return { mode: "no_preference" };
  if (draft.values.length === 0) {
    setError(emptyMessage);
    return null;
  }
  return { mode: "selected", values: draft.values };
}

function closedSelectionWrite<T extends string>(
  draft: SelectionDraft,
  allowed: readonly T[],
  emptyMessage: string,
  setError: (message: string) => void,
): MarketplaceCreatorCodePreference<T> | null {
  const preference = selectionWrite(draft, emptyMessage, setError);
  if (!preference || preference.mode === "no_preference") return preference;
  const allowedValues = new Set<string>(allowed);
  const isAllowed = (value: string): value is T => allowedValues.has(value);
  if (!preference.values.every(isAllowed)) {
    setError("Choose only the available options.");
    return null;
  }
  return { mode: "selected", values: preference.values.filter(isAllowed) };
}

function boundedInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 365 ? parsed : null;
}

function withExistingOptions(known: Option[], selected: string[]): Option[] {
  const knownValues = new Set(known.map(({ value }) => value));
  return [
    ...known,
    ...selected
      .filter((value) => !knownValues.has(value))
      .map((value) => ({ value, label: `${humanizeCode(value)} (saved)` })),
  ];
}

function humanizeCode(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function draftFingerprint(draft: CreatorMatchingPreferencesDraft): string {
  return JSON.stringify({
    ...draft,
    contentCategories: {
      ...draft.contentCategories,
      values: [...draft.contentCategories.values].sort(),
    },
    deliverableTypes: {
      ...draft.deliverableTypes,
      values: [...draft.deliverableTypes.values].sort(),
    },
    compensationTypes: {
      ...draft.compensationTypes,
      values: [...draft.compensationTypes.values].sort(),
    },
    collaborationGoals: {
      ...draft.collaborationGoals,
      values: [...draft.collaborationGoals.values].sort(),
    },
  });
}
