"use client";
import { formatTimezoneLabel } from "@/lib/timezoneLabel";

import { useCallback, useEffect, useRef, useState } from "react";
import { FormRow, SettingsCard } from "@vayada/settings-ui";
import {
  getPmsCalendarAutoOpen,
  updatePmsCalendarAutoOpen,
  type PmsCalendarAutoOpenRead,
  type PmsCalendarAutoOpenSetting,
} from "@/services/api/pmsPropertyClient";
import { ApiErrorResponse } from "@/services/api/client";
import { useTranslation } from "@/lib/i18n";

const ROLLING_MONTHS = [12, 18, 24] as const;
const inputClass =
  "mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-400";

export function CalendarAutoOpenEditor() {
  const { t, locale } = useTranslation();
  const [read, setRead] = useState<PmsCalendarAutoOpenRead | null>(null);
  const [draft, setDraft] = useState<PmsCalendarAutoOpenSetting | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [success, setSuccess] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setSaveError("");
    setSuccess("");
    try {
      const current = await getPmsCalendarAutoOpen();
      setRead(current);
      setDraft(current.setting);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (saveError) errorRef.current?.focus();
  }, [saveError]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    setSuccess("");
    try {
      const saved = await updatePmsCalendarAutoOpen(draft);
      setRead(saved);
      setDraft(saved.setting);
      if (saved.setupError) {
        setSaveError(
          setupErrorMessage(saved.setupError.code, t) ?? t("settings.autoOpen.savedNotReady"),
        );
        return;
      }
      setSuccess(
        saved.enqueueIntentId
          ? t("settings.autoOpen.savedUpdating")
          : saved.setting.enabled
            ? t("settings.autoOpen.savedNoExtension")
            : t("settings.autoOpen.savedOff"),
      );
    } catch (error) {
      if (
        error instanceof ApiErrorResponse &&
        error.data.code === "calendar_auto_open_revision_conflict"
      ) {
        try {
          const current = await getPmsCalendarAutoOpen();
          setRead(current);
          setDraft(current.setting);
          setSaveError(t("settings.autoOpen.revisionReloaded"));
        } catch {
          setSaveError(t("settings.autoOpen.revisionError"));
        }
      } else if (error instanceof ApiErrorResponse) {
        const setupMessage = setupErrorMessage(error.data.code, t);
        setSaveError(setupMessage ?? t("settings.autoOpen.saveError"));
      } else {
        setSaveError(t("settings.autoOpen.saveError"));
      }
    } finally {
      setSaving(false);
    }
  };

  if (status === "loading") {
    return (
      <SettingsCard>
        <p role="status" className="text-sm text-gray-600">
          {t("settings.autoOpen.loading")}
        </p>
      </SettingsCard>
    );
  }

  if (status === "error" || !read || !draft) {
    return (
      <SettingsCard>
        <div role="alert" className="flex items-center justify-between gap-3 text-sm text-red-700">
          <span>{t("settings.autoOpen.loadError")}</span>
          <button
            type="button"
            onClick={load}
            className="shrink-0 rounded-lg border border-red-300 bg-white px-3 py-1.5 font-medium hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            {t("settings.retry")}
          </button>
        </div>
      </SettingsCard>
    );
  }

  const minimumMonth = read.horizon.propertyLocalDate.slice(0, 7);
  const maximumMonth = monthAfter(read.horizon.propertyLocalDate, 24);
  const fixedMonthInvalid =
    draft.enabled &&
    draft.mode === "fixed" &&
    (!draft.fixedEndMonth ||
      draft.fixedEndMonth < minimumMonth ||
      draft.fixedEndMonth > maximumMonth);
  const changed = configurationKey(draft) !== configurationKey(read.setting);

  return (
    <SettingsCard
      title={t("settings.autoOpen.title")}
      description={t("settings.autoOpen.description")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p id="auto-open-state" className="text-sm text-gray-700">
            {draft.enabled
              ? read.setupError
                ? t("settings.autoOpen.statePaused")
                : t("settings.autoOpen.stateOn")
              : t("settings.autoOpen.stateOff")}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label={t("settings.autoOpen.title")}
          aria-describedby="auto-open-state"
          aria-checked={draft.enabled}
          disabled={saving}
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:opacity-50 ${draft.enabled ? "bg-primary-600" : "bg-gray-300"}`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${draft.enabled ? "translate-x-5" : "translate-x-0.5"}`}
          />
        </button>
      </div>

      <fieldset disabled={!draft.enabled || saving} className="mt-5 space-y-4 disabled:opacity-60">
        <legend className="text-sm font-medium text-gray-900">
          {t("settings.autoOpen.schedule")}
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["rolling", "fixed"] as const).map((mode) => (
            <label
              key={mode}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 p-3 text-sm text-gray-700"
            >
              <input
                type="radio"
                name="calendar-auto-open-mode"
                value={mode}
                checked={draft.mode === mode}
                onChange={() =>
                  setDraft(
                    mode === "rolling"
                      ? { ...draft, mode, rollingMonths: 18, fixedEndMonth: null }
                      : {
                          ...draft,
                          mode,
                          rollingMonths: null,
                          fixedEndMonth: monthAfter(
                            read.horizon.propertyLocalDate,
                            draft.rollingMonths ?? 18,
                          ),
                        },
                  )
                }
                className="mt-0.5 accent-primary-600"
              />
              <span>
                {t(
                  mode === "rolling"
                    ? "settings.autoOpen.rollingWindow"
                    : "settings.autoOpen.fixedEndMonth",
                )}
              </span>
            </label>
          ))}
        </div>

        {draft.mode === "rolling" ? (
          <FormRow label={t("settings.autoOpen.openThrough")} htmlFor="calendar-auto-open-months">
            <select
              id="calendar-auto-open-months"
              value={draft.rollingMonths ?? 18}
              onChange={(event) =>
                setDraft({ ...draft, rollingMonths: Number(event.target.value) as 12 | 18 | 24 })
              }
              className={inputClass}
            >
              {ROLLING_MONTHS.map((months) => (
                <option key={months} value={months}>
                  {t("settings.autoOpen.monthsAhead", { months })}
                </option>
              ))}
            </select>
          </FormRow>
        ) : (
          <FormRow
            label={t("settings.autoOpen.openThroughMonth")}
            htmlFor="calendar-auto-open-fixed-month"
            description={t("settings.autoOpen.chooseRange", {
              from: minimumMonth,
              through: maximumMonth,
            })}
            error={fixedMonthInvalid ? t("settings.autoOpen.invalidMonth") : null}
          >
            <input
              id="calendar-auto-open-fixed-month"
              type="month"
              min={minimumMonth}
              max={maximumMonth}
              value={draft.fixedEndMonth ?? ""}
              onChange={(event) => setDraft({ ...draft, fixedEndMonth: event.target.value })}
              aria-invalid={fixedMonthInvalid}
              className={inputClass}
            />
          </FormRow>
        )}
      </fieldset>

      <div className="mt-5 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
        <span className="font-medium">{t("settings.autoOpen.currentHorizon")}</span>{" "}
        {read.horizon.targetOpenThrough
          ? `${formatDate(read.horizon.targetOpenThrough, locale)} (${formatTimezoneLabel(read.horizon.propertyTimeZone)})`
          : t("settings.autoOpen.notActive")}
      </div>

      {read.setupError && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          {setupErrorMessage(read.setupError.code, t)}
        </p>
      )}

      {read.warnings.map((warning) => (
        <p
          key={`${warning.roomTypeId}:${warning.from}:${warning.through}`}
          role="alert"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          {t("settings.autoOpen.missingRate", {
            roomType: warning.roomTypeId,
            from: formatDate(warning.from, locale),
            through: formatDate(warning.through, locale),
          })}
        </p>
      ))}

      {saveError && (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 outline-none focus:ring-2 focus:ring-primary-500"
        >
          <span>{saveError}</span>
          <button type="button" onClick={load} className="shrink-0 font-medium underline">
            {t("settings.autoOpen.reload")}
          </button>
        </div>
      )}
      {success && (
        <p role="status" className="mt-3 text-sm text-green-700">
          {success}
        </p>
      )}

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={save}
          disabled={saving || fixedMonthInvalid || !changed}
          aria-busy={saving}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("settings.autoOpen.save")}
        </button>
      </div>
    </SettingsCard>
  );
}

function monthAfter(localDate: string, months: number): string {
  const [year, month] = localDate.slice(0, 7).split("-").map(Number);
  const target = year! * 12 + month! - 1 + months;
  return `${Math.floor(target / 12)}-${String((target % 12) + 1).padStart(2, "0")}`;
}

function configurationKey(setting: PmsCalendarAutoOpenSetting): string {
  return JSON.stringify([
    setting.enabled,
    setting.mode,
    setting.rollingMonths,
    setting.fixedEndMonth,
  ]);
}

function formatDate(value: string, locale: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date)
    : value;
}

function setupErrorMessage(code: unknown, t: (key: string) => string): string | null {
  if (code === "operating_calendar_not_configured") return t("settings.autoOpen.setupCalendar");
  if (code === "operating_calendar_room_bindings_stale")
    return t("settings.autoOpen.setupBindingsStale");
  if (code === "physical_room_labels_unverified")
    return t("settings.autoOpen.setupLabelsUnverified");
  return null;
}
