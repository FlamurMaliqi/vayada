import {
  buildSharedHotelSetupRedirectPath,
  resolveSharedHotelSetupGuardDecision,
  resolveSharedHotelSetupGuard,
  type SharedHotelSetupApi,
  type SharedHotelSetupGuardDecision,
} from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";

type HotelSelectionStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

export const SELECTED_SHARED_PROPERTY_ID_KEY = "selectedSharedPropertyId";

export function marketplaceSetupRedirectPath(returnTo: string, propertyId?: string | null): string {
  return buildSharedHotelSetupRedirectPath({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo,
    propertyId,
  });
}

export function marketplaceGuardRedirectPath(
  decision: SharedHotelSetupGuardDecision,
): string | null {
  return decision.action === "redirect_to_setup" ? decision.redirectPath : null;
}

export async function resolveMarketplaceSetupGuard(
  returnTo: string,
  api: Pick<SharedHotelSetupApi, "getStatus"> = sharedHotelSetupApi,
  storage: HotelSelectionStorage | null = browserStorage(),
): Promise<SharedHotelSetupGuardDecision> {
  const decision = await resolveSharedHotelSetupGuard(api, {
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo,
    propertyId: readSelectedSharedPropertyId(storage),
    onInvalidPropertyId: () => storage?.removeItem?.(SELECTED_SHARED_PROPERTY_ID_KEY),
  });
  persistEnteredSharedProperty(decision, storage);
  return decision;
}

export async function resolveMarketplaceActivationGuard(
  returnTo: string,
  propertyId: string,
  options: {
    api?: Pick<SharedHotelSetupApi, "getStatus">;
    signal?: AbortSignal;
  } = {},
): Promise<SharedHotelSetupGuardDecision> {
  const requestedPropertyId = propertyId.trim();
  if (!requestedPropertyId) throw new Error("Marketplace activation requires a hotel");

  const status = await (options.api ?? sharedHotelSetupApi).getStatus(
    {
      entryProduct: "marketplace",
      propertyId: requestedPropertyId,
    },
    { signal: options.signal },
  );
  return resolveSharedHotelSetupGuardDecision(status, {
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo,
  });
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
