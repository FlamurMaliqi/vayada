import type { ProductReadinessResult } from "@vayada/domain-hotels";

export const BOOKING_PUBLICATION_OPERATION_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "unknown",
] as const;

export type BookingPublicationOperationStatus =
  (typeof BOOKING_PUBLICATION_OPERATION_STATUSES)[number];

export const BOOKING_PUBLICATION_FAILURE_CODES = [
  "external_result_unconfirmed",
  "projection_failed",
  "source_content_changed",
] as const;

export type BookingPublicationFailureCode = (typeof BOOKING_PUBLICATION_FAILURE_CODES)[number];

export type ReadyBookingPublicationEvidence = ProductReadinessResult & {
  readonly product: "booking";
  readonly status: "ready";
};

export type BookingPublicationAuditContext = {
  requestId: string;
  correlationId?: string;
  source: string;
};

/** Safe recovery projection; source manifests and unpublished content stay private. */
export type BookingPublicationOperation = {
  operationId: string;
  propertyId: string;
  status: BookingPublicationOperationStatus;
  expectedActiveContentRevisionId: string | null;
  resultContentRevisionId: string | null;
  failureCode: BookingPublicationFailureCode | null;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type RequestBookingPublicationCommand = {
  organizationId: string;
  propertyId: string;
  actorUserId: string;
  idempotencyKey: string;
  expectedActiveContentRevisionId: string | null;
  readiness: ReadyBookingPublicationEvidence;
  audit: BookingPublicationAuditContext;
};

export type BookingPublicationRequestError = {
  code:
    | "active_content_revision_conflict"
    | "command_in_progress"
    | "idempotency_key_conflict"
    | "invalid_readiness_evidence"
    | "publication_in_progress"
    | "setup_scope_unavailable";
  currentActiveContentRevisionId?: string | null;
};

export type BookingPublicationRequestResult =
  | { ok: true; operation: BookingPublicationOperation }
  | { ok: false; error: BookingPublicationRequestError };

/** Booking owns durable attempts; a later projector owns public activation. */
export interface BookingPublicationCommandPort {
  requestPublication(
    command: RequestBookingPublicationCommand,
  ): Promise<BookingPublicationRequestResult>;
  getPublicationStatus(input: {
    organizationId: string;
    propertyId: string;
    operationId: string;
    actorUserId: string;
  }): Promise<BookingPublicationOperation | null>;
  close?(): Promise<void>;
}
