import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { reconcileStripeProviderAccount, settleCapturedStripeBooking } from "./providerWebhooks.js";

const stripeAccountHash = `sha256:${createHash("sha256").update("acct_1").digest("hex")}`;

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
              bookingMetadata: {
                requestFingerprint: "a".repeat(64),
                selectedOffer: {
                  roomTypeId: "d9fccec2-eb4c-4c35-bfd3-02a748c2e117",
                  nightlyRoomAmounts: [12, 13, 14].map((day) => ({
                    stayDate: `2026-09-${day}`,
                    grossRoomAmount: 200,
                  })),
                },
              },
            },
          ],
        };
      }
      if (sql.includes("UPDATE booking.guest_bookings")) return { rows: [{ id: "booking-1" }] };
      if (sql.includes('from_status AS "fromStatus"')) {
        return { rows: [{ fromStatus: "draft", toStatus: "confirmed" }] };
      }
      if (sql.includes('AS "hostEmail"')) {
        return {
          rows: [
            {
              propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
              guestBookingId: "b9fccec2-eb4c-4c35-bfd3-02a748c2e117",
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
              bookingMetadata: {},
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO platform.domain_events")) {
        return { rows: [{ eventId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e117" }] };
      }
      if (sql.includes('RETURNING id::text AS "jobId"')) {
        return { rows: [{ jobId: "d9fccec2-eb4c-4c35-bfd3-02a748c2e117", replay: false }] };
      }
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
    expect(
      statements.some((sql) => sql.includes("INSERT INTO booking.nightly_revenue_evidence")),
    ).toBe(true);
    expect(
      statements.findIndex((sql) => sql.includes("INSERT INTO booking.nightly_revenue_evidence")),
    ).toBeLessThan(statements.findIndex((sql) => sql.includes("'pms-reservation-handoff'")));
    expect(query.mock.calls.flatMap(([, values]) => values ?? [])).toEqual(
      expect.arrayContaining(["pi_booking_1", "webhook:stripe:evt_1"]),
    );
  });

  it("promotes canonical Stripe readiness without silently publishing a gain", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('SELECT property_id::text AS "propertyId"')) {
        return { rows: [{ propertyId: "property-1" }] };
      }
      if (sql.includes("FROM hotel_catalog.properties")) {
        return { rows: [{ id: "property-1" }] };
      }
      if (
        sql.includes("FROM finance.payment_provider_accounts account") &&
        sql.includes("JOIN finance.payment_settings settings")
      ) {
        return { rows: [{ id: "provider-account-1" }] };
      }
      if (sql.includes("UPDATE finance.payment_provider_accounts")) {
        return { rows: [{ propertyId: "property-1" }], rowCount: 1 };
      }
      if (sql.includes("FROM distribution.public_hotel_bookability_profiles")) {
        return { rows: [] };
      }
      if (sql.includes("FROM finance.online_card_readiness")) {
        return { rows: [{ cardReady: false }] };
      }
      return { rows: [] };
    });
    await reconcileStripeProviderAccount({ query } as never, {
      provider: "stripe",
      receiptId: "receipt-account",
      receiptKey: "webhook:stripe:evt_account",
      receiptKeyHash: "hash",
      payloadHash: "payload-hash",
      rawPayload: { data: { object: { id: "acct_1" } } },
      normalizedPreview: {
        domainEventKey: `finance.provider-account.updated:stripe:${stripeAccountHash}:true:v1`,
        domainEventType: "finance.provider-account.updated",
        resourceProduct: "finance",
        resourceType: "provider_account",
        resourceId: stripeAccountHash,
        jobKey: `finance.reconcile-provider-account:${stripeAccountHash}:v1`,
        queueName: "finance.webhooks",
        jobType: "finance.reconcile-provider-account",
        payload: {
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          cardPaymentsStatus: "active",
          defaultCurrency: "eur",
          rawEventId: "evt_account",
        },
      },
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("onboarding_status = CASE"),
      expect.arrayContaining(["acct_1", true, true, true, "eur"]),
    );
    const update = query.mock.calls.find(([sql]) =>
      sql.includes("UPDATE finance.payment_provider_accounts"),
    );
    expect(update?.[1]?.[6]).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("public_payment_methods"))).toBe(false);
  });

  it("keeps Stripe readiness incomplete when card-payments capability is missing", async () => {
    let updateValues: readonly unknown[] | undefined;
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('SELECT property_id::text AS "propertyId"')) {
        return { rows: [{ propertyId: "property-1" }] };
      }
      if (sql.includes("FROM hotel_catalog.properties")) {
        return { rows: [{ id: "property-1" }] };
      }
      if (
        sql.includes("FROM finance.payment_provider_accounts account") &&
        sql.includes("JOIN finance.payment_settings settings")
      ) {
        return { rows: [{ id: "provider-account-1" }] };
      }
      if (sql.includes("UPDATE finance.payment_provider_accounts")) {
        updateValues = values;
        return { rows: [{ propertyId: "property-1" }], rowCount: 1 };
      }
      if (sql.includes("FROM distribution.public_hotel_bookability_profiles")) {
        return { rows: [] };
      }
      if (sql.includes("FROM finance.online_card_readiness")) {
        return { rows: [{ cardReady: false }] };
      }
      return { rows: [] };
    });
    await reconcileStripeProviderAccount({ query } as never, {
      provider: "stripe",
      receiptId: "receipt-account-missing-capability",
      receiptKey: "webhook:stripe:evt_account_missing_capability",
      receiptKeyHash: "hash",
      payloadHash: "payload-hash",
      rawPayload: { data: { object: { id: "acct_1" } } },
      normalizedPreview: {
        domainEventKey: `finance.provider-account.updated:stripe:${stripeAccountHash}:missing-capability:v1`,
        domainEventType: "finance.provider-account.updated",
        resourceProduct: "finance",
        resourceType: "provider_account",
        resourceId: stripeAccountHash,
        jobKey: `finance.reconcile-provider-account:${stripeAccountHash}:missing-capability:v1`,
        queueName: "finance.webhooks",
        jobType: "finance.reconcile-provider-account",
        payload: {
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          defaultCurrency: "eur",
          rawEventId: "evt_account_missing_capability",
        },
      },
    });

    expect(updateValues?.slice(1, 4)).toEqual([true, true, true]);
    expect(updateValues?.[6]).toBe(false);
  });

  it("uses canonical Stripe account state when an older incomplete webhook arrives last", async () => {
    const updateValues: Array<readonly unknown[]> = [];
    const executionOrder: string[] = [];
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('SELECT property_id::text AS "propertyId"')) {
        return { rows: [{ propertyId: "property-1" }] };
      }
      if (sql.includes("FROM hotel_catalog.properties")) {
        executionOrder.push("property-lock");
        return { rows: [{ id: "property-1" }] };
      }
      if (
        sql.includes("FROM finance.payment_provider_accounts account") &&
        sql.includes("JOIN finance.payment_settings settings")
      ) {
        executionOrder.push("account-lock");
        return { rows: [{ id: "provider-account-1" }] };
      }
      if (sql.includes("UPDATE finance.payment_provider_accounts")) {
        updateValues.push(values ?? []);
        return { rows: [{ propertyId: "property-1" }], rowCount: 1 };
      }
      if (sql.includes("FROM finance.online_card_readiness")) {
        return { rows: [{ cardReady: false }] };
      }
      return { rows: [] };
    });
    const retrieveAccount = vi.fn(async () => {
      executionOrder.push("retrieve");
      return {
        providerAccountRef: "acct_1",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        cardPaymentsStatus: "active",
        defaultCurrency: "eur",
      };
    });

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
          rawPayload: { data: { object: { id: "acct_1" } } },
          normalizedPreview: {
            domainEventKey: `finance.provider-account.updated:stripe:${stripeAccountHash}:${fixture.event}:v1`,
            domainEventType: "finance.provider-account.updated",
            resourceProduct: "finance",
            resourceType: "provider_account",
            resourceId: stripeAccountHash,
            jobKey: `finance.reconcile-provider-account:${stripeAccountHash}:${fixture.event}:v1`,
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
    expect(executionOrder).toEqual([
      "property-lock",
      "account-lock",
      "retrieve",
      "property-lock",
      "account-lock",
      "retrieve",
    ]);
    expect(updateValues).toHaveLength(2);
    for (const values of updateValues) {
      expect(values.slice(1, 4)).toEqual([true, true, true]);
      expect(values[6]).toBe(true);
    }
  });
});
