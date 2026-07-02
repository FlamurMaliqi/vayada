import { expect, test } from "@playwright/test";

test.describe("booking-admin smoke", () => {
  test("login page redirects to AuthKit", async ({ page, baseURL }) => {
    const response = await page.request.get("/login");
    const html = await response.text();
    expect(html).toContain("Booking Engine");
    expect(html).not.toContain("Email address");
    expect(html).not.toContain("Continue with WorkOS");
    expect(html).not.toContain("Use legacy password fallback");

    const loginRequests: string[] = [];
    await page.route("**/auth/workos/login**", (route) => {
      loginRequests.push(route.request().url());
      return route.fulfill({ status: 204, body: "" });
    });

    await page.goto("/login");
    await expect.poll(() => loginRequests.length).toBe(1);

    const loginUrl = new URL(loginRequests[0]!);
    expect(loginUrl.searchParams.get("surface")).toBe("booking-admin");
    const returnTo = new URL(loginUrl.searchParams.get("return_to") ?? "");
    expect(returnTo.origin).toBe(new URL(baseURL!).origin);
    expect(returnTo.pathname).toBe("/login");
    expect(returnTo.searchParams.get("auth")).toBe("callback");
    expect(returnTo.searchParams.get("returnTo")).toBe("/dashboard");
  });

  test("@signup register redirects to hosted AuthKit signup", async ({ request, baseURL }) => {
    const response = await request.get("/register", { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    const hostedSignupUrl = new URL(response.headers().location ?? "");
    expect(hostedSignupUrl.pathname).toBe("/auth/workos/signup");
    expect(hostedSignupUrl.searchParams.get("surface")).toBe("booking-admin");
    expect(hostedSignupUrl.searchParams.get("intent")).toBe("hotel");
    expect(hostedSignupUrl.pathname).not.toBe("/auth/register");
    expect(hostedSignupUrl.pathname).not.toBe("/auth/login");

    const returnTo = new URL(hostedSignupUrl.searchParams.get("return_to") ?? "");
    expect(returnTo.origin).toBe(new URL(baseURL!).origin);
    expect(returnTo.pathname).toBe("/login");
    expect(returnTo.searchParams.get("auth")).toBe("callback");
    expect(returnTo.searchParams.get("returnTo")).toBe("/dashboard");
  });
});
