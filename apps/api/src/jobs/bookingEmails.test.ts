import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";

import {
  BOOKING_EMAIL_QUEUE,
  BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE,
  BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE,
  bookingLifecycleEmailJobKey,
  enqueueBookingLifecycleEmailJob,
  enqueueBookingTransitionNotifications,
  type BookingLifecycleEmailInput,
} from "./bookingEmails.js";

describe("booking lifecycle email jobs", () => {
  it("deduplicates retries but sends each accepted host date revision", async () => {
    const target = createTargetEmailStore();
    const enqueue = (revision: string) =>
      enqueueBookingLifecycleEmailJob(
        target,
        bookingEmailInput({
          kind: "booking_updated",
          transition: {
            eventType: "guest_booking.host_dates_updated",
            fromStatus: "confirmed",
            toStatus: "confirmed",
            revision,
          },
        }),
      );
    const first = await enqueue("preview-one");
    const retry = await enqueue("preview-one");
    const second = await enqueue("preview-two");
    expect(retry.jobKey).toBe(first.jobKey);
    expect(second.jobKey).not.toBe(first.jobKey);
    expect(target.requiredCall("INSERT INTO platform.jobs").values?.[2]).toBe(
      "email.booking-updated",
    );
  });

  it.each([undefined, "  ", "Sorry.\r\n\r\nCall us.\r\n<script>alert(1)</script>"])(
    "renders optional cancellation text safely with paragraphs: %s",
    async (guestMessage) => {
      const target = createTargetEmailStore();
      await enqueueBookingLifecycleEmailJob(
        target,
        bookingEmailInput({
          kind: "booking_canceled",
          guestMessage,
          transition: {
            eventType: "guest_booking.canceled",
            fromStatus: "confirmed",
            toStatus: "canceled",
            reason: "property_cancellation",
          },
        }),
      );
      const payload = JSON.parse(
        String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
      );
      expect(payload.subject).toContain("Booking canceled");
      expect(payload.text).toContain("We've canceled your booking");
      expect(payload.html).toBeUndefined();
      if (guestMessage?.trim())
        expect(payload.text).toContain(`Message from us:\n${guestMessage.replace(/\r\n/g, "\n")}`);
      else expect(payload.text).not.toContain("Message from us:");
    },
  );

  it("enqueues a bank-transfer email without storing credentials", async () => {
    const target = createTargetEmailStore();

    const result = await enqueueBookingLifecycleEmailJob(
      target,
      bookingEmailInput({
        kind: "reserved_pending_payment",
        paymentDeadlineAt: "2026-09-02T10:00:00.000Z",
        bankTransferDetails: {
          accountHolder: "Hotel Alpenrose GmbH",
          iban: "DE89370400440532013000",
          bic: "COBADEFFXXX",
        },
      }),
    );

    expect(result).toMatchObject({
      status: "queued",
      jobType: BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE,
      jobKey: bookingLifecycleEmailJobKey("reserved_pending_payment", "book_bank_001", "guest", {
        eventType: "guest_booking.accepted",
        fromStatus: "pending_payment",
        toStatus: "confirmed",
      }),
    });

    const jobInsert = target.requiredCall("INSERT INTO platform.jobs");
    expect(jobInsert.values?.[1]).toBe(BOOKING_EMAIL_QUEUE);
    expect(jobInsert.values?.[2]).toBe(BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE);

    const payload = JSON.parse(String(jobInsert.values?.[8]));
    expect(payload.subject).toContain("reserved pending payment");
    expect(payload.text).toContain("We've reserved your room");
    expect(payload.text).toContain("Payment deadline: 2026-09-02T10:00:00.000Z");
    expect(JSON.stringify(payload)).not.toContain("DE89370400440532013000");
    expect(payload.bankTransferDetails).toBeUndefined();
    expect(payload.requiresBankTransferInstructions).toBe(true);

    expect(target.requiredCall("INSERT INTO platform.domain_events").values?.[1]).toBe(
      "booking.notification.reserved_pending_payment_requested",
    );
    expect(target.requiredCall("INSERT INTO platform.product_audit_events").values?.[1]).toBe(
      "booking.notification.reserved_pending_payment_requested",
    );
  });

  it("renders confirmation resends without requesting protected bank instructions", async () => {
    const target = createTargetEmailStore();

    await enqueueBookingLifecycleEmailJob(
      target,
      bookingEmailInput({
        kind: "final_confirmation",
        resendKey: "booking.confirmation.resend:test",
      }),
    );

    const jobInsert = target.requiredCall("INSERT INTO platform.jobs");
    expect(jobInsert.values?.[2]).toBe(BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE);

    const payload = JSON.parse(String(jobInsert.values?.[8]));
    expect(payload.template).toBe("booking_final_confirmation");
    expect(payload.requiresBankTransferInstructions).toBe(false);
    expect(payload.text).toContain("We look forward to welcoming you!");
    expect(payload.text).not.toContain("You can look up your booking anytime");
    expect(payload.text.split("We look forward to welcoming you!")[1]).toBe("");
  });

  it.each(["pay_at_property", "credit_card", "bank_transfer", "cash"])(
    "does not expose the internal %s identifier in guest email copy",
    async (paymentMethod) => {
      const target = createTargetEmailStore();
      const input = bookingEmailInput({ kind: "final_confirmation" });
      input.booking.paymentMethod = paymentMethod;

      await enqueueBookingLifecycleEmailJob(target, input);

      const payload = JSON.parse(
        String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
      );
      expect(payload.subject).not.toContain(paymentMethod);
      expect(payload.text).not.toContain(paymentMethod);
    },
  );

  it("reuses the same customer-facing job for duplicate command retries", async () => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({
      kind: "final_confirmation",
      causationId: "finance.manual_payment.record:cmd-bank-paid-001",
    });

    const first = await enqueueBookingLifecycleEmailJob(target, input);
    const retry = await enqueueBookingLifecycleEmailJob(target, input);

    expect(first?.status).toBe("queued");
    expect(retry).toMatchObject({
      status: "idempotent_replay",
      jobId: first?.jobId,
      jobKey: first?.jobKey,
    });
    expect(
      target.calls.filter((call) => call.text.includes("INSERT INTO platform.jobs")),
    ).toHaveLength(2);
  });

  it("keeps existing guest-only callers compatible while lifecycle wiring migrates", async () => {
    const target = createTargetEmailStore();
    const input = bookingEmailInput({ kind: "final_confirmation" });
    delete input.recipient;
    delete input.transition;

    const result = await enqueueBookingLifecycleEmailJob(target, input);

    expect(result.jobKey).toBe(bookingLifecycleEmailJobKey("final_confirmation", "book_bank_001"));
    const payload = JSON.parse(
      String(target.requiredCall("INSERT INTO platform.jobs").values?.[8]),
    );
    expect(payload).toMatchObject({
      to: "guest@example.test",
      recipientRole: "guest",
      transition: {
        eventType: "guest_booking.payment_received",
        fromStatus: "pending_payment",
        toStatus: "confirmed",
      },
    });
  });

  it("resolves guest and host recipients for a confirmed lifecycle transition", async () => {
    const target = createTargetEmailStore();

    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.payment_received",
        fromStatus: "pending_payment",
        toStatus: "confirmed",
      },
    });

    expect(enqueued).toHaveLength(2);
    const payloads = target.calls
      .filter((call) => call.text.includes("INSERT INTO platform.jobs"))
      .map((call) => JSON.parse(String(call.values?.[8])));
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "guest@example.test", recipientRole: "guest" }),
        expect.objectContaining({ to: "reservations@alpenrose.test", recipientRole: "host" }),
      ]),
    );
    expect(enqueued.map((job) => job.jobKey)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":recipient:guest:final_confirmation:v1"),
        expect.stringContaining(":recipient:host:host_new_booking:v1"),
      ]),
    );
  });

  it("uses current bank-transfer pending state for request and review notifications", async () => {
    const target = createTargetEmailStore({ paymentMethod: "bank_transfer" });

    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.created",
        fromStatus: null,
        toStatus: "pending_payment",
      },
    });

    expect(enqueued.map((job) => job.jobType)).toEqual([
      "email.booking-request-received",
      "email.booking-host-review-required",
    ]);
  });

  it("waits for card authorization before notifying a future request-mode booking", async () => {
    const target = createTargetEmailStore({
      paymentMethod: "card",
      bookingMetadata: { acceptanceMode: "request" },
    });
    const input = {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
    };

    await expect(
      enqueueBookingTransitionNotifications(target, {
        ...input,
        transition: { eventType: "guest_booking.created", fromStatus: null, toStatus: "draft" },
      }),
    ).resolves.toEqual([]);
    const enqueued = await enqueueBookingTransitionNotifications(target, {
      ...input,
      transition: {
        eventType: "guest_booking.payment_authorized",
        fromStatus: "draft",
        toStatus: "pending_payment",
      },
    });

    expect(enqueued.map((job) => job.jobType)).toEqual([
      "email.booking-request-received",
      "email.booking-host-review-required",
    ]);
  });

  it.each([
    ["guest_booking.accepted", "confirmed", "email.booking-reserved-pending-payment", null],
    ["guest_booking.rejected", "declined", "email.booking-rejected", null],
    ["guest_booking.expired", "expired", "email.booking-expired", null],
    ["guest_booking.canceled", "canceled", "email.booking-expired", "accepted_payment_expired"],
  ])(
    "maps %s to the appropriate guest lifecycle message",
    async (eventType, toStatus, jobType, reason) => {
      const target = createTargetEmailStore({ paymentMethod: "bank_transfer" });

      const enqueued = await enqueueBookingTransitionNotifications(target, {
        propertyId: "f2000000-0000-0000-0000-000000000951",
        guestBookingId: "book_bank_001",
        occurredAt: "2026-09-01T10:00:00.000Z",
        transition: { eventType, fromStatus: "pending_payment", toStatus, reason },
      });

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.jobType).toBe(jobType);
    },
  );

  it("queues an auditable host failure instead of using the guest or creator address", async () => {
    const target = createTargetEmailStore({ hostEmail: null });

    const enqueued = await enqueueBookingTransitionNotifications(target, {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      occurredAt: "2026-09-01T10:00:00.000Z",
      transition: {
        eventType: "guest_booking.created",
        fromStatus: null,
        toStatus: "confirmed",
      },
    });

    expect(enqueued).toHaveLength(2);
    expect(enqueued[1]?.jobKey).toContain(":recipient:host:");
    const payloads = target.calls
      .filter((call) => call.text.includes("INSERT INTO platform.jobs"))
      .map((call) => JSON.parse(String(call.values?.[8])));
    expect(payloads).toContainEqual(expect.objectContaining({ to: null, recipientRole: "host" }));
    const recipientQuery = target.requiredCall('AS "hostEmail"').text;
    expect(recipientQuery).toContain("contact.purpose = 'operations'");
    expect(recipientQuery).toContain(
      "contact.purpose = 'general' AND contact.source_system = 'booking'",
    );
    expect(recipientQuery).not.toContain("contact.purpose = 'creator'");
  });
});

type QueryCall = { text: string; values?: readonly unknown[] };

function createTargetEmailStore(snapshotOverrides: Record<string, unknown> = {}): {
  calls: QueryCall[];
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  requiredCall(fragment: string): QueryCall;
} {
  const calls: QueryCall[] = [];
  const jobs = new Map<string, string>();
  let sequence = 0;

  return {
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }> {
      calls.push({ text, values });
      if (text.includes('AS "hostEmail"')) {
        return {
          rows: [
            {
              propertyId: "f2000000-0000-0000-0000-000000000951",
              guestBookingId: "book_bank_001",
              bookingReference: "B-BANK-001",
              guestEmail: "guest@example.test",
              guestName: "Ada Guest",
              hostEmail: "reservations@alpenrose.test",
              propertyName: "Hotel Alpenrose",
              checkIn: "2026-09-12",
              checkOut: "2026-09-15",
              totalAmount: "600.00",
              balanceAmount: "200.00",
              currency: "EUR",
              paymentMethod: "card",
              bookingMetadata: {},
              ...snapshotOverrides,
            } as unknown as T,
          ],
        };
      }
      if (text.includes("INSERT INTO platform.domain_events")) {
        sequence += 1;
        return { rows: [{ eventId: `event_booking_email_${sequence}` } as unknown as T] };
      }
      if (text.includes("INSERT INTO platform.jobs")) {
        const jobKey = String(values?.[0]);
        const existingJobId = jobs.get(jobKey);
        if (existingJobId) {
          return { rows: [{ jobId: existingJobId, replay: true } as unknown as T] };
        }
        const jobId = `job_booking_email_${jobs.size + 1}`;
        jobs.set(jobKey, jobId);
        return { rows: [{ jobId, replay: false } as unknown as T] };
      }
      return { rows: [] as T[] };
    },
    requiredCall(fragment: string) {
      const call = calls.find((candidate) => candidate.text.includes(fragment));
      expect(call, fragment).toBeDefined();
      return call!;
    },
  };
}

function bookingEmailInput(
  overrides: Partial<BookingLifecycleEmailInput>,
): BookingLifecycleEmailInput {
  return {
    kind: "reserved_pending_payment",
    occurredAt: "2026-09-01T10:00:00.000Z",
    correlationId: "corr-booking-email-001",
    causationId: "booking.accept:book_bank_001",
    actor: { type: "user", userId: "f1000000-0000-0000-0000-000000000951" },
    recipient: { role: "guest", email: "guest@example.test" },
    transition: {
      eventType: "guest_booking.accepted",
      fromStatus: "pending_payment",
      toStatus: "confirmed",
    },
    booking: {
      propertyId: "f2000000-0000-0000-0000-000000000951",
      guestBookingId: "book_bank_001",
      bookingReference: "B-BANK-001",
      guestEmail: "guest@example.test",
      guestName: "Ada Guest",
      propertyName: "Hotel Alpenrose",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      totalAmount: "600.00",
      balanceAmount: "200.00",
      currency: "EUR",
      paymentMethod: "bank_transfer",
    },
    ...overrides,
  };
}
