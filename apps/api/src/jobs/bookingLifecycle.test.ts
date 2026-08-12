import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_LIFECYCLE_QUEUE,
  buildBookingLifecycleJobKey,
  buildBookingLifecycleSweepKey,
  createPgBookingLifecycleStore,
  runBookingLifecycleSchedulerJobs,
  type BookingLifecycleAction,
  type BookingLifecycleCandidate,
  type BookingLifecycleJobContext,
  type BookingLifecycleMutation,
  type BookingLifecycleMutationResult,
  type BookingLifecycleStore,
} from "./bookingLifecycle.js";

describe("booking lifecycle scheduler jobs", () => {
  it("expires, cancels, and cleans up due target Booking lifecycle rows idempotently", async () => {
    const now = new Date("2026-09-01T10:00:00.000Z");
    const store = createFixtureStore();

    const firstRun = await runBookingLifecycleSchedulerJobs(store, {
      now,
      workerId: "worker_fixture",
    });
    const rerun = await runBookingLifecycleSchedulerJobs(store, {
      now,
      workerId: "worker_fixture",
    });

    expect(firstRun).toMatchObject({
      scanned: 3,
      applied: 3,
      skipped: 0,
    });
    expect(rerun).toMatchObject({
      scanned: 0,
      applied: 0,
      skipped: 0,
    });

    expect(store.booking("book_pending_due")?.lifecycleStatus).toBe("expired");
    expect(store.booking("book_stale_unpaid")?.lifecycleStatus).toBe("canceled");
    expect(store.booking("book_expired_draft")?.deleted).toBe(true);
    expect(store.booking("book_not_due")?.lifecycleStatus).toBe("pending_payment");
    expect(store.booking("book_confirmed")?.lifecycleStatus).toBe("confirmed");

    expect(store.domainEvents).toHaveLength(3);
    expect(store.jobs).toHaveLength(3);
    expect(store.jobAttempts).toHaveLength(3);
    expect(store.idempotencyKeys).toHaveLength(3);
    expect(store.productAuditEvents).toHaveLength(3);

    expect(store.jobs.map((job) => job.jobKey)).toEqual([
      "booking.lifecycle-sweep:booking:book_pending_due:pending-expiry:2026-09-01T09:55:00.000Z:v1",
      "booking.lifecycle-sweep:booking:book_stale_unpaid:stale-unpaid-cancellation:created-before-2026-09-01T09:30:00.000Z:v1",
      "booking.lifecycle-sweep:booking:book_expired_draft:expired-draft-cleanup:2026-09-01T09:45:00.000Z:v1",
    ]);
    expect(store.jobs.every((job) => job.queueName === BOOKING_LIFECYCLE_QUEUE)).toBe(true);
    expect(store.statusEvents).toEqual([
      {
        guestBookingId: "book_pending_due",
        eventType: "guest_booking.expired",
        fromStatus: "pending_payment",
        toStatus: "expired",
      },
      {
        guestBookingId: "book_stale_unpaid",
        eventType: "guest_booking.canceled",
        fromStatus: "pending_payment",
        toStatus: "canceled",
      },
    ]);
  });

  it("keeps lifecycle audit payloads free of guest PII", async () => {
    const store = createFixtureStore();

    await runBookingLifecycleSchedulerJobs(store, {
      now: new Date("2026-09-01T10:00:00.000Z"),
      workerId: "worker_fixture",
    });

    const serializedAudit = JSON.stringify(store.productAuditEvents);
    expect(serializedAudit).not.toContain("Ada");
    expect(serializedAudit).not.toContain("Lovelace");
    expect(serializedAudit).not.toContain("ada@example.test");
    expect(serializedAudit).not.toContain("+49123456789");
    expect(serializedAudit).not.toContain("Late arrival");
    expect(store.productAuditEvents.every((event) => event.actorType === "system")).toBe(true);
    expect(
      store.productAuditEvents.every((event) => Object.keys(event.privatePayload).length === 0),
    ).toBe(true);
  });

  it("uses the cutover-plan lifecycle sweep key format", () => {
    const input = {
      guestBookingId: "book_123",
      action: "pending-expiry" as const,
      deadlineOrWindow: "2026-09-01T09:55:00.000Z",
    };

    expect(buildBookingLifecycleSweepKey(input)).toBe(
      "booking.lifecycle-sweep:book_123:pending-expiry:2026-09-01T09:55:00.000Z:v1",
    );
    expect(buildBookingLifecycleJobKey(input)).toBe(
      "booking.lifecycle-sweep:booking:book_123:pending-expiry:2026-09-01T09:55:00.000Z:v1",
    );
  });

  it("releases PMS inventory when an unpaid manual booking expires", async () => {
    const fixture = pgLifecycleFixture("pending_payment");
    const store = createPgBookingLifecycleStore({
      connectionString: "postgres://unused",
      pool: fixture.pool as never,
      inventoryReservationPort: fixture.inventoryReservationPort,
    });

    await runBookingLifecycleSchedulerJobs(store, {
      now: new Date("2026-09-01T10:00:00.000Z"),
      run: ["pendingBookingExpiry"],
    });

    expect(fixture.inventoryReservationPort.release).toHaveBeenCalledOnce();
  });

  it("cancels an accepted unpaid bank booking at its post-acceptance deadline", async () => {
    const fixture = pgLifecycleFixture("confirmed");
    const store = createPgBookingLifecycleStore({
      connectionString: "postgres://unused",
      pool: fixture.pool as never,
      inventoryReservationPort: fixture.inventoryReservationPort,
    });

    const result = await runBookingLifecycleSchedulerJobs(store, {
      now: new Date("2026-09-01T10:00:00.000Z"),
      run: ["pendingBookingExpiry"],
    });

    expect(result.runs[0]?.mutations[0]).toMatchObject({
      action: "accepted-payment-expiry",
      fromStatus: "confirmed",
      toStatus: "canceled",
    });
    expect(fixture.inventoryReservationPort.release).toHaveBeenCalledOnce();
    expect(fixture.calls.find((sql) => sql.includes("WITH updated AS"))).toContain(
      "NULLIF(booking_metadata ->> 'acceptedPaymentDeadlineAt', '')::timestamptz",
    );
  });

  it("does not cancel an accepted bank booking that was paid after candidate selection", async () => {
    const fixture = pgLifecycleFixture("confirmed", { paidBeforeMutation: true });
    const store = createPgBookingLifecycleStore({
      connectionString: "postgres://unused",
      pool: fixture.pool as never,
      inventoryReservationPort: fixture.inventoryReservationPort,
    });

    const result = await runBookingLifecycleSchedulerJobs(store, {
      now: new Date("2026-09-01T10:00:00.000Z"),
      run: ["pendingBookingExpiry"],
    });

    expect(result.runs[0]?.mutations[0]?.applied).toBe(false);
    expect(fixture.inventoryReservationPort.release).not.toHaveBeenCalled();
    expect(fixture.calls.find((sql) => sql.includes("WITH updated AS"))).toContain(
      "payment_status = 'unpaid'",
    );
  });

  it("cancels an open Stripe intent and releases inventory before deleting its draft", async () => {
    const fixture = pgLifecycleFixture("draft");
    const stripePaymentProvider = {
      retrievePaymentIntent: vi.fn().mockResolvedValue(stripeIntent("requires_action")),
      cancelPaymentIntent: vi.fn().mockResolvedValue(stripeIntent("canceled")),
      createPaymentIntent: vi.fn(),
    };
    const store = createPgBookingLifecycleStore({
      connectionString: "postgres://unused",
      pool: fixture.pool as never,
      inventoryReservationPort: fixture.inventoryReservationPort,
      stripePaymentProvider,
    });

    await runBookingLifecycleSchedulerJobs(store, {
      now: new Date("2026-09-01T10:00:00.000Z"),
      run: ["expiredDraftCleanup"],
    });

    expect(stripePaymentProvider.cancelPaymentIntent).toHaveBeenCalledWith(
      "pi_expiring",
      expect.stringContaining("booking-card-expire"),
    );
    expect(fixture.inventoryReservationPort.release).toHaveBeenCalledOnce();
    expect(fixture.calls.some((sql) => sql.includes("DELETE FROM booking.guest_bookings"))).toBe(
      true,
    );
  });

  it("settles a succeeded Stripe intent instead of deleting the booking after response loss", async () => {
    const fixture = pgLifecycleFixture("draft");
    const stripePaymentProvider = {
      retrievePaymentIntent: vi.fn().mockResolvedValue(stripeIntent("succeeded")),
      cancelPaymentIntent: vi.fn(),
      createPaymentIntent: vi.fn(),
    };
    const store = createPgBookingLifecycleStore({
      connectionString: "postgres://unused",
      pool: fixture.pool as never,
      inventoryReservationPort: fixture.inventoryReservationPort,
      stripePaymentProvider,
    });

    await runBookingLifecycleSchedulerJobs(store, {
      now: new Date("2026-09-01T10:00:00.000Z"),
      run: ["expiredDraftCleanup"],
    });

    expect(stripePaymentProvider.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(fixture.calls.some((sql) => sql.includes("UPDATE finance.payments"))).toBe(true);
    expect(fixture.calls.some((sql) => sql.includes("DELETE FROM booking.guest_bookings"))).toBe(
      false,
    );
    expect(fixture.calls.some((sql) => sql.includes("'pms-reservation-handoff'"))).toBe(true);
  });
});

function pgLifecycleFixture(
  status: "pending_payment" | "confirmed" | "draft",
  options: { paidBeforeMutation?: boolean } = {},
) {
  const propertyId = "a9fccec2-eb4c-4c35-bfd3-02a748c2e117";
  const guestBookingId = "b9fccec2-eb4c-4c35-bfd3-02a748c2e117";
  const bookingMetadata = {
    inventoryReservation: {
      contractVersion: "pms.inventory-reservation.v1",
      owner: "pms",
      source: "booking_engine",
      quoteSessionId: "c9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      propertyId,
      roomTypeId: "d9fccec2-eb4c-4c35-bfd3-02a748c2e117",
      publicOfferKey: "deluxe:flexible",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      roomCount: 1,
    },
  };
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (sql.includes("WITH raw_deadlines") && sql.includes(`lifecycle_status = '${status}'`)) {
      return {
        rows: [
          {
            guestBookingId,
            propertyId,
            lifecycleStatus: status,
            paymentStatus: "unpaid",
            createdAt: "2026-09-01T09:00:00.000Z",
            updatedAt: "2026-09-01T09:00:00.000Z",
            deadlineOrWindow: "2026-09-01T09:30:00.000Z",
            checkoutContextId: "e9fccec2-eb4c-4c35-bfd3-02a748c2e117",
            ...(status === "draft"
              ? {
                  providerPaymentIntentId: "pi_expiring",
                  providerAccountRef: "acct_property",
                  publicReference: "B-EXPIRING",
                }
              : {}),
          },
        ],
      };
    }
    if (sql.includes("WITH updated AS")) {
      if (options.paidBeforeMutation) return { rows: [] };
      return {
        rows: [
          {
            guestBookingId,
            fromStatus: status,
            toStatus: status === "confirmed" ? "canceled" : "expired",
            bookingMetadata,
          },
        ],
      };
    }
    if (sql.includes("FOR UPDATE OF payment, booking")) {
      return {
        rows: [
          {
            paymentId: "payment-1",
            paymentStatus: "requires_action",
            propertyId,
            guestBookingId,
            amount: "600.00",
            currency: "EUR",
            lifecycleStatus: "draft",
            bookingPaymentStatus: "unpaid",
            publicReference: "B-EXPIRING",
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
    if (sql.startsWith("UPDATE booking.guest_bookings")) return { rows: [{ id: guestBookingId }] };
    if (sql.startsWith("SELECT id FROM booking.guest_bookings"))
      return { rows: [{ id: guestBookingId }] };
    if (sql.includes('SELECT booking_metadata AS "bookingMetadata"')) {
      return { rows: [{ bookingMetadata }] };
    }
    if (sql.includes("WITH deleted AS")) return { rows: [{ guestBookingId, fromStatus: "draft" }] };
    if (sql.includes("INSERT INTO platform.idempotency_keys")) return { rows: [{ id: "idem-1" }] };
    if (sql.includes("INSERT INTO platform.domain_events")) return { rows: [{ id: "event-1" }] };
    if (sql.includes("INSERT INTO platform.jobs")) return { rows: [{ id: "job-1" }] };
    return { rows: [] };
  });
  const client = { query, release() {} };
  const pool = {
    query,
    async connect() {
      return client;
    },
    async end() {},
  };
  const inventoryReservationPort = {
    reserve: vi.fn(),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { pool, inventoryReservationPort, calls };
}

function stripeIntent(status: string) {
  return {
    paymentIntentId: "pi_expiring",
    clientSecret: null,
    status,
    amountMinor: 60_000,
    currency: "EUR",
    propertyId: "a9fccec2-eb4c-4c35-bfd3-02a748c2e117",
    bookingReference: "B-EXPIRING",
    providerAccountRef: "acct_property",
  };
}

type FixtureBooking = BookingLifecycleCandidate & {
  deleted?: boolean;
  guestPrivate: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    specialRequests: string;
  };
};

type FixtureAuditEvent = {
  auditKey: string;
  action: string;
  actorType: "system";
  redactedPayload: Record<string, unknown>;
  privatePayload: Record<string, never>;
};

function createFixtureStore(): MemoryBookingLifecycleStore {
  return new MemoryBookingLifecycleStore([
    {
      guestBookingId: "book_pending_due",
      propertyId: "prop_alpenrose",
      lifecycleStatus: "pending_payment",
      paymentStatus: "authorized",
      createdAt: "2026-09-01T09:00:00.000Z",
      updatedAt: "2026-09-01T09:00:00.000Z",
      deadlineOrWindow: "2026-09-01T09:55:00.000Z",
      guestPrivate: guestPiiFixture(),
    },
    {
      guestBookingId: "book_stale_unpaid",
      propertyId: "prop_alpenrose",
      lifecycleStatus: "pending_payment",
      paymentStatus: "unpaid",
      createdAt: "2026-09-01T09:20:00.000Z",
      updatedAt: "2026-09-01T09:20:00.000Z",
      deadlineOrWindow: "created-before-2026-09-01T09:30:00.000Z",
      guestPrivate: guestPiiFixture(),
    },
    {
      guestBookingId: "book_expired_draft",
      propertyId: "prop_alpenrose",
      lifecycleStatus: "draft",
      paymentStatus: "unpaid",
      createdAt: "2026-09-01T09:10:00.000Z",
      updatedAt: "2026-09-01T09:10:00.000Z",
      deadlineOrWindow: "2026-09-01T09:45:00.000Z",
      checkoutContextId: "checkout_expired",
      guestPrivate: guestPiiFixture(),
    },
    {
      guestBookingId: "book_not_due",
      propertyId: "prop_alpenrose",
      lifecycleStatus: "pending_payment",
      paymentStatus: "authorized",
      createdAt: "2026-09-01T09:50:00.000Z",
      updatedAt: "2026-09-01T09:50:00.000Z",
      deadlineOrWindow: "2026-09-01T10:15:00.000Z",
      guestPrivate: guestPiiFixture(),
    },
    {
      guestBookingId: "book_confirmed",
      propertyId: "prop_alpenrose",
      lifecycleStatus: "confirmed",
      paymentStatus: "paid",
      createdAt: "2026-09-01T09:00:00.000Z",
      updatedAt: "2026-09-01T09:00:00.000Z",
      deadlineOrWindow: "2026-09-01T09:30:00.000Z",
      guestPrivate: guestPiiFixture(),
    },
  ]);
}

class MemoryBookingLifecycleStore implements BookingLifecycleStore {
  readonly domainEvents: Array<{ eventKey: string; payload: Record<string, unknown> }> = [];
  readonly jobs: Array<{ jobKey: string; queueName: string; payload: Record<string, unknown> }> =
    [];
  readonly jobAttempts: Array<{ jobKey: string; attemptNumber: number }> = [];
  readonly idempotencyKeys: string[] = [];
  readonly productAuditEvents: FixtureAuditEvent[] = [];
  readonly statusEvents: Array<{
    guestBookingId: string;
    eventType: string;
    fromStatus: string;
    toStatus: string;
  }> = [];

  private readonly bookings: FixtureBooking[];

  constructor(bookings: FixtureBooking[]) {
    this.bookings = bookings;
  }

  booking(guestBookingId: string): FixtureBooking | undefined {
    return this.bookings.find((booking) => booking.guestBookingId === guestBookingId);
  }

  async findPendingBookingExpiryCandidates(
    now: Date,
    limit: number,
  ): Promise<BookingLifecycleCandidate[]> {
    return this.bookings
      .filter(
        (booking) =>
          !booking.deleted &&
          booking.lifecycleStatus === "pending_payment" &&
          booking.deadlineOrWindow.startsWith("2026-") &&
          new Date(booking.deadlineOrWindow) <= now,
      )
      .slice(0, limit);
  }

  async findStaleUnpaidBookingCandidates(
    _now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<BookingLifecycleCandidate[]> {
    return this.bookings
      .filter(
        (booking) =>
          !booking.deleted &&
          booking.lifecycleStatus === "pending_payment" &&
          booking.paymentStatus === "unpaid" &&
          new Date(booking.createdAt) <= staleBefore,
      )
      .map((booking) => ({
        ...booking,
        deadlineOrWindow: `created-before-${staleBefore.toISOString()}`,
      }))
      .slice(0, limit);
  }

  async findExpiredDraftCandidates(now: Date, limit: number): Promise<BookingLifecycleCandidate[]> {
    return this.bookings
      .filter(
        (booking) =>
          !booking.deleted &&
          booking.lifecycleStatus === "draft" &&
          new Date(booking.deadlineOrWindow) <= now,
      )
      .slice(0, limit);
  }

  async applyLifecycleMutation(
    candidate: BookingLifecycleCandidate,
    mutation: BookingLifecycleMutation,
    context: BookingLifecycleJobContext,
  ): Promise<BookingLifecycleMutationResult> {
    const booking = this.booking(candidate.guestBookingId);
    const lifecycleKey = buildBookingLifecycleSweepKey({
      guestBookingId: candidate.guestBookingId,
      action: mutation.action,
      deadlineOrWindow: mutation.deadlineOrWindow,
    });
    const jobKey = buildBookingLifecycleJobKey({
      guestBookingId: candidate.guestBookingId,
      action: mutation.action,
      deadlineOrWindow: mutation.deadlineOrWindow,
    });

    if (!booking || booking.deleted || booking.lifecycleStatus !== mutation.fromStatus) {
      return {
        action: mutation.action,
        guestBookingId: candidate.guestBookingId,
        propertyId: candidate.propertyId,
        applied: false,
        fromStatus: candidate.lifecycleStatus,
        toStatus: booking?.lifecycleStatus,
        lifecycleKey,
        jobKey,
      };
    }

    const fromStatus = booking.lifecycleStatus;
    if (mutation.deleteDraft) {
      booking.deleted = true;
    } else {
      booking.lifecycleStatus = mutation.toStatus!;
      this.statusEvents.push({
        guestBookingId: booking.guestBookingId,
        eventType: mutation.statusEventType,
        fromStatus,
        toStatus: mutation.toStatus!,
      });
    }

    const payload = {
      action: mutation.action,
      guestBookingId: booking.guestBookingId,
      propertyId: booking.propertyId,
      fromStatus,
      toStatus: mutation.toStatus ?? null,
      deadlineOrWindow: mutation.deadlineOrWindow,
      cancellationReason: mutation.cancellationReason ?? null,
    };
    if (!this.domainEvents.some((event) => event.eventKey === lifecycleKey)) {
      this.domainEvents.push({ eventKey: lifecycleKey, payload });
    }
    if (!this.jobs.some((job) => job.jobKey === jobKey)) {
      this.jobs.push({ jobKey, queueName: BOOKING_LIFECYCLE_QUEUE, payload });
      this.jobAttempts.push({ jobKey, attemptNumber: 1 });
    }
    if (!this.idempotencyKeys.includes(lifecycleKey)) {
      this.idempotencyKeys.push(lifecycleKey);
    }
    if (!this.productAuditEvents.some((event) => event.auditKey === lifecycleKey)) {
      this.productAuditEvents.push({
        auditKey: lifecycleKey,
        action: mutation.auditAction,
        actorType: "system",
        redactedPayload: payload,
        privatePayload: {},
      });
    }
    void context;

    return {
      action: mutation.action,
      guestBookingId: booking.guestBookingId,
      propertyId: booking.propertyId,
      applied: true,
      fromStatus,
      toStatus: mutation.toStatus,
      lifecycleKey,
      jobKey,
    };
  }
}

function guestPiiFixture(): FixtureBooking["guestPrivate"] {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    phone: "+49123456789",
    specialRequests: "Late arrival",
  };
}
