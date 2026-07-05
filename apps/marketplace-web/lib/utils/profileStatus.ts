/**
 * Profile status utility functions
 */

import { creatorService } from "@/services/api/creators";
import { hotelService } from "@/services/api/hotels";
import type { UserType, CreatorProfileStatus, HotelProfileStatus } from "@/lib/types";
import { ApiErrorResponse } from "@/services/api/client";

/**
 * Check profile status and return the status object
 */
export async function checkProfileStatus(
  userType: UserType,
): Promise<CreatorProfileStatus | HotelProfileStatus | null> {
  try {
    if (userType === "creator") {
      return await creatorService.getProfileStatus();
    } else if (userType === "hotel") {
      return await hotelService.getProfileStatus();
    }
    return null;
  } catch (error) {
    if (error instanceof ApiErrorResponse) {
      if (error.status === 404) return null;
      console.error("Failed to check profile status:", error);
    }
    throw error;
  }
}

/**
 * Check if profile is complete and return boolean
 */
export async function isProfileComplete(userType: UserType): Promise<boolean> {
  const status = await checkProfileStatus(userType);
  if (!status) return false;
  return status.profile_complete;
}
