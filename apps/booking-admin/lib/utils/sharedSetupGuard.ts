import {
  isActionableSharedProductActivation,
  resolveSharedHotelSetupGuard,
  type SharedHotelSetupApi,
  type SharedHotelSetupGuardDecision,
} from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";

type HotelSelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const SELECTED_SHARED_PROPERTY_ID_KEY = "selectedSharedPropertyId";

export async function resolveBookingSetupGuard(
  returnTo: string,
  api: Pick<SharedHotelSetupApi, "getStatus"> = sharedHotelSetupApi,
  storage: HotelSelectionStorage | null = browserStorage(),
): Promise<SharedHotelSetupGuardDecision> {
  const decision = await resolveSharedHotelSetupGuard(api, {
    entryProduct: "booking",
    returnTo,
    propertyId: readSelectedSharedPropertyId(storage),
    onInvalidPropertyId: () => storage?.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY),
  });
  const resolvedDecision = isBookingWorkspaceActivationDecision(decision)
    ? {
        action: "enter_product" as const,
        propertyId: decision.propertyId!,
        redirectPath: null,
      }
    : decision;
  persistEnteredSharedProperty(resolvedDecision, storage);
  return resolvedDecision;
}

export function isBookingWorkspaceActivationDecision(
  decision: SharedHotelSetupGuardDecision,
): boolean {
  return (
    decision.action === "redirect_to_setup" &&
    decision.setupAction === "complete_product_activation" &&
    decision.product === "booking" &&
    decision.propertyId !== null &&
    !decision.missingSteps.includes("bookingSettings") &&
    isActionableSharedProductActivation(decision)
  );
}

export function persistEnteredSharedProperty(
  decision: SharedHotelSetupGuardDecision,
  storage: HotelSelectionStorage | null = browserStorage(),
): void {
  if (decision.action === "enter_product") {
    storage?.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, decision.propertyId);
  }
}

export function readSelectedSharedPropertyId(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): string | null {
  const value = storage?.getItem(SELECTED_SHARED_PROPERTY_ID_KEY)?.trim();
  return value || null;
}

function browserStorage(): HotelSelectionStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
