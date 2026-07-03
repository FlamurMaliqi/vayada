import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authService } from "./index";
import { clearAuthData, getAuthBearerToken, setAuthKitSession } from "./sessionStore";

describe("PMS AuthKit session refresh", () => {
  beforeEach(() => {
    clearAuthData();
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the AuthKit session when the first-run PMS compatibility token is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/session?surface=pms-web")) {
        return jsonResponse({
          accessToken: "authkit-token",
          csrfToken: "csrf-token",
          organizationId: "org_hotel_group",
          user: {
            id: "user_hotel_admin",
            email: "hotel@example.com",
            status: "active",
          },
        });
      }
      if (url.endsWith("/auth/compat/pms-web-token")) {
        return jsonResponse({ error: "missing_pms_property_link" }, 403);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.refreshSession()).resolves.toMatchObject({
      accessToken: "authkit-token",
      organizationId: "org_hotel_group",
    });
    expect(getAuthBearerToken()).toBe("authkit-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the selected shared property when the AuthKit organization changes", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });

    setAuthKitSession({
      accessToken: "org-a-token",
      organizationId: "org_hotel_a",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });
    localStorage.setItem("selectedSharedPropertyId", "property_a");
    localStorage.setItem("selectedHotelId", "property_a");

    setAuthKitSession({
      accessToken: "org-b-token",
      organizationId: "org_hotel_b",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });

    expect(localStorage.getItem("selectedSharedPropertyId")).toBeNull();
    expect(localStorage.getItem("selectedHotelId")).toBeNull();
  });

  it("stores the PMS resource scope as the selected property", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });

    setAuthKitSession({
      accessToken: "authkit-token",
      organizationId: "org_hotel_a",
      resources: {
        "pms:pms_property": [" property_a "],
      },
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });

    expect(localStorage.getItem("selectedSharedPropertyId")).toBe("property_a");
    expect(localStorage.getItem("selectedHotelId")).toBe("property_a");
    expect(localStorage.getItem("selectedSharedPropertyOrganizationId")).toBe("org_hotel_a");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
