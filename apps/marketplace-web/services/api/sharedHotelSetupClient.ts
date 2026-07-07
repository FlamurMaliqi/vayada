import { createSharedHotelSetupApi } from "@vayada/product-onboarding";

import { ApiClient } from "./client";
import { getAuthKitAccessToken } from "@/services/auth/sessionStore";

const SHARED_SETUP_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";

export const sharedHotelSetupApi = createSharedHotelSetupApi(
  new ApiClient(SHARED_SETUP_API_BASE_URL, getAuthKitAccessToken),
);
