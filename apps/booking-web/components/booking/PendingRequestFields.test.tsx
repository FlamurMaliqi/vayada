/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import type { RoomType, RoomSelection } from "@/lib/types";
import type { BookingCreateRequest } from "@/services/api/booking";
import type { PendingEditDetails } from "@/services/api/pendingBookingEdits";
import PendingRequestFields from "./PendingRequestFields";
const selection: RoomSelection = {
  contractVersion: "booking-room-selection.v1",
  lines: [
    {
      roomTypeId: "double",
      publicOfferKey: "double:flex",
      guests: [
        { adults: 2, children: 0 },
        { adults: 2, children: 0 },
      ],
    },
    { roomTypeId: "twin", publicOfferKey: "twin:nrf", guests: [{ adults: 2, children: 0 }] },
  ],
};
const input = {
  roomTypeId: "double",
  roomSelection: selection,
  checkIn: "2027-02-01",
  checkOut: "2027-02-03",
  adults: 6,
  children: 0,
  numberOfRooms: 3,
  paymentMethod: "pay_at_property",
} as BookingCreateRequest;
const details = { input, booking: { roomName: "2 × Double + 1 × Twin" } } as PendingEditDetails;
const mixed = {
  id: "selection-complete",
  name: details.booking.roomName,
  currency: "EUR",
  combination: { roomSelection: selection },
} as RoomType;
const single = { id: "suite", name: "Suite", currency: "EUR" } as RoomType;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
async function render(value: BookingCreateRequest, rooms: RoomType[], change = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        children: createElement(PendingRequestFields, {
          input: value,
          details,
          settings: null,
          rooms,
          addons: [],
          disabled: false,
          change,
        }),
      }),
    ),
  );
  return change;
}
it("prefills held mixed rooms even when public search cannot offer them", async () => {
  await render(input, [single]);
  expect(document.querySelector("select")!.selectedOptions[0].textContent).toBe(
    details.booking.roomName,
  );
  const count = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="number"]')).at(
    -1,
  )!;
  expect(count.value).toBe("3");
  expect(count.readOnly).toBe(true);
});
it("switches every line together and clears mixed state when choosing a single room", async () => {
  const change = await render(input, [mixed, single]);
  const select = document.querySelector("select")!;
  expect(select.value).toBe(mixed.id);
  act(() => {
    select.value = single.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(change).toHaveBeenLastCalledWith({
    roomTypeId: "suite",
    roomSelection: undefined,
    currency: undefined,
    numberOfRooms: 1,
  });
  await render(
    { ...input, roomTypeId: "suite", roomSelection: undefined },
    [mixed, single],
    change,
  );
  act(() => {
    select.value = mixed.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(change).toHaveBeenLastCalledWith({
    roomTypeId: "double",
    roomSelection: selection,
    currency: "EUR",
    numberOfRooms: 3,
  });
});
it("blocks price review after a party change until allocations match", async () => {
  await render({ ...input, adults: 7 }, [mixed, single]);
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')!.textContent).toBe(en.roomSelection.partyChanged);
});

it("can restore a held original selection after choosing an alternative", async () => {
  const change = await render(input, [single]);
  const select = document.querySelector("select")!;
  act(() => {
    select.value = single.id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const alternative = { ...input, ...change.mock.lastCall![0] };
  await render(alternative, [single], change);
  act(() => {
    select.value = "original-selection";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(change).toHaveBeenLastCalledWith({
    roomTypeId: input.roomTypeId,
    roomSelection: selection,
    numberOfRooms: 3,
    currency: undefined,
  });
});
