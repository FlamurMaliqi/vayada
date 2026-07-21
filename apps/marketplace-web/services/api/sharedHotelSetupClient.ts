import {
  createSharedAccountProfileImageUploader,
  createSharedHotelSetupApi,
} from "@vayada/product-onboarding";

import { createVayadaApiClient } from "./client";
import { getAuthKitAccessToken } from "@/services/auth/sessionStore";

const SHARED_SETUP_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const sharedSetupClient = createVayadaApiClient(SHARED_SETUP_API_BASE_URL, getAuthKitAccessToken);

export const sharedHotelSetupApi = createSharedHotelSetupApi(sharedSetupClient);
export const sharedAccountProfileImageUploader =
  createSharedAccountProfileImageUploader(sharedSetupClient);
