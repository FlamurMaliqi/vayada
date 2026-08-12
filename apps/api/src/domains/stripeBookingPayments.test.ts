import { describe, expect, it } from "vitest";

import { createStripeBookingPaymentProvider } from "./stripeBookingPayments.js";

describe("Stripe booking payments", () => {
  it("creates a connected-account PaymentIntent with stable metadata", async () => {
    const calls: Array<{ url: string; body: string; key: string | null }> = [];
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          body: String(init?.body),
          key: headers.get("Idempotency-Key"),
        });
        return new Response(
          JSON.stringify({
            id: "pi_booking_1",
            client_secret: "pi_booking_1_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-001",
            },
            transfer_data: { destination: "acct_1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      provider.createPaymentIntent({
        propertyId: "property-1",
        bookingReference: "B-001",
        providerAccountRef: "acct_1",
        amountMinor: 6050,
        applicationFeeAmountMinor: 303,
        currency: "EUR",
        idempotencyKey: "booking-payment-1",
      }),
    ).resolves.toMatchObject({
      paymentIntentId: "pi_booking_1",
      amountMinor: 6050,
      currency: "EUR",
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.stripe.com/v1/payment_intents",
      key: "booking-payment-1",
    });
    expect(new URLSearchParams(calls[0]!.body).get("transfer_data[destination]")).toBe("acct_1");
    expect(new URLSearchParams(calls[0]!.body).get("payment_method_types[0]")).toBe("card");
    expect(new URLSearchParams(calls[0]!.body).get("application_fee_amount")).toBe("303");
    expect(new URLSearchParams(calls[0]!.body).has("automatic_payment_methods[enabled]")).toBe(
      false,
    );
  });

  it("rejects a provider replay bound to another property", async () => {
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "pi_wrong_property",
            client_secret: "pi_wrong_property_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-2",
              vayada_booking_reference: "B-001",
            },
            transfer_data: { destination: "acct_2" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(
      provider.createPaymentIntent({
        propertyId: "property-1",
        bookingReference: "B-001",
        providerAccountRef: "acct_1",
        amountMinor: 6050,
        applicationFeeAmountMinor: 303,
        currency: "EUR",
        idempotencyKey: "booking-payment-1",
      }),
    ).rejects.toThrow("different property booking");
  });
});
