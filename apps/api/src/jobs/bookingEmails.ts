import { paymentMethodLabel } from "@vayada/locale-constants";
import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

export const BOOKING_EMAIL_QUEUE = "platform.email";
const BOOKING_LIFECYCLE_EMAIL_JOB_TYPE_BY_KIND = {
  reserved_pending_payment: "email.booking-reserved-pending-payment",
  final_confirmation: "email.booking-final-confirmation",
  request_received: "email.booking-request-received",
  booking_accepted: "email.booking-accepted",
  booking_rejected: "email.booking-rejected",
  booking_expired: "email.booking-expired",
  host_new_booking: "email.booking-host-new-booking",
  host_review_required: "email.booking-host-review-required",
} as const;

export type BookingLifecycleEmailKind = keyof typeof BOOKING_LIFECYCLE_EMAIL_JOB_TYPE_BY_KIND;

export const BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE =
  BOOKING_LIFECYCLE_EMAIL_JOB_TYPE_BY_KIND.reserved_pending_payment;
export const BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE =
  BOOKING_LIFECYCLE_EMAIL_JOB_TYPE_BY_KIND.final_confirmation;
export const BOOKING_LIFECYCLE_EMAIL_JOB_TYPES = Object.values(
  BOOKING_LIFECYCLE_EMAIL_JOB_TYPE_BY_KIND,
);

export type BookingNotificationRecipientRole = "guest" | "host";

export type BookingLifecycleTransition = {
  eventType: string;
  fromStatus?: string | null;
  toStatus: string;
  reason?: string | null;
};

export type BookingLifecycleEmailInput = {
  resendKey?: string;
  kind: BookingLifecycleEmailKind;
  occurredAt: string;
  correlationId?: string | null;
  causationId?: string | null;
  actor?: { type: "user" | "system" | "provider" | "migration"; userId?: string | null };
  paymentDeadlineAt?: string | null;
  bankTransferDetails?: unknown;
  source?: string;
  recipient?: { role: BookingNotificationRecipientRole; email: string | null };
  transition?: BookingLifecycleTransition;
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
    addons?: string | null;
    roomCount?: number;
    adults?: number;
    children?: number;
    specialRequests?: string | null;
  };
};

export type BookingTransitionNotificationInput = {
  propertyId: string;
  guestBookingId: string;
  occurredAt: string;
  transition: BookingLifecycleTransition;
  correlationId?: string | null;
  causationId?: string | null;
  actor?: BookingLifecycleEmailInput["actor"];
  source?: string;
  paymentDeadlineAt?: string | null;
  bankTransferDetails?: unknown;
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
): Promise<BookingLifecycleEmailEnqueueResult> {
  const recipientRole = input.recipient?.role ?? "guest";
  const to = normalizeEmail(input.recipient ? input.recipient.email : input.booking.guestEmail);

  const jobType = bookingLifecycleEmailJobType(input.kind);
  const eventType = `booking.notification.${input.kind}_requested`;
  const transition = input.transition ?? legacyTransition(input.kind);
  const jobKey =
    input.resendKey ??
    bookingLifecycleEmailJobKey(
      input.kind,
      input.booking.guestBookingId,
      recipientRole,
      transition,
    );
  const keyHash = sha256(jobKey);
  const copy = emailCopy(input);
  const payload = {
    to,
    ...copy,
    bookingReference: input.booking.bookingReference,
    paymentDeadlineAt: input.paymentDeadlineAt ?? null,
    bankTransferDetails:
      input.kind === "reserved_pending_payment" ? (input.bankTransferDetails ?? null) : null,
    recipientRole,
    notificationType: input.kind,
    transition,
    ...(input.resendKey ? { resentByUserId: input.actor?.userId } : {}),
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
        recipientRole,
        notificationType: input.kind,
        transition,
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
        recipientRole,
        notificationType: input.kind,
        transition,
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

type BookingNotificationSnapshot = QueryResultRow & {
  propertyId: string;
  guestBookingId: string;
  bookingReference: string;
  guestEmail: string | null;
  guestName: string | null;
  hostEmail: string | null;
  propertyName: string;
  checkIn: string;
  checkOut: string;
  totalAmount: string;
  balanceAmount: string;
  currency: string;
  paymentMethod: string | null;
  bookingMetadata: unknown;
  status: string;
  roomCount: number;
  adults: number;
  children: number;
  specialRequests: string | null;
  addons: string | null;
};

export async function loadBookingNotificationSnapshot(
  queryable: Queryable,
  input: { propertyId: string; guestBookingId: string },
) {
  const result = await queryable.query<BookingNotificationSnapshot>(
    `SELECT
       booking.property_id::text AS "propertyId",
       booking.id::text AS "guestBookingId",
       booking.public_reference AS "bookingReference",
       guest.email AS "guestEmail",
       NULLIF(trim(concat_ws(' ', guest.first_name, guest.last_name)), '') AS "guestName",
       host_contact.value AS "hostEmail",
       property.display_name AS "propertyName",
       booking.check_in::text AS "checkIn",
       booking.check_out::text AS "checkOut",
       booking.total_amount::text AS "totalAmount",
       booking.balance_amount::text AS "balanceAmount",
       booking.currency,
       COALESCE(booking.booking_metadata ->> 'paymentMethod', booking.expected_payment_method) AS "paymentMethod",
       booking.booking_metadata AS "bookingMetadata",
       booking.lifecycle_status AS status, booking.adults, booking.children, booking.room_count AS "roomCount",
       guest.special_requests AS "specialRequests",
       (SELECT string_agg(item.addon_name || ' × ' || item.quantity, ', ' ORDER BY item.created_at)
        FROM booking.booking_addon_selection_items item
        WHERE item.guest_booking_id = booking.id AND item.property_id = booking.property_id) AS addons
     FROM booking.guest_bookings booking
     JOIN hotel_catalog.properties property ON property.id = booking.property_id
     LEFT JOIN LATERAL (
       SELECT booking_guest.first_name, booking_guest.last_name, booking_guest.email, booking_guest.special_requests
       FROM booking.booking_guests booking_guest
       WHERE booking_guest.guest_booking_id = booking.id
         AND booking_guest.guest_role IN ('booker', 'primary_guest')
       ORDER BY (booking_guest.guest_role = 'booker') DESC, booking_guest.created_at
       LIMIT 1
     ) guest ON TRUE
     LEFT JOIN LATERAL (
       SELECT contact.value
       FROM hotel_catalog.property_contact_channels contact
       WHERE contact.property_id = booking.property_id
         AND contact.channel_type = 'email'
         AND (
           contact.purpose = 'operations'
           OR (contact.purpose = 'general' AND contact.source_system = 'booking')
         )
       ORDER BY (contact.purpose = 'operations') DESC,
                contact.updated_at DESC,
                contact.id
       LIMIT 1
     ) host_contact ON TRUE
     WHERE booking.property_id = $1::uuid
       AND booking.id = $2::uuid
     LIMIT 1`,
    [input.propertyId, input.guestBookingId],
  );
  return result.rows[0] ?? null;
}

export async function enqueueBookingTransitionNotifications(
  queryable: Queryable,
  input: BookingTransitionNotificationInput,
): Promise<BookingLifecycleEmailEnqueueResult[]> {
  const booking = await loadBookingNotificationSnapshot(queryable, input);
  if (!booking) throw new Error("Booking notification snapshot was not found.");

  const notifications = notificationsForTransition(input.transition, booking);
  const enqueued: BookingLifecycleEmailEnqueueResult[] = [];
  for (const notification of notifications) {
    const queued = await enqueueBookingLifecycleEmailJob(queryable, {
      kind: notification.kind,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      causationId: input.causationId,
      actor: input.actor,
      paymentDeadlineAt: input.paymentDeadlineAt,
      bankTransferDetails: input.bankTransferDetails,
      source: input.source,
      recipient: {
        role: notification.role,
        email: notification.role === "guest" ? booking.guestEmail : booking.hostEmail,
      },
      transition: input.transition,
      booking,
    });
    enqueued.push(queued);
  }
  return enqueued;
}

export function bookingLifecycleEmailJobType(kind: BookingLifecycleEmailKind): string {
  return BOOKING_LIFECYCLE_EMAIL_JOB_TYPE_BY_KIND[kind];
}

export function bookingLifecycleEmailJobKey(
  kind: BookingLifecycleEmailKind,
  guestBookingId: string,
  recipientRole: BookingNotificationRecipientRole = "guest",
  transition: BookingLifecycleTransition = legacyTransition(kind),
): string {
  const transitionKey = [
    transition.eventType,
    transition.fromStatus ?? "none",
    transition.toStatus,
    transition.reason ?? "none",
  ]
    .join("-")
    .replace(/[^a-z0-9_.-]/gi, "-")
    .toLowerCase();
  return `${bookingLifecycleEmailJobType(kind)}:booking:${guestBookingId}:transition:${transitionKey}:recipient:${recipientRole}:${kind}:v1`;
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
  if (input.kind === "request_received") {
    return {
      template: "booking_request_received",
      subject: `Booking request received - ${booking.bookingReference}`,
      text: [
        `Hi ${name},`,
        `We've received your booking request for ${property}.`,
        `Stay: ${dateOnly(booking.checkIn)} to ${dateOnly(booking.checkOut)}`,
        "We'll review it and let you know as soon as possible.",
        `Booking reference: ${booking.bookingReference}`,
      ].join("\n\n"),
    };
  }
  if (input.kind === "booking_accepted") {
    return {
      template: "booking_accepted",
      subject: `Booking request accepted - ${booking.bookingReference}`,
      text: [
        `Hi ${name},`,
        `We've accepted your booking request for ${property}.`,
        `Stay: ${dateOnly(booking.checkIn)} to ${dateOnly(booking.checkOut)}`,
        ...confirmationDetails(booking),
        `Booking reference: ${booking.bookingReference}`,
      ].join("\n\n"),
    };
  }
  if (input.kind === "booking_rejected") {
    return {
      template: "booking_rejected",
      subject: `Booking request update - ${booking.bookingReference}`,
      text: [
        `Hi ${name},`,
        `We couldn't accept your booking request for ${property}.`,
        `Booking reference: ${booking.bookingReference}`,
      ].join("\n\n"),
    };
  }
  if (input.kind === "booking_expired") {
    return {
      template: "booking_expired",
      subject: `Booking expired - ${booking.bookingReference}`,
      text: [
        `Hi ${name},`,
        `Your booking for ${property} has expired.`,
        `Booking reference: ${booking.bookingReference}`,
      ].join("\n\n"),
    };
  }
  if (input.kind === "host_new_booking" || input.kind === "host_review_required") {
    const reviewRequired = input.kind === "host_review_required";
    return {
      template: reviewRequired ? "booking_host_review_required" : "booking_host_new_booking",
      subject: reviewRequired
        ? `Booking request requires review - ${booking.bookingReference}`
        : `New confirmed booking - ${booking.bookingReference}`,
      text: [
        reviewRequired ? "A new booking request requires review." : "A new booking is confirmed.",
        `Guest: ${name}`,
        `Stay: ${dateOnly(booking.checkIn)} to ${dateOnly(booking.checkOut)}`,
        `Total: ${money(booking.totalAmount, booking.currency)}`,
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
      ...confirmationDetails(booking),
      `Booking reference: ${booking.bookingReference}`,
      "We look forward to welcoming you!",
    ].join("\n\n"),
  };
}

function confirmationDetails(booking: BookingLifecycleEmailInput["booking"]): string[] {
  return [
    `Total: ${money(booking.totalAmount, booking.currency)}`,
    `Balance: ${money(booking.balanceAmount, booking.currency)}`,
    `Payment method: ${paymentMethodLabel(booking.paymentMethod)}`,
    ...(booking.adults == null
      ? []
      : [`Guests: ${booking.adults} adults, ${booking.children ?? 0} children`]),
    ...(booking.roomCount == null ? [] : [`Rooms: ${booking.roomCount}`]),
    `Add-ons: ${booking.addons || "None"}`,
    ...(booking.specialRequests ? [`Special requests: ${booking.specialRequests}`] : []),
  ];
}

function notificationsForTransition(
  transition: BookingLifecycleTransition,
  booking: BookingNotificationSnapshot,
): Array<{ kind: BookingLifecycleEmailKind; role: BookingNotificationRecipientRole }> {
  if (transition.eventType === "guest_booking.created") {
    if (transition.toStatus === "confirmed") {
      return [
        { kind: "final_confirmation", role: "guest" },
        { kind: "host_new_booking", role: "host" },
      ];
    }
    const metadata = record(booking.bookingMetadata);
    const acceptanceMode = text(metadata["acceptanceMode"] ?? metadata["bookingAcceptanceMode"]);
    if (
      transition.toStatus === "pending_review" ||
      (transition.toStatus === "pending_payment" &&
        (acceptanceMode === "request" || booking.paymentMethod === "bank_transfer"))
    ) {
      return [
        { kind: "request_received", role: "guest" },
        { kind: "host_review_required", role: "host" },
      ];
    }
    return [];
  }
  if (transition.eventType === "guest_booking.payment_authorized") {
    const metadata = record(booking.bookingMetadata);
    const acceptanceMode = text(metadata["acceptanceMode"] ?? metadata["bookingAcceptanceMode"]);
    if (
      transition.toStatus === "pending_review" ||
      (transition.toStatus === "pending_payment" && acceptanceMode === "request")
    ) {
      return [
        { kind: "request_received", role: "guest" },
        { kind: "host_review_required", role: "host" },
      ];
    }
    return [];
  }
  if (transition.eventType === "guest_booking.payment_received") {
    if (
      transition.fromStatus === "confirmed" &&
      ["pay_at_property", "cash"].includes(booking.paymentMethod ?? "")
    ) {
      return [];
    }
    return [
      { kind: "final_confirmation", role: "guest" },
      { kind: "host_new_booking", role: "host" },
    ];
  }
  if (transition.eventType === "guest_booking.accepted") {
    return [
      {
        kind:
          booking.paymentMethod === "bank_transfer"
            ? "reserved_pending_payment"
            : "booking_accepted",
        role: "guest",
      },
    ];
  }
  if (["guest_booking.rejected", "guest_booking.declined"].includes(transition.eventType)) {
    return [{ kind: "booking_rejected", role: "guest" }];
  }
  if (
    transition.eventType === "guest_booking.expired" ||
    (transition.eventType === "guest_booking.canceled" &&
      transition.reason === "accepted_payment_expired")
  ) {
    return [{ kind: "booking_expired", role: "guest" }];
  }
  return [];
}

function legacyTransition(kind: BookingLifecycleEmailKind): BookingLifecycleTransition {
  if (kind === "reserved_pending_payment" || kind === "booking_accepted") {
    return {
      eventType: "guest_booking.accepted",
      fromStatus: "pending_payment",
      toStatus: "confirmed",
    };
  }
  if (kind === "request_received" || kind === "host_review_required") {
    return { eventType: "guest_booking.created", fromStatus: null, toStatus: "pending_payment" };
  }
  if (kind === "booking_rejected") {
    return {
      eventType: "guest_booking.rejected",
      fromStatus: "pending_payment",
      toStatus: "declined",
    };
  }
  if (kind === "booking_expired") {
    return {
      eventType: "guest_booking.expired",
      fromStatus: "pending_payment",
      toStatus: "expired",
    };
  }
  if (kind === "host_new_booking") {
    return { eventType: "guest_booking.created", fromStatus: null, toStatus: "confirmed" };
  }
  return {
    eventType: "guest_booking.payment_received",
    fromStatus: "pending_payment",
    toStatus: "confirmed",
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
