import {
  isSafeSharedHotelSetupReturnTo,
  type SharedHotelSetupEntryProduct,
  type SharedHotelSetupNextAction,
  type SharedHotelSetupProduct,
  type SharedHotelSetupStatus,
  type SharedProductActivation,
} from "./sharedFirstRunSetupFlow";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

export type SharedHotelSetupGuardDecision =
  | {
      action: "enter_product";
      propertyId: string;
      redirectPath: null;
    }
  | {
      action: "redirect_to_setup";
      propertyId: string | null;
      redirectPath: string;
      setupAction: SharedHotelSetupNextAction["action"];
      product: SharedHotelSetupProduct | null;
      productStatus: SharedProductActivation<SharedHotelSetupProduct>["status"] | null;
      missingSteps: string[];
    };

export function resolveSharedHotelSetupGuardDecision(
  status: SharedHotelSetupStatus,
  input: {
    entryProduct: SharedHotelSetupEntryProduct;
    returnTo: string;
  },
): SharedHotelSetupGuardDecision {
  if (
    status.nextAction.action === "enter_product" &&
    status.nextAction.product === input.entryProduct
  ) {
    return {
      action: "enter_product",
      propertyId: status.nextAction.propertyId,
      redirectPath: null,
    };
  }

  const propertyId = "propertyId" in status.nextAction ? status.nextAction.propertyId : null;
  const product = "product" in status.nextAction ? status.nextAction.product : null;
  const selectedProperty = propertyId
    ? status.properties.find((property) => property.propertyId === propertyId)
    : null;
  const activation = product && selectedProperty ? selectedProperty.products[product] : null;

  return {
    action: "redirect_to_setup",
    propertyId,
    redirectPath: buildSharedHotelSetupRedirectPath({ ...input, propertyId }),
    setupAction: status.nextAction.action,
    product,
    productStatus: activation?.status ?? null,
    missingSteps:
      activation?.missingSteps ??
      ("missingSteps" in status.nextAction ? status.nextAction.missingSteps : []),
  };
}

export async function resolveSharedHotelSetupGuard(
  api: Pick<SharedHotelSetupApi, "getStatus">,
  input: {
    entryProduct: SharedHotelSetupEntryProduct;
    returnTo: string;
    propertyId?: string | null;
    onInvalidPropertyId?: () => void;
  },
): Promise<SharedHotelSetupGuardDecision> {
  let status: SharedHotelSetupStatus;
  try {
    status = await api.getStatus({
      entryProduct: input.entryProduct,
      returnTo: input.returnTo,
      propertyId: input.propertyId,
    });
  } catch (error) {
    if (!input.propertyId || !isMissingPropertyResourceLinkError(error)) throw error;
    input.onInvalidPropertyId?.();
    status = await api.getStatus({
      entryProduct: input.entryProduct,
      returnTo: input.returnTo,
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
  returnTo: string;
  propertyId?: string | null;
}): string {
  const query = new URLSearchParams({ entryProduct: input.entryProduct });
  if (isSafeSharedHotelSetupReturnTo(input.returnTo)) {
    query.set("returnTo", input.returnTo);
  }
  if (input.propertyId?.trim()) {
    query.set("propertyId", input.propertyId.trim());
  }
  return `/setup?${query.toString()}`;
}
