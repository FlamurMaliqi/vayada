/**
 * @vayada/domain-pms-channex
 *
 * Target job/event contracts for Channex-triggered side effects:
 * - Inbound revision ingestion (OTA booking create/modify/cancel)
 * - ARI push (availability, restrictions, cancellation policy) for room blocks,
 *   admin bookings, guest changes, and full-hotel sync
 * - Notification dispatch (OTA booking imported, host booking alerts)
 * - Payout side-effect coordination
 * - Audit record emission
 *
 * Booking Engine MUST NOT import this package or any Channex implementation
 * modules. These contracts are PMS-owned. Booking Engine interacts with PMS
 * through the reservation sink and operational read contracts in
 * packages/domain-pms, or through typed domain events.
 *
 * All side effects described here should be moved from inline
 * asyncio.create_task calls in the Python request path into durable jobs/events
 * with idempotency keys, retry ownership, failure visibility, and dead-letter
 * expectations. See VAY-654 / VAY-642.
 */

// ── Shared primitives ────────────────────────────────────────────────────────

export const CHANNEX_JOB_CONTRACT_VERSION = "pms-channex-jobs.v1" as const;
export type ChannexJobContractVersion = typeof CHANNEX_JOB_CONTRACT_VERSION;

/** ISO-8601 UTC date-time string. */
export type ChannexUtcDateTime = string;

/** ISO-8601 calendar date string (YYYY-MM-DD). */
export type ChannexDate = string;

export const CHANNEX_JOB_TYPES = [
  "channex.inbound.revision.process",
  "channex.ari.room_type.push",
  "channex.ari.booking.push",
  "channex.ari.room_block.push",
  "channex.notification.ota_booking_imported",
  "channex.notification.guest_booking_alert",
  "channex.payout.booking_settled",
  "channex.audit.side_effect_recorded",
] as const;

export type ChannexJobType = (typeof CHANNEX_JOB_TYPES)[number];

/**
 * Job owner domains.
 * NOTE: "booking" here refers to the Booking audit consumer — a read-only sink
 * that records inbound revision outcomes. The Booking Engine MUST NOT import
 * this package or any Channex implementation module. The Booking Engine
 * interacts with PMS through the reservation sink and operational read
 * contracts in packages/domain-pms, or through typed domain events.
 */
export const CHANNEX_JOB_OWNERS = ["pms", "booking", "finance", "notification"] as const;
export type ChannexJobOwner = (typeof CHANNEX_JOB_OWNERS)[number];

export const CHANNEX_JOB_RETRY_POLICIES = [
  "no_retry",
  "exponential_backoff",
  "fixed_interval",
] as const;
export type ChannexJobRetryPolicy = (typeof CHANNEX_JOB_RETRY_POLICIES)[number];

export const CHANNEX_JOB_DEAD_LETTER_REASONS = [
  "max_retries_exceeded",
  "non_retryable_error",
  "idempotency_conflict",
  "mapping_missing",
  "provider_rejected",
  "validation_failed",
  "notification_settings_unavailable",
] as const;
export type ChannexJobDeadLetterReason = (typeof CHANNEX_JOB_DEAD_LETTER_REASONS)[number];

export const CHANNEX_INBOUND_REVISION_EVENTS = [
  "booking.created",
  "booking.modified",
  "booking.cancelled",
] as const;
export type ChannexInboundRevisionEvent = (typeof CHANNEX_INBOUND_REVISION_EVENTS)[number];

/**
 * Why the notification was dispatched. Used as the `trigger` field on
 * ChannexOtaBookingImportedNotificationJob to discriminate notification cause
 * without re-inspecting revisionEvent.
 */
export const CHANNEX_NOTIFICATION_TRIGGER_REASONS = [
  "ota_booking_imported",
  "ota_booking_modified",
  "ota_booking_cancelled",
] as const;
export type ChannexNotificationTriggerReason =
  (typeof CHANNEX_NOTIFICATION_TRIGGER_REASONS)[number];

export const CHANNEX_ARI_PUSH_TRIGGERS = [
  "room_block_created",
  "room_block_updated",
  "room_block_deleted",
  "admin_booking_created",
  "admin_booking_cancelled",
  "guest_change_approved",
  "guest_change_cancelled",
  "full_hotel_sync",
  "rate_plan_updated",
  "inbound_revision_processed",
] as const;
export type ChannexAriPushTrigger = (typeof CHANNEX_ARI_PUSH_TRIGGERS)[number];

// ── Job audit context ────────────────────────────────────────────────────────

export type ChannexJobAudit = {
  jobId: string;
  jobType: ChannexJobType;
  contractVersion: ChannexJobContractVersion;
  idempotencyKey: string;
  propertyId: string;
  organizationId: string;
  causationId?: string;
  correlationId: string;
  scheduledAt: ChannexUtcDateTime;
  attemptNumber: number;
  owner: ChannexJobOwner;
};

// ── Dead-letter envelope ─────────────────────────────────────────────────────

export type ChannexJobDeadLetterEnvelope = {
  contractVersion: ChannexJobContractVersion;
  jobId: string;
  jobType: ChannexJobType;
  idempotencyKey: string;
  propertyId: string;
  organizationId: string;
  correlationId: string;
  deadLetterReason: ChannexJobDeadLetterReason;
  lastError: string;
  failedAt: ChannexUtcDateTime;
  attemptCount: number;
  originalPayload: unknown;
};

// ── 1. Channex inbound revision job ─────────────────────────────────────────
//
// Owner: pms
// Idempotency key: channex.inbound:{propertyId}:{channexBookingId}:{revisionEvent}:{revisionSequence}:v1
// Retry policy: exponential_backoff (retryable integration failures)
// Dead-letter reason: max_retries_exceeded | mapping_missing | validation_failed
//
// This job replaces the inline asyncio.create_task calls in inbound.py that
// trigger ARI push, notification, and room-assignment side effects. The job
// runner must process one revision at a time per property to preserve ordering.

export type ChannexInboundRevisionJobPayload = {
  /** Channex booking ID from the channel manager. */
  channexBookingId: string;
  /** Hotel ID in the Vayada PMS database. */
  propertyId: string;
  /** Internal organization that owns this property. */
  organizationId: string;
  /** Channex connection ID for this property. */
  connectionId: string;
  /** Channex property ID on the channel-manager side. */
  channexPropertyId: string;
  /** The revision event type that triggered this job. */
  revisionEvent: ChannexInboundRevisionEvent;
  /**
   * Revision discriminator from the Channex webhook payload — either a
   * monotonically increasing sequence number or the webhook received-timestamp
   * (ISO-8601). Used in the idempotency key to disambiguate repeated events of
   * the same type for the same booking.
   */
  revisionSequence: string | number;
  /**
   * Opaque revision payload from Channex.
   * The PMS inbound handler owns deserialization and validation.
   */
  rawRevision: unknown;
  /**
   * Downstream side-effect jobs that the inbound handler should enqueue
   * after successful revision processing. The job runner must NOT trigger
   * these directly; they are specified here for the inbound handler to
   * schedule through the job infrastructure.
   */
  downstreamJobs: {
    ariPush: boolean;
    notification: boolean;
    audit: boolean;
  };
};

export type ChannexInboundRevisionJob = {
  jobType: "channex.inbound.revision.process";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "exponential_backoff">;
  maxAttempts: number;
  payload: ChannexInboundRevisionJobPayload;
};

// ── 2. ARI push for a single room type ──────────────────────────────────────
//
// Owner: pms
// Idempotency key: channex.ari.room_type:{propertyId}:{roomTypeId}:{trigger}:{triggerRefId}:v1
// Retry policy: exponential_backoff
// Dead-letter reason: max_retries_exceeded | mapping_missing | provider_rejected

export type ChannexAriRoomTypePushPayload = {
  propertyId: string;
  organizationId: string;
  connectionId: string;
  channexPropertyId: string;
  roomTypeId: string;
  channexRoomTypeId: string;
  trigger: ChannexAriPushTrigger;
  /**
   * The ID of the entity that caused this push (booking ID, room-block ID,
   * rate-plan ID, etc.). Used for dead-letter correlation.
   */
  triggerRefId: string;
  dateRange: {
    from: ChannexDate;
    to: ChannexDate;
  };
  includeAvailability: boolean;
  includeRestrictions: boolean;
};

export type ChannexAriRoomTypePushJob = {
  jobType: "channex.ari.room_type.push";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "exponential_backoff">;
  maxAttempts: number;
  payload: ChannexAriRoomTypePushPayload;
};

// ── 3. ARI push triggered by a booking event ────────────────────────────────
//
// Owner: pms
// Idempotency key: channex.ari.booking:{bookingId}:{trigger}:{occurredAt}:v1
// Retry policy: exponential_backoff
//
// Replaces asyncio.create_task(push_ari_for_booking(...)) calls in
// booking_change_service.py and admin_bookings.py.
//
// The occurredAt component disambiguates repeated guest_change_approved or
// guest_change_cancelled events on the same booking.

export type ChannexAriBookingPushPayload = {
  propertyId: string;
  organizationId: string;
  /** Channex connection ID for this property. */
  connectionId: string;
  /** Channex property ID on the channel-manager side. */
  channexPropertyId: string;
  bookingId: string;
  trigger: Extract<
    ChannexAriPushTrigger,
    | "admin_booking_created"
    | "admin_booking_cancelled"
    | "guest_change_approved"
    | "guest_change_cancelled"
  >;
  /**
   * ISO-8601 timestamp of the triggering event. Included in the idempotency
   * key to disambiguate repeated guest_change_approved / guest_change_cancelled
   * events on the same booking.
   */
  occurredAt: ChannexUtcDateTime;
  /**
   * Room type IDs whose ARI must be refreshed. The PMS job handler derives
   * channex mapping IDs from these.
   */
  affectedRoomTypeIds: string[];
};

export type ChannexAriBookingPushJob = {
  jobType: "channex.ari.booking.push";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "exponential_backoff">;
  maxAttempts: number;
  payload: ChannexAriBookingPushPayload;
};

// ── 4. ARI push triggered by a room-block event ──────────────────────────────
//
// Owner: pms
// Idempotency key: channex.ari.room_block:{roomBlockId}:{trigger}:{occurredAt}:v1
// Retry policy: exponential_backoff
//
// Replaces asyncio.create_task(push_ari_for_room_type(...)) calls in
// admin_room_blocks.py. Covers create/update/delete lifecycle.
// The occurredAt component disambiguates repeated room_block_updated events.

export type ChannexAriRoomBlockPushPayload = {
  propertyId: string;
  organizationId: string;
  /** Channex connection ID for this property. */
  connectionId: string;
  /** Channex property ID on the channel-manager side. */
  channexPropertyId: string;
  roomBlockId: string;
  roomTypeId: string;
  trigger: Extract<
    ChannexAriPushTrigger,
    "room_block_created" | "room_block_updated" | "room_block_deleted"
  >;
  dateRange: {
    from: ChannexDate;
    to: ChannexDate;
  };
  /**
   * ISO-8601 timestamp of the triggering event. Required for `room_block_updated`
   * to disambiguate repeated updates on the same room block in the idempotency key.
   */
  occurredAt: ChannexUtcDateTime;
};

export type ChannexAriRoomBlockPushJob = {
  jobType: "channex.ari.room_block.push";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "exponential_backoff">;
  maxAttempts: number;
  payload: ChannexAriRoomBlockPushPayload;
};

// ── 5. OTA booking imported notification ────────────────────────────────────
//
// Owner: notification
// Idempotency key: channex.notification.ota_imported:{propertyId}:{bookingId}:{revisionEvent}:v1
// Retry policy: fixed_interval (at most 3 attempts; swallowed on final failure)
// Dead-letter reason: notification_settings_unavailable | non_retryable_error
//
// Notification preferences MUST be consumed through a settings/read model, not
// through a direct read of the booking_db inside the Channex ingestion path.
// The job payload carries the recipient email resolved before job dispatch so
// the notification handler does not need cross-domain DB access.

export type ChannexOtaBookingImportedNotificationPayload = {
  propertyId: string;
  organizationId: string;
  bookingId: string;
  channexBookingId: string;
  revisionEvent: ChannexInboundRevisionEvent;
  /** Why the notification was triggered. Discriminates cause without re-inspecting revisionEvent. */
  trigger: ChannexNotificationTriggerReason;
  /**
   * Recipient resolved from the hotel's notification settings read model.
   * If the settings read model is unavailable at dispatch time, the job
   * must be placed in dead-letter with reason notification_settings_unavailable.
   */
  recipientEmail: string;
  /**
   * Notification preference snapshot at dispatch time.
   * Derived from a settings/read model, NOT from a booking_db query inside
   * the Channex ingestion path.
   */
  notificationPreferences: {
    emailNotificationsEnabled: boolean;
    otaBookingAlertsEnabled: boolean;
  };
};

export type ChannexOtaBookingImportedNotificationJob = {
  jobType: "channex.notification.ota_booking_imported";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "fixed_interval">;
  maxAttempts: number;
  payload: ChannexOtaBookingImportedNotificationPayload;
};

// ── 6. Guest booking alert (admin-created or status change) ─────────────────
//
// Owner: notification
// Idempotency key: channex.notification.guest_alert:{bookingId}:{alertKind}:v1
// Retry policy: fixed_interval
//
// Replaces asyncio.create_task(send_guest_confirmation/send_guest_cancellation)
// calls in admin_bookings.py and booking_change_service.py.

export const CHANNEX_GUEST_ALERT_KINDS = [
  "booking_confirmed",
  "booking_modified",
  "booking_cancelled",
  "change_request_received",
  "change_request_approved",
  "change_request_declined",
] as const;
export type ChannexGuestAlertKind = (typeof CHANNEX_GUEST_ALERT_KINDS)[number];

export type ChannexGuestBookingAlertPayload = {
  propertyId: string;
  organizationId: string;
  bookingId: string;
  bookingReference: string;
  alertKind: ChannexGuestAlertKind;
  recipientEmail: string;
  locale: string;
};

export type ChannexGuestBookingAlertJob = {
  jobType: "channex.notification.guest_booking_alert";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "fixed_interval">;
  maxAttempts: number;
  payload: ChannexGuestBookingAlertPayload;
};

// ── 7. Payout booking settled ────────────────────────────────────────────────
//
// Owner: finance
// Idempotency key: channex.payout.booking_settled:{bookingId}:v1
// Retry policy: exponential_backoff
// Dead-letter reason: max_retries_exceeded | non_retryable_error
//
// Replaces payout side effects triggered inline in admin_bookings.py.

export type ChannexPayoutBookingSettledPayload = {
  propertyId: string;
  organizationId: string;
  bookingId: string;
  bookingReference: string;
  /**
   * Finance-owned fields. The finance domain resolves payout amounts and
   * settings; they are not derived from a direct PMS booking_db read in the
   * Channex ingestion path.
   */
  settledAt: ChannexUtcDateTime;
  payoutSettingsId?: string;
};

export type ChannexPayoutBookingSettledJob = {
  jobType: "channex.payout.booking_settled";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "exponential_backoff">;
  maxAttempts: number;
  payload: ChannexPayoutBookingSettledPayload;
};

// ── 8. Side-effect audit record ──────────────────────────────────────────────
//
// Owner: pms
// Idempotency key: channex.audit.side_effect:{correlationId}:{jobType}:v1
// Retry policy: no_retry (best-effort; missing audit is not a blocking failure)
// Dead-letter reason: non_retryable_error
//
// Each completed or dead-lettered job emits one audit record referencing the
// VAY-642 audit contract. This closes the gap from fire-and-forget tasks.

export type ChannexSideEffectAuditPayload = {
  propertyId: string;
  organizationId: string;
  /** The job whose completion (or dead-letter) is being audited. */
  auditedJobId: string;
  auditedJobType: ChannexJobType;
  outcome: "completed" | "dead_lettered";
  deadLetterReason?: ChannexJobDeadLetterReason;
  /** Free-form context forwarded to the product audit log. */
  context?: Record<string, string | number | boolean | null>;
  occurredAt: ChannexUtcDateTime;
};

export type ChannexSideEffectAuditJob = {
  jobType: "channex.audit.side_effect_recorded";
  jobId: string;
  idempotencyKey: string;
  audit: ChannexJobAudit;
  retryPolicy: Extract<ChannexJobRetryPolicy, "no_retry">;
  maxAttempts: 1;
  payload: ChannexSideEffectAuditPayload;
};

// ── Discriminated union of all Channex jobs ──────────────────────────────────

export type ChannexJob =
  | ChannexInboundRevisionJob
  | ChannexAriRoomTypePushJob
  | ChannexAriBookingPushJob
  | ChannexAriRoomBlockPushJob
  | ChannexOtaBookingImportedNotificationJob
  | ChannexGuestBookingAlertJob
  | ChannexPayoutBookingSettledJob
  | ChannexSideEffectAuditJob;

// ── Job runner port ───────────────────────────────────────────────────────────

/**
 * The job runner port that PMS domain code uses to enqueue Channex side-effect
 * jobs. Implementations must guarantee at-least-once delivery, idempotency-key
 * deduplication, and dead-letter visibility.
 *
 * The Booking Engine MUST NOT implement or call this port directly.
 */
export interface ChannexJobQueue {
  enqueue(job: ChannexJob): Promise<{ jobId: string; idempotencyKey: string }>;
  enqueueMany(jobs: ChannexJob[]): Promise<Array<{ jobId: string; idempotencyKey: string }>>;
}

// ── Idempotency key builders ──────────────────────────────────────────────────

export function buildInboundRevisionIdempotencyKey(input: {
  propertyId: string;
  channexBookingId: string;
  revisionEvent: ChannexInboundRevisionEvent;
  /**
   * Revision discriminator from the Channex webhook payload — either a
   * monotonically increasing sequence number or the webhook received-timestamp
   * (ISO-8601). Required to disambiguate repeated events of the same type for
   * the same booking (e.g. two successive `booking.modified` deliveries).
   */
  revisionSequence: string | number;
}): string {
  return `channex.inbound:${input.propertyId}:${input.channexBookingId}:${input.revisionEvent}:${input.revisionSequence}:v1`;
}

export function buildAriRoomTypePushIdempotencyKey(input: {
  propertyId: string;
  roomTypeId: string;
  trigger: ChannexAriPushTrigger;
  triggerRefId: string;
}): string {
  return `channex.ari.room_type:${input.propertyId}:${input.roomTypeId}:${input.trigger}:${input.triggerRefId}:v1`;
}

export function buildAriBookingPushIdempotencyKey(input: {
  bookingId: string;
  trigger: ChannexAriBookingPushPayload["trigger"];
  /**
   * ISO-8601 timestamp of the triggering event. Included in the key to
   * disambiguate repeated `guest_change_approved` / `guest_change_cancelled`
   * events on the same booking.
   */
  occurredAt: ChannexUtcDateTime;
}): string {
  return `channex.ari.booking:${input.bookingId}:${input.trigger}:${input.occurredAt}:v1`;
}

export function buildAriRoomBlockPushIdempotencyKey(input: {
  roomBlockId: string;
  trigger: ChannexAriRoomBlockPushPayload["trigger"];
  /**
   * ISO-8601 timestamp of the triggering event. Included in the key to
   * disambiguate repeated `room_block_updated` events on the same room block.
   */
  occurredAt: ChannexUtcDateTime;
}): string {
  return `channex.ari.room_block:${input.roomBlockId}:${input.trigger}:${input.occurredAt}:v1`;
}

/**
 * Builds the idempotency key for an OTA booking-imported notification job.
 *
 * Deduplication behaviour (intentional): a single `revisionEvent` per booking
 * per property produces the same key, so a second `booking.modified`
 * notification for the same booking will be deduplicated by the job runner.
 * This is deliberate — host email notifications are edge-triggered (one alert
 * per lifecycle event type, not per revision sequence), so repeated
 * `booking.modified` revisions from the OTA do not generate duplicate emails.
 * If fine-grained per-revision notifications are needed in the future, add a
 * `revisionSequence` discriminator here (matching the inbound revision job
 * pattern used by `buildInboundRevisionIdempotencyKey`).
 */
export function buildOtaBookingImportedNotificationIdempotencyKey(input: {
  propertyId: string;
  bookingId: string;
  revisionEvent: ChannexInboundRevisionEvent;
}): string {
  return `channex.notification.ota_imported:${input.propertyId}:${input.bookingId}:${input.revisionEvent}:v1`;
}

export function buildGuestBookingAlertIdempotencyKey(input: {
  bookingId: string;
  alertKind: ChannexGuestAlertKind;
}): string {
  return `channex.notification.guest_alert:${input.bookingId}:${input.alertKind}:v1`;
}

export function buildPayoutBookingSettledIdempotencyKey(input: { bookingId: string }): string {
  return `channex.payout.booking_settled:${input.bookingId}:v1`;
}

export function buildSideEffectAuditIdempotencyKey(input: {
  correlationId: string;
  jobType: ChannexJobType;
}): string {
  return `channex.audit.side_effect:${input.correlationId}:${input.jobType}:v1`;
}

// ── Notification settings read model ─────────────────────────────────────────
//
// Channex ingestion MUST NOT read booking_db directly to resolve notification
// preferences. Instead, it must use this read model, which is populated by the
// hotel settings domain and cached independently.

export type ChannexNotificationSettingsReadModel = {
  propertyId: string;
  organizationId: string;
  emailNotificationsEnabled: boolean;
  otaBookingAlertsEnabled: boolean;
  /** Contact email resolved from the hotel settings (not from booking_db inline). */
  contactEmail: string | null;
  /** Timestamp when this snapshot was last refreshed. */
  settingsSnapshotAt: ChannexUtcDateTime;
};

export interface ChannexNotificationSettingsReadPort {
  getNotificationSettings(input: {
    propertyId: string;
  }): Promise<ChannexNotificationSettingsReadModel | null>;
}

export * from "./management.js";
