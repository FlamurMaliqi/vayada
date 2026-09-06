import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect } from "vitest";
import {
  createTargetBookingWebCheckoutAdapter,
  type BookingWebCheckoutCommandContext,
} from "./bookingWebPublic.js";
import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import {
  cleanup,
  seedProperty,
  seedQuote,
  addonId,
  roomTypeId,
} from "./pendingBookingEdits.fixtures.js";
import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "../domains/stripeBookingPayments.js";
export function pendingEditFixture() {
  const intents = new Map<string, StripeBookingPaymentIntent>();
  const keys = new Map<string, string>();
  const stripe: StripeBookingPaymentProvider = {
    async createPaymentIntent(input) {
      let id = keys.get(input.idempotencyKey);
      if (!id) {
        id = `pi_${randomUUID()}`;
        keys.set(input.idempotencyKey, id);
        intents.set(id, {
          ...input,
          paymentIntentId: id,
          clientSecret: `${id}_secret`,
          status: "requires_payment_method",
        });
      }
      expect(input.captureMethod).toBe("manual");
      return intents.get(id)!;
    },
    async retrievePaymentIntent(id) {
      return intents.get(id)!;
    },
    async capturePaymentIntent() {
      throw new Error("Editing must never capture funds");
    },
    async cancelPaymentIntent(id) {
      const intent = intents.get(id)!;
      intent.status = "canceled";
      return intent;
    },
  };
  const url = process.env["TEST_DATABASE_URL"];
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const now = new Date("2027-01-01T10:00:00Z");
  const adapter = createTargetBookingWebCheckoutAdapter({
    connectionString: url ?? "",
    pool,
    stripePaymentProvider: stripe,
    now: () => new Date(now),
    inventoryReservationPort: createTargetPmsInventoryReservationPort(),
    billingConfigReadPortFactory: () => ({
      async getBillingConfig(id) {
        return {
          propertyId: id,
          activePlan: "commission",
          bookingEngineFeePercent: 5,
          channelManagerFeePercent: 8,
          affiliatePlatformFeePercent: 2,
          updatedAt: now.toISOString(),
        };
      },
    }),
  });
  function command(): BookingWebCheckoutCommandContext {
    const key = randomUUID();
    return {
      operation: "booking-edit-test",
      requestId: key,
      correlationId: key,
      idempotencyKey: key,
      fingerprint: key.replaceAll("-", "").repeat(2),
      occurredAt: now,
    };
  }
  let created: any;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("_edit_test"))
      throw new Error("Use the dedicated edit test database.");
    await cleanup(pool);
    await seedProperty(pool);
    await seedQuote(pool, randomUUID(), "edit-original", addonId);
    created = await adapter.createBooking(
      "vay-959-hotel",
      {
        quoteId: "edit-original",
        roomTypeId,
        checkIn: "2027-02-01",
        checkOut: "2027-02-03",
        adults: 2,
        children: 0,
        numberOfRooms: 1,
        paymentMethod: "pay_at_property",
        addonIds: ["spa_partner"],
        addonQuantities: { spa_partner: 2 },
        expectedTotalAmount: "220.50",
        firstName: "Ada",
        lastName: "Lovelace",
        guestEmail: "ada@example.test",
      },
      command(),
    );
  });
  afterAll(async () => {
    await adapter.close?.();
    await pool.end();
  });

  const edit = (action: string, input: Record<string, unknown>, context = command()) =>
    adapter.editRequest!(
      "vay-959-hotel",
      created.booking.id,
      action,
      { ...input, confirmationToken: created.confirmationToken },
      context,
    ) as Promise<any>;

  return {
    pool,
    now,
    adapter,
    command,
    edit,
    url,
    intents,
    stripe,
    get created() {
      return created;
    },
  };
}
