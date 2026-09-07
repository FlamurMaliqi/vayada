import { expect, it } from "vitest";
import {
  toBookingReservationReadModel,
  type BookingReservationReadModelRow,
} from "./bookingReservationReadModel.js";
it("projects every selected room for admin without exposing inventory evidence", () => {
  const lines = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ].map((roomTypeId, index) => ({
    roomTypeId,
    publicOfferKey: roomTypeId,
    guests: Array.from({ length: index ? 1 : 2 }, () => ({ adults: 2, children: 0 })),
  }));
  const result = toBookingReservationReadModel({
    id: "booking",
    bookingReference: "VAY-1",
    roomTypeId: lines[0]!.roomTypeId,
    roomName: "stale primary",
    roomMaxOccupancy: 2,
    guestFirstName: "Test",
    guestLastName: "Guest",
    guestEmail: "",
    guestPhone: "",
    specialRequests: "",
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    adults: 6,
    children: 0,
    nightlyRate: 100,
    numberOfRooms: 3,
    totalAmount: 600,
    currency: "EUR",
    status: "pending",
    createdAt: "2027-01-01",
    updatedAt: "2027-01-01",
    selectedRoomOffer: {
      roomSelection: { contractVersion: "booking-room-selection.v1", lines },
      roomLines: lines.map((line, index) => ({
        ...line,
        offer: {
          roomSummary: { name: index ? "Twin" : "Double" },
          inventoryEvidence: "private receipt",
        },
      })),
    },
  } satisfies BookingReservationReadModelRow);
  expect(result.roomLines).toEqual(
    lines.map((line, index) => ({
      roomTypeId: line.roomTypeId,
      roomName: index ? "Twin" : "Double",
      roomCount: index ? 1 : 2,
    })),
  );
  expect(JSON.stringify(result)).not.toContain("private receipt");
});
