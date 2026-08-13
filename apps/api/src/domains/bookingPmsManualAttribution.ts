import { parseBookingAttribution } from "@vayada/domain-booking";
import { PmsManualBookingCreateError } from "@vayada/domain-pms";

import type { PmsManualBookingAttributionOwnerPort } from "./pmsManualBookingTransactionPorts.js";

export function createBookingPmsManualAttributionOwner(): PmsManualBookingAttributionOwnerPort {
  return {
    resolveManualAttribution({ directSource }) {
      const attribution = parseBookingAttribution({
        bookingChannel: "direct",
        directBookingSource: directSource,
      });
      if (
        !attribution ||
        attribution.bookingChannel !== "direct" ||
        attribution.directBookingSource === "booking_engine"
      ) {
        throw new PmsManualBookingCreateError("invalid_source", "directSource");
      }
      return { bookingChannel: "direct", directSource: attribution.directBookingSource };
    },
  };
}
