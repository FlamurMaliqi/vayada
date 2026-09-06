import type { Hotel, RoomType } from "@/lib/types";

import { bookingWebPublic, type ApiRequestInit } from "./client";

const FALLBACK_IMAGE = "/vayada-logo.png";
export const PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS = 60;

export type BookingWebPublicHotelResponse = {
  hotel: {
    propertyId: string;
    slug: string;
    name: string;
    canonicalUrl: string;
    bookingBaseUrl: string;
    customDomainUrl: string | null;
    timezone: string;
    defaultLocale: string;
    supportedLocales: string[];
    defaultCurrency: string;
    supportedCurrencies: string[];
    location: {
      country: string;
      city: string;
      region: string | null;
      latitude: number | null;
      longitude: number | null;
    };
    summary: string | null;
    branding?: {
      logoUrl?: string | null;
      showContactButton?: boolean;
      showReferAGuestButton?: boolean;
      showLanguageSelector?: boolean;
      showCurrencySelector?: boolean;
      heroImage: string | null;
      heroHeading: string | null;
      heroSubtext: string | null;
      primaryColor: string | null;
      fontPairing: string | null;
    };
    images: Array<{ url: string; alt: string | null }>;
    amenities: string[];
    publicContacts?: Array<{
      type: "phone" | "email" | "whatsapp" | "website" | "instagram" | "facebook" | "x";
      value: string;
    }>;
    policies: {
      checkInFrom: string | null;
      checkOutUntil: string | null;
      cancellationSummary: string | null;
      termsUrl: string | null;
    };
    capabilities: {
      instantBook: boolean;
      onlinePayment: boolean;
      payAtProperty: boolean;
      promoCodes: boolean;
      referralCodes: boolean;
      bookingDeepLinks: boolean;
    };
    supportedQuoteParameters: {
      minRooms: number;
      maxRooms: number;
      minAdults: number;
      maxAdults: number;
      childrenSupported: boolean;
      adultAgeThreshold?: number;
      supportedCurrencies: string[];
      supportedLocales: string[];
    };
  };
};

export type BookingWebPublicOffer = {
  offerId: string;
  roomTypeId: string;
  ratePlanId: string | null;
  name: string;
  locationAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  occupancy: {
    maxAdults: number;
    maxChildren: number;
  };
  availableRooms: number;
  refundable: boolean;
  mealPlan: string | null;
  amenities?: string[];
  paymentOptions: string[];
  totals: {
    currency: string;
    promotion?: { name: string; discountAmount: number; discountPercent: number };
    roomTotal: number;
    taxesAndFees: number;
    discounts: number;
    grandTotal: number;
  };
  policies: {
    cancellation: string | null;
    deposit: string | null;
  };
  bookingUrl: string;
};

export type BookingWebPublicOffersResponse = {
  request: {
    nights: number;
    rooms: number;
  };
  status: "bookable" | "unavailable" | "stale";
  unavailableReasons?: Array<{ code: string }>;
  quote?: {
    offers: BookingWebPublicOffer[];
  };
};

export type BookingWebPublicCalendarResponse = {
  calendar: {
    unavailableDates: string[];
    minStayByArrival: Record<string, number>;
    validCheckOutsByArrival?: Record<string, string[]>;
    maxStayByArrival: Record<string, number>;
  };
  freshness?: {
    status: "fresh" | "stale" | "unavailable" | "unknown";
  };
};

export type BookingWebPublicHostResponse = {
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl: string | null;
  shouldRedirect: boolean;
  redirectUrl: string | null;
  redirectStatus: 308 | null;
  hotel: {
    slug: string;
    name: string;
    defaultLocale: string;
    supportedLocales: string[];
  };
};

export type BookingWebAffiliateRegistrationRequest = {
  fullName: string;
  email: string;
  socialMedia?: string;
  userType?: "guest" | "creator";
  paymentMethod?: "stripe" | "paypal" | "bank";
  paypalEmail?: string;
  bankIban?: string;
  bankAccountHolder?: string;
  bankSwiftBic?: string;
  bankName?: string;
  bankCountry?: string;
};

export type BookingWebAffiliateRegistrationResponse = {
  id: string;
  referralCode: string;
};

export type BookingWebAffiliateStripeConnectResponse = {
  onboardingUrl: string;
};

export const bookingWebPublicApi = {
  async resolveHost(host: string, init?: ApiRequestInit): Promise<BookingWebPublicHostResponse> {
    return bookingWebPublic.get<BookingWebPublicHostResponse>(
      `/api/booking-web/hosts/${encodeURIComponent(host)}`,
      init,
    );
  },

  async getHotel(
    slug: string,
    query: { locale?: string } = {},
  ): Promise<BookingWebPublicHotelResponse> {
    const params = new URLSearchParams();
    if (query.locale) params.set("locale", query.locale);
    const qs = params.toString();
    return bookingWebPublic.get<BookingWebPublicHotelResponse>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`,
    );
  },

  async getOffers(
    slug: string,
    query: {
      checkIn: string;
      checkOut: string;
      adults?: number;
      children?: number;
      rooms?: number;
      currency?: string;
      locale?: string;
    },
  ): Promise<BookingWebPublicOffersResponse> {
    const params = new URLSearchParams({
      check_in: query.checkIn,
      check_out: query.checkOut,
      rooms: String(query.rooms || 1),
    });
    if (query.adults) params.set("adults", String(query.adults));
    if (query.children !== undefined) params.set("children", String(query.children));
    if (query.currency) params.set("currency", query.currency);
    if (query.locale) params.set("locale", query.locale);
    return bookingWebPublic.get<BookingWebPublicOffersResponse>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/offers?${params.toString()}`,
    );
  },

  async getCalendar(
    slug: string,
    start: string,
    end: string,
  ): Promise<BookingWebPublicCalendarResponse> {
    const params = new URLSearchParams({ start, end });
    return bookingWebPublic.get<BookingWebPublicCalendarResponse>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/calendar?${params.toString()}`,
    );
  },
};

export const bookingWebAffiliateApi = {
  async checkEmail(slug: string, email: string): Promise<{ exists: boolean }> {
    const params = new URLSearchParams({ email });
    return bookingWebPublic.get<{ exists: boolean }>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/affiliates/check-email?${params.toString()}`,
    );
  },

  async register(
    slug: string,
    request: BookingWebAffiliateRegistrationRequest,
  ): Promise<BookingWebAffiliateRegistrationResponse> {
    return bookingWebPublic.post<BookingWebAffiliateRegistrationResponse>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/affiliates`,
      request,
    );
  },

  async createStripeConnectLink(
    slug: string,
    affiliateId: string,
    request: { email: string },
  ): Promise<BookingWebAffiliateStripeConnectResponse> {
    return bookingWebPublic.post<BookingWebAffiliateStripeConnectResponse>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/affiliates/${encodeURIComponent(
        affiliateId,
      )}/stripe/connect`,
      request,
    );
  },
};

export function toLegacyHotel(data: BookingWebPublicHotelResponse): Hotel {
  const hotel = data.hotel;
  const images = hotel.images.map((image) => image.url).filter(Boolean);
  const heroImage = hotel.branding?.heroImage || FALLBACK_IMAGE;
  const contacts = publicContactValues(hotel.publicContacts);
  const address = uniqueNonEmpty([
    hotel.location.city,
    hotel.location.region,
    hotel.location.country,
  ]).join(", ");

  return {
    id: hotel.propertyId,
    name: hotel.name,
    slug: hotel.slug,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    description: hotel.summary || "",
    location: [hotel.location.city, hotel.location.region].filter(Boolean).join(", "),
    country: hotel.location.country,
    starRating: 0,
    currency: hotel.defaultCurrency,
    supportedCurrencies: hotel.supportedCurrencies,
    heroImage,
    images,
    amenities: hotel.amenities,
    checkInTime: hotel.policies.checkInFrom || "",
    checkOutTime: hotel.policies.checkOutUntil || "",
    timezone: hotel.timezone,
    contact: {
      address,
      phone: contacts.phone || "",
      email: contacts.email || "",
      whatsapp: contacts.whatsapp || undefined,
      website: safePublicHttpUrl(contacts.website),
    },
    bookingFilters: [],
    customFilters: {},
    filterRooms: {},
    socialLinks: {
      instagram: safePublicHttpUrl(contacts.instagram),
      facebook: safePublicHttpUrl(contacts.facebook),
    },
    branding: hotel.branding
      ? {
          logoUrl: hotel.branding.logoUrl || undefined,
          heroImage: hotel.branding.heroImage || undefined,
          heroHeading: hotel.branding.heroHeading || undefined,
          heroSubtext: hotel.branding.heroSubtext || undefined,
          primaryColor: hotel.branding.primaryColor || undefined,
          fontPairing: hotel.branding.fontPairing || undefined,
        }
      : undefined,
    headerSettings: {
      showContactButton: hotel.branding?.showContactButton ?? true,
      showReferAGuestButton: hotel.branding?.showReferAGuestButton ?? false,
      showLanguageSelector: hotel.branding?.showLanguageSelector ?? true,
      showCurrencySelector: hotel.branding?.showCurrencySelector ?? true,
    },
    defaultLanguage: hotel.defaultLocale,
    supportedLanguages: hotel.supportedLocales,
    guestTypeSettings: {
      adultAgeThreshold: hotel.supportedQuoteParameters.adultAgeThreshold ?? 18,
      childrenEnabled: hotel.supportedQuoteParameters.childrenSupported,
    },
    referAGuestEnabled:
      hotel.capabilities.referralCodes && (hotel.branding?.showReferAGuestButton ?? false),
    instantBook: hotel.capabilities.instantBook,
  };
}

function publicContactValues(
  contacts: BookingWebPublicHotelResponse["hotel"]["publicContacts"],
): Partial<
  Record<
    NonNullable<BookingWebPublicHotelResponse["hotel"]["publicContacts"]>[number]["type"],
    string
  >
> {
  const values: Partial<
    Record<
      NonNullable<BookingWebPublicHotelResponse["hotel"]["publicContacts"]>[number]["type"],
      string
    >
  > = {};
  for (const contact of contacts ?? []) {
    const value = contact.value.trim();
    if (value && !values[contact.type]) values[contact.type] = value;
  }
  return values;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  );
}

function safePublicHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function toLegacyRooms(
  data: BookingWebPublicOffersResponse,
  displayRooms: RoomType[] = [],
): RoomType[] {
  const offers = data.quote?.offers || [];
  const grouped = new Map<string, BookingWebPublicOffer[]>();
  const displayRoomById = new Map(displayRooms.map((room) => [room.id, room]));
  for (const offer of offers) {
    const existing = grouped.get(offer.roomTypeId) || [];
    existing.push(offer);
    grouped.set(offer.roomTypeId, existing);
  }

  return Array.from(grouped.entries()).flatMap(([roomTypeId, roomOffers]) => {
    const firstOffer = roomOffers[0];
    if (!firstOffer) return [];
    const flexible = roomOffers.find((offer) => offer.refundable) || firstOffer;
    const nonRefundable = roomOffers.find((offer) => !offer.refundable) || null;
    const displayRoom = displayRoomById.get(roomTypeId);
    const nights = Math.max(data.request.nights || 1, 1);
    const rooms = Math.max(data.request.rooms || 1, 1);
    const baseRate = nightlyRoomRate(
      flexible.totals.roomTotal -
        flexible.totals.discounts +
        (flexible.totals.promotion?.discountAmount ?? 0),
      nights,
      rooms,
    );
    const nonRefundableRate = nonRefundable
      ? nightlyRoomRate(
          nonRefundable.totals.roomTotal -
            nonRefundable.totals.discounts +
            (nonRefundable.totals.promotion?.discountAmount ?? 0),
          nights,
          rooms,
        )
      : null;
    const maxAdults = flexible.occupancy.maxAdults;
    const maxChildren = flexible.occupancy.maxChildren;

    return {
      ...displayRoom,
      id: roomTypeId,
      name: displayRoom?.name || roomName(flexible.name),
      category: displayRoom?.category || "",
      locationAddress: displayRoom?.locationAddress ?? flexible.locationAddress ?? undefined,
      latitude: displayRoom?.latitude ?? flexible.latitude ?? null,
      longitude: displayRoom?.longitude ?? flexible.longitude ?? null,
      description: displayRoom?.description || flexible.policies.cancellation || flexible.name,
      shortDescription:
        displayRoom?.shortDescription ||
        flexible.mealPlan ||
        flexible.policies.cancellation ||
        flexible.name,
      maxOccupancy: Math.max(maxAdults + maxChildren, maxAdults, 1),
      maxAdults,
      maxChildren,
      size: displayRoom?.size || 0,
      baseRate,
      nonRefundableRate,
      promotion: flexible.totals.promotion
        ? {
            ...flexible.totals.promotion,
            discountAmount: flexible.totals.promotion.discountAmount / rooms,
          }
        : undefined,
      nonRefundablePromotion: nonRefundable?.totals.promotion
        ? {
            ...nonRefundable.totals.promotion,
            discountAmount: nonRefundable.totals.promotion.discountAmount / rooms,
          }
        : undefined,
      nightlyRates: Array.from({ length: nights }, () => baseRate),
      nonRefundableNightlyRates:
        nonRefundableRate === null
          ? undefined
          : Array.from({ length: nights }, () => nonRefundableRate),
      currency: flexible.totals.currency,
      amenities:
        flexible.amenities !== undefined
          ? flexible.amenities
          : displayRoom?.amenities?.length
            ? displayRoom.amenities
            : flexible.mealPlan
              ? [flexible.mealPlan]
              : [],
      images: displayRoom?.images?.length ? displayRoom.images : [FALLBACK_IMAGE],
      bedType: displayRoom?.bedType || "",
      remainingRooms: Math.max(0, flexible.availableRooms),
      features: displayRoom?.features || [],
      benefits: displayRoom?.benefits || [],
      flexibleRateEnabled: Boolean(roomOffers.find((offer) => offer.refundable)),
      cancellationPolicy: flexible.policies.cancellation || undefined,
      ratePaymentMethods: {
        flexible: flexible.paymentOptions,
        ...(nonRefundable ? { nonrefundable: nonRefundable.paymentOptions } : {}),
      },
      rateDepositSettings: {
        flexible: depositSettings(flexible.policies.deposit),
        ...(nonRefundable
          ? { nonrefundable: depositSettings(nonRefundable.policies.deposit) }
          : {}),
      },
    };
  });
}

export function toLegacyCalendar(data: BookingWebPublicCalendarResponse): {
  dates: string[];
  minStayByArrival: Record<string, number>;
  validCheckOutsByArrival?: Record<string, string[]>;
  maxStayByArrival: Record<string, number>;
  availabilityUnavailable: boolean;
} {
  const unavailableDates = new Set(data.calendar.unavailableDates);
  const hasSelectableCoverage = Object.keys(data.calendar.minStayByArrival).some(
    (date) => !unavailableDates.has(date),
  );

  return {
    dates: data.calendar.unavailableDates,
    ...(data.calendar.validCheckOutsByArrival && {
      validCheckOutsByArrival: data.calendar.validCheckOutsByArrival,
    }),
    minStayByArrival: data.calendar.minStayByArrival,
    maxStayByArrival: data.calendar.maxStayByArrival,
    availabilityUnavailable: data.freshness?.status === "unavailable" && !hasSelectableCoverage,
  };
}

export function defaultOfferDates(): { checkIn: string; checkOut: string } {
  const today = new Date();
  const checkIn = new Date(today);
  checkIn.setDate(today.getDate() + 1);
  const checkOut = new Date(today);
  checkOut.setDate(today.getDate() + 2);
  return {
    checkIn: checkIn.toISOString().slice(0, 10),
    checkOut: checkOut.toISOString().slice(0, 10),
  };
}

function nightlyRoomRate(total: number, nights: number, rooms: number): number {
  return Math.round((total / Math.max(nights * rooms, 1)) * 100) / 100;
}

function roomName(value: string): string {
  return value.replace(/\s+-\s+Non-refundable$/i, "");
}

function depositSettings(summary: string | null): { enabled: boolean; percentage: number | null } {
  if (!summary || /no deposit/i.test(summary)) {
    return { enabled: false, percentage: null };
  }
  // TODO: Replace summary parsing when the public API exposes structured deposit settings.
  const percentage = summary.match(/(\d+(?:\.\d+)?)\s*%/i);
  return {
    enabled: true,
    percentage: percentage ? Number(percentage[1]) : null,
  };
}
