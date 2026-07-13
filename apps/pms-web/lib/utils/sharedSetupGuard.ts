import {
  resolveSharedHotelSetupGuard,
  type SharedHotelSetupApi,
  type SharedHotelSetupGuardDecision,
} from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { SELECTED_SHARED_PROPERTY_ID_KEY } from "@/lib/utils/pmsPropertySelectionKeys";

type HotelSelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PMS_ACTIVATION_STEPS = new Set(["roomTypes", "rooms", "ratePlans"]);

export function isPmsRoomSetupDecision(decision: SharedHotelSetupGuardDecision): boolean {
  return (
    decision.action === "redirect_to_setup" &&
    decision.setupAction === "complete_product_activation" &&
    decision.product === "pms" &&
    decision.productStatus === "selected_incomplete" &&
    decision.missingSteps.length > 0 &&
    decision.missingSteps.every((step) => PMS_ACTIVATION_STEPS.has(step))
  );
}

export async function resolvePmsSetupGuard(
  returnTo: string,
  api: Pick<SharedHotelSetupApi, "getStatus"> = sharedHotelSetupApi,
  storage: HotelSelectionStorage | null = browserStorage(),
): Promise<SharedHotelSetupGuardDecision> {
  const decision = await resolveSharedHotelSetupGuard(api, {
    entryProduct: "pms",
    returnTo,
    propertyId: readSelectedSharedPropertyId(storage),
    onInvalidPropertyId: () => storage?.removeItem(SELECTED_SHARED_PROPERTY_ID_KEY),
  });
  persistEnteredSharedProperty(decision, storage);
  return decision;
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
