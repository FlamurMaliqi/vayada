"use client";

import { useCallback, useEffect, useState } from "react";
import { FormRow, SettingsCard, SettingsSection } from "@vayada/settings-ui";
import {
  OTA_COMMISSION_CHANNELS,
  listOtaCommissionSettings,
  updateOtaCommissionSetting,
  type OtaCommissionSetting,
} from "@/services/finance/otaCommissionSettings";
import {
  canonicalEffectiveFrom,
  displayPercentage,
  otaCommissionFormErrors,
} from "@/lib/settings/otaCommissions";

const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500";
export function OtaCommissionSettingsSection() {
  const [settings, setSettings] = useState<OtaCommissionSetting[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [editing, setEditing] = useState<OtaCommissionSetting | null>(null);
  const [percentageRate, setPercentageRate] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [errors, setErrors] = useState({ percentageRate: "", effectiveFrom: "" });
  const [saveError, setSaveError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setStatus("loading");
    try {
      setSettings(await listOtaCommissionSettings());
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);
  useEffect(() => void load(), [load]);
  const beginEditing = (setting: OtaCommissionSetting) => {
    setEditing(setting);
    setPercentageRate(
      setting.status === "configured" ? displayPercentage(setting.percentageRate) : "",
    );
    setEffectiveFrom("");
    setErrors({ percentageRate: "", effectiveFrom: "" });
    setSaveError("");
    setSuccess("");
  };
  const save = async () => {
    if (!editing) return;
    const validation = otaCommissionFormErrors(percentageRate, effectiveFrom);
    setErrors(validation);
    if (validation.percentageRate || validation.effectiveFrom) return;
    setSaving(true);
    setSaveError("");
    try {
      const persisted = await updateOtaCommissionSetting(editing.channel, {
        percentageRate: percentageRate.trim(),
        effectiveFrom: canonicalEffectiveFrom(effectiveFrom)!,
        expectedRevision: editing.status === "configured" ? editing.revision : 0,
      });
      setSettings((current) =>
        current.map((setting) => (setting.channel === persisted.channel ? persisted : setting)),
      );
      const label = OTA_COMMISSION_CHANNELS.find(([channel]) => channel === persisted.channel)![1];
      setSuccess(
        `${label} saved at ${displayPercentage(persisted.percentageRate)}%, effective ${formatDate(persisted.effectiveFrom)}, revision ${persisted.revision}.`,
      );
      setEditing(null);
    } catch {
      setSaveError("We couldn’t save this setting. Reload and try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection
      id="ota-commissions"
      title="OTA commissions"
      description="Set the commission expected for each booking source. Changes affect future booking economics only; existing financial records are never rewritten."
    >
      <SettingsCard>
        {status === "loading" && (
          <p className="text-sm text-gray-600" role="status">
            Loading persisted OTA commission settings…
          </p>
        )}
        {status === "error" && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            role="alert"
          >
            <span>We couldn’t load the persisted settings. Check your access and retry.</span>
            <button
              type="button"
              onClick={load}
              className="shrink-0 rounded-md border border-red-300 bg-white px-3 py-1.5 font-medium hover:bg-red-100"
            >
              Retry
            </button>
          </div>
        )}
        {status === "ready" && (
          <div className="space-y-4">
            <ul className="divide-y divide-gray-100" aria-label="OTA commission channels">
              {OTA_COMMISSION_CHANNELS.map(([channel, label]) => {
                const setting = settings.find((item) => item.channel === channel)!;
                return (
                  <li
                    key={channel}
                    className="flex items-center justify-between gap-4 py-3 first:pt-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">{label}</p>
                      {setting.status === "configured" ? (
                        <p className="text-xs text-gray-500">
                          {displayPercentage(setting.percentageRate)}% · Effective{" "}
                          {formatDate(setting.effectiveFrom)} · Revision {setting.revision}
                        </p>
                      ) : (
                        <p className="text-xs font-medium text-amber-700">Not configured</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => beginEditing(setting)}
                      disabled={saving}
                      className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      {setting.status === "configured" ? "Change" : "Configure"}
                    </button>
                  </li>
                );
              })}
            </ul>
            {editing && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <h3 className="text-sm font-semibold text-gray-900">
                  {OTA_COMMISSION_CHANNELS.find(([channel]) => channel === editing.channel)![1]}
                </h3>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <FormRow
                    label="Commission percentage"
                    htmlFor="ota-commission-rate"
                    required
                    error={<span id="ota-commission-rate-error">{errors.percentageRate}</span>}
                  >
                    <input
                      id="ota-commission-rate"
                      type="number"
                      value={percentageRate}
                      onChange={(event) => setPercentageRate(event.target.value)}
                      aria-invalid={Boolean(errors.percentageRate)}
                      aria-errormessage="ota-commission-rate-error"
                      className={inputClass}
                    />
                  </FormRow>
                  <FormRow
                    label="Effective time (your device timezone)"
                    htmlFor="ota-commission-effective"
                    required
                    error={<span id="ota-commission-effective-error">{errors.effectiveFrom}</span>}
                  >
                    <input
                      id="ota-commission-effective"
                      type="datetime-local"
                      value={effectiveFrom}
                      onChange={(event) => setEffectiveFrom(event.target.value)}
                      aria-invalid={Boolean(errors.effectiveFrom)}
                      aria-errormessage="ota-commission-effective-error"
                      className={inputClass}
                    />
                  </FormRow>
                </div>
                {saveError && (
                  <p className="mt-3 text-sm text-red-700" role="alert">
                    {saveError}
                  </p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    disabled={saving}
                    className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save commission"}
                  </button>
                </div>
              </div>
            )}
            {success && (
              <p
                className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700"
                role="status"
              >
                {success}
              </p>
            )}
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
const formatDate = (value: string) => new Date(value).toLocaleString();
