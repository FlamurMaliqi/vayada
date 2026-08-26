"use client";

import { SettingsSection, SettingsCard } from "@vayada/settings-ui";

type Props = {
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  loadError: string;
  onToggle: (next: boolean) => void;
  onRetry: () => void;
};

export function CalendarSection({ enabled, loading, saving, loadError, onToggle, onRetry }: Props) {
  return (
    <SettingsSection
      id="calendar"
      title="Calendar"
      description="Control automatic room placement for future reservations."
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
    </SettingsSection>
  );
}
