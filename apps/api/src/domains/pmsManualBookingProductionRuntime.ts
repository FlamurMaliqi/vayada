import type { HotelMediaResolutionPort } from "@vayada/domain-hotels";
import type { RoomAmenityVocabularyValidationPort } from "@vayada/domain-pms";

import { createBookingPmsManualAttributionOwner } from "./bookingPmsManualAttribution.js";
import { createBookingPmsManualNightlyRevenueEvidenceOwner } from "./bookingPmsManualNightlyRevenueEvidence.js";
import { createFinanceManualBookingSettlementPort } from "./financeManualBookingSettlement.js";
import { createPgPmsManualBookingCommandRepository } from "./pmsManualBookingCommandRepository.js";
import { createPgPmsManualBookingPlatformOwnerPort } from "./pmsManualBookingCommandEvidence.js";
import {
  createPgPmsManualBookingBookingOwnerPort,
  createPgPmsManualBookingOperationsOwnerPort,
} from "./pmsManualBookingPersistence.js";
import {
  createPmsManualBookingCurrentPricingEvidence,
  createPmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionalPricing.js";

type RoomPublicationRuntime = Readonly<{
  amenityVocabulary: RoomAmenityVocabularyValidationPort;
  mediaResolver: HotelMediaResolutionPort;
}>;

export function createPmsManualBookingProductionCommandConfig(input: {
  connectionString: string;
  pmsOperationsReady: boolean;
  roomPublication?: RoomPublicationRuntime;
}): Parameters<typeof createPgPmsManualBookingCommandRepository>[0] | null {
  if (!input.pmsOperationsReady || !input.roomPublication) return null;
  return {
    connectionString: input.connectionString,
    dependencies: {
      booking: createPgPmsManualBookingBookingOwnerPort(),
      operations: createPgPmsManualBookingOperationsOwnerPort(),
      platform: createPgPmsManualBookingPlatformOwnerPort(),
      nightlyEvidence: createBookingPmsManualNightlyRevenueEvidenceOwner(),
      attribution: createBookingPmsManualAttributionOwner(),
      financeSettlement: createFinanceManualBookingSettlementPort(),
      pricing: createPmsManualBookingTransactionalPricingPort(
        createPmsManualBookingCurrentPricingEvidence(input.roomPublication),
      ),
    },
  };
}
