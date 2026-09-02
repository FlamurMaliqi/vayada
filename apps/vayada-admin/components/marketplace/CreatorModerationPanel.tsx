"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";

import { Button } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Textarea } from "@/components/ui/Textarea";
import type { CreatorModerationCapabilities, CreatorProfileDetail } from "@/lib/types";
import {
  createCreatorModerationIdempotencyKey,
  creatorModerationFailure,
  creatorModerationReasonError,
  getCreatorModerationActions,
  moderateCreatorProfile,
  type CreatorModerationAction,
} from "@/services/api/creatorModeration";

type CreatorProfileStatus = CreatorProfileDetail["profileStatus"];

type Props = {
  creatorName: string;
  profile: CreatorProfileDetail;
  moderation: CreatorModerationCapabilities;
  onModerated: (status?: CreatorProfileStatus) => Promise<void>;
};

const STATUS_PRESENTATION: Record<
  CreatorProfileStatus,
  {
    label: string;
    description: string;
    variant: "success" | "warning" | "danger" | "info" | "neutral";
  }
> = {
  pending: {
    label: "Pending review",
    description: "This profile is waiting for an operator decision.",
    variant: "warning",
  },
  active: {
    label: "Active",
    description: "This profile can appear in marketplace discovery.",
    variant: "success",
  },
  rejected: {
    label: "Rejected",
    description: "This profile is not eligible for marketplace discovery.",
    variant: "danger",
  },
  suspended: {
    label: "Suspended",
    description: "This profile is temporarily removed from discovery.",
    variant: "warning",
  },
  archived: {
    label: "Archived",
    description: "This profile is permanently closed and cannot transition again.",
    variant: "neutral",
  },
};

export function CreatorModerationPanel({ creatorName, profile, moderation, onModerated }: Props) {
  const [currentStatus, setCurrentStatus] = useState(profile.profileStatus);
  const [allowedTransitions, setAllowedTransitions] = useState(moderation.allowedTransitions);
  const [selectedAction, setSelectedAction] = useState<CreatorModerationAction | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [requestError, setRequestError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setCurrentStatus(profile.profileStatus);
  }, [profile.profileStatus]);

  useEffect(() => {
    setAllowedTransitions(moderation.allowedTransitions);
  }, [moderation.allowedTransitions]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!selectedAction || !dialog) return;
    if (!dialog.open) dialog.showModal();
    reasonRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [selectedAction]);

  useEffect(() => {
    if (!selectedAction && (success || requestError)) feedbackRef.current?.focus();
  }, [requestError, selectedAction, success]);

  const presentation = STATUS_PRESENTATION[currentStatus];
  const actions = getCreatorModerationActions(currentStatus, allowedTransitions);

  function openDialog(action: CreatorModerationAction) {
    triggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedAction(action);
    setReason("");
    setReasonError("");
    setRequestError("");
    setSuccess("");
    setIdempotencyKey(createCreatorModerationIdempotencyKey(profile.id, action.nextStatus));
  }

  function closeDialog() {
    if (submitting) return;
    dialogRef.current?.close();
    setSelectedAction(null);
    setReason("");
    setReasonError("");
    setIdempotencyKey(null);
    triggerRef.current?.focus();
  }

  function trapDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submitModeration() {
    if (!selectedAction || !idempotencyKey || submitting) return;
    const validationError = creatorModerationReasonError(reason);
    if (validationError) {
      setReasonError(validationError);
      reasonRef.current?.focus();
      return;
    }

    setSubmitting(true);
    setReasonError("");
    setRequestError("");
    try {
      const response = await moderateCreatorProfile({
        creatorProfileId: profile.id,
        currentStatus,
        nextStatus: selectedAction.nextStatus,
        reason,
        idempotencyKey,
      });
      setCurrentStatus(response.profileStatus);
      setAllowedTransitions([]);
      setSuccess(`Creator status updated to ${STATUS_PRESENTATION[response.profileStatus].label}.`);
      dialogRef.current?.close();
      setSelectedAction(null);
      setReason("");
      setIdempotencyKey(null);
      await onModerated(response.profileStatus);
    } catch (error) {
      const failure = creatorModerationFailure(error);
      setRequestError(failure.message);
      if (failure.currentStatus) {
        setCurrentStatus(failure.currentStatus);
      }
      if (failure.refreshRequired) {
        setAllowedTransitions([]);
        dialogRef.current?.close();
        setSelectedAction(null);
        setReason("");
        setIdempotencyKey(null);
        await onModerated(failure.currentStatus);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-labelledby="creator-moderation-title"
      className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
    >
      <div className="border-l-4 border-l-indigo-500 px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
              Marketplace lifecycle
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h3 id="creator-moderation-title" className="text-lg font-semibold text-gray-900">
                Creator moderation
              </h3>
              <Badge variant={presentation.variant}>{presentation.label}</Badge>
            </div>
            <p className="mt-1 text-sm text-gray-600">{presentation.description}</p>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
            <span className="font-medium">Profile readiness:</span>{" "}
            {profile.profileComplete ? "Complete" : "Incomplete"}
          </div>
        </div>

        {!selectedAction && (success || requestError) && (
          <div
            ref={feedbackRef}
            tabIndex={-1}
            role={requestError ? "alert" : "status"}
            aria-live="polite"
            className={`mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${
              requestError
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-green-200 bg-green-50 text-green-800"
            }`}
          >
            {requestError ? (
              <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span>{requestError || success}</span>
          </div>
        )}

        {!profile.profileComplete && currentStatus !== "active" && currentStatus !== "archived" && (
          <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Complete the creator profile before activation becomes available.
          </p>
        )}

        <div className="mt-5 border-t border-gray-100 pt-4">
          {!moderation.allowed ? (
            <p className="text-sm text-gray-600">
              You have read-only access to this profile. Creator moderation permission is required
              to make a decision.
            </p>
          ) : actions.length > 0 ? (
            <>
              <p className="text-sm font-medium text-gray-900">Available decisions</p>
              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                {actions.map((action) => (
                  <div key={action.nextStatus} className="rounded-lg border border-gray-200 p-3">
                    <p className="min-h-10 text-sm text-gray-600">{action.description}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant={action.destructive ? "danger" : "primary"}
                      className="mt-3 w-full"
                      onClick={() => openDialog(action)}
                    >
                      {action.label}
                    </Button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-600">
              {currentStatus === "archived"
                ? "Archived is terminal; no further lifecycle decisions are available."
                : "No lifecycle decisions are currently available."}
            </p>
          )}
        </div>
      </div>

      {selectedAction && (
        <dialog
          ref={dialogRef}
          aria-labelledby="creator-moderation-dialog-title"
          aria-describedby="creator-moderation-dialog-description"
          onKeyDown={trapDialogFocus}
          onCancel={(event) => {
            event.preventDefault();
            closeDialog();
          }}
          className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border-0 bg-white p-0 shadow-xl backdrop:bg-gray-950/50"
        >
          <div className="border-b border-gray-200 px-6 py-5">
            <h2
              id="creator-moderation-dialog-title"
              className="text-lg font-semibold text-gray-900"
            >
              {selectedAction.confirmationLabel}
            </h2>
            <p id="creator-moderation-dialog-description" className="mt-1 text-sm text-gray-600">
              {selectedAction.description} This decision applies to {creatorName}.
            </p>
          </div>

          <div className="space-y-4 px-6 py-5">
            <Textarea
              ref={reasonRef}
              id="creator-moderation-reason"
              label="Reason"
              required
              rows={4}
              maxLength={1000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                if (reasonError) setReasonError("");
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                setReasonError("Use a single line without control characters.");
              }}
              error={reasonError || undefined}
              helperText="Use one line. Recorded in the confidential audit log; not shown to the creator."
              disabled={submitting}
            />
            <p className="text-right text-xs text-gray-500">{reason.length}/1,000</p>
            {requestError && (
              <p
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
              >
                {requestError}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
            <Button type="button" variant="outline" onClick={closeDialog} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={selectedAction.destructive ? "danger" : "primary"}
              onClick={submitModeration}
              disabled={submitting}
            >
              {submitting ? "Saving…" : selectedAction.confirmationLabel}
            </Button>
          </div>
        </dialog>
      )}
    </section>
  );
}
