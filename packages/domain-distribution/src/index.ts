export const PUBLIC_BOOKABILITY_CONTRACT_VERSION = "public-bookability.v1" as const;
export const PUBLIC_BOOKABILITY_VISIBILITY = "public_safe" as const;

export const PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS = [
  "hotel_catalog",
  "booking",
  "pms",
  "finance",
  "distribution",
] as const;

export const PUBLIC_BOOKABILITY_STATUSES = ["bookable", "unavailable", "stale", "error"] as const;

export const PUBLIC_BOOKABILITY_REASON_CODES = [
  "sold_out",
  "payment_disabled",
  "min_stay_not_met",
  "max_stay_exceeded",
  "same_day_cutoff_passed",
  "unsupported_occupancy",
  "occupancy_unavailable",
  "unpublished",
  "policy_missing",
  "stale_data",
  "unavailable_data",
  "invalid_request",
  "currency_not_supported",
  "locale_not_supported",
  "promo_not_applicable",
] as const;

export const PUBLIC_BOOKABILITY_FRESHNESS_STATUSES = [
  "fresh",
  "stale",
  "unavailable",
  "unknown",
] as const;

export const PUBLIC_BOOKABILITY_CONTACT_CHANNEL_TYPES = [
  "phone",
  "email",
  "whatsapp",
  "website",
  "instagram",
  "facebook",
  "x",
] as const;

export const FORBIDDEN_PUBLIC_BOOKABILITY_KEYS = [
  "admin",
  "bank",
  "channex",
  "credential",
  "database",
  "guestEmail",
  "guestName",
  "guestPhone",
  "housekeeping",
  "internal",
  "maintenance",
  "bookingNotesPrivate",
  "booking_notes_private",
  "privateNote",
  "privateNoteAuthor",
  "privateNoteBody",
  "privateNoteCount",
  "privateNoteId",
  "private_note",
  "notesPrivate",
  "payout",
  "processorAccount",
  "providerAccount",
  "secret",
  "webhookPayload",
] as const;

export type PublicBookabilityContractVersion = typeof PUBLIC_BOOKABILITY_CONTRACT_VERSION;
export type PublicBookabilityVisibility = typeof PUBLIC_BOOKABILITY_VISIBILITY;
export type PublicBookabilityDataSourceOwner =
  (typeof PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS)[number];
export type PublicBookabilityStatus = (typeof PUBLIC_BOOKABILITY_STATUSES)[number];
export type PublicBookabilityReasonCode = (typeof PUBLIC_BOOKABILITY_REASON_CODES)[number];
export type PublicBookabilityFreshnessStatus =
  (typeof PUBLIC_BOOKABILITY_FRESHNESS_STATUSES)[number];
export type PublicBookabilityContactChannelType =
  (typeof PUBLIC_BOOKABILITY_CONTACT_CHANNEL_TYPES)[number];

export type PublicBookabilityPublicationStatus =
  | "public"
  | "incomplete"
  | "unpublished"
  | "stale"
  | "unavailable";

export type PublishPublicBookabilityProfileCommand = {
  propertyId: string;
};

export type PublicBookabilityPublicationResult = {
  propertyId: string;
  canonicalSlug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  profileStatus: PublicBookabilityPublicationStatus;
  freshnessStatus: PublicBookabilityFreshnessStatus;
  missingReadiness: string[];
};

/**
 * Distribution-owned command boundary used by product activation flows.
 * Callers identify the canonical property; the implementation projects only
 * public-safe catalog, Booking, Finance, and Distribution read models.
 */
export interface PublicBookabilityPublicationCommandPort {
  publish(
    command: PublishPublicBookabilityProfileCommand,
  ): Promise<PublicBookabilityPublicationResult | null>;
  close?(): Promise<void>;
}

export type ProjectPmsInventoryToPublicOffersCommand = {
  propertyId: string;
};

export type PmsInventoryPublicOfferProjectionResult = {
  profileAvailable: boolean;
  pendingEvents: number;
  projectedOfferDays: number;
};

/**
 * Distribution-owned consumer for durable PMS inventory events. The consumer
 * projects public-safe room offers without exposing PMS tables to public reads.
 */
export interface PmsInventoryPublicOfferProjectionPort {
  projectPending(
    command: ProjectPmsInventoryToPublicOffersCommand,
  ): Promise<PmsInventoryPublicOfferProjectionResult>;
  close?(): Promise<void>;
}

export type PublicBookabilityFreshnessSource = {
  owner: PublicBookabilityDataSourceOwner;
  lastUpdatedAt?: string;
  status: PublicBookabilityFreshnessStatus;
  reasonCode?: "source_unavailable" | "source_stale" | "not_configured";
};

export type PublicBookabilityProducerFreshnessInput = {
  lastUpdatedAt?: string;
  status?: PublicBookabilityFreshnessStatus;
  reasonCode?: PublicBookabilityFreshnessSource["reasonCode"];
};

export type PublicBookabilityProducerSourceInput = {
  lastUpdatedAt?: string;
  freshness?: PublicBookabilityProducerFreshnessInput;
};

export type PublicBookabilityFreshness = {
  status: PublicBookabilityFreshnessStatus;
  generatedAt: string;
  sources: PublicBookabilityFreshnessSource[];
};

export type PublicBookabilityLocation = {
  country: string;
  city: string;
  region?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type PublicBookabilityImage = {
  url: string;
  alt?: string | null;
};

export type PublicBookabilityPublicContact = {
  type: PublicBookabilityContactChannelType;
  value: string;
};

export type PublicBookabilityPolicies = {
  checkInFrom?: string | null;
  checkInUntil?: string | null;
  checkOutFrom?: string | null;
  checkOutUntil?: string | null;
  cancellationSummary?: string | null;
  termsUrl?: string | null;
};

export type PublicBookabilityCapabilities = {
  instantBook: boolean;
  onlinePayment: boolean;
  payAtProperty: boolean;
  promoCodes: boolean;
  referralCodes: boolean;
  bookingDeepLinks: boolean;
};

export type PublicBookabilitySupportedQuoteParameters = {
  minRooms: number;
  maxRooms: number;
  minAdults: number;
  maxAdults: number;
  childrenSupported: boolean;
  adultAgeThreshold: number;
  supportedCurrencies: string[];
  supportedLocales: string[];
};

export type PublicBookabilityBranding = {
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

export type PublicBookabilityHotelProfile = {
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
  location: PublicBookabilityLocation;
  summary?: string | null;
  branding?: PublicBookabilityBranding;
  images: PublicBookabilityImage[];
  amenities: string[];
  publicContacts: PublicBookabilityPublicContact[];
  policies: PublicBookabilityPolicies;
  capabilities: PublicBookabilityCapabilities;
  supportedQuoteParameters: PublicBookabilitySupportedQuoteParameters;
  trust: {
    profileComplete: boolean;
    profileVerified: boolean;
    domainVerified: boolean;
    bookabilityStatus: PublicBookabilityStatus;
    reasonCodes: PublicBookabilityReasonCode[];
  };
};

export type PublicBookabilityProfileProjection = {
  contractVersion: PublicBookabilityContractVersion;
  generatedAt: string;
  publicVisibility: PublicBookabilityVisibility;
  hotel: PublicBookabilityHotelProfile;
  freshness: PublicBookabilityFreshness;
  dataSources: PublicBookabilityDataSourceOwner[];
};

export type PublicBookabilityQuoteRequest = {
  hotelSlug: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  rooms: number;
  currency: string;
  locale: string;
  promoCode?: string | null;
  referralCode?: string | null;
};

export type PublicBookabilityMoneyTotals = {
  promotion?: { name: string; discountAmount: number; discountPercent: number };
  currency: string;
  roomTotal: number;
  taxesAndFees: number;
  discounts: number;
  grandTotal: number;
};

/** Public projection of Booking's versioned selection; contains no inventory receipt data. */
export type PublicBookabilityRoomSelection = {
  contractVersion: "booking-room-selection.v1";
  lines: readonly {
    roomTypeId: string;
    publicOfferKey: string;
    guests: readonly { adults: number; children: number }[];
  }[];
};
export type PublicBookabilityRoomLine = PublicBookabilityRoomSelection["lines"][number] & {
  roomName: string;
  roomCount: number;
  ratePlanId: string | null;
  rateSummary: Record<string, unknown>;
  policy: Record<string, unknown>;
  totals: Record<string, string>;
};

export type PublicBookabilityOffer = {
  roomSelection?: PublicBookabilityRoomSelection;
  roomLines?: PublicBookabilityRoomLine[];
  expiresAt?: string;
  offerId: string;
  roomTypeId: string;
  ratePlanId?: string | null;
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
  mealPlan?: string | null;
  amenities: string[];
  paymentOptions: Array<"card" | "pay_at_property" | "bank_transfer" | "paypal">;
  totals: PublicBookabilityMoneyTotals;
  policies: {
    cancellation?: string | null;
    deposit?: string | null;
  };
  bookingUrl: string;
};

export type PublicBookabilityAvailabilityOfferInput = {
  offerId: string;
  roomTypeId: string;
  ratePlanId?: string | null;
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
  mealPlan?: string | null;
  amenities?: string[];
  paymentOptions?: PublicBookabilityOffer["paymentOptions"];
  totals: PublicBookabilityMoneyTotals;
};

export type PublicBookabilityBookingOfferPolicyInput = {
  roomTypeId: string;
  ratePlanId?: string | null;
  cancellation?: string | null;
  deposit?: string | null;
};

export type PublicBookabilityDeepLink = {
  url: string;
  expiresAt?: string | null;
  preserves: Array<
    | "dates"
    | "guests"
    | "rooms"
    | "currency"
    | "locale"
    | "promo_code"
    | "referral_code"
    | "quote_id"
  >;
};

export type PublicBookabilityUnavailableReason = {
  code: PublicBookabilityReasonCode;
  detail?: string;
};

export type PublicBookabilityQuoteProjection = {
  contractVersion: PublicBookabilityContractVersion;
  generatedAt: string;
  publicVisibility: PublicBookabilityVisibility;
  request: PublicBookabilityQuoteRequest;
  status: PublicBookabilityStatus;
  unavailableReasons: PublicBookabilityUnavailableReason[];
  quote?: {
    quoteId: string;
    quoteHash: string;
    expiresAt: string;
    priceGuarantee: "expires_at" | "none";
    offers: PublicBookabilityOffer[];
  };
  deepLink?: PublicBookabilityDeepLink;
  freshness: PublicBookabilityFreshness;
  dataSources: PublicBookabilityDataSourceOwner[];
};

export type PublicBookabilityProducerInputs = {
  hotelCatalog: Pick<
    PublicBookabilityHotelProfile,
    | "propertyId"
    | "slug"
    | "name"
    | "timezone"
    | "defaultLocale"
    | "supportedLocales"
    | "location"
    | "summary"
    | "images"
    | "amenities"
  > & {
    publicContacts?: PublicBookabilityPublicContact[];
    profileComplete: boolean;
    profileVerified: boolean;
  } & PublicBookabilityProducerSourceInput;
  booking: PublicBookabilityProducerSourceInput & {
    branding?: PublicBookabilityBranding;
    policies: PublicBookabilityPolicies;
    capabilities: Pick<
      PublicBookabilityCapabilities,
      "instantBook" | "promoCodes" | "referralCodes"
    >;
    supportedQuoteParameters: PublicBookabilitySupportedQuoteParameters;
  };
  pms: PublicBookabilityProducerSourceInput & {
    availabilityReady: boolean;
  };
  finance: PublicBookabilityProducerSourceInput & {
    defaultCurrency: string;
    supportedCurrencies: string[];
    onlinePayment: boolean;
    payAtProperty: boolean;
  };
  bookingWeb: {
    canonicalUrl: string;
    bookingBaseUrl: string;
    customDomainUrl: string | null;
    domainVerified: boolean;
    bookingDeepLinks: boolean;
  };
};

export type PublicBookabilityQuoteProducerInputs = {
  request: PublicBookabilityQuoteRequest;
  hotelCatalog: PublicBookabilityProducerSourceInput;
  booking: PublicBookabilityProducerSourceInput & {
    offerPolicies: PublicBookabilityBookingOfferPolicyInput[];
  };
  pms: PublicBookabilityProducerSourceInput & {
    availabilityReady: boolean;
    offers: PublicBookabilityAvailabilityOfferInput[];
    unavailableReasons?: PublicBookabilityUnavailableReason[];
  };
  finance: PublicBookabilityProducerSourceInput & {
    publicPaymentOptions: PublicBookabilityOffer["paymentOptions"];
    supportedCurrencies: string[];
  };
  bookingWeb: {
    offerBookingUrlBase: string;
    deepLink?: PublicBookabilityDeepLink | null;
  };
  quote: {
    quoteId: string;
    quoteHash: string;
    expiresAt: string;
    priceGuarantee: "expires_at" | "none";
  };
};

export function buildPublicBookabilityProfileProjection(
  generatedAt: string,
  inputs: PublicBookabilityProducerInputs,
): PublicBookabilityProfileProjection {
  const capabilities: PublicBookabilityCapabilities = {
    instantBook: inputs.booking.capabilities.instantBook,
    onlinePayment: inputs.finance.onlinePayment,
    payAtProperty: inputs.finance.payAtProperty,
    promoCodes: inputs.booking.capabilities.promoCodes,
    referralCodes: inputs.booking.capabilities.referralCodes,
    bookingDeepLinks: inputs.bookingWeb.bookingDeepLinks,
  };
  const hasPublicPaymentMethod = capabilities.onlinePayment || capabilities.payAtProperty;
  const bookabilityReasonCodes: PublicBookabilityReasonCode[] = [];

  if (!inputs.pms.availabilityReady) {
    bookabilityReasonCodes.push("unavailable_data");
  }
  if (!hasPublicPaymentMethod) {
    bookabilityReasonCodes.push("payment_disabled");
  }

  const sources = [
    sourceFreshness("hotel_catalog", inputs.hotelCatalog),
    sourceFreshness("booking", inputs.booking),
    sourceFreshness("pms", inputs.pms, inputs.pms.availabilityReady),
    sourceFreshness("finance", inputs.finance),
    sourceFreshness("distribution", { lastUpdatedAt: generatedAt }),
  ];

  const projection: PublicBookabilityProfileProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    hotel: {
      propertyId: inputs.hotelCatalog.propertyId,
      slug: inputs.hotelCatalog.slug,
      name: inputs.hotelCatalog.name,
      canonicalUrl: inputs.bookingWeb.canonicalUrl,
      bookingBaseUrl: inputs.bookingWeb.bookingBaseUrl,
      customDomainUrl: inputs.bookingWeb.customDomainUrl,
      timezone: inputs.hotelCatalog.timezone,
      defaultLocale: inputs.hotelCatalog.defaultLocale,
      supportedLocales: copyStrings(inputs.hotelCatalog.supportedLocales),
      defaultCurrency: inputs.finance.defaultCurrency,
      supportedCurrencies: copyStrings(inputs.finance.supportedCurrencies),
      location: sanitizeLocation(inputs.hotelCatalog.location),
      summary: inputs.hotelCatalog.summary,
      branding: inputs.booking.branding ? { ...inputs.booking.branding } : undefined,
      images: inputs.hotelCatalog.images.map(sanitizeImage),
      amenities: copyStrings(inputs.hotelCatalog.amenities),
      publicContacts: sanitizePublicContacts(inputs.hotelCatalog.publicContacts),
      policies: sanitizePolicies(inputs.booking.policies),
      capabilities,
      supportedQuoteParameters: sanitizeSupportedQuoteParameters(
        inputs.booking.supportedQuoteParameters,
      ),
      trust: {
        profileComplete: inputs.hotelCatalog.profileComplete,
        profileVerified: inputs.hotelCatalog.profileVerified,
        domainVerified: inputs.bookingWeb.domainVerified,
        bookabilityStatus: bookabilityReasonCodes.length === 0 ? "bookable" : "unavailable",
        reasonCodes: bookabilityReasonCodes,
      },
    },
    freshness: {
      status: rollupFreshnessStatus(sources),
      generatedAt,
      sources,
    },
    dataSources: [...PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS],
  };

  assertPublicBookabilityPublicSafe(projection);
  return projection;
}

export function buildPublicBookabilityQuoteProjection(
  generatedAt: string,
  inputs: PublicBookabilityQuoteProducerInputs,
): PublicBookabilityQuoteProjection {
  const sources = [
    sourceFreshness("hotel_catalog", inputs.hotelCatalog),
    sourceFreshness("booking", inputs.booking),
    sourceFreshness("pms", inputs.pms, inputs.pms.availabilityReady),
    sourceFreshness("finance", inputs.finance),
    sourceFreshness("distribution", { lastUpdatedAt: generatedAt }),
  ];
  const freshnessStatus = rollupFreshnessStatus(sources);
  const publicPaymentOptions = new Set(inputs.finance.publicPaymentOptions);
  const offers = inputs.pms.offers
    .map((offer) =>
      sanitizeOffer(
        offer,
        findOfferPolicy(offer, inputs.booking.offerPolicies),
        new Set(
          (offer.paymentOptions ?? inputs.finance.publicPaymentOptions).filter((option) =>
            publicPaymentOptions.has(option),
          ),
        ),
        buildOfferBookingUrl(
          inputs.bookingWeb.offerBookingUrlBase,
          inputs.request,
          offer,
          inputs.quote.quoteId,
        ),
      ),
    )
    .filter((offer) => offer.paymentOptions.length > 0);
  const unavailableReasons = buildQuoteUnavailableReasons(inputs, freshnessStatus, offers);
  const status: PublicBookabilityStatus =
    unavailableReasons.length > 0
      ? freshnessStatus === "stale" &&
        unavailableReasons.every((reason) => reason.code === "stale_data")
        ? "stale"
        : "unavailable"
      : "bookable";

  const projection: PublicBookabilityQuoteProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    request: sanitizeQuoteRequest(inputs.request),
    status,
    unavailableReasons,
    quote:
      status === "bookable"
        ? {
            quoteId: inputs.quote.quoteId,
            quoteHash: inputs.quote.quoteHash,
            expiresAt: inputs.quote.expiresAt,
            priceGuarantee: inputs.quote.priceGuarantee,
            offers,
          }
        : undefined,
    deepLink:
      status === "bookable" && inputs.bookingWeb.deepLink
        ? sanitizeDeepLink(inputs.bookingWeb.deepLink)
        : undefined,
    freshness: {
      status: freshnessStatus,
      generatedAt,
      sources,
    },
    dataSources: [...PUBLIC_BOOKABILITY_DATA_SOURCE_OWNERS],
  };

  assertPublicBookabilityPublicSafe(projection);
  return projection;
}

export function findForbiddenPublicBookabilityKeys(value: unknown): string[] {
  const matches = new Set<string>();
  visitPublicBookabilityValue(value, (key) => {
    if (
      FORBIDDEN_PUBLIC_BOOKABILITY_KEYS.some((forbidden) => key.includes(forbidden.toLowerCase()))
    ) {
      matches.add(key);
    }
  });
  return [...matches].sort();
}

export function assertPublicBookabilityPublicSafe(value: unknown): void {
  const forbiddenKeys = findForbiddenPublicBookabilityKeys(value);
  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Public bookability projection contains private keys: ${forbiddenKeys.join(", ")}`,
    );
  }
}

function sourceFreshness(
  owner: PublicBookabilityDataSourceOwner,
  source: PublicBookabilityProducerSourceInput,
  ready = true,
): PublicBookabilityFreshnessSource {
  const lastUpdatedAt = source.freshness?.lastUpdatedAt ?? source.lastUpdatedAt;
  const status = ready
    ? (source.freshness?.status ?? (lastUpdatedAt ? "fresh" : "unknown"))
    : "unavailable";
  const reasonCode =
    (ready ? source.freshness?.reasonCode : undefined) ??
    (status === "unavailable"
      ? "source_unavailable"
      : status === "stale"
        ? "source_stale"
        : status === "unknown"
          ? "not_configured"
          : undefined);

  return {
    owner,
    lastUpdatedAt,
    status,
    reasonCode,
  };
}

function rollupFreshnessStatus(
  sources: PublicBookabilityFreshnessSource[],
): PublicBookabilityFreshnessStatus {
  if (sources.some((source) => source.status === "unavailable")) return "unavailable";
  if (sources.some((source) => source.status === "stale")) return "stale";
  if (sources.some((source) => source.status === "unknown")) return "unknown";
  return "fresh";
}

function buildQuoteUnavailableReasons(
  inputs: PublicBookabilityQuoteProducerInputs,
  freshnessStatus: PublicBookabilityFreshnessStatus,
  offers: PublicBookabilityOffer[],
): PublicBookabilityUnavailableReason[] {
  const reasons = [...(inputs.pms.unavailableReasons ?? []).map(sanitizeUnavailableReason)];

  if (freshnessStatus === "stale") {
    reasons.push({ code: "stale_data", detail: "One or more producer sources are stale." });
  }
  if (freshnessStatus === "unavailable") {
    reasons.push({
      code: "unavailable_data",
      detail: "One or more producer sources are unavailable.",
    });
  }
  if (!inputs.finance.supportedCurrencies.includes(inputs.request.currency)) {
    reasons.push({ code: "currency_not_supported" });
  }
  if (inputs.finance.publicPaymentOptions.length === 0) {
    reasons.push({ code: "payment_disabled" });
  }
  if (!inputs.pms.availabilityReady) {
    reasons.push({ code: "unavailable_data", detail: "Availability source is unavailable." });
  }
  if (
    inputs.pms.availabilityReady &&
    offers.length === 0 &&
    !reasons.some((reason) =>
      [
        "min_stay_not_met",
        "max_stay_exceeded",
        "same_day_cutoff_passed",
        "unsupported_occupancy",
        "occupancy_unavailable",
        "unpublished",
        "policy_missing",
      ].includes(reason.code),
    )
  ) {
    reasons.push({ code: "sold_out" });
  }

  return dedupeUnavailableReasons(reasons);
}

function dedupeUnavailableReasons(
  reasons: PublicBookabilityUnavailableReason[],
): PublicBookabilityUnavailableReason[] {
  const seen = new Set<PublicBookabilityReasonCode>();
  return reasons.filter((reason) => {
    if (seen.has(reason.code)) return false;
    seen.add(reason.code);
    return true;
  });
}

function sanitizeQuoteRequest(
  request: PublicBookabilityQuoteRequest,
): PublicBookabilityQuoteRequest {
  return {
    hotelSlug: request.hotelSlug,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    nights: request.nights,
    adults: request.adults,
    children: request.children,
    rooms: request.rooms,
    currency: request.currency,
    locale: request.locale,
    promoCode: request.promoCode ?? null,
    referralCode: request.referralCode ?? null,
  };
}

function sanitizeLocation(location: PublicBookabilityLocation): PublicBookabilityLocation {
  return {
    country: location.country,
    city: location.city,
    region: location.region ?? null,
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
  };
}

function sanitizeImage(image: PublicBookabilityImage): PublicBookabilityImage {
  return {
    url: image.url,
    alt: image.alt ?? null,
  };
}

function sanitizePublicContacts(
  contacts: PublicBookabilityPublicContact[] | undefined,
): PublicBookabilityPublicContact[] {
  return (contacts ?? [])
    .filter(
      (contact) =>
        PUBLIC_BOOKABILITY_CONTACT_CHANNEL_TYPES.includes(contact.type) &&
        typeof contact.value === "string" &&
        contact.value.trim().length > 0,
    )
    .map((contact) => ({ type: contact.type, value: contact.value.trim() }));
}

function sanitizePolicies(policies: PublicBookabilityPolicies): PublicBookabilityPolicies {
  return {
    checkInFrom: policies.checkInFrom ?? null,
    checkOutUntil: policies.checkOutUntil ?? null,
    ...(policies.checkInUntil ? { checkInUntil: policies.checkInUntil } : {}),
    ...(policies.checkOutFrom ? { checkOutFrom: policies.checkOutFrom } : {}),
    cancellationSummary: policies.cancellationSummary ?? null,
    termsUrl: policies.termsUrl ?? null,
  };
}

function sanitizeSupportedQuoteParameters(
  parameters: PublicBookabilitySupportedQuoteParameters,
): PublicBookabilitySupportedQuoteParameters {
  return {
    minRooms: parameters.minRooms,
    maxRooms: parameters.maxRooms,
    minAdults: parameters.minAdults,
    maxAdults: parameters.maxAdults,
    childrenSupported: parameters.childrenSupported,
    adultAgeThreshold: parameters.adultAgeThreshold,
    supportedCurrencies: copyStrings(parameters.supportedCurrencies),
    supportedLocales: copyStrings(parameters.supportedLocales),
  };
}

function sanitizeOffer(
  offer: PublicBookabilityAvailabilityOfferInput,
  policy: PublicBookabilityBookingOfferPolicyInput | undefined,
  allowedPaymentOptions: Set<PublicBookabilityOffer["paymentOptions"][number]>,
  bookingUrl: string,
): PublicBookabilityOffer {
  return {
    offerId: offer.offerId,
    roomTypeId: offer.roomTypeId,
    ratePlanId: offer.ratePlanId ?? null,
    name: offer.name,
    locationAddress: offer.locationAddress ?? null,
    latitude: offer.latitude ?? null,
    longitude: offer.longitude ?? null,
    occupancy: {
      maxAdults: offer.occupancy.maxAdults,
      maxChildren: offer.occupancy.maxChildren,
    },
    availableRooms: offer.availableRooms,
    refundable: offer.refundable,
    mealPlan: offer.mealPlan ?? null,
    amenities: copyStrings(offer.amenities ?? []),
    paymentOptions: [...allowedPaymentOptions],
    totals: {
      currency: offer.totals.currency,
      roomTotal: offer.totals.roomTotal,
      taxesAndFees: offer.totals.taxesAndFees,
      discounts: offer.totals.discounts,
      grandTotal: offer.totals.grandTotal,
      ...(offer.totals.promotion
        ? {
            promotion: {
              name: offer.totals.promotion.name,
              discountAmount: offer.totals.promotion.discountAmount,
              discountPercent: offer.totals.promotion.discountPercent,
            },
          }
        : {}),
    },
    policies: {
      cancellation: policy?.cancellation ?? null,
      deposit: policy?.deposit ?? null,
    },
    bookingUrl,
  };
}

function findOfferPolicy(
  offer: PublicBookabilityAvailabilityOfferInput,
  policies: PublicBookabilityBookingOfferPolicyInput[],
): PublicBookabilityBookingOfferPolicyInput | undefined {
  return (
    policies.find(
      (policy) =>
        policy.roomTypeId === offer.roomTypeId &&
        (policy.ratePlanId ?? null) === (offer.ratePlanId ?? null),
    ) ?? policies.find((policy) => policy.roomTypeId === offer.roomTypeId && !policy.ratePlanId)
  );
}

function buildOfferBookingUrl(
  offerBookingUrlBase: string,
  request: PublicBookabilityQuoteRequest,
  offer: PublicBookabilityAvailabilityOfferInput,
  quoteId: string,
): string {
  const parameters = new URLSearchParams({
    check_in: request.checkIn,
    check_out: request.checkOut,
    adults: String(request.adults),
    children: String(request.children),
    rooms: String(request.rooms),
    room_type: offer.roomTypeId,
    currency: request.currency,
    locale: request.locale,
    quote_id: quoteId,
  });

  if (offer.ratePlanId) parameters.set("rate_plan", offer.ratePlanId);
  if (request.promoCode) parameters.set("promo_code", request.promoCode);
  if (request.referralCode) parameters.set("referral_code", request.referralCode);

  return `${offerBookingUrlBase}?${parameters.toString()}`;
}

function sanitizeDeepLink(deepLink: PublicBookabilityDeepLink): PublicBookabilityDeepLink {
  return {
    url: deepLink.url,
    expiresAt: deepLink.expiresAt ?? null,
    preserves: [...deepLink.preserves],
  };
}

function sanitizeUnavailableReason(
  reason: PublicBookabilityUnavailableReason,
): PublicBookabilityUnavailableReason {
  return {
    code: reason.code,
    detail: reason.detail,
  };
}

function copyStrings(values: string[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function visitPublicBookabilityValue(value: unknown, visitKey: (key: string) => void): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) visitPublicBookabilityValue(item, visitKey);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    visitKey(key.toLowerCase());
    visitPublicBookabilityValue(child, visitKey);
  }
}

export { calendarStays, type CalendarStayDay } from "./calendarStays.js";
