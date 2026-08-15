import { Booking } from "@/lib/types";
import { pms } from "./client";

export interface BookingRequestResponse {
  // For card payments (VAY-388) `booking` is a placeholder preview —
  // status === 'draft' and id is empty until Stripe authorizes the card.
  // For other payment methods it's a real persisted booking.
  booking: Booking;
  clientSecret: string | null;
  stripeAccountId?: string;
  xenditInvoiceUrl: string | null;
  paymentMethod: string;
  // Soft-hold draft id, present when paymentMethod === 'card'. Pass it
  // to confirmAuthorization() after Stripe.confirmPayment resolves.
  draftId?: string;
  bookingReference?: string;
}

export interface BookingQuote {
  roomTypeId: string;
  roomName: string;
  rateType: string;
  paymentMethod: string;
  nightlyRate: number;
  numberOfRooms: number;
  roomTotal: number;
  addonTotal: number;
  promoCode?: string | null;
  promoDiscount: number;
  lastMinuteDiscountPercent: number;
  lastMinuteDiscountAmount: number;
  totalAmount: number;
  currency: string;
  depositRequired: boolean;
  depositPercentage?: number | null;
  depositAmount: number;
  balanceAmount: number;
}

export interface BankDetails {
  accountHolder: string;
  accountType?: "iban" | "account_number";
  iban: string;
  accountNumber?: string;
  bankName: string;
  swift: string;
}

export interface PaymentSettings {
  payAtPropertyEnabled: boolean;
  onlineCardPayment?: boolean;
  bankTransfer?: boolean;
  paypalEnabled?: boolean;
  paypalEmail?: string;
  paypalPaymentWindowHours?: number;
  bankDetails?: BankDetails;
  xenditPaymentsEnabled?: boolean;
  payAtHotelMethods?: string[];
  freeCancellationDays: number;
  specialRequestsEnabled?: boolean;
  arrivalTimeEnabled?: boolean;
  guestCountEnabled?: boolean;
  phoneRequired?: boolean;
  sameDayBookingsEnabled?: boolean;
  sameDayBookingCutoffTime?: string | null;
  termsText?: string;
  cancellationPolicyText?: string;
}

export interface BookingStatus {
  status: string;
  paymentStatus: string | null;
  hostResponseDeadline: string | null;
}

export interface CancelPreview {
  refundAmount: number;
  refundPercentage: number;
  freeCancellationDays: number;
  daysUntilCheckIn: number;
  currency: string;
}

export const bookingService = {
  async create(
    slug: string,
    data: {
      roomTypeId: string;
      guestFirstName: string;
      guestLastName: string;
      guestEmail: string;
      guestPhone: string;
      guestCountry?: string;
      specialRequests?: string;
      estimatedArrivalTime?: string;
      numberOfGuests?: number;
      checkIn: string;
      checkOut: string;
      adults: number;
      children: number;
      numberOfRooms?: number;
      referralCode?: string;
      paymentMethod?: string;
      rateType?: string;
      addonIds?: string[];
      addonQuantities?: Record<string, number>;
      addonDates?: Record<string, string[]>;
      promoCode?: string;
      expectedTotalAmount?: number;
    },
  ): Promise<BookingRequestResponse> {
    return pms.post(`/api/hotels/${slug}/bookings`, data);
  },

  async quote(
    slug: string,
    data: {
      roomTypeId: string;
      guestFirstName: string;
      guestLastName: string;
      guestEmail: string;
      guestPhone: string;
      guestCountry?: string;
      specialRequests?: string;
      estimatedArrivalTime?: string;
      numberOfGuests?: number;
      checkIn: string;
      checkOut: string;
      adults: number;
      children: number;
      numberOfRooms?: number;
      referralCode?: string;
      paymentMethod?: string;
      rateType?: string;
      addonIds?: string[];
      addonQuantities?: Record<string, number>;
      addonDates?: Record<string, string[]>;
      promoCode?: string;
    },
  ): Promise<BookingQuote> {
    return pms.post(`/api/hotels/${slug}/bookings/quote`, data);
  },

  // Materializes the soft-hold draft into a real booking row after
  // Stripe authorizes the card. Returns the booking so the caller can
  // redirect with a real reference. Idempotent: a second call after the
  // Stripe webhook has already materialized the draft returns the same
  // booking. Accepts a draft id (VAY-388) or a legacy booking id.
  async confirmAuthorization(slug: string, handle: string): Promise<Booking> {
    return pms.post(`/api/hotels/${slug}/bookings/${handle}/confirm-authorization`);
  },

  async withdraw(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    await pms.post(`/api/hotels/${slug}/bookings/${bookingId}/withdraw`, {
      guest_email: guestEmail,
    });
  },

  async cancelPreview(slug: string, bookingId: string, guestEmail: string): Promise<CancelPreview> {
    return pms.post(`/api/hotels/${slug}/bookings/${bookingId}/cancel-preview`, {
      guest_email: guestEmail,
    });
  },

  async cancel(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    await pms.post(`/api/hotels/${slug}/bookings/${bookingId}/cancel`, { guest_email: guestEmail });
  },

  async getStatus(slug: string, reference: string, email: string): Promise<BookingStatus> {
    const params = new URLSearchParams({ reference, email });
    return pms.get(`/api/hotels/${slug}/bookings/status?${params}`);
  },

  async getPaymentSettings(slug: string): Promise<PaymentSettings> {
    try {
      return await pms.get<PaymentSettings>(`/api/hotels/${slug}/payment-settings`);
    } catch {
      // Settings endpoint is best-effort — return a permissive default so the
      // checkout form still renders if the backend is briefly unreachable.
      return { payAtPropertyEnabled: false, freeCancellationDays: 7 };
    }
  },

  async lookup(slug: string, bookingReference: string, guestEmail: string): Promise<Booking> {
    return pms.post(`/api/hotels/${slug}/bookings/lookup`, { bookingReference, guestEmail });
  },

  // Guest-initiated booking change requests (VAY-379)
  async previewChangeRequest(
    slug: string,
    bookingId: string,
    payload: ChangeRequestPayload,
  ): Promise<ChangeRequestPreview> {
    return pms.post(`/api/hotels/${slug}/bookings/${bookingId}/change-request/preview`, payload);
  },

  async submitChangeRequest(
    slug: string,
    bookingId: string,
    payload: ChangeRequestPayload,
  ): Promise<BookingChangeRequest> {
    return pms.post(`/api/hotels/${slug}/bookings/${bookingId}/change-request`, payload);
  },

  async getChangeRequest(
    slug: string,
    bookingId: string,
    email: string,
  ): Promise<BookingChangeRequest | null> {
    const params = new URLSearchParams({ email });
    return pms.get(`/api/hotels/${slug}/bookings/${bookingId}/change-request?${params}`);
  },
};

export interface ChangeRequestPayload {
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  addonIds: string[];
  addonQuantities: Record<string, number>;
  addonDates: Record<string, string[]>;
}

export interface ChangeRequestPreview {
  oldTotal: number;
  newTotal: number;
  priceDifference: number;
  currency: string;
  blocked: boolean;
  blockReason: string | null;
  available: boolean;
}

export interface BookingChangeRequest {
  id: string;
  bookingId: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  oldCheckIn: string;
  oldCheckOut: string;
  oldAddonIds: string[];
  oldAddonQuantities: Record<string, number>;
  oldAddonDates: Record<string, string[]>;
  oldTotal: number;
  requestedCheckIn: string;
  requestedCheckOut: string;
  requestedAddonIds: string[];
  requestedAddonQuantities: Record<string, number>;
  requestedAddonDates: Record<string, string[]>;
  requestedAddonNames: string[];
  newTotal: number;
  priceDifference: number;
  currency: string;
  declineReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}
