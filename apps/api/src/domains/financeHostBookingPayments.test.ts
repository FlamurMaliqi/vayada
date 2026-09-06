import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createFinanceHostBookingPayments } from "./financeHostBookingPayments.js";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";

function fixture(status = "requires_capture") {
  const payment = {
    id: "payment",
    status: "authorized",
    method: "card",
    intentId: "pi_test",
    accountRef: "acct_test",
    chargeType: "direct",
    amount: "100.00",
    currency: "EUR",
    reference: "VAY-TEST",
  };
  const intent = {
    paymentIntentId: "pi_test",
    clientSecret: null,
    status,
    propertyId: "property",
    bookingReference: "VAY-TEST",
    providerAccountRef: "acct_test",
    amountMinor: 10000,
    currency: "EUR",
  };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("SELECT payment") ? [payment] : [],
    rowCount: 1,
  }));
  const provider = {
    retrievePaymentIntent: vi.fn(async () => ({ ...intent })),
    cancelPaymentIntent: vi.fn(async () => ({ ...intent, status: "canceled" })),
  };
  const input = {
    propertyId: "property",
    bookingId: "booking",
    action: "reject",
    apply: true,
    authorized: true,
    occurredAt: new Date("2026-09-06T10:00:00Z"),
  };
  return {
    payment,
    intent,
    query,
    provider,
    input,
    run: createFinanceHostBookingPayments(provider as unknown as StripeBookingPaymentProvider),
    client: { query } as unknown as PoolClient,
  };
}
describe("Finance host-request rejection", () => {
  it("previews an authorization void without calling the provider", async () => {
    const f = fixture();
    expect(await f.run(f.client, { ...f.input, apply: false })).toBe("authorization_void");
    expect(f.provider.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(f.provider.cancelPaymentIntent).not.toHaveBeenCalled();
  });
  it("uses a stable scoped void key and records the verified canceled state", async () => {
    const f = fixture();
    await f.run(f.client, f.input);
    expect(f.provider.cancelPaymentIntent).toHaveBeenCalledWith(
      "pi_test",
      "acct_test",
      "booking-host-reject:property:booking:v1",
    );
    expect(f.query.mock.calls.some(([sql]) => sql.includes("UPDATE finance.payments"))).toBe(true);
  });
  it("reconciles a lost cancellation response and retries an already canceled intent", async () => {
    const f = fixture();
    f.provider.cancelPaymentIntent.mockRejectedValueOnce(new Error("response lost"));
    f.provider.retrievePaymentIntent
      .mockResolvedValueOnce(f.intent)
      .mockResolvedValueOnce({ ...f.intent, status: "canceled" });
    await expect(f.run(f.client, f.input)).resolves.toBe("authorization_void");
    const replay = fixture("canceled");
    await expect(replay.run(replay.client, replay.input)).resolves.toBe("authorization_void");
    expect(replay.provider.cancelPaymentIntent).not.toHaveBeenCalled();
  });
  it.each(["succeeded", "processing", "requires_action"])(
    "does not record cancellation for %s",
    async (status) => {
      const f = fixture(status);
      await expect(f.run(f.client, f.input)).rejects.toMatchObject({
        code: "payment_adjustment_required",
      });
      expect(f.query.mock.calls.some(([sql]) => sql.includes("UPDATE finance.payments"))).toBe(
        false,
      );
      expect(f.provider.cancelPaymentIntent).not.toHaveBeenCalled();
    },
  );
  it.each(["propertyId", "bookingReference", "providerAccountRef", "currency"] as const)(
    "checks the provider %s binding",
    async (field) => {
      const f = fixture();
      f.intent[field] = "wrong";
      await expect(f.run(f.client, f.input)).rejects.toMatchObject({
        code: "payment_adjustment_required",
      });
      expect(f.provider.cancelPaymentIntent).not.toHaveBeenCalled();
    },
  );
  it("fails closed if the provider cannot confirm cancellation", async () => {
    const f = fixture();
    f.provider.cancelPaymentIntent.mockRejectedValueOnce(new Error("offline"));
    await expect(f.run(f.client, f.input)).rejects.toMatchObject({
      code: "payment_adjustment_required",
    });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("UPDATE finance.payments"))).toBe(false);
  });
});
