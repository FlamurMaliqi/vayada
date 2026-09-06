import type {
  BookingReservationListFilters,
  BookingReservationsReadRepository,
} from "@vayada/domain-booking";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  toBookingReservationReadModel,
  type BookingReservationReadModelRow,
} from "./bookingReservationReadModel.js";
import { bookingScopedPropertyCte } from "./bookingDashboard.js";
import {
  BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL,
  guestContactForPropertyPlan,
  HIDDEN_GUEST_CONTACT,
  PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL,
} from "../domains/bookingGuestContactAccess.js";
import { readPropertyPlan } from "../domains/propertyPlanReadModel.js";

type BookingReservationsReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type TargetBookingReservationRow = BookingReservationReadModelRow & {
  propertyId: string;
  guestContactAccepted: boolean;
};

const TARGET_RESERVATION_STATUS_SQL = `CASE
  WHEN primary_assignment.assignment_status IN ('checked_in', 'in_house', 'checked_out')
    THEN primary_assignment.assignment_status
  WHEN booking.lifecycle_status IN ('draft', 'pending_payment')
    THEN 'pending'
  WHEN booking.lifecycle_status = 'canceled'
    THEN 'cancelled'
  ELSE booking.lifecycle_status
END`;

export function createTargetBookingReservationsReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingReservationsReadPool;
}): BookingReservationsReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Booking reservations repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async resolveCanonicalPropertyId(hotelId) {
      if (!hotelId.trim()) return null;
      const result = await pool.query<{ propertyId: string }>(
        `${bookingScopedPropertyCte()}
         SELECT property_id::text AS "propertyId" FROM scoped_property`,
        [hotelId],
      );
      return result.rows[0]?.propertyId ?? null;
    },
    async listReservationsByPropertyId(propertyId, filters) {
      if (!propertyId.trim()) {
        return { reservations: [], total: 0 };
      }

      const { whereSql, params } = toTargetReservationWhere(propertyId, filters);
      const listParams = [...params, filters.limit, filters.offset];
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;
      const guestEmailSql = filters.canReadGuestContact ? "COALESCE(booker.email, '')" : "''";
      const guestPhoneSql = filters.canReadGuestContact ? "COALESCE(booker.phone, '')" : "''";
      const guestContactColumnsSql = filters.canReadGuestContact
        ? ", guest.email, guest.phone"
        : "";

      const [reservationResult, countResult] = await Promise.all([
        pool.query<TargetBookingReservationRow>(
          `SELECT
             booking.id::text AS "id",
             booking.property_id::text AS "propertyId",
             booking.public_reference AS "bookingReference",
             COALESCE(room_type.id::text, quote.selected_offer_snapshot ->> 'roomTypeId', '') AS "roomTypeId",
             COALESCE(room_type.name, quote.selected_offer_snapshot ->> 'roomName', '') AS "roomName",
             COALESCE(
               NULLIF(room_type.occupancy_limits ->> 'maxOccupancy', '')::integer,
               NULLIF(room_type.occupancy_limits ->> 'total', '')::integer,
               NULLIF(
                 COALESCE(NULLIF(room_type.occupancy_limits ->> 'adults', '')::integer, 0)
                   + COALESCE(NULLIF(room_type.occupancy_limits ->> 'children', '')::integer, 0),
                 0
               ),
               booking.adults + booking.children,
               1
             ) AS "roomMaxOccupancy",
             COALESCE(booker.first_name, '') AS "guestFirstName",
             COALESCE(booker.last_name, '') AS "guestLastName",
             ${guestEmailSql} AS "guestEmail",
             ${guestPhoneSql} AS "guestPhone",
             ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL} AS "guestContactAccepted",
             booker.country_code AS "guestCountry",
             checkout.guest_input #>> '{booker,gender}' AS "guestGender",
             checkout.guest_input #>> '{booker,dateOfBirth}' AS "guestDateOfBirth",
             checkout.guest_input #>> '{booker,passportNumber}' AS "guestPassportNumber",
             COALESCE(booker.special_requests, checkout.guest_input ->> 'specialRequests', '') AS "specialRequests",
             COALESCE(booker.arrival_time, checkout.guest_input ->> 'arrivalTime') AS "estimatedArrivalTime",
             booking.adults + booking.children AS "numberOfGuests",
             booking.check_in::text AS "checkIn",
             booking.check_out::text AS "checkOut",
             booking.adults,
             booking.children,
             COALESCE(
               rate_plan.base_rate_amount,
               room_type.base_rate_amount,
               CASE
                 WHEN booking.check_out > booking.check_in AND booking.room_count > 0
                   THEN booking.total_amount / ((booking.check_out - booking.check_in) * booking.room_count)
                 ELSE booking.total_amount
               END
             ) AS "nightlyRate",
             booking.room_count AS "numberOfRooms",
             booking.total_amount AS "totalAmount",
             booking.currency,
             ${TARGET_RESERVATION_STATUS_SQL} AS "status",
             primary_room.id::text AS "roomId",
             primary_room.room_number AS "roomNumber",
             COALESCE(assigned_rooms.assigned_rooms, '[]'::jsonb) AS "assignedRooms",
             COALESCE(primary_assignment.channel, 'direct') AS "channel",
             COALESCE(booking.booking_metadata->>'paymentMethod', booking.expected_payment_method, payment.payment_method) AS "paymentMethod",
             booking.payment_status AS "paymentStatus",
             (
               COALESCE(NULLIF(quote.totals ->> 'depositDue', '')::numeric, 0) > 0
               OR COALESCE(
                    NULLIF(rate_plan.deposit_policy ->> 'depositPercent', '')::numeric,
                    NULLIF(payment_settings.deposit_policy ->> 'depositPercent', '')::numeric,
                    0
                  ) > 0
             ) AS "depositRequired",
             COALESCE(
               NULLIF(rate_plan.deposit_policy ->> 'depositPercent', '')::numeric,
               NULLIF(payment_settings.deposit_policy ->> 'depositPercent', '')::numeric
             ) AS "depositPercentage",
             COALESCE(NULLIF(quote.totals ->> 'depositDue', '')::numeric, 0) AS "depositAmount",
             booking.balance_amount AS "balanceAmount",
             COALESCE(checkin.pending_flags, '[]'::jsonb) AS "checkInPendingFlags",
             checkin.completed_at AS "checkedInAt",
             checkout_record.completed_at AS "checkedOutAt",
             NULLIF(booking.booking_metadata ->> 'hostResponseDeadline', '') AS "hostResponseDeadline",
             payment.fee_amount AS "platformFeeAmount",
             NULL::numeric AS "affiliateCommissionAmount",
             payment.net_amount AS "propertyPayoutAmount",
             COALESCE(addons.addon_ids, '[]'::jsonb) AS "addonIds",
             COALESCE(addons.addon_names, '[]'::jsonb) AS "addonNames",
             COALESCE(addons.addon_total, 0) AS "addonTotal",
             COALESCE(addons.addon_quantities, '{}'::jsonb) AS "addonQuantities",
             COALESCE(addons.addon_dates, '{}'::jsonb) AS "addonDates",
             EXISTS (
               SELECT 1
               FROM booking.booking_change_requests change_request
               WHERE change_request.guest_booking_id = booking.id
                 AND change_request.request_type = 'cancellation'
                 AND change_request.requested_by = 'guest'
                 AND change_request.status IN ('pending', 'accepted')
             ) AS "guestWithdrawn",
             promo.promo_code AS "promoCode",
             COALESCE(promo.discount_amount, 0) AS "promoDiscount",
             COALESCE(NULLIF(promo.metadata ->> 'lastMinuteDiscountPercent', '')::numeric, 0)
               AS "lastMinuteDiscountPercent",
             COALESCE(NULLIF(promo.metadata ->> 'lastMinuteDiscountAmount', '')::numeric, 0)
               AS "lastMinuteDiscountAmount",
             booking.created_at AS "createdAt",
             booking.updated_at AS "updatedAt"
           FROM booking.guest_bookings booking
           LEFT JOIN booking.checkout_contexts checkout
             ON checkout.id = booking.checkout_context_id
            AND checkout.property_id = booking.property_id
           LEFT JOIN booking.quote_sessions quote
             ON quote.id = booking.quote_session_id
            AND quote.property_id = booking.property_id
           LEFT JOIN LATERAL (
             SELECT
               guest.first_name,
               guest.last_name,
               guest.country_code,
               guest.special_requests,
               guest.arrival_time${guestContactColumnsSql}
             FROM booking.booking_guests guest
             WHERE guest.guest_booking_id = booking.id
             ORDER BY
               CASE guest.guest_role
                 WHEN 'booker' THEN 0
                 WHEN 'primary_guest' THEN 1
                 ELSE 2
               END,
               guest.created_at,
               guest.id
             LIMIT 1
           ) booker ON TRUE
           LEFT JOIN LATERAL (
             SELECT assignment.*
             FROM pms.operational_booking_assignments assignment
             WHERE assignment.guest_booking_id = booking.id
               AND assignment.property_id = booking.property_id
             ORDER BY assignment.position, assignment.created_at, assignment.id
             LIMIT 1
           ) primary_assignment ON TRUE
           LEFT JOIN pms.room_types room_type
             ON room_type.id = primary_assignment.room_type_id
            AND room_type.property_id = booking.property_id
           LEFT JOIN pms.rate_plans rate_plan
             ON rate_plan.id = primary_assignment.rate_plan_id
            AND rate_plan.property_id = booking.property_id
            AND rate_plan.room_type_id = primary_assignment.room_type_id
           LEFT JOIN pms.rooms primary_room
             ON primary_room.id = primary_assignment.room_id
            AND primary_room.property_id = booking.property_id
           LEFT JOIN finance.payment_settings payment_settings
             ON payment_settings.property_id = booking.property_id
           LEFT JOIN LATERAL (
             SELECT
               (array_agg(payment.payment_method ORDER BY payment.created_at DESC, payment.id))[1]
                 AS payment_method,
               COALESCE(
                 SUM(payment.fee_amount) FILTER (
                   WHERE payment.status IN ('authorized', 'paid', 'partially_refunded', 'refunded')
                 ),
                 0
               ) AS fee_amount,
               COALESCE(
                 SUM(payment.net_amount) FILTER (
                   WHERE payment.status IN ('authorized', 'paid', 'partially_refunded', 'refunded')
                 ),
                 0
               ) AS net_amount
             FROM finance.payments payment
             WHERE payment.guest_booking_id = booking.id
               AND payment.property_id = booking.property_id
               AND payment.payment_metadata->>'supersededByEdit' IS DISTINCT FROM 'true'
               AND (payment.payment_method <> 'card' OR booking.active_card_payment_id IS NULL OR booking.active_card_payment_id=payment.id)
           ) payment ON TRUE
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'roomId', room.id::text,
                        'roomNumber', room.room_number,
                        'position', assignment.zero_position
                      )
                      ORDER BY assignment.zero_position
                    ) AS assigned_rooms
             FROM (
               SELECT
                 assignment.*,
                 row_number() OVER (ORDER BY assignment.position, assignment.created_at, assignment.id) - 1
                   AS zero_position
               FROM pms.operational_booking_assignments assignment
               WHERE assignment.guest_booking_id = booking.id
                 AND assignment.property_id = booking.property_id
                 AND assignment.room_id IS NOT NULL
             ) assignment
             JOIN pms.rooms room
               ON room.id = assignment.room_id
              AND room.property_id = assignment.property_id
             WHERE primary_assignment.id IS NULL OR assignment.id <> primary_assignment.id
           ) assigned_rooms ON TRUE
           LEFT JOIN LATERAL (
             WITH expanded AS (
               SELECT item.*
               FROM booking.booking_addon_selection_items item
        JOIN booking.active_booking_addon_selections current_selection ON current_selection.id = item.selection_id
               WHERE item.guest_booking_id = booking.id
                 AND item.property_id = booking.property_id
             )
             SELECT
               jsonb_agg(grouped.addon_key ORDER BY grouped.first_created, grouped.addon_key)
                 AS addon_ids,
               jsonb_agg(grouped.addon_name ORDER BY grouped.first_created, grouped.addon_key)
                 AS addon_names,
               (
                 SELECT SUM(selection.total_amount)
                 FROM booking.active_booking_addon_selections selection
                 WHERE selection.guest_booking_id = booking.id
                   AND selection.property_id = booking.property_id
               ) AS addon_total,
               jsonb_object_agg(grouped.addon_key, grouped.quantity) AS addon_quantities,
               jsonb_object_agg(grouped.addon_key, grouped.service_dates) AS addon_dates
             FROM (
               SELECT
                 source.addon_key,
                 MIN(source.addon_name) AS addon_name,
                 SUM(source.quantity) AS quantity,
                 (
                   SELECT COALESCE(jsonb_agg(service_date.value ORDER BY service_date.value), '[]')
                   FROM expanded dated
                   CROSS JOIN LATERAL jsonb_array_elements_text(dated.service_dates)
                     AS service_date(value)
                   WHERE dated.addon_key = source.addon_key
                 ) AS service_dates,
                 MIN(source.created_at) AS first_created
               FROM expanded source
               GROUP BY source.addon_key
             ) grouped
           ) addons ON TRUE
           LEFT JOIN LATERAL (
             SELECT promo_application.*
             FROM booking.promo_applications promo_application
             WHERE promo_application.guest_booking_id = booking.id
               AND promo_application.property_id = booking.property_id
               AND promo_application.application_status = 'applied'
             ORDER BY promo_application.created_at DESC, promo_application.id
             LIMIT 1
           ) promo ON TRUE
           LEFT JOIN LATERAL (
             SELECT record.completed_at, record.pending_flags
             FROM pms.booking_checkin_records record
             WHERE record.guest_booking_id = booking.id
               AND record.property_id = booking.property_id
             ORDER BY record.completed_at DESC, record.id
             LIMIT 1
           ) checkin ON TRUE
           LEFT JOIN LATERAL (
             SELECT record.completed_at
             FROM pms.booking_checkout_records record
             WHERE record.guest_booking_id = booking.id
               AND record.property_id = booking.property_id
             ORDER BY record.completed_at DESC, record.id
             LIMIT 1
           ) checkout_record ON TRUE
           WHERE ${whereSql}
           ORDER BY booking.created_at DESC, booking.id
           LIMIT $${limitParam} OFFSET $${offsetParam}`,
          listParams,
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM booking.guest_bookings booking
           LEFT JOIN LATERAL (
             SELECT assignment.*
             FROM pms.operational_booking_assignments assignment
             WHERE assignment.guest_booking_id = booking.id
               AND assignment.property_id = booking.property_id
             ORDER BY assignment.position, assignment.created_at, assignment.id
             LIMIT 1
           ) primary_assignment ON TRUE
           WHERE ${whereSql}`,
          params,
        ),
      ]);

      const propertyPlan = reservationResult.rows[0]
        ? await readPropertyPlan(pool, reservationResult.rows[0].propertyId)
        : null;
      return {
        reservations: propertyPlan
          ? reservationResult.rows.map((reservation) => {
              const contact = filters.canReadGuestContact
                ? guestContactForPropertyPlan(propertyPlan, reservation.guestContactAccepted, {
                    email: reservation.guestEmail,
                    phone: reservation.guestPhone,
                  })
                : { email: HIDDEN_GUEST_CONTACT, phone: HIDDEN_GUEST_CONTACT };
              return toBookingReservationReadModel({
                ...reservation,
                guestEmail: contact.email ?? "",
                guestPhone: contact.phone ?? "",
              });
            })
          : [],
        total: parseCount(countResult.rows[0]?.total),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function toTargetReservationWhere(
  propertyId: string,
  filters: BookingReservationListFilters,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [propertyId];
  const conditions = ["booking.property_id = $1::uuid"];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`(${TARGET_RESERVATION_STATUS_SQL}) = $${params.length}`);
  }

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const guestEmailSearchSql = filters.canReadGuestContact
      ? `OR (
                (${PROPERTY_ALWAYS_HAS_GUEST_CONTACT_SQL}
                  OR ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL})
                AND guest.email ILIKE $${params.length}
              )`
      : "";
    conditions.push(
      `(booking.public_reference ILIKE $${params.length}
        OR EXISTS (
          SELECT 1
          FROM booking.booking_guests guest
          WHERE guest.guest_booking_id = booking.id
            AND (
              guest.first_name ILIKE $${params.length}
              OR guest.last_name ILIKE $${params.length}
              OR CONCAT(guest.first_name, ' ', guest.last_name) ILIKE $${params.length}
              ${guestEmailSearchSql}
            )
        )
        OR EXISTS (
          SELECT 1
          FROM pms.operational_booking_assignments assignment
          JOIN pms.room_types room_type
            ON room_type.id = assignment.room_type_id
           AND room_type.property_id = assignment.property_id
          LEFT JOIN pms.rooms room
            ON room.id = assignment.room_id
           AND room.property_id = assignment.property_id
          WHERE assignment.guest_booking_id = booking.id
            AND assignment.property_id = booking.property_id
            AND (
              room_type.name ILIKE $${params.length}
              OR room.room_number ILIKE $${params.length}
              OR assignment.pms_reservation_ref ILIKE $${params.length}
              OR assignment.external_reservation_id ILIKE $${params.length}
            )
        ))`,
    );
  }

  return {
    whereSql: conditions.join(" AND "),
    params,
  };
}

function parseCount(value: string | undefined): number {
  if (!value) return 0;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? count : 0;
}
