import type { QueryResultRow } from "pg";

import {
  createPgTargetBookingAddonItemsRepository,
  type BookingAddonItemsPool,
} from "../routes/bookingAddonItems.js";
import { calculateManualBookingPreview } from "../routes/pmsManualBookingPreviewCalculation.js";
import { readCurrentBookingGuestPolicyRevision } from "./bookingGuestPolicyRepository.js";
import type {
  PmsManualBookingTransaction,
  PmsManualBookingTransactionalPricingPort,
} from "./pmsManualBookingTransactionPorts.js";
import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { loadPmsRecurringPricingBookingEvidence } from "./pmsRecurringPricingReadModel.js";

const DAY = 86_400_000;

export function createPmsManualBookingTransactionalPricingPort(): PmsManualBookingTransactionalPricingPort {
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
          stays: command.stays.map((stay) => ({
            ...stay,
            dates: dates(stay.checkIn, stay.checkOut),
          })),
          addOns: command.addOns.map((selection) => ({
            ...selection,
            serviceUnits: [...selection.serviceUnits],
          })),
        },
        {
          pms,
          pricing: {
            getRecurringPricingBookingEvidence: (propertyId) =>
              loadPmsRecurringPricingBookingEvidence(transaction, propertyId, acceptedAt),
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

function dates(checkIn: string, checkOut: string): string[] {
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const count = (Date.parse(`${checkOut}T00:00:00Z`) - start) / DAY;
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * DAY).toISOString().slice(0, 10),
  );
}
