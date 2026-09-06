import type pg from "pg";
import {
  assertTargetBookingConfirmationTokenActive,
  createHttpError,
  loadTargetBooking,
  loadTargetHotelBooking,
  objectValue,
  resolveTargetHistoricalBookingProperty,
  sha256Hex,
  stringValue,
  type BookingWebCheckoutRequest,
  type TargetBookingRow,
} from "./bookingWebPublic.js";
type EditableBooking = TargetBookingRow & { editRevision: number; deadline: string };

export async function authorize(
  client: pg.PoolClient,
  slug: string,
  bookingId: string,
  request: BookingWebCheckoutRequest,
  now: () => Date,
) {
  const token = stringValue(request["confirmationToken"]);
  if (!token || !/^[A-Za-z0-9_-]{40,80}$/.test(token))
    throw createHttpError(404, "Booking not found.");
  const property = await resolveTargetHistoricalBookingProperty(client, slug);
  const authenticated = await loadTargetBooking(
    client,
    property.propertyId,
    bookingId,
    null,
    sha256Hex(token),
  );
  const booking = await loadTargetHotelBooking(
    client,
    property.propertyId,
    authenticated.guestBookingId,
    true,
  );
  assertTargetBookingConfirmationTokenActive(booking, sha256Hex(token), now());
  return { property, booking };
}

export async function editable(
  client: pg.PoolClient,
  booking: TargetBookingRow,
  now: Date,
): Promise<EditableBooking> {
  const metadata = objectValue(booking.bookingMetadata);
  const deadline = stringValue(metadata["hostResponseDeadlineAt"] ?? metadata["pendingExpiresAt"]);
  if (
    booking.lifecycleStatus !== "pending_payment" ||
    !["unpaid", "authorized"].includes(booking.paymentStatus) ||
    metadata["acceptedPaymentDeadlineAt"] ||
    !deadline ||
    !Number.isFinite(Date.parse(deadline)) ||
    Date.parse(deadline) <= now.getTime()
  )
    throw createHttpError(409, "This request can no longer be edited.");
  const state = (
    await client.query<{
      revision: number;
      accepted: boolean;
      financial: boolean;
      supported: boolean;
    }>(
      `SELECT edit_revision AS revision,
       EXISTS(SELECT 1 FROM booking.booking_status_events e WHERE e.guest_booking_id=b.id
         AND e.event_type IN ('guest_booking.accepted','booking.accepted','booking_accepted')) AS accepted,
       EXISTS(SELECT 1 FROM finance.folios f WHERE f.guest_booking_id=b.id) AS financial,
       EXISTS(SELECT 1 FROM pms.pending_booking_edit_support support
          WHERE support.guest_booking_id=b.id AND support.property_id=b.property_id) AS supported
     FROM booking.guest_bookings b WHERE id=$1::uuid`,
      [booking.guestBookingId],
    )
  ).rows[0];
  if (!state || state.accepted || state.financial || !state.supported)
    throw createHttpError(409, "This request can no longer be edited.");
  return { ...booking, editRevision: state.revision, deadline };
}

export function requireRevision(booking: EditableBooking, value: unknown) {
  if (!Number.isSafeInteger(value) || value !== booking.editRevision)
    throw createHttpError(
      409,
      "This request changed. Reopen the editor to load its latest details.",
    );
}

export async function guestInput(
  client: pg.PoolClient,
  booking: TargetBookingRow,
  request: BookingWebCheckoutRequest,
): Promise<BookingWebCheckoutRequest> {
  const guest = (
    await client.query(
      `SELECT first_name,last_name,email,phone,country_code,arrival_time,special_requests
    FROM booking.booking_guests WHERE guest_booking_id=$1::uuid AND guest_role='booker'`,
      [booking.guestBookingId],
    )
  ).rows[0];
  if (!guest) throw createHttpError(404, "Booking not found.");
  const { confirmationToken: _token, ...input } = request;
  return {
    ...input,
    guestFirstName: guest.first_name,
    guestLastName: guest.last_name,
    guestEmail: guest.email,
    guestPhone: guest.phone ?? "",
    guestCountry: guest.country_code ?? undefined,
  };
}
