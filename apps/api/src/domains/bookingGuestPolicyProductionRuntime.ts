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
    async readInitialArrivalTimes(scope) {
      const { rows } = await input.catalogPool.query<{
        checkInTime: string | null;
        checkOutTime: string | null;
        checkInUntil: string | null;
        checkOutFrom: string | null;
      }>(
        `SELECT to_char(policy.check_in_time, 'HH24:MI') AS "checkInTime",
                to_char(policy.check_out_time, 'HH24:MI') AS "checkOutTime",
                to_char(policy.check_in_until, 'HH24:MI') AS "checkInUntil",
                to_char(policy.check_out_from, 'HH24:MI') AS "checkOutFrom"
           FROM hotel_catalog.property_policy_summaries policy
          WHERE policy.property_id = $2::uuid
            AND EXISTS (
              SELECT 1 FROM identity.organization_resource_links resource
              JOIN identity.organizations organization ON organization.id = resource.organization_id
              WHERE organization.id = $1::uuid AND organization.kind = 'hotel_group'
                AND organization.status = 'active' AND resource.product = 'hotel_catalog'
                AND resource.resource_type = 'property' AND resource.resource_id = policy.property_id::text
                AND resource.relationship IN ('owner', 'operator') AND resource.status = 'active'
            )`,
        [scope.organizationId, scope.propertyId],
      );
      const row = rows[0];
      return {
        checkInTime: row?.checkInTime ?? null,
        checkOutTime: row?.checkOutTime ?? null,
        ...(row?.checkInUntil ? { checkInUntil: row.checkInUntil } : {}),
        ...(row?.checkOutFrom ? { checkOutFrom: row.checkOutFrom } : {}),
      };
    },
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
