import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

export const BOOKING_EMAIL_QUEUE = "platform.email";
export const BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE =
  "email.booking-reserved-pending-payment";
export const BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE = "email.booking-final-confirmation";

export type BookingLifecycleEmailKind = "reserved_pending_payment" | "final_confirmation";

export type BookingLifecycleEmailInput = {
  kind: BookingLifecycleEmailKind;
  occurredAt: string;
  correlationId?: string | null;
  causationId?: string | null;
  actor?: { type: "user" | "system" | "provider" | "migration"; userId?: string | null };
  paymentDeadlineAt?: string | null;
  bankTransferDetails?: unknown;
  source?: string;
  booking: {
    propertyId: string;
    guestBookingId: string;
    bookingReference: string;
    guestEmail: string | null;
    guestName?: string | null;
    propertyName?: string | null;
    checkIn: string | Date;
    checkOut: string | Date;
    totalAmount?: string | number | null;
    balanceAmount?: string | number | null;
    currency?: string | null;
    paymentMethod?: string | null;
  };
};

export type BookingLifecycleEmailEnqueueResult = {
  eventId: string;
  jobId: string;
  jobType: string;
  jobKey: string;
  status: "queued" | "idempotent_replay";
};

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

export async function enqueueBookingLifecycleEmailJob(
  queryable: Queryable,
  input: BookingLifecycleEmailInput,
): Promise<BookingLifecycleEmailEnqueueResult | null> {
  const to = normalizeEmail(input.booking.guestEmail);
  if (!to) return null;

  const jobType = bookingLifecycleEmailJobType(input.kind);
  const eventType =
    input.kind === "reserved_pending_payment"
      ? "booking.email.reserved_pending_payment_requested"
      : "booking.email.final_confirmation_requested";
  const jobKey = bookingLifecycleEmailJobKey(input.kind, input.booking.guestBookingId);
  const keyHash = sha256(jobKey);
  const copy = emailCopy(input);
  const payload = {
    to,
    ...copy,
    bookingReference: input.booking.bookingReference,
    paymentDeadlineAt: input.paymentDeadlineAt ?? null,
    bankTransferDetails:
      input.kind === "reserved_pending_payment" ? (input.bankTransferDetails ?? null) : null,
  };
  const actorType = input.actor?.type ?? "system";

  const event = await queryable.query<QueryResultRow & { eventId: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events (
         source_system, event_key, event_type, event_version, occurred_at,
         tenant_scope, property_id, resource_product, resource_type, resource_id,
         actor_type, actor_user_id, correlation_id, causation_id,
         idempotency_key_hash, payload, event_metadata, privacy_scope
       )
       VALUES (
         'booking', $1, $2, 1, $3::timestamptz,
         'property', $4::uuid, 'booking', 'guest_booking', $5,
         $6, $7::uuid, $8, $9,
         $10, $11::jsonb, $12::jsonb, 'confidential'
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id::text AS "eventId"
     )
     SELECT "eventId" FROM inserted
     UNION ALL
     SELECT id::text AS "eventId"
     FROM platform.domain_events
     WHERE source_system = 'booking'
       AND event_key = $1
     LIMIT 1`,
    [
      jobKey,
      eventType,
      input.occurredAt,
      input.booking.propertyId,
      input.booking.guestBookingId,
      actorType,
      input.actor?.userId ?? null,
      input.correlationId ?? null,
      input.causationId ?? null,
      keyHash,
      JSON.stringify(payload),
      JSON.stringify({ source: input.source ?? "apps/api-booking-email-lifecycle" }),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("Booking lifecycle email event was not persisted.");

  const job = await queryable.query<QueryResultRow & { jobId: string; replay: boolean }>(
    `WITH inserted AS (
       INSERT INTO platform.jobs (
         job_key, queue_name, job_type, source_domain_event_id,
         tenant_scope, property_id, resource_product, resource_type, resource_id,
         correlation_id, idempotency_key_hash, payload, job_metadata
       )
       VALUES (
         $1, $2, $3, $4::uuid,
         'property', $5::uuid, 'booking', 'guest_booking', $6,
         $7, $8, $9::jsonb, $10::jsonb
       )
       ON CONFLICT (queue_name, job_key) DO NOTHING
       RETURNING id::text AS "jobId", false AS replay
     )
     SELECT "jobId", replay FROM inserted
     UNION ALL
     SELECT id::text AS "jobId", true AS replay
     FROM platform.jobs
     WHERE queue_name = $2
       AND job_key = $1
     LIMIT 1`,
    [
      jobKey,
      BOOKING_EMAIL_QUEUE,
      jobType,
      eventId,
      input.booking.propertyId,
      input.booking.guestBookingId,
      input.correlationId ?? null,
      keyHash,
      JSON.stringify(payload),
      JSON.stringify({
        template: copy.template,
        source: input.source ?? "apps/api-booking-email-lifecycle",
      }),
    ],
  );
  const jobRow = job.rows[0];
  if (!jobRow) throw new Error("Booking lifecycle email job was not persisted.");

  await queryable.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at,
       tenant_scope, property_id, actor_type, actor_user_id,
       target_resource_product, target_resource_type, target_resource_id,
       domain_event_id, job_id, correlation_id, causation_id,
       redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope
     )
     VALUES (
       $1, 'booking', $2, 1, $3::timestamptz,
       'property', $4::uuid, $5, $6::uuid,
       'booking', 'guest_booking', $7,
       $8::uuid, $9::uuid, $10, $11,
       $12::jsonb, $13::jsonb, $14::jsonb, 'guest_pii', 'confidential'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `booking.email.audit:${jobKey}`,
      eventType,
      input.occurredAt,
      input.booking.propertyId,
      actorType,
      input.actor?.userId ?? null,
      input.booking.guestBookingId,
      eventId,
      jobRow.jobId,
      input.correlationId ?? null,
      input.causationId ?? null,
      JSON.stringify({
        template: copy.template,
        bookingReference: input.booking.bookingReference,
        paymentMethod: input.booking.paymentMethod ?? null,
      }),
      JSON.stringify({ to, subject: copy.subject }),
      JSON.stringify({ jobType, jobKey }),
    ],
  );

  return {
    eventId,
    jobId: jobRow.jobId,
    jobType,
    jobKey,
    status: jobRow.replay ? "idempotent_replay" : "queued",
  };
}

export function bookingLifecycleEmailJobType(kind: BookingLifecycleEmailKind): string {
  return kind === "reserved_pending_payment"
    ? BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE
    : BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE;
}

export function bookingLifecycleEmailJobKey(
  kind: BookingLifecycleEmailKind,
  guestBookingId: string,
): string {
  const semantic =
    kind === "reserved_pending_payment" ? "guest-reserved-pending-payment" : "guest-confirmation";
  return `${bookingLifecycleEmailJobType(kind)}:booking:${guestBookingId}:${semantic}:v1`;
}

export function bankTransferDetailsFromPolicy(policy: unknown): unknown | null {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const instructions = (policy as Record<string, unknown>)["bankTransferInstructions"];
  if (typeof instructions === "string") {
    const text = instructions.trim();
    return text || null;
  }
  if (!instructions || typeof instructions !== "object" || Array.isArray(instructions)) {
    return null;
  }
  return Object.keys(instructions).length > 0 ? instructions : null;
}

function emailCopy(input: BookingLifecycleEmailInput) {
  const { booking } = input;
  const name = booking.guestName?.trim() || "there";
  const property = booking.propertyName || "our property";
  if (input.kind === "reserved_pending_payment") {
    const details =
      typeof input.bankTransferDetails === "string"
        ? input.bankTransferDetails
        : JSON.stringify(input.bankTransferDetails ?? {});
    return {
      template: "booking_reserved_pending_payment",
      subject: `Your room is reserved pending payment - ${booking.bookingReference}`,
      text: [
        `Hi ${name},`,
        `We've reserved your room at ${property} while we wait for your bank transfer.`,
        `Amount due: ${money(booking.balanceAmount ?? booking.totalAmount, booking.currency)}`,
        `Payment deadline: ${input.paymentDeadlineAt ?? "as soon as possible"}`,
        `Bank transfer details: ${details}`,
        `Booking reference: ${booking.bookingReference}`,
      ].join("\n\n"),
    };
  }
  return {
    template: "booking_final_confirmation",
    subject: `Booking confirmed - ${booking.bookingReference}`,
    text: [
      `Hi ${name},`,
      `Your booking at ${property} is confirmed.`,
      `Stay: ${dateOnly(booking.checkIn)} to ${dateOnly(booking.checkOut)}`,
      `Total: ${money(booking.totalAmount, booking.currency)}`,
      `Booking reference: ${booking.bookingReference}`,
      "We look forward to welcoming you!",
    ].join("\n\n"),
  };
}

function money(
  value: string | number | null | undefined,
  currency: string | null | undefined,
): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `${amount.toFixed(2)} ${currency || "EUR"}`
    : `0.00 ${currency || "EUR"}`;
}

function dateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function normalizeEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
