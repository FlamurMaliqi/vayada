import type { QueryResultRow } from "pg";

import {
  createPgTargetBookingAddonItemsRepository,
  type BookingAddonItemsPool,
} from "../routes/bookingAddonItems.js";
import { calculateManualBookingPreview } from "../routes/pmsManualBookingPreviewCalculation.js";
import { readCurrentBookingGuestPolicyRevision } from "./bookingGuestPolicyRepository.js";
import type {
  PmsManualBookingCurrentPricingEvidence,
  PmsManualBookingTransaction,
  PmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionPorts.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { loadPmsRecurringPricingBookingEvidence } from "./pmsRecurringPricingReadModel.js";

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
