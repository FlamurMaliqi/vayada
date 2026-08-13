export const MANUAL_BOOKING_EXPECTED_PAYMENT_METHODS = [
  "pay_at_property",
  "bank_transfer",
  "manual_card",
  "cash",
  "other",
] as const;

export type ManualBookingExpectedPaymentMethod =
  (typeof MANUAL_BOOKING_EXPECTED_PAYMENT_METHODS)[number];

export type RecordManualBookingPaymentIntentCommand = Readonly<{
  contractVersion: "pms-manual-booking.v1";
  propertyId: string;
  guestBookingId: string;
  expectedMethod: ManualBookingExpectedPaymentMethod;
}>;

/** Booking-owned write boundary used by the PMS manual-booking transaction. */
export interface ManualBookingPaymentIntentOwnerPort {
  recordExpectedPaymentMethod(command: RecordManualBookingPaymentIntentCommand): Promise<void>;
}
