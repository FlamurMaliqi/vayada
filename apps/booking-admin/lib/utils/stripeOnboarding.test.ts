import { describe, expect, it, vi } from "vitest";

import { continueStripeAfterSavingSettings } from "./stripeOnboarding";

describe("Stripe account creation", () => {
  it("creates the account for the exact property only after settings persist", async () => {
    const order: string[] = [];
    const continueStripe = vi.fn(async (propertyId: string) => {
      order.push(`create:${propertyId}`);
      return { providerAccountId: "provider-account-1" };
    });

    await expect(
      continueStripeAfterSavingSettings({
        saveSettings: async () => {
          order.push("save");
          return "property-1";
        },
        continueStripe,
      }),
    ).resolves.toEqual({ providerAccountId: "provider-account-1" });

    expect(order).toEqual(["save", "create:property-1"]);
  });

  it("does not request an onboarding link when settings persistence fails", async () => {
    const continueStripe = vi.fn();

    await expect(
      continueStripeAfterSavingSettings({
        saveSettings: async () => null,
        continueStripe,
      }),
    ).resolves.toBeNull();

    expect(continueStripe).not.toHaveBeenCalled();
  });
});
