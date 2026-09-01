"use client";

import { SettingsCard } from "@vayada/settings-ui";
import { ToggleSwitch } from "@/components/ui";
import type { SameDayBookingSettings } from "@/services/settings";

const HALF_HOUR_TIMES = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2)
    .toString()
    .padStart(2, "0");
  return `${hour}:${index % 2 === 0 ? "00" : "30"}`;
});

export function SameDayBookingCard({
  settings,
  loading,
  saving,
  loadError,
  onSave,
  onRetry,
}: {
  settings: SameDayBookingSettings | null;
  loading: boolean;
  saving: boolean;
  loadError: string;
  onSave: (enabled: boolean, cutoffLocalTime: string | null) => void;
  onRetry: () => void;
}) {
  return (
    <SettingsCard>
      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-4 text-sm">
          <span className="text-red-600">{loadError}</span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
          >
            Retry
          </button>
        </div>
      ) : loading || !settings ? (
        <div role="status" className="py-3">
          <p className="text-[13px] font-semibold text-gray-900">Allow same-day bookings</p>
          <p className="text-[13px] text-gray-500">Loading current setting…</p>
        </div>
      ) : (
        <div aria-busy={saving}>
          <ToggleSwitch
            enabled={settings.enabled}
            disabled={saving}
            onChange={() => onSave(!settings.enabled, settings.cutoffLocalTime)}
            label="Allow same-day bookings"
            description={`Control whether guests can arrive today. The cutoff uses the property timezone (${settings.propertyTimeZone}).`}
          />
          <label className="mt-2 block max-w-xs text-[13px] font-semibold text-gray-900">
            Booking cutoff
            <select
              aria-label="Same-day booking cutoff"
              value={settings.cutoffLocalTime ?? ""}
              disabled={!settings.enabled || saving}
              onChange={(event) => onSave(settings.enabled, event.target.value || null)}
              className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-400"
            >
              <option value="">No cutoff</option>
              {HALF_HOUR_TIMES.map((time) => (
                <option key={time} value={time}>
                  {time}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-[12px] text-gray-500">
            At the selected time, today becomes unavailable across direct booking and connected
            channels.
          </p>
          <p className="mt-3 border-t border-gray-100 pt-3 text-[12px] text-gray-500">
            This setting is shared between PMS and Booking Engine.
          </p>
          {saving && (
            <p role="status" className="mt-2 text-[12px] text-gray-500">
              Saving…
            </p>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
