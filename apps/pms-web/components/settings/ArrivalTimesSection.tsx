"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  BookingGuestPolicyChoices,
  BookingGuestPolicyComposition,
  BookingGuestPolicySetupAggregate,
} from "@vayada/domain-booking";
import { SettingsCard } from "@vayada/settings-ui";
import { arrivalTimesService } from "@/services/settings/arrivalTimes";
import { humanizeApiError } from "./constants";

const fields = [
  ["checkInTime", "Guests can check in from", true],
  ["checkInUntil", "Check-in until (optional)", false],
  ["checkOutFrom", "Check-out from (optional)", false],
  ["checkOutTime", "Guests must check out by", true],
] as const;

type ArrivalDraft = Omit<
  BookingGuestPolicyChoices,
  "defaultGuestLanguage" | "childrenEnabled" | "checkInTime" | "checkOutTime"
> & {
  defaultGuestLanguage: BookingGuestPolicyChoices["defaultGuestLanguage"] | null;
  childrenEnabled: boolean | null;
  checkInTime: string | null;
  checkOutTime: string | null;
};

export function ArrivalTimesSection() {
  const [setup, setSetup] = useState<BookingGuestPolicySetupAggregate | null>(null);
  const [choices, setChoices] = useState<ArrivalDraft | null>(null);
  const [preview, setPreview] = useState<Extract<
    BookingGuestPolicyComposition,
    { outcome: "ready" }
  > | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSetup(null);
    setChoices(null);
    setError("");
    void arrivalTimesService
      .load(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setSetup(value);
        setChoices(value.current?.bundle.choices ?? value.draft);
        setPreview(null);
        setConfirmed(false);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(humanizeApiError(cause, "Arrival times could not be loaded."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!setup || !choices) return;
    setSaving(true);
    setError("");
    try {
      if (!preview) {
        if (
          !choices.defaultGuestLanguage ||
          choices.childrenEnabled === null ||
          !choices.checkInTime ||
          !choices.checkOutTime
        ) {
          setError(
            "Choose a guest language, child policy and both required times before reviewing.",
          );
          return;
        }
        const result = await arrivalTimesService.preview(
          setup.propertyId,
          choices as BookingGuestPolicyChoices,
        );
        if (result.outcome !== "ready") {
          setError(
            "Guest policies are not ready. Review your property timezone, rooms and rates in setup before saving.",
          );
          return;
        }
        setPreview(result);
        setKey(`arrival-times:${crypto.randomUUID()}`);
      } else if (confirmed) {
        await arrivalTimesService.save(setup, preview, key);
        setSaved(true);
        setReload((value) => value + 1);
      }
    } catch (cause) {
      setError(
        humanizeApiError(
          cause,
          "Arrival times could not be saved. Reload if another user changed the policy.",
        ),
      );
    } finally {
      setSaving(false);
    }
  };
  const updateChoices = (patch: Partial<ArrivalDraft>) => {
    setChoices((current) => (current ? { ...current, ...patch } : current));
    setPreview(null);
    setConfirmed(false);
    setSaved(false);
  };

  return (
    <SettingsCard>
      <h3 className="text-sm font-medium text-gray-900">Arrival and departure</h3>
      {loading ? (
        <p className="mt-2 text-sm" role="status">
          Loading arrival times…
        </p>
      ) : (
        <>
          {error && (
            <p className="mt-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="mt-2 text-sm text-green-700" role="status">
              Arrival times saved. Review and publish your booking page to show the updated policy
              to guests.
            </p>
          )}
          {!choices ? (
            <p className="mt-2 text-sm">
              Arrival times are unavailable. Retry loading your property settings.
            </p>
          ) : (
            <form onSubmit={submit} className="mt-3 space-y-4">
              <p className="text-xs text-gray-500">
                Times use your property timezone
                {preview
                  ? ` (${preview.bundle.propertyTimeZone})`
                  : setup?.current
                    ? ` (${setup.current.bundle.propertyTimeZone})`
                    : ""}
                . Leave optional times empty for check-in from a time or check-out by a time.
              </p>
              {!setup?.current && (
                <fieldset disabled={saving} className="space-y-3 text-sm">
                  <legend className="mb-2 font-medium">Confirm your initial guest policy</legend>
                  <p>
                    Existing arrival times are prefilled when available. Choose the remaining guest
                    policies before saving.
                  </p>
                  <label className="block">
                    Default guest language
                    <select
                      required
                      value={choices.defaultGuestLanguage ?? ""}
                      onChange={(event) =>
                        updateChoices({
                          defaultGuestLanguage: event.target
                            .value as BookingGuestPolicyChoices["defaultGuestLanguage"],
                        })
                      }
                      className="ml-2 rounded border p-2"
                    >
                      <option value="">Choose a language</option>
                      {setup?.supportedLanguages.map((language) => (
                        <option key={language} value={language}>
                          {language}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    Are children welcome?
                    <select
                      required
                      value={
                        choices.childrenEnabled === null ? "" : String(choices.childrenEnabled)
                      }
                      onChange={(event) =>
                        updateChoices({ childrenEnabled: event.target.value === "true" })
                      }
                      className="ml-2 rounded border p-2"
                    >
                      <option value="">Choose a child policy</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </label>
                  {choices.childrenEnabled && (
                    <label className="block">
                      Adult age threshold
                      <input
                        type="number"
                        min={1}
                        max={21}
                        required
                        value={choices.adultAgeThreshold ?? ""}
                        onChange={(event) =>
                          updateChoices({
                            adultAgeThreshold: event.target.value
                              ? Number(event.target.value)
                              : null,
                          })
                        }
                        className="ml-2 w-20 rounded border p-2"
                      />
                    </label>
                  )}
                  {(
                    [
                      ["phoneRequired", "Require phone number"],
                      ["arrivalTimeEnabled", "Ask for arrival time"],
                      ["specialRequestsEnabled", "Allow special requests"],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field} className="block">
                      <input
                        type="checkbox"
                        checked={choices[field]}
                        onChange={(event) => updateChoices({ [field]: event.target.checked })}
                        className="mr-2"
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {fields.map(([field, label, required]) => (
                  <label key={field} className="text-sm">
                    {label}
                    <input
                      type="time"
                      required={required}
                      disabled={saving}
                      value={choices[field] ?? ""}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2"
                      onChange={(event) => {
                        const next = { ...choices };
                        if (
                          (field === "checkInUntil" || field === "checkOutFrom") &&
                          !event.target.value
                        )
                          delete next[field];
                        else next[field] = event.target.value;
                        setChoices(next);
                        setPreview(null);
                        setConfirmed(false);
                        setSaved(false);
                      }}
                    />
                  </label>
                ))}
              </div>
              {preview && (
                <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-sm">
                  <p>
                    Check-in: {preview.bundle.choices.checkInTime}
                    {preview.bundle.choices.checkInUntil
                      ? `–${preview.bundle.choices.checkInUntil}`
                      : " onwards"}
                    . Check-out:{" "}
                    {preview.bundle.choices.checkOutFrom
                      ? `${preview.bundle.choices.checkOutFrom}–`
                      : "by "}
                    {preview.bundle.choices.checkOutTime}.
                  </p>
                  {preview.bundle.rates.map((rate) => (
                    <p key={rate.roomTypeId}>
                      Flexible cancellation: {rate.flexible.freeCancellationDeadlineDays} days
                      before arrival at {rate.flexible.cutoff.localTime} (
                      {rate.flexible.cutoff.timeZone}). After that deadline or for a no-show, the
                      full booking amount applies.
                    </p>
                  ))}
                  {preview.bundle.rates
                    .filter((rate) => rate.nonRefundable)
                    .map((rate) => (
                      <p key={`nonref-${rate.roomTypeId}`}>
                        Non-refundable rate: full prepayment, no refund, and the full booking amount
                        for a no-show.
                      </p>
                    ))}
                  {preview.bundle.rates
                    .filter((rate) => rate.additionalGuest)
                    .map((rate) => (
                      <p key={`additional-${rate.roomTypeId}`}>
                        Additional guests: {rate.additionalGuest!.amountDecimal}{" "}
                        {rate.additionalGuest!.currency}, with{" "}
                        {rate.additionalGuest!.includedGuestsPerRoom} guests included per room (
                        {rate.additionalGuest!.countedGuestTypes.join(" and ")}).
                      </p>
                    ))}
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      disabled={saving}
                    />
                    I have reviewed how these policies and guest charges will appear to guests.
                  </label>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  disabled={saving || Boolean(preview && !confirmed)}
                  className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? "Saving…" : preview ? "Save arrival times" : "Review policy"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  className="text-sm underline"
                  onClick={() => setReload((value) => value + 1)}
                >
                  Reload saved values
                </button>
              </div>
            </form>
          )}
          {!choices && (
            <button
              type="button"
              onClick={() => setReload((value) => value + 1)}
              className="mt-2 text-sm underline"
            >
              Retry
            </button>
          )}
        </>
      )}
    </SettingsCard>
  );
}
