import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { createBankTransferBookingOperations } from "./financeBankTransferBooking.js";
import { enqueueBookingLifecycleEmailJob } from "../jobs/bookingEmails.js";
import { runBookingEmailDeliveryJobs } from "../jobs/bookingEmailDelivery.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Unsafe test database");
it.skipIf(!url)(
  "authorizes confirmation and claimed guest email reveals without retaining secrets",
  async () => {
    const pool = new pg.Pool({ connectionString: url });
    const propertyId = randomUUID(),
      bookingId = randomUUID(),
      destinationId = randomUUID();
    const tokenHash = "a".repeat(64);
    const secret = "DE89370400440532013000";
    const decrypt = vi.fn(async () => ({
      accountHolder: "Private Holder",
      accountType: "iban" as const,
      accountNumber: secret,
      bankName: "Private Bank",
      bicSwift: "COBADEFFXXX",
      instructions: "Private instructions",
    }));
    const operations = createBankTransferBookingOperations(url!, {
      async encrypt() {
        throw new Error();
      },
      decrypt,
    });
    try {
      await pool.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1::uuid,$1::text,'Test')",
        [propertyId],
      );
      await pool.query(
        `INSERT INTO finance.bank_transfer_destinations
      (id,property_id,revision,ciphertext,key_arn,account_last4) VALUES ($1,$2,1,$3,'key','3000')`,
        [destinationId, propertyId, Buffer.alloc(40)],
      );
      await pool.query(
        `INSERT INTO booking.guest_bookings
      (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,payment_status,
       check_in,check_out,currency,total_amount,balance_amount,expected_payment_method,booking_metadata)
      VALUES ($1::uuid,$2::uuid,$1::text,'booking',$1::text,'pending_payment','unpaid',CURRENT_DATE+10,CURRENT_DATE+12,'EUR',100,100,'bank_transfer',$3)`,
        [
          bookingId,
          propertyId,
          JSON.stringify({
            paymentMethod: "bank_transfer",
            confirmationTokens: { [tokenHash]: new Date(Date.now() + 86400000).toISOString() },
          }),
        ],
      );
      await pool.query(
        `INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email)
      VALUES ($1,'booker','Test','Guest','guest@example.test')`,
        [bookingId],
      );
      await operations.bind(pool, propertyId, bookingId);
      for (const input of [
        { propertyId: randomUUID(), bookingId, tokenHash },
        { propertyId, bookingId, tokenHash: "bad" },
      ])
        expect(await operations.confirmation(input)).toBeNull();
      expect(decrypt).not.toHaveBeenCalled();
      await pool.query(
        "UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,'{confirmationTokens}',$2::jsonb) WHERE id=$1",
        [bookingId, JSON.stringify({ [tokenHash]: new Date(Date.now() - 10000).toISOString() })],
      );
      expect(await operations.confirmation({ propertyId, bookingId, tokenHash })).toBeNull();
      expect(decrypt).not.toHaveBeenCalled();
      await pool.query(
        "UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,'{confirmationTokens}',$2::jsonb) WHERE id=$1",
        [bookingId, JSON.stringify({ [tokenHash]: new Date(Date.now() + 86400000).toISOString() })],
      );
      expect(await operations.confirmation({ propertyId, bookingId, tokenHash })).toContain(secret);
      expect(decrypt).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: destinationId }),
        expect.anything(),
      );
      await pool.query("UPDATE finance.bank_transfer_destinations SET enabled=FALSE WHERE id=$1", [
        destinationId,
      ]);
      expect(await operations.confirmation({ propertyId, bookingId, tokenHash })).toContain(secret);
      await pool.query(
        "UPDATE booking.guest_bookings SET payment_status='partially_paid',balance_amount=50 WHERE id=$1",
        [bookingId],
      );
      expect(await operations.confirmation({ propertyId, bookingId, tokenHash })).toContain(secret);
      const job = await enqueueBookingLifecycleEmailJob(pool, {
        kind: "request_received",
        occurredAt: new Date().toISOString(),
        booking: {
          propertyId,
          guestBookingId: bookingId,
          bookingReference: bookingId,
          guestEmail: "guest@example.test",
          paymentMethod: "bank_transfer",
          checkIn: "2026-10-01",
          checkOut: "2026-10-02",
        },
      });
      expect(
        await operations.email({ jobId: job.jobId, workerId: "unclaimed", attempt: 0 }),
      ).toBeNull();
      const send = vi.fn(async (_input: { text: string }) => undefined);
      expect(
        await runBookingEmailDeliveryJobs(
          url!,
          { send },
          { limit: 1, workerId: "bank-test", bankTransfers: operations },
        ),
      ).toEqual({ processed: 1, failed: 0 });
      expect(send.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining(secret) });
      for (const table of [
        "booking.guest_bookings",
        "platform.jobs",
        "platform.domain_events",
        "platform.product_audit_events",
      ])
        expect(
          JSON.stringify(
            (await pool.query(`SELECT * FROM ${table} WHERE property_id=$1`, [propertyId])).rows,
          ),
        ).not.toContain(secret);
      await pool.query("UPDATE booking.guest_bookings SET payment_status='paid' WHERE id=$1", [
        bookingId,
      ]);
      expect(await operations.confirmation({ propertyId, bookingId, tokenHash })).toBeNull();
      await pool.query(
        "UPDATE booking.guest_bookings SET payment_status='unpaid', booking_metadata=booking_metadata||'{\"paymentMethod\":\"card\"}' WHERE id=$1",
        [bookingId],
      );
      expect(await operations.confirmation({ propertyId, bookingId, tokenHash })).toBeNull();
      await pool.query(
        'UPDATE booking.guest_bookings SET booking_metadata=booking_metadata||\'{"paymentMethod":"bank_transfer"}\' WHERE id=$1',
        [bookingId],
      );
      await pool.query(
        "UPDATE finance.bank_transfer_destinations SET ciphertext=NULL,deleted_at=now() WHERE id=$1",
        [destinationId],
      );
      expect(await operations.confirmation({ propertyId, bookingId, tokenHash })).toBeNull();
    } finally {
      await operations.close();
      const client = await pool.connect();
      try {
        await client.query("BEGIN; SET LOCAL session_replication_role=replica");
        await client.query(
          "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id=$1)",
          [propertyId],
        );
        for (const table of [
          "platform.product_audit_events",
          "platform.jobs",
          "platform.domain_events",
          "finance.bank_transfer_bookings",
          "finance.bank_transfer_destinations",
        ])
          await client.query(`DELETE FROM ${table} WHERE property_id=$1`, [propertyId]);
        await client.query("DELETE FROM booking.booking_guests WHERE guest_booking_id=$1", [
          bookingId,
        ]);
        await client.query("DELETE FROM booking.guest_bookings WHERE id=$1", [bookingId]);
        await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
        await client.query("COMMIT");
      } finally {
        client.release();
        await pool.end();
      }
    }
  },
);
