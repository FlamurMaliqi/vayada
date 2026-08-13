import { describe, expect, it, vi } from "vitest";

import {
  createResendBookingEmailDelivery,
  runBookingEmailDeliveryJobs,
} from "./bookingEmailDelivery.js";

describe("booking email delivery", () => {
  it("delivers a claimed booking email and records a succeeded attempt", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("RETURNING job.id::text AS id")) {
          return {
            rows: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                jobKey: "email.booking:booking-1:v1",
                attemptsCount: 1,
                workerId: "worker-1",
                payload: {
                  to: "guest@example.test",
                  subject: "Booking accepted",
                  text: "Your bank transfer instructions are attached.",
                },
              },
            ],
          };
        }
        if (text.includes("RETURNING id::text AS id")) return { rows: [{ id: "audit-1" }] };
        return { rows: [] };
      }),
    };
    const send = vi.fn(async () => undefined);

    await expect(
      runBookingEmailDeliveryJobs(
        "postgres://unused",
        { send },
        {
          pool: pool as never,
          limit: 1,
          workerId: "worker-1",
        },
      ),
    ).resolves.toEqual({ processed: 1, failed: 0 });

    expect(send).toHaveBeenCalledWith({
      to: "guest@example.test",
      subject: "Booking accepted",
      text: "Your bank transfer instructions are attached.",
      idempotencyKey: "email.booking:booking-1:v1",
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO platform.job_attempts"))).toBe(true);
    expect(queries.some((sql) => sql.includes("status = 'succeeded'"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO platform.product_audit_events"))).toBe(
      true,
    );
  });

  it("retries or dead-letters provider failures", async () => {
    const queries: string[] = [];
    const queryValues: (readonly unknown[])[] = [];
    const pool = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push(text);
        queryValues.push(values ?? []);
        if (text.includes("RETURNING job.id::text AS id")) {
          return {
            rows: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                jobKey: "email.booking:booking-1:v1",
                attemptsCount: 3,
                workerId: "worker-1",
                payload: { to: "guest@example.test", subject: "Booking", text: "Instructions" },
              },
            ],
          };
        }
        if (text.includes("RETURNING id::text AS id")) return { rows: [{ id: "audit-1" }] };
        return { rows: [] };
      }),
    };

    await expect(
      runBookingEmailDeliveryJobs(
        "postgres://unused",
        {
          send: vi.fn(async () =>
            Promise.reject(new Error("provider unavailable for guest@example.test")),
          ),
        },
        { pool: pool as never, limit: 1, workerId: "worker-1" },
      ),
    ).resolves.toEqual({ processed: 0, failed: 1 });

    expect(queries.some((sql) => sql.includes("dead_lettered"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO platform.dead_letter_events"))).toBe(
      true,
    );
    expect(queries.some((sql) => sql.includes("INSERT INTO platform.product_audit_events"))).toBe(
      true,
    );
    expect(queryValues.flat()).toContain("provider unavailable for [redacted-email]");
    expect(queryValues.flat()).not.toContain("provider unavailable for guest@example.test");
    const failureUpdate = queries.find((sql) => sql.includes("delivery_failed"));
    expect(failureUpdate).toContain("worker_id = $6");
    expect(failureUpdate).toContain("locked_by = $6");
    expect(queries.every((sql) => !sql.includes("booking.guest_bookings"))).toBe(true);
    expect(queries.every((sql) => !sql.includes("pms-reservation-handoff"))).toBe(true);
  });

  it("records a missing recipient as a retryable audited failure", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("RETURNING job.id::text AS id")) {
          return {
            rows: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                jobKey: "email.booking:booking-1:recipient:host:v1",
                attemptsCount: 1,
                workerId: "worker-1",
                payload: { to: null, subject: "New booking", text: "Booking details" },
              },
            ],
          };
        }
        if (text.includes("RETURNING id::text AS id")) return { rows: [{ id: "audit-1" }] };
        return { rows: [] };
      }),
    };
    const send = vi.fn(async () => undefined);

    await expect(
      runBookingEmailDeliveryJobs(
        "postgres://unused",
        { send },
        {
          pool: pool as never,
          limit: 1,
          workerId: "worker-1",
        },
      ),
    ).resolves.toEqual({ processed: 0, failed: 1 });

    expect(send).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("booking.notification.delivery_failed"))).toBe(true);
  });

  it("does not let a stale worker overwrite a reclaimed job", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        if (text.includes("RETURNING job.id::text AS id")) {
          return {
            rows: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                jobKey: "email.booking:booking-1:v1",
                attemptsCount: 2,
                workerId: "worker-old",
                payload: { to: "guest@example.test", subject: "Booking", text: "Details" },
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    await expect(
      runBookingEmailDeliveryJobs(
        "postgres://unused",
        { send: vi.fn(async () => undefined) },
        { pool: pool as never, limit: 1, workerId: "worker-old" },
      ),
    ).resolves.toEqual({ processed: 0, failed: 0 });

    expect(calls.some((call) => call.text.includes("status = 'timed_out'"))).toBe(true);
    const finish = calls.find((call) => call.text.includes("delivery_succeeded"));
    expect(finish?.text).toContain("worker_id = $5");
    expect(finish?.text).toContain("locked_by = $5");
    expect(finish?.text).toContain("attempts_count = $2");
    expect(finish?.values?.[4]).toBe("worker-old");
  });

  it("sends through Resend with provider idempotency", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 200 }));
    const delivery = createResendBookingEmailDelivery({
      apiKey: "re_test",
      from: "Vayada <booking@example.test>",
      fetch: request,
    });

    await delivery.send({
      to: "guest@example.test",
      subject: "Booking confirmed",
      text: "Your booking is confirmed.",
      idempotencyKey: "booking-email-1",
    });

    expect(request).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer re_test",
          "Idempotency-Key": "booking-email-1",
        }),
      }),
    );
  });
});
