import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import type { DirectBookingInventoryReservationPort } from "../platform/inventoryReservation.js";
import {
  createTargetBookingWebCheckoutAdapter,
  resolveTargetCheckoutProperty,
  type BookingWebCheckoutCommandContext,
} from "./bookingWebPublic.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const uuid = (suffix: number) => `11880000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const propertyId = uuid(1);
const roomTypeId = uuid(2);
const successfulQuoteId = uuid(3);
const rollbackQuoteId = uuid(4);
const addonId = uuid(5);
const missingAddonId = uuid(6);
const occurredAt = new Date("2027-01-01T10:00:00.000Z");
const completedReservationQuoteIds = new Set<string>();

describe.skipIf(!TEST_DATABASE_URL)(
  "Booking Web canonical attribution PostgreSQL persistence",
  () => {
    const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
    const checkoutPool = new pg.Pool({
      connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
      max: 1,
    });

    beforeAll(async () => {
      const databaseName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
      if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
        throw new Error("Unsafe test database");
      }
      completedReservationQuoteIds.clear();
      await cleanup();
      await seedProperty();
      await seedQuote(successfulQuoteId, "VAY-1188-SUCCESS", addonId);
      await seedQuote(rollbackQuoteId, "VAY-1188-ROLLBACK", missingAddonId);
    });

    afterAll(async () => {
      await cleanup();
      await checkoutPool.end();
      await admin.end();
    });

    it("owns canonical attribution across creation, replay, and rollback", async () => {
      const adapter = createAdapter(checkoutPool);
      const context = command("success");
      const request = checkoutRequest("VAY-1188-SUCCESS");

      const created = await adapter.createBooking("vay-1188-hotel", request, context);
      await expect(adapter.createBooking("vay-1188-hotel", request, context)).resolves.toEqual(
        created,
      );
      await admin.query(
        `UPDATE booking.addon_definitions
            SET price_amount = 99, ownership_kind = 'property', partner_commission_rate = NULL
          WHERE id = $1::uuid`,
        [addonId],
      );

      const persisted = await admin.query<{
        bookingChannel: string;
        directBookingSource: string;
        sourceSystem: string;
        totalAmount: string;
        bookingCount: number;
        addonCount: number;
        addonGrossAmount: string;
        addonOwnership: string;
        addonCommissionMatches: boolean;
      }>(
        `SELECT
         min(booking_channel) AS "bookingChannel",
         min(direct_booking_source) AS "directBookingSource",
         min(source_system) AS "sourceSystem",
         min(total_amount)::text AS "totalAmount",
         count(DISTINCT booking.id)::int AS "bookingCount",
         count(evidence.selection_id)::int AS "addonCount",
         min(evidence.gross_amount)::text AS "addonGrossAmount",
         min(evidence.ownership_kind) AS "addonOwnership",
         bool_and(evidence.partner_commission_rate = 18.75) AS "addonCommissionMatches"
       FROM booking.guest_bookings booking
       LEFT JOIN booking.finance_addon_purchase_evidence evidence
         ON evidence.guest_booking_id = booking.id
       WHERE booking.property_id = $1::uuid AND booking.quote_session_id = $2::uuid`,
        [propertyId, successfulQuoteId],
      );
      expect(persisted.rows[0]).toEqual({
        bookingChannel: "direct",
        directBookingSource: "booking_engine",
        sourceSystem: "booking",
        totalAmount: "220.50",
        bookingCount: 1,
        addonCount: 1,
        addonGrossAmount: "20.50",
        addonOwnership: "partner",
        addonCommissionMatches: true,
      });
      const selection = await admin.query<{
        addonDefinitionId: string;
        addonSnapshot: Record<string, unknown>;
        quantity: number;
        serviceDate: string;
      }>(
        `SELECT addon_definition_id::text AS "addonDefinitionId",
                addon_snapshot AS "addonSnapshot", quantity,
                service_date::text AS "serviceDate"
           FROM booking.booking_addon_selections
          WHERE guest_booking_id = (
            SELECT id FROM booking.guest_bookings
             WHERE property_id = $1::uuid AND quote_session_id = $2::uuid
          )`,
        [propertyId, successfulQuoteId],
      );
      expect(selection.rows).toMatchObject([
        {
          addonDefinitionId: addonId,
          addonSnapshot: { name: "Partner spa", unitAmount: "10.25", pricingModel: "per_guest" },
          quantity: 2,
          serviceDate: "2027-02-01",
        },
      ]);

      await expect(
        adapter.createBooking(
          "vay-1188-hotel",
          checkoutRequest("VAY-1188-ROLLBACK"),
          command("rollback"),
        ),
      ).rejects.toMatchObject({ constraint: "fk_booking_addon_selections_definition_property" });
      expect(completedReservationQuoteIds).toContain(rollbackQuoteId);

      const rolledBack = await admin.query<{
        bookingCount: number;
        checkoutCount: number;
        addonCount: number;
        quoteStatus: string;
        idempotencyCount: number;
        inventoryAvailable: number;
        inventoryAssigned: number;
        publicAvailable: number;
      }>(
        `SELECT
         (SELECT count(*)::int FROM booking.guest_bookings
           WHERE property_id = $1::uuid AND quote_session_id = $2::uuid) AS "bookingCount",
         (SELECT count(*)::int FROM booking.checkout_contexts
           WHERE property_id = $1::uuid AND quote_session_id = $2::uuid) AS "checkoutCount",
         (SELECT count(*)::int FROM booking.booking_addon_selections
           WHERE property_id = $1::uuid AND addon_definition_id = $3::uuid) AS "addonCount",
         (SELECT status FROM booking.quote_sessions WHERE id = $2::uuid) AS "quoteStatus",
         (SELECT count(*)::int FROM platform.idempotency_keys
           WHERE property_id = $1::uuid
             AND correlation_id = 'vay-1188-rollback-correlation') AS "idempotencyCount",
         (SELECT min(available_count)::int FROM pms.inventory_days
           WHERE property_id = $1::uuid) AS "inventoryAvailable",
         (SELECT min(assigned_count)::int FROM pms.inventory_days
           WHERE property_id = $1::uuid) AS "inventoryAssigned",
         (SELECT min(available_rooms)::int FROM distribution.public_room_offer_snapshots
           WHERE property_id = $1::uuid) AS "publicAvailable"`,
        [propertyId, rollbackQuoteId, missingAddonId],
      );
      expect(rolledBack.rows[0]).toMatchObject({
        bookingCount: 0,
        checkoutCount: 0,
        addonCount: 0,
        quoteStatus: "active",
        idempotencyCount: 0,
        inventoryAvailable: 1,
        inventoryAssigned: 1,
        publicAvailable: 1,
      });
    });

    it("reads the committed same-day policy after waiting for its property lock", async () => {
      await admin.query(
        `INSERT INTO booking.same_day_booking_policies
           (property_id, enabled, cutoff_local_time)
         VALUES ($1::uuid, TRUE, '18:00')
         ON CONFLICT (property_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, cutoff_local_time = EXCLUDED.cutoff_local_time`,
        [propertyId],
      );
      const settings = new pg.Client({ connectionString: TEST_DATABASE_URL! });
      const checkout = new pg.Client({ connectionString: TEST_DATABASE_URL! });
      await settings.connect();
      await checkout.connect();
      try {
        await settings.query("BEGIN");
        await settings.query(
          `SELECT property.id FROM hotel_catalog.properties property
           WHERE property.id = $1::uuid FOR UPDATE OF property`,
          [propertyId],
        );
        await settings.query(
          `UPDATE booking.same_day_booking_policies SET enabled = FALSE
           WHERE property_id = $1::uuid`,
          [propertyId],
        );

        await checkout.query("BEGIN");
        const pid = await backendPid(checkout);
        const propertyRead = resolveTargetCheckoutProperty(
          checkout as never,
          "vay-1188-hotel",
          true,
        );
        await waitForLockWaiter(admin, pid);
        await settings.query("COMMIT");

        await expect(propertyRead).resolves.toMatchObject({ sameDayBookingsEnabled: false });
        await checkout.query("COMMIT");
      } finally {
        await settings.query("ROLLBACK").catch(() => undefined);
        await checkout.query("ROLLBACK").catch(() => undefined);
        await settings.end();
        await checkout.end();
      }
    });

    function createAdapter(pool: pg.Pool) {
      return createTargetBookingWebCheckoutAdapter({
        connectionString: TEST_DATABASE_URL!,
        pool,
        inventoryReservationPort,
        billingConfigReadPortFactory: () => ({
          async getBillingConfig(requestedPropertyId) {
            return {
              propertyId: requestedPropertyId,
              activePlan: "commission",
              bookingEngineFeePercent: 5,
              channelManagerFeePercent: 8,
              affiliatePlatformFeePercent: 2,
              updatedAt: occurredAt.toISOString(),
            };
          },
        }),
      });
    }

    async function seedProperty(): Promise<void> {
      await admin.query(
        `INSERT INTO hotel_catalog.properties
         (id, public_id, display_name, profile_status, lifecycle_status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'VAY-1188 Hotel', 'complete', 'active')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_slugs (property_id, slug, purpose, status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'canonical', 'active')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
         VALUES ($1::uuid, 'Europe/Athens')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
         (property_id, public_id, display_name, canonical_slug,
          default_locale, supported_locales, profile_status)
       VALUES ($1::uuid, 'vay-1188-hotel', 'VAY-1188 Hotel', 'vay-1188-hotel',
               'en', ARRAY['en'], 'complete')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO finance.payment_settings
         (property_id, payments_enabled, accepted_methods, default_currency)
       VALUES ($1::uuid, TRUE, ARRAY['pay_at_property', 'cash'], 'EUR')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO booking.booking_settings
         (property_id, acceptance_mode, phone_required, default_currency)
       VALUES ($1::uuid, 'request', FALSE, 'EUR')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO booking.addon_definitions
         (id, property_id, source_addon_id, name, pricing_model, price_amount,
          currency, ownership_kind, partner_commission_rate)
       VALUES ($1::uuid, $2::uuid, 'spa_partner', 'Partner spa', 'per_guest', 10.25,
               'EUR', 'partner', 18.75)`,
        [addonId, propertyId],
      );
      await admin.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
         (property_id, finance_payment_settings_property_id, public_id, canonical_slug,
          canonical_url, booking_base_url, timezone, default_currency,
          supported_currencies, profile_status, freshness_status,
          capabilities, public_setup_completeness, data_sources)
       VALUES (
         $1::uuid, $1::uuid, 'vay-1188-hotel', 'vay-1188-hotel',
         'https://booking.example.test/vay-1188-hotel', 'https://booking.example.test',
         'Europe/Athens', 'EUR', ARRAY['EUR'], 'public', 'fresh',
         '{"paymentMethods":["pay_at_property"]}'::jsonb, '{"status":"ready"}'::jsonb,
         ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']
       )`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO pms.room_types
         (id, property_id, name, occupancy_limits, base_rate_amount, currency)
       VALUES ($1::uuid, $2::uuid, 'VAY-1188 Room', '{"adults":2,"total":2}', 100, 'EUR')`,
        [roomTypeId, propertyId],
      );
      // prettier-ignore
      await admin.query(`BEGIN; SET LOCAL session_replication_role=replica; INSERT INTO pms.operating_calendar_revisions (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at) VALUES (gen_random_uuid(),'${propertyId}',1,'pms-operating-calendar.v1',1,'Europe/Athens','year_round',0,1,1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now()); INSERT INTO pms.operating_calendar_room_bindings (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,physical_capacity_count,starting_sellable_limit_count) VALUES ('${propertyId}',1,'${roomTypeId}',1,1,2,2); COMMIT;`);
      await admin.query(
        `INSERT INTO pms.inventory_days
         (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
          inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
          generated_source_revision,channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
       SELECT $1::uuid,$2::uuid,stay_date,2,2,1,1,2,2,1,0,0,0,0
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02']) AS stay_date`,
        [propertyId, roomTypeId],
      );
      await admin.query(
        `INSERT INTO distribution.public_room_offer_snapshots
         (property_id, room_type_id, stay_date, public_offer_key, available_rooms,
          base_price_amount, currency, payment_options, freshness_status)
       SELECT $1::uuid, $2::uuid, stay_date, 'vay-1188-flex', 2,
              100, 'EUR', ARRAY['pay_at_property'], 'fresh'
       FROM unnest(ARRAY[DATE '2027-02-01', DATE '2027-02-02']) AS stay_date`,
        [propertyId, roomTypeId],
      );
    }

    async function seedQuote(id: string, reference: string, quotedAddonId: string): Promise<void> {
      await admin.query(
        `INSERT INTO booking.quote_sessions
         (id, property_id, request_hash, public_quote_reference,
          requested_check_in, requested_check_out, adults, children,
          requested_room_count, currency, selected_offer_snapshot, totals,
          policy_snapshot, expires_at)
       VALUES (
         $1::uuid, $2::uuid, $3, $4,
         DATE '2027-02-01', DATE '2027-02-03', 2, 0,
         1, 'EUR',
         jsonb_build_object(
           'roomTypeId', $5::text,
           'publicOfferKey', 'vay-1188-flex',
           'paymentMethod', 'pay_at_property',
           'acceptanceMode', 'request',
           'addonRequest', jsonb_build_object(
             'addonIds', jsonb_build_array('spa_partner'),
             'addonQuantities', '{"spa_partner":2}'::jsonb,
             'addonDates', '{}'::jsonb
           ),
           'addonPurchases', jsonb_build_array(jsonb_build_object(
             'addonDefinitionId', $6::text,
             'addonSnapshot', jsonb_build_object(
               'addonDefinitionId', $6::text,
               'sourceAddonId', 'spa_partner',
               'name', 'Partner spa',
               'pricingModel', 'per_guest',
               'unitAmount', '10.25',
               'currency', 'EUR'
             ),
             'quantity', 2,
             'serviceDate', '2027-02-01',
             'totalAmount', '20.50',
             'currency', 'EUR',
             'ownershipKind', 'partner',
             'partnerCommissionRate', '18.7500'
           ))
         ),
         '{"roomTotal":"200.00","addonTotal":"20.50","totalAmount":"220.50","balanceAmount":"220.50"}'::jsonb,
         '{}'::jsonb, TIMESTAMPTZ '2027-01-02T10:00:00Z'
       )`,
        [id, propertyId, `hash-${reference}`, reference, roomTypeId, quotedAddonId],
      );
    }

    async function cleanup(): Promise<void> {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const statement of [
          "WITH s AS (DELETE FROM pms.inventory_reservation_statuses WHERE property_id=$1::uuid), w AS (DELETE FROM pms.inventory_reservation_day_watermarks WHERE property_id=$1::uuid), r AS (DELETE FROM pms.inventory_reservation_receipts WHERE property_id=$1::uuid) DELETE FROM platform.outbox_events WHERE property_id=$1::uuid",
          "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.jobs WHERE property_id = $1::uuid",
          "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
          "DELETE FROM booking.direct_booking_summary_read_model WHERE property_id = $1::uuid",
          `DELETE FROM booking.booking_status_events
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
          `DELETE FROM booking.booking_guests
           WHERE guest_booking_id IN (
             SELECT id FROM booking.guest_bookings WHERE property_id = $1::uuid
           )`,
          "DELETE FROM booking.booking_addon_selections WHERE property_id = $1::uuid",
          "DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid",
          "DELETE FROM booking.checkout_contexts WHERE property_id = $1::uuid",
          "DELETE FROM booking.quote_sessions WHERE property_id = $1::uuid",
          "DELETE FROM booking.addon_definitions WHERE property_id = $1::uuid",
          "DELETE FROM booking.same_day_booking_policies WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_room_offer_snapshots WHERE property_id = $1::uuid",
          "DELETE FROM pms.inventory_days WHERE property_id = $1::uuid",
          "WITH b AS (DELETE FROM pms.operating_calendar_room_bindings WHERE property_id=$1::uuid) DELETE FROM pms.operating_calendar_revisions WHERE property_id=$1::uuid",
          "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid",
          "DELETE FROM booking.booking_settings WHERE property_id = $1::uuid",
          "DELETE FROM finance.payment_settings WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_locations WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.properties WHERE id = $1::uuid",
        ]) {
          await client.query(statement, [propertyId]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  },
);

const realInventoryReservationPort = createTargetPmsInventoryReservationPort();
const inventoryReservationPort: DirectBookingInventoryReservationPort = {
  async reserve(input) {
    const reservation = await realInventoryReservationPort.reserve(input);
    if (reservation) completedReservationQuoteIds.add(input.quoteSessionId);
    return reservation;
  },
  async release(input) {
    await realInventoryReservationPort.release(input);
  },
};

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]!.pid;
}

async function waitForLockWaiter(observer: pg.Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for checkout to acquire the property lock");
}

function checkoutRequest(quoteId: string): Record<string, unknown> {
  return {
    quoteId,
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    adults: 2,
    children: 0,
    numberOfRooms: 1,
    currency: "EUR",
    paymentMethod: "pay_at_property",
    addonIds: ["spa_partner"],
    addonQuantities: { spa_partner: 2 },
    expectedTotalAmount: "220.50",
    firstName: "Ada",
    lastName: "Lovelace",
    guestEmail: "ada@example.test",
    bookingChannel: "ota",
    directBookingSource: "phone",
    booking_channel: "ota",
    direct_booking_source: "email",
  };
}

function command(suffix: string): BookingWebCheckoutCommandContext {
  return {
    operation: "booking-create",
    requestId: `vay-1188-${suffix}`,
    correlationId: `vay-1188-${suffix}-correlation`,
    idempotencyKey: `vay-1188-${suffix}-idempotency`,
    fingerprint: suffix.padEnd(64, "0"),
    occurredAt,
  };
}
