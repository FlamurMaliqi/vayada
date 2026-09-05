import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { dashboardService } from ".";

const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

describe("dashboardService target route adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T12:00:00.000Z"));
    process.env.NEXT_PUBLIC_API_URL = "https://next-api.vayada.com";
    const storage = createMemoryStorage();
    storage.setItem("selectedHotelId", "stale_booking_hotel");
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    setAuthKitSession({
      accessToken: "workos-access-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
  });

  afterEach(() => {
    clearAuthData();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreEnv("NEXT_PUBLIC_API_URL", originalApiUrl);
  });

  it("maps dashboard stats from the target booking route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          metrics: {
            current: {
              totalRevenue: { amountDecimal: "3600.00", currency: "EUR" },
              bookingCount: 10,
              avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
              pageViewCount: 28,
            },
            previous: {
              totalRevenue: { amountDecimal: "2880.00", currency: "EUR" },
              bookingCount: 8,
              avgNightlyRate: { amountDecimal: "110.00", currency: "EUR" },
              pageViewCount: 21,
            },
            nextArrivalDate: "2026-07-04",
            liveSinceDate: "2025-01-15",
          },
        }),
      ),
    );

    const stats = await dashboardService.getStats("week", "Europe/Vienna");

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "/api/booking/properties/booking_hotel_alpenrose/dashboard/stats",
    );
    expect(localStorage.getItem("selectedHotelId")).toBe("booking_hotel_alpenrose");
    expect(stats).toMatchObject({
      revenue: 3600,
      revenue_previous: 2880,
      bookings: 10,
      bookings_previous: 8,
      avg_nightly_rate: 120,
      avg_nightly_rate_previous: 110,
      page_views: 28,
      page_views_previous: 21,
      next_arrival: "2026-07-04",
      live_since: "2025-01-15",
    });
  });

  it("maps page-view sparklines and the requested weekly timeline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/sparklines")) {
          return Response.json({
            sparklines: {
              points: Array.from({ length: 7 }, (_, index) => ({
                revenue: { amountDecimal: "0.00", currency: "EUR" },
                bookingCount: 0,
                avgNightlyRate: { amountDecimal: "0.00", currency: "EUR" },
                pageViewCount: index,
              })),
            },
          });
        }
        return Response.json({
          pageViews: {
            timeZone: "Europe/Vienna",
            windowStart: "2026-06-01",
            windowEnd: "2026-06-07",
            previousWindowStart: "2026-05-25",
            previousWindowEnd: "2026-05-31",
            buckets: [{ date: "2026-06-01", count: 3 }],
            previousBuckets: [{ date: "2026-05-25", count: 2 }],
            total: 3,
            previousTotal: 2,
          },
        });
      }),
    );

    await expect(dashboardService.getSparklines("week", "Europe/Vienna")).resolves.toMatchObject({
      page_views: [0, 1, 2, 3, 4, 5, 6],
    });
    await expect(dashboardService.getPageViewsTimeline(1, "Europe/Vienna")).resolves.toMatchObject({
      time_zone: "Europe/Vienna",
      window_start: "2026-06-01",
      total: 3,
      previous_total: 2,
      has_previous_data: true,
    });
    expect(String(vi.mocked(fetch).mock.calls[1]?.[0])).toContain(
      "/page-views?windowStart=2026-06-01&windowEnd=2026-06-07",
    );
  });

  it("builds date windows in the property timezone across a browser-local date boundary", async () => {
    vi.setSystemTime(new Date("2026-06-14T23:30:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          metrics: {
            current: {
              totalRevenue: { amountDecimal: "0", currency: "EUR" },
              bookingCount: 0,
              avgNightlyRate: { amountDecimal: "0", currency: "EUR" },
              pageViewCount: 0,
            },
            previous: {
              totalRevenue: { amountDecimal: "0", currency: "EUR" },
              bookingCount: 0,
              avgNightlyRate: { amountDecimal: "0", currency: "EUR" },
              pageViewCount: 0,
            },
            nextArrivalDate: null,
            liveSinceDate: null,
          },
        }),
      ),
    );

    await dashboardService.getStats("week", "Pacific/Auckland");

    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain(
      "periodStart=2026-06-09&periodEnd=2026-06-15&previousPeriodStart=2026-06-02&previousPeriodEnd=2026-06-08",
    );
  });

  it.each(["today", "week", "month"] as const)("loads the %s funnel in property-local dates", async (range) => {
    const funnel = { steps: [], paymentMethods: [], biggestDrop: null };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ funnel })));
    await expect(dashboardService.getConversionFunnel(range, "Pacific/Auckland")).resolves.toEqual(funnel);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain("/conversion-funnel?windowStart=");
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain("windowEnd=2026-06-15");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
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
