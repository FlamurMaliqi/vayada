import { canonicalSetupReturnUrl } from "@vayada/product-onboarding/returnTo";

import { SELECTED_SHARED_PROPERTY_ID_KEY } from "./pmsPropertySelectionKeys";

export type PmsSetupTaskContext = {
  returnUrl: string;
};

const HANDOFF_KEYS = [
  "onboarding",
  "taskId",
  "destinationRouteKey",
  "planRevision",
  "returnUrl",
] as const;

type SetupTaskSearchParams = Pick<URLSearchParams, "forEach" | "get" | "getAll">;

export function parsePmsSetupTaskHandoff(
  params: SetupTaskSearchParams,
  storage: Pick<Storage, "getItem">,
  marketplaceOrigin: string,
): PmsSetupTaskContext | null {
  const allowedKeys = new Set<string>(HANDOFF_KEYS);
  let hasInvalidKey = false;
  params.forEach((_, key) => {
    if (!allowedKeys.has(key) || params.getAll(key).length !== 1) hasInvalidKey = true;
  });
  if (hasInvalidKey || HANDOFF_KEYS.some((key) => params.getAll(key).length !== 1)) return null;

  const taskId = params.get("taskId");
  const destinationRouteKey = params.get("destinationRouteKey");
  const planRevision = params.get("planRevision") ?? "";
  if (
    params.get("onboarding") !== "pms-activation" ||
    taskId !== "rooms_rates_availability" ||
    destinationRouteKey !== "pms.rooms_rates_availability" ||
    !planRevision.trim() ||
    planRevision !== planRevision.trim()
  ) {
    return null;
  }

  const propertyId = storage.getItem(SELECTED_SHARED_PROPERTY_ID_KEY)?.trim() ?? "";
  if (!propertyId) return null;

  const returnUrl = canonicalSetupReturnUrl(
    params.get("returnUrl") ?? "",
    propertyId,
    marketplaceOrigin,
  );
  if (!returnUrl) return null;

  return { returnUrl };
}

export function hasPmsSetupTaskContext(params: SetupTaskSearchParams): boolean {
  return HANDOFF_KEYS.some((key) => params.getAll(key).length > 0);
}
