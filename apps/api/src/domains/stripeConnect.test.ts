import { describe, expect, it } from "vitest";

import { createStripeConnectProvider } from "./stripeConnect.js";

describe("Stripe Connect provider", () => {
  it("creates an Express account and issues a Marketplace onboarding link", async () => {
    const calls: Array<{ url: string; body: URLSearchParams; key: string | null }> = [];
    const provider = createStripeConnectProvider({
      secretKey: "sk_test",
      returnBaseUrls: {
        marketplace: "https://marketplace.test",
        bookingAdmin: "https://admin.booking.test",
      },
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          body: new URLSearchParams(String(init?.body ?? "")),
          key: new Headers(init?.headers).get("Idempotency-Key"),
        });
        const url = String(input);
        return new Response(
          JSON.stringify(
            url.endsWith("/accounts")
              ? { id: "acct_property_1" }
              : url.includes("/accounts/acct_property_1")
                ? {
                    id: "acct_property_1",
                    charges_enabled: true,
                    payouts_enabled: true,
                    details_submitted: true,
                    default_currency: "eur",
                    capabilities: { card_payments: "active" },
                  }
                : { url: "https://connect.stripe.test/setup/acct_property_1" },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      provider.createAccount({
        owner: { ownerScope: "property", propertyId: "property-1", organizationId: "org-1" },
        email: "owner@example.test",
        country: "DE",
        idempotencyKey: "connect-property-1",
      }),
    ).resolves.toEqual({
      providerAccountRef: "acct_property_1",
      onboardingUrl: "https://connect.stripe.test/setup/acct_property_1",
    });
    expect(calls[0]?.body.get("type")).toBe("express");
    expect(calls[0]?.body.get("capabilities[card_payments][requested]")).toBe("true");
    expect(calls[1]?.body.get("return_url")).toBe("https://marketplace.test/setup?stripe=return");

    await provider.createOnboardingLink({
      owner: { ownerScope: "property", propertyId: "property-1", organizationId: "org-1" },
      providerAccountRef: "acct_property_1",
      idempotencyKey: "connect-property-1-admin",
      returnSurface: "booking_admin",
    });
    expect(calls[2]?.body.get("return_url")).toBe(
      "https://admin.booking.test/settings?stripe=return",
    );

    await expect(
      provider.retrieveAccount({ providerAccountRef: "acct_property_1" }),
    ).resolves.toEqual({
      providerAccountRef: "acct_property_1",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      cardPaymentsStatus: "active",
      defaultCurrency: "eur",
    });
  });
});
