import { Hotel, RoomType, Addon } from "@/lib/types";
import { bookingWebPublic } from "./client";
import {
  bookingWebPublicApi,
  defaultOfferDates,
  toLegacyCalendar,
  toLegacyHotel,
  toLegacyRooms,
} from "./bookingWebPublic";
import { getBookingWebSessionId } from "./session";

export const hotelService = {
  async getHotel(slug: string, locale: string = "en"): Promise<Hotel> {
    return toLegacyHotel(await bookingWebPublicApi.getHotel(slug, { locale }));
  },

  async recordAffiliateClick(slug: string, referralCode: string): Promise<void> {
    try {
      await fetch(
        `${bookingWebPublic.baseURL}/api/booking-web/hotels/${encodeURIComponent(slug)}/attribution/clicks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            referralCode,
            sessionId: getBookingWebSessionId(),
            landingUrl: typeof window === "undefined" ? undefined : window.location.href,
            referrer: typeof document === "undefined" ? undefined : document.referrer,
          }),
          keepalive: true,
        },
      );
    } catch {
      // Click tracking is best-effort — never block UX on it.
    }
  },

  async getRooms(
    slug: string,
    checkIn?: string,
    checkOut?: string,
    adults?: number,
    children?: number,
    locale?: string,
  ): Promise<RoomType[]> {
    const dates = checkIn && checkOut ? { checkIn, checkOut } : defaultOfferDates();
    const data = await bookingWebPublicApi.getOffers(slug, {
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
      adults,
      children,
      rooms: 1,
      locale,
    });
    return toLegacyRooms(data);
  },

  async getAddons(slug: string): Promise<Addon[]> {
    const config = await bookingWebPublic.get<{ addons: Addon[] }>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/checkout-config`,
    );
    return config.addons ?? [];
  },

  async getUnavailableDates(
    slug: string,
    start: string,
    end: string,
  ): Promise<{
    dates: string[];
    minStayByArrival: Record<string, number>;
    validCheckOutsByArrival?: Record<string, string[]>;
    maxStayByArrival: Record<string, number>;
    availabilityUnavailable: boolean;
  }> {
    return toLegacyCalendar(await bookingWebPublicApi.getCalendar(slug, start, end));
  },

  async validatePromoCode(
    slug: string,
    code: string,
    context: {
      checkIn?: string;
      roomTypeId?: string;
      bookingTotal?: number;
    } = {},
  ): Promise<{
    valid: boolean;
    code: string;
    discountType?: string;
    discountValue?: number;
    currency?: string;
    message: string;
  }> {
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/promo/validate`,
      { code, ...context },
    );
  },
};
