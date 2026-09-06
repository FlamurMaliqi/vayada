import type { Booking } from "@/lib/types";
import type { BookingCreateRequest, BookingQuote, BookingRequestResponse } from "./booking";
import { bookingWebPublic } from "./client";

export type PendingEditDetails = {
  booking: Booking;
  revision: number;
  input: BookingCreateRequest;
};
export type PendingEditAttempt = {
  attemptId: string;
  clientSecret: string | null;
  stripeAccountId?: string;
};

export function pendingBookingEdit<T>(
  slug: string,
  reference: string,
  token: string,
  action: "details" | "quote" | "prepare" | "save",
  input: object = {},
  key?: string,
): Promise<T> {
  return bookingWebPublic.post<T>(
    `/api/booking-web/hotels/${encodeURIComponent(slug)}/bookings/${encodeURIComponent(reference)}/edit/${action}`,
    { ...input, confirmationToken: token },
    key ? { headers: { "Idempotency-Key": key } } : undefined,
  );
}

export type { BookingQuote, BookingRequestResponse };
