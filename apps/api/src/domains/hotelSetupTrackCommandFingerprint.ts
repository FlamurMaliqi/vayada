import { createHash } from "node:crypto";

import type { SetupTrack } from "@vayada/domain-hotels";

export type HotelSetupTrackRequestFingerprintInput = {
  organizationId: string;
  selectedTracks: SetupTrack[];
  expectedRevision: number;
  adminActivation?: { platformOrganizationId: string; accountUserId: string; actorUserId: string };
};

/**
 * Keep this serialization order stable: persisted idempotency rows use its digest.
 */
export function hotelSetupTrackRequestFingerprint(
  input: HotelSetupTrackRequestFingerprintInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        selectedTracks: input.selectedTracks,
        expectedRevision: input.expectedRevision,
        ...(input.adminActivation ? { adminActivation: input.adminActivation } : {}),
      }),
    )
    .digest("hex");
}
