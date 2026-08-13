import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  BookingDashboardMetricsReadModel,
  BookingDashboardMetricsReadPort,
  BookingPageViewTimelineReadModel,
  BookingSourceMixReadModel,
  BookingSparklineReadModel,
} from "@vayada/domain-booking";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  createTargetBookingDashboardMetricsReadPort,
  type BookingDashboardMetricsReadPool,
} from "./platform/bookingDashboard.js";
import type {
  BookingDashboardSparklinesResponse,
  BookingDashboardSourceMixResponse,
  BookingDashboardStatsResponse,
} from "./routes/bookingDashboard.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

const session: VerifiedSession = {
  workosUserId: "workos_booking_analytics_user",
  workosOrgId: "workos_booking_analytics_org",
  sessionId: "session_booking_analytics",
  expiresAt: futureExpiry,
};

const dashboardStatsUrl = "/api/booking/properties/prop_alpenrose/dashboard/stats";
const dashboardStatsQuery = {
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  previousPeriodStart: "2026-05-01",
  previousPeriodEnd: "2026-05-31",
};

const activeBookingEntitlement: ProductEntitlement = {
  product: "booking",
  key: "booking-engine",
  status: "active",
  resource: {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: "prop_alpenrose",
  },
};

const suspendedBookingEntitlement: ProductEntitlement = {
  ...activeBookingEntitlement,
  status: "suspended",
};

type DashboardAppOptions = {
  readPort?: BookingDashboardMetricsReadPort & { close?(): Promise<void> };
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  linkedPropertyId?: string;
};

describe("Booking dashboard routes", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("returns target dashboard stats from the injected Booking read port", async () => {
    const calls: unknown[] = [];
    app = buildDashboardApp({
      readPort: {
        async getDashboardMetrics(input) {
          calls.push(input);
          return fakeMetrics();
        },
        async getSourceMix(input) {
          return fakeSourceMix(input.propertyId);
        },
        async getSparklines(input) {
          return fakeSparklines(input.propertyId);
        },
        async getPageViewTimeline(input) {
          return fakePageViews(input.propertyId);
        },
      },
    });

    const response = await injectJson<BookingDashboardStatsResponse>(app, {
      method: "GET",
      url: dashboardStatsUrl,
      headers: { authorization: "Bearer valid-token" },
      query: dashboardStatsQuery,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.contractVersion).toBe("booking-dashboard.v1");
    expect(response.body.metrics.current.totalRevenue.amountDecimal).toBe("3600.00");
    expect(calls).toEqual([
      {
        propertyId: "prop_alpenrose",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        previousPeriodStart: "2026-05-01",
        previousPeriodEnd: "2026-05-31",
      },
    ]);
  });

  it("returns source mix and sparklines with the dashboard contract version", async () => {
    app = buildDashboardApp();

    const sourceMix = await injectJson<BookingDashboardSourceMixResponse>(app, {
      method: "GET",
      url: "/api/booking/properties/prop_alpenrose/dashboard/bookings-by-source",
      headers: { authorization: "Bearer valid-token" },
      query: {
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
      },
    });
    const sparklines = await injectJson<BookingDashboardSparklinesResponse>(app, {
      method: "GET",
      url: "/api/booking/properties/prop_alpenrose/dashboard/sparklines",
      headers: { authorization: "Bearer valid-token" },
      query: {
        windowStart: "2026-06-01",
        windowEnd: "2026-06-30",
      },
    });

    expect(sourceMix.statusCode).toBe(200);
    expect(sourceMix.body.contractVersion).toBe("booking-dashboard.v1");
    expect(sourceMix.body.sourceMix.items[0].source).toBe("direct");
    expect(sparklines.statusCode).toBe(200);
    expect(sparklines.body.contractVersion).toBe("booking-dashboard.v1");
    expect(sparklines.body.sparklines.points).toHaveLength(7);
  });

  it("closes the dashboard read port on app shutdown", async () => {
    let closed = false;
    app = buildDashboardApp({
      readPort: {
        ...fakeReadPort(),
        async close() {
          closed = true;
        },
      },
    });

    await app.close();
    app = null;

    expect(closed).toBe(true);
  });

  it("rejects invalid dashboard date ranges before reading the port", async () => {
    let readCount = 0;
    app = buildDashboardApp({
      readPort: {
        async getDashboardMetrics() {
          readCount += 1;
          return fakeMetrics();
        },
        async getSourceMix(input) {
          return fakeSourceMix(input.propertyId);
        },
        async getSparklines(input) {
          return fakeSparklines(input.propertyId);
        },
        async getPageViewTimeline(input) {
          return fakePageViews(input.propertyId);
        },
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: dashboardStatsUrl,
      headers: { authorization: "Bearer valid-token" },
      query: {
        periodStart: "2026-06-30",
        periodEnd: "2026-06-01",
        previousPeriodStart: "2026-05-01",
        previousPeriodEnd: "2026-05-31",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe("invalid_query");
    expect(readCount).toBe(0);
  });

  it("returns a not-found contract when the dashboard read model has no property row", async () => {
    app = buildDashboardApp({
      readPort: {
        async getDashboardMetrics() {
          return null;
        },
        async getSourceMix(input) {
          return fakeSourceMix(input.propertyId);
        },
        async getSparklines(input) {
          return fakeSparklines(input.propertyId);
        },
        async getPageViewTimeline(input) {
          return fakePageViews(input.propertyId);
        },
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: dashboardStatsUrl,
      headers: { authorization: "Bearer valid-token" },
      query: dashboardStatsQuery,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe("read_model_not_found");
  });

  it.each([
    {
      name: "without authentication",
      appOptions: {},
      headers: {},
      expectedStatus: 401,
      expectedCode: "unauthenticated",
    },
    {
      name: "when permission is missing",
      appOptions: { permissions: ["booking.settings.read"] },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
      expectedCode: "missing_permission",
    },
    {
      name: "when entitlement is missing",
      appOptions: { entitlements: [] },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
      expectedCode: "missing_entitlement",
    },
    {
      name: "when entitlement is inactive",
      appOptions: { entitlements: [suspendedBookingEntitlement] },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
      expectedCode: "inactive_entitlement",
    },
    {
      name: "when linked-resource access is missing",
      appOptions: { linkedPropertyId: "prop_other" },
      headers: { authorization: "Bearer valid-token" },
      expectedStatus: 403,
      expectedCode: "missing_resource_access",
    },
  ] satisfies Array<{
    name: string;
    appOptions: DashboardAppOptions;
    headers: Record<string, string>;
    expectedStatus: number;
    expectedCode: string;
  }>)(
    "rejects dashboard reads $name",
    async ({ appOptions, headers, expectedStatus, expectedCode }) => {
      app = buildDashboardApp(appOptions);

      const response = await injectJson<{ code: string }>(app, {
        method: "GET",
        url: dashboardStatsUrl,
        headers,
        query: dashboardStatsQuery,
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(response.body.code).toBe(expectedCode);
    },
  );
});

describe("target Booking dashboard metrics read port", () => {
  it("maps aggregate target rows into the dashboard metrics contract", async () => {
    const pool = createQueuedDashboardPool([
      {
        rows: [
          {
            propertyFound: true,
            revenueAmount: "3600.00",
            bookingCount: "10",
            roomNightCount: "30",
            currency: "EUR",
            nextArrivalDate: "2026-07-04",
            liveSinceDate: "2025-01-15",
          },
        ],
      },
      {
        rows: [
          {
            propertyFound: true,
            revenueAmount: "2880.00",
            bookingCount: "8",
            roomNightCount: "24",
            currency: "EUR",
            nextArrivalDate: "2026-07-04",
            liveSinceDate: "2025-01-15",
          },
        ],
      },
      { rows: [pageViewRow("2026-06-01", "28")] },
      { rows: [pageViewRow("2026-05-01", "21")] },
      {
        rows: [
          {
            source: "direct",
            revenueAmount: "3000.00",
            bookingCount: "8",
            currency: "EUR",
          },
          {
            source: "airbnb",
            revenueAmount: "600.00",
            bookingCount: "2",
            currency: "EUR",
          },
        ],
      },
      {
        rows: [
          {
            bucketStart: "2026-06-01",
            bucketEnd: "2026-06-04",
            revenueAmount: "400.00",
            bookingCount: "1",
            roomNightCount: "4",
            currency: "EUR",
          },
        ],
      },
      { rows: [pageViewRow("2026-06-01", "4")] },
    ]);
    const readPort = createTargetBookingDashboardMetricsReadPort({
      connectionString: "postgres://target",
      pool,
    });

    const metrics = await readPort.getDashboardMetrics({
      propertyId: "booking_hotel_alpenrose",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      previousPeriodStart: "2026-05-01",
      previousPeriodEnd: "2026-05-31",
    });
    const sourceMix = await readPort.getSourceMix({
      propertyId: "booking_hotel_alpenrose",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
    });
    const sparklines = await readPort.getSparklines({
      propertyId: "booking_hotel_alpenrose",
      windowStart: "2026-06-01",
      windowEnd: "2026-06-30",
    });

    expect(metrics?.current.totalRevenue.amountDecimal).toBe("3600.00");
    expect(metrics?.current.avgNightlyRate.amountDecimal).toBe("120.00");
    expect(metrics?.current.pageViewCount).toBe(28);
    expect(metrics?.nextArrivalDate).toBe("2026-07-04");
    expect(sourceMix.items[0].revenueSharePercent).toBe(83.3);
    expect(sparklines.points[0].avgNightlyRate.amountDecimal).toBe("100.00");
    expect(sparklines.points[0].pageViewCount).toBe(4);
    expect(pool.queries.join("\n")).toContain("booking.guest_bookings");
    expect(pool.queries.join("\n")).toContain("platform.domain_events");
    expect(pool.queries.join("\n")).toContain("trafficClass");
    expect(pool.queries.join("\n")).not.toContain("booking.booking_guests");
  });

  it("builds seven indexed sparkline buckets that keep the requested tail date", async () => {
    const pool = createQueuedDashboardPool([
      { rows: [] },
      { rows: [pageViewRow("2026-06-01", "0")] },
    ]);
    const readPort = createTargetBookingDashboardMetricsReadPort({
      connectionString: "postgres://target",
      pool,
    });

    await readPort.getSparklines({
      propertyId: "booking_hotel_alpenrose",
      windowStart: "2026-06-01",
      windowEnd: "2026-06-30",
    });

    const sql = pool.queries[0];
    expect(sql).toContain("generate_series(0, 6)");
    expect(sql).toContain("bucket.bucket_end::text");
    expect(sql).not.toContain("LIMIT 7");
  });

  it("buckets deduplicated human page views in the property timezone", async () => {
    const pool = createQueuedDashboardPool([
      {
        rows: [
          pageViewRow("2026-06-01", "21", "Asia/Makassar"),
          pageViewRow("2026-06-08", "28", "Asia/Makassar"),
          pageViewRow("2026-06-09", "0", "Asia/Makassar"),
        ],
      },
    ]);
    const readPort = createTargetBookingDashboardMetricsReadPort({
      connectionString: "postgres://target",
      pool,
    });

    const timeline = await readPort.getPageViewTimeline({
      propertyId: "booking_hotel_alpenrose",
      windowStart: "2026-06-08",
      windowEnd: "2026-06-14",
    });

    expect(timeline).toMatchObject({
      timeZone: "Asia/Makassar",
      total: 28,
      previousTotal: 21,
      buckets: [
        { date: "2026-06-08", count: 28 },
        { date: "2026-06-09", count: 0 },
      ],
    });
    expect(pool.queries[0]).toContain("AT TIME ZONE scope.time_zone");
    expect(pool.queries[0]).toContain("COUNT(DISTINCT event.id)");
    expect(pool.queries[0]).toContain("event.property_id = scope.property_id");
    expect(pool.queries[0]).toContain("COUNT(DISTINCT slug_owner.property_id)");
    expect(pool.queries[0]).toContain("NOT IN ('bot', 'test')");
    expect(pool.queries[0]).toContain("hotel_catalog.property_slugs");
  });

  it("returns null metrics when the target property cannot be resolved", async () => {
    const pool = createQueuedDashboardPool([
      {
        rows: [
          {
            propertyFound: false,
            revenueAmount: "0",
            bookingCount: "0",
            roomNightCount: "0",
            currency: null,
            nextArrivalDate: null,
            liveSinceDate: null,
          },
        ],
      },
      {
        rows: [
          {
            propertyFound: false,
            revenueAmount: "0",
            bookingCount: "0",
            roomNightCount: "0",
            currency: null,
            nextArrivalDate: null,
            liveSinceDate: null,
          },
        ],
      },
      { rows: [{ propertyFound: false, timeZone: null, pageViewCount: "0" }] },
      { rows: [{ propertyFound: false, timeZone: null, pageViewCount: "0" }] },
    ]);
    const readPort = createTargetBookingDashboardMetricsReadPort({
      connectionString: "postgres://target",
      pool,
    });

    await expect(
      readPort.getDashboardMetrics({
        propertyId: "missing_hotel",
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        previousPeriodStart: "2026-05-01",
        previousPeriodEnd: "2026-05-31",
      }),
    ).resolves.toBeNull();
  });
});

function buildDashboardApp(options: DashboardAppOptions = {}): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    bookingDashboardMetricsReadPort: options.readPort ?? fakeReadPort(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: createIdentityRepository(options.linkedPropertyId),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["booking.analytics.read"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return options.entitlements ?? [activeBookingEntitlement];
        },
      },
    },
  });
}

function createIdentityRepository(linkedPropertyId = "prop_alpenrose"): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_booking_analytics",
        email: "owner@example.test",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_hotel_group",
        workosOrgId: "workos_booking_analytics_org",
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_booking_analytics",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om_booking_analytics",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return [
        {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: linkedPropertyId,
          relationship: "owner",
          status: "active",
        },
      ];
    },
  };
}

function fakeReadPort(): BookingDashboardMetricsReadPort {
  return {
    async getDashboardMetrics() {
      return fakeMetrics();
    },
    async getSourceMix(input) {
      return fakeSourceMix(input.propertyId);
    },
    async getSparklines(input) {
      return fakeSparklines(input.propertyId);
    },
    async getPageViewTimeline(input) {
      return fakePageViews(input.propertyId);
    },
  };
}

function fakeMetrics(): BookingDashboardMetricsReadModel {
  return {
    propertyId: "prop_alpenrose",
    current: {
      totalRevenue: { amountDecimal: "3600.00", currency: "EUR" },
      bookingCount: 10,
      avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
      pageViewCount: 28,
    },
    previous: {
      totalRevenue: { amountDecimal: "2880.00", currency: "EUR" },
      bookingCount: 8,
      avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
      pageViewCount: 21,
    },
    nextArrivalDate: "2026-07-04",
    liveSinceDate: "2025-01-15",
  };
}

function fakeSourceMix(propertyId: string): BookingSourceMixReadModel {
  return {
    propertyId,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    totalRevenue: { amountDecimal: "3600.00", currency: "EUR" },
    items: [
      {
        source: "direct",
        revenue: { amountDecimal: "3000.00", currency: "EUR" },
        bookingCount: 8,
        revenueSharePercent: 83.3,
      },
      {
        source: "airbnb",
        revenue: { amountDecimal: "600.00", currency: "EUR" },
        bookingCount: 2,
        revenueSharePercent: 16.7,
      },
    ],
  };
}

function fakeSparklines(propertyId: string): BookingSparklineReadModel {
  return {
    propertyId,
    points: Array.from({ length: 7 }, (_, index) => ({
      bucketStart: `2026-06-${String(index * 4 + 1).padStart(2, "0")}`,
      bucketEnd: `2026-06-${String(index * 4 + 4).padStart(2, "0")}`,
      revenue: { amountDecimal: String(400 + index * 20), currency: "EUR" },
      bookingCount: index + 1,
      avgNightlyRate: { amountDecimal: "120.00", currency: "EUR" },
      pageViewCount: index,
    })),
  };
}

function fakePageViews(propertyId: string): BookingPageViewTimelineReadModel {
  const buckets = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-06-${String(index + 8).padStart(2, "0")}`,
    count: index === 1 ? 0 : index + 1,
  }));
  const previousBuckets = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    count: index,
  }));
  return {
    propertyId,
    timeZone: "Europe/Vienna",
    windowStart: "2026-06-08",
    windowEnd: "2026-06-14",
    previousWindowStart: "2026-06-01",
    previousWindowEnd: "2026-06-07",
    buckets,
    previousBuckets,
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    previousTotal: previousBuckets.reduce((sum, bucket) => sum + bucket.count, 0),
  };
}

function createQueuedDashboardPool(
  responses: Array<{ rows: Record<string, unknown>[] }>,
): BookingDashboardMetricsReadPool & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string) {
      queries.push(text);
      const next = responses.shift();
      if (!next) throw new Error("Unexpected dashboard query");
      return { rows: next.rows as T[], rowCount: next.rows.length };
    },
    async end() {},
  };
}

function pageViewRow(bucketDate: string, pageViewCount: string, timeZone = "Europe/Vienna") {
  return { propertyFound: true, timeZone, bucketDate, pageViewCount };
}
