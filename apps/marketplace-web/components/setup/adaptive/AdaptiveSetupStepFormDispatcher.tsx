"use client";

import type { AdaptiveSetupStepRenderContext } from "./AdaptiveHotelSetupController";
import { BookingDesignStep } from "./booking/BookingDesignStep";
import { MarketplacePreferencesStep } from "./marketplace/MarketplacePreferencesStep";
import { PresentHotelStep } from "./presentation/PresentHotelStep";

export type AdaptiveSetupStepComponentProps = AdaptiveSetupStepRenderContext & {
  propertyId: string;
  registerBeforeLeave: (callback: () => Promise<void>) => () => void;
};

export function AdaptiveSetupStepFormDispatcher(props: AdaptiveSetupStepComponentProps) {
  switch (props.step.stepId) {
    case "present_hotel":
      return <PresentHotelStep {...props} />;
    case "marketplace_preferences":
      return <MarketplacePreferencesStep {...props} />;
    case "booking_design":
      return <BookingDesignStep {...props} />;
    default:
      return null;
  }
}
