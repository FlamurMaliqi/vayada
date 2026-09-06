/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CurrencyProvider, useCurrency } from "./CurrencyContext";
const hotel = { currency: "EUR" };
vi.mock("@/contexts/HotelContext", () => ({
  useHotel: () => ({ hotel }),
  useSlug: () => ({ slug: "currency-test" }),
}));
vi.mock("@/services/api/client", () => ({
  bookingEngine: { get: async () => ({ base: "EUR", rates: { EUR: 1, USD: 1.1, JPY: 160 } }) },
}));
it("preserves cents across combined rooms, a booking add-on, and currency conversion", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  const container = document.createElement("div");
  const root = createRoot(container);
  let currency: ReturnType<typeof useCurrency>;
  function Probe() {
    currency = useCurrency();
    return null;
  }
  try {
    await act(async () => root.render(createElement(CurrencyProvider, null, createElement(Probe))));
    expect(currency!.convertAndRound(610.25, "EUR")).toBe(610.25);
    expect(currency!.formatPrice(610.25, "EUR")).toBe("€610.25");
    expect(currency!.formatPrice(600, "EUR")).toBe("€600");
    act(() => currency!.setSelectedCurrency("USD"));
    expect(currency!.convertAndRound(610.25, "EUR")).toBe(671.28);
    expect(currency!.formatPrice(610.25, "EUR")).toContain("671.28");
    act(() => currency!.setSelectedCurrency("JPY"));
    expect(currency!.convertAndRound(10.253, "EUR")).toBe(1640);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
