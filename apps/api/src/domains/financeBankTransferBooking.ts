import { randomUUID } from "node:crypto";
import pg from "pg";
import type { createBankTransferCodec, BankTransferDetails } from "./financeBankTransferCodec.js";
import {
  recordBankTransferAudit,
  type BankTransferQueryable,
} from "./financeBankTransferRepository.js";

type Queryable = BankTransferQueryable;
type Destination = {
  id: string;
  propertyId: string;
  revision: number;
  ciphertext: Buffer;
  keyArn: string;
};
export type BankTransferBookingOperations = {
  bind(transaction: Queryable, propertyId: string, bookingId: string): Promise<void>;
  confirmation(input: {
    propertyId: string;
    bookingId: string;
    tokenHash: string;
  }): Promise<string | null>;
  email(input: { jobId: string; workerId: string; attempt: number }): Promise<string | null>;
};
const columns = `destination.id::text, destination.property_id::text AS "propertyId",
  destination.revision, destination.ciphertext, destination.key_arn AS "keyArn"`;
const bankBooking = `booking.booking_metadata->>'paymentMethod' = 'bank_transfer'
  AND booking.lifecycle_status IN ('pending_payment','pending_review','confirmed')
  AND booking.payment_status IN ('unpaid','pending','partially_paid')`;

export function createBankTransferBookingOperations(
  connectionString: string,
  codec: ReturnType<typeof createBankTransferCodec>,
) {
  const pool = new pg.Pool({ connectionString });
  async function reveal(query: string, values: unknown[]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query<Destination & { bookingId: string }>(query, values)).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const details = await codec.decrypt(row, row);
      await recordBankTransferAudit(client, {
        propertyId: row.propertyId,
        id: row.id,
        bookingId: row.bookingId,
        action: "revealed",
        auditKey: randomUUID(),
      });
      await client.query("COMMIT");
      return formatBankTransferInstructions(details);
    } catch {
      await client.query("ROLLBACK");
      throw new Error("Bank transfer instructions unavailable.");
    } finally {
      client.release();
    }
  }
  return {
    async bind(transaction: Queryable, propertyId: string, bookingId: string) {
      const result = await transaction.query(
        `INSERT INTO finance.bank_transfer_bookings
        (guest_booking_id,property_id,destination_id)
        SELECT booking.id,booking.property_id,destination.id
        FROM booking.guest_bookings booking JOIN finance.bank_transfer_destinations destination
          ON destination.property_id=booking.property_id AND destination.enabled
        WHERE booking.id=$1::uuid AND booking.property_id=$2::uuid AND ${bankBooking}
        FOR SHARE OF destination RETURNING guest_booking_id`,
        [bookingId, propertyId],
      );
      if (result.rows.length !== 1) throw new Error("Bank transfer destination unavailable.");
    },
    confirmation(input: { propertyId: string; bookingId: string; tokenHash: string }) {
      return reveal(
        `SELECT ${columns}, booking.id::text AS "bookingId"
        FROM finance.bank_transfer_bookings binding
        JOIN booking.guest_bookings booking ON booking.id=binding.guest_booking_id AND booking.property_id=binding.property_id
        JOIN finance.bank_transfer_destinations destination ON destination.id=binding.destination_id AND destination.property_id=binding.property_id
        WHERE booking.id=$1::uuid AND booking.property_id=$2::uuid AND ${bankBooking}
          AND destination.deleted_at IS NULL
          AND ((booking.booking_metadata->>'confirmationTokenHash'=$3
                AND (booking.booking_metadata->>'confirmationTokenExpiresAt')::timestamptz > now())
            OR (booking.booking_metadata->'confirmationTokens'->>$3)::timestamptz > now())
        FOR SHARE OF destination`,
        [input.bookingId, input.propertyId, input.tokenHash],
      );
    },
    email(input: { jobId: string; workerId: string; attempt: number }) {
      return reveal(
        `SELECT ${columns}, booking.id::text AS "bookingId"
        FROM platform.jobs job
        JOIN booking.guest_bookings booking ON booking.id::text=job.resource_id AND booking.property_id=job.property_id
        JOIN booking.booking_guests booker ON booker.guest_booking_id=booking.id AND booker.guest_role='booker'
        JOIN finance.bank_transfer_bookings binding ON binding.guest_booking_id=booking.id AND binding.property_id=booking.property_id
        JOIN finance.bank_transfer_destinations destination ON destination.id=binding.destination_id AND destination.property_id=binding.property_id
        WHERE job.id=$1::uuid AND job.locked_by=$2 AND job.attempts_count=$3 AND job.status='running'
          AND job.locked_at > now() - interval '5 minutes'
          AND job.queue_name='platform.email' AND job.resource_product='booking' AND job.resource_type='guest_booking'
          AND job.job_type IN ('email.booking-request-received','email.booking-reserved-pending-payment')
          AND job.payload->>'recipientRole'='guest' AND lower(job.payload->>'to')=lower(booker.email)
          AND ${bankBooking} AND destination.deleted_at IS NULL
        FOR SHARE OF destination`,
        [input.jobId, input.workerId, input.attempt],
      );
    },
    close: () => pool.end(),
  } satisfies BankTransferBookingOperations & { close(): Promise<void> };
}

function formatBankTransferInstructions(details: BankTransferDetails): string {
  return [
    `Account holder: ${details.accountHolder}`,
    `Bank: ${details.bankName}`,
    `${details.accountType === "iban" ? "IBAN" : "Account number"}: ${details.accountNumber}`,
    details.bicSwift ? `SWIFT/BIC: ${details.bicSwift}` : "",
    details.instructions,
  ]
    .filter(Boolean)
    .join("\n");
}
