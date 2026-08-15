import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DirectBookingInventoryReservationPort } from "../platform/inventoryReservation.js";
import {
  createTargetBookingWebCheckoutAdapter,
  type BookingWebCheckoutCommandContext,
} from "./bookingWebPublic.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const uuid = (suffix: number) => `11880000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const propertyId = uuid(1);
const roomTypeId = uuid(2);
const successfulQuoteId = uuid(3);
const rollbackQuoteId = uuid(4);
const occurredAt = new Date("2027-01-01T10:00:00.000Z");

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
      await cleanup();
      await seedProperty();
      await seedQuote(successfulQuoteId, "VAY-1188-SUCCESS");
      await seedQuote(rollbackQuoteId, "VAY-1188-ROLLBACK");
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

      const persisted = await admin.query<{
        bookingChannel: string;
        directBookingSource: string;
        sourceSystem: string;
        bookingCount: number;
      }>(
        `SELECT
         min(booking_channel) AS "bookingChannel",
         min(direct_booking_source) AS "directBookingSource",
         min(source_system) AS "sourceSystem",
         count(*)::int AS "bookingCount"
       FROM booking.guest_bookings
       WHERE property_id = $1::uuid AND quote_session_id = $2::uuid`,
        [propertyId, successfulQuoteId],
      );
      expect(persisted.rows[0]).toEqual({
        bookingChannel: "direct",
        directBookingSource: "booking_engine",
        sourceSystem: "booking",
        bookingCount: 1,
      });

      const rollbackAdapter = createAdapter(poolFailingAfterBookingInsert(checkoutPool));
      await expect(
        rollbackAdapter.createBooking(
          "vay-1188-hotel",
          checkoutRequest("VAY-1188-ROLLBACK"),
          command("rollback"),
        ),
      ).rejects.toThrow("VAY-1188 post-insert failure");

      const rolledBack = await admin.query<{
        bookingCount: number;
        checkoutCount: number;
        quoteStatus: string;
        idempotencyCount: number;
      }>(
        `SELECT
         (SELECT count(*)::int FROM booking.guest_bookings
           WHERE property_id = $1::uuid AND quote_session_id = $2::uuid) AS "bookingCount",
         (SELECT count(*)::int FROM booking.checkout_contexts
           WHERE property_id = $1::uuid AND quote_session_id = $2::uuid) AS "checkoutCount",
         (SELECT status FROM booking.quote_sessions WHERE id = $2::uuid) AS "quoteStatus",
         (SELECT count(*)::int FROM platform.idempotency_keys
           WHERE property_id = $1::uuid
             AND correlation_id = 'vay-1188-rollback-correlation') AS "idempotencyCount"`,
        [propertyId, rollbackQuoteId],
      );
      expect(rolledBack.rows[0]).toMatchObject({
        bookingCount: 0,
        checkoutCount: 0,
        quoteStatus: "active",
        idempotencyCount: 0,
      });
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
      await admin.query(
        `INSERT INTO pms.inventory_days
         (property_id, room_type_id, stay_date, total_count, available_count)
       SELECT $1::uuid, $2::uuid, stay_date, 2, 2
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

    async function seedQuote(id: string, reference: string): Promise<void> {
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
           'acceptanceMode', 'request'
         ),
         '{"roomTotal":"200.00","totalAmount":"200.00","balanceAmount":"200.00"}'::jsonb,
         '{}'::jsonb, TIMESTAMPTZ '2027-01-02T10:00:00Z'
       )`,
        [id, propertyId, `hash-${reference}`, reference, roomTypeId],
      );
    }

    async function cleanup(): Promise<void> {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        for (const statement of [
          "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.jobs WHERE property_id = $1::uuid",
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
          "DELETE FROM booking.guest_bookings WHERE property_id = $1::uuid",
          "DELETE FROM booking.checkout_contexts WHERE property_id = $1::uuid",
          "DELETE FROM booking.quote_sessions WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_room_offer_snapshots WHERE property_id = $1::uuid",
          "DELETE FROM pms.inventory_days WHERE property_id = $1::uuid",
          "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
          "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid",
          "DELETE FROM booking.booking_settings WHERE property_id = $1::uuid",
          "DELETE FROM finance.payment_settings WHERE property_id = $1::uuid",
          "DELETE FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid",
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

const inventoryReservationPort: DirectBookingInventoryReservationPort = {
  async reserve(input) {
    return {
      contractVersion: "pms.inventory-reservation.v1",
      owner: "pms",
      source: "booking_engine",
      quoteSessionId: input.quoteSessionId,
      propertyId: input.propertyId,
      roomTypeId: input.roomTypeId,
      publicOfferKey: input.publicOfferKey,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      roomCount: input.roomCount,
    };
  },
  async release() {},
};

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
    expectedTotalAmount: "200.00",
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

function poolFailingAfterBookingInsert(inner: pg.Pool): pg.Pool {
  return {
    query: inner.query.bind(inner),
    async connect() {
      const client = await inner.connect();
      const query = client.query.bind(client);
      let insertedBooking = false;
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (statement: string | pg.QueryConfig, values?: readonly unknown[]) => {
              const text = typeof statement === "string" ? statement : statement.text;
              if (insertedBooking && text.includes("UPDATE booking.guest_bookings")) {
                throw new Error("VAY-1188 post-insert failure");
              }
              const result = await query(statement as never, values as never);
              if (text.includes("INSERT INTO booking.guest_bookings")) insertedBooking = true;
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    end: inner.end.bind(inner),
  } as pg.Pool;
}
