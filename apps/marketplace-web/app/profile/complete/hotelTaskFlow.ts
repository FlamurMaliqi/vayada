import { canonicalSetupReturnUrl } from "@vayada/product-onboarding/returnTo";

import { SELECTED_SHARED_PROPERTY_ID_KEY } from "@/lib/utils/sharedSetupGuard";

export type MarketplaceHotelSetupTaskId = "public_profile" | "creator_profile" | "creator_offer";

export type HotelTaskSection =
  | "public_profile"
  | "creator_profile"
  | "offer_details"
  | "offerings"
  | "requirements";

export type MarketplaceHotelTaskHandoff = {
  propertyId: string;
  taskId: MarketplaceHotelSetupTaskId;
  planRevision: string;
  destinationRouteKey: string;
  returnUrl: string;
};

export type MarketplaceHotelTaskFlow = {
  steps: ReadonlyArray<{ title: string; section: HotelTaskSection }>;
  ensureCover: boolean;
  submitPublicProfile: boolean;
  submitMarketplaceProfile: boolean;
  submitOffers: boolean;
};

const TASK_DESTINATIONS: Record<MarketplaceHotelSetupTaskId, string> = {
  public_profile: "hotel_catalog.public_profile",
  creator_profile: "marketplace.creator_profile",
  creator_offer: "marketplace.creator_offer",
};

const TASK_FLOWS: Record<MarketplaceHotelSetupTaskId, MarketplaceHotelTaskFlow> = {
  public_profile: {
    steps: [{ title: "Complete your public hotel profile", section: "public_profile" }],
    ensureCover: true,
    submitPublicProfile: true,
    submitMarketplaceProfile: false,
    submitOffers: false,
  },
  creator_profile: {
    steps: [{ title: "Introduce your hotel to creators", section: "creator_profile" }],
    ensureCover: false,
    submitPublicProfile: false,
    submitMarketplaceProfile: true,
    submitOffers: false,
  },
  creator_offer: {
    steps: [
      { title: "Describe your offer", section: "offer_details" },
      { title: "What are you offering?", section: "offerings" },
      { title: "Who are you looking for?", section: "requirements" },
    ],
    ensureCover: false,
    submitPublicProfile: false,
    submitMarketplaceProfile: false,
    submitOffers: true,
  },
};

export function hotelTaskFlow(taskId: MarketplaceHotelSetupTaskId): MarketplaceHotelTaskFlow {
  return TASK_FLOWS[taskId];
}

export function parseMarketplaceHotelTaskHandoff(
  params: URLSearchParams,
  storage: Pick<Storage, "getItem">,
  marketplaceOrigin: string,
): MarketplaceHotelTaskHandoff | null {
  const allowedKeys = [
    "activation",
    "taskId",
    "destinationRouteKey",
    "planRevision",
    "returnUrl",
  ] as const;
  const allowedKeySet = new Set<string>(allowedKeys);
  let invalidKey = false;
  params.forEach((_, key) => {
    if (!allowedKeySet.has(key) || params.getAll(key).length !== 1) invalidKey = true;
  });
  if (invalidKey || allowedKeys.some((key) => params.getAll(key).length !== 1)) return null;

  const taskId = params.get("taskId")?.trim() as MarketplaceHotelSetupTaskId | undefined;
  const destinationRouteKey = params.get("destinationRouteKey")?.trim() ?? "";
  const planRevision = params.get("planRevision")?.trim() ?? "";
  if (
    params.get("activation") !== "marketplace" ||
    !taskId ||
    TASK_DESTINATIONS[taskId] !== destinationRouteKey ||
    !planRevision
  ) {
    return null;
  }

  const propertyId = storage.getItem(SELECTED_SHARED_PROPERTY_ID_KEY)?.trim() ?? "";
  if (!propertyId) return null;

  const returnUrlValue = params.get("returnUrl") ?? "";
  if (!canonicalSetupReturnUrl(returnUrlValue, propertyId, marketplaceOrigin)) return null;

  return {
    propertyId,
    taskId,
    planRevision,
    destinationRouteKey,
    returnUrl: returnUrlValue,
  };
}

export function hotelTaskResumeStep(input: {
  taskId: MarketplaceHotelSetupTaskId;
  savedStep: number;
  authoritativeLocalityPublic: boolean;
  needsPhotos: boolean;
}): number {
  if (input.taskId === "public_profile" && !input.authoritativeLocalityPublic) return 1;
  if (input.taskId !== "creator_offer") return 1;
  const savedStep = Math.max(1, Math.min(3, input.savedStep));
  return input.needsPhotos ? 1 : savedStep;
}
