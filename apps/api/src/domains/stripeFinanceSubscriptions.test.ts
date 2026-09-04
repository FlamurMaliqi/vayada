import { describe, expect, it } from "vitest";

import { createStripeFinanceSubscriptionProvider } from "./stripeFinanceSubscriptions.js";

describe("Stripe fixed-plan provider", () => {
  it("creates one exact monthly graduated EUR price and a hosted subscription checkout", async () => {
    const calls: Array<{ url: string; body: string; headers: unknown }> = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? ""), headers: init?.headers ?? {} });
        if (url.includes("/prices?")) return response({ data: [] });
        if (url.endsWith("/prices")) return response({ id: "price_fixed_30d" });
        if (url.includes("/prices/price_fixed_30d")) return response(fixedPrice());
        return response({ id: "cs_test_fixed", url: "https://checkout.stripe.test/fixed" });
      },
    });

    await expect(
      provider.createFixedPlanCheckout({
        propertyId: "property-1",
        organizationId: "organization-1",
        customerEmail: "host@example.com",
        existingCustomerId: null,
        activeRoomCount: 4,
        currency: "EUR",
        billingCycleAnchor: "2026-09-01T00:00:00.000Z",
        successUrl: "https://admin.booking.test/settings?billing=success",
        cancelUrl: "https://admin.booking.test/settings?billing=canceled",
        idempotencyKey: "checkout-1",
      }),
    ).resolves.toEqual({
      checkoutSessionId: "cs_test_fixed",
      checkoutUrl: "https://checkout.stripe.test/fixed",
    });

    const price = new URLSearchParams(calls[1].body);
    expect(price.get("currency")).toBe("eur");
    expect(price.get("recurring[interval]")).toBe("month");
    expect(price.get("recurring[interval_count]")).toBe("1");
    expect(price.get("billing_scheme")).toBe("tiered");
    expect(price.get("tiers[0][unit_amount]")).toBe("3000");
    expect(price.get("tiers[1][unit_amount]")).toBe("500");
    expect([...price.keys()].filter((key) => key.startsWith("product_data["))).toEqual([
      "product_data[name]",
    ]);

    expect(calls[2].url).toContain("/prices/price_fixed_30d?expand%5B%5D=tiers");
    const checkout = new URLSearchParams(calls[3].body);
    expect(checkout.get("mode")).toBe("subscription");
    expect(checkout.get("line_items[0][price]")).toBe("price_fixed_30d");
    expect(checkout.get("line_items[0][quantity]")).toBe("4");
    expect(checkout.get("subscription_data[proration_behavior]")).toBe("create_prorations");
    expect(checkout.get("subscription_data[billing_cycle_anchor]")).toBe(
      String(Date.parse("2026-09-01T00:00:00.000Z") / 1_000),
    );
  });

  it("updates room quantity without proration and reads item-level periods", async () => {
    const calls: string[] = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_30d",
      fetch: async (input, init) => {
        calls.push(String(init?.body ?? ""));
        if (String(input).includes("/prices/price_fixed_30d")) return response(fixedPrice());
        return response({
          id: "sub_fixed",
          customer: "cus_fixed",
          status: "active",
          metadata: {
            vayada_plan: "fixed",
            vayada_property_id: "property-1",
            vayada_organization_id: "organization-1",
          },
          cancel_at_period_end: false,
          items: {
            data: [
              {
                id: "si_fixed",
                price: fixedPrice(),
                current_period_start: 1_786_449_600,
                current_period_end: 1_789_041_600,
              },
            ],
          },
        });
      },
    });

    const snapshot = await provider.updateRoomQuantity({
      subscriptionId: "sub_fixed",
      subscriptionItemId: "si_fixed",
      activeRoomCount: 7,
      idempotencyKey: "rooms-7",
    });
    const body = new URLSearchParams(calls[0]);
    expect(body.get("items[0][quantity]")).toBe("7");
    expect(body.get("proration_behavior")).toBe("none");
    expect(snapshot).toMatchObject({
      subscriptionId: "sub_fixed",
      subscriptionItemId: "si_fixed",
      propertyId: "property-1",
      organizationId: "organization-1",
      fixedPlanVerified: true,
      currentPeriodStart: "2026-08-11T12:00:00.000Z",
      currentPeriodEnd: "2026-09-10T12:00:00.000Z",
    });
  });

  it("expires a superseded hosted checkout", async () => {
    const calls: Array<{ url: string; method: string; idempotencyKey: string | null }> = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_30d",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          method: String(init?.method),
          idempotencyKey: headers.get("Idempotency-Key"),
        });
        return response({ id: "cs_old", status: "expired" });
      },
    });

    await provider.expireFixedPlanCheckout({
      checkoutSessionId: "cs_old",
      idempotencyKey: "expire-cs-old",
    });

    expect(calls).toEqual([
      {
        url: "https://api.stripe.com/v1/checkout/sessions/cs_old/expire",
        method: "POST",
        idempotencyKey: "expire-cs-old",
      },
    ]);
  });

  it("cancels immediately with a prorated final invoice", async () => {
    const calls: Array<{ method: string; url: string; body: string }> = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_30d",
      fetch: async (input, init) => {
        calls.push({
          method: String(init?.method),
          url: String(input),
          body: String(init?.body ?? ""),
        });
        if (String(input).includes("/prices/")) return response(fixedPrice());
        return response(subscription());
      },
    });

    await expect(
      provider.cancelImmediately({ subscriptionId: "sub_fixed", idempotencyKey: "cancel-now" }),
    ).resolves.toMatchObject({ status: "canceled", fixedPlanVerified: true });
    const cancellation = calls[0]!;
    expect(cancellation.method).toBe("DELETE");
    expect(cancellation.body).toContain("invoice_now=true");
    expect(cancellation.body).toContain("prorate=true");
  });

  it("accepts a legacy 30-day snapshot when canceling an existing subscription", async () => {
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_legacy",
      fetch: async () =>
        response({
          ...subscription(),
          status: "canceled",
          items: {
            data: [
              {
                ...subscription().items.data[0],
                price: {
                  ...fixedPrice(),
                  id: "price_fixed_legacy",
                  lookup_key: "vayada_fixed_eur_30d_v1",
                  recurring: { interval: "day", interval_count: 30 },
                },
              },
            ],
          },
        }),
    });

    await expect(
      provider.cancelImmediately({ subscriptionId: "sub_legacy", idempotencyKey: "cancel-legacy" }),
    ).resolves.toMatchObject({ fixedPlanVerified: true, status: "canceled" });
  });

  it("starts a bank-transfer Fixed Plan with an emailed net-14 invoice", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_30d",
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body ?? "") });
        return String(input).includes("/prices/")
          ? response(fixedPrice())
          : response({ ...subscription(), status: "active" });
      },
    });

    await expect(
      provider.createFixedPlanInvoiceSubscription({
        propertyId: "property-1",
        organizationId: "organization-1",
        customerId: "cus_fixed",
        activeRoomCount: 7,
        currency: "EUR",
        billingCycleAnchor: "2026-09-01T00:00:00.000Z",
        idempotencyKey: "bank-fixed",
      }),
    ).resolves.toMatchObject({ status: "active", fixedPlanVerified: true });
    const request = new URLSearchParams(calls[1]!.body);
    expect(request.get("collection_method")).toBe("send_invoice");
    expect(request.get("days_until_due")).toBe("14");
    expect(request.get("proration_behavior")).toBe("create_prorations");
    expect(request.get("billing_cycle_anchor")).toBe(
      String(Date.parse("2026-09-01T00:00:00.000Z") / 1_000),
    );
    expect(request.get("items[0][quantity]")).toBe("7");
  });

  it("maps provider invoices to the public billing contract", async () => {
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fetch: async () =>
        response({
          data: [
            {
              id: "in_123",
              number: "ACME-42",
              created: 1_788_566_400,
              amount_due: 6_000,
              currency: "idr",
              status: "paid",
              invoice_pdf: "https://pay.stripe.test/in_123.pdf",
            },
          ],
        }),
    });

    await expect(provider.listInvoices("cus_fixed")).resolves.toEqual([
      expect.objectContaining({
        id: "in_123",
        number: "INV-2026-0042",
        amountMinor: 6_000,
        currency: "IDR",
        status: "paid",
        pdfUrl: "https://pay.stripe.test/in_123.pdf",
      }),
    ]);
  });

  it("maps a failed automatic payment and uses the paid charge date when available", async () => {
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fetch: async () =>
        response({
          data: [
            {
              id: "in_failed",
              number: "ACME-43",
              created: 1_788_566_400,
              amount_due: 6_000,
              currency: "usd",
              status: "open",
              attempt_count: 1,
            },
            {
              id: "in_paid",
              number: "ACME-44",
              created: 1_788_566_400,
              amount_paid: 6_000,
              currency: "usd",
              status: "paid",
              status_transitions: { paid_at: 1_788_652_800 },
            },
          ],
        }),
    });

    const invoices = await provider.listInvoices("cus_fixed");
    expect(invoices.find(({ id }) => id === "in_failed")?.status).toBe("failed");
    expect(invoices.find(({ id }) => id === "in_paid")?.issuedAt).toBe(
      new Date(1_788_652_800_000).toISOString(),
    );
  });

  it("updates Stripe customer invoice identity without exposing provider fields", async () => {
    let body = "";
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fetch: async (_input, init) => {
        body = String(init?.body ?? "");
        return response({ id: "cus_fixed" });
      },
    });

    await provider.upsertCustomer({
      customerId: "cus_fixed",
      propertyId: "property-1",
      organizationId: "organization-1",
      billingDetails: {
        companyName: "Alpenrose Hospitality Ltd.",
        billingEmail: "billing@example.test",
        taxId: "EU123",
      },
      idempotencyKey: "billing-details",
    });
    const fields = new URLSearchParams(body);
    expect(fields.get("name")).toBe("Alpenrose Hospitality Ltd.");
    expect(fields.get("email")).toBe("billing@example.test");
    expect(fields.get("invoice_settings[custom_fields][0][value]")).toBe("EU123");
  });

  it.each([
    ["USD", 3_000, 500],
    ["IDR", 50_000_000, 8_000_000],
  ])("verifies %s subscriptions against the localized catalog", async (currency, base, extra) => {
    const price = {
      ...fixedPrice(),
      id: `price_fixed_${currency.toLowerCase()}`,
      currency: currency.toLowerCase(),
      lookup_key: `vayada_fixed_${currency.toLowerCase()}_monthly_v2`,
      tiers: [
        { up_to: 1, unit_amount: base },
        { up_to: null, unit_amount: extra },
      ],
    };
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/subscriptions/")) {
          return response({
            ...subscription(),
            status: "active",
            items: { data: [{ ...subscription().items.data[0], price }] },
          });
        }
        if (url.includes("/prices?")) return response({ data: [{ id: price.id }] });
        return response(price);
      },
    });

    await expect(
      provider.retrieveSubscription(`sub_${currency.toLowerCase()}`),
    ).resolves.toMatchObject({ fixedPlanVerified: true, currency });
  });

  it("does not verify a subscription with mismatched Fixed Plan terms", async () => {
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_30d",
      fetch: async (input) =>
        String(input).includes("/prices/price_fixed_30d")
          ? response(fixedPrice())
          : response({
              id: "sub_wrong",
              customer: "cus_fixed",
              status: "active",
              metadata: {
                vayada_plan: "fixed",
                vayada_property_id: "property-1",
                vayada_organization_id: "organization-1",
              },
              items: {
                data: [
                  {
                    id: "si_wrong",
                    price: {
                      ...fixedPrice(),
                      recurring: { interval: "day", interval_count: 30 },
                    },
                  },
                ],
              },
            }),
    });

    await expect(provider.retrieveSubscription("sub_wrong")).resolves.toMatchObject({
      fixedPlanVerified: false,
    });
  });

  it("rejects a configured Price with mismatched terms before creating Checkout", async () => {
    const calls: string[] = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_wrong",
      fetch: async (input) => {
        calls.push(String(input));
        return response({ ...fixedPrice(), id: "price_wrong", currency: "usd" });
      },
    });

    await expect(provider.createFixedPlanCheckout(checkoutInput())).rejects.toThrow(
      "does not match the canonical Vayada billing terms",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/prices/price_wrong");
  });

  it("rejects a lookup-key Price with mismatched tiers before creating Checkout", async () => {
    const calls: string[] = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fetch: async (input) => {
        calls.push(String(input));
        return String(input).includes("/prices?")
          ? response({ data: [{ id: "price_fixed_30d" }] })
          : response({
              ...fixedPrice(),
              tiers: [
                { up_to: 1, unit_amount: 9_999 },
                { up_to: null, unit_amount: 500 },
              ],
            });
      },
    });

    await expect(provider.createFixedPlanCheckout(checkoutInput())).rejects.toThrow(
      "does not match the canonical Vayada billing terms",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("/prices/price_fixed_30d?expand%5B%5D=tiers");
  });
});

function fixedPrice() {
  return {
    id: "price_fixed_30d",
    currency: "eur",
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    lookup_key: "vayada_fixed_eur_monthly_v2",
    metadata: { vayada_plan: "fixed" },
    recurring: { interval: "month", interval_count: 1 },
    tiers: [
      { up_to: 1, unit_amount: 3_000 },
      { up_to: null, unit_amount: 500 },
    ],
  };
}

function subscription() {
  return {
    id: "sub_fixed",
    customer: "cus_fixed",
    status: "canceled",
    metadata: {
      vayada_plan: "fixed",
      vayada_property_id: "property-1",
      vayada_organization_id: "organization-1",
    },
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_fixed",
          price: fixedPrice(),
          current_period_start: 1_786_449_600,
          current_period_end: 1_789_041_600,
        },
      ],
    },
  };
}

function checkoutInput() {
  return {
    propertyId: "property-1",
    organizationId: "organization-1",
    customerEmail: "host@example.com",
    existingCustomerId: null,
    activeRoomCount: 4,
    currency: "EUR",
    billingCycleAnchor: "2026-09-01T00:00:00.000Z",
    successUrl: "https://admin.booking.test/settings?billing=success",
    cancelUrl: "https://admin.booking.test/settings?billing=canceled",
    idempotencyKey: "checkout-1",
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
