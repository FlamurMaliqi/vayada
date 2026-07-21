import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setAuthKitSession, setLegacyPasswordSession } from "../auth/sessionStore";
import { ApiClient, isNextApiTarget } from "./client";

describe("ApiClient hotel context header", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage, location: { href: "" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })),
    );
    setLegacyPasswordSession({
      token: "booking-admin-token",
      expiresIn: 3600,
      user: {
        id: "user_1",
        email: "owner@example.com",
        name: "Owner",
        type: "hotel",
        status: "active",
      },
    });
    localStorage.setItem("selectedHotelId", "booking_hotel_alpenrose");
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps target resource routes free of the legacy hotel header", async () => {
    const client = new ApiClient("https://api.booking.localhost");

    await client.get("/api/booking/hotels/booking_hotel_alpenrose/settings/addons");

    expect(fetchHeaders()).not.toHaveProperty("X-Hotel-Id");
  });

  it("uses the active session bearer for target routes", async () => {
    clearAuthData();
    setAuthKitSession({
      accessToken: "workos-token",
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
    const client = new ApiClient("https://next-api.vayada.com");

    await client.get("/api/booking/hotels/booking_hotel_alpenrose/settings/addons");
    expect(fetchHeaders()).toMatchObject({
      Authorization: "Bearer workos-token",
    });
  });

  it("only treats explicit legacy booking API hosts as non-target", () => {
    expect(isNextApiTarget("https://api.localhost")).toBe(true);
    expect(isNextApiTarget("https://next-api.vayada.com")).toBe(true);
    expect(isNextApiTarget("https://api.booking.localhost")).toBe(false);
    expect(isNextApiTarget("http://localhost:8001")).toBe(false);
  });
});

function fetchHeaders(): Record<string, string> {
  const fetchMock = vi.mocked(fetch);
  const requestInit = fetchMock.mock.calls.at(-1)?.[1];
  return (requestInit?.headers ?? {}) as Record<string, string>;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
