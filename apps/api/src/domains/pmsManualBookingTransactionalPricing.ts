import type { QueryResultRow } from "pg";
import type { HotelMediaResolutionPort } from "@vayada/domain-hotels";
import type { RoomAmenityVocabularyValidationPort } from "@vayada/domain-pms";

import {
  createPgTargetBookingAddonItemsRepository,
  type BookingAddonItemsPool,
} from "../routes/bookingAddonItems.js";
import { calculateManualBookingPreview } from "../routes/pmsManualBookingPreviewCalculation.js";
import { readCurrentBookingGuestPolicyRevision } from "./bookingGuestPolicyRepository.js";
import { loadPmsPricingSourceSnapshot } from "./pmsPricingReadModel.js";
import { createPgPmsRoomFactsReadModel } from "./pmsRoomFactsReadModel.js";
import { createPgPmsRoomPublicationReadModel } from "./pmsRoomPublicationReadModel.js";
import type {
  PmsManualBookingCurrentPricingEvidence,
  PmsManualBookingTransaction,
  PmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionPorts.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { loadPmsRecurringPricingBookingEvidence } from "./pmsRecurringPricingReadModel.js";

export function createPmsManualBookingCurrentPricingEvidence(config: {
  amenityVocabulary: RoomAmenityVocabularyValidationPort;
  mediaResolver: HotelMediaResolutionPort;
  now?: () => Date;
}): PmsManualBookingCurrentPricingEvidence {
  return {
    getPricingSourceSnapshot: ({ transaction, propertyId }) =>
      loadPmsPricingSourceSnapshot(transaction, propertyId, (config.now ?? (() => new Date()))()),
    getRoomPublicationSnapshot: async ({ transaction, propertyId, organizationId }) => {
      const roomFacts = createPgPmsRoomFactsReadModel({
        connectionString: "caller-transaction",
        pool: transaction,
      });
      const publication = createPgPmsRoomPublicationReadModel({
        connectionString: "caller-transaction",
        pool: transaction,
        roomFacts,
        roomCapacity: roomFacts,
        amenityVocabulary: config.amenityVocabulary,
        mediaResolver: config.mediaResolver,
      });
      return publication.getRoomPublicationSnapshot({ propertyId, organizationId });
    },
  };
}

export function createPmsManualBookingTransactionalPricingPort(
  current: PmsManualBookingCurrentPricingEvidence,
): PmsManualBookingTransactionalPricingPort {
  return {
    async calculate({ transaction, command, acceptedAt }) {
      const pms = createTargetPmsOperationsReadRepository({
        connectionString: "caller-transaction",
        pool: transaction,
      });
      const addonRepository = createPgTargetBookingAddonItemsRepository({
        connectionString: "caller-transaction",
        pool: addonQueryable(transaction),
      });
      return calculateManualBookingPreview(
        { propertyId: command.propertyId, organizationId: command.organizationId },
        {
          contractVersion: command.contractVersion,
          stays: [...command.stays],
          addOns: command.addOns.map((selection) => ({
            ...selection,
            serviceUnits: [...selection.serviceUnits],
          })),
        },
        {
          pms,
          pricing: {
            getPricingSourceSnapshot: (propertyId) =>
              current.getPricingSourceSnapshot({ transaction, propertyId }),
            getRecurringPricingBookingEvidence: (propertyId) =>
              loadPmsRecurringPricingBookingEvidence(transaction, propertyId, acceptedAt),
          },
          roomPublication: {
            getRoomPublicationSnapshot: ({ propertyId, organizationId }) =>
              current.getRoomPublicationSnapshot({ transaction, propertyId, organizationId }),
          },
          booking: {
            listAddonItemsByHotelId: (propertyId) =>
              addonRepository.listAddonItemsByHotelId(propertyId),
            getCurrentGuestPolicy: ({ propertyId, organizationId }) =>
              readCurrentBookingGuestPolicyRevision(transaction, propertyId, organizationId),
          },
        },
      );
    },
  };
}

function addonQueryable(transaction: PmsManualBookingTransaction): BookingAddonItemsPool {
  return {
    query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      return transaction.query<Row>(text, values);
    },
  };
}
