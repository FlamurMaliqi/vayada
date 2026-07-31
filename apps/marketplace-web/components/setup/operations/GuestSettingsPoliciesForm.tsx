"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  type GuestSettingsPolicies,
} from "@/services/api/hotelOperationsSetupClient";

import {
  OperationField,
  OperationFormLoadError,
  OperationFormLoading,
  OperationFormShell,
  operationInputClassName,
} from "./OperationFormShell";

export function GuestSettingsPoliciesForm({
  onBack,
  onBeforeSave,
  onCompleted,
  propertyId,
}: {
  onBack: (() => void) | null;
  onBeforeSave: () => Promise<void>;
  onCompleted: () => void | Promise<void>;
  propertyId: string;
}) {
  const [settings, setSettings] = useState<GuestSettingsPolicies | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [taskSaved, setTaskSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void hotelOperationsSetupApi
      .getGuestSettingsPolicies(propertyId, controller.signal)
      .then(setSettings)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setLoadError(hotelOperationsErrorMessage(cause, "Guest settings could not be loaded."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [propertyId, reloadToken]);

  const update = <Key extends keyof GuestSettingsPolicies>(
    key: Key,
    value: GuestSettingsPolicies[Key],
  ) => {
    setTaskSaved(false);
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) return;
    setSubmitting(true);
    setError("");
    try {
      if (!taskSaved) {
        await onBeforeSave();
        await hotelOperationsSetupApi.updateGuestSettingsPolicies(propertyId, settings);
        setTaskSaved(true);
      }
      try {
        await onCompleted();
      } catch (cause) {
        console.warn("Guest policies saved but setup status could not refresh", cause);
        setError("Your guest policies were saved, but setup could not refresh. Try again.");
      }
    } catch (cause) {
      setError(hotelOperationsErrorMessage(cause, "Guest settings could not be saved."));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <OperationFormLoading />;
  if (loadError || !settings) {
    return (
      <OperationFormLoadError
        message={loadError || "Guest settings could not be loaded."}
        onBack={onBack}
        onRetry={() => setReloadToken((current) => current + 1)}
      />
    );
  }

  return (
    <OperationFormShell
      error={error}
      notice={
        taskSaved ? "Your guest policies are saved. Retry the setup refresh to continue." : null
      }
      onBack={onBack}
      onSubmit={handleSubmit}
      submitLabel={taskSaved ? "Refresh setup progress" : "Save guest policies"}
      submitting={submitting}
      submittingLabel={taskSaved ? "Refreshing..." : "Saving..."}
    >
      <OperationField label="Check-in time">
        <input
          className={operationInputClassName}
          onChange={(event) => update("checkInTime", event.target.value)}
          required
          type="time"
          value={settings.checkInTime}
        />
      </OperationField>
      <OperationField label="Check-out time">
        <input
          className={operationInputClassName}
          onChange={(event) => update("checkOutTime", event.target.value)}
          required
          type="time"
          value={settings.checkOutTime}
        />
      </OperationField>
      <OperationField
        className="sm:col-span-2"
        hint="Guests see this summary before they confirm a booking."
        label="Cancellation policy"
      >
        <textarea
          className={`${operationInputClassName} min-h-28 resize-y`}
          maxLength={1000}
          onChange={(event) => update("cancellationPolicyText", event.target.value)}
          placeholder="Free cancellation until 7 days before arrival."
          required
          value={settings.cancellationPolicyText}
        />
      </OperationField>
    </OperationFormShell>
  );
}
