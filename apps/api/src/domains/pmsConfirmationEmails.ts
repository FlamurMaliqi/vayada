import { createHash } from "node:crypto";
import pg from "pg";
import {
  BOOKING_EMAIL_QUEUE,
  enqueueBookingLifecycleEmailJob,
  loadBookingNotificationSnapshot,
} from "../jobs/bookingEmails.js";

export function createPmsConfirmationEmails(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 2 });
  return {
    close: () => pool.end(),
    async request(propertyId: string, guestBookingId: string, key: string, actorUserId: string) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize only this booking's resend commands, without changing booking state.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `confirmation:${propertyId}:${guestBookingId}`,
        ]);
        const jobKey = `booking.confirmation.resend:${propertyId}:${guestBookingId}:${createHash("sha256").update(key).digest("hex")}`;
        const existing = await client.query<{ jobId: string }>(
          `SELECT id::text AS "jobId" FROM platform.jobs
           WHERE queue_name = $1 AND property_id = $2::uuid AND resource_id = $3
             AND (job_key = $4 OR job_metadata -> 'resendKeys' ? $4 OR (job_key LIKE 'booking.confirmation.resend:%' AND status IN ('pending', 'running')))
           ORDER BY (job_key = $4 OR COALESCE(job_metadata -> 'resendKeys' ? $4, false)) DESC LIMIT 1`,
          [BOOKING_EMAIL_QUEUE, propertyId, guestBookingId, jobKey],
        );
        if (existing.rows[0]) {
          await client.query(
            `UPDATE platform.jobs SET job_metadata = jsonb_set(job_metadata, '{resendKeys}',
               COALESCE(job_metadata -> 'resendKeys', '[]'::jsonb) || to_jsonb($2::text))
             WHERE id=$1::uuid AND job_key <> $2 AND NOT COALESCE(job_metadata -> 'resendKeys' ? $2, false)`,
            [existing.rows[0].jobId, jobKey],
          );
          await client.query("COMMIT");
          return existing.rows[0];
        }
        const booking = await loadBookingNotificationSnapshot(client, {
          propertyId,
          guestBookingId,
        });
        if (
          !booking ||
          !["confirmed", "checked_in", "in_house", "checked_out", "completed"].includes(
            booking.status,
          )
        ) {
          await client.query("ROLLBACK");
          return { error: "A confirmed reservation is required." };
        }
        if (!booking.guestEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(booking.guestEmail.trim())) {
          await client.query("ROLLBACK");
          return { error: "The guest needs a valid email address." };
        }
        const original = await client.query<{ kind: "booking_accepted" | "final_confirmation" }>(
          `SELECT payload ->> 'notificationType' AS kind FROM platform.jobs
           WHERE property_id = $1::uuid AND resource_id = $2 AND queue_name = $3
             AND payload ->> 'recipientRole' = 'guest'
             AND payload ->> 'notificationType' IN ('booking_accepted', 'final_confirmation')
           ORDER BY created_at DESC LIMIT 1`,
          [propertyId, guestBookingId, BOOKING_EMAIL_QUEUE],
        );
        const result = await enqueueBookingLifecycleEmailJob(client, {
          resendKey: jobKey,
          kind: original.rows[0]?.kind ?? "final_confirmation",
          occurredAt: new Date().toISOString(),
          actor: { type: "user", userId: actorUserId },
          source: "pms-confirmation-resend",
          booking,
        });
        await client.query("COMMIT");
        return { jobId: result.jobId };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async status(
      propertyId: string,
      guestBookingId: string,
      jobId: string,
    ): Promise<{ status: string } | null> {
      const result = await pool.query<{ status: string }>(
        `SELECT status FROM platform.jobs WHERE id = $1::uuid AND property_id = $2::uuid
         AND resource_id = $3 AND queue_name = $4 AND job_key LIKE 'booking.confirmation.resend:%'`,
        [jobId, propertyId, guestBookingId, BOOKING_EMAIL_QUEUE],
      );
      return result.rows[0] ?? null;
    },
  };
}
export type PmsConfirmationEmails = ReturnType<typeof createPmsConfirmationEmails>;
