import type {
  PlatformAdminDashboardPool,
  PlatformAdminGrowthGranularity,
} from "../routes/platform/admin/dashboard/bookingCompatible.js";

/** Platform reporting uses UTC dates across properties (VAY-928). */
export async function readGrowthTelemetry(
  pool: PlatformAdminDashboardPool,
  input: {
    propertyIds: string[];
    granularity: PlatformAdminGrowthGranularity;
    excludeTestData: boolean;
  },
) {
  const unit = { daily: "day", weekly: "week", monthly: "month" }[input.granularity];
  const { rows } = await pool.query<{
    key: string;
    label: string;
    views: string;
    requests: string;
  }>(
    `
    WITH buckets AS (
      SELECT start
      FROM generate_series(
        date_trunc($2, CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - (($3 - 1) || ' ' || $2)::interval,
        date_trunc($2, CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        ('1 ' || $2)::interval
      ) start
    ), scoped_properties AS (
      SELECT id FROM hotel_catalog.properties WHERE id::text = ANY($1::text[])
    ), views AS (
      SELECT event.id, event.occurred_at AT TIME ZONE 'UTC' AS occurred_at
      FROM platform.domain_events event
      WHERE event.source_system = 'distribution'
        AND event.event_type = 'booking_web.page_visit'
        AND event.resource_product = 'distribution'
        AND event.resource_type = 'booking_web_hotel'
        AND event.event_status IN ('recorded', 'projected')
        AND COALESCE(event.event_metadata ->> 'trafficClass', 'human') <> 'bot'
        AND (NOT $4::boolean OR (
          COALESCE(event.event_metadata ->> 'trafficClass', 'human') <> 'test'
          AND event.payload -> 'metadata' -> 'isTestData' IS DISTINCT FROM 'true'::jsonb
          AND event.payload -> 'metadata' -> 'testData' IS DISTINCT FROM 'true'::jsonb
        ))
        AND (
          (event.tenant_scope = 'property' AND event.property_id IN (SELECT id FROM scoped_properties))
          OR (event.tenant_scope = 'external' AND event.property_id IS NULL
            AND event.resource_id IN (
              SELECT slug.slug FROM hotel_catalog.property_slugs slug
              JOIN scoped_properties property ON property.id = slug.property_id
            )
            AND 1 = (SELECT COUNT(DISTINCT property_id) FROM hotel_catalog.property_slugs WHERE slug = event.resource_id)
          )
        )
        AND event.occurred_at >= (SELECT MIN(start) AT TIME ZONE 'UTC' FROM buckets)
        AND event.occurred_at <= CURRENT_TIMESTAMP
    ), requests AS (
      SELECT booking.id, booking.created_at AT TIME ZONE 'UTC' AS occurred_at
      FROM booking.guest_bookings booking
      JOIN scoped_properties property ON property.id = booking.property_id
      WHERE booking.created_at >= (SELECT MIN(start) AT TIME ZONE 'UTC' FROM buckets)
        AND booking.created_at <= CURRENT_TIMESTAMP
        AND (NOT $4::boolean OR (
          booking.booking_metadata -> 'operationalEvidence' -> 'isTestBooking' IS DISTINCT FROM 'true'::jsonb
          AND booking.booking_metadata -> 'isTestBooking' IS DISTINCT FROM 'true'::jsonb
          AND booking.booking_metadata -> 'isTestData' IS DISTINCT FROM 'true'::jsonb
          AND booking.booking_metadata -> 'testData' IS DISTINCT FROM 'true'::jsonb
        ))
    ), view_counts AS (
      SELECT date_trunc($2, occurred_at) AS start, COUNT(*)::text AS count FROM views GROUP BY 1
    ), request_counts AS (
      SELECT date_trunc($2, occurred_at) AS start, COUNT(*)::text AS count FROM requests GROUP BY 1
    )
    SELECT to_char(bucket.start, 'YYYY-MM-DD') AS key,
      to_char(bucket.start, CASE WHEN $2 = 'month' THEN 'Mon YYYY' ELSE 'Mon FMDD' END) AS label,
      COALESCE(views.count, '0') AS views, COALESCE(requests.count, '0') AS requests
    FROM buckets bucket
    LEFT JOIN view_counts views ON views.start = bucket.start
    LEFT JOIN request_counts requests ON requests.start = bucket.start
    ORDER BY bucket.start
  `,
    [input.propertyIds, unit, input.granularity === "daily" ? 30 : 12, input.excludeTestData],
  );
  return {
    pageViews: rows.map(({ key, label, views }) => ({ key, label, value: Number(views) })),
    bookingRequests: rows.map(({ key, label, requests }) => ({
      key,
      label,
      value: Number(requests),
    })),
  };
}
