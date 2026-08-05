"use client";

import { useCallback, useMemo, useRef, type ComponentType } from "react";

import {
  AdaptiveHotelSetupController,
  type AdaptiveHotelSetupControllerProps,
  type AdaptiveSetupStepRenderContext,
} from "../AdaptiveHotelSetupController";
import { AdaptiveSetupStepFormDispatcher } from "../AdaptiveSetupStepFormDispatcher";
import {
  RoomAuthoringStep,
  saveRoomAuthoringSessionDraft,
  type RoomAuthoringSessionStore,
} from "./RoomAuthoringStep";

export type AdaptiveRoomAuthoringSetupControllerProps = Omit<
  AdaptiveHotelSetupControllerProps,
  "beforeLeave" | "StepForm"
>;

/**
 * Thin Step 4 composition seam. Route, shell, history, Back, Exit, and conflict
 * recovery remain exclusively owned by AdaptiveHotelSetupController.
 */
export function AdaptiveRoomAuthoringSetupController(
  props: AdaptiveRoomAuthoringSetupControllerProps,
) {
  const roomSession = useRef<RoomAuthoringSessionStore>({});
  const stepBeforeLeave = useRef<{
    stepId: AdaptiveSetupStepRenderContext["step"]["stepId"];
    callback: () => Promise<void>;
  } | null>(null);
  const stepStaleRecovery = useRef<{
    stepId: AdaptiveSetupStepRenderContext["step"]["stepId"];
    callback: () => Promise<void>;
    mode: "refresh" | "reset";
  } | null>(null);
  const registerBeforeLeaveForStep = useCallback(
    (stepId: AdaptiveSetupStepRenderContext["step"]["stepId"], callback: () => Promise<void>) => {
      const registration = { stepId, callback };
      stepBeforeLeave.current = registration;
      return () => {
        if (stepBeforeLeave.current === registration) stepBeforeLeave.current = null;
      };
    },
    [],
  );
  const beforeLeave = useCallback(() => {
    const currentStepId = roomSession.current.currentStepId;
    if (currentStepId === "rooms") {
      return (
        roomSession.current.beforeLeave?.() ??
        saveRoomAuthoringSessionDraft(roomSession.current).then(() => undefined)
      );
    }
    const registration = stepBeforeLeave.current;
    if (registration && registration.stepId === currentStepId) return registration.callback();
    return Promise.resolve();
  }, []);
  const registerStaleRecoveryForStep = useCallback(
    (
      stepId: AdaptiveSetupStepRenderContext["step"]["stepId"],
      callback: () => Promise<void>,
      mode: "refresh" | "reset" = "refresh",
    ) => {
      const registration = { stepId, callback, mode };
      stepStaleRecovery.current = registration;
      return () => {
        if (stepStaleRecovery.current === registration) stepStaleRecovery.current = null;
      };
    },
    [],
  );
  const recoverStaleDraft = useCallback(() => {
    const registration = stepStaleRecovery.current;
    if (registration && registration.stepId === roomSession.current.currentStepId) {
      return registration.callback();
    }
    return Promise.reject(new Error("This step does not have a saved draft to reset."));
  }, []);
  const staleRecoveryMode = useCallback(() => {
    const registration = stepStaleRecovery.current;
    return registration && registration.stepId === roomSession.current.currentStepId
      ? registration.mode
      : null;
  }, []);
  const StepForm = useMemo<ComponentType<AdaptiveSetupStepRenderContext>>(() => {
    function RoomAwareStepForm(context: AdaptiveSetupStepRenderContext) {
      roomSession.current.currentStepId = context.step.stepId;
      return context.step.stepId === "rooms" ? (
        <RoomAuthoringStep {...context} sessionStore={roomSession.current} />
      ) : (
        <AdaptiveSetupStepFormDispatcher
          {...context}
          propertyId={props.propertyId}
          registerBeforeLeave={(callback) =>
            registerBeforeLeaveForStep(context.step.stepId, callback)
          }
          registerStaleRecovery={(callback, mode) =>
            registerStaleRecoveryForStep(context.step.stepId, callback, mode)
          }
        />
      );
    }
    return RoomAwareStepForm;
  }, [props.propertyId, registerBeforeLeaveForStep, registerStaleRecoveryForStep]);

  return (
    <AdaptiveHotelSetupController
      {...props}
      beforeLeave={beforeLeave}
      recoverStaleDraft={recoverStaleDraft}
      staleRecoveryMode={staleRecoveryMode}
      StepForm={StepForm}
    />
  );
}
