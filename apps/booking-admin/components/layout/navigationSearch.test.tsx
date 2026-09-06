import { beforeEach, expect, it, vi } from "vitest";
import { loadSearchAccess, matchesSearch, SEARCH_ENTRIES } from "./navigationSearchEntries";

const reads = vi.hoisted(() => ({
  settings: vi.fn(),
  design: vi.fn(),
  dashboard: vi.fn(),
  modules: vi.fn(),
  payments: vi.fn(),
  billing: vi.fn(),
}));
vi.mock("@/services/settings", () => ({
  settingsService: { getPropertySettings: reads.settings, getDesignSettings: reads.design },
}));
vi.mock("@/services/dashboard", () => ({ dashboardService: { getStats: reads.dashboard } }));
vi.mock("@/services/api/moduleActivationClient", () => ({
  moduleActivationClient: { list: reads.modules },
}));
vi.mock("@/services/api/bookingPropertyLinkClient", () => ({
  getBookingHotelPropertyLink: async () => ({ propertyId: "property-1" }),
}));
vi.mock("@/services/api/financePaymentSettingsClient", () => ({
  getFinancePaymentSettings: reads.payments,
}));
vi.mock("@/services/api/financeSubscriptionsClient", () => ({
  getFinancePlanStatus: reads.billing,
}));

beforeEach(() => {
  for (const read of Object.values(reads)) read.mockReset().mockResolvedValue({});
  reads.modules.mockResolvedValue({ activations: [{ moduleId: "affiliates", isActive: true }] });
});

it("matches partial labels, case, accents and one mistyped character", () => {
  for (const query of [" dom ", "DOMAIN", "domai", "dommain", "domein"])
    expect(matchesSearch(query, "Domain Settings")).toBe(true);
  expect(matchesSearch("hot", "Hôtel")).toBe(true);
  expect(matchesSearch("zzzz", "Domain Settings")).toBe(false);
  expect(matchesSearch("ab", "Dashboard")).toBe(false);
});

it("hides inaccessible destinations independently and fails closed on read errors", async () => {
  reads.settings.mockRejectedValue({ status: 403 });
  reads.payments.mockRejectedValue({ status: 403 });
  reads.billing.mockRejectedValue(new Error("Network unavailable"));
  const access = await loadSearchAccess("hotel-1");
  const visible = SEARCH_ENTRIES.filter((entry) => access.has(entry[3]));
  expect(visible.some((entry) => entry[0] === "Dashboard")).toBe(true);
  expect(visible.some((entry) => entry[0] === "Domain Settings")).toBe(true);
  expect(visible.some((entry) => entry[1].startsWith("/settings?"))).toBe(false);
  expect(reads.settings).toHaveBeenCalledWith("hotel-1");
  expect(reads.payments).toHaveBeenCalledWith({ propertyId: "property-1" });
});

it("does not offer retired affiliate management even when activated", async () => {
  expect((await loadSearchAccess("hotel-1")).has("affiliates")).toBe(false);
  expect(SEARCH_ENTRIES.map((entry) => entry[1])).not.toContain("/affiliates");
});
