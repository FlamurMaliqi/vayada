"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { PropertySetupRouteReadModel } from "@vayada/domain-hotels";

import { ROUTES } from "@/lib/constants";
import { ApiErrorResponse } from "@/services/api/client";
import { createPropertySetupRouteClient } from "@/services/api/propertySetupRouteClient";
import { targetApiClient } from "@/services/api/targetClient";
import { AdaptiveHotelSetupShell } from "./AdaptiveHotelSetupShell";
import {
  ADAPTIVE_SETUP_STEP_COPY,
  resolveAdaptiveSetupActiveStep,
  resolveNextAdaptiveSetupStep,
  resolvePreviousAdaptiveSetupStep,
  resolveSupportedInterfaceLocale,
  type AdaptiveSetupStepId,
  type SupportedInterfaceLocale,
} from "./adaptiveSetupNavigation";

const routeClient = createPropertySetupRouteClient(targetApiClient);
const STALE_DRAFT_CODES = new Set([
  "track_revision_conflict",
  "session_revision_conflict",
  "draft_revision_conflict",
  "base_revision_conflict",
  "setup_session_expired",
  "setup_draft_expired",
  "inactive_setup_step",
]);
const STALE_DRAFT_MESSAGE =
  "This step changed in another tab or session. Refresh it before continuing.";
const SETUP_HISTORY_GUARD = "__vayadaAdaptiveSetupGuard";

type PendingNavigation = {
  navigate: () => void | Promise<void>;
  restore?: () => void;
  beforeLeaveCompleted?: boolean;
};

type BrowserHistoryRestore = {
  guardedUrl: string;
  moveTowardGuard: () => void;
  restored: Promise<void>;
  resolve: () => void;
};

export type AdaptiveSetupStepRenderContext = {
  route: PropertySetupRouteReadModel;
  step: PropertySetupRouteReadModel["steps"][number];
  interfaceLocale: SupportedInterfaceLocale;
  saveAndContinue: () => Promise<void>;
  refreshRoute: () => Promise<void>;
  reportRevisionConflict: (message?: string) => void;
};

export type AdaptiveHotelSetupControllerProps = {
  propertyId: string;
  requestedStepId?: string | null;
  onExit: () => void;
  beforeLeave?: () => void | Promise<void>;
  recoverStaleDraft?: () => void | Promise<void>;
  staleRecoveryMode?: () => "refresh" | "reset" | null;
  StepForm?: ComponentType<AdaptiveSetupStepRenderContext>;
};

export function AdaptiveHotelSetupController({
  propertyId,
  requestedStepId,
  onExit,
  beforeLeave,
  recoverStaleDraft,
  staleRecoveryMode,
  StepForm,
}: AdaptiveHotelSetupControllerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [route, setRoute] = useState<PropertySetupRouteReadModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recoveringStaleDraft, setRecoveringStaleDraft] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeErrorTitle, setRouteErrorTitle] = useState("Setup could not be loaded");
  const [staleDraftMessage, setStaleDraftMessage] = useState<string | null>(null);
  const [navigationPending, setNavigationPending] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const [activeStepId, setActiveStepId] = useState<AdaptiveSetupStepId | null>(null);
  const previousActiveStepId = useRef<AdaptiveSetupStepId | null>(null);
  const retryNavigation = useRef<PendingNavigation | null>(null);
  const navigationPendingRef = useRef(false);
  const requestedHistoryStepRef = useRef<AdaptiveSetupStepId | null>(null);
  const programmaticStepRef = useRef<AdaptiveSetupStepId | null>(null);
  const bypassNextBrowserHistoryRef = useRef(false);
  const guardedSetupUrlRef = useRef<string | null>(null);
  const browserHistoryRestoreRef = useRef<BrowserHistoryRestore | null>(null);
  const interfaceLocale = useMemo(
    () =>
      resolveSupportedInterfaceLocale(
        typeof navigator === "undefined" ? null : (navigator.languages[0] ?? navigator.language),
      ),
    [],
  );

  const loadRoute = useCallback(
    async (
      signal?: AbortSignal,
      mode: "load" | "refresh" = "load",
      propagateError = false,
    ): Promise<PropertySetupRouteReadModel | null> => {
      if (mode === "refresh") {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setRouteError(null);
      setRouteErrorTitle("Setup could not be loaded");
      retryNavigation.current = null;

      try {
        const nextRoute = await routeClient.getRoute(propertyId, {
          signal,
          cache: "no-store",
        });
        setRoute(nextRoute);
        setStaleDraftMessage(null);
        return nextRoute;
      } catch (error) {
        if (isAbortError(error, signal)) return null;
        if (isStaleDraftError(error)) {
          setStaleDraftMessage(STALE_DRAFT_MESSAGE);
        } else {
          setRouteError(routeErrorMessage(error));
        }
        if (propagateError) throw error;
        return null;
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [propertyId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadRoute(controller.signal);
    return () => controller.abort();
  }, [loadRoute, reloadRevision]);

  const requestedActiveStep = route
    ? resolveAdaptiveSetupActiveStep({
        steps: route.steps,
        requestedStepId,
        resumeStepId: route.resumeStepId,
      })
    : null;
  const requestedStepIsActive = route?.steps.some(({ stepId }) => stepId === requestedStepId);
  const activeStep =
    route?.steps.find(({ stepId }) => stepId === activeStepId) ??
    (activeStepId === null ? requestedActiveStep : null);

  const runAfterDraftSave = useCallback(
    async (pendingNavigation: PendingNavigation) => {
      if (navigationPendingRef.current) return;
      navigationPendingRef.current = true;
      setNavigationPending(true);
      setRouteError(null);
      try {
        if (!pendingNavigation.beforeLeaveCompleted) {
          await beforeLeave?.();
          pendingNavigation.beforeLeaveCompleted = true;
        }
        retryNavigation.current = null;
        await pendingNavigation.navigate();
      } catch (error) {
        pendingNavigation.restore?.();
        if (isStaleDraftError(error)) {
          retryNavigation.current = null;
          setStaleDraftMessage(STALE_DRAFT_MESSAGE);
        } else {
          retryNavigation.current = pendingNavigation;
          setRouteErrorTitle(
            pendingNavigation.beforeLeaveCompleted
              ? "Next step could not be loaded"
              : "Step could not be saved",
          );
          setRouteError(routeErrorMessage(error));
        }
      } finally {
        navigationPendingRef.current = false;
        setNavigationPending(false);
      }
    },
    [beforeLeave],
  );

  const navigateToStep = useCallback(
    (stepId: AdaptiveSetupStepId, method: "push" | "replace") => {
      programmaticStepRef.current = stepId;
      setActiveStepId(stepId);
      router[method](setupStepPath(searchParams, stepId), { scroll: false });
    },
    [router, searchParams],
  );

  useEffect(() => {
    if (!route || !requestedActiveStep) return;

    const programmaticStepId = programmaticStepRef.current;
    if (programmaticStepId) {
      if (!route.steps.some(({ stepId }) => stepId === programmaticStepId)) {
        programmaticStepRef.current = null;
      } else {
        if (requestedStepId === programmaticStepId) {
          programmaticStepRef.current = null;
          requestedHistoryStepRef.current = null;
        }
        return;
      }
    }

    if (!activeStepId || !route.steps.some(({ stepId }) => stepId === activeStepId)) {
      if (!requestedStepIsActive) {
        navigateToStep(requestedActiveStep.stepId, "replace");
      } else {
        setActiveStepId(requestedActiveStep.stepId);
      }
      return;
    }

    if (!requestedStepIsActive) {
      requestedHistoryStepRef.current = null;
      programmaticStepRef.current = activeStepId;
      router.replace(setupStepPath(searchParams, activeStepId), { scroll: false });
      return;
    }

    if (requestedStepId === activeStepId) {
      requestedHistoryStepRef.current = null;
      return;
    }

    if (navigationPending || requestedHistoryStepRef.current === requestedActiveStep.stepId) {
      return;
    }
    requestedHistoryStepRef.current = requestedActiveStep.stepId;

    void runAfterDraftSave({
      navigate: () => navigateToStep(requestedActiveStep.stepId, "replace"),
      restore: () => {
        programmaticStepRef.current = activeStepId;
        router.replace(setupStepPath(searchParams, activeStepId), {
          scroll: false,
        });
      },
    });
  }, [
    activeStepId,
    navigateToStep,
    navigationPending,
    requestedActiveStep,
    requestedStepId,
    requestedStepIsActive,
    route,
    router,
    runAfterDraftSave,
    searchParams,
  ]);

  useEffect(() => {
    if (
      !route ||
      !activeStep ||
      !requestedStepIsActive ||
      requestedStepId !== activeStep.stepId ||
      typeof window === "undefined"
    ) {
      return;
    }

    const currentUrl = window.location.href;
    guardedSetupUrlRef.current = currentUrl;
    const state = window.history.state as Record<string, unknown> | null;
    if (state?.[SETUP_HISTORY_GUARD] === currentUrl) return;

    window.history.pushState(
      { ...(state ?? {}), [SETUP_HISTORY_GUARD]: currentUrl },
      "",
      currentUrl,
    );
  }, [activeStep, requestedStepId, requestedStepIsActive, route]);

  useEffect(() => {
    if (!route || typeof window === "undefined") return;

    const acceptBrowserDestination = () => {
      const destination = new URL(window.location.href);
      if (destination.pathname !== ROUTES.SETUP) return;
      const destinationStepId = destination.searchParams.get("step");
      const destinationStep = route.steps.find(({ stepId }) => stepId === destinationStepId);
      if (!destinationStep) return;
      requestedHistoryStepRef.current = destinationStep.stepId;
      setActiveStepId(destinationStep.stepId);
    };

    const handlePopState = (event: PopStateEvent) => {
      const state = event.state as Record<string, unknown> | null;
      const historyRestore = browserHistoryRestoreRef.current;
      if (historyRestore) {
        if (
          window.location.href === historyRestore.guardedUrl &&
          state?.[SETUP_HISTORY_GUARD] === historyRestore.guardedUrl
        ) {
          browserHistoryRestoreRef.current = null;
          guardedSetupUrlRef.current = historyRestore.guardedUrl;
          acceptBrowserDestination();
          historyRestore.resolve();
        } else {
          historyRestore.moveTowardGuard();
        }
        return;
      }

      if (bypassNextBrowserHistoryRef.current) {
        bypassNextBrowserHistoryRef.current = false;
        if (state?.[SETUP_HISTORY_GUARD] === window.location.href) {
          guardedSetupUrlRef.current = window.location.href;
        }
        acceptBrowserDestination();
        return;
      }

      if (state?.[SETUP_HISTORY_GUARD] === window.location.href) {
        guardedSetupUrlRef.current = window.location.href;
        acceptBrowserDestination();
        return;
      }

      const returningFromGuard = guardedSetupUrlRef.current === window.location.href;
      let resolveHistoryRestore: () => void = () => {};
      const restored = new Promise<void>((resolve) => {
        resolveHistoryRestore = resolve;
      });
      const moveTowardGuard = returningFromGuard
        ? () => window.history.forward()
        : () => window.history.back();
      browserHistoryRestoreRef.current = {
        guardedUrl: guardedSetupUrlRef.current ?? window.location.href,
        moveTowardGuard,
        restored,
        resolve: resolveHistoryRestore,
      };
      moveTowardGuard();

      void runAfterDraftSave({
        navigate: async () => {
          await restored;
          bypassNextBrowserHistoryRef.current = true;
          window.history.go(returningFromGuard ? -2 : 2);
        },
      });
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [route, runAfterDraftSave]);

  useEffect(() => {
    if (!activeStep) return;
    const priorStepId = previousActiveStepId.current;
    previousActiveStepId.current = activeStep.stepId;
    if (!priorStepId || priorStepId === activeStep.stepId) return;

    const frame = requestAnimationFrame(() => {
      document.getElementById("adaptive-setup-heading")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeStep]);

  const handleBack = useCallback(() => {
    const previousStep = route
      ? resolvePreviousAdaptiveSetupStep(route.steps, activeStep?.stepId)
      : null;
    void runAfterDraftSave({
      navigate: () => {
        if (previousStep) {
          navigateToStep(previousStep.stepId, "push");
        } else {
          onExit();
        }
      },
    });
  }, [activeStep?.stepId, navigateToStep, onExit, route, runAfterDraftSave]);

  const handleExit = useCallback(() => {
    void runAfterDraftSave({ navigate: onExit });
  }, [onExit, runAfterDraftSave]);

  const refreshRoute = useCallback(async () => {
    await loadRoute(undefined, "refresh");
  }, [loadRoute]);

  const activeStaleRecoveryMode = recoverStaleDraft ? staleRecoveryMode?.() : null;

  const recoverStale = useCallback(async () => {
    if (!activeStaleRecoveryMode || !recoverStaleDraft) {
      await refreshRoute();
      return;
    }
    setRecoveringStaleDraft(true);
    try {
      await recoverStaleDraft();
    } catch (error) {
      setStaleDraftMessage(routeErrorMessage(error));
    } finally {
      setRecoveringStaleDraft(false);
    }
  }, [activeStaleRecoveryMode, recoverStaleDraft, refreshRoute]);

  const reportRevisionConflict = useCallback((message = STALE_DRAFT_MESSAGE) => {
    retryNavigation.current = null;
    setRouteError(null);
    setStaleDraftMessage(message);
  }, []);

  const saveAndContinue = useCallback(async () => {
    if (!activeStep) return;
    await runAfterDraftSave({
      navigate: async () => {
        const refreshedRoute = await loadRoute(undefined, "refresh", true);
        if (!refreshedRoute) return;

        const nextStep = resolveNextAdaptiveSetupStep(refreshedRoute.steps, activeStep.stepId);
        if (!nextStep) {
          onExit();
          return;
        }

        navigateToStep(nextStep.stepId, "push");
      },
    });
  }, [activeStep, loadRoute, navigateToStep, onExit, runAfterDraftSave]);

  const activeCopy = activeStep ? ADAPTIVE_SETUP_STEP_COPY[activeStep.stepId] : null;
  const handleRetry = () => {
    const pendingNavigation = retryNavigation.current;
    if (pendingNavigation) {
      retryNavigation.current = null;
      void runAfterDraftSave(pendingNavigation);
      return;
    }
    setReloadRevision((revision) => revision + 1);
  };

  return (
    <AdaptiveHotelSetupShell
      brandMark={
        <Image
          src="/vayada-logo.png"
          alt="vayada"
          width={36}
          height={32}
          priority
          className="h-8 w-auto"
        />
      }
      currentStep={activeStep?.position ?? 1}
      totalSteps={route?.steps.length ?? 1}
      title={activeCopy?.title ?? "Set up your hotel"}
      subtitle={activeCopy?.subtitle ?? "Loading the steps for your selected products."}
      onBack={handleBack}
      onExit={handleExit}
      backDisabled={navigationPending}
      exitDisabled={navigationPending}
      loading={loading}
      routeError={routeError}
      routeErrorTitle={routeErrorTitle}
      onRetry={handleRetry}
      staleDraftMessage={staleDraftMessage}
      staleDraftActionLabel={activeStaleRecoveryMode === "reset" ? "Reset saved draft" : "Refresh"}
      onRefresh={() => void recoverStale()}
      refreshing={refreshing || recoveringStaleDraft}
    >
      {route && activeStep ? (
        <div
          data-testid="adaptive-setup-content"
          data-step-id={activeStep.stepId}
          aria-label={`${activeCopy?.title ?? "Hotel setup"} form`}
        >
          {StepForm ? (
            <StepForm
              route={route}
              step={activeStep}
              interfaceLocale={interfaceLocale}
              saveAndContinue={saveAndContinue}
              refreshRoute={refreshRoute}
              reportRevisionConflict={reportRevisionConflict}
            />
          ) : null}
        </div>
      ) : null}
    </AdaptiveHotelSetupShell>
  );
}

function setupStepPath(searchParams: { toString(): string }, stepId: AdaptiveSetupStepId): string {
  const next = new URLSearchParams(searchParams.toString());
  next.set("step", stepId);
  return `${ROUTES.SETUP}?${next.toString()}`;
}

function isStaleDraftError(error: unknown): boolean {
  return (
    error instanceof ApiErrorResponse &&
    typeof error.data.code === "string" &&
    STALE_DRAFT_CODES.has(error.data.code)
  );
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function routeErrorMessage(error: unknown): string {
  if (error instanceof ApiErrorResponse) {
    const detail = error.data.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : "We could not load your setup. Try again.";
}
