import type { AdaptiveHotelSetupStatus, ProductEntryDecision } from "@vayada/domain-hotels";

import {
  isSafeSharedHotelSetupReturnTo,
  type SharedHotelSetupEntryProduct,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

export type SharedHotelSetupGuardDecision =
  | {
      action: "enter_product";
      propertyId: string;
      destinationRouteKey: string;
      redirectPath: null;
    }
  | {
      action: "redirect_to_setup";
      propertyId: string | null;
      redirectPath: string;
      entryDecision: ProductEntryDecision["decision"] | "not_evaluated";
      reasonCode: string | null;
    };

export function resolveSharedHotelSetupGuardDecision(
  status: AdaptiveHotelSetupStatus,
  input: {
    entryProduct: SharedHotelSetupEntryProduct;
    returnProduct?: SharedHotelSetupEntryProduct;
    returnTo: string;
    setupBaseUrl?: string;
  },
): SharedHotelSetupGuardDecision {
  const entryDecision = status.entryDecision;
  if (
    entryDecision?.requestedProduct === input.entryProduct &&
    entryDecision.decision === "enter" &&
    entryDecision.propertyId &&
    entryDecision.destinationRouteKey
  ) {
    return {
      action: "enter_product",
      propertyId: entryDecision.propertyId,
      destinationRouteKey: entryDecision.destinationRouteKey,
      redirectPath: null,
    };
  }

  const propertyId = entryDecision?.propertyId ?? status.propertySelection.selectedPropertyId;
  return {
    action: "redirect_to_setup",
    propertyId,
    redirectPath: buildSharedHotelSetupRedirectPath({ ...input, propertyId }),
    entryDecision: entryDecision?.decision ?? "not_evaluated",
    reasonCode: entryDecision?.reasonCode ?? null,
  };
}

export async function resolveSharedHotelSetupGuard(
  api: Pick<SharedHotelSetupApi, "getStatus">,
  input: {
    entryProduct: SharedHotelSetupEntryProduct;
    returnProduct?: SharedHotelSetupEntryProduct;
    returnTo: string;
    propertyId?: string | null;
    setupBaseUrl?: string;
    onInvalidPropertyId?: () => void;
    fallbackOnInvalidPropertyId?: boolean;
  },
): Promise<SharedHotelSetupGuardDecision> {
  let status: AdaptiveHotelSetupStatus;
  try {
    status = await api.getStatus({
      entryProduct: input.entryProduct,
      propertyId: input.propertyId,
    });
  } catch (error) {
    if (!input.propertyId || !isMissingPropertyResourceLinkError(error)) throw error;
    input.onInvalidPropertyId?.();
    if (input.fallbackOnInvalidPropertyId === false) throw error;
    status = await api.getStatus({
      entryProduct: input.entryProduct,
      propertyId: null,
    });
  }
  return resolveSharedHotelSetupGuardDecision(status, input);
}

function isMissingPropertyResourceLinkError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; statusCode?: unknown; data?: unknown };
  const status = Number(candidate.status ?? candidate.statusCode);
  const data =
    typeof candidate.data === "object" && candidate.data !== null
      ? (candidate.data as { code?: unknown })
      : null;
  return status === 403 && data?.code === "missing_property_resource_link";
}

export function buildSharedHotelSetupRedirectPath(input: {
  entryProduct: SharedHotelSetupEntryProduct;
  returnProduct?: SharedHotelSetupEntryProduct;
  returnTo: string;
  propertyId?: string | null;
  setupBaseUrl?: string;
  mode?: "add";
}): string {
  const query = new URLSearchParams({ entryProduct: input.entryProduct });
  if (input.returnProduct) query.set("returnProduct", input.returnProduct);
  if (isSafeSharedHotelSetupReturnTo(input.returnTo)) query.set("returnTo", input.returnTo);
  if (input.propertyId?.trim()) query.set("propertyId", input.propertyId.trim());
  if (input.mode === "add") query.set("mode", "add");
  const path = `/setup?${query.toString()}`;
  return input.setupBaseUrl ? new URL(path, input.setupBaseUrl).toString() : path;
}
