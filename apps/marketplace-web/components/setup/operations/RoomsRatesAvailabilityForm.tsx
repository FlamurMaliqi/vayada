"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  hotelOperationsWriteMayHaveCommitted,
  isPropertyCurrencyConflict,
  type ExistingRoomSetup,
  type RoomSetupDraft,
  type RoomSetupState,
} from "@/services/api/hotelOperationsSetupClient";

import {
  OperationField,
  OperationFormLoadError,
  OperationFormLoading,
  OperationFormShell,
  operationInputClassName,
} from "./OperationFormShell";

export function RoomsRatesAvailabilityForm({
  onBack,
  onBeforeSave,
  onCompleted,
  propertyId,
  taskComplete,
}: {
  onBack: (() => void) | null;
  onBeforeSave: () => Promise<void>;
  onCompleted: () => void | Promise<void>;
  propertyId: string;
  taskComplete: boolean;
}) {
  const [draft, setDraft] = useState<RoomSetupDraft>(() => emptyRoomDraft("EUR"));
  const [roomState, setRoomState] = useState<RoomSetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [roomSaved, setRoomSaved] = useState(false);
  const [addingAnother, setAddingAnother] = useState(false);
  const [pendingAdditionalDraft, setPendingAdditionalDraft] = useState<RoomSetupDraft | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setRoomState(null);
    setRoomSaved(false);
    setAddingAnother(false);
    setPendingAdditionalDraft(null);
    void hotelOperationsSetupApi
      .getRoomSetupState(propertyId, controller.signal)
      .then(async (nextRoomState) => {
        setRoomState(nextRoomState);
        if (nextRoomState.status !== "empty") return;

        const launchSettings = await hotelOperationsSetupApi.getPropertyLaunchSettings(
          propertyId,
          controller.signal,
        );
        const currency = launchSettings.defaultCurrency.trim().toUpperCase() || "EUR";
        setDraft(emptyRoomDraft(currency));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setLoadError(
            hotelOperationsErrorMessage(cause, "Existing room setup could not be loaded."),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [propertyId, reloadToken, taskComplete]);

  const update = <Key extends keyof RoomSetupDraft>(key: Key, value: RoomSetupDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    let attemptedAdditionalDraft: RoomSetupDraft | null = null;
    try {
      if (roomSaved) {
        await refreshProgress(true);
        return;
      }
      if (roomState?.status === "complete") {
        await refreshProgress(false);
        return;
      }
      if (roomState?.status === "needs_recovery") {
        const refreshed = await hotelOperationsSetupApi.getRoomSetupState(propertyId);
        setRoomState(refreshed);
        if (refreshed.status === "complete") {
          await refreshProgress(false);
        }
        return;
      }

      if (addingAnother) {
        attemptedAdditionalDraft = pendingAdditionalDraft ?? { ...draft };
        setPendingAdditionalDraft(attemptedAdditionalDraft);
        await hotelOperationsSetupApi.addRoomSetup(propertyId, attemptedAdditionalDraft);
        setPendingAdditionalDraft(null);
        setRoomSaved(true);
        return;
      }

      await onBeforeSave();
      const result = await hotelOperationsSetupApi.saveRoomSetup(propertyId, draft);
      if (result.status === "needs_recovery") {
        setRoomState(result);
        return;
      }
      if (result.status === "complete") {
        await refreshProgress(false);
        return;
      }

      setRoomSaved(true);
    } catch (cause) {
      if (isPropertyCurrencyConflict(cause)) {
        setPendingAdditionalDraft(null);
        try {
          const launchSettings =
            await hotelOperationsSetupApi.getPropertyLaunchSettings(propertyId);
          const currency = launchSettings.defaultCurrency.trim().toUpperCase() || "EUR";
          setDraft((current) => ({ ...current, currency, nightlyRate: Number.NaN }));
          setError(
            `Property currency changed to ${currency}. Review and re-enter the nightly rate.`,
          );
        } catch (reloadCause) {
          setError(
            hotelOperationsErrorMessage(
              reloadCause,
              "Property currency changed, but the latest setting could not be loaded.",
            ),
          );
        }
        return;
      }
      if (attemptedAdditionalDraft && !hotelOperationsWriteMayHaveCommitted(cause)) {
        setPendingAdditionalDraft(null);
      }
      setError(hotelOperationsErrorMessage(cause, "The room type could not be saved."));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddAnother = () => {
    setDraft(emptyRoomDraft(draft.currency));
    setRoomSaved(false);
    setAddingAnother(true);
    setPendingAdditionalDraft(null);
    setError("");
  };

  const refreshProgress = async (roomWasSaved: boolean) => {
    try {
      await onCompleted();
    } catch {
      setError(
        roomWasSaved
          ? "Your room types were saved, but setup progress could not be refreshed. Choose Continue setup again. vayada will not submit them twice."
          : "Setup progress could not be refreshed. Try again.",
      );
    }
  };

  if (loading) return <OperationFormLoading />;
  if (loadError) {
    return (
      <OperationFormLoadError
        message={loadError}
        onBack={onBack}
        onRetry={() => setReloadToken((current) => current + 1)}
      />
    );
  }

  if (roomSaved) {
    return (
      <OperationFormShell
        error={error}
        notice={
          <div className="space-y-1">
            <p className="font-semibold">Room type saved.</p>
            <p>
              You can add another room type now, or continue setup. You can always add more room
              types and configure detailed pricing in Rooms &amp; Rates after setup.
            </p>
          </div>
        }
        onBack={onBack}
        onSubmit={handleSubmit}
        secondaryAction={{ label: "Add another room type", onClick: handleAddAnother }}
        submitLabel="Continue setup"
        submitting={submitting}
      >
        <RoomDraftSummary draft={draft} />
      </OperationFormShell>
    );
  }

  if (roomState?.status === "complete") {
    return (
      <OperationFormShell
        error={error}
        notice={
          <div className="space-y-1">
            <p className="font-semibold">Rooms and rates are already set up.</p>
            <p>
              This step is read-only to prevent duplicate inventory. You can make later changes in
              Rooms &amp; Rates.
            </p>
          </div>
        }
        onBack={onBack}
        onSubmit={handleSubmit}
        submitLabel="Continue"
        submitting={submitting}
      >
        {roomState.room ? <RoomSetupSummary room={roomState.room} /> : null}
      </OperationFormShell>
    );
  }

  if (roomState?.status === "needs_recovery") {
    return (
      <OperationFormShell
        error={error}
        onBack={onBack}
        onSubmit={handleSubmit}
        submitLabel="Check setup again"
        submitting={submitting}
      >
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:col-span-2"
          role="status"
        >
          <p className="font-semibold">This room setup needs attention.</p>
          <p className="mt-1">
            vayada found existing room setup data, so it will not create another room type. Complete
            the missing items in the PMS, then check this step again.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5">
            {roomRecoveryMessages(roomState.reasonCodes, roomState.room?.active === true).map(
              (message) => (
                <li key={message}>{message}</li>
              ),
            )}
          </ul>
        </div>
        {roomState.room ? <RoomSetupSummary room={roomState.room} /> : null}
      </OperationFormShell>
    );
  }

  return (
    <OperationFormShell
      error={error}
      onBack={onBack}
      onSubmit={handleSubmit}
      submitLabel={pendingAdditionalDraft ? "Retry save" : "Save and continue"}
      submitting={submitting}
      submittingLabel={pendingAdditionalDraft ? "Retrying..." : "Saving..."}
    >
      <OperationField className="sm:col-span-2" label="Room type name">
        <input
          autoComplete="off"
          className={operationInputClassName}
          disabled={pendingAdditionalDraft !== null}
          maxLength={120}
          onChange={(event) => update("name", event.target.value)}
          placeholder="e.g. Deluxe Double, Pool Villa, Studio"
          required
          value={draft.name}
        />
      </OperationField>
      <OperationField hint="How many of this room type do you have?" label="Number of rooms/units">
        <input
          className={operationInputClassName}
          disabled={pendingAdditionalDraft !== null}
          inputMode="numeric"
          min={1}
          onChange={(event) => update("totalRooms", event.target.valueAsNumber)}
          required
          type="number"
          value={draft.totalRooms}
        />
      </OperationField>
      <OperationField label="Max guests">
        <input
          className={operationInputClassName}
          disabled={pendingAdditionalDraft !== null}
          inputMode="numeric"
          min={1}
          onChange={(event) => update("maxOccupancy", event.target.valueAsNumber)}
          required
          type="number"
          value={draft.maxOccupancy}
        />
      </OperationField>
      <OperationField label="Nightly rate">
        <div className="flex min-h-11 overflow-hidden rounded-xl border border-gray-300 bg-white focus-within:border-primary-600 focus-within:ring-2 focus-within:ring-primary-100">
          <input
            className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-gray-950 outline-none"
            disabled={pendingAdditionalDraft !== null}
            inputMode="decimal"
            min="0.01"
            onChange={(event) => update("nightlyRate", event.target.valueAsNumber)}
            required
            step="0.01"
            type="number"
            value={Number.isNaN(draft.nightlyRate) ? "" : draft.nightlyRate}
          />
          <span
            className="flex items-center border-l border-gray-200 bg-gray-50 px-3 text-sm font-semibold text-gray-700"
            data-testid="room-rate-currency"
          >
            {draft.currency}
          </span>
        </div>
      </OperationField>
    </OperationFormShell>
  );
}

function emptyRoomDraft(currency: string): RoomSetupDraft {
  return {
    name: "",
    totalRooms: 1,
    maxOccupancy: 2,
    nightlyRate: 150,
    currency,
  };
}

function roomRecoveryMessages(reasonCodes: string[], hasActiveRoom: boolean): string[] {
  const messages = reasonCodes.flatMap((reasonCode) => {
    switch (reasonCode) {
      case "missing_non_retired_room":
        return ["Add at least one active physical room."];
      case "missing_active_rate_plan":
        return ["Activate a rate plan for this room type."];
      case "missing_future_inventory":
        return ["Add future availability for this room type."];
      case "missing_active_room_type":
        return hasActiveRoom ? [] : ["Make the existing room type active."];
      default:
        return [];
    }
  });
  return messages.length > 0
    ? messages
    : ["Finish the remaining room, rate, and availability requirements."];
}

function RoomDraftSummary({ draft }: { draft: RoomSetupDraft }) {
  return (
    <RoomSummary
      currency={draft.currency}
      maxOccupancy={draft.maxOccupancy}
      name={draft.name}
      nightlyRate={draft.nightlyRate.toFixed(2)}
      totalRooms={draft.totalRooms}
    />
  );
}

function RoomSetupSummary({ room }: { room: ExistingRoomSetup }) {
  return (
    <RoomSummary
      currency={room.currency}
      maxOccupancy={room.maxOccupancy}
      name={room.name}
      nightlyRate={room.nightlyRate}
      totalRooms={room.totalRooms}
    />
  );
}

function RoomSummary({
  currency,
  maxOccupancy,
  name,
  nightlyRate,
  totalRooms,
}: {
  currency: string;
  maxOccupancy: number;
  name: string;
  nightlyRate: string;
  totalRooms: number;
}) {
  const summary = [
    ["Room type", name],
    ["Number of rooms", String(totalRooms)],
    ["Max guests", String(maxOccupancy)],
    ["Nightly rate", `${currency} ${nightlyRate}`],
  ];

  return (
    <dl className="grid grid-cols-1 gap-4 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:col-span-2 sm:grid-cols-2">
      {summary.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-medium text-gray-600">{label}</dt>
          <dd className="mt-1 text-sm font-semibold text-gray-950">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
