import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "./client";

vi.mock("@/services/auth", () => ({ authService: { ensureSession: vi.fn() } }));
vi.mock("@/services/auth/storage", () => ({
  getAuthBearerToken: () => "expired-token",
  clearAuthData: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

it("returns expired support sessions inline without navigating away from the draft", async () => {
  const location = { href: "/dashboard" };
  vi.stubGlobal("window", { location });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response('{"detail":"expired"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  await expect(
    apiClient.post(
      "/api/support",
      { message: "Keep my draft" },
      {
        redirectOnUnauthorized: false,
      },
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(location.href).toBe("/dashboard");
});
