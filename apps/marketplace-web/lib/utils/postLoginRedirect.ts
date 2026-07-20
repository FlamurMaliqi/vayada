import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import type { UserType } from "@/lib/types";
import { creatorService } from "@/services/api/creators";
import { authService } from "@/services/auth";

import { hasRequiredCreatorAccountDetails } from "./creatorAccountRequirements";
import { getPostLoginProfileRedirect } from "./profileRedirect";
import { checkProfileStatus } from "./profileStatus";
import { resolveMarketplaceSetupGuard } from "./sharedSetupGuard";

type ProfileStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;

export async function getMarketplacePostLoginRedirect(
  returnTo: string = ROUTES.MARKETPLACE,
  storage: ProfileStorage | null = browserStorage(),
): Promise<string> {
  const userType = storage?.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;

  if (userType === "hotel") {
    const decision = await resolveMarketplaceSetupGuard(returnTo, undefined, storage);
    storage?.setItem(STORAGE_KEYS.PROFILE_COMPLETE, String(decision.action === "enter_product"));
    return decision.action === "enter_product" ? returnTo : (decision.redirectPath ?? ROUTES.SETUP);
  }

  if (userType === "creator") {
    const [profileStatus, profile] = await Promise.all([
      checkProfileStatus(userType),
      creatorService.getMyProfile(),
    ]);
    if (!hasRequiredCreatorAccountDetails(authService.getSessionUser(), profile)) {
      storage?.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
      return ROUTES.ONBOARDING;
    }
    const decision = getPostLoginProfileRedirect(userType, profileStatus);
    if (decision.profileComplete !== null) {
      storage?.setItem(STORAGE_KEYS.PROFILE_COMPLETE, String(decision.profileComplete));
    }
    return decision.redirectPath;
  }

  return ROUTES.ONBOARDING;
}

function browserStorage(): ProfileStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
