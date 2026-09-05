import { buildBookingConversionFunnel, type BookingFunnelEvent } from "@vayada/domain-booking";
import type {
  BookingDashboardMetricsPeriodInput,
  BookingDashboardMetricsReadModel,
  BookingDashboardMetricsReadPort,
  BookingDate,
  BookingMoney,
  BookingPageViewTimelineReadModel,
  BookingSourceMixReadModel,
  BookingSparklineReadModel,
} from "@vayada/domain-booking";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type BookingDashboardMetricsReadClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export type BookingDashboardMetricsReadPool = BookingDashboardMetricsReadClient & {
  end(): Promise<void>;
};

type BookingDashboardMetricsRow = {
  propertyFound: boolean;
  revenueAmount: string | null;
  bookingCount: string;
  roomNightCount: string | null;
  currency: string | null;
  nextArrivalDate: string | Date | null;
  liveSinceDate: string | Date | null;
};

type BookingDashboardSourceRow = {
  source: string | null;
  revenueAmount: string | null;
  bookingCount: string;
  currency: string | null;
};

type BookingDashboardSparklineRow = {
  bucketStart: string | Date;
  bucketEnd: string | Date;
  revenueAmount: string | null;
  bookingCount: string;
  roomNightCount: string | null;
  currency: string | null;
};

type BookingPageViewBucketRow = {
  propertyFound: boolean;
  timeZone: string | null;
  bucketDate: string | Date;
  pageViewCount: string;
};

export function createTargetBookingDashboardMetricsReadPort(config: {
  connectionString: string;
  max?: number;
  pool?: BookingDashboardMetricsReadPool;
}): BookingDashboardMetricsReadPort & {
  resolveCanonicalPropertyId(propertyId: string): Promise<string | null>;
  close(): Promise<void>;
} {
  if (!config.connectionString.trim()) {
    throw new Error("Booking dashboard metrics read port connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: BookingDashboardMetricsReadPool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async resolveCanonicalPropertyId(propertyId) {
      const result = await pool.query<{ propertyId: string }>(
        `${bookingScopedPropertyCte()}
         SELECT property_id::text AS "propertyId" FROM scoped_property`,
        [propertyId],
      );
      return result.rows[0]?.propertyId ?? null;
    },
    async getConversionFunnel(input) {
      const result = await pool.query<{ timeZone: string | null; addonsEnabled: boolean; events: BookingFunnelEvent[] }>(
        conversionFunnelSql(), [input.propertyId, input.windowStart, input.windowEnd],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (!row.timeZone) throw new Error("Booking funnel requires a canonical property timezone");
      return buildBookingConversionFunnel(row.events, row.addonsEnabled);
    },
    async getDashboardMetrics(input) {
      const [currentResult, previousResult, currentPageViews, previousPageViews] =
        await Promise.all([
          pool.query<BookingDashboardMetricsRow>(dashboardMetricsSql(), [
            input.propertyId,
            input.periodStart,
            input.periodEnd,
          ]),
          pool.query<BookingDashboardMetricsRow>(dashboardMetricsSql(), [
            input.propertyId,
            input.previousPeriodStart,
            input.previousPeriodEnd,
          ]),
          pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
            input.propertyId,
            input.periodStart,
            input.periodEnd,
          ]),
          pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
            input.propertyId,
            input.previousPeriodStart,
            input.previousPeriodEnd,
          ]),
        ]);

      const current = currentResult.rows[0];
      const previous = previousResult.rows[0];
      const currentViews = currentPageViews.rows[0];
      const previousViews = previousPageViews.rows[0];
      if (
        !current?.propertyFound ||
        !previous?.propertyFound ||
        !currentViews?.propertyFound ||
        !previousViews?.propertyFound
      ) {
        return null;
      }
      requirePageViewTimeZone(currentViews);
      requirePageViewTimeZone(previousViews);

      return {
        propertyId: input.propertyId,
        current: toRevenueStats(current, totalPageViews(currentPageViews.rows)),
        previous: toRevenueStats(previous, totalPageViews(previousPageViews.rows)),
        nextArrivalDate: toDateString(current.nextArrivalDate),
        liveSinceDate: toDateString(current.liveSinceDate),
      } satisfies BookingDashboardMetricsReadModel;
    },
    async getSourceMix(input) {
      const result = await pool.query<BookingDashboardSourceRow>(sourceMixSql(), [
        input.propertyId,
        input.periodStart,
        input.periodEnd,
      ]);
      const totalRevenue = result.rows.reduce((sum, row) => sum + numeric(row.revenueAmount), 0);
      const currency = result.rows.find((row) => row.currency)?.currency ?? "USD";

      return {
        propertyId: input.propertyId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        totalRevenue: money(totalRevenue, currency),
        items: result.rows.map((row) => {
          const revenue = numeric(row.revenueAmount);
          return {
            source: row.source || "direct",
            revenue: money(revenue, row.currency ?? currency),
            bookingCount: Number(row.bookingCount),
            revenueSharePercent:
              totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 1000) / 10 : 0,
          };
        }),
      } satisfies BookingSourceMixReadModel;
    },
    async getSparklines(input) {
      const [result, pageViews] = await Promise.all([
        pool.query<BookingDashboardSparklineRow>(sparklineSql(), [
          input.propertyId,
          input.windowStart,
          input.windowEnd,
        ]),
        pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
          input.propertyId,
          input.windowStart,
          input.windowEnd,
        ]),
      ]);
      const currency = result.rows.find((row) => row.currency)?.currency ?? "USD";
      requirePageViewTimeZone(pageViews.rows[0]);

      return {
        propertyId: input.propertyId,
        points: result.rows.map((row) => ({
          bucketStart: toDateString(row.bucketStart) ?? input.windowStart,
          bucketEnd: toDateString(row.bucketEnd) ?? input.windowEnd,
          revenue: money(numeric(row.revenueAmount), row.currency ?? currency),
          bookingCount: Number(row.bookingCount),
          avgNightlyRate: averageNightlyRate(row, row.currency ?? currency),
          pageViewCount: totalPageViews(
            pageViews.rows,
            toDateString(row.bucketStart),
            toDateString(row.bucketEnd),
          ),
        })),
      } satisfies BookingSparklineReadModel;
    },
    async getPageViewTimeline(input) {
      const windowDays = inclusiveDays(input.windowStart, input.windowEnd);
      const previousWindowStart = shiftIsoDate(input.windowStart, -windowDays);
      const previousWindowEnd = shiftIsoDate(input.windowStart, -1);
      const result = await pool.query<BookingPageViewBucketRow>(pageViewBucketsSql(), [
        input.propertyId,
        previousWindowStart,
        input.windowEnd,
      ]);
      const first = result.rows[0];
      if (!first?.propertyFound) return null;
      const timeZone = requirePageViewTimeZone(first);
      const current = result.rows.filter(
        (row) => (toDateString(row.bucketDate) ?? "") >= input.windowStart,
      );
      const previous = result.rows.filter(
        (row) => (toDateString(row.bucketDate) ?? "") < input.windowStart,
      );
      const buckets = current.map(toPageViewBucket);
      const previousBuckets = previous.map(toPageViewBucket);
      return {
        propertyId: input.propertyId,
        timeZone,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        previousWindowStart,
        previousWindowEnd,
        buckets,
        previousBuckets,
        total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
        previousTotal: previousBuckets.reduce((sum, bucket) => sum + bucket.count, 0),
      } satisfies BookingPageViewTimelineReadModel;
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

export function bookingScopedPropertyCte(): string {
  return `WITH scoped_property_candidates AS (
    SELECT property.id AS property_id
    FROM hotel_catalog.properties property
    WHERE property.id::text = $1
    UNION
    SELECT source.property_id
    FROM hotel_catalog.property_source_links source
    WHERE source.source_system = 'booking'
      AND source.source_table = 'booking_hotels'
      AND source.source_id = $1
      AND source.relationship = 'canonical_input'
      AND source.status = 'active'
  ),
  scoped_property AS (
    SELECT MIN(property_id::text)::uuid AS property_id
    FROM scoped_property_candidates
    HAVING COUNT(*) = 1
  )`;
}

function dashboardMetricsSql(): string {
  return `${bookingScopedPropertyCte()},
  scoped_bookings AS (
    SELECT booking.*
    FROM booking.guest_bookings booking
    JOIN scoped_property scoped ON scoped.property_id = booking.property_id
    WHERE booking.lifecycle_status IN ('confirmed', 'completed')
  )
  SELECT
    COALESCE(SUM(booking.total_amount), 0)::text AS "revenueAmount",
    COUNT(*)::text AS "bookingCount",
    COALESCE(
      SUM(GREATEST(booking.check_out - booking.check_in, 1) * booking.room_count),
      0
    )::text AS "roomNightCount",
    (array_agg(booking.currency ORDER BY booking.created_at DESC, booking.id))[1] AS currency,
    (
      SELECT MIN(upcoming.check_in)::text
      FROM scoped_bookings upcoming
      WHERE upcoming.check_in >= CURRENT_DATE
    ) AS "nextArrivalDate",
    (
      SELECT MIN(live.check_in)::text
      FROM scoped_bookings live
    ) AS "liveSinceDate",
    EXISTS (SELECT 1 FROM scoped_property) AS "propertyFound"
  FROM scoped_bookings booking
  WHERE booking.check_in >= $2::date
    AND booking.check_in <= $3::date`;
}

function sourceMixSql(): string {
  return `${bookingScopedPropertyCte()}
  SELECT
    COALESCE(
      NULLIF(booking.booking_metadata ->> 'channel', ''),
      NULLIF(booking.source_system, ''),
      'direct'
    ) AS source,
    COALESCE(SUM(booking.total_amount), 0)::text AS "revenueAmount",
    COUNT(*)::text AS "bookingCount",
    (array_agg(booking.currency ORDER BY booking.created_at DESC, booking.id))[1] AS currency
  FROM booking.guest_bookings booking
  JOIN scoped_property scoped ON scoped.property_id = booking.property_id
  WHERE booking.lifecycle_status IN ('confirmed', 'completed')
    AND booking.check_in >= $2::date
    AND booking.check_in <= $3::date
  GROUP BY COALESCE(
    NULLIF(booking.booking_metadata ->> 'channel', ''),
    NULLIF(booking.source_system, ''),
    'direct'
  )
  ORDER BY SUM(booking.total_amount) DESC, source ASC`;
}

function sparklineSql(): string {
  return `${bookingScopedPropertyCte()},
  buckets AS (
    SELECT
      ($2::date + floor((($3::date - $2::date + 1) * bucket_index)::numeric / 7)::int)
        AS bucket_start,
      GREATEST(
        ($2::date + floor((($3::date - $2::date + 1) * (bucket_index + 1))::numeric / 7)::int - 1),
        ($2::date + floor((($3::date - $2::date + 1) * bucket_index)::numeric / 7)::int)
      ) AS bucket_end
    FROM generate_series(0, 6) bucket_index
  )
  SELECT
    bucket.bucket_start::text AS "bucketStart",
    bucket.bucket_end::text AS "bucketEnd",
    COALESCE(SUM(booking.total_amount), 0)::text AS "revenueAmount",
    COUNT(booking.id)::text AS "bookingCount",
    COALESCE(
      SUM(GREATEST(booking.check_out - booking.check_in, 1) * booking.room_count),
      0
    )::text AS "roomNightCount",
    (array_agg(booking.currency ORDER BY booking.created_at DESC, booking.id)
      FILTER (WHERE booking.id IS NOT NULL))[1] AS currency
  FROM buckets bucket
  JOIN scoped_property scoped ON TRUE
  LEFT JOIN booking.guest_bookings booking
    ON booking.property_id = scoped.property_id
   AND booking.lifecycle_status IN ('confirmed', 'completed')
   AND booking.check_in >= bucket.bucket_start
   AND booking.check_in <= bucket.bucket_end
  GROUP BY bucket.bucket_start, bucket.bucket_end
  ORDER BY bucket.bucket_start`;
}

function pageViewBucketsSql(): string {
  return `${bookingScopedPropertyCte()},
  telemetry_scope AS (
    SELECT scoped.property_id, location.timezone AS time_zone
    FROM scoped_property scoped
    JOIN hotel_catalog.property_locations location ON location.property_id = scoped.property_id
    JOIN pg_timezone_names timezone ON timezone.name = location.timezone
  ),
  known_slugs AS (
    SELECT DISTINCT slug.slug
    FROM hotel_catalog.property_slugs slug
    JOIN scoped_property scoped ON scoped.property_id = slug.property_id
  ),
  buckets AS (
    SELECT day::date AS bucket_date
    FROM generate_series($2::date, $3::date, INTERVAL '1 day') day
  )
  SELECT
    EXISTS (SELECT 1 FROM scoped_property) AS "propertyFound",
    (SELECT time_zone FROM telemetry_scope) AS "timeZone",
    bucket.bucket_date::text AS "bucketDate",
    COUNT(DISTINCT event.id)::text AS "pageViewCount"
  FROM buckets bucket
  LEFT JOIN telemetry_scope scope ON TRUE
  LEFT JOIN platform.domain_events event
    ON event.source_system = 'distribution'
   AND event.event_type = 'booking_web.page_visit'
   AND event.resource_product = 'distribution'
   AND event.resource_type = 'booking_web_hotel'
   AND (
     (event.tenant_scope = 'property' AND event.property_id = scope.property_id)
     OR (
       event.tenant_scope = 'external'
       AND event.property_id IS NULL
       AND event.resource_id IN (SELECT slug FROM known_slugs)
       AND 1 = (
         SELECT COUNT(DISTINCT slug_owner.property_id)
         FROM hotel_catalog.property_slugs slug_owner
         WHERE slug_owner.slug = event.resource_id
       )
     )
   )
   AND event.event_status IN ('recorded', 'projected')
   AND COALESCE(event.event_metadata ->> 'trafficClass', 'human') NOT IN ('bot', 'test')
   AND event.payload -> 'metadata' -> 'isTestData' IS DISTINCT FROM 'true'::jsonb
   AND event.payload -> 'metadata' -> 'testData' IS DISTINCT FROM 'true'::jsonb
   AND (event.occurred_at AT TIME ZONE scope.time_zone)::date = bucket.bucket_date
  GROUP BY bucket.bucket_date
  ORDER BY bucket.bucket_date`;
}

function toRevenueStats(
  row: BookingDashboardMetricsRow,
  pageViewCount: number,
): BookingDashboardMetricsReadModel["current"] {
  const currency = row.currency ?? "USD";
  return {
    totalRevenue: money(numeric(row.revenueAmount), currency),
    bookingCount: Number(row.bookingCount),
    avgNightlyRate: averageNightlyRate(row, currency),
    pageViewCount,
  };
}

function requirePageViewTimeZone(row: BookingPageViewBucketRow | undefined): string {
  if (!row?.propertyFound || !row.timeZone) {
    throw new Error("Booking dashboard page views require a canonical property timezone");
  }
  return row.timeZone;
}

function totalPageViews(
  rows: BookingPageViewBucketRow[],
  start?: BookingDate | null,
  end?: BookingDate | null,
): number {
  return rows.reduce((sum, row) => {
    const date = toDateString(row.bucketDate);
    return date && (!start || date >= start) && (!end || date <= end)
      ? sum + Number(row.pageViewCount)
      : sum;
  }, 0);
}

function inclusiveDays(start: BookingDate, end: BookingDate): number {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  );
}

function shiftIsoDate(value: BookingDate, days: number): BookingDate {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toPageViewBucket(row: BookingPageViewBucketRow): {
  date: BookingDate;
  count: number;
} {
  return {
    date: toDateString(row.bucketDate) ?? String(row.bucketDate),
    count: Number(row.pageViewCount),
  };
}

function averageNightlyRate(
  row: { revenueAmount: string | null; roomNightCount: string | null },
  currency: string,
): BookingMoney {
  const roomNights = numeric(row.roomNightCount);
  return money(roomNights > 0 ? numeric(row.revenueAmount) / roomNights : 0, currency);
}

function money(amount: number, currency: string): BookingMoney {
  return {
    amountDecimal: amount.toFixed(2),
    currency,
  };
}

function numeric(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDateString(value: string | Date | null | undefined): BookingDate | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function conversionFunnelSql(): string {
  return `${bookingScopedPropertyCte()}
  SELECT timezone.name AS "timeZone",
    (COALESCE(settings.show_addons_step, TRUE) AND EXISTS (
      SELECT 1 FROM booking.addon_definitions addon
      WHERE addon.property_id = scoped.property_id AND addon.status = 'active' AND addon.public_visible
    )) AS "addonsEnabled",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'sessionId', event.payload ->> 'sessionId',
      'sequence', event.payload -> 'metadata' -> 'funnelSequence',
      'stage', substring(event.event_type FROM 13),
      'paymentMethod', event.payload -> 'metadata' ->> 'paymentMethod'
    ) ORDER BY event.occurred_at, event.id)
    FROM platform.domain_events event
    WHERE property.profile_status = 'complete'
      AND event.property_id = scoped.property_id AND event.tenant_scope = 'property'
      AND event.source_system = 'distribution' AND event.resource_product = 'distribution'
      AND event.resource_type = 'booking_web_hotel'
      AND event.event_type IN ('booking_web.page_visit', 'booking_web.room_viewed',
        'booking_web.rate_selected', 'booking_web.addons_step_passed', 'booking_web.details_completed',
        'booking_web.complete_booking_clicked', 'booking_web.payment_authorized', 'booking_web.booking_completed')
      AND event.event_status IN ('recorded', 'projected')
      AND event.payload -> 'metadata' -> 'funnelVersion' = '1'::jsonb
      AND COALESCE(event.event_metadata ->> 'trafficClass', 'human') NOT IN ('bot', 'test')
      AND event.payload -> 'metadata' -> 'isTestData' IS DISTINCT FROM 'true'::jsonb
      AND event.payload -> 'metadata' -> 'testData' IS DISTINCT FROM 'true'::jsonb
      AND event.occurred_at >= ($2::date::timestamp AT TIME ZONE timezone.name)
      AND event.occurred_at < (($3::date + 1)::timestamp AT TIME ZONE timezone.name)
    ), '[]'::jsonb) AS events
  FROM scoped_property scoped
  JOIN hotel_catalog.properties property ON property.id = scoped.property_id
  LEFT JOIN hotel_catalog.property_locations location ON location.property_id = scoped.property_id
  LEFT JOIN pg_timezone_names timezone ON timezone.name = location.timezone
  LEFT JOIN booking.booking_settings settings ON settings.property_id = scoped.property_id`;
}
