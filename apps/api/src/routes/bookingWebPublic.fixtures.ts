import type { BookingWebCheckoutAdapter } from "./bookingWebPublic.js";

const rejectUnexpectedCall = (method: keyof BookingWebCheckoutAdapter) => (): never => {
  throw new Error(`Unexpected Booking Web checkout adapter call: ${method}`);
};

export const unusedBookingWebCheckoutAdapter = {
  consumeLookupAttempt: rejectUnexpectedCall("consumeLookupAttempt"),
  getCheckoutConfig: rejectUnexpectedCall("getCheckoutConfig"),
  quoteBooking: rejectUnexpectedCall("quoteBooking"),
  createBooking: rejectUnexpectedCall("createBooking"),
  confirmAuthorization: rejectUnexpectedCall("confirmAuthorization"),
  getStatus: rejectUnexpectedCall("getStatus"),
  lookup: rejectUnexpectedCall("lookup"),
  confirmation: rejectUnexpectedCall("confirmation"),
  withdraw: rejectUnexpectedCall("withdraw"),
  cancelPreview: rejectUnexpectedCall("cancelPreview"),
  cancel: rejectUnexpectedCall("cancel"),
  previewChangeRequest: rejectUnexpectedCall("previewChangeRequest"),
  submitChangeRequest: rejectUnexpectedCall("submitChangeRequest"),
  getChangeRequest: rejectUnexpectedCall("getChangeRequest"),
  getPaymentInstructions: rejectUnexpectedCall("getPaymentInstructions"),
  validatePromo: rejectUnexpectedCall("validatePromo"),
} satisfies BookingWebCheckoutAdapter;
