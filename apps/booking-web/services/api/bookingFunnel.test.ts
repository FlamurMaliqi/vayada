import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingService, type BookingCreateRequest } from "./booking";
import { trackEvent } from "./tracking";
import { analyticsChoice, saveAnalyticsChoice } from "./analyticsConsent";

afterEach(() => vi.unstubAllGlobals());

function mockBrowser(choice: unknown = { version: 1, analytics: true }) {
  const storage = new Map<string, string>();
  const local = new Map([["vayada_booking_analytics:hotel", JSON.stringify(choice)]]);
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  return storage;
}

describe("Booking funnel instrumentation", () => {
  it.each([
    null,
    {},
    { version: 1, analytics: false },
    { version: 2, analytics: true },
    { version: 1, analytics: "true" },
  ])("does not allocate identifiers or dispatch without valid consent: %j", (choice) => {
    const storage = mockBrowser(choice);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    trackEvent("hotel", "page_visit");
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it("isolates hotels, clears withdrawal identifiers, and starts a fresh accepted session", () => {
    const storage = mockBrowser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    trackEvent("hotel", "page_visit");
    const first = storage.get("vayada_sid:hotel");
    expect(first).toBeTruthy();
    expect(analyticsChoice("other-hotel")).toBeNull();
    trackEvent("other-hotel", "page_visit");
    expect(storage.has("vayada_sid:other-hotel")).toBe(false);
    saveAnalyticsChoice("hotel", false);
    expect(storage.size).toBe(0);
    trackEvent("hotel", "room_viewed");
    expect(storage.size).toBe(0);
    saveAnalyticsChoice("hotel", true);
    trackEvent("hotel", "page_visit");
    expect(storage.get("vayada_sid:hotel")).not.toBe(first);
  });

  it("fails closed when persisting withdrawal fails", () => {
    const storage = mockBrowser();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    trackEvent("hotel", "page_visit");
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(saveAnalyticsChoice("hotel", false)).toBe(false);
    expect(analyticsChoice("hotel")).toBe(false);
    expect(storage.size).toBe(0);
    mockBrowser();
    saveAnalyticsChoice("hotel", false);
  });

  it("carries a stable session and increasing sequence without interrupting checkout", () => {
    mockBrowser();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    trackEvent("hotel", "page_visit");
    trackEvent("hotel", "rate_selected");
    const events = fetch.mock.calls.map((call) =>
      JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
    );
    expect(events.map((event) => event.metadata.funnelSequence)).toEqual([1, 2]);
    expect(events[0].sessionId).toBe(events[1].sessionId);
    expect(events[0].eventId).not.toBe(events[1].eventId);
    vi.stubGlobal("sessionStorage", {
      getItem() {
        throw new Error("disabled");
      },
    });
    expect(() => trackEvent("hotel", "rate_selected")).not.toThrow();
  });

  it.each([
    ["card", { id: "", status: "draft" }, false, []],
    [
      "card",
      { id: "booking", status: "confirmed" },
      true,
      ["payment_authorized", "booking_completed"],
    ],
    ["bank_transfer", { id: "booking", status: "pending" }, false, ["booking_completed"]],
    ["pay_at_property", { id: "booking", status: "confirmed" }, false, ["booking_completed"]],
  ])(
    "records %s only after successful creation",
    async (paymentMethod, booking, authorizationComplete, expected) => {
      mockBrowser();
      const events: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          if (url.endsWith("/events")) {
            events.push(JSON.parse(init.body as string).eventType);
            return new Response(null, { status: 204 });
          }
          return Response.json({ booking, paymentMethod, authorizationComplete });
        }),
      );
      await bookingService.create("hotel", { paymentMethod } as BookingCreateRequest);
      expect(events).toEqual(expected);
    },
  );

  it("never records failed booking creation or failed authorization", async () => {
    mockBrowser();
    const fetch = vi.fn(async () => Response.json({ detail: "failed" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      bookingService.create("hotel", { paymentMethod: "card" } as BookingCreateRequest),
    ).rejects.toThrow();
    await expect(bookingService.confirmAuthorization("hotel", "draft")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
