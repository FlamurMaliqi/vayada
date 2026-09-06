import type pg from "pg";
import type { PendingBookingEditAttempt as Attempt } from "../routes/pendingBookingEditAttempts.js";
import {
  withTargetCheckoutTransaction,
  type PgTargetBookingWebCheckoutAdapterConfig,
} from "../routes/bookingWebPublic.js";
const cleanupRunning = new WeakSet<pg.Pool>();
export async function releaseAbandonedBookingEdits(
  pool: pg.Pool,
  config: PgTargetBookingWebCheckoutAdapterConfig,
) {
  if (cleanupRunning.has(pool)) return;
  cleanupRunning.add(pool);
  try {
    await withTargetCheckoutTransaction(pool, async (client) => {
      const attempts = await client.query<Attempt>(
        `SELECT * FROM booking.pending_booking_edit_attempts
        WHERE status='prepared' AND expires_at <= now()
          AND (payment_method <> 'card' OR $1::boolean)
          ORDER BY updated_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`,
        [Boolean(config.stripePaymentProvider)],
      );
      for (const attempt of attempts.rows) {
        if (attempt.payment_method === "card") {
          const providerRequest = attempt.provider_request as Parameters<
            NonNullable<typeof config.stripePaymentProvider>["createPaymentIntent"]
          >[0];
          let intent = attempt.provider_payment_intent_id;
          if (!intent) {
            try {
              intent = (await config.stripePaymentProvider!.createPaymentIntent(providerRequest))
                .paymentIntentId;
            } catch {
              // Move failed recovery to the back of the next sweep; one disconnected
              // account must not starve other attempts or already-durable releases.
              await client.query(
                "UPDATE booking.pending_booking_edit_attempts SET updated_at=now() WHERE id=$1",
                [attempt.id],
              );
              continue;
            }
          }
          await client.query(
            `INSERT INTO booking.edit_authorization_releases
            (provider_payment_intent_id,provider_account_ref,property_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [intent, providerRequest.providerAccountRef, providerRequest.propertyId],
          );
        }
        await client.query(
          `UPDATE booking.pending_booking_edit_attempts SET status='released',request_snapshot='{}'::jsonb,
          updated_at=now() WHERE id=$1`,
          [attempt.id],
        );
      }
    });
    if (!config.stripePaymentProvider) return;
    await withTargetCheckoutTransaction(pool, async (client) => {
      const releases = await client.query<{
        provider_payment_intent_id: string;
        provider_account_ref: string;
      }>(
        `SELECT * FROM booking.edit_authorization_releases WHERE released_at IS NULL AND next_attempt_at<=now()
         ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
      );
      for (const release of releases.rows) {
        try {
          const intent = await config.stripePaymentProvider!.cancelPaymentIntent(
            release.provider_payment_intent_id,
            release.provider_account_ref,
            `booking-edit-release:${release.provider_payment_intent_id}`,
          );
          if (intent.status !== "canceled")
            throw new Error("Authorization release is not complete.");
          await client.query(
            `UPDATE booking.edit_authorization_releases SET released_at=now(),attempts=attempts+1
            WHERE provider_payment_intent_id=$1 AND provider_account_ref=$2`,
            [release.provider_payment_intent_id, release.provider_account_ref],
          );
        } catch {
          await client.query(
            `UPDATE booking.edit_authorization_releases SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute'
            WHERE provider_payment_intent_id=$1 AND provider_account_ref=$2`,
            [release.provider_payment_intent_id, release.provider_account_ref],
          );
        }
      }
    });
  } finally {
    cleanupRunning.delete(pool);
  }
}
