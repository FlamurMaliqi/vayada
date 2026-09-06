import { createHash } from "node:crypto";

import {
  PMS_INVENTORY_RESERVATION_MARKER_VERSION,
  PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
  PMS_INVENTORY_RESERVATION_BUNDLE_VERSION,
  parsePmsInventoryReservationBundle,
  type PmsInventoryReservationReceipt,
  type PmsInventoryReservationMarker,
} from "@vayada/domain-pms";

import type {
  DirectBookingInventoryReservationPort,
  InventoryReservationReceipt,
} from "../platform/inventoryReservation.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";

type ReservationResultRow = {
  reserved: boolean;
};

export function createTargetPmsInventoryReservationPort(): DirectBookingInventoryReservationPort {
  const port: DirectBookingInventoryReservationPort = {
    async reserveBundle(input) {
      const types = input.lines.map((line) => line.roomTypeId.toLowerCase());
      if (
        !types.length ||
        types.length > 99 ||
        new Set(types).size !== types.length ||
        input.lines.some((line) => !Number.isSafeInteger(line.roomCount) || line.roomCount < 1) ||
        input.lines.reduce((sum, line) => sum + line.roomCount, 0) > 99
      ) {
        throw Object.assign(new Error("Invalid room selection."), { statusCode: 400 });
      }
      await lockPmsInventoryMutationScope(input.transaction, input.propertyId);
      const lines = [...input.lines]
        .map((line) => ({
          roomTypeId: line.roomTypeId.toLowerCase(),
          publicOfferKey: line.publicOfferKey,
          roomCount: line.roomCount,
        }))
        .sort((a, b) => a.roomTypeId.localeCompare(b.roomTypeId));
      const keyHash = createHash("sha256")
        .update(`${input.propertyId}:${input.quoteSessionId}`)
        .digest("hex");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            lines,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            currency: input.currency,
          }),
        )
        .digest("hex");
      const previous = await input.transaction.query<{ fingerprint: string }>(
        `SELECT request_fingerprint_hash AS fingerprint FROM platform.idempotency_keys
         WHERE operation_scope='pms' AND operation='pms.direct_booking_inventory.reserve_bundle'
           AND property_id=$1::uuid AND key_hash=$2`,
        [input.propertyId, keyHash],
      );
      const existing = await input.transaction.query<{ receiptId: string }>(
        `SELECT receipt_id::text AS "receiptId" FROM pms.inventory_reservation_receipts
         WHERE property_id=$1::uuid AND quote_session_id=$2 ORDER BY room_type_id`,
        [input.propertyId, input.quoteSessionId],
      );
      if (previous.rows.length || existing.rows.length) {
        if (previous.rows[0]?.fingerprint !== fingerprint || existing.rows.length !== lines.length)
          throw Object.assign(
            new Error("This quote already reserved a different room selection."),
            { statusCode: 409 },
          );
        return {
          contractVersion: PMS_INVENTORY_RESERVATION_BUNDLE_VERSION,
          owner: "pms",
          receipts: existing.rows.map(({ receiptId }) => ({
            contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
            owner: "pms",
            receiptId,
          })),
        };
      }
      const receipts: PmsInventoryReservationReceipt[] = [];
      for (const line of lines) {
        const receipt = await port.reserve({ ...input, ...line });
        if (!receipt || !isOpaqueReceipt(receipt))
          throw Object.assign(
            new Error("The room combination is no longer available. Please refresh."),
            { statusCode: 409 },
          );
        receipts.push(receipt);
      }
      await input.transaction.query(
        `INSERT INTO platform.idempotency_keys
        (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
         response_status_code,response_body_hash,first_seen_at,last_seen_at,completed_at,expires_at)
        VALUES ('pms','pms.direct_booking_inventory.reserve_bundle',$2,$3,'completed','property',$1::uuid,
          200,$3,$4,$4,$4,'infinity')`,
        [input.propertyId, keyHash, fingerprint, input.occurredAt],
      );
      return { contractVersion: PMS_INVENTORY_RESERVATION_BUNDLE_VERSION, owner: "pms", receipts };
    },
    async reserve(input) {
      await lockPmsInventoryMutationScope(input.transaction, input.propertyId);
      const result = await input.transaction.query<ReservationResultRow>(
        `WITH reservation_guard AS (
           SELECT offer.room_type_id
           FROM distribution.public_room_offer_snapshots offer
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
             AND COALESCE(inventory.rate_gate_open, TRUE)
             AND inventory.calendar_revision IS NOT NULL
             AND inventory.inventory_revision IS NOT NULL
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
                  inventory_revision = CASE
                    WHEN inventory.inventory_revision IS NULL THEN NULL
                    ELSE inventory.inventory_revision + 1
                  END,
                  booking_source_revision = CASE
                    WHEN inventory.booking_source_revision IS NULL THEN NULL
                    ELSE inventory.booking_source_revision + 1
                  END,
                  updated_at = $8::timestamptz
           FROM reservation_guard
           WHERE inventory.property_id = $1::uuid
             AND inventory.room_type_id::text = $2
             AND inventory.stay_date >= $4::date
             AND inventory.stay_date < $5::date
             AND inventory.status <> 'closed'
             AND COALESCE(inventory.rate_gate_open, TRUE)
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

      const scope = {
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
      const keyHash = reservationKeyHash(scope);
      const receipt = await persistDirectBookingReceipt(
        input.transaction,
        scope,
        input.occurredAt,
        keyHash,
      );
      if (!receipt) return null;
      await reconcileDirectBookingLinkedInventory(
        input.transaction,
        scope,
        input.occurredAt,
        keyHash,
        "reserve",
      );
      return receipt;
    },

    async release(input) {
      const reservation = input.reservation;
      await lockPmsInventoryMutationScope(input.transaction, input.propertyId);
      if (reservation.contractVersion === PMS_INVENTORY_RESERVATION_BUNDLE_VERSION) {
        const bundle = parsePmsInventoryReservationBundle(reservation);
        if (!bundle) throw new Error("Invalid inventory reservation bundle");
        const ids = bundle.receipts.map((receipt) => receipt.receiptId).sort();
        const scope = await input.transaction.query<{ valid: boolean }>(
          `SELECT count(*)=$3::int AND count(DISTINCT quote_session_id)=1
             AND count(*)=(SELECT count(*) FROM pms.inventory_reservation_receipts all_receipts
               WHERE all_receipts.property_id=$1::uuid AND all_receipts.quote_session_id=(
                 SELECT quote_session_id FROM pms.inventory_reservation_receipts
                 WHERE property_id=$1::uuid AND receipt_id=($2::uuid[])[1]))
             AND count(DISTINCT check_in)=1 AND count(DISTINCT check_out)=1
             AND count(DISTINCT room_type_id)=$3::int AS valid
           FROM pms.inventory_reservation_receipts WHERE property_id=$1::uuid
             AND receipt_id=ANY($2::uuid[])`,
          [input.propertyId, ids, ids.length],
        );
        if (!scope.rows[0]?.valid) throw new Error("Inventory reservation bundle scope mismatch");
        for (const receipt of [...bundle.receipts].sort((a, b) =>
          a.receiptId.localeCompare(b.receiptId),
        ))
          await port.release({ ...input, reservation: receipt });
        return;
      }
      const receiptId = isOpaqueReceipt(reservation) ? reservation.receiptId : null;
      const scope = receiptId
        ? await loadReservedReceiptScope(input.transaction, input.propertyId, receiptId)
        : isLegacyReservation(reservation, input.propertyId)
          ? reservation
          : null;
      if (!scope) {
        if (input.requireReserved)
          throw Object.assign(new Error("This request’s inventory can no longer be edited."), {
            statusCode: 409,
          });
        return;
      }
      const linkedReceiptState = receiptId
        ? "reserved"
        : await readLinkedReceiptState(input.transaction, scope);
      if (linkedReceiptState === "released" || linkedReceiptState === "handed_off") {
        if (input.requireReserved)
          throw Object.assign(new Error("This request’s inventory can no longer be edited."), {
            statusCode: 409,
          });
        return;
      }
      if (linkedReceiptState === "missing")
        throw new Error("Linked inventory reservation receipt is missing");
      const releaseKeyHash = receiptId
        ? createHash("sha256").update(receiptId).digest("hex")
        : reservationKeyHash(scope);
      await input.transaction.query(
        `WITH release_guard AS (
           SELECT TRUE AS releasable
           FROM pms.inventory_days inventory
           WHERE inventory.property_id = $1::uuid
             AND inventory.room_type_id = $2::uuid
             AND inventory.stay_date >= $3::date
             AND inventory.stay_date < $4::date
           HAVING COUNT(*) = ($4::date - $3::date)
              AND BOOL_AND(inventory.assigned_count >= $5::integer)
         ),
         release_claim AS (
           INSERT INTO platform.idempotency_keys (
             operation_scope, operation, key_hash, request_fingerprint_hash,
             status, tenant_scope, property_id, response_status_code,
             response_body_hash, first_seen_at, last_seen_at, completed_at, expires_at
           )
           SELECT 'pms', 'pms.direct_booking_inventory.release', $7, $7,
                  'completed', 'property', $1::uuid, 200, $7,
                  $6::timestamptz, $6::timestamptz, $6::timestamptz, 'infinity'::timestamptz
           FROM release_guard
           ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
           RETURNING TRUE AS claimed
         ),
         restored AS (
           UPDATE pms.inventory_days inventory
              SET assigned_count = GREATEST(0, inventory.assigned_count - $5::integer),
                  available_count = CASE
                    WHEN inventory.inventory_revision IS NULL THEN LEAST(
                      inventory.total_count - inventory.blocked_count,
                      inventory.available_count + $5::integer
                    )
                    WHEN inventory.status = 'closed' OR inventory.linked_stop_sell THEN 0
                    ELSE GREATEST(
                      0,
                      inventory.effective_sellable_limit_count
                        - GREATEST(0, inventory.assigned_count - $5::integer)
                        - inventory.blocked_count
                    )
                  END,
                  inventory_revision = CASE
                    WHEN inventory.inventory_revision IS NULL THEN NULL
                    ELSE inventory.inventory_revision + 1
                  END,
                  booking_source_revision = CASE
                    WHEN inventory.booking_source_revision IS NULL THEN NULL
                    ELSE inventory.booking_source_revision + 1
                  END,
                  updated_at = $6::timestamptz
            FROM release_claim
            WHERE inventory.property_id = $1::uuid
              AND inventory.room_type_id = $2::uuid
              AND inventory.stay_date >= $3::date
              AND inventory.stay_date < $4::date
              AND inventory.assigned_count >= $5::integer
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
          scope.propertyId,
          scope.roomTypeId,
          scope.checkIn,
          scope.checkOut,
          scope.roomCount,
          input.occurredAt.toISOString(),
          releaseKeyHash,
        ],
      );
      if (
        await releaseDirectBookingReceipt(
          input.transaction,
          scope,
          receiptId,
          input.occurredAt,
          releaseKeyHash,
          receiptId !== null || linkedReceiptState === "reserved",
        )
      ) {
        await reconcileDirectBookingLinkedInventory(
          input.transaction,
          scope,
          input.occurredAt,
          releaseKeyHash,
          "release",
        );
      }
    },

    async availabilityCredit(input) {
      const result = await input.transaction.query<{
        checkIn: string;
        checkOut: string;
        roomCount: number;
      }>(
        `SELECT receipt.check_in::text AS "checkIn", receipt.check_out::text AS "checkOut",
                receipt.room_count AS "roomCount"
           FROM pms.inventory_reservation_receipts receipt
           JOIN pms.inventory_reservation_statuses status USING (receipt_id)
          WHERE receipt.receipt_id=$1::uuid AND receipt.property_id=$2::uuid
            AND receipt.room_type_id=$3::uuid AND receipt.public_offer_key=$4
            AND receipt.check_in=$5::date AND receipt.check_out=$6::date
            AND receipt.room_count=$7 AND receipt.receipt_owner='pms'
            AND receipt.contract_version=$8 AND status.lifecycle_state='reserved'`,
        [
          input.reservation.receiptId,
          input.propertyId,
          input.roomTypeId,
          input.publicOfferKey,
          input.checkIn,
          input.checkOut,
          input.roomCount,
          input.reservation.contractVersion,
        ],
      );
      return result.rows[0] ?? null;
    },
  };
  return port;
}

type Transaction = Parameters<DirectBookingInventoryReservationPort["reserve"]>[0]["transaction"];

type ReceiptScopeRow = {
  quoteSessionId: string;
  roomTypeId: string;
  publicOfferKey: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
};

function isOpaqueReceipt(
  reservation: InventoryReservationReceipt,
): reservation is PmsInventoryReservationReceipt {
  return reservation.contractVersion === PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION;
}

function isLegacyReservation(
  reservation: InventoryReservationReceipt,
  propertyId: string,
): reservation is PmsInventoryReservationMarker {
  return (
    reservation.contractVersion === PMS_INVENTORY_RESERVATION_MARKER_VERSION &&
    reservation.owner === "pms" &&
    reservation.source === "booking_engine" &&
    reservation.propertyId === propertyId
  );
}

async function loadReservedReceiptScope(
  transaction: Transaction,
  propertyId: string,
  receiptId: string,
): Promise<PmsInventoryReservationMarker | null> {
  const result = await transaction.query<ReceiptScopeRow>(
    `SELECT receipt.quote_session_id AS "quoteSessionId",
            receipt.room_type_id::text AS "roomTypeId",
            receipt.public_offer_key AS "publicOfferKey",
            receipt.check_in::text AS "checkIn", receipt.check_out::text AS "checkOut",
            receipt.room_count AS "roomCount"
       FROM pms.inventory_reservation_receipts receipt
       JOIN pms.inventory_reservation_statuses status USING (receipt_id)
      WHERE receipt.receipt_id=$1::uuid AND receipt.property_id=$2::uuid
        AND status.lifecycle_state='reserved'
      FOR UPDATE OF status`,
    [receiptId, propertyId],
  );
  const scope = result.rows[0];
  return scope
    ? {
        contractVersion: PMS_INVENTORY_RESERVATION_MARKER_VERSION,
        owner: "pms",
        source: "booking_engine",
        propertyId,
        ...scope,
      }
    : null;
}

function reservationKeyHash(reservation: PmsInventoryReservationMarker): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        reservation.contractVersion,
        reservation.owner,
        reservation.source,
        reservation.quoteSessionId,
        reservation.propertyId,
        reservation.roomTypeId,
        reservation.publicOfferKey,
        reservation.checkIn,
        reservation.checkOut,
        reservation.roomCount,
      ]),
    )
    .digest("hex");
}

async function persistDirectBookingReceipt(
  transaction: Transaction,
  reservation: PmsInventoryReservationMarker,
  occurredAt: Date,
  keyHash: string,
): Promise<PmsInventoryReservationReceipt | null> {
  const result = await transaction.query<{ receiptId: string }>(
    `WITH source AS (
       SELECT revision.organization_id, MIN(inventory.calendar_revision)::integer AS calendar_revision,
              gen_random_uuid() AS receipt_id
       FROM pms.room_types room_type
       JOIN pms.inventory_days inventory
         ON inventory.property_id=room_type.property_id AND inventory.room_type_id=room_type.id
        AND inventory.stay_date >= $4::date AND inventory.stay_date < $5::date
       JOIN pms.operating_calendar_revisions revision
         ON revision.property_id=inventory.property_id
        AND revision.calendar_revision=inventory.calendar_revision
       WHERE room_type.property_id=$1::uuid AND room_type.id=$2::uuid
       GROUP BY revision.organization_id
       HAVING COUNT(DISTINCT inventory.stay_date)=($5::date-$4::date)
          AND MIN(inventory.calendar_revision)=MAX(inventory.calendar_revision)
     ), claim AS (
       INSERT INTO platform.idempotency_keys (
         operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
         property_id,response_status_code,response_body_hash,correlation_id,
         first_seen_at,last_seen_at,completed_at,expires_at
       ) SELECT 'pms','pms.direct_booking_inventory.reserve',$8,$9,'completed','property',
                $1::uuid,200,$8,$3,$7::timestamptz,$7::timestamptz,$7::timestamptz,'infinity'
         FROM source
       ON CONFLICT (operation_scope,operation,key_hash,scope_key) DO NOTHING
       RETURNING id
     ), event AS (
       INSERT INTO platform.domain_events (
         source_system,event_key,event_type,event_version,occurred_at,tenant_scope,property_id,
         resource_product,resource_type,resource_id,correlation_id,causation_id,
         idempotency_key_hash,payload,event_metadata
       ) SELECT 'pms',concat('pms.direct-booking-inventory.held.receipt.',source.receipt_id,'.v1'),
                'pms.inventory.projection_refresh_requested',1,$7::timestamptz,'property',$1::uuid,
                'pms','inventory_reservation',source.receipt_id::text,$3,$3,$8,
                jsonb_build_object('propertyId',$1,'roomTypeId',$2,'coverageFrom',$4,
                  'coverageThroughExclusive',$5,'reason','reservation_held'),
                jsonb_build_object('contractVersion',$10::text)
       FROM source,claim RETURNING id
     ), outbox AS (
       INSERT INTO platform.outbox_events (
         domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,
         resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,payload
       ) SELECT event.id,concat('distribution.inventory-projection.receipt.',source.receipt_id,'.held.v1'),
                'distribution.inventory-projection','pms.inventory.projection_refresh_requested',
                'property',$1::uuid,'pms','inventory_reservation',source.receipt_id::text,$3,$8,
                jsonb_build_object('propertyId',$1,'roomTypeId',$2,'coverageFrom',$4,
                  'coverageThroughExclusive',$5,'reason','reservation_held')
       FROM source,event RETURNING id,domain_event_id
     ), receipt AS (
       INSERT INTO pms.inventory_reservation_receipts (
         receipt_id,contract_version,receipt_owner,organization_id,property_id,room_type_id,
         check_in,check_out,room_count,quote_session_id,public_offer_key,calendar_revision,
         materialized_revision,reserve_fingerprint_hash,reserve_idempotency_key_id,
         reserve_domain_event_id,reserve_outbox_event_id,reserved_at
       ) SELECT source.receipt_id,$10,'pms',source.organization_id,$1::uuid,$2::uuid,$4::date,$5::date,
                $6,$3,$11,source.calendar_revision,source.calendar_revision,$9,claim.id,
                event.id,outbox.id,$7::timestamptz
       FROM source,claim,event,outbox RETURNING receipt_id,organization_id,property_id,room_type_id
     ), watermarks AS (
       INSERT INTO pms.inventory_reservation_day_watermarks (
         receipt_id,organization_id,property_id,room_type_id,stay_date,calendar_revision,
         inventory_revision,generated_source_revision,channel_source_revision,
         manual_source_revision,block_source_revision,booking_source_revision
       ) SELECT receipt.receipt_id,receipt.organization_id,receipt.property_id,
                receipt.room_type_id,inventory.stay_date,inventory.calendar_revision,
                inventory.inventory_revision,inventory.generated_source_revision,
                inventory.channel_source_revision,inventory.manual_source_revision,
                inventory.block_source_revision,inventory.booking_source_revision
       FROM receipt JOIN pms.inventory_days inventory
         ON inventory.property_id=receipt.property_id AND inventory.room_type_id=receipt.room_type_id
        AND inventory.stay_date >= $4::date AND inventory.stay_date < $5::date
       RETURNING receipt_id
     ) INSERT INTO pms.inventory_reservation_statuses (
         receipt_id,organization_id,property_id,lifecycle_state,lifecycle_revision
       ) SELECT receipt_id,organization_id,property_id,'reserved',1 FROM receipt
         WHERE (SELECT count(*) FROM watermarks)=($5::date-$4::date)
       RETURNING receipt_id::text AS "receiptId"`,
    [
      reservation.propertyId,
      reservation.roomTypeId,
      reservation.quoteSessionId,
      reservation.checkIn,
      reservation.checkOut,
      reservation.roomCount,
      occurredAt.toISOString(),
      keyHash,
      `sha256:${keyHash}`,
      PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
      reservation.publicOfferKey,
    ],
  );
  const receiptId = result.rows[0]?.receiptId;
  return typeof receiptId === "string"
    ? {
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        owner: "pms",
        receiptId,
      }
    : null;
}

async function releaseDirectBookingReceipt(
  transaction: Transaction,
  reservation: PmsInventoryReservationMarker,
  receiptId: string | null,
  occurredAt: Date,
  keyHash: string,
  mustRelease: boolean,
): Promise<boolean> {
  const result = await transaction.query<{ receiptId: string }>(
    `WITH source AS (
       SELECT receipt.receipt_id,receipt.organization_id,receipt.property_id
       FROM pms.inventory_reservation_receipts receipt
       JOIN pms.inventory_reservation_statuses status USING (receipt_id)
       WHERE receipt.property_id=$1::uuid AND receipt.room_type_id=$2::uuid
         AND (($12::uuid IS NOT NULL AND receipt.receipt_id=$12::uuid) OR ($12::uuid IS NULL
           AND receipt.quote_session_id=$3 AND receipt.public_offer_key=$4
           AND receipt.check_in=$5::date AND receipt.check_out=$6::date AND receipt.room_count=$7))
         AND status.lifecycle_state='reserved'
       FOR UPDATE OF status
     ), claim AS (
       SELECT id FROM platform.idempotency_keys
       WHERE operation_scope='pms' AND operation='pms.direct_booking_inventory.release'
         AND key_hash=$9 AND tenant_scope='property' AND property_id=$1::uuid
     ), event AS (
       INSERT INTO platform.domain_events (
         source_system,event_key,event_type,event_version,occurred_at,tenant_scope,property_id,
         resource_product,resource_type,resource_id,correlation_id,causation_id,
         idempotency_key_hash,payload,event_metadata
       ) SELECT 'pms',concat('pms.direct-booking-inventory.released.receipt.',source.receipt_id,'.v1'),
                'pms.inventory.projection_refresh_requested',1,$8::timestamptz,'property',$1::uuid,
                'pms','inventory_reservation',source.receipt_id::text,$3,$3,$9,
                jsonb_build_object('propertyId',$1,'roomTypeId',$2,'coverageFrom',$5,
                  'coverageThroughExclusive',$6,'reason','reservation_released'),
                jsonb_build_object('contractVersion',$10::text)
       FROM source,claim RETURNING id
     ), outbox AS (
       INSERT INTO platform.outbox_events (
         domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,
         resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,payload
       ) SELECT event.id,concat('distribution.inventory-projection.receipt.',source.receipt_id,'.released.v1'),
                'distribution.inventory-projection','pms.inventory.projection_refresh_requested',
                'property',$1::uuid,'pms','inventory_reservation',source.receipt_id::text,$3,$9,
                jsonb_build_object('propertyId',$1,'roomTypeId',$2,'coverageFrom',$5,
                  'coverageThroughExclusive',$6,'reason','reservation_released')
       FROM source,event RETURNING id,domain_event_id
     ) UPDATE pms.inventory_reservation_statuses status
       SET lifecycle_state='released',lifecycle_revision=2,release_fingerprint_hash=$11,
           release_idempotency_key_id=claim.id,release_domain_event_id=event.id,
           release_outbox_event_id=outbox.id,released_at=$8::timestamptz
       FROM source,claim,event,outbox WHERE status.receipt_id=source.receipt_id
       RETURNING status.receipt_id::text AS "receiptId"`,
    [
      reservation.propertyId,
      reservation.roomTypeId,
      reservation.quoteSessionId,
      reservation.publicOfferKey,
      reservation.checkIn,
      reservation.checkOut,
      reservation.roomCount,
      occurredAt.toISOString(),
      keyHash,
      PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
      `sha256:${keyHash}`,
      receiptId,
    ],
  );
  if (!result.rows[0]?.receiptId && mustRelease)
    throw new Error("Inventory reservation receipt could not be released");
  return typeof result.rows[0]?.receiptId === "string";
}
// prettier-ignore
async function readLinkedReceiptState(transaction: Transaction, reservation: PmsInventoryReservationMarker): Promise<"unlinked" | "missing" | "reserved" | "released" | "handed_off"> { const result = await transaction.query<{ linked: boolean; state: "reserved" | "released" | "handed_off" | null }>("SELECT room_type.linked_inventory_group_id IS NOT NULL AS linked,(SELECT status.lifecycle_state FROM pms.inventory_reservation_receipts receipt JOIN pms.inventory_reservation_statuses status USING(receipt_id) WHERE receipt.property_id=$1::uuid AND receipt.room_type_id=$2::uuid AND receipt.quote_session_id=$3 AND receipt.public_offer_key=$4 AND receipt.check_in=$5::date AND receipt.check_out=$6::date AND receipt.room_count=$7) AS state FROM pms.room_types room_type WHERE room_type.property_id=$1::uuid AND room_type.id=$2::uuid", [reservation.propertyId, reservation.roomTypeId, reservation.quoteSessionId, reservation.publicOfferKey, reservation.checkIn, reservation.checkOut, reservation.roomCount]); return result.rows[0]?.state ?? (result.rows[0]?.linked ? "missing" : "unlinked"); }
async function reconcileDirectBookingLinkedInventory(
  transaction: Transaction,
  reservation: PmsInventoryReservationMarker,
  occurredAt: Date,
  keyHash: string,
  operation: "reserve" | "release",
): Promise<void> {
  const changes = await reconcilePmsLinkedInventory(
    transaction as Parameters<typeof reconcilePmsLinkedInventory>[0],
    reservation.propertyId,
    occurredAt.toISOString(),
  );
  await enqueuePmsLinkedInventorySideEffects(
    transaction as Parameters<typeof enqueuePmsLinkedInventorySideEffects>[0],
    {
      propertyId: reservation.propertyId,
      operation,
      commandId: reservation.quoteSessionId,
      keyHash,
      acceptedAt: occurredAt.toISOString(),
      audit: { requestId: reservation.quoteSessionId },
    },
    changes,
  );
}
