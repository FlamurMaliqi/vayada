/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoomType } from "@/lib/types";
import { usePricing, type PricingInputs } from "./usePricing";
import { bookingService } from "@/services/api/booking";
import { hotelService } from "@/services/api/hotel";

vi.mock("@/services/api/booking", () => ({ bookingService: { quote: vi.fn() } }));
vi.mock("@/services/api/hotel", () => ({ hotelService: { validatePromoCode: vi.fn() } }));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrency: () => ({ convertAndRound: (amount: number) => amount }),
}));
vi.mock("@/contexts/HotelContext", () => ({
  useHotel: () => ({ hotel: { currency: "EUR" } }),
  useSlug: () => ({ slug: "hotel" }),
  useRooms: () => ({ rooms: [room] }),
  useAddons: () => ({ addons: [] }),
}));
const selection = {
  contractVersion: "booking-room-selection.v1" as const,
  lines: [
    {
      roomTypeId: "double",
      publicOfferKey: "double:flex",
      guests: [
        { adults: 2, children: 0 },
        { adults: 1, children: 1 },
      ],
    },
    { roomTypeId: "twin", publicOfferKey: "twin:flex", guests: [{ adults: 2, children: 0 }] },
  ],
};
const room = {
  id: "selection-complete",
  currency: "EUR",
  baseRate: 300,
  nonRefundableRate: null,
  ratePaymentMethods: { flexible: ["pay_at_property"] },
  combination: {
    roomSelection: selection,
    roomLines: [],
    totalAmount: 600,
    expiresAt: "2027-01-01T10:15:00Z",
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    adults: 5,
    children: 1,
  },
} as unknown as RoomType;
const input: PricingInputs = {
  roomId: room.id,
  checkIn: "2027-02-01",
  checkOut: "2027-02-03",
  adults: 5,
  children: 1,
  roomsParam: 3,
  rateType: "flexible",
  selectedAddonIds: ["breakfast"],
  addonQuantities: {},
  promoCode: "MIXED50",
};
let root: Root;
let latest: ReturnType<typeof usePricing>;
function Probe({ value }: { value: PricingInputs }) {
  latest = usePricing(value);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-01-01T10:00:00Z"));
  vi.mocked(bookingService.quote).mockReset();
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
it("uses canonical combined pricing once and invalidates it at selection expiry", async () => {
  vi.mocked(bookingService.quote).mockResolvedValue({
    roomSelection: selection,
    roomLines: [],
    quoteId: "quote",
    expiresAt: "2027-01-01T10:15:00Z",
    totalAmount: 560.25,
    addonTotal: 10.25,
    promoDiscount: 50,
    currency: "EUR",
  } as never);
  await act(async () => {
    root.render(createElement(Probe, { value: input }));
  });
  expect(latest).toMatchObject({
    quoteReady: true,
    roomTotal: 600,
    addonTotal: 10.25,
    grandTotal: 560.25,
    discountAmount: 50,
  });
  expect(bookingService.quote).toHaveBeenCalledWith(
    "hotel",
    expect.objectContaining({
      roomSelection: selection,
      numberOfRooms: 3,
      adults: 5,
      children: 1,
      addonIds: ["breakfast"],
      promoCode: "MIXED50",
    }),
    expect.any(String),
  );
  expect(hotelService.validatePromoCode).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(15 * 60_000);
  });
  expect(latest.room).toBeUndefined();
  expect(latest.quoteReady).toBe(false);
});
it("ignores a delayed quote after the user changes the selection", async () => {
  let finish!: (value: never) => void;
  vi.mocked(bookingService.quote).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    root.render(createElement(Probe, { value: input }));
  });
  await act(async () => {
    root.render(createElement(Probe, { value: { ...input, roomId: "selection-gone" } }));
  });
  await act(async () => {
    finish({
      roomSelection: selection,
      expiresAt: "2027-01-01T10:15:00Z",
      totalAmount: 560.25,
    } as never);
  });
  expect(latest.room).toBeUndefined();
  expect(latest.quoteReady).toBe(false);
});

it("rejects a quote that omits part of the selected rooms", async () => {
  vi.mocked(bookingService.quote).mockResolvedValue({
    roomSelection: { ...selection, lines: [selection.lines[0]] },
    expiresAt: "2027-01-01T10:15:00Z",
    totalAmount: 400,
    currency: "EUR",
  } as never);
  await act(async () => {
    root.render(createElement(Probe, { value: input }));
  });
  expect(latest.quoteReady).toBe(false);
  expect(latest.promoError).toContain("Room selection pricing is unavailable");
});
