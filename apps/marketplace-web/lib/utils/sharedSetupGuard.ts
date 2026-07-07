import {
  buildSharedHotelSetupRedirectPath,
  canOpenMarketplaceProfileTools,
  resolveSharedHotelSetupGuard,
  type SharedHotelSetupApi,
  type SharedHotelSetupGuardDecision,
} from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";

type HotelSelectionStorage = Pick<Storage, "getItem" | "setItem">;

export const SELECTED_SHARED_PROPERTY_ID_KEY = "selectedSharedPropertyId";
export { canOpenMarketplaceProfileTools };

export function marketplaceSetupRedirectPath(returnTo: string): string {
  return buildSharedHotelSetupRedirectPath({ entryProduct: "marketplace", returnTo });
}

export function isMarketplaceActivationDecision(decision: SharedHotelSetupGuardDecision): boolean {
  return (
    decision.action === "redirect_to_setup" &&
    decision.setupAction === "complete_product_activation" &&
    canOpenMarketplaceProfileTools(decision)
  );
}

export async function resolveMarketplaceSetupGuard(
  returnTo: string,
  api: Pick<SharedHotelSetupApi, "getStatus"> = sharedHotelSetupApi,
  storage: HotelSelectionStorage | null = browserStorage(),
): Promise<SharedHotelSetupGuardDecision> {
  const decision = await resolveSharedHotelSetupGuard(api, {
    entryProduct: "marketplace",
    returnTo,
    propertyId: readSelectedSharedPropertyId(storage),
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
