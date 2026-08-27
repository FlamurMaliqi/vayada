import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadStripe } = vi.hoisted(() => ({ loadStripe: vi.fn(() => Promise.resolve(null)) }));

vi.mock("@stripe/stripe-js", () => ({ loadStripe }));

import stripeForAccount from "./stripe";

describe("Stripe.js account scope", () => {
  beforeEach(() => loadStripe.mockClear());

  it("loads and caches Stripe.js for the connected account", () => {
    const first = stripeForAccount("acct_property_1288");
    const second = stripeForAccount("acct_property_1288");

    expect(first).toBe(second);
    expect(loadStripe).toHaveBeenCalledTimes(1);
    expect(loadStripe).toHaveBeenCalledWith(expect.any(String), {
      stripeAccount: "acct_property_1288",
    });
  });
});
