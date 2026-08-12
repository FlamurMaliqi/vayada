import { describe, expect, it } from "vitest";

import { createStripeFinanceSubscriptionProvider } from "./stripeFinanceSubscriptions.js";

describe("Stripe fixed-plan provider", () => {
  it("creates one exact 30-day graduated EUR price and a hosted subscription checkout", async () => {
    const calls: Array<{ url: string; body: string; headers: unknown }> = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? ""), headers: init?.headers ?? {} });
        if (url.includes("/prices?")) return response({ data: [] });
        if (url.endsWith("/prices")) return response({ id: "price_fixed_30d" });
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
    expect(price.get("recurring[interval]")).toBe("day");
    expect(price.get("recurring[interval_count]")).toBe("30");
    expect(price.get("billing_scheme")).toBe("tiered");
    expect(price.get("tiers[0][unit_amount]")).toBe("3000");
    expect(price.get("tiers[1][unit_amount]")).toBe("500");

    const checkout = new URLSearchParams(calls[2].body);
    expect(checkout.get("mode")).toBe("subscription");
    expect(checkout.get("line_items[0][price]")).toBe("price_fixed_30d");
    expect(checkout.get("line_items[0][quantity]")).toBe("4");
    expect(checkout.get("subscription_data[proration_behavior]")).toBe("none");
  });

  it("updates room quantity without proration and reads item-level periods", async () => {
    const calls: string[] = [];
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_30d",
      fetch: async (_input, init) => {
        calls.push(String(init?.body ?? ""));
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

  it("does not verify a subscription with mismatched Fixed Plan terms", async () => {
    const provider = createStripeFinanceSubscriptionProvider({
      secretKey: "sk_test_secret",
      fixedPlanPriceId: "price_fixed_30d",
      fetch: async () =>
        response({
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
                  recurring: { interval: "month", interval_count: 1 },
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
});

function fixedPrice() {
  return {
    id: "price_fixed_30d",
    currency: "eur",
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    lookup_key: "vayada_fixed_eur_30d_v1",
    metadata: { vayada_plan: "fixed" },
    recurring: { interval: "day", interval_count: 30 },
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
