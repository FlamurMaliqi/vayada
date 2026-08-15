import type { PropertyPlanReadModel } from "@vayada/domain-finance";
import pg from "pg";

import {
  BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL,
  guestContactForPropertyPlan,
} from "./bookingGuestContactAccess.js";
import { readPropertyPlan } from "./propertyPlanReadModel.js";

export type PmsDecimalAmount = string;
export type PmsCurrencyCode = string;
export type PmsDate = string;
export type PmsUtcDateTime = string;
export type PmsJsonScalar = string | number | boolean | null;
export type PmsJsonValue = PmsJsonScalar | PmsJsonValue[] | { [key: string]: PmsJsonValue };
export type PmsJsonRecord = Record<string, PmsJsonValue>;

export type PmsMoney = {
  amountDecimal: PmsDecimalAmount;
  currency: PmsCurrencyCode;
};

export type PmsRoomStatus = "available" | "maintenance" | "out_of_order" | "retired";

export type PmsRoom = {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: PmsRoomStatus;
  sortOrder: number;
  metadata: PmsJsonRecord;
};

export type PmsRatePlan = {
  ratePlanId: string;
  pricingContractVersion?: string | null;
  code: string;
  name: string;
  rateType: "flexible" | "non_refundable" | "package" | "manual";
  mealPlan: string | null;
  baseRate: PmsMoney;
  active: boolean;
};

export type PmsRateRulesSummary = {
  minStayNights: number | null;
  maxStayNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  activeRuleCount: number;
};

export type PmsRoomTypeMedia = {
  mediaObjectId?: string;
  url: string;
  altText?: string | null;
};

export type PmsRoomType = {
  roomTypeId: string;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: Record<string, number>;
  attributes: PmsJsonRecord;
  amenities: string[];
  media: PmsRoomTypeMedia[];
  roomMediaRevision?: number;
  baseRate: PmsMoney;
  active: boolean;
  sortOrder: number;
  ratePlans: PmsRatePlan[];
  rateRulesSummary: PmsRateRulesSummary;
  roomCount: number;
};

export type PmsSourceFreshness = PmsJsonRecord;

export type PmsRoomBlockStatus = "active" | "released" | "expired";

export type PmsRoomBlockSummary = {
  blockId: string;
  version: string;
  roomTypeId: string;
  roomId: string | null;
  startsOn: PmsDate;
  endsOn: PmsDate;
  blockedCount: number;
  reason: string;
  status: PmsRoomBlockStatus;
};

export type PmsCalendarStatus = "open" | "closed" | "limited";

export type PmsCalendarDay = {
  stayDate: PmsDate;
  roomTypeId: string;
  totalCount: number;
  assignedCount: number;
  blockedCount: number;
  availableCount: number;
  status: PmsCalendarStatus;
  blocks: PmsRoomBlockSummary[];
  assignmentRefs: string[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsReservationSource = "direct_booking" | "channel" | "manual" | "migration";

export type PmsOperationalAssignmentStatus =
  | "pending"
  | "assigned"
  | "checked_in"
  | "in_house"
  | "checked_out"
  | "canceled"
  | "released";

export type PmsExpectedPaymentMethod =
  | "unknown"
  | "pay_at_property"
  | "bank_transfer"
  | "manual_card"
  | "cash"
  | "other";

export type PmsOperationalNight = {
  serviceDate: PmsDate;
  applied: PmsMoney | null;
  evidenceQuality: "exact" | "inferred" | "missing";
};

export type PmsOperationalAssignment = {
  assignmentId: string;
  roomTypeId: string;
  ratePlanId: string | null;
  roomId: string | null;
  roomNumber: string | null;
  position: number;
  assignmentStatus: PmsOperationalAssignmentStatus;
  channel: string;
  assignedAt: PmsUtcDateTime | null;
  stay?: { checkIn: PmsDate; checkOut: PmsDate; adults: number; children: number };
  nightly?: PmsOperationalNight[];
};

export type PmsOperationalReservation = {
  guestBookingId: string;
  bookingReference: string;
  status: string;
  source: PmsReservationSource;
  stay: { checkIn: PmsDate; checkOut: PmsDate; adults: number; children: number };
  primaryGuest: {
    displayName: string;
    email: string | null;
    phone: string | null;
    countryCode: string | null;
  };
  assignments: PmsOperationalAssignment[];
  checkin: { completedAt: PmsUtcDateTime | null; pendingFlags: string[] };
  checkout: { completedAt: PmsUtcDateTime | null; pendingFlags: string[] };
  privateNoteCount: number;
  additionalGuestCount: number;
  bookedOffer?: { roomTypeId: string; roomName: string };
  roomCount?: number;
  pricing?: { totalAmount: PmsMoney; balanceAmount: PmsMoney };
  payment?: {
    method: string | null;
    expectedMethod?: PmsExpectedPaymentMethod;
    status: string;
    breakdown?: {
      grossAmount: PmsMoney;
      stripeFee: PmsMoney;
      vayadaCommission: PmsMoney;
      netPayout: PmsMoney;
    };
  };
  hostResponseDeadlineAt?: PmsUtcDateTime | null;
};

export type PmsReservationListFilters = {
  status?: string;
  arrivalFrom?: PmsDate;
  arrivalTo?: PmsDate;
  search?: string;
  limit: number;
  offset: number;
};

export type PmsOperationsReadResult<T> = {
  items: T[];
  sourceFreshness?: PmsSourceFreshness;
};

export type PmsOperationsPaginatedReadResult<T> = PmsOperationsReadResult<T> & {
  total: number;
};

export type PmsOperationsReadRepository = {
  listRoomsByPropertyId(propertyId: string): Promise<PmsOperationsReadResult<PmsRoom>>;
  listRoomTypesByPropertyId(propertyId: string): Promise<PmsOperationsReadResult<PmsRoomType>>;
  findRoomTypeById(propertyId: string, roomTypeId: string): Promise<PmsRoomType | null>;
  listCalendarDaysByPropertyId(
    propertyId: string,
    range: { from: PmsDate; to: PmsDate },
  ): Promise<PmsOperationsReadResult<PmsCalendarDay>>;
  listRoomBlocksByPropertyId(
    propertyId: string,
    range?: { from?: PmsDate; to?: PmsDate },
  ): Promise<PmsOperationsReadResult<PmsRoomBlockSummary>>;
  listReservationsByPropertyId(
    propertyId: string,
    filters: PmsReservationListFilters,
  ): Promise<PmsOperationsPaginatedReadResult<PmsOperationalReservation>>;
  listReservationsOverlappingStayRangeByPropertyId?(
    propertyId: string,
    range: { from: PmsDate; to: PmsDate },
  ): Promise<PmsOperationsPaginatedReadResult<PmsOperationalReservation>>;
  findReservationByGuestBookingId(
    propertyId: string,
    guestBookingId: string,
  ): Promise<PmsOperationalReservation | null>;
  close?(): Promise<void>;
};

export type PmsManualBookingAvailabilityReadPort = {
  getPhysicalRoomAvailability(
    propertyId: string,
    stays: readonly { roomId: string; checkIn: PmsDate; checkOut: PmsDate }[],
  ): Promise<readonly (boolean | null)[]>;
};

export type PmsOperationsReadPool = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<pg.QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

export function createTargetPmsOperationsReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PmsOperationsReadPool;
}): PmsOperationsReadRepository & PmsManualBookingAvailabilityReadPort {
  if (!config.connectionString.trim()) {
    throw new Error("PMS operations repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listRoomsByPropertyId(propertyId) {
      const result = await pool.query<TargetPmsRoomRow>(
        `SELECT
           room.id::text AS "roomId",
           room.room_type_id::text AS "roomTypeId",
           room.room_number AS "roomNumber",
           room.floor,
           room.status,
           room.sort_order AS "sortOrder",
           room.room_metadata AS "metadata"
         FROM pms.rooms room
         JOIN pms.room_types room_type
           ON room_type.id = room.room_type_id
          AND room_type.property_id = room.property_id
         WHERE room.property_id = $1
         ORDER BY room.sort_order ASC, room.room_number ASC`,
        [propertyId],
      );

      return {
        items: result.rows.map(toPmsRoom),
        sourceFreshness: {},
      };
    },

    async listRoomTypesByPropertyId(propertyId) {
      return listRoomTypes(pool, propertyId);
    },

    async getPhysicalRoomAvailability(propertyId, stays) {
      const result = await pool.query<{ available: boolean | null }>(
        `WITH requested AS (
           SELECT position::integer,
                  (value->>'roomId')::uuid AS room_id,
                  (value->>'checkIn')::date AS check_in,
                  (value->>'checkOut')::date AS check_out
           FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS input(value, position)
         )
         SELECT CASE WHEN room.id IS NULL THEN NULL ELSE
         room.status = 'available'
         AND room.operational_label_status = 'verified'
         AND room.room_number IS NOT NULL
         AND requested.check_in < requested.check_out
         AND NOT EXISTS (
           SELECT 1 FROM requested sibling
           WHERE sibling.position <> requested.position
             AND sibling.room_id = requested.room_id
             AND sibling.check_in < requested.check_out
             AND sibling.check_out > requested.check_in
         )
         AND NOT EXISTS (
           SELECT 1 FROM pms.room_blocks block
           WHERE block.property_id = room.property_id AND block.room_id = room.id
             AND block.status = 'active'
             AND block.starts_on < requested.check_out AND block.ends_on >= requested.check_in
         ) AND NOT EXISTS (
           SELECT 1 FROM pms.operational_booking_assignments assignment
           JOIN booking.guest_bookings booking
             ON booking.id = assignment.guest_booking_id
            AND booking.property_id = assignment.property_id
           WHERE assignment.property_id = room.property_id AND assignment.room_id = room.id
             AND assignment.assignment_status NOT IN ('canceled', 'released')
             AND COALESCE(assignment.check_in, booking.check_in) < requested.check_out
             AND COALESCE(assignment.check_out, booking.check_out) > requested.check_in
         ) AND NOT EXISTS (
           SELECT 1
           FROM generate_series(
             requested.check_in, requested.check_out - 1, interval '1 day'
           ) AS dates(stay_date)
           WHERE NOT EXISTS (
             SELECT 1
             FROM pms.inventory_days inventory
             WHERE inventory.property_id = room.property_id
               AND inventory.room_type_id = room.room_type_id
               AND inventory.stay_date = dates.stay_date
               AND inventory.status <> 'closed'
               AND inventory.effective_sellable_limit_count IS NOT NULL
               AND inventory.available_count >= (
                 SELECT COUNT(*)
                 FROM requested sibling
                 JOIN pms.rooms sibling_room
                   ON sibling_room.property_id = room.property_id
                  AND sibling_room.id = sibling.room_id
                  AND sibling_room.room_type_id = room.room_type_id
                 WHERE sibling.check_in <= dates.stay_date AND sibling.check_out > dates.stay_date
               )
           )
         ) END AS available
         FROM requested
         LEFT JOIN pms.rooms room
           ON room.property_id = $1::uuid AND room.id = requested.room_id
         ORDER BY requested.position`,
        [propertyId, JSON.stringify(stays)],
      );
      return result.rows.map((row) => row.available);
    },

    async findRoomTypeById(propertyId, roomTypeId) {
      const result = await listRoomTypes(pool, propertyId, roomTypeId);
      return result.items[0] ?? null;
    },

    async listCalendarDaysByPropertyId(propertyId, range) {
      const result = await pool.query<TargetPmsCalendarDayRow>(
        `SELECT
           inventory.stay_date::text AS "stayDate",
           inventory.room_type_id::text AS "roomTypeId",
           inventory.total_count AS "totalCount",
           inventory.assigned_count AS "assignedCount",
           inventory.blocked_count AS "blockedCount",
           inventory.available_count AS "availableCount",
           inventory.status,
           inventory.source_freshness AS "sourceFreshness",
           COALESCE(blocks.items, '[]'::jsonb) AS "blocks",
           COALESCE(assignments.refs, '[]'::jsonb) AS "assignmentRefs"
         FROM pms.inventory_days inventory
         JOIN pms.room_types room_type
           ON room_type.id = inventory.room_type_id
          AND room_type.property_id = inventory.property_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'blockId', block.id::text,
                      'version', concat('room-block-v', block.revision),
                      'roomTypeId', block.room_type_id::text,
                      'roomId', block.room_id::text,
                      'startsOn', block.starts_on::text,
                      'endsOn', block.ends_on::text,
                      'blockedCount', block.blocked_count,
                      'reason', block.reason,
                      'status', block.status
                    )
                    ORDER BY block.starts_on ASC, block.id ASC
                  ) AS items
           FROM pms.room_blocks block
           WHERE block.property_id = inventory.property_id
             AND block.room_type_id = inventory.room_type_id
             AND block.status = 'active'
             AND block.starts_on <= inventory.stay_date
             AND block.ends_on >= inventory.stay_date
         ) blocks ON TRUE
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(assignment.id::text ORDER BY assignment.position, assignment.id) AS refs
           FROM pms.operational_booking_assignments assignment
           JOIN booking.guest_bookings booking
             ON booking.id = assignment.guest_booking_id
            AND booking.property_id = assignment.property_id
           WHERE assignment.property_id = inventory.property_id
             AND assignment.room_type_id = inventory.room_type_id
             AND assignment.assignment_status NOT IN ('canceled', 'released')
             AND COALESCE(assignment.check_in, booking.check_in) <= inventory.stay_date
             AND COALESCE(assignment.check_out, booking.check_out) > inventory.stay_date
         ) assignments ON TRUE
         WHERE inventory.property_id = $1
           AND inventory.stay_date >= $2::date
           AND inventory.stay_date <= $3::date
         ORDER BY inventory.stay_date ASC, room_type.sort_order ASC`,
        [propertyId, range.from, range.to],
      );

      return {
        items: result.rows.map(toPmsCalendarDay),
        sourceFreshness: {},
      };
    },

    async listRoomBlocksByPropertyId(propertyId, range) {
      const { whereSql, params } = toRoomBlockWhere(propertyId, range);
      const result = await pool.query<TargetPmsRoomBlockRow>(
        `SELECT
           block.id::text AS "blockId",
           block.revision,
           block.room_type_id::text AS "roomTypeId",
           block.room_id::text AS "roomId",
           block.starts_on AS "startsOn",
           block.ends_on AS "endsOn",
           block.blocked_count AS "blockedCount",
           block.reason,
           block.status
         FROM pms.room_blocks block
         JOIN pms.room_types room_type
           ON room_type.id = block.room_type_id
          AND room_type.property_id = block.property_id
         WHERE ${whereSql}
         ORDER BY block.starts_on ASC, room_type.sort_order ASC, block.id ASC`,
        params,
      );

      return {
        items: result.rows.map(toPmsRoomBlockSummary),
        sourceFreshness: {},
      };
    },

    async listReservationsByPropertyId(propertyId, filters) {
      const propertyPlan = await readPropertyPlan(pool, propertyId);
      const { whereSql, params } = toReservationWhere(propertyId, filters, propertyPlan);
      const listParams = [...params, filters.limit, filters.offset];
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;

      const [reservationResult, countResult] = await Promise.all([
        pool.query<TargetPmsOperationalReservationRow>(
          `${PMS_OPERATIONAL_RESERVATION_SELECT_SQL}
           WHERE ${whereSql}
           ORDER BY booking.check_in ASC, booking.public_reference ASC
           LIMIT $${limitParam} OFFSET $${offsetParam}`,
          listParams,
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
	           FROM booking.guest_bookings booking
	           LEFT JOIN LATERAL (
	             SELECT assignment.assignment_status, assignment.assignment_payload
	             FROM pms.operational_booking_assignments assignment
	             WHERE assignment.guest_booking_id = booking.id
	               AND assignment.property_id = booking.property_id
             ORDER BY assignment.position, assignment.created_at, assignment.id
             LIMIT 1
           ) primary_assignment ON TRUE
           LEFT JOIN LATERAL (
             SELECT guest.first_name, guest.last_name, guest.email, guest.phone
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
           ) primary_guest ON TRUE
           WHERE ${whereSql}`,
          params,
        ),
      ]);

      return {
        items: reservationResult.rows.map((row) => toPmsOperationalReservation(row, propertyPlan)),
        total: toInteger(countResult.rows[0]?.total ?? 0),
        sourceFreshness: {},
      };
    },

    async listReservationsOverlappingStayRangeByPropertyId(propertyId, range) {
      const result = await pool.query<TargetPmsOperationalReservationRow>(
        `${PMS_OPERATIONAL_RESERVATION_SELECT_SQL}
         WHERE booking.property_id = $1
           AND booking.check_in < $2::date
           AND booking.check_out > $3::date
         ORDER BY booking.check_in ASC, booking.public_reference ASC`,
        [propertyId, range.to, range.from],
      );

      const propertyPlan = result.rows.length ? await readPropertyPlan(pool, propertyId) : null;
      return {
        items: propertyPlan
          ? result.rows.map((row) => toPmsOperationalReservation(row, propertyPlan))
          : [],
        total: result.rows.length,
        sourceFreshness: {},
      };
    },

    async findReservationByGuestBookingId(propertyId, guestBookingId) {
      const result = await pool.query<TargetPmsOperationalReservationRow>(
        `${PMS_OPERATIONAL_RESERVATION_SELECT_SQL}
         WHERE booking.property_id = $1
           AND booking.id = $2`,
        [propertyId, guestBookingId],
      );

      if (!result.rows[0]) return null;
      const propertyPlan = await readPropertyPlan(pool, propertyId);
      return toPmsOperationalReservation(result.rows[0], propertyPlan);
    },

    async close() {
      await pool.end?.();
    },
  };
}

type TargetPmsRoomRow = {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: PmsRoomStatus;
  sortOrder: number;
  metadata: unknown;
};

type TargetPmsRoomTypeRow = {
  roomTypeId: string;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: unknown;
  attributes: unknown;
  amenities: unknown;
  media: unknown;
  roomMediaRevision: string | number;
  baseRateAmount: string | number;
  currency: string;
  active: boolean;
  sortOrder: number;
  ratePlans: unknown;
  minStayNights: number | null;
  maxStayNights: number | null;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  activeRuleCount: string | number;
  roomCount: string | number;
};

type TargetPmsRoomBlockRow = {
  blockId: string;
  revision: number;
  roomTypeId: string;
  roomId: string | null;
  startsOn: Date | string;
  endsOn: Date | string;
  blockedCount: number;
  reason: string;
  status: PmsRoomBlockStatus;
};

type TargetPmsCalendarDayRow = {
  stayDate: Date | string;
  roomTypeId: string;
  totalCount: number;
  assignedCount: number;
  blockedCount: number;
  availableCount: number;
  status: PmsCalendarStatus;
  blocks: unknown;
  assignmentRefs: unknown;
  sourceFreshness: unknown;
};

type TargetPmsOperationalReservationRow = {
  guestBookingId: string;
  bookingReference: string;
  status: string;
  source: PmsReservationSource;
  checkIn: Date | string;
  checkOut: Date | string;
  adults: number;
  children: number;
  primaryGuestDisplayName: string | null;
  primaryGuestEmail: string | null;
  primaryGuestPhone: string | null;
  primaryGuestCountryCode: string | null;
  guestContactAccepted: boolean;
  assignments: unknown;
  checkinCompletedAt: Date | string | null;
  checkinPendingFlags: unknown;
  checkoutCompletedAt: Date | string | null;
  checkoutPendingFlags: unknown;
  privateNoteCount: string | number;
  additionalGuestCount: string | number;
  bookedRoomTypeId: string;
  bookedRoomName: string;
  roomCount: string | number;
  totalAmount: string | number;
  balanceAmount: string | number;
  currency: string;
  paymentMethod: string | null;
  expectedPaymentMethod: PmsExpectedPaymentMethod;
  paymentStatus: string;
  paymentBreakdown: unknown;
  hostResponseDeadlineAt: string | null;
};

const PMS_OPERATIONAL_RESERVATION_STATUS_SQL = `CASE
  WHEN primary_assignment.assignment_payload ->> 'operationalStatus' = 'no_show'
    THEN 'no_show'
  WHEN primary_assignment.assignment_status IN ('checked_in', 'in_house', 'checked_out')
    THEN primary_assignment.assignment_status
  ELSE booking.lifecycle_status
END`;

const PMS_OPERATIONAL_RESERVATION_SOURCE_SQL = `COALESCE(
  primary_assignment.source,
  CASE
    WHEN booking.source_system = 'migration' THEN 'migration'
    WHEN booking.source_system = 'pms' THEN 'migration'
    ELSE 'direct_booking'
  END
)`;

const PMS_OPERATIONAL_RESERVATION_SELECT_SQL = `SELECT
  booking.id::text AS "guestBookingId",
  booking.public_reference AS "bookingReference",
  ${PMS_OPERATIONAL_RESERVATION_STATUS_SQL} AS "status",
  ${PMS_OPERATIONAL_RESERVATION_SOURCE_SQL} AS "source",
  booking.check_in::text AS "checkIn",
  booking.check_out::text AS "checkOut",
  booking.adults,
  booking.children,
  NULLIF(
    trim(
      concat_ws(
        ' ',
        NULLIF(primary_guest.first_name, ''),
        NULLIF(primary_guest.last_name, '')
      )
    ),
    ''
  ) AS "primaryGuestDisplayName",
  primary_guest.email AS "primaryGuestEmail",
  primary_guest.phone AS "primaryGuestPhone",
  primary_guest.country_code AS "primaryGuestCountryCode",
  ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL} AS "guestContactAccepted",
  COALESCE(
    NULLIF(quote.selected_offer_snapshot ->> 'roomTypeId', ''),
    NULLIF(booking.booking_metadata #>> '{selectedOffer,roomTypeId}', ''),
    ''
  ) AS "bookedRoomTypeId",
  COALESCE(
    NULLIF(quote.selected_offer_snapshot ->> 'roomName', ''),
    NULLIF(booking.booking_metadata #>> '{selectedOffer,roomName}', ''),
    ''
  ) AS "bookedRoomName",
  booking.room_count AS "roomCount",
  booking.total_amount AS "totalAmount",
  booking.balance_amount AS "balanceAmount",
  booking.currency,
  booking.booking_metadata ->> 'paymentMethod' AS "paymentMethod",
  booking.expected_payment_method AS "expectedPaymentMethod",
  booking.payment_status AS "paymentStatus",
  card_payment.breakdown AS "paymentBreakdown",
  COALESCE(
    booking.booking_metadata ->> 'acceptedPaymentDeadlineAt',
    booking.booking_metadata ->> 'hostResponseDeadlineAt',
    booking.booking_metadata ->> 'pendingExpiresAt'
  ) AS "hostResponseDeadlineAt",
  COALESCE(assignments.items, '[]'::jsonb) AS "assignments",
  checkin.completed_at AS "checkinCompletedAt",
  COALESCE(checkin.pending_flags, '[]'::jsonb) AS "checkinPendingFlags",
  checkout.completed_at AS "checkoutCompletedAt",
  COALESCE(checkout.pending_flags, '[]'::jsonb) AS "checkoutPendingFlags",
  COALESCE(private_notes.note_count, 0) AS "privateNoteCount",
  COALESCE(additional_guests.guest_count, 0) AS "additionalGuestCount"
FROM booking.guest_bookings booking
LEFT JOIN booking.quote_sessions quote
  ON quote.id = booking.quote_session_id
 AND quote.property_id = booking.property_id
LEFT JOIN LATERAL (
  SELECT jsonb_build_object(
           'grossAmount', jsonb_build_object(
             'amountDecimal', payment.processor_fee_breakdown ->> 'grossAmount',
             'currency', payment.processor_fee_breakdown ->> 'currency'
           ),
           'stripeFee', jsonb_build_object(
             'amountDecimal', payment.processor_fee_breakdown ->> 'stripeFeeAmount',
             'currency', payment.processor_fee_breakdown ->> 'currency'
           ),
           'vayadaCommission', jsonb_build_object(
             'amountDecimal', payment.processor_fee_breakdown ->> 'applicationFeeAmount',
             'currency', payment.processor_fee_breakdown ->> 'currency'
           ),
           'netPayout', jsonb_build_object(
             'amountDecimal', payment.processor_fee_breakdown ->> 'netPayoutAmount',
             'currency', payment.processor_fee_breakdown ->> 'currency'
           )
         ) AS breakdown
  FROM finance.payments payment
  WHERE payment.property_id = booking.property_id
    AND payment.guest_booking_id = booking.id
    AND payment.payment_method = 'card'
    AND payment.payment_metadata ->> 'chargeType' = 'direct'
    AND payment.processor_fee_breakdown ->> 'status' = 'available'
  ORDER BY payment.created_at DESC, payment.id DESC
  LIMIT 1
) card_payment ON TRUE
LEFT JOIN LATERAL (
  SELECT assignment.*
  FROM pms.operational_booking_assignments assignment
  WHERE assignment.guest_booking_id = booking.id
    AND assignment.property_id = booking.property_id
  ORDER BY assignment.position, assignment.created_at, assignment.id
  LIMIT 1
) primary_assignment ON TRUE
LEFT JOIN LATERAL (
  SELECT guest.first_name, guest.last_name, guest.email, guest.phone, guest.country_code
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
) primary_guest ON TRUE
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
           jsonb_build_object(
             'assignmentId', assignment.id::text,
             'roomTypeId', assignment.room_type_id::text,
             'ratePlanId', assignment.rate_plan_id::text,
             'roomId', assignment.room_id::text,
             'roomNumber', room.room_number,
             'position', assignment.position,
             'assignmentStatus', assignment.assignment_status,
             'channel', assignment.channel,
             'assignedAt', to_jsonb(assignment.assigned_at),
             'stay', CASE WHEN assignment.stay_evidence_kind = 'exact' THEN
               jsonb_build_object(
                 'checkIn', assignment.check_in::text,
                 'checkOut', assignment.check_out::text,
                 'adults', assignment.adults,
                 'children', assignment.children
               )
             END,
             'nightly', COALESCE(nightly.items, '[]'::jsonb)
           )
           ORDER BY assignment.position, assignment.created_at, assignment.id
         ) AS items
  FROM pms.operational_booking_assignments assignment
  LEFT JOIN pms.rooms room
    ON room.id = assignment.room_id
   AND room.property_id = assignment.property_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'serviceDate', applied.stay_date::text,
               'applied', CASE WHEN applied.amount IS NULL THEN NULL ELSE
                 jsonb_build_object(
                   'amountDecimal', applied.amount::text,
                   'currency', applied.currency
                 )
               END,
               'evidenceQuality', applied.evidence_quality
             ) ORDER BY applied.stay_date
           ) AS items
    FROM (
      SELECT evidence.stay_date, evidence.currency,
        CASE WHEN COUNT(evidence.gross_room_amount) = 0 THEN NULL
          ELSE SUM(evidence.gross_room_amount) END AS amount,
        (array_agg(evidence.evidence_quality ORDER BY evidence.source_revision DESC,
          evidence.created_at DESC,evidence.id DESC))[1] AS evidence_quality
      FROM booking.nightly_revenue_evidence evidence
      WHERE evidence.property_id = assignment.property_id
        AND evidence.guest_booking_id = assignment.guest_booking_id
        AND evidence.room_type_id = assignment.room_type_id
        AND evidence.line_position = assignment.position
        AND evidence.economic_event NOT IN ('refund','retained_charge')
        AND (assignment.stay_evidence_kind <> 'exact' OR
          (evidence.stay_date >= assignment.check_in AND evidence.stay_date < assignment.check_out))
      GROUP BY evidence.stay_date, evidence.currency
    ) applied
  ) nightly ON TRUE
  WHERE assignment.guest_booking_id = booking.id
    AND assignment.property_id = booking.property_id
) assignments ON TRUE
LEFT JOIN LATERAL (
  SELECT record.completed_at, record.pending_flags
  FROM pms.booking_checkin_records record
  WHERE record.guest_booking_id = booking.id
    AND record.property_id = booking.property_id
  ORDER BY record.completed_at DESC, record.id DESC
  LIMIT 1
) checkin ON TRUE
LEFT JOIN LATERAL (
  SELECT record.completed_at, record.pending_flags
  FROM pms.booking_checkout_records record
  WHERE record.guest_booking_id = booking.id
    AND record.property_id = booking.property_id
  ORDER BY record.completed_at DESC, record.id DESC
  LIMIT 1
) checkout ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS note_count
  FROM pms.booking_notes_private note
  WHERE note.guest_booking_id = booking.id
    AND note.property_id = booking.property_id
) private_notes ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS guest_count
  FROM booking.booking_guests guest
  WHERE guest.guest_booking_id = booking.id
    AND guest.guest_role = 'additional_guest'
) additional_guests ON TRUE`;

async function listRoomTypes(
  pool: PmsOperationsReadPool,
  propertyId: string,
  roomTypeId?: string,
): Promise<PmsOperationsReadResult<PmsRoomType>> {
  const params: unknown[] = [propertyId];
  const roomTypeFilter = roomTypeId ? "AND room_type.id = $2" : "";
  if (roomTypeId) params.push(roomTypeId);

  const result = await pool.query<TargetPmsRoomTypeRow>(
    `SELECT
       room_type.id::text AS "roomTypeId",
       room_type.name,
       room_type.description,
       room_type.category,
       room_type.occupancy_limits AS "occupancyLimits",
       room_type.room_attributes AS "attributes",
       room_type.amenities_snapshot AS "amenities",
       CASE
         WHEN jsonb_typeof(room_type.media_snapshot) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(room_type.media_snapshot) legacy_media(item)
            WHERE jsonb_typeof(legacy_media.item) <> 'object'
               OR jsonb_typeof(legacy_media.item -> 'mediaObjectId') IS DISTINCT FROM 'string'
          )
           THEN room_type.media_snapshot
         ELSE COALESCE(room_media.items, room_type.media_snapshot)
       END AS "media",
       room_type.room_media_revision AS "roomMediaRevision",
       room_type.base_rate_amount AS "baseRateAmount",
       room_type.currency,
       room_type.active,
       room_type.sort_order AS "sortOrder",
       COALESCE(rate_plans.items, '[]'::jsonb) AS "ratePlans",
       rate_rules.min_stay_nights AS "minStayNights",
       rate_rules.max_stay_nights AS "maxStayNights",
       COALESCE(rate_rules.closed_to_arrival, FALSE) AS "closedToArrival",
       COALESCE(rate_rules.closed_to_departure, FALSE) AS "closedToDeparture",
       COALESCE(rate_rules.active_rule_count, 0) AS "activeRuleCount",
       COALESCE(room_counts.room_count, 0) AS "roomCount"
     FROM pms.room_types room_type
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
                jsonb_build_object(
                  'mediaObjectId', assignment.platform_media_object_id::text,
                  'url', variant.public_cdn_url,
                  'altText', assignment.alt_text
                )
                ORDER BY assignment.sort_order, assignment.platform_media_object_id
              ) AS items
       FROM pms.room_type_media assignment
       JOIN platform.media_objects media_object
         ON media_object.id = assignment.platform_media_object_id
        AND media_object.property_id = assignment.property_id
        AND media_object.visibility = 'public'
        AND media_object.lifecycle_status = 'active'
        AND media_object.public_approved = TRUE
       JOIN LATERAL (
         SELECT media_variant.public_cdn_url
         FROM platform.media_variants media_variant
         WHERE media_variant.media_object_id = media_object.id
           AND media_variant.visibility = 'public'
           AND media_variant.public_cdn_url IS NOT NULL
         ORDER BY
           CASE media_variant.variant_name
             WHEN 'thumbnail' THEN 0
             WHEN 'large' THEN 1
             WHEN 'original_safe' THEN 2
             ELSE 3
           END,
           media_variant.id
         LIMIT 1
       ) variant ON TRUE
       WHERE assignment.property_id = room_type.property_id
         AND assignment.room_type_id = room_type.id
     ) room_media ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
                jsonb_build_object(
                  'ratePlanId', rate_plan.id::text,
                  'pricingContractVersion', rate_plan.pricing_contract_version,
                  'code', rate_plan.code,
                  'name', rate_plan.name,
                  'rateType', rate_plan.rate_type,
                  'mealPlan', rate_plan.meal_plan,
                  'baseRate', jsonb_build_object(
                    'amountDecimal', rate_plan.base_rate_amount::text,
                    'currency', rate_plan.currency
                  ),
                  'active', rate_plan.active
                )
                ORDER BY rate_plan.code ASC, rate_plan.name ASC
              ) AS items
       FROM pms.rate_plans rate_plan
       WHERE rate_plan.property_id = room_type.property_id
         AND rate_plan.room_type_id = room_type.id
     ) rate_plans ON TRUE
     LEFT JOIN LATERAL (
       SELECT
         MIN(rule.min_stay_nights) FILTER (WHERE rule.min_stay_nights IS NOT NULL)
           AS min_stay_nights,
         MAX(rule.max_stay_nights) FILTER (WHERE rule.max_stay_nights IS NOT NULL)
           AS max_stay_nights,
         BOOL_OR(rule.closed_to_arrival) AS closed_to_arrival,
         BOOL_OR(rule.closed_to_departure) AS closed_to_departure,
         COUNT(*) AS active_rule_count
       FROM pms.rate_rules rule
       WHERE rule.property_id = room_type.property_id
         AND rule.room_type_id = room_type.id
     ) rate_rules ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS room_count
       FROM pms.rooms room
       WHERE room.property_id = room_type.property_id
         AND room.room_type_id = room_type.id
         AND room.status <> 'retired'
     ) room_counts ON TRUE
     WHERE room_type.property_id = $1
       ${roomTypeFilter}
     ORDER BY room_type.sort_order ASC, room_type.name ASC`,
    params,
  );

  return {
    items: result.rows.map(toPmsRoomType),
    sourceFreshness: {},
  };
}

function toPmsRoom(row: TargetPmsRoomRow): PmsRoom {
  return {
    roomId: row.roomId,
    roomTypeId: row.roomTypeId,
    roomNumber: row.roomNumber,
    floor: row.floor,
    status: row.status,
    sortOrder: row.sortOrder,
    metadata: toJsonRecord(row.metadata),
  };
}

function toPmsRoomType(row: TargetPmsRoomTypeRow): PmsRoomType {
  return {
    roomTypeId: row.roomTypeId,
    name: row.name,
    description: row.description,
    category: row.category,
    occupancyLimits: toNumberRecord(row.occupancyLimits),
    attributes: toJsonRecord(row.attributes),
    amenities: toStringArray(row.amenities),
    media: toMediaArray(row.media),
    roomMediaRevision: toInteger(row.roomMediaRevision),
    baseRate: {
      amountDecimal: toDecimalString(row.baseRateAmount),
      currency: row.currency,
    },
    active: row.active,
    sortOrder: row.sortOrder,
    ratePlans: toRatePlans(row.ratePlans),
    rateRulesSummary: {
      minStayNights: row.minStayNights,
      maxStayNights: row.maxStayNights,
      closedToArrival: row.closedToArrival,
      closedToDeparture: row.closedToDeparture,
      activeRuleCount: toInteger(row.activeRuleCount),
    },
    roomCount: toInteger(row.roomCount),
  };
}

function toPmsRoomBlockSummary(row: TargetPmsRoomBlockRow): PmsRoomBlockSummary {
  return {
    blockId: row.blockId,
    version: `room-block-v${row.revision}`,
    roomTypeId: row.roomTypeId,
    roomId: row.roomId,
    startsOn: toDateOnly(row.startsOn),
    endsOn: toDateOnly(row.endsOn),
    blockedCount: toInteger(row.blockedCount),
    reason: row.reason,
    status: row.status,
  };
}

function toPmsCalendarDay(row: TargetPmsCalendarDayRow): PmsCalendarDay {
  return {
    stayDate: toDateOnly(row.stayDate),
    roomTypeId: row.roomTypeId,
    totalCount: toInteger(row.totalCount),
    assignedCount: toInteger(row.assignedCount),
    blockedCount: toInteger(row.blockedCount),
    availableCount: toInteger(row.availableCount),
    status: row.status,
    blocks: toRoomBlockSummaries(row.blocks),
    assignmentRefs: toStringArray(row.assignmentRefs),
    sourceFreshness: toJsonRecord(row.sourceFreshness),
  };
}

function toPmsOperationalReservation(
  row: TargetPmsOperationalReservationRow,
  propertyPlan: PropertyPlanReadModel,
): PmsOperationalReservation {
  const bookedRoomTypeId = row.bookedRoomTypeId.trim();
  const bookedRoomName = row.bookedRoomName.trim();
  const contact = guestContactForPropertyPlan(propertyPlan, row.guestContactAccepted, {
    email: row.primaryGuestEmail,
    phone: row.primaryGuestPhone,
  });

  return {
    guestBookingId: row.guestBookingId,
    bookingReference: row.bookingReference,
    status: row.status,
    source: row.source,
    stay: {
      checkIn: toDateOnly(row.checkIn),
      checkOut: toDateOnly(row.checkOut),
      adults: row.adults,
      children: row.children,
    },
    primaryGuest: {
      displayName: row.primaryGuestDisplayName ?? "",
      email: contact.email,
      phone: contact.phone,
      countryCode: row.primaryGuestCountryCode,
    },
    assignments: toOperationalAssignments(row.assignments),
    checkin: {
      completedAt: toIsoDateTimeOrNull(row.checkinCompletedAt),
      pendingFlags: toStringArray(row.checkinPendingFlags),
    },
    checkout: {
      completedAt: toIsoDateTimeOrNull(row.checkoutCompletedAt),
      pendingFlags: toStringArray(row.checkoutPendingFlags),
    },
    privateNoteCount: toInteger(row.privateNoteCount),
    additionalGuestCount: toInteger(row.additionalGuestCount),
    ...(bookedRoomTypeId && bookedRoomName
      ? { bookedOffer: { roomTypeId: bookedRoomTypeId, roomName: bookedRoomName } }
      : {}),
    roomCount: Math.max(toInteger(row.roomCount), 1),
    pricing: {
      totalAmount: {
        amountDecimal: toDecimalString(row.totalAmount),
        currency: row.currency,
      },
      balanceAmount: {
        amountDecimal: toDecimalString(row.balanceAmount),
        currency: row.currency,
      },
    },
    payment: {
      method: row.paymentMethod,
      expectedMethod: row.expectedPaymentMethod,
      status: row.paymentStatus,
      ...paymentBreakdown(row.paymentBreakdown),
    },
    hostResponseDeadlineAt: toIsoDateTimeOrNull(row.hostResponseDeadlineAt),
  };
}

function paymentBreakdown(value: unknown): {
  breakdown?: NonNullable<PmsOperationalReservation["payment"]>["breakdown"];
} {
  const breakdown = toJsonRecord(value);
  const money = (key: string): PmsMoney | null => {
    const item = toJsonRecord(breakdown[key]);
    const amountDecimal = typeof item["amountDecimal"] === "string" ? item["amountDecimal"] : "";
    const currency = typeof item["currency"] === "string" ? item["currency"] : "";
    return amountDecimal && currency ? { amountDecimal, currency } : null;
  };
  const grossAmount = money("grossAmount");
  const stripeFee = money("stripeFee");
  const vayadaCommission = money("vayadaCommission");
  const netPayout = money("netPayout");
  return grossAmount && stripeFee && vayadaCommission && netPayout
    ? { breakdown: { grossAmount, stripeFee, vayadaCommission, netPayout } }
    : {};
}

function toRoomBlockSummaries(value: unknown): PmsRoomBlockSummary[] {
  return toRecordArray(value)
    .map((item) => ({
      blockId: String(item.blockId ?? ""),
      version: String(item.version ?? ""),
      roomTypeId: String(item.roomTypeId ?? ""),
      roomId: typeof item.roomId === "string" ? item.roomId : null,
      startsOn: toDateOnly(String(item.startsOn ?? "")),
      endsOn: toDateOnly(String(item.endsOn ?? "")),
      blockedCount: toInteger(Number(item.blockedCount ?? 0)),
      reason: String(item.reason ?? ""),
      status: toRoomBlockStatus(item.status),
    }))
    .filter(
      (item) => item.blockId.length > 0 && item.version.length > 0 && item.roomTypeId.length > 0,
    );
}

function toOperationalAssignments(value: unknown): PmsOperationalAssignment[] {
  return toRecordArray(value)
    .map((item) => {
      const stay = record(item.stay);
      return {
        assignmentId: String(item.assignmentId ?? ""),
        roomTypeId: String(item.roomTypeId ?? ""),
        ratePlanId: typeof item.ratePlanId === "string" ? item.ratePlanId : null,
        roomId: typeof item.roomId === "string" ? item.roomId : null,
        roomNumber: typeof item.roomNumber === "string" ? item.roomNumber : null,
        position: toInteger(Number(item.position ?? 0)),
        assignmentStatus: toAssignmentStatus(item.assignmentStatus),
        channel: String(item.channel ?? "direct"),
        assignedAt: toIsoDateTimeOrNull(
          typeof item.assignedAt === "string" || item.assignedAt instanceof Date
            ? item.assignedAt
            : null,
        ),
        ...(stay
          ? {
              stay: {
                checkIn: toDateOnly(String(stay.checkIn ?? "")),
                checkOut: toDateOnly(String(stay.checkOut ?? "")),
                adults: toInteger(Number(stay.adults ?? 0)),
                children: toInteger(Number(stay.children ?? 0)),
              },
            }
          : {}),
        nightly: toOperationalNights(item.nightly),
      };
    })
    .filter((item) => item.assignmentId.length > 0 && item.roomTypeId.length > 0);
}

function toOperationalNights(value: unknown): PmsOperationalNight[] {
  return toRecordArray(value).map((item) => {
    const applied = record(item.applied);
    return {
      serviceDate: toDateOnly(String(item.serviceDate ?? "")),
      applied: applied
        ? {
            amountDecimal: toDecimalString(String(applied.amountDecimal ?? "0")),
            currency: String(applied.currency ?? ""),
          }
        : null,
      evidenceQuality:
        item.evidenceQuality === "exact" || item.evidenceQuality === "inferred"
          ? item.evidenceQuality
          : "missing",
    };
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
}

function toRoomBlockStatus(value: unknown): PmsRoomBlockStatus {
  return value === "released" || value === "expired" ? value : "active";
}

function toAssignmentStatus(value: unknown): PmsOperationalAssignmentStatus {
  return value === "assigned" ||
    value === "checked_in" ||
    value === "in_house" ||
    value === "checked_out" ||
    value === "canceled" ||
    value === "released"
    ? value
    : "pending";
}

function toRoomBlockWhere(
  propertyId: string,
  range?: { from?: PmsDate; to?: PmsDate },
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [propertyId];
  const conditions = ["block.property_id = $1"];

  if (range?.from) {
    params.push(range.from);
    conditions.push(`block.ends_on >= $${params.length}::date`);
  }

  if (range?.to) {
    params.push(range.to);
    conditions.push(`block.starts_on <= $${params.length}::date`);
  }

  return { whereSql: conditions.join(" AND "), params };
}

function toReservationWhere(
  propertyId: string,
  filters: PmsReservationListFilters,
  propertyPlan: PropertyPlanReadModel,
): { whereSql: string; params: unknown[] } {
  const params: unknown[] = [propertyId];
  const conditions = ["booking.property_id = $1"];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`${PMS_OPERATIONAL_RESERVATION_STATUS_SQL} = $${params.length}`);
  }

  if (filters.arrivalFrom) {
    params.push(filters.arrivalFrom);
    conditions.push(`booking.check_in >= $${params.length}::date`);
  }

  if (filters.arrivalTo) {
    params.push(filters.arrivalTo);
    conditions.push(`booking.check_in <= $${params.length}::date`);
  }

  if (filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(
      `(booking.public_reference ILIKE $${params.length}
        OR primary_guest.first_name ILIKE $${params.length}
        OR primary_guest.last_name ILIKE $${params.length}
        OR CONCAT(primary_guest.first_name, ' ', primary_guest.last_name) ILIKE $${params.length}
        OR (
          (${propertyPlan.limits.guestContactAccess === "always"}
            OR ${BOOKING_HAS_EVER_BEEN_ACCEPTED_SQL})
          AND (
            primary_guest.email ILIKE $${params.length}
            OR primary_guest.phone ILIKE $${params.length}
          )
        )
        OR EXISTS (
          SELECT 1
          FROM pms.operational_booking_assignments assignment_search
          WHERE assignment_search.guest_booking_id = booking.id
            AND assignment_search.property_id = booking.property_id
            AND (
              assignment_search.pms_reservation_ref ILIKE $${params.length}
              OR assignment_search.external_reservation_id ILIKE $${params.length}
            )
        ))`,
    );
  }

  return { whereSql: conditions.join(" AND "), params };
}

function toJsonRecord(value: unknown): PmsJsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, toJsonValue(raw)] as const)
      .filter((entry): entry is [string, PmsJsonValue] => entry[1] !== undefined),
  );
}

function toJsonValue(value: unknown): PmsJsonValue | undefined {
  if (isJsonScalar(value)) return value;
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item): item is PmsJsonValue => item !== undefined);
  }
  if (value && typeof value === "object") {
    return toJsonRecord(value);
  }
  return undefined;
}

function toNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, raw]) => [key, Number(raw)] as const)
      .filter(([, raw]) => Number.isFinite(raw)),
  );
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toMediaArray(value: unknown): PmsRoomTypeMedia[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item.length > 0 ? [{ url: item, altText: null }] : [];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const url = typeof raw.url === "string" ? raw.url : "";
    if (!url) return [];
    const mediaObjectId = typeof raw.mediaObjectId === "string" ? raw.mediaObjectId : undefined;
    const altText =
      typeof raw.altText === "string" ? raw.altText : typeof raw.alt === "string" ? raw.alt : null;
    return [
      {
        ...(mediaObjectId ? { mediaObjectId } : {}),
        url,
        altText,
      },
    ];
  });
}

function toRatePlans(value: unknown): PmsRatePlan[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      ratePlanId: String(item.ratePlanId ?? ""),
      pricingContractVersion:
        typeof item.pricingContractVersion === "string" ? item.pricingContractVersion : null,
      code: String(item.code ?? ""),
      name: String(item.name ?? ""),
      rateType: toRateType(item.rateType),
      mealPlan: typeof item.mealPlan === "string" ? item.mealPlan : null,
      baseRate: toMoney(item.baseRate),
      active: item.active === true,
    }))
    .filter((item) => item.ratePlanId.length > 0);
}

function toRateType(value: unknown): PmsRatePlan["rateType"] {
  return value === "non_refundable" || value === "package" || value === "manual"
    ? value
    : "flexible";
}

function toMoney(value: unknown): PmsMoney {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    return {
      amountDecimal: toDecimalString(raw.amountDecimal ?? "0"),
      currency: typeof raw.currency === "string" ? raw.currency : "EUR",
    };
  }
  return { amountDecimal: "0", currency: "EUR" };
}

function isJsonScalar(value: unknown): value is PmsJsonScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function toDecimalString(value: string | number | unknown): string {
  if (typeof value === "number") return value.toFixed(2);
  if (typeof value !== "string") return "0.00";
  const trimmed = value.trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return "0.00";

  const sign = trimmed.startsWith("-") ? "-" : "";
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  return `${sign}${whole}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function toInteger(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDateOnly(value: Date | string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return "";
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return value.slice(0, 10);
}

function toIsoDateTimeOrNull(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}
