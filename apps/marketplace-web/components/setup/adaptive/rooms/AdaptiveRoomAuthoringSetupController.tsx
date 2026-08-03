"use client";

import { useCallback, useMemo, useRef, type ComponentType } from "react";

import {
  AdaptiveHotelSetupController,
  type AdaptiveHotelSetupControllerProps,
  type AdaptiveSetupStepRenderContext,
} from "../AdaptiveHotelSetupController";
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
  const beforeLeave = useCallback(() => {
    if (roomSession.current.currentStepId !== "rooms") return Promise.resolve();
    return (
      roomSession.current.beforeLeave?.() ??
      saveRoomAuthoringSessionDraft(roomSession.current).then(() => undefined)
    );
  }, []);
  const StepForm = useMemo<ComponentType<AdaptiveSetupStepRenderContext>>(() => {
    function RoomAwareStepForm(context: AdaptiveSetupStepRenderContext) {
      roomSession.current.currentStepId = context.step.stepId;
      return context.step.stepId === "rooms" ? (
        <RoomAuthoringStep {...context} sessionStore={roomSession.current} />
      ) : null;
    }
    return RoomAwareStepForm;
  }, []);

  return <AdaptiveHotelSetupController {...props} beforeLeave={beforeLeave} StepForm={StepForm} />;
}
