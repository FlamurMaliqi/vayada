import type {
  BookingDashboardMetricsPeriodInput,
  BookingDashboardMetricsReadModel,
  BookingDashboardMetricsReadPort,
  BookingDate,
  BookingMoney,
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

export function createTargetBookingDashboardMetricsReadPort(config: {
  connectionString: string;
  max?: number;
  pool?: BookingDashboardMetricsReadPool;
}): BookingDashboardMetricsReadPort & { close(): Promise<void> } {
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
    async getDashboardMetrics(input) {
      const [currentResult, previousResult] = await Promise.all([
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
      ]);

      const current = currentResult.rows[0];
      const previous = previousResult.rows[0];
      if (!current?.propertyFound || !previous?.propertyFound) return null;

      return {
        propertyId: input.propertyId,
        current: toRevenueStats(current),
        previous: toRevenueStats(previous),
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
      const result = await pool.query<BookingDashboardSparklineRow>(sparklineSql(), [
        input.propertyId,
        input.windowStart,
        input.windowEnd,
      ]);
      const currency = result.rows.find((row) => row.currency)?.currency ?? "USD";

      return {
        propertyId: input.propertyId,
        points: result.rows.map((row) => ({
          bucketStart: toDateString(row.bucketStart) ?? input.windowStart,
          bucketEnd: toDateString(row.bucketEnd) ?? input.windowEnd,
          revenue: money(numeric(row.revenueAmount), row.currency ?? currency),
          bookingCount: Number(row.bookingCount),
          avgNightlyRate: averageNightlyRate(row, row.currency ?? currency),
        })),
      } satisfies BookingSparklineReadModel;
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

export function bookingScopedPropertyCte(): string {
  return `WITH scoped_property_candidates AS (
    SELECT property.id AS property_id, 0 AS precedence
    FROM hotel_catalog.properties property
    WHERE property.id::text = $1
    UNION ALL
    SELECT source.property_id, 1 AS precedence
    FROM hotel_catalog.property_source_links source
    WHERE source.source_system = 'booking'
      AND source.source_table = 'booking_hotels'
      AND source.source_id = $1
      AND source.relationship = 'canonical_input'
      AND source.status = 'active'
  ),
  scoped_property AS (
    SELECT property_id
    FROM scoped_property_candidates
    ORDER BY precedence
    LIMIT 1
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

function toRevenueStats(
  row: BookingDashboardMetricsRow,
): BookingDashboardMetricsReadModel["current"] {
  const currency = row.currency ?? "USD";
  return {
    totalRevenue: money(numeric(row.revenueAmount), currency),
    bookingCount: Number(row.bookingCount),
    avgNightlyRate: averageNightlyRate(row, currency),
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
