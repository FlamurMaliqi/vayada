import { getSelectedBookingHotelId } from "../api/bookingHotelScope";
import { apiClient } from "../api/client";

export interface DashboardStats {
  revenue: number;
  revenue_previous: number;
  bookings: number;
  bookings_previous: number;
  avg_nightly_rate: number;
  avg_nightly_rate_previous: number;
  page_views: number;
  page_views_previous: number;
  next_arrival: string | null;
  live_since: string | null;
}

export interface SourceBreakdown {
  source: string;
  revenue: number;
  percentage: number;
  count: number;
}

export interface BookingsBySource {
  total_revenue: number;
  sources: SourceBreakdown[];
}

export interface FunnelStep {
  label: string;
  value: number;
  percentage: number;
}

export interface ConversionFunnel {
  steps: FunnelStep[];
}

export interface Sparklines {
  revenue: number[];
  bookings: number[];
  avg_rate: number[];
  page_views: number[];
}

export interface PageViewBucket {
  date: string;
  count: number;
}

export interface PageViewsTimeline {
  time_zone: string;
  window_start: string;
  window_end: string;
  previous_window_start: string;
  previous_window_end: string;
  buckets: PageViewBucket[];
  previous_buckets: PageViewBucket[];
  total: number;
  previous_total: number;
  has_previous_data: boolean;
}

export type TimeRange = "today" | "week" | "month";

type Money = {
  amountDecimal: string;
  currency: string;
};

type TargetDashboardStatsResponse = {
  metrics: {
    current: {
      totalRevenue: Money;
      bookingCount: number;
      avgNightlyRate: Money;
      pageViewCount: number;
    };
    previous: {
      totalRevenue: Money;
      bookingCount: number;
      avgNightlyRate: Money;
      pageViewCount: number;
    };
    nextArrivalDate: string | null;
    liveSinceDate: string | null;
  };
};

type TargetSourceMixResponse = {
  sourceMix: {
    totalRevenue: Money;
    items: {
      source: string;
      revenue: Money;
      bookingCount: number;
      revenueSharePercent: number;
    }[];
  };
};

type TargetSparklinesResponse = {
  sparklines: {
    points: {
      revenue: Money;
      bookingCount: number;
      avgNightlyRate: Money;
      pageViewCount: number;
    }[];
  };
};

type TargetPageViewsResponse = {
  pageViews: {
    timeZone: string;
    windowStart: string;
    windowEnd: string;
    previousWindowStart: string;
    previousWindowEnd: string;
    buckets: { date: string; count: number }[];
    previousBuckets: { date: string; count: number }[];
    total: number;
    previousTotal: number;
  };
};

function currentHotelId(): string | null {
  return getSelectedBookingHotelId();
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = values.year;
  const month = values.month;
  const day = values.day;
  if (!year || !month || !day) throw new Error("Property timezone date is unavailable.");
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rangeQuery(
  range: TimeRange,
  timeZone: string,
): {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
} {
  const currentEnd = dateInTimeZone(new Date(), timeZone);
  const days = range === "today" ? 1 : range === "week" ? 7 : 30;
  const currentStart = shiftIsoDate(currentEnd, -(days - 1));
  const previousEnd = shiftIsoDate(currentStart, -1);
  const previousStart = shiftIsoDate(previousEnd, -(days - 1));
  return {
    currentStart,
    currentEnd,
    previousStart,
    previousEnd,
  };
}

function amount(value: Money): number {
  return Number(value.amountDecimal) || 0;
}

function dashboardBasePath(): string | null {
  const hotelId = currentHotelId();
  return hotelId ? `/api/booking/properties/${encodeURIComponent(hotelId)}/dashboard` : null;
}

function requireDashboardBasePath(): string {
  const basePath = dashboardBasePath();
  if (!basePath) throw new Error("Booking hotel scope is unavailable.");
  return basePath;
}

export const dashboardService = {
  getStats: async (range: TimeRange, timeZone: string): Promise<DashboardStats> => {
    const basePath = requireDashboardBasePath();
    const query = rangeQuery(range, timeZone);
    const response = await apiClient.get<TargetDashboardStatsResponse>(
      `${basePath}/stats?periodStart=${query.currentStart}&periodEnd=${query.currentEnd}&previousPeriodStart=${query.previousStart}&previousPeriodEnd=${query.previousEnd}`,
    );
    return {
      revenue: amount(response.metrics.current.totalRevenue),
      revenue_previous: amount(response.metrics.previous.totalRevenue),
      bookings: response.metrics.current.bookingCount,
      bookings_previous: response.metrics.previous.bookingCount,
      avg_nightly_rate: amount(response.metrics.current.avgNightlyRate),
      avg_nightly_rate_previous: amount(response.metrics.previous.avgNightlyRate),
      page_views: response.metrics.current.pageViewCount,
      page_views_previous: response.metrics.previous.pageViewCount,
      next_arrival: response.metrics.nextArrivalDate,
      live_since: response.metrics.liveSinceDate,
    };
  },

  getBookingsBySource: async (range: TimeRange, timeZone: string): Promise<BookingsBySource> => {
    const basePath = requireDashboardBasePath();
    const query = rangeQuery(range, timeZone);
    const response = await apiClient.get<TargetSourceMixResponse>(
      `${basePath}/bookings-by-source?periodStart=${query.currentStart}&periodEnd=${query.currentEnd}`,
    );
    return {
      total_revenue: amount(response.sourceMix.totalRevenue),
      sources: response.sourceMix.items.map((item) => ({
        source: item.source,
        revenue: amount(item.revenue),
        percentage: item.revenueSharePercent,
        count: item.bookingCount,
      })),
    };
  },

  getConversionFunnel: async (range: TimeRange = "month"): Promise<ConversionFunnel> => {
    void range;
    throw new Error("Booking dashboard conversion funnel is not available on the target API yet.");
  },

  getSparklines: async (range: TimeRange, timeZone: string): Promise<Sparklines> => {
    const basePath = requireDashboardBasePath();
    const query = rangeQuery(range, timeZone);
    const response = await apiClient.get<TargetSparklinesResponse>(
      `${basePath}/sparklines?windowStart=${query.currentStart}&windowEnd=${query.currentEnd}`,
    );
    return {
      revenue: response.sparklines.points.map((point) => amount(point.revenue)),
      bookings: response.sparklines.points.map((point) => point.bookingCount),
      avg_rate: response.sparklines.points.map((point) => amount(point.avgNightlyRate)),
      page_views: response.sparklines.points.map((point) => point.pageViewCount),
    };
  },

  getPageViewsTimeline: async (
    weekOffset: number,
    timeZone: string,
  ): Promise<PageViewsTimeline> => {
    const basePath = requireDashboardBasePath();
    const propertyToday = dateInTimeZone(new Date(), timeZone);
    const windowEnd = shiftIsoDate(propertyToday, -7 * Math.max(weekOffset, 0));
    const windowStart = shiftIsoDate(windowEnd, -6);
    const response = await apiClient.get<TargetPageViewsResponse>(
      `${basePath}/page-views?windowStart=${windowStart}&windowEnd=${windowEnd}`,
    );
    if (response.pageViews.timeZone !== timeZone) {
      throw new Error("Property timezone changed while loading page views.");
    }
    return {
      time_zone: response.pageViews.timeZone,
      window_start: response.pageViews.windowStart,
      window_end: response.pageViews.windowEnd,
      previous_window_start: response.pageViews.previousWindowStart,
      previous_window_end: response.pageViews.previousWindowEnd,
      buckets: response.pageViews.buckets,
      previous_buckets: response.pageViews.previousBuckets,
      total: response.pageViews.total,
      previous_total: response.pageViews.previousTotal,
      has_previous_data: response.pageViews.previousTotal > 0,
    };
  },
};
