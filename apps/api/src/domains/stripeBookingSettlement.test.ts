import { describe, expect, it } from "vitest";

import {
  reconcileStripeBookingPaymentProviderDetails,
  settleStripeBookingPayment,
} from "./stripeBookingSettlement.js";

describe("Stripe booking lifecycle notifications", () => {
  it.each([
    ["browser", "webhook"],
    ["webhook", "browser"],
  ])("deduplicates notifications when %s settlement wins before %s", async (first, second) => {
    const fixture = settlementFixture();

    await expect(fixture.settle(first)).resolves.toBe("settled");
    await expect(fixture.settle(second)).resolves.toBe("already_settled");
    await expect(fixture.settle(`${second}-retry`)).resolves.toBe("already_settled");

    expect([...fixture.notificationJobs.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":recipient:guest:final_confirmation:v1"),
        expect.stringContaining(":recipient:host:host_new_booking:v1"),
      ]),
    );
    expect(fixture.notificationJobs.size).toBe(2);
    expect(fixture.pmsJobs).toEqual([
      "booking-checkout:create:b9fccec2-eb4c-4c35-bfd3-02a748c2e117:v1",
    ]);
  });

  it("persists the exact connected-account Stripe fee and net payout", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    await reconcileStripeBookingPaymentProviderDetails(
      {
        async query(sql, values = []) {
          calls.push({ sql, values });
          return { rows: [] };
        },
      },
      {
        paymentIntentId: "pi_booking_1",
        clientSecret: null,
        status: "succeeded",
        amountMinor: 10_000,
        currency: "EUR",
        propertyId: "property-1",
        bookingReference: "VAY-ABC123",
        providerAccountRef: "acct_property_1",
        cardBrand: "visa",
        cardLast4: "4242",
        feeBreakdown: {
          balanceTransactionId: "txn_booking_1",
          chargeId: "ch_booking_1",
          currency: "EUR",
          grossAmountMinor: 10_000,
          processorFeeAmountMinor: 320,
          applicationFeeAmountMinor: 500,
          netPayoutAmountMinor: 9_180,
        },
      },
      new Date("2026-09-01T10:00:00.000Z"),
    );

    expect(calls[0]?.sql).toContain("processor_fee_breakdown");
    expect(calls[0]?.sql).toContain("account.provider_account_id = $2");
    expect(calls[0]?.sql).toContain("payment.payment_metadata ->> 'chargeType' = 'direct'");
    expect(calls[0]?.values).toEqual(
      expect.arrayContaining(["pi_booking_1", "acct_property_1", "ch_booking_1"]),
    );
    expect(JSON.parse(String(calls[0]?.values[4]))).toMatchObject({
      status: "available",
      stripeFeeAmount: "3.20",
      applicationFeeAmount: "5.00",
      netPayoutAmount: "91.80",
    });
  });
});

function settlementFixture() {
  let settled = false;
  const domainEvents = new Map<string, string>();
  const notificationJobs = new Map<string, string>();
  const pmsJobs: string[] = [];
  const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
  const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e117";
  const bookingMetadata = {
    requestFingerprint: "a".repeat(64),
    paymentMethod: "card",
    selectedOffer: {
      roomTypeId: "d9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      nightlyRoomAmounts: [12, 13, 14].map((day) => ({
        stayDate: `2026-09-${day}`,
        grossRoomAmount: "200.00",
      })),
    },
  };
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      if (sql.includes("FOR UPDATE OF payment, booking")) {
        return {
          rows: [
            {
              paymentId: "payment-1",
              paymentStatus: settled ? "paid" : "requires_action",
              propertyId,
              guestBookingId,
              amount: "600.00",
              currency: "EUR",
              lifecycleStatus: settled ? "confirmed" : "pending_payment",
              bookingPaymentStatus: settled ? "paid" : "unpaid",
              publicReference: "B-001",
              checkIn: "2026-09-12",
              checkOut: "2026-09-15",
              adults: 2,
              children: 0,
              roomCount: 1,
              totalAmount: "600.00",
              bookingMetadata,
            },
          ],
        };
      }
      if (sql.startsWith("UPDATE finance.payments")) return { rows: [] };
      if (sql.startsWith("UPDATE booking.guest_bookings")) {
        settled = true;
        return { rows: [{ id: guestBookingId }] };
      }
      if (sql.includes("INSERT INTO booking.booking_status_events")) return { rows: [] };
      if (sql.includes("UPDATE booking.direct_booking_summary_read_model")) return { rows: [] };
      if (sql.includes("WITH booking_scope AS")) return { rows: [] };
      if (sql.includes('from_status AS "fromStatus"')) {
        return { rows: [{ fromStatus: "pending_payment", toStatus: "confirmed" }] };
      }
      if (sql.includes('AS "hostEmail"')) {
        return {
          rows: [
            {
              propertyId,
              guestBookingId,
              bookingReference: "B-001",
              guestEmail: "guest@example.test",
              guestName: "Ada Guest",
              hostEmail: "reservations@example.test",
              propertyName: "Hotel Alpenrose",
              checkIn: "2026-09-12",
              checkOut: "2026-09-15",
              totalAmount: "600.00",
              balanceAmount: "0.00",
              currency: "EUR",
              paymentMethod: "card",
              bookingMetadata,
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO platform.domain_events")) {
        const key = String(values?.[0]);
        const eventId = domainEvents.get(key) ?? `event-${domainEvents.size + 1}`;
        domainEvents.set(key, eventId);
        return { rows: [{ eventId }] };
      }
      if (sql.includes('RETURNING id::text AS "jobId"')) {
        const key = String(values?.[0]);
        const existing = notificationJobs.get(key);
        const jobId = existing ?? `notification-${notificationJobs.size + 1}`;
        notificationJobs.set(key, jobId);
        return { rows: [{ jobId, replay: Boolean(existing) }] };
      }
      if (sql.includes("INSERT INTO platform.product_audit_events")) return { rows: [] };
      if (sql.includes("INSERT INTO platform.jobs")) {
        const jobKey = String(values?.[0]);
        if (!pmsJobs.includes(jobKey)) pmsJobs.push(jobKey);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return {
    notificationJobs,
    pmsJobs,
    settle(source: string) {
      return settleStripeBookingPayment(client as never, {
        paymentIntentId: "pi_booking_1",
        amountMinor: 60_000,
        currency: "EUR",
        occurredAt: new Date("2026-09-01T10:00:00.000Z"),
        correlationId: `${source}:correlation`,
        sourceDomainEventId: null,
      });
    },
  };
}
