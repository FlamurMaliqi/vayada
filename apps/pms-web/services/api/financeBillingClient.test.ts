import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
const resolveProperty = vi.hoisted(() => vi.fn(async () => "property-1"));

vi.mock("./pmsOperationsClient", () => ({
  pmsOperationsClient: api,
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));
vi.mock("./pmsPropertyClient", () => ({ resolveSelectedPmsPropertyId: resolveProperty }));

describe("financeBillingClient", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.patch.mockReset();
    resolveProperty.mockClear();
  });

  it("uses canonical property-scoped Finance billing routes", async () => {
    const billing = { propertyId: "property-1", paymentMethod: "card" };
    api.get.mockResolvedValue(billing);
    api.patch.mockResolvedValue({ ...billing, paymentMethod: "bank_transfer" });
    api.post.mockResolvedValue({ ...billing, paymentMethod: "bank_transfer" });
    const client = await import("./financeBillingClient");

    await expect(client.getFinanceBilling()).resolves.toBe(billing);
    await client.savePaymentMethod("bank_transfer");
    await client.activateFixedPlanByInvoice();
    await client.activateFixedPlanByCard();

    expect(api.get).toHaveBeenCalledWith(
      "/api/finance/properties/property-1/billing",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(api.patch).toHaveBeenCalledWith(
      "/api/finance/properties/property-1/payment-method",
      expect.objectContaining({ paymentMethod: "bank_transfer" }),
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(api.post.mock.calls.map(([url]) => url)).toEqual([
      "/api/finance/properties/property-1/fixed-plan/invoice",
      "/api/finance/properties/property-1/fixed-plan/card",
    ]);
  });

  it("pins hosted Stripe returns to the PMS surface", async () => {
    api.post
      .mockResolvedValueOnce({ checkout: { checkoutUrl: "https://checkout.stripe.test/fixed" } })
      .mockResolvedValueOnce({ customerPortal: { portalUrl: "https://billing.stripe.test" } });
    const client = await import("./financeBillingClient");

    await expect(client.startFixedPlanCheckout()).resolves.toContain("checkout.stripe.test");
    await expect(client.openBillingPortal()).resolves.toContain("billing.stripe.test");
    expect(api.post.mock.calls.map(([, body]) => body)).toEqual([
      expect.objectContaining({ returnSurface: "pms" }),
      expect.objectContaining({ returnSurface: "pms" }),
    ]);
  });
});
