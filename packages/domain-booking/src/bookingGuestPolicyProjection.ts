import type {
  BookingGuestPolicyChangedEvent,
  BookingGuestPolicyProjectionReceipt,
} from "./bookingGuestPolicyAggregate.js";

export type BookingGuestPolicyProjectionMessage = Readonly<{
  organizationId: string;
  outboxEventId: string;
  event: BookingGuestPolicyChangedEvent;
  processedAt: string;
}>;

export type BookingGuestPolicyProjectionResult =
  | Readonly<{
      outcome: "applied" | "source_revision_conflict";
      receipt: BookingGuestPolicyProjectionReceipt;
    }>
  | Readonly<{ outcome: "retry"; errorSource: "provider" | "system" }>
  | Readonly<{
      outcome: "rejected";
      code:
        | "malformed_message"
        | "projection_not_found"
        | "projection_contract_violation"
        | "catalog_projection_malformed";
    }>;

export interface BookingGuestPolicyProjectionHandlerPort {
  handleGuestPolicyProjection(
    message: BookingGuestPolicyProjectionMessage,
  ): Promise<BookingGuestPolicyProjectionResult>;
}
