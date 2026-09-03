"use client";

import type { ReactNode } from "react";
import { SettingsSection, SettingsCard } from "@vayada/settings-ui";

type Props = {
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  loadError: string;
  onToggle: (next: boolean) => void;
  onRetry: () => void;
  autoOpenEditor?: ReactNode;
  sameDayEnabled: boolean;
  sameDayCutoffTime: string | null;
  sameDayTimeZone: string;
  sameDayLoading: boolean;
  sameDaySaving: boolean;
  sameDayLoadError: string;
  onSameDayToggle: (next: boolean) => void;
  onSameDayCutoffChange: (next: string | null) => void;
  onSameDayRetry: () => void;
};

const HALF_HOUR_TIMES = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2)
    .toString()
    .padStart(2, "0");
  return `${hour}:${index % 2 === 0 ? "00" : "30"}`;
});

export function CalendarSection({
  enabled,
  loading,
  saving,
  loadError,
  onToggle,
  onRetry,
  autoOpenEditor,
  sameDayEnabled,
  sameDayCutoffTime,
  sameDayTimeZone,
  sameDayLoading,
  sameDaySaving,
  sameDayLoadError,
  onSameDayToggle,
  onSameDayCutoffChange,
  onSameDayRetry,
}: Props) {
  return (
    <SettingsSection
      id="calendar"
      title="Calendar"
      description="Control room placement and when today's arrivals remain bookable."
    >
      <SettingsCard>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900">Optimize room assignments</p>
            <p className="mt-1 text-xs text-gray-500">
              {loadError
                ? "The current setting is unavailable. Retry before making changes."
                : loading
                  ? "Loading the current room-assignment setting…"
                  : enabled
                    ? "On — future bookings may move between rooms of the same type to make space. Checked-in and checked-out guests never move, and every change is logged."
                    : "Off — automatic room moves are disabled. Bookings that do not fit remain unassigned for manual placement."}
            </p>
          </div>
          {loadError ? (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Retry
            </button>
          ) : (
            <button
              type="button"
              role="switch"
              aria-label="Optimize room assignments"
              aria-checked={enabled}
              disabled={loading || saving}
              onClick={() => onToggle(!enabled)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                enabled ? "bg-primary-600" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  enabled ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          )}
        </div>
        {loading && (
          <p role="status" className="mt-3 text-xs text-gray-500">
            Loading calendar settings…
          </p>
        )}
        {saving && (
          <p role="status" className="mt-3 text-xs text-gray-500">
            Saving…
          </p>
        )}
        {loadError && (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {loadError}
          </p>
        )}
      </SettingsCard>

      {autoOpenEditor}

      <SettingsCard>
        {sameDayLoadError ? (
          <div role="alert" className="flex items-center justify-between gap-4 text-sm">
            <span className="text-red-600">{sameDayLoadError}</span>
            <button
              type="button"
              onClick={onSameDayRetry}
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">Allow same-day bookings</p>
                <p className="mt-1 text-xs text-gray-500">
                  Control whether guests can arrive today. The cutoff uses the property timezone
                  {sameDayTimeZone ? ` (${sameDayTimeZone})` : ""}.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="Allow same-day bookings"
                aria-checked={sameDayEnabled}
                disabled={sameDayLoading || sameDaySaving}
                onClick={() => onSameDayToggle(!sameDayEnabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
                  sameDayEnabled ? "bg-primary-600" : "bg-gray-300"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    sameDayEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>

            <label className="mt-5 block max-w-xs text-sm font-medium text-gray-900">
              Booking cutoff
              <select
                aria-label="Same-day booking cutoff"
                value={sameDayCutoffTime ?? ""}
                disabled={!sameDayEnabled || sameDayLoading || sameDaySaving}
                onChange={(event) => onSameDayCutoffChange(event.target.value || null)}
                className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:bg-gray-50 disabled:text-gray-400"
              >
                <option value="">No cutoff</option>
                {HALF_HOUR_TIMES.map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs text-gray-500">
              At the selected time, today becomes unavailable across direct booking and connected
              channels.
            </p>
            <p className="mt-2 text-xs text-gray-500">
              This setting is shared between PMS and Booking Engine.
            </p>
            {sameDaySaving && (
              <p role="status" className="mt-3 text-xs text-gray-500">
                Saving…
              </p>
            )}
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
