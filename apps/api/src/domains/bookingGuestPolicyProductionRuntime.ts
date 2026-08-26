import type {
  BookingGuestPolicyApplicationPort,
  BookingGuestPolicyCurrentOwnerEvidencePort,
  BookingGuestPolicyOwnerEvidencePorts,
} from "@vayada/domain-booking";

import {
  createBookingGuestPolicyApplication,
  type BookingGuestPolicyApplicationDependencies,
} from "./bookingGuestPolicyApplication.js";
import {
  createBookingGuestPolicyCatalogProfileEvidencePort,
  type BookingGuestPolicyCatalogProfileEvidencePool,
} from "./bookingGuestPolicyCatalogProfileEvidence.js";
import type { BookingGuestPolicyRepository } from "./bookingGuestPolicyRepository.js";

export function createBookingGuestPolicyProductionApplication(input: {
  repository: BookingGuestPolicyRepository;
  catalogPool: BookingGuestPolicyCatalogProfileEvidencePool;
  ownerEvidence: Omit<BookingGuestPolicyOwnerEvidencePorts, "catalogProfile">;
  currentOwnerEvidence: BookingGuestPolicyCurrentOwnerEvidencePort;
}): BookingGuestPolicyApplicationPort {
  const dependencies: BookingGuestPolicyApplicationDependencies = {
    authorizedReplay: input.repository,
    persistence: input.repository,
    read: input.repository,
    ownerEvidence: {
      catalogProfile: createBookingGuestPolicyCatalogProfileEvidencePort({
        pool: input.catalogPool,
      }),
      ...input.ownerEvidence,
    },
    currentOwnerEvidence: input.currentOwnerEvidence,
  };
  return createBookingGuestPolicyApplication(dependencies);
}
