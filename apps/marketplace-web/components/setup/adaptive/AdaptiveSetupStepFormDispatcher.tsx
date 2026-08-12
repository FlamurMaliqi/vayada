"use client";

import type { AdaptiveSetupStepRenderContext } from "./AdaptiveHotelSetupController";
import { BookingDesignStep } from "./booking/BookingDesignStep";
import { CalendarStep } from "./calendar/CalendarStep";
import { MarketplacePreferencesStep } from "./marketplace/MarketplacePreferencesStep";
import { PresentHotelStep } from "./presentation/PresentHotelStep";
import { PricingStep } from "./pricing/PricingStep";

export type AdaptiveSetupStepComponentProps = AdaptiveSetupStepRenderContext & {
  propertyId: string;
  registerBeforeLeave: (callback: () => Promise<void>) => () => void;
  registerStaleRecovery?: (callback: () => Promise<void>, mode?: "refresh" | "reset") => () => void;
};

export function AdaptiveSetupStepFormDispatcher(props: AdaptiveSetupStepComponentProps) {
  switch (props.step.stepId) {
    case "present_hotel":
      return <PresentHotelStep {...props} />;
    case "marketplace_preferences":
      return <MarketplacePreferencesStep {...props} />;
    case "booking_design":
      return <BookingDesignStep {...props} />;
    case "pricing":
      return <PricingStep {...props} />;
    case "calendar":
      return <CalendarStep {...props} />;
    default:
      return null;
  }
}
