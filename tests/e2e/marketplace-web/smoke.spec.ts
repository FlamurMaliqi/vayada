import { expect, test } from "@playwright/test";

test.describe("marketplace-web smoke", () => {
  test("login page redirects to hosted auth", async ({ request }) => {
    const response = await request.get("/login", { maxRedirects: 0 });

    expect(response.status()).toBe(307);

    const hostedLoginUrl = new URL(response.headers().location ?? "");
    expect(hostedLoginUrl.pathname).toBe("/auth/workos/login");
    expect(hostedLoginUrl.searchParams.get("surface")).toBe("marketplace-web");

    const returnTo = new URL(hostedLoginUrl.searchParams.get("return_to") ?? "");
    expect(returnTo.pathname).toBe("/login");
    expect(returnTo.searchParams.get("auth")).toBe("callback");
    expect(returnTo.searchParams.get("returnTo")).toBe("/marketplace");
  });

  test("login callback renders locally", async ({ request }) => {
    const response = await request.get("/login?auth=callback", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
  });

  for (const intent of ["creator", "hotel"] as const) {
    test(`@signup ${intent} signup redirects to hosted AuthKit`, async ({ request }) => {
      const response = await request.get(`/signup?type=${intent}`, { maxRedirects: 0 });

      expect(response.status()).toBe(307);
      const hostedSignupUrl = new URL(response.headers().location ?? "");
      expect(hostedSignupUrl.pathname).toBe("/auth/workos/signup");
      expect(hostedSignupUrl.searchParams.get("surface")).toBe("marketplace-web");
      expect(hostedSignupUrl.searchParams.get("intent")).toBe(intent);
      expect(hostedSignupUrl.pathname).not.toBe("/auth/register");
      expect(hostedSignupUrl.pathname).not.toBe("/auth/login");

      const returnTo = new URL(hostedSignupUrl.searchParams.get("return_to") ?? "");
      expect(returnTo.pathname).toBe("/login");
      expect(returnTo.searchParams.get("auth")).toBe("callback");
      expect(returnTo.searchParams.get("returnTo")).toBe("/marketplace");
    });
  }
});
