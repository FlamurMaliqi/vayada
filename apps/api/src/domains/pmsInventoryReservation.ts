import {
  PMS_INVENTORY_RESERVATION_MARKER_VERSION,
  type PmsInventoryReservationMarker,
} from "@vayada/domain-pms";

import type { DirectBookingInventoryReservationPort } from "../platform/inventoryReservation.js";

type ReservationResultRow = {
  reserved: boolean;
};

export function createTargetPmsInventoryReservationPort(): DirectBookingInventoryReservationPort {
  return {
    async reserve(input) {
      const result = await input.transaction.query<ReservationResultRow>(
        `WITH inventory_lock AS (
           SELECT pg_advisory_xact_lock(
             hashtextextended(concat('pms-inventory:', $1::text), 0)
           )
         ),
         reservation_guard AS (
           SELECT offer.room_type_id
           FROM distribution.public_room_offer_snapshots offer
           CROSS JOIN inventory_lock
           JOIN distribution.public_hotel_bookability_profiles profile
             ON profile.property_id = offer.property_id
           JOIN pms.inventory_days inventory
             ON inventory.property_id = offer.property_id
            AND inventory.room_type_id = offer.room_type_id
            AND inventory.stay_date = offer.stay_date
           WHERE offer.property_id = $1::uuid
             AND offer.room_type_id::text = $2
             AND offer.public_offer_key = $3
             AND offer.stay_date >= $4::date
             AND offer.stay_date < $5::date
             AND $6::integer >= 1
             AND profile.public_visibility = 'public_safe'
             AND profile.profile_status = 'public'
             AND profile.freshness_status = 'fresh'
             AND profile.public_setup_completeness ->> 'status' = 'ready'
             AND (profile.expires_at IS NULL OR profile.expires_at > $8::timestamptz)
             AND offer.public_visibility = 'public_safe'
             AND offer.currency = $7
             AND offer.sellable_publicly = TRUE
             AND offer.availability_status IN ('available', 'limited')
             AND offer.freshness_status = 'fresh'
             AND (offer.expires_at IS NULL OR offer.expires_at > $8::timestamptz)
             AND inventory.status <> 'closed'
           GROUP BY offer.room_type_id
           HAVING COUNT(DISTINCT offer.stay_date) = ($5::date - $4::date)
              AND BOOL_AND(offer.available_rooms >= $6::integer)
              AND BOOL_AND(inventory.available_count >= $6::integer)
              AND COALESCE(
                MAX(NULLIF(offer.rate_summary ->> 'minStayNights', '')::integer)
                  FILTER (WHERE offer.stay_date = $4::date),
                1
              ) <= ($5::date - $4::date)
              AND (
                MAX(NULLIF(offer.rate_summary ->> 'maxStayNights', '')::integer)
                  FILTER (WHERE offer.stay_date = $4::date) IS NULL
                OR MAX(NULLIF(offer.rate_summary ->> 'maxStayNights', '')::integer)
                  FILTER (WHERE offer.stay_date = $4::date) >= ($5::date - $4::date)
              )
         ),
         pms_inventory_reserved AS (
           UPDATE pms.inventory_days inventory
              SET assigned_count = inventory.assigned_count + $6::integer,
                  available_count = inventory.available_count - $6::integer,
                  updated_at = $8::timestamptz
           FROM reservation_guard
           WHERE inventory.property_id = $1::uuid
             AND inventory.room_type_id::text = $2
             AND inventory.stay_date >= $4::date
             AND inventory.stay_date < $5::date
             AND inventory.status <> 'closed'
             AND inventory.available_count >= $6::integer
           RETURNING inventory.stay_date, inventory.available_count, inventory.total_count
         ),
         public_inventory_reserved AS (
           UPDATE distribution.public_room_offer_snapshots offer
              SET available_rooms = inventory.available_count,
                  availability_status = CASE
                    WHEN offer.availability_status IN ('closed', 'stale', 'unavailable')
                      THEN offer.availability_status
                    WHEN inventory.available_count = 0 THEN 'sold_out'
                    WHEN inventory.available_count < inventory.total_count THEN 'limited'
                    ELSE 'available'
                  END,
                  sellable_publicly = CASE
                    WHEN offer.availability_status IN ('closed', 'stale', 'unavailable') THEN FALSE
                    ELSE inventory.available_count > 0
                  END,
                  unavailable_reasons = CASE
                    WHEN inventory.available_count = 0
                      THEN array_append(array_remove(offer.unavailable_reasons, 'sold_out'), 'sold_out')
                    ELSE array_remove(offer.unavailable_reasons, 'sold_out')
                  END,
                  updated_at = $8::timestamptz
           FROM reservation_guard, pms_inventory_reserved inventory
           WHERE offer.property_id = $1::uuid
             AND offer.room_type_id::text = $2
             AND offer.stay_date = inventory.stay_date
             AND offer.public_visibility = 'public_safe'
             AND offer.freshness_status = 'fresh'
           RETURNING offer.stay_date
         )
         SELECT
           ($5::date - $4::date) > 0
           AND $6::integer >= 1
           AND (SELECT COUNT(DISTINCT stay_date) FROM pms_inventory_reserved) =
               ($5::date - $4::date)
           AND (SELECT COUNT(DISTINCT stay_date) FROM public_inventory_reserved) =
               ($5::date - $4::date) AS reserved`,
        [
          input.propertyId,
          input.roomTypeId,
          input.publicOfferKey,
          input.checkIn,
          input.checkOut,
          input.roomCount,
          input.currency,
          input.occurredAt.toISOString(),
        ],
      );
      if (result.rows[0]?.reserved !== true) return null;

      return {
        contractVersion: PMS_INVENTORY_RESERVATION_MARKER_VERSION,
        owner: "pms",
        source: "booking_engine",
        quoteSessionId: input.quoteSessionId,
        propertyId: input.propertyId,
        roomTypeId: input.roomTypeId,
        publicOfferKey: input.publicOfferKey,
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        roomCount: input.roomCount,
      } satisfies PmsInventoryReservationMarker;
    },

    async release(input) {
      const reservation = input.reservation;
      if (
        reservation.contractVersion !== PMS_INVENTORY_RESERVATION_MARKER_VERSION ||
        reservation.owner !== "pms" ||
        reservation.source !== "booking_engine" ||
        reservation.propertyId !== input.propertyId
      ) {
        return;
      }

      await input.transaction.query(
        `WITH inventory_lock AS (
           SELECT pg_advisory_xact_lock(
             hashtextextended(concat('pms-inventory:', $1::text), 0)
           )
         ),
         restored AS (
           UPDATE pms.inventory_days inventory
              SET assigned_count = GREATEST(0, inventory.assigned_count - $5::integer),
                  available_count = LEAST(
                    inventory.total_count - inventory.blocked_count,
                    inventory.available_count + $5::integer
                  ),
                  updated_at = $6::timestamptz
            FROM inventory_lock
            WHERE inventory.property_id = $1::uuid
              AND inventory.room_type_id = $2::uuid
              AND inventory.stay_date >= $3::date
              AND inventory.stay_date < $4::date
            RETURNING inventory.stay_date, inventory.available_count, inventory.total_count
         )
         UPDATE distribution.public_room_offer_snapshots offer
            SET available_rooms = restored.available_count,
                availability_status = CASE
                  WHEN offer.availability_status IN ('closed', 'stale', 'unavailable')
                    THEN offer.availability_status
                  WHEN restored.available_count = 0 THEN 'sold_out'
                  WHEN restored.available_count < restored.total_count THEN 'limited'
                  ELSE 'available'
                END,
                sellable_publicly = CASE
                  WHEN offer.availability_status IN ('closed', 'stale', 'unavailable')
                    THEN offer.sellable_publicly
                  ELSE restored.available_count > 0
                END,
                unavailable_reasons = CASE
                  WHEN restored.available_count = 0
                    THEN array_append(array_remove(offer.unavailable_reasons, 'sold_out'), 'sold_out')
                  ELSE array_remove(offer.unavailable_reasons, 'sold_out')
                END,
                updated_at = $6::timestamptz
           FROM restored
          WHERE offer.property_id = $1::uuid
            AND offer.room_type_id = $2::uuid
            AND offer.stay_date = restored.stay_date`,
        [
          reservation.propertyId,
          reservation.roomTypeId,
          reservation.checkIn,
          reservation.checkOut,
          reservation.roomCount,
          input.occurredAt.toISOString(),
        ],
      );
    },
  };
}
