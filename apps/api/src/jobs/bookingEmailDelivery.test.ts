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
                payload: {
                  to: "guest@example.test",
                  subject: "Booking accepted",
                  text: "Your bank transfer instructions are attached.",
                },
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const send = vi.fn(async () => undefined);

    await expect(
      runBookingEmailDeliveryJobs("postgres://unused", { send }, { pool: pool as never, limit: 1 }),
    ).resolves.toEqual({ processed: 1, failed: 0 });

    expect(send).toHaveBeenCalledWith({
      to: "guest@example.test",
      subject: "Booking accepted",
      text: "Your bank transfer instructions are attached.",
      idempotencyKey: "email.booking:booking-1:v1",
    });
    expect(queries.some((sql) => sql.includes("INSERT INTO platform.job_attempts"))).toBe(true);
    expect(queries.some((sql) => sql.includes("status = 'succeeded'"))).toBe(true);
  });

  it("retries or dead-letters provider failures", async () => {
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
                attemptsCount: 3,
                payload: { to: "guest@example.test", subject: "Booking", text: "Instructions" },
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
        { send: vi.fn(async () => Promise.reject(new Error("provider unavailable"))) },
        { pool: pool as never, limit: 1 },
      ),
    ).resolves.toEqual({ processed: 0, failed: 1 });

    expect(queries.some((sql) => sql.includes("dead_lettered"))).toBe(true);
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
