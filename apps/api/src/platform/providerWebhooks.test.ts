import { describe, expect, it, vi } from "vitest";

import { reconcileStripeProviderAccount, settleCapturedStripeBooking } from "./providerWebhooks.js";

describe("provider webhook booking settlement", () => {
  it("atomically settles a target card booking and enqueues the PMS handoff", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("FOR UPDATE OF payment, booking")) {
        return {
          rows: [
            {
              paymentId: "payment-1",
              paymentStatus: "requires_action",
              propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
              guestBookingId: "b9fccec2-eb4c-4c35-bfd3-02a748c2e117",
              amount: "600.00",
              currency: "EUR",
              lifecycleStatus: "draft",
              bookingPaymentStatus: "unpaid",
              publicReference: "B-001",
              checkIn: "2026-09-12",
              checkOut: "2026-09-15",
              adults: 2,
              children: 0,
              roomCount: 1,
              totalAmount: "600.00",
            },
          ],
        };
      }
      if (sql.includes("UPDATE booking.guest_bookings")) return { rows: [{ id: "booking-1" }] };
      return { rows: [], rowCount: 0 };
    });
    await settleCapturedStripeBooking(
      { query } as never,
      {
        provider: "stripe",
        receiptId: "receipt-1",
        receiptKey: "webhook:stripe:evt_1",
        receiptKeyHash: "hash",
        payloadHash: "payload-hash",
        rawPayload: {},
        normalizedPreview: {
          domainEventKey: "payment.captured:stripe:pi_booking_1:60000:v1",
          domainEventType: "payment.captured",
          resourceProduct: "finance",
          resourceType: "payment",
          resourceId: "pi_booking_1",
          jobKey: "payment.reconcile-status:payment:pi_booking_1:evt_1:v1",
          queueName: "finance.webhooks",
          jobType: "payment.reconcile-status",
          payload: { amount: 60_000 },
        },
      },
      "e9fccec2-eb4c-4c35-bfd3-02a748c2e952",
    );

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.some((sql) => sql.includes("UPDATE finance.payments"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE booking.guest_bookings"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'pms-reservation-handoff'"))).toBe(true);
    expect(query.mock.calls.flatMap(([, values]) => values ?? [])).toEqual(
      expect.arrayContaining(["pi_booking_1", "webhook:stripe:evt_1"]),
    );
  });

  it("promotes a completed Stripe account.updated event into canonical provider readiness", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("UPDATE finance.payment_provider_accounts")) {
        return { rows: [{ propertyId: "property-1" }], rowCount: 1 };
      }
      if (sql.includes("FROM distribution.public_hotel_bookability_profiles")) {
        return {
          rows: [
            {
              canonicalUrl: "https://hotel.booking.test/en",
              bookingBaseUrl: "https://hotel.booking.test",
            },
          ],
        };
      }
      return { rows: [] };
    });
    await reconcileStripeProviderAccount({ query } as never, {
      provider: "stripe",
      receiptId: "receipt-account",
      receiptKey: "webhook:stripe:evt_account",
      receiptKeyHash: "hash",
      payloadHash: "payload-hash",
      rawPayload: {},
      normalizedPreview: {
        domainEventKey: "finance.provider-account.updated:stripe:acct_1:true:v1",
        domainEventType: "finance.provider-account.updated",
        resourceProduct: "finance",
        resourceType: "provider_account",
        resourceId: "acct_1",
        jobKey: "finance.reconcile-provider-account:acct_1:v1",
        queueName: "finance.webhooks",
        jobType: "finance.reconcile-provider-account",
        payload: {
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          defaultCurrency: "eur",
          rawEventId: "evt_account",
        },
      },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("onboarding_status = CASE"),
      expect.arrayContaining(["acct_1", true, true, true, "eur"]),
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("public_payment_methods"))).toBe(true);
  });

  it("uses canonical Stripe account state when an older incomplete webhook arrives last", async () => {
    const updateValues: Array<readonly unknown[]> = [];
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("UPDATE finance.payment_provider_accounts")) {
        updateValues.push(values ?? []);
        return { rows: [{ propertyId: "property-1" }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const retrieveAccount = vi.fn(async () => ({
      providerAccountRef: "acct_1",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      cardPaymentsStatus: "active",
      defaultCurrency: "eur",
    }));

    for (const fixture of [
      { event: "evt_new", charges: true },
      { event: "evt_old", charges: false },
    ]) {
      await reconcileStripeProviderAccount(
        { query } as never,
        {
          provider: "stripe",
          receiptId: fixture.event,
          receiptKey: `webhook:stripe:${fixture.event}`,
          receiptKeyHash: "hash",
          payloadHash: "payload-hash",
          rawPayload: {},
          normalizedPreview: {
            domainEventKey: `finance.provider-account.updated:stripe:acct_1:${fixture.event}:v1`,
            domainEventType: "finance.provider-account.updated",
            resourceProduct: "finance",
            resourceType: "provider_account",
            resourceId: "acct_1",
            jobKey: `finance.reconcile-provider-account:acct_1:${fixture.event}:v1`,
            queueName: "finance.webhooks",
            jobType: "finance.reconcile-provider-account",
            payload: {
              chargesEnabled: fixture.charges,
              payoutsEnabled: fixture.charges,
              detailsSubmitted: fixture.charges,
              rawEventId: fixture.event,
            },
          },
        },
        { retrieveAccount },
      );
    }

    expect(retrieveAccount).toHaveBeenCalledTimes(2);
    expect(updateValues).toHaveLength(2);
    for (const values of updateValues) {
      expect(values.slice(1, 4)).toEqual([true, true, true]);
      expect(values[6]).toBe(true);
    }
  });
});
