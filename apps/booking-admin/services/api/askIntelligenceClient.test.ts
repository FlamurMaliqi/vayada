import { afterEach, describe, expect, it, vi } from "vitest";

describe("askIntelligence", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("mints a booking compatibility token to resolve organization scope", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_API_URL", "https://api.localhost");
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);
    vi.stubGlobal("navigator", { language: "en-US" });

    const answer = askAnswer();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "/auth/compat/booking-admin-token") {
        expect(init?.credentials).toBe("include");
        expect(new Headers(init?.headers).get("x-vayada-csrf")).toBe("csrf-token");
        return jsonResponse({
          accessToken: fakeJwt({ org: "org_hotel_group" }),
          expiresIn: 900,
          tokenType: "Bearer",
        });
      }

      expect(href).toBe("https://api.localhost/api/ai/ask");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer workos-token");
      expect(headers.get("x-hotel-id")).toBeNull();
      expect(JSON.parse(String(init?.body))).toMatchObject({
        question: "Why did direct share change?",
        scope: {
          organizationId: "org_hotel_group",
          bookingHotelId: "booking_hotel_alpenrose",
          locale: "en-US",
        },
      });
      return jsonResponse(answer);
    });
    vi.stubGlobal("fetch", fetch);

    const { setAuthKitSession } = await import("@/services/auth/sessionStore");
    const { askIntelligence } = await import("./askIntelligenceClient");
    setAuthKitSession({
      accessToken: "workos-token",
      csrfToken: "csrf-token",
      organizationId: "org_workos_hotel_group",
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });

    await expect(
      askIntelligence("Why did direct share change?", "booking_hotel_alpenrose"),
    ).resolves.toEqual(answer);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps non-envelope failures to safe retry copy", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_API_URL", "https://api.localhost");
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "database password leaked in upstream error" }, { status: 500 }),
      ),
    );

    const { setAuthKitSession, setLegacyCompatibilityToken } =
      await import("@/services/auth/sessionStore");
    const { askIntelligence } = await import("./askIntelligenceClient");
    setAuthKitSession({
      accessToken: "workos-token",
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });
    setLegacyCompatibilityToken(fakeJwt({ org: "org_hotel_group" }), 900);

    await expect(
      askIntelligence("What happened?", "booking_hotel_alpenrose"),
    ).rejects.toMatchObject({
      message: "Ask Intelligence could not answer right now. Try again.",
      retryable: true,
    });
  });
});

function askAnswer() {
  return {
    answerId: "ask_answer_1",
    generatedAt: "2026-06-19T00:00:00.000Z",
    question: "Why did direct share change?",
    status: "answered",
    summary: "Direct share declined because OTA bookings increased.",
    blocks: [],
    unavailableData: [],
    caveats: [],
    suggestedActions: [],
    followUpQuestions: [],
  };
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createWindowWithStorage(): Window {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
  };

  return { localStorage } as Window;
}
