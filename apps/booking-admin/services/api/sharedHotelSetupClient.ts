import { createNearbyApi } from "@vayada/product-onboarding/nearbyApi";
import {
  createSharedAccountProfileImageUploader,
  createSharedHotelSetupApi,
} from "@vayada/product-onboarding";

import { ApiClient } from "./client";

const SHARED_SETUP_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const sharedSetupClient = new ApiClient(SHARED_SETUP_API_BASE_URL);

export const sharedHotelSetupApi = createSharedHotelSetupApi(sharedSetupClient);
export const sharedAccountProfileImageUploader =
  createSharedAccountProfileImageUploader(sharedSetupClient);

export const nearbyApi = createNearbyApi(sharedSetupClient);
