import { describe, expect, it } from "vitest";

import { createTargetPmsInventoryReservationPort } from "../domains/pmsInventoryReservation.js";
import { createTargetBookingWebCheckoutAdapter } from "./bookingWebPublic.js";

describe("request-mode card checkout", () => {
  it("keeps a manually authorized card booking pending for host acceptance", async () => {
    const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
    const bookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e952";
    let lifecycleStatus = "draft";
    let paymentStatus = "unpaid";
    const calls: string[] = [];
    const booking = () => ({
      guestBookingId: bookingId,
      propertyId,
      publicReference: "B-REQUEST-CARD",
      sourceSystem: "booking",
      lifecycleStatus,
      paymentStatus,
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      adults: 2,
      children: 0,
      roomCount: 1,
      currency: "EUR",
      totalAmount: "60.50",
      balanceAmount: "60.50",
      bookingMetadata: { paymentMethod: "card", acceptanceMode: "request" },
      createdAt: "2026-09-01T10:00:00.000Z",
    });
    const pool = {
      async query(text: string) {
        calls.push(text);
        if (text.includes("FROM hotel_catalog.property_slugs")) {
          return { rows: [{ propertyId, displayName: "Alpenrose", defaultLocale: "en" }] };
        }
        if (text.includes("INSERT INTO platform.idempotency_keys")) {
          return { rows: [{ id: "idempotency-1" }] };
        }
        if (text.includes("FROM booking.guest_bookings booking")) return { rows: [booking()] };
        if (text.includes('account.provider_account_id AS "providerAccountRef"')) {
          return {
            rows: [
              {
                paymentId: "payment-1",
                providerPaymentIntentId: "pi_request_1",
                providerAccountRef: "acct_1",
              },
            ],
          };
        }
        if (text.includes("FOR UPDATE OF payment, booking")) {
          return {
            rows: [
              {
                paymentId: "payment-1",
                paymentStatus: "requires_action",
                propertyId,
                guestBookingId: bookingId,
                amount: "60.50",
                currency: "EUR",
                lifecycleStatus,
                bookingPaymentStatus: paymentStatus,
              },
            ],
          };
        }
        if (text.includes("SET status = 'authorized'")) return { rows: [{ id: "payment-1" }] };
        if (text.includes("SET lifecycle_status = 'pending_payment'")) {
          lifecycleStatus = "pending_payment";
          paymentStatus = "authorized";
          return { rows: [{ id: bookingId }] };
        }
        return { rows: [] };
      },
      async end() {},
    };
    const adapter = createTargetBookingWebCheckoutAdapter({
      connectionString: "postgres://unused",
      inventoryReservationPort: createTargetPmsInventoryReservationPort(),
      stripePaymentProvider: {
        async createPaymentIntent() {
          throw new Error("not used");
        },
        async retrievePaymentIntent() {
          return {
            paymentIntentId: "pi_request_1",
            clientSecret: null,
            status: "requires_capture",
            amountMinor: 6050,
            currency: "EUR",
            propertyId,
            bookingReference: "B-REQUEST-CARD",
            providerAccountRef: "acct_1",
          };
        },
        async capturePaymentIntent() {
          throw new Error("not used");
        },
        async cancelPaymentIntent() {
          throw new Error("not used");
        },
      },
      pool: pool as never,
    });

    await expect(
      adapter.confirmAuthorization("hotel-alpenrose", bookingId, {
        operation: "booking-confirm-authorization",
        requestId: "req-request-card",
        correlationId: "corr-request-card",
        idempotencyKey: "idem-request-card",
        fingerprint: "a".repeat(64),
        occurredAt: new Date("2026-09-01T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "pending", paymentStatus: "authorized" });

    expect(calls.some((sql) => sql.includes("guest_booking.payment_authorized"))).toBe(true);
    expect(calls.some((sql) => sql.includes("nightly_revenue_evidence"))).toBe(false);
    expect(calls.some((sql) => sql.includes("pms-reservation-handoff"))).toBe(false);
    expect(calls.some((sql) => sql.includes("SET status = 'paid'"))).toBe(false);
  });
});
