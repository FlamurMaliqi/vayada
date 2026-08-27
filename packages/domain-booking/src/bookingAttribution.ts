export const BOOKING_CHANNEL_VALUES = Object.freeze([
  "direct",
  "booking_com",
  "airbnb",
  "expedia",
  "agoda",
  "other_ota",
  "unknown",
] as const);

export const DIRECT_BOOKING_SOURCE_VALUES = Object.freeze([
  "booking_engine",
  "whatsapp",
  "call",
  "email",
  "walk_in",
  "social_media",
  "other",
] as const);

export type BookingChannel = (typeof BOOKING_CHANNEL_VALUES)[number];
export type DirectBookingSource = (typeof DIRECT_BOOKING_SOURCE_VALUES)[number];

export type BookingAttribution =
  | { bookingChannel: "direct"; directBookingSource: DirectBookingSource }
  | {
      bookingChannel: Exclude<BookingChannel, "direct">;
      directBookingSource: null;
    };

export function parseBookingAttribution(value: unknown): BookingAttribution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const input = value as Record<string, unknown>;
  const bookingChannel = input["bookingChannel"];
  const directBookingSource = input["directBookingSource"];
  if (!isBookingChannel(bookingChannel)) return null;

  if (bookingChannel === "direct") {
    return isDirectBookingSource(directBookingSource)
      ? { bookingChannel, directBookingSource }
      : null;
  }

  return directBookingSource == null ? { bookingChannel, directBookingSource: null } : null;
}

function isBookingChannel(value: unknown): value is BookingChannel {
  return BOOKING_CHANNEL_VALUES.some((candidate) => candidate === value);
}

function isDirectBookingSource(value: unknown): value is DirectBookingSource {
  return DIRECT_BOOKING_SOURCE_VALUES.some((candidate) => candidate === value);
}
