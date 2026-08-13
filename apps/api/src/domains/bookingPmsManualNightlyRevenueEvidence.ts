import { appendExternalNightlyRevenueEvidence } from "./bookingExternalNightlyRevenueEvidence.js";
import type { PmsManualBookingNightlyEvidenceOwnerPort } from "./pmsManualBookingTransactionPorts.js";

export function createBookingPmsManualNightlyRevenueEvidenceOwner(): PmsManualBookingNightlyEvidenceOwnerPort {
  return {
    async appendExactNightlyEvidence({ transaction, command, guestBookingId, rooms, preview }) {
      const roomTypes = new Map(rooms.map((room) => [room.roomId, room.roomTypeId]));
      const selections = new Map(command.stays.map((stay) => [stay.position, stay]));
      if (
        preview.contractVersion !== command.contractVersion ||
        preview.stays.length !== command.stays.length ||
        new Set(preview.stays.map(({ position }) => position)).size !== command.stays.length
      ) {
        throw new Error("Manual booking nightly evidence is unavailable");
      }
      const lines = preview.stays.flatMap((pricedStay) => {
        const selectedStay = selections.get(pricedStay.position);
        const roomTypeId = selectedStay && roomTypes.get(selectedStay.roomId);
        if (
          !selectedStay ||
          !roomTypeId ||
          pricedStay.roomId !== selectedStay.roomId ||
          pricedStay.ratePlanId !== selectedStay.ratePlanId
        ) {
          throw new Error("Manual booking nightly evidence does not match the selected stay");
        }
        const serviceDates = stayDates(selectedStay.checkIn, selectedStay.checkOut);
        if (
          pricedStay.nightly.length !== serviceDates.length ||
          pricedStay.nightly.some(
            (night, index) =>
              night.serviceDate !== serviceDates[index] ||
              night.applied.currency !== preview.currency,
          )
        ) {
          throw new Error("Manual booking nightly evidence is incomplete");
        }
        return pricedStay.nightly.map((night) => ({
          roomTypeId,
          stayDate: night.serviceDate,
          recognizedOn: night.serviceDate,
          grossRoomAmount: night.applied.amountDecimal,
          occupiedRoomNights: 1 as const,
          economicEvent: "room_night" as const,
          lifecycleState: "confirmed" as const,
          evidenceQuality: "exact" as const,
          linePosition: pricedStay.position,
        }));
      });
      if (lines.length === 0) {
        throw new Error("Manual booking nightly evidence is unavailable");
      }
      await transaction.query(
        `INSERT INTO booking.nightly_revenue_room_scopes (property_id, room_type_id)
         SELECT $1::uuid, room_type_id::uuid FROM unnest($2::text[]) AS room_type_id
         ON CONFLICT DO NOTHING`,
        [command.propertyId, [...new Set(roomTypes.values())]],
      );
      await appendExternalNightlyRevenueEvidence(transaction, {
        propertyId: command.propertyId,
        guestBookingId,
        sourceKind: "manual",
        sourceBookingReference: command.commandId,
        idempotencyKey: `${command.idempotencyKey}:nightly-revenue:v1`,
        lines,
      });
    },
  };
}

function stayDates(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}
