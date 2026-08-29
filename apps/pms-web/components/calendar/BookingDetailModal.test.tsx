import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Booking } from "@/services/bookings";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/services/bookings", () => ({ bookingsService: { get: mocks.get } }));

import BookingDetailModal from "./BookingDetailModal";

// prettier-ignore
const booking = { id: "booking-1", bookingReference: "VAY-1", roomTypeId: "type-1", roomName: "Double", guestFirstName: "Ada", guestLastName: "Lovelace", guestEmail: "", guestPhone: "", checkIn: "2026-09-10", checkOut: "2026-09-12", nights: 2, adults: 1, children: 0, nightlyRate: 100, numberOfRooms: 2, totalAmount: 200, balanceAmount: 200, currency: "EUR", status: "confirmed", roomId: "room-1", roomNumber: "101", assignedRooms: [{ assignmentId: "a-1", roomId: "room-1", roomNumber: "101", position: 0, roomTypeId: "type-1" }, { assignmentId: "a-2", roomId: "room-2", roomNumber: "202", position: 1, roomTypeId: "type-1" }], stays: [{ position: 0, roomName: "Double", ratePlanName: null, roomNumber: "101", checkIn: "2026-09-10", checkOut: "2026-09-12", adults: 1, children: 0, nightly: [] }], channel: "manual", expectedPaymentMethod: "cash", createdAt: "2026-08-01" } as unknown as Booking;
// prettier-ignore
const rooms = [{ id: "room-1", roomTypeId: "type-1", roomTypeName: "Double", roomNumber: "101", floor: "1", status: "available", baseRate: 100, currency: "EUR", maxOccupancy: 2, size: 20 }, { id: "room-2", roomTypeId: "type-1", roomTypeName: "Double", roomNumber: "202", floor: "2", status: "available", baseRate: 100, currency: "EUR", maxOccupancy: 2, size: 20 }, { id: "room-3", roomTypeId: "type-2", roomTypeName: "Villa", roomNumber: "V1", floor: "", status: "available", baseRate: 220, currency: "EUR", maxOccupancy: 5, size: 80 }];
// prettier-ignore
const bookings = [{ id: "booking-1", assignmentId: "a-1", roomId: "room-1", roomPosition: 0, checkIn: "2026-09-10", checkOut: "2026-09-12", status: "confirmed" }, { id: "booking-1", assignmentId: "a-2", roomId: "room-2", roomPosition: 1, checkIn: "2026-09-10", checkOut: "2026-09-12", status: "confirmed" }];

describe("cross-room-type move picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(booking);
  });

  it("groups all rooms and keeps sibling assignments occupied", async () => {
    let view: ReturnType<typeof create>;
    await act(async () => {
      // prettier-ignore
      view = create(
        <BookingDetailModal bookingId="booking-1" sourceAssignmentSelector={{ assignmentId: "a-1" }} onClose={vi.fn()} onStatusChange={vi.fn()} rooms={rooms} bookings={bookings} />,
      );
    });
    const buttonContaining = (text: string) =>
      view!.root
        .findAllByType("button")
        .find(
          (button) =>
            button.findAll((node) =>
              node.children.some((child) => typeof child === "string" && child.includes(text)),
            ).length,
        );
    await act(async () => buttonContaining("Move to another room")!.props.onClick());
    const picker = JSON.stringify(view!.toJSON());
    expect(picker.indexOf("202")).toBeLessThan(picker.indexOf("V1"));
    expect(picker).toContain("Occupied");
    expect(picker).toContain("Up to 5 guests");
    expect(picker).toContain("80 m²");
    view!.unmount();
  });

  it("fails closed when the selected assignment is stale", async () => {
    let view: ReturnType<typeof create>;
    await act(async () => {
      // prettier-ignore
      view = create(<BookingDetailModal bookingId="booking-1" sourceAssignmentSelector={{ assignmentId: "missing" }} onClose={vi.fn()} onStatusChange={vi.fn()} rooms={rooms} bookings={bookings} />);
    });
    expect(JSON.stringify(view!.toJSON())).toContain("This room assignment changed");
    view!.unmount();
  });
});
