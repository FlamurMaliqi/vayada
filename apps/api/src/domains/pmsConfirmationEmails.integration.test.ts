import pg from "pg";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createPmsConfirmationEmails } from "./pmsConfirmationEmails.js";
import {
  enqueueBookingLifecycleEmailJob,
  loadBookingNotificationSnapshot,
} from "../jobs/bookingEmails.js";
import { runBookingEmailDeliveryJobs } from "../jobs/bookingEmailDelivery.js";

const url = process.env.TEST_DATABASE_URL;
const property = randomUUID();
const booking = randomUUID();
const actor = randomUUID();
describe.skipIf(!url)("confirmation resend with target PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: url });
  const emails = createPmsConfirmationEmails(url ?? "");
  beforeAll(async () => {
    if (
      !url ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
      !new URL(url).pathname.includes("test")
    )
      throw new Error("Use an isolated local test database");
    await pool.query(
      `INSERT INTO hotel_catalog.properties(id, public_id, display_name) VALUES ($1::uuid, $1::text, 'Test Hotel')`,
      [property],
    );
    await pool.query(
      `INSERT INTO identity.users(id, email) VALUES ($1::uuid, $1::text || '@example.test')`,
      [actor],
    );
    await pool.query(
      `INSERT INTO booking.guest_bookings(id, property_id, public_reference, lifecycle_status, check_in, check_out, currency, total_amount, balance_amount, booking_metadata)
      VALUES ($1::uuid,$2,$1::text,'confirmed','2026-10-01','2026-10-04','EUR',300,100,'{"paymentMethod":"pay_at_property"}')`,
      [booking, property],
    );
    await pool.query(
      `INSERT INTO booking.booking_guests(guest_booking_id, guest_role, first_name, last_name, email) VALUES ($1,'booker','Ada','Lovelace','old@example.test')`,
      [booking],
    );
    await pool.query(
      `INSERT INTO booking.booking_addon_selections(property_id, guest_booking_id, addon_snapshot, quantity, total_amount, currency) VALUES ($1,$2,'{"name":"Breakfast"}',2,30,'EUR')`,
      [property, booking],
    );
  });
  // Audit records are append-only; this suite requires a disposable local test database.
  afterAll(async () => {
    await emails.close();
    await pool.end();
  });
  it("sends current details once, attributes staff history, and preserves booking data on failure", async () => {
    await pool.query(
      `UPDATE booking.booking_guests SET email='updated@example.test' WHERE guest_booking_id=$1`,
      [booking],
    );
    await pool.query(
      `UPDATE booking.guest_bookings SET check_out='2026-10-05', total_amount=400 WHERE id=$1`,
      [booking],
    );
    const before = (
      await pool.query(`SELECT to_jsonb(b) AS data FROM booking.guest_bookings b WHERE id=$1`, [
        booking,
      ])
    ).rows;
    const requests = await Promise.all([
      emails.request(property, booking, "one", actor),
      emails.request(property, booking, "two", actor),
    ]);
    expect(requests[0]).toEqual(requests[1]);
    const jobId = (requests[0] as { jobId: string }).jobId;
    const send = vi.fn(async () => {});
    expect(await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 1 })).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([
      expect.objectContaining({
        to: "updated@example.test",
        text: expect.stringContaining("2026-10-05"),
      }),
    ]);
    const payload = (await pool.query(`SELECT payload FROM platform.jobs WHERE id=$1`, [jobId]))
      .rows[0].payload;
    for (const value of ["400.00 EUR", "Pay at Property", "Breakfast × 2"])
      expect(payload.text).toContain(value);
    expect(await emails.request(property, booking, "one", actor)).toEqual({ jobId });
    expect(await emails.request(property, booking, "two", actor)).toEqual({ jobId });
    expect(await emails.status(property, booking, jobId)).toEqual({ status: "succeeded" });
    expect(await emails.status(actor, booking, jobId)).toBeNull();
    const audit = await pool.query(
      `SELECT actor_user_id::text AS actor, redacted_payload FROM platform.product_audit_events WHERE job_id=$1 AND action='booking.confirmation.resent'`,
      [jobId],
    );
    expect(audit.rows).toEqual([
      {
        actor,
        redacted_payload: expect.objectContaining({
          description: "Confirmation email resent by staff",
        }),
      },
    ]);
    const failed = (await emails.request(property, booking, "three", actor)) as { jobId: string };
    expect(await emails.request(property, booking, "two", actor)).toEqual({ jobId });
    await pool.query(`UPDATE platform.jobs SET max_attempts=1 WHERE id=$1`, [failed.jobId]);
    expect(
      await runBookingEmailDeliveryJobs(
        url!,
        {
          send: async () => {
            throw new Error("Provider failure");
          },
        },
        { pool, limit: 1 },
      ),
    ).toEqual({ processed: 0, failed: 1 });
    expect(await emails.status(property, booking, failed.jobId)).toEqual({
      status: "dead_lettered",
    });
    expect(
      (
        await pool.query(`SELECT to_jsonb(b) AS data FROM booking.guest_bookings b WHERE id=$1`, [
          booking,
        ])
      ).rows,
    ).toEqual(before);
    await enqueueBookingLifecycleEmailJob(pool, {
      kind: "booking_accepted",
      occurredAt: new Date().toISOString(),
      booking: (await loadBookingNotificationSnapshot(pool, {
        propertyId: property,
        guestBookingId: booking,
      }))!,
    });
    await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 1 });
    const accepted = (await emails.request(property, booking, "accepted", actor)) as {
      jobId: string;
    };
    const acceptedPayload = (
      await pool.query(`SELECT payload FROM platform.jobs WHERE id=$1`, [accepted.jobId])
    ).rows[0].payload;
    expect(acceptedPayload.template).toBe("booking_accepted");
    expect(acceptedPayload.text).toContain("We've accepted your booking request");
    await runBookingEmailDeliveryJobs(url!, { send }, { pool, limit: 1 });
    await pool.query(`UPDATE booking.booking_guests SET email='' WHERE guest_booking_id=$1`, [
      booking,
    ]);
    expect(await emails.request(property, booking, "invalid-email", actor)).toHaveProperty("error");
    expect(await emails.request(actor, booking, "wrong-property", actor)).toHaveProperty("error");
  });
});
