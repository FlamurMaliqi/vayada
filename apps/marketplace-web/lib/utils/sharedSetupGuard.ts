import {
  buildSharedHotelSetupRedirectPath,
  canOpenMarketplaceProfileTools,
  resolveSharedHotelSetupGuardDecision,
  resolveSharedHotelSetupGuard,
  type SharedHotelSetupApi,
  type SharedHotelSetupGuardDecision,
} from "@vayada/product-onboarding";

import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";

type HotelSelectionStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

export const SELECTED_SHARED_PROPERTY_ID_KEY = "selectedSharedPropertyId";
export { canOpenMarketplaceProfileTools };

export function marketplaceSetupRedirectPath(returnTo: string, propertyId?: string | null): string {
  return buildSharedHotelSetupRedirectPath({ entryProduct: "marketplace", returnTo, propertyId });
}

export function marketplaceActivationPath(propertyId: string): string {
  return `/profile/complete?${new URLSearchParams({
    activation: "marketplace",
    propertyId,
  }).toString()}`;
}

export function isMarketplaceActivationDecision(decision: SharedHotelSetupGuardDecision): boolean {
  return (
    decision.action === "redirect_to_setup" &&
    decision.setupAction === "complete_product_activation" &&
    canOpenMarketplaceProfileTools(decision)
  );
}

export function marketplaceGuardRedirectPath(
  decision: SharedHotelSetupGuardDecision,
): string | null {
  if (decision.action !== "redirect_to_setup") return null;
  return isMarketplaceActivationDecision(decision) && decision.propertyId
    ? marketplaceActivationPath(decision.propertyId)
    : decision.redirectPath;
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
    onInvalidPropertyId: () => storage?.removeItem?.(SELECTED_SHARED_PROPERTY_ID_KEY),
  });
  const workspaceDecision = allowPendingMarketplaceWorkspace(decision);
  persistEnteredSharedProperty(workspaceDecision, storage);
  return workspaceDecision;
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
      returnTo,
      propertyId: requestedPropertyId,
    },
    { signal: options.signal },
  );
  return allowPendingMarketplaceWorkspace(
    resolveSharedHotelSetupGuardDecision(status, {
      entryProduct: "marketplace",
      returnTo,
    }),
  );
}

function allowPendingMarketplaceWorkspace(
  decision: SharedHotelSetupGuardDecision,
): SharedHotelSetupGuardDecision {
  if (
    decision.action === "redirect_to_setup" &&
    decision.product === "marketplace" &&
    decision.productStatus === "selected_incomplete" &&
    decision.missingSteps.length === 0 &&
    decision.propertyId
  ) {
    return {
      action: "enter_product",
      propertyId: decision.propertyId,
      redirectPath: null,
    };
  }
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
