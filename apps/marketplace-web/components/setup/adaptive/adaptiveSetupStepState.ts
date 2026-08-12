import {
  parseResetPropertySetupDraftRequest,
  type PropertySetupBaseRevisions,
  type PropertySetupRouteReadModel,
  type PropertySetupStepId,
  type ResetPropertySetupDraftRequest,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";

import { ApiErrorResponse } from "@/services/api/client";

const REVISION_CONFLICT_CODES = new Set([
  "track_revision_conflict",
  "session_revision_conflict",
  "draft_revision_conflict",
  "base_revision_conflict",
  "setup_session_expired",
  "setup_draft_expired",
  "inactive_setup_step",
  "profile_revision_conflict",
  "preferences_revision_conflict",
  "design_revision_conflict",
]);

export class AdaptiveStepManifestUnavailableError extends Error {
  constructor() {
    super("This setup step cannot be saved until its current revision manifest is available.");
    this.name = "AdaptiveStepManifestUnavailableError";
  }
}

export type AdaptiveStepDraftRevision<TStepId extends PropertySetupStepId> = {
  trackRevision: number;
  sessionRevision: number;
  draftRevision: number;
  baseRevisions: PropertySetupBaseRevisions<TStepId> | null;
};

export function adaptiveStepDraftRevision<TStepId extends PropertySetupStepId>(
  route: PropertySetupRouteReadModel,
  step: PropertySetupRouteReadModel["steps"][number],
  stepId: TStepId,
): AdaptiveStepDraftRevision<TStepId> {
  const draft = step.draft?.stepId === stepId ? step.draft : null;
  return {
    trackRevision: route.trackRevision,
    sessionRevision: route.sessionRevision ?? 0,
    draftRevision: draft?.revision ?? 0,
    // Persisted drafts always retain their historical manifest. VAY-1049 adds
    // the truthful current manifest used when no draft exists.
    baseRevisions:
      (draft?.baseRevisions as PropertySetupBaseRevisions<TStepId> | undefined) ??
      (step.currentBaseRevisions as PropertySetupBaseRevisions<TStepId>),
  };
}

export function withDraftReceipt<TStepId extends PropertySetupStepId>(
  current: AdaptiveStepDraftRevision<TStepId>,
  receipt: SavePropertySetupDraftReceipt,
): AdaptiveStepDraftRevision<TStepId> {
  return {
    ...current,
    trackRevision: receipt.trackRevision,
    sessionRevision: receipt.sessionRevision,
    draftRevision: receipt.draftRevision,
  };
}

export function adaptiveStepResetRequest<TStepId extends PropertySetupStepId>(
  route: PropertySetupRouteReadModel,
  step: PropertySetupRouteReadModel["steps"][number],
  stepId: TStepId,
): Extract<ResetPropertySetupDraftRequest, { stepId: TStepId }> | null {
  const draft = step.draft?.stepId === stepId ? step.draft : null;
  if (!route.sessionId || !route.sessionRevision || !draft) return null;
  const parsed = parseResetPropertySetupDraftRequest({
    sessionId: route.sessionId,
    stepId,
    expectedTrackRevision: route.trackRevision,
    expectedSessionRevision: route.sessionRevision,
    expectedDraftRevision: draft.revision,
    expectedBaseRevisions: draft.baseRevisions,
  });
  return parsed.ok
    ? (parsed.value as Extract<ResetPropertySetupDraftRequest, { stepId: TStepId }>)
    : null;
}

export function draftRequest<TStepId extends PropertySetupStepId>(
  revision: AdaptiveStepDraftRevision<TStepId>,
  values: Pick<
    Extract<SavePropertySetupDraftRequest, { stepId: TStepId }>,
    "stepId" | "payload" | "dirtyFields"
  >,
): Extract<SavePropertySetupDraftRequest, { stepId: TStepId }> {
  if (!revision.baseRevisions) throw new AdaptiveStepManifestUnavailableError();
  return {
    ...values,
    expectedBaseRevisions: revision.baseRevisions,
    expectedTrackRevision: revision.trackRevision,
    expectedSessionRevision: revision.sessionRevision,
    expectedDraftRevision: revision.draftRevision,
  } as Extract<SavePropertySetupDraftRequest, { stepId: TStepId }>;
}

export function isAdaptiveRevisionConflict(error: unknown): boolean {
  return (
    error instanceof ApiErrorResponse &&
    typeof error.data.code === "string" &&
    REVISION_CONFLICT_CODES.has(error.data.code)
  );
}

export function adaptiveStepErrorMessage(error: unknown): string {
  if (error instanceof ApiErrorResponse) {
    const detail = error.data.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Your changes could not be saved. Try again.";
}

export function exactSourceRevision(value: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}:(0|[1-9]\\d*)$`).exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision <= 2_147_483_647 ? revision : null;
}
