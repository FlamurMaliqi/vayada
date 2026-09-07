/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoomType } from "@/lib/types";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import RoomCombinationCard from "./RoomCombinationCard";

vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrency: () => ({
    selectedCurrency: "EUR",
    convertAndRound: (amount: number) => amount,
    formatPrice: (amount: number) => `EUR ${amount.toFixed(2)}`,
  }),
}));
const lines = [
  {
    roomTypeId: "double",
    publicOfferKey: "double:flex",
    roomName: "Double",
    roomCount: 2,
    guests: [
      { adults: 2, children: 0 },
      { adults: 1, children: 1 },
    ],
    rateSummary: { refundable: true },
    policy: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 3,
      afterDeadlinePenalty: "full_booking_amount",
    },
    totals: { totalAmount: "400.00" },
  },
  {
    roomTypeId: "twin",
    publicOfferKey: "twin:nrf",
    roomName: "Twin",
    roomCount: 1,
    guests: [{ adults: 2, children: 0 }],
    rateSummary: { refundable: false },
    policy: {},
    totals: { totalAmount: "200.00" },
  },
];
const room = {
  id: "selection-test",
  currency: "EUR",
  combination: {
    roomSelection: { contractVersion: "booking-room-selection.v1", lines },
    roomLines: lines,
    totalAmount: 600,
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    adults: 5,
    children: 1,
    expiresAt: "2027-01-01T10:15:00Z",
  },
} as unknown as RoomType;
let root: Root | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2027-01-01T10:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function card(locale: "en" | "de", onSelect = vi.fn()) {
  return createElement(NextIntlClientProvider, {
    locale,
    messages: locale === "en" ? en : de,
    children: createElement(RoomCombinationCard, {
      room,
      nights: 2,
      timezone: "Europe/Athens",
      onSelect,
    }),
  });
}
it.each(["en", "de"] as const)("renders every room and distinct policy in %s", (locale) => {
  const html = renderToStaticMarkup(card(locale));
  expect(html).toContain("2 × Double");
  expect(html).toContain("1 × Twin");
  expect(html).toContain("EUR 600.00");
  expect(html).toContain("Europe/Athens");
  expect(html).toContain(locale === "en" ? "Accommodation for 6 guests" : "Unterkunft für 6 Gäste");
  expect(html).toContain(locale === "en" ? "Non-refundable" : de.home.nonRefundableDesc);
});
it("selects all three rooms and disables selection at expiry", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  const select = vi.fn();
  await act(async () => {
    root!.render(card("en", select));
  });
  const button = document.querySelector("button")!;
  act(() => button.click());
  expect(select).toHaveBeenCalledWith(3);
  await act(async () => {
    vi.advanceTimersByTime(15 * 60_000);
  });
  expect(button.disabled).toBe(true);
  expect(document.body.textContent).toContain(en.roomSelection.unavailable);
});
