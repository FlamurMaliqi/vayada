import { describe, expect, it } from "vitest";

import { createStripeBookingPaymentProvider } from "./stripeBookingPayments.js";

describe("Stripe booking payments", () => {
  it("creates a connected-account PaymentIntent with stable metadata", async () => {
    const calls: Array<{ url: string; body: string; key: string | null; account: string | null }> =
      [];
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          body: String(init?.body),
          key: headers.get("Idempotency-Key"),
          account: headers.get("Stripe-Account"),
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
        captureMethod: "automatic",
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
      account: "acct_1",
    });
    expect(new URLSearchParams(calls[0]!.body).has("transfer_data[destination]")).toBe(false);
    expect(new URLSearchParams(calls[0]!.body).get("payment_method_types[0]")).toBe("card");
    expect(new URLSearchParams(calls[0]!.body).get("capture_method")).toBe("automatic");
    expect(new URLSearchParams(calls[0]!.body).get("application_fee_amount")).toBe("303");
    expect(new URLSearchParams(calls[0]!.body).has("automatic_payment_methods[enabled]")).toBe(
      false,
    );

    await provider.capturePaymentIntent("pi_booking_1", "acct_1", "capture-booking-payment-1");
    expect(calls[1]).toMatchObject({
      url: "https://api.stripe.com/v1/payment_intents/pi_booking_1/capture",
      key: "capture-booking-payment-1",
      account: "acct_1",
    });
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
        captureMethod: "automatic",
        idempotencyKey: "booking-payment-1",
      }),
    ).rejects.toThrow("different property booking");
  });

  it("retrieves safe card display details from the PaymentIntent", async () => {
    let requestedUrl = "";
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            id: "pi_booking_1",
            client_secret: "pi_booking_1_secret_test",
            status: "succeeded",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-001",
            },
            latest_charge: {
              id: "ch_booking_1",
              balance_transaction: {
                id: "txn_booking_1",
                amount: 6050,
                fee: 478,
                net: 5572,
                currency: "eur",
                fee_details: [
                  { type: "stripe_fee", amount: 175, currency: "eur" },
                  { type: "application_fee", amount: 303, currency: "eur" },
                ],
              },
            },
            payment_method: { card: { brand: "visa", last4: "4242" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(provider.retrievePaymentIntent("pi_booking_1", "acct_1")).resolves.toMatchObject({
      cardBrand: "visa",
      cardLast4: "4242",
      providerAccountRef: "acct_1",
      feeBreakdown: {
        processorFeeAmountMinor: 175,
        applicationFeeAmountMinor: 303,
        netPayoutAmountMinor: 5572,
      },
    });
    expect(new URL(requestedUrl).searchParams.get("expand[]")).toBe("payment_method");
  });

  it("creates request-mode PaymentIntents with manual capture", async () => {
    let body = "";
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return new Response(
          JSON.stringify({
            id: "pi_request_1",
            client_secret: "pi_request_1_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-REQUEST-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await provider.createPaymentIntent({
      propertyId: "property-1",
      bookingReference: "B-REQUEST-1",
      providerAccountRef: "acct_1",
      amountMinor: 6050,
      applicationFeeAmountMinor: 303,
      currency: "EUR",
      captureMethod: "manual",
      idempotencyKey: "booking-request-payment-1",
    });

    expect(new URLSearchParams(body).get("capture_method")).toBe("manual");
  });

  it("omits Vayada commission from fixed-plan direct charges", async () => {
    let body = "";
    const provider = createStripeBookingPaymentProvider({
      secretKey: "sk_test",
      fetch: async (_input, init) => {
        body = String(init?.body);
        return new Response(
          JSON.stringify({
            id: "pi_fixed_1",
            client_secret: "pi_fixed_1_secret_test",
            status: "requires_payment_method",
            amount: 6050,
            currency: "eur",
            metadata: {
              vayada_property_id: "property-1",
              vayada_booking_reference: "B-FIXED-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await provider.createPaymentIntent({
      propertyId: "property-1",
      bookingReference: "B-FIXED-1",
      providerAccountRef: "acct_1",
      amountMinor: 6050,
      applicationFeeAmountMinor: 0,
      currency: "EUR",
      captureMethod: "automatic",
      idempotencyKey: "booking-fixed-payment-1",
    });

    expect(new URLSearchParams(body).has("application_fee_amount")).toBe(false);
  });
});
