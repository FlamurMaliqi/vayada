"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
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
  const [draft, setDraft] = useState<RoomSetupDraft>({
    name: "",
    totalRooms: 1,
    maxOccupancy: 2,
    nightlyRate: 150,
    currency: "EUR",
    minimumStay: 1,
  });
  const [roomState, setRoomState] = useState<RoomSetupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [savedPendingRefresh, setSavedPendingRefresh] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setRoomState(null);
    void hotelOperationsSetupApi
      .getRoomSetupState(propertyId, controller.signal)
      .then(setRoomState)
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
    try {
      if (savedPendingRefresh) {
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

      setSavedPendingRefresh(true);
      await refreshProgress(true);
    } catch (cause) {
      setError(
        hotelOperationsErrorMessage(cause, "Rooms, rates, and availability could not be saved."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const refreshProgress = async (roomWasSaved: boolean) => {
    try {
      await onCompleted();
    } catch {
      setError(
        roomWasSaved
          ? "Rooms and rates were saved, but setup progress could not be refreshed. Try refreshing again. Vayada will not submit the room setup twice."
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

  if (savedPendingRefresh) {
    return (
      <OperationFormShell
        error={error}
        notice={
          <div className="space-y-1">
            <p className="font-semibold">Rooms and rates were saved.</p>
            <p>
              Setup progress still needs to refresh. Retrying here will not submit the room setup
              again.
            </p>
          </div>
        }
        onBack={onBack}
        onSubmit={handleSubmit}
        submitLabel="Refresh setup progress"
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
              the PMS.
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
            Vayada found existing room setup data, so it will not create another room type. Complete
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
      submitLabel="Save rooms and rates"
      submitting={submitting}
    >
      <OperationField className="sm:col-span-2" label="Room type name">
        <input
          autoComplete="off"
          className={operationInputClassName}
          maxLength={120}
          onChange={(event) => update("name", event.target.value)}
          placeholder="Double room"
          required
          value={draft.name}
        />
      </OperationField>
      <OperationField label="Number of rooms">
        <input
          className={operationInputClassName}
          inputMode="numeric"
          min={1}
          onChange={(event) => update("totalRooms", event.target.valueAsNumber)}
          required
          type="number"
          value={draft.totalRooms}
        />
      </OperationField>
      <OperationField label="Guests per room">
        <input
          className={operationInputClassName}
          inputMode="numeric"
          min={1}
          onChange={(event) => update("maxOccupancy", event.target.valueAsNumber)}
          required
          type="number"
          value={draft.maxOccupancy}
        />
      </OperationField>
      <OperationField label="Nightly rate">
        <input
          className={operationInputClassName}
          inputMode="decimal"
          min="0.01"
          onChange={(event) => update("nightlyRate", event.target.valueAsNumber)}
          required
          step="0.01"
          type="number"
          value={draft.nightlyRate}
        />
      </OperationField>
      <OperationField label="Currency">
        <select
          className={operationInputClassName}
          onChange={(event) => update("currency", event.target.value)}
          value={draft.currency}
        >
          <option value="EUR">EUR</option>
          <option value="CHF">CHF</option>
          <option value="GBP">GBP</option>
          <option value="USD">USD</option>
        </select>
      </OperationField>
      <OperationField
        className="sm:col-span-2"
        hint="This creates a year-round rate and initial bookable inventory."
        label="Minimum stay"
      >
        <input
          className={operationInputClassName}
          inputMode="numeric"
          min={1}
          onChange={(event) => update("minimumStay", event.target.valueAsNumber)}
          required
          type="number"
          value={draft.minimumStay}
        />
      </OperationField>
    </OperationFormShell>
  );
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
      minimumStay={draft.minimumStay}
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
      minimumStay={room.minimumStay}
      name={room.name}
      nightlyRate={room.nightlyRate}
      totalRooms={room.totalRooms}
    />
  );
}

function RoomSummary({
  currency,
  maxOccupancy,
  minimumStay,
  name,
  nightlyRate,
  totalRooms,
}: {
  currency: string;
  maxOccupancy: number;
  minimumStay: number | null;
  name: string;
  nightlyRate: string;
  totalRooms: number;
}) {
  const summary = [
    ["Room type", name],
    ["Number of rooms", String(totalRooms)],
    ["Guests per room", String(maxOccupancy)],
    ["Nightly rate", `${currency} ${nightlyRate}`],
    [
      "Minimum stay",
      minimumStay ? `${minimumStay} ${minimumStay === 1 ? "night" : "nights"}` : "Not set",
    ],
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
