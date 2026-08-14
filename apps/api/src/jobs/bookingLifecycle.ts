import { createHash } from "node:crypto";
import pg from "pg";

import type { StripeBookingPaymentProvider } from "../domains/stripeBookingPayments.js";
import {
  captureDirectNightlyRevenueEvidence,
  settleStripeBookingPayment,
} from "../domains/stripeBookingSettlement.js";
import {
  inventoryReservationReceiptFromBookingMetadata,
  type DirectBookingInventoryReservationPort,
} from "../platform/inventoryReservation.js";
import { enqueueBookingTransitionNotifications } from "./bookingEmails.js";

export const BOOKING_LIFECYCLE_QUEUE = "booking-lifecycle";
export const DEFAULT_STALE_UNPAID_MINUTES = 30;
export const DEFAULT_BOOKING_LIFECYCLE_LIMIT = 100;

export type BookingLifecycleAction =
  | "pending-expiry"
  | "accepted-payment-expiry"
  | "stale-unpaid-cancellation"
  | "expired-draft-cleanup";

export type BookingLifecycleRunName =
  | "pendingBookingExpiry"
  | "staleUnpaidCancellation"
  | "expiredDraftCleanup";

export type BookingLifecycleCandidate = {
  guestBookingId: string;
  propertyId: string;
  lifecycleStatus: "draft" | "pending_payment" | string;
  paymentStatus: string;
  createdAt: string;
  updatedAt: string;
  deadlineOrWindow: string;
  checkoutContextId?: string | null;
  providerPaymentIntentId?: string | null;
  publicReference?: string | null;
  providerAccountRef?: string | null;
};

export type BookingLifecycleJobContext = {
  now: Date;
  correlationId: string;
  workerId: string;
};

export type BookingLifecycleMutation = {
  action: BookingLifecycleAction;
  fromStatus: string;
  toStatus?: "canceled" | "expired";
  cancellationReason?: string;
  statusEventType: string;
  auditAction: string;
  jobType: string;
  deadlineOrWindow: string;
  deleteDraft: boolean;
};

export type BookingLifecycleMutationResult = {
  action: BookingLifecycleAction;
  guestBookingId: string;
  propertyId: string;
  applied: boolean;
  fromStatus: string;
  toStatus?: string;
  lifecycleKey: string;
  jobKey: string;
};

export type BookingLifecycleRunResult = {
  name: BookingLifecycleRunName;
  scanned: number;
  applied: number;
  skipped: number;
  failed: number;
  mutations: BookingLifecycleMutationResult[];
  failures: Array<{
    guestBookingId: string;
    propertyId: string;
    action: BookingLifecycleAction;
    errorMessage: string;
  }>;
};

export type BookingLifecycleSchedulerResult = {
  runs: BookingLifecycleRunResult[];
  scanned: number;
  applied: number;
  skipped: number;
  failed: number;
};

export type BookingLifecycleStore = {
  findPendingBookingExpiryCandidates(
    now: Date,
    limit: number,
  ): Promise<BookingLifecycleCandidate[]>;
  findStaleUnpaidBookingCandidates(
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<BookingLifecycleCandidate[]>;
  findExpiredDraftCandidates(now: Date, limit: number): Promise<BookingLifecycleCandidate[]>;
  applyLifecycleMutation(
    candidate: BookingLifecycleCandidate,
    mutation: BookingLifecycleMutation,
    context: BookingLifecycleJobContext,
  ): Promise<BookingLifecycleMutationResult>;
};

export type BookingLifecycleSchedulerOptions = {
  now?: Date;
  limit?: number;
  staleUnpaidMinutes?: number;
  workerId?: string;
  run?: readonly BookingLifecycleRunName[];
};

type PgBookingLifecycleStoreConfig = {
  connectionString: string;
  max?: number;
  inventoryReservationPort?: DirectBookingInventoryReservationPort;
  stripePaymentProvider?: StripeBookingPaymentProvider;
  pool?: pg.Pool;
};

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type CandidateRow = {
  guestBookingId: string;
  propertyId: string;
  lifecycleStatus: string;
  paymentStatus: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  deadlineOrWindow: Date | string;
  checkoutContextId?: string | null;
  providerPaymentIntentId?: string | null;
  publicReference?: string | null;
  providerAccountRef?: string | null;
};

const LIFECYCLE_RUNS: readonly BookingLifecycleRunName[] = [
  "pendingBookingExpiry",
  "staleUnpaidCancellation",
  "expiredDraftCleanup",
];

const MUTATIONS: Record<
  BookingLifecycleAction,
  Omit<BookingLifecycleMutation, "deadlineOrWindow">
> = {
  "pending-expiry": {
    action: "pending-expiry",
    fromStatus: "pending_payment",
    toStatus: "expired",
    cancellationReason: "pending_booking_expired",
    statusEventType: "guest_booking.expired",
    auditAction: "booking.lifecycle.expire_pending",
    jobType: "booking.lifecycle-sweep.expire-pending",
    deleteDraft: false,
  },
  "accepted-payment-expiry": {
    action: "accepted-payment-expiry",
    fromStatus: "confirmed",
    toStatus: "canceled",
    cancellationReason: "accepted_payment_expired",
    statusEventType: "guest_booking.canceled",
    auditAction: "booking.lifecycle.cancel_accepted_unpaid",
    jobType: "booking.lifecycle-sweep.cancel-accepted-unpaid",
    deleteDraft: false,
  },
  "stale-unpaid-cancellation": {
    action: "stale-unpaid-cancellation",
    fromStatus: "pending_payment",
    toStatus: "canceled",
    cancellationReason: "stale_unpaid_booking",
    statusEventType: "guest_booking.canceled",
    auditAction: "booking.lifecycle.cancel_stale_unpaid",
    jobType: "booking.lifecycle-sweep.cancel-stale-unpaid",
    deleteDraft: false,
  },
  "expired-draft-cleanup": {
    action: "expired-draft-cleanup",
    fromStatus: "draft",
    statusEventType: "guest_booking.draft_deleted",
    auditAction: "booking.lifecycle.cleanup_expired_draft",
    jobType: "booking.lifecycle-sweep.cleanup-expired-draft",
    deleteDraft: true,
  },
};

export function createPgBookingLifecycleStore(
  config: PgBookingLifecycleStoreConfig,
): BookingLifecycleStore & { close(): Promise<void> } {
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async findPendingBookingExpiryCandidates(now, limit) {
      return selectPendingBookingExpiryCandidates(pool, now, limit);
    },
    async findStaleUnpaidBookingCandidates(now, staleBefore, limit) {
      return selectStaleUnpaidBookingCandidates(pool, now, staleBefore, limit);
    },
    async findExpiredDraftCandidates(now, limit) {
      return selectExpiredDraftCandidates(pool, now, limit);
    },
    async applyLifecycleMutation(candidate, mutation, context) {
      return applyPgLifecycleMutation(pool, candidate, mutation, context, config);
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

export async function runBookingLifecycleSchedulerJobs(
  store: BookingLifecycleStore,
  options: BookingLifecycleSchedulerOptions = {},
): Promise<BookingLifecycleSchedulerResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_BOOKING_LIFECYCLE_LIMIT;
  const staleBefore = new Date(
    now.getTime() - (options.staleUnpaidMinutes ?? DEFAULT_STALE_UNPAID_MINUTES) * 60 * 1000,
  );
  const context: BookingLifecycleJobContext = {
    now,
    correlationId: `booking.lifecycle-sweep:${now.toISOString()}`,
    workerId: options.workerId ?? "booking-lifecycle-scheduler",
  };
  const selectedRuns = options.run ?? LIFECYCLE_RUNS;
  const runs: BookingLifecycleRunResult[] = [];

  for (const runName of selectedRuns) {
    const run = await runBookingLifecycleJob(store, runName, {
      now,
      staleBefore,
      limit,
      context,
    });
    runs.push(run);
  }

  return {
    runs,
    scanned: sumBy(runs, "scanned"),
    applied: sumBy(runs, "applied"),
    skipped: sumBy(runs, "skipped"),
    failed: sumBy(runs, "failed"),
  };
}

export function buildBookingLifecycleSweepKey(input: {
  guestBookingId: string;
  action: BookingLifecycleAction;
  deadlineOrWindow: string;
}): string {
  return `booking.lifecycle-sweep:${input.guestBookingId}:${input.action}:${input.deadlineOrWindow}:v1`;
}

export function buildBookingLifecycleJobKey(input: {
  guestBookingId: string;
  action: BookingLifecycleAction;
  deadlineOrWindow: string;
}): string {
  return `booking.lifecycle-sweep:booking:${input.guestBookingId}:${input.action}:${input.deadlineOrWindow}:v1`;
}

async function runBookingLifecycleJob(
  store: BookingLifecycleStore,
  runName: BookingLifecycleRunName,
  input: {
    now: Date;
    staleBefore: Date;
    limit: number;
    context: BookingLifecycleJobContext;
  },
): Promise<BookingLifecycleRunResult> {
  const candidates = await selectCandidatesForRun(store, runName, input);
  const mutations: BookingLifecycleMutationResult[] = [];
  const failures: BookingLifecycleRunResult["failures"] = [];

  for (const candidate of candidates) {
    const mutationTemplate = mutationForRun(runName, candidate);
    try {
      const result = await store.applyLifecycleMutation(
        candidate,
        { ...mutationTemplate, deadlineOrWindow: candidate.deadlineOrWindow },
        input.context,
      );
      mutations.push(result);
    } catch (error) {
      failures.push({
        guestBookingId: candidate.guestBookingId,
        propertyId: candidate.propertyId,
        action: mutationTemplate.action,
        errorMessage: error instanceof Error ? error.message : "Booking lifecycle mutation failed.",
      });
    }
  }

  const applied = mutations.filter((mutation) => mutation.applied).length;
  return {
    name: runName,
    scanned: candidates.length,
    applied,
    skipped: mutations.length - applied,
    failed: failures.length,
    mutations,
    failures,
  };
}

function selectCandidatesForRun(
  store: BookingLifecycleStore,
  runName: BookingLifecycleRunName,
  input: { now: Date; staleBefore: Date; limit: number },
): Promise<BookingLifecycleCandidate[]> {
  switch (runName) {
    case "pendingBookingExpiry":
      return store.findPendingBookingExpiryCandidates(input.now, input.limit);
    case "staleUnpaidCancellation":
      return store.findStaleUnpaidBookingCandidates(input.now, input.staleBefore, input.limit);
    case "expiredDraftCleanup":
      return store.findExpiredDraftCandidates(input.now, input.limit);
  }
}

function mutationForRun(
  runName: BookingLifecycleRunName,
  candidate: BookingLifecycleCandidate,
): Omit<BookingLifecycleMutation, "deadlineOrWindow"> {
  switch (runName) {
    case "pendingBookingExpiry":
      return candidate.lifecycleStatus === "confirmed"
        ? MUTATIONS["accepted-payment-expiry"]
        : MUTATIONS["pending-expiry"];
    case "staleUnpaidCancellation":
      return MUTATIONS["stale-unpaid-cancellation"];
    case "expiredDraftCleanup":
      return MUTATIONS["expired-draft-cleanup"];
  }
}

async function selectPendingBookingExpiryCandidates(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<BookingLifecycleCandidate[]> {
  const rows: CandidateRow[] = [];
  for (const lane of ["provider", "manual"] as const) {
    const result = await selectPendingBookingExpiryCandidateLane(queryable, now, limit, lane);
    rows.push(...result);
  }
  return rows
    .map(candidateFromRow)
    .sort(
      (left, right) =>
        Date.parse(left.deadlineOrWindow) - Date.parse(right.deadlineOrWindow) ||
        Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );
}

async function selectPendingBookingExpiryCandidateLane(
  queryable: Queryable,
  now: Date,
  limit: number,
  lane: "provider" | "manual",
): Promise<CandidateRow[]> {
  const result = await queryable.query<CandidateRow>(
    `WITH raw_deadlines AS (
       SELECT
         b.id,
         COALESCE(
           b.booking_metadata ->> 'acceptedPaymentDeadlineAt',
           b.booking_metadata ->> 'hostResponseDeadlineAt',
           b.booking_metadata ->> 'pendingExpiresAt',
           b.booking_metadata ->> 'expiresAt'
         ) AS deadline_text
       FROM booking.guest_bookings b
       WHERE b.lifecycle_status = 'pending_payment'
          OR (
            b.lifecycle_status = 'confirmed'
            AND b.payment_status = 'unpaid'
            AND b.booking_metadata ->> 'paymentMethod' = 'bank_transfer'
            AND NULLIF(b.booking_metadata ->> 'acceptedPaymentDeadlineAt', '') IS NOT NULL
          )
     ),
     candidate_deadlines AS (
       SELECT
         id,
         CASE
           WHEN deadline_text ~ '^\\d{4}-\\d{2}-\\d{2}([T ]|$)'
           THEN deadline_text::timestamptz
           ELSE NULL
         END AS deadline_at
       FROM raw_deadlines
     )
     SELECT
       b.id::text AS "guestBookingId",
       b.property_id::text AS "propertyId",
       b.lifecycle_status AS "lifecycleStatus",
       b.payment_status AS "paymentStatus",
       b.created_at AS "createdAt",
       b.updated_at AS "updatedAt",
       d.deadline_at AS "deadlineOrWindow",
       b.checkout_context_id::text AS "checkoutContextId",
       b.public_reference AS "publicReference",
       card_payment.provider_payment_intent_id AS "providerPaymentIntentId",
       provider_account.provider_account_id AS "providerAccountRef"
     FROM booking.guest_bookings b
     JOIN candidate_deadlines d ON d.id = b.id
     LEFT JOIN LATERAL (
       SELECT payment.provider_payment_intent_id, payment.provider_account_id
       FROM finance.payments payment
       WHERE payment.guest_booking_id = b.id
         AND payment.property_id = b.property_id
         AND payment.payment_method = 'card'
         AND payment.provider_payment_intent_id IS NOT NULL
       ORDER BY payment.created_at DESC
       LIMIT 1
     ) card_payment ON TRUE
     LEFT JOIN finance.payment_provider_accounts provider_account
       ON provider_account.id = card_payment.provider_account_id
     WHERE d.deadline_at IS NOT NULL
       AND d.deadline_at <= $1::timestamptz
       AND (
         ($3::text = 'provider' AND b.payment_status = 'authorized')
         OR ($3::text = 'manual' AND b.payment_status <> 'authorized')
       )
     ORDER BY d.deadline_at ASC, b.created_at ASC
     LIMIT $2`,
    [now.toISOString(), limit, lane],
  );
  return result.rows;
}

async function selectStaleUnpaidBookingCandidates(
  queryable: Queryable,
  now: Date,
  staleBefore: Date,
  limit: number,
): Promise<BookingLifecycleCandidate[]> {
  const result = await queryable.query<CandidateRow>(
    `SELECT
       b.id::text AS "guestBookingId",
       b.property_id::text AS "propertyId",
       b.lifecycle_status AS "lifecycleStatus",
       b.payment_status AS "paymentStatus",
       b.created_at AS "createdAt",
       b.updated_at AS "updatedAt",
       $2::text AS "deadlineOrWindow",
       b.checkout_context_id::text AS "checkoutContextId"
     FROM booking.guest_bookings b
     WHERE b.lifecycle_status = 'pending_payment'
       AND b.payment_status = 'unpaid'
       AND COALESCE(
         b.booking_metadata ->> 'hostResponseDeadlineAt',
         b.booking_metadata ->> 'pendingExpiresAt',
         b.booking_metadata ->> 'expiresAt'
       ) IS NULL
       AND b.created_at <= $1::timestamptz
     ORDER BY b.created_at ASC
     LIMIT $3`,
    [staleBefore.toISOString(), `created-before-${staleBefore.toISOString()}`, limit],
  );
  void now;
  return result.rows.map(candidateFromRow);
}

async function selectExpiredDraftCandidates(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<BookingLifecycleCandidate[]> {
  const result = await queryable.query<CandidateRow>(
    `WITH raw_deadlines AS (
       SELECT
         b.id,
         c.expires_at AS checkout_expires_at,
         COALESCE(
           b.booking_metadata ->> 'draftExpiresAt',
           b.booking_metadata ->> 'expiresAt'
         ) AS deadline_text
       FROM booking.guest_bookings b
       LEFT JOIN booking.checkout_contexts c ON c.id = b.checkout_context_id
       WHERE b.lifecycle_status = 'draft'
     ),
     draft_deadlines AS (
       SELECT
         id,
         COALESCE(
           checkout_expires_at,
           CASE
             WHEN deadline_text ~ '^\\d{4}-\\d{2}-\\d{2}([T ]|$)'
             THEN deadline_text::timestamptz
             ELSE NULL
           END
         ) AS deadline_at
       FROM raw_deadlines
     )
     SELECT
       b.id::text AS "guestBookingId",
       b.property_id::text AS "propertyId",
       b.lifecycle_status AS "lifecycleStatus",
       b.payment_status AS "paymentStatus",
       b.created_at AS "createdAt",
       b.updated_at AS "updatedAt",
       d.deadline_at AS "deadlineOrWindow",
       b.checkout_context_id::text AS "checkoutContextId",
       b.public_reference AS "publicReference",
       card_payment.provider_payment_intent_id AS "providerPaymentIntentId",
       provider_account.provider_account_id AS "providerAccountRef"
     FROM booking.guest_bookings b
     JOIN draft_deadlines d ON d.id = b.id
     LEFT JOIN LATERAL (
       SELECT payment.provider_payment_intent_id, payment.provider_account_id
       FROM finance.payments payment
       WHERE payment.guest_booking_id = b.id
         AND payment.property_id = b.property_id
         AND payment.payment_method = 'card'
         AND payment.provider_payment_intent_id IS NOT NULL
       ORDER BY payment.created_at DESC
       LIMIT 1
     ) card_payment ON TRUE
     LEFT JOIN finance.payment_provider_accounts provider_account
       ON provider_account.id = card_payment.provider_account_id
     WHERE d.deadline_at IS NOT NULL
       AND d.deadline_at <= $1::timestamptz
     ORDER BY d.deadline_at ASC, b.created_at ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows.map(candidateFromRow);
}

async function applyPgLifecycleMutation(
  pool: pg.Pool,
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
  config: Pick<PgBookingLifecycleStoreConfig, "inventoryReservationPort" | "stripePaymentProvider">,
): Promise<BookingLifecycleMutationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (mutation.action === "pending-expiry" && candidate.paymentStatus === "authorized") {
      const cardResult = await resolveExpiredStripeAuthorization(
        client,
        candidate,
        mutation,
        context,
        config,
      );
      if (cardResult) {
        await client.query("COMMIT");
        return cardResult;
      }
    }
    if (mutation.deleteDraft && candidate.providerPaymentIntentId) {
      const cardResult = await resolveExpiredStripeDraft(
        client,
        candidate,
        mutation,
        context,
        config,
      );
      if (cardResult) {
        await client.query("COMMIT");
        return cardResult;
      }
    }
    const result = mutation.deleteDraft
      ? await deleteExpiredDraft(
          client,
          candidate,
          mutation,
          context,
          config.inventoryReservationPort,
        )
      : await updateBookingLifecycleStatus(
          client,
          candidate,
          mutation,
          context,
          config.inventoryReservationPort,
        );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveExpiredStripeAuthorization(
  client: pg.PoolClient,
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
  config: Pick<PgBookingLifecycleStoreConfig, "stripePaymentProvider">,
): Promise<BookingLifecycleMutationResult | null> {
  const paymentIntentId = candidate.providerPaymentIntentId;
  const provider = config.stripePaymentProvider;
  if (!provider || !paymentIntentId) return lifecycleNoopResult(candidate, mutation);
  const locked = await client.query<{ paymentId: string }>(
    `SELECT payment.id::text AS "paymentId"
       FROM finance.payments payment
       JOIN booking.guest_bookings booking
         ON booking.id = payment.guest_booking_id
        AND booking.property_id = payment.property_id
      WHERE booking.id = $1::uuid
        AND booking.property_id = $2::uuid
        AND booking.lifecycle_status = 'pending_payment'
        AND booking.payment_status = 'authorized'
        AND booking.booking_metadata ->> 'acceptanceMode' = 'request'
        AND booking.booking_metadata ->> 'paymentMethod' = 'card'
        AND NULLIF(booking.booking_metadata ->> 'hostResponseDeadlineAt', '')::timestamptz
              = $3::timestamptz
        AND payment.provider_payment_intent_id = $4
        AND payment.payment_method = 'card'
        AND payment.status = 'authorized'
      FOR UPDATE OF payment, booking`,
    [candidate.guestBookingId, candidate.propertyId, candidate.deadlineOrWindow, paymentIntentId],
  );
  const payment = locked.rows[0];
  if (!payment) return lifecycleNoopResult(candidate, mutation);

  let intent = await provider.retrievePaymentIntent(paymentIntentId);
  assertLifecycleStripeBinding(candidate, intent);
  if (intent.status === "succeeded") {
    return settleExpiredStripeAuthorization(client, candidate, mutation, context, intent);
  }
  if (intent.status !== "requires_capture" && intent.status !== "canceled") {
    return lifecycleNoopResult(candidate, mutation);
  }
  if (intent.status === "requires_capture") {
    try {
      intent = await provider.cancelPaymentIntent(
        paymentIntentId,
        `booking-card-request-expire:${candidate.propertyId}:${candidate.guestBookingId}:v1`,
      );
    } catch {
      intent = await provider.retrievePaymentIntent(paymentIntentId);
    }
    assertLifecycleStripeBinding(candidate, intent);
    if (intent.status === "succeeded") {
      return settleExpiredStripeAuthorization(client, candidate, mutation, context, intent);
    }
    if (intent.status !== "canceled") return lifecycleNoopResult(candidate, mutation);
  }
  const terminalized = await client.query(
    `UPDATE finance.payments
        SET status = 'canceled',
            updated_at = $2::timestamptz,
            payment_metadata = payment_metadata ||
              '{"providerStatus":"canceled","reconciliationStatus":"canceled"}'::jsonb
      WHERE id = $1::uuid AND status = 'authorized'
      RETURNING id`,
    [payment.paymentId, context.now.toISOString()],
  );
  return terminalized.rows.length > 0 ? null : lifecycleNoopResult(candidate, mutation);
}

async function settleExpiredStripeAuthorization(
  client: pg.PoolClient,
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
  intent: Awaited<ReturnType<StripeBookingPaymentProvider["retrievePaymentIntent"]>>,
): Promise<BookingLifecycleMutationResult> {
  await settleStripeBookingPayment(client, {
    paymentIntentId: intent.paymentIntentId,
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    occurredAt: context.now,
    correlationId: context.correlationId,
  });
  return {
    ...lifecycleNoopResult(candidate, mutation),
    applied: true,
    toStatus: "confirmed",
  };
}

async function resolveExpiredStripeDraft(
  client: pg.PoolClient,
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
  config: Pick<PgBookingLifecycleStoreConfig, "stripePaymentProvider">,
): Promise<BookingLifecycleMutationResult | null> {
  const locked = await client.query(
    `SELECT id FROM booking.guest_bookings
     WHERE id = $1::uuid AND property_id = $2::uuid AND lifecycle_status = 'draft'
     FOR UPDATE`,
    [candidate.guestBookingId, candidate.propertyId],
  );
  if (locked.rows.length === 0) return lifecycleNoopResult(candidate, mutation);
  const provider = config.stripePaymentProvider;
  const paymentIntentId = candidate.providerPaymentIntentId;
  if (!provider || !paymentIntentId) return lifecycleNoopResult(candidate, mutation);

  let intent = await provider.retrievePaymentIntent(paymentIntentId);
  assertLifecycleStripeBinding(candidate, intent);
  if (intent.status === "succeeded") {
    await settleStripeBookingPayment(client, {
      paymentIntentId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      occurredAt: context.now,
      correlationId: context.correlationId,
    });
    return {
      ...lifecycleNoopResult(candidate, mutation),
      applied: true,
      toStatus: "confirmed",
    };
  }
  if (intent.status === "processing") return lifecycleNoopResult(candidate, mutation);
  if (
    !["requires_payment_method", "requires_confirmation", "requires_action", "canceled"].includes(
      intent.status,
    )
  ) {
    return lifecycleNoopResult(candidate, mutation);
  }
  if (intent.status !== "canceled") {
    try {
      intent = await provider.cancelPaymentIntent(
        paymentIntentId,
        `booking-card-expire:${candidate.propertyId}:${candidate.guestBookingId}:v1`,
      );
    } catch {
      intent = await provider.retrievePaymentIntent(paymentIntentId);
    }
    assertLifecycleStripeBinding(candidate, intent);
    if (intent.status === "succeeded") {
      await settleStripeBookingPayment(client, {
        paymentIntentId,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        occurredAt: context.now,
        correlationId: context.correlationId,
      });
      return {
        ...lifecycleNoopResult(candidate, mutation),
        applied: true,
        toStatus: "confirmed",
      };
    }
    if (intent.status !== "canceled") return lifecycleNoopResult(candidate, mutation);
  }
  return null;
}

function assertLifecycleStripeBinding(
  candidate: BookingLifecycleCandidate,
  intent: Awaited<ReturnType<StripeBookingPaymentProvider["retrievePaymentIntent"]>>,
): void {
  if (
    intent.propertyId !== candidate.propertyId ||
    intent.bookingReference !== candidate.publicReference ||
    intent.providerAccountRef !== candidate.providerAccountRef
  ) {
    throw new Error("Stripe PaymentIntent did not match the expiring booking.");
  }
}

async function updateBookingLifecycleStatus(
  client: pg.PoolClient,
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
  inventoryReservationPort?: DirectBookingInventoryReservationPort,
): Promise<BookingLifecycleMutationResult> {
  const updated = await client.query<{
    guestBookingId: string;
    fromStatus: string;
    toStatus: string;
    bookingMetadata: unknown;
    sourceSystem: string;
    checkIn: string;
    checkOut: string;
    recognizedOn: string | null;
  }>(
    `WITH updated AS (
       UPDATE booking.guest_bookings
          SET lifecycle_status = $3,
              payment_status = CASE
                WHEN $10 = 'pending-expiry' AND payment_status = 'authorized' THEN 'failed'
                ELSE payment_status
              END,
              cancellation_reason = COALESCE(cancellation_reason, $4),
              updated_at = $5::timestamptz
        WHERE id = $1::uuid
          AND property_id = $2::uuid
          AND lifecycle_status = $6
          AND (
            $10 <> 'pending-expiry'
            OR NULLIF(COALESCE(
              booking_metadata ->> 'hostResponseDeadlineAt',
              booking_metadata ->> 'pendingExpiresAt',
              booking_metadata ->> 'expiresAt'
            ), '')::timestamptz = $11::timestamptz
          )
          AND (
            $10 <> 'accepted-payment-expiry'
            OR (
              payment_status = 'unpaid'
              AND booking_metadata ->> 'paymentMethod' = 'bank_transfer'
              AND NULLIF(booking_metadata ->> 'acceptedPaymentDeadlineAt', '')::timestamptz
                    = $11::timestamptz
            )
          )
        RETURNING id::text AS "guestBookingId", $6::text AS "fromStatus",
          lifecycle_status AS "toStatus", booking_metadata AS "bookingMetadata",
          payment_status AS "paymentStatus", source_system AS "sourceSystem",
          check_in::text AS "checkIn", check_out::text AS "checkOut"
     ),
     status_event AS (
       INSERT INTO booking.booking_status_events
         (
           guest_booking_id,
           event_type,
           from_status,
           to_status,
           actor_type,
           public_visible,
           public_message,
           event_payload,
           occurred_at
         )
       SELECT
         updated."guestBookingId"::uuid,
         $7,
         updated."fromStatus",
         updated."toStatus",
         'system',
         true,
         $8,
         $9::jsonb,
         $5::timestamptz
       FROM updated
     ),
     summary AS (
       UPDATE booking.direct_booking_summary_read_model summary
          SET lifecycle_status = (SELECT "toStatus" FROM updated),
              payment_status = (SELECT "paymentStatus" FROM updated),
              projected_at = $5::timestamptz
        WHERE summary.guest_booking_id = (SELECT "guestBookingId"::uuid FROM updated)
     )
     SELECT updated.*, (SELECT ($5::timestamptz AT TIME ZONE location.timezone)::date::text
       FROM hotel_catalog.property_locations location WHERE location.property_id = $2::uuid
     ) AS "recognizedOn" FROM updated`,
    [
      candidate.guestBookingId,
      candidate.propertyId,
      mutation.toStatus,
      mutation.cancellationReason ?? null,
      context.now.toISOString(),
      mutation.fromStatus,
      mutation.statusEventType,
      publicMessageForMutation(mutation),
      JSON.stringify(statusEventPayload(candidate, mutation, context)),
      mutation.action,
      candidate.deadlineOrWindow,
    ],
  );

  const row = updated.rows[0];
  if (!row) {
    return lifecycleNoopResult(candidate, mutation);
  }
  if (row.sourceSystem === "booking") {
    if (!row.recognizedOn) throw new Error("Booking cancellation requires property timezone.");
    await captureDirectNightlyRevenueEvidence(
      client,
      {
        ...row,
        propertyId: candidate.propertyId,
      },
      {
        clear: true,
        fingerprint: `${mutation.action}:${mutation.deadlineOrWindow}`,
        recognizedOn: row.recognizedOn,
        required: true,
      },
    );
  }
  await releaseLifecycleInventory(
    client,
    inventoryReservationPort,
    candidate.propertyId,
    row.bookingMetadata,
    context.now,
  );
  if (
    mutation.statusEventType === "guest_booking.expired" ||
    mutation.cancellationReason === "accepted_payment_expired"
  ) {
    await enqueueBookingTransitionNotifications(client, {
      propertyId: candidate.propertyId,
      guestBookingId: candidate.guestBookingId,
      occurredAt: context.now.toISOString(),
      correlationId: context.correlationId,
      causationId: buildBookingLifecycleSweepKey({
        guestBookingId: candidate.guestBookingId,
        action: mutation.action,
        deadlineOrWindow: mutation.deadlineOrWindow,
      }),
      actor: { type: "system" },
      source: "apps/api-booking-lifecycle-scheduler",
      transition: {
        eventType: mutation.statusEventType,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        reason: mutation.cancellationReason ?? null,
      },
    });
  }

  return insertLifecycleSideEffects(client, candidate, mutation, context, {
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
  });
}

async function deleteExpiredDraft(
  client: pg.PoolClient,
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
  inventoryReservationPort?: DirectBookingInventoryReservationPort,
): Promise<BookingLifecycleMutationResult> {
  const locked = await client.query<{ bookingMetadata: unknown }>(
    `SELECT booking_metadata AS "bookingMetadata"
     FROM booking.guest_bookings
     WHERE id = $1::uuid AND property_id = $2::uuid AND lifecycle_status = 'draft'
     FOR UPDATE`,
    [candidate.guestBookingId, candidate.propertyId],
  );
  if (!locked.rows[0]) return lifecycleNoopResult(candidate, mutation);
  await releaseLifecycleInventory(
    client,
    inventoryReservationPort,
    candidate.propertyId,
    locked.rows[0].bookingMetadata,
    context.now,
  );
  const deleted = await client.query<{ guestBookingId: string; fromStatus: string }>(
    `WITH deleted AS (
       DELETE FROM booking.guest_bookings
        WHERE id = $1::uuid
          AND property_id = $2::uuid
          AND lifecycle_status = 'draft'
        RETURNING id::text AS "guestBookingId", lifecycle_status AS "fromStatus", checkout_context_id
     ),
     expired_context AS (
       UPDATE booking.checkout_contexts c
          SET status = 'expired',
              updated_at = $3::timestamptz
        WHERE c.id = (SELECT checkout_context_id FROM deleted)
          AND c.status <> 'converted'
     )
     SELECT "guestBookingId", "fromStatus" FROM deleted`,
    [candidate.guestBookingId, candidate.propertyId, context.now.toISOString()],
  );

  const row = deleted.rows[0];
  if (!row) {
    return lifecycleNoopResult(candidate, mutation);
  }

  return insertLifecycleSideEffects(client, candidate, mutation, context, {
    fromStatus: row.fromStatus,
  });
}

async function releaseLifecycleInventory(
  client: pg.PoolClient,
  inventoryReservationPort: DirectBookingInventoryReservationPort | undefined,
  propertyId: string,
  bookingMetadata: unknown,
  occurredAt: Date,
): Promise<void> {
  if (!inventoryReservationPort) return;
  const reservation = inventoryReservationReceiptFromBookingMetadata(bookingMetadata, propertyId);
  if (!reservation) return;
  await inventoryReservationPort.release({
    transaction: client,
    propertyId,
    reservation,
    occurredAt,
  });
}

async function insertLifecycleSideEffects(
  client: pg.PoolClient,
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
  status: { fromStatus: string; toStatus?: string },
): Promise<BookingLifecycleMutationResult> {
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
  const keyHash = sha256Key(lifecycleKey);
  const fingerprint = sha256Key(
    stableJson({
      action: mutation.action,
      guestBookingId: candidate.guestBookingId,
      deadlineOrWindow: mutation.deadlineOrWindow,
    }),
  );
  const payload = auditSafeLifecyclePayload(candidate, mutation, status);

  const idempotencyKeyId = await insertCompletedIdempotencyKey(client, {
    candidate,
    mutation,
    keyHash,
    fingerprint,
    lifecycleKey,
    context,
  });
  const domainEventId = await insertOrFindDomainEvent(client, {
    candidate,
    mutation,
    lifecycleKey,
    keyHash,
    payload,
    context,
  });
  const jobId = await insertOrFindSucceededJob(client, {
    candidate,
    mutation,
    jobKey,
    keyHash,
    payload,
    domainEventId,
    context,
  });
  await insertJobAttempt(client, jobId, context);
  await insertProductAudit(client, {
    candidate,
    mutation,
    lifecycleKey,
    payload,
    idempotencyKeyId,
    domainEventId,
    jobId,
    context,
  });

  return {
    action: mutation.action,
    guestBookingId: candidate.guestBookingId,
    propertyId: candidate.propertyId,
    applied: true,
    fromStatus: status.fromStatus,
    toStatus: status.toStatus,
    lifecycleKey,
    jobKey,
  };
}

async function insertCompletedIdempotencyKey(
  client: pg.PoolClient,
  input: {
    candidate: BookingLifecycleCandidate;
    mutation: BookingLifecycleMutation;
    keyHash: string;
    fingerprint: string;
    lifecycleKey: string;
    context: BookingLifecycleJobContext;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         property_id,
         response_status_code,
         response_body_hash,
         response_resource_product,
         response_resource_type,
         response_resource_id,
         correlation_id,
         completed_at,
         expires_at,
         idempotency_metadata
       )
     VALUES
       (
         'booking',
         $1,
         $2,
         $3,
         'completed',
         'property',
         $4::uuid,
         200,
         $3,
         'booking',
         'guest_booking',
         $5,
         $6,
         $7::timestamptz,
         $8::timestamptz,
         $9::jsonb
       )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       last_seen_at = now(),
       status = 'completed',
       completed_at = COALESCE(platform.idempotency_keys.completed_at, EXCLUDED.completed_at)
     RETURNING id`,
    [
      input.mutation.action,
      input.keyHash,
      input.fingerprint,
      input.candidate.propertyId,
      input.candidate.guestBookingId,
      input.context.correlationId,
      input.context.now.toISOString(),
      new Date(input.context.now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({
        lifecycleKey: input.lifecycleKey,
        source: "apps/api-booking-lifecycle-scheduler",
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertOrFindDomainEvent(
  client: pg.PoolClient,
  input: {
    candidate: BookingLifecycleCandidate;
    mutation: BookingLifecycleMutation;
    lifecycleKey: string;
    keyHash: string;
    payload: Record<string, unknown>;
    context: BookingLifecycleJobContext;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events
         (
           source_system,
           event_key,
           event_type,
           occurred_at,
           tenant_scope,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           actor_type,
           correlation_id,
           causation_id,
           idempotency_key_hash,
           payload,
           event_metadata,
           privacy_scope
         )
       VALUES
         (
           'booking',
           $1,
           $2,
           $3::timestamptz,
           'property',
           $4::uuid,
           'booking',
           'guest_booking',
           $5,
           'system',
           $6,
           $7,
           $8,
           $9::jsonb,
           $10::jsonb,
           'internal'
         )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM platform.domain_events WHERE source_system = 'booking' AND event_key = $1
     LIMIT 1`,
    [
      input.lifecycleKey,
      input.mutation.statusEventType,
      input.context.now.toISOString(),
      input.candidate.propertyId,
      input.candidate.guestBookingId,
      input.context.correlationId,
      input.mutation.jobType,
      input.keyHash,
      JSON.stringify(input.payload),
      JSON.stringify({
        action: input.mutation.action,
        source: "apps/api-booking-lifecycle-scheduler",
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertOrFindSucceededJob(
  client: pg.PoolClient,
  input: {
    candidate: BookingLifecycleCandidate;
    mutation: BookingLifecycleMutation;
    jobKey: string;
    keyHash: string;
    payload: Record<string, unknown>;
    domainEventId: string;
    context: BookingLifecycleJobContext;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.jobs
       (
         job_key,
         queue_name,
         job_type,
         source_domain_event_id,
         status,
         attempts_count,
         run_after,
         finished_at,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
     VALUES
       (
         $1,
         $2,
         $3,
         $4::uuid,
         'succeeded',
         1,
         $5::timestamptz,
         $5::timestamptz,
         'property',
         $6::uuid,
         'booking',
         'guest_booking',
         $7,
         $8,
         $9,
         $10::jsonb,
         $11::jsonb
       )
     ON CONFLICT (queue_name, job_key)
     DO UPDATE SET
       updated_at = now(),
       status = CASE
         WHEN platform.jobs.status IN ('succeeded', 'dead_lettered', 'canceled')
         THEN platform.jobs.status
         ELSE 'succeeded'
       END,
       finished_at = COALESCE(platform.jobs.finished_at, EXCLUDED.finished_at)
     RETURNING id`,
    [
      input.jobKey,
      BOOKING_LIFECYCLE_QUEUE,
      input.mutation.jobType,
      input.domainEventId,
      input.context.now.toISOString(),
      input.candidate.propertyId,
      input.candidate.guestBookingId,
      input.context.correlationId,
      input.keyHash,
      JSON.stringify(input.payload),
      JSON.stringify({
        action: input.mutation.action,
        workerId: input.context.workerId,
        source: "apps/api-booking-lifecycle-scheduler",
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertJobAttempt(
  client: pg.PoolClient,
  jobId: string,
  context: BookingLifecycleJobContext,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.job_attempts
       (job_id, attempt_number, status, worker_id, started_at, finished_at, duration_ms)
     VALUES
       ($1::uuid, 1, 'succeeded', $2, $3::timestamptz, $3::timestamptz, 0)
     ON CONFLICT (job_id, attempt_number) DO NOTHING`,
    [jobId, context.workerId, context.now.toISOString()],
  );
}

async function insertProductAudit(
  client: pg.PoolClient,
  input: {
    candidate: BookingLifecycleCandidate;
    mutation: BookingLifecycleMutation;
    lifecycleKey: string;
    payload: Record<string, unknown>;
    idempotencyKeyId: string;
    domainEventId: string;
    jobId: string;
    context: BookingLifecycleJobContext;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         property_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         domain_event_id,
         job_id,
         idempotency_key_id,
         correlation_id,
         causation_id,
         redacted_payload,
         private_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       (
         $1,
         'booking',
         $2,
         $3::timestamptz,
         'property',
         $4::uuid,
         'system',
         'booking',
         'guest_booking',
         $5,
         $6::uuid,
         $7::uuid,
         $8::uuid,
         $9,
         $10,
         $11::jsonb,
         '{}'::jsonb,
         $12::jsonb,
         'standard',
         'internal'
       )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      input.lifecycleKey,
      input.mutation.auditAction,
      input.context.now.toISOString(),
      input.candidate.propertyId,
      input.candidate.guestBookingId,
      input.domainEventId,
      input.jobId,
      input.idempotencyKeyId,
      input.context.correlationId,
      input.mutation.jobType,
      JSON.stringify(input.payload),
      JSON.stringify({
        source: "apps/api-booking-lifecycle-scheduler",
        workerId: input.context.workerId,
      }),
    ],
  );
}

function candidateFromRow(row: CandidateRow): BookingLifecycleCandidate {
  return {
    guestBookingId: row.guestBookingId,
    propertyId: row.propertyId,
    lifecycleStatus: row.lifecycleStatus,
    paymentStatus: row.paymentStatus,
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt),
    deadlineOrWindow: dateValue(row.deadlineOrWindow),
    checkoutContextId: row.checkoutContextId,
    providerPaymentIntentId: row.providerPaymentIntentId,
    publicReference: row.publicReference,
    providerAccountRef: row.providerAccountRef,
  };
}

function lifecycleNoopResult(
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
): BookingLifecycleMutationResult {
  return {
    action: mutation.action,
    guestBookingId: candidate.guestBookingId,
    propertyId: candidate.propertyId,
    applied: false,
    fromStatus: candidate.lifecycleStatus,
    toStatus: candidate.lifecycleStatus,
    lifecycleKey: buildBookingLifecycleSweepKey({
      guestBookingId: candidate.guestBookingId,
      action: mutation.action,
      deadlineOrWindow: mutation.deadlineOrWindow,
    }),
    jobKey: buildBookingLifecycleJobKey({
      guestBookingId: candidate.guestBookingId,
      action: mutation.action,
      deadlineOrWindow: mutation.deadlineOrWindow,
    }),
  };
}

function statusEventPayload(
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  context: BookingLifecycleJobContext,
): Record<string, unknown> {
  return {
    action: mutation.action,
    deadlineOrWindow: mutation.deadlineOrWindow,
    correlationId: context.correlationId,
    source: "booking_lifecycle_scheduler",
    guestBookingId: candidate.guestBookingId,
    propertyId: candidate.propertyId,
  };
}

function auditSafeLifecyclePayload(
  candidate: BookingLifecycleCandidate,
  mutation: BookingLifecycleMutation,
  status: { fromStatus: string; toStatus?: string },
): Record<string, unknown> {
  return {
    action: mutation.action,
    guestBookingId: candidate.guestBookingId,
    propertyId: candidate.propertyId,
    fromStatus: status.fromStatus,
    toStatus: status.toStatus ?? null,
    deadlineOrWindow: mutation.deadlineOrWindow,
    cancellationReason: mutation.cancellationReason ?? null,
  };
}

function publicMessageForMutation(mutation: BookingLifecycleMutation): string {
  switch (mutation.action) {
    case "pending-expiry":
      return "Booking expired.";
    case "accepted-payment-expiry":
      return "Booking canceled because payment was not received by the deadline.";
    case "stale-unpaid-cancellation":
      return "Booking canceled.";
    case "expired-draft-cleanup":
      return "Booking draft expired.";
  }
}

function sha256Key(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function dateValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function sumBy<T extends Record<K, number>, K extends keyof T>(
  values: readonly T[],
  key: K,
): number {
  return values.reduce((sum, value) => sum + value[key], 0);
}
