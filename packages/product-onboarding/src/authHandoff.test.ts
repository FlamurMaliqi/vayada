import { describe, expect, it, vi } from "vitest";

import {
  BrowserAuthHandoffError,
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
  redeemBrowserAuthHandoff,
} from "./authHandoff";

describe("browser auth handoff", () => {
  it("creates the handoff through the source app's relative auth route", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        destination:
          "https://admin.booking.localhost/handoff#code=7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk",
      }),
    );

    await expect(
      createBrowserAuthHandoff({
        csrfToken: "csrf-token",
        sourceSurface: "marketplace-web",
        targetPath: "/dashboard",
        targetSurface: "booking-admin",
        fetcher,
      }),
    ).resolves.toContain("/handoff#code=");
    expect(fetcher).toHaveBeenCalledWith(
      "/auth/handoff/create",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({ "x-vayada-csrf": "csrf-token" }),
        method: "POST",
      }),
    );
  });

  it("redeems only an opaque code and accepts safe relative navigation", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        routingHints: { propertyId: "property_alpenrose" },
        targetPath: "/dashboard?from=marketplace",
      }),
    );

    await expect(
      redeemBrowserAuthHandoff({
        code: "7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk",
        targetSurface: "booking-admin",
        fetcher,
      }),
    ).resolves.toEqual({
      routingHints: { propertyId: "property_alpenrose" },
      targetPath: "/dashboard?from=marketplace",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/auth/handoff/redeem",
      expect.objectContaining({ credentials: "include", method: "POST" }),
    );
  });

  it.each([
    [
      "classified server failure",
      async () => Response.json({ error: "handoff_retryable" }, { status: 503 }),
    ],
    ["generic gateway failure", async () => new Response("Bad Gateway", { status: 502 })],
    ["rate limit", async () => new Response(null, { status: 429 })],
    ["network failure", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("preserves the bearer code for a retry after a %s", async (_label, fetcherImplementation) => {
    const fetcher = vi.fn(fetcherImplementation);
    const error = await redeemBrowserAuthHandoff({
      code: "7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk",
      targetSurface: "booking-admin",
      fetcher,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BrowserAuthHandoffError);
    expect((error as BrowserAuthHandoffError).retryable).toBe(true);
  });

  it("treats an invalid or consumed handoff as terminal", async () => {
    const error = await redeemBrowserAuthHandoff({
      code: "7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk",
      targetSurface: "booking-admin",
      fetcher: async () => Response.json({ error: "invalid_handoff" }, { status: 401 }),
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(BrowserAuthHandoffError);
    expect((error as BrowserAuthHandoffError).retryable).toBe(false);
  });

  it("builds a safe reauthentication fallback and rejects external return paths", () => {
    expect(crossAppReauthenticationUrl("https://admin.booking.localhost", "/dashboard")).toBe(
      "https://admin.booking.localhost/login?returnTo=%2Fdashboard",
    );
    expect(() =>
      crossAppReauthenticationUrl("https://admin.booking.localhost", "https://evil.test"),
    ).toThrow("invalid");
  });
});
