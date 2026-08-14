import {
  assertPublicBookabilityPublicSafe,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityDataSourceOwner,
  type PublicBookabilityFreshness,
  type PublicBookabilityFreshnessSource,
  type PublicBookabilityFreshnessStatus,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityProfileProjection,
  type PublicBookabilityQuoteProjection,
} from "@vayada/domain-distribution";
import { parseBookingFlexibleCancellationTerms } from "@vayada/domain-booking";
import type { BillingConfigReadModel, BillingConfigReadPort } from "@vayada/domain-finance";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  StripeBookingPaymentIntent,
  StripeBookingPaymentProvider,
} from "../domains/stripeBookingPayments.js";
import {
  authorizeStripeBookingPayment,
  captureDirectNightlyRevenueEvidence,
  pmsCreateJobKey,
  reconcileStripeBookingPaymentProviderDetails,
  settleStripeBookingPayment,
  targetNightlyRoomAmounts,
} from "../domains/stripeBookingSettlement.js";
import {
  stripeAmountDecimal,
  stripeAmountMinor,
  stripeApplicationFeeMinor,
} from "../domains/stripeMoney.js";
import {
  bankTransferDetailsFromPolicy,
  enqueueBookingTransitionNotifications,
} from "../jobs/bookingEmails.js";
import {
  inventoryReservationReceiptFromBookingMetadata,
  type DirectBookingInventoryReservationPort,
} from "../platform/inventoryReservation.js";
import {
  serializePublicHotelQuoteProjection,
  type PublicHotelQuoteQuery,
  type PublicHotelQuoteRepository,
} from "./aiHotelQuotes.js";
import {
  serializePublicHotelProfileProjection,
  type PublicHotelProfileRepository,
} from "./aiHotels.js";
import {
  registerBookingWebAffiliateRoutes,
  type BookingWebAffiliateHotelResolver,
  type BookingWebAffiliateRepository,
} from "./bookingWebAffiliate.js";

export type BookingDomainResolutionSource = "legacy" | "target";

type BookingWebHostParams = {
  host: string;
};

type BookingWebHotelParams = {
  slug: string;
};

type BookingWebCalendarQuery = {
  start?: string;
  end?: string;
};

export const BOOKING_WEB_CALENDAR_MAX_RANGE_DAYS = 370;

type BookingWebBookingHandleParams = BookingWebHotelParams & {
  handle: string;
};

type BookingWebBookingIdParams = BookingWebHotelParams & {
  bookingId: string;
};

type BookingWebBookingStatusQuery = {
  reference?: string;
  email?: string;
};

type BookingWebGuestActionRequest = {
  guestEmail?: string;
  guest_email?: string;
};

type BookingWebCheckoutRequest = Record<string, unknown>;
type BookingWebLookupRequest = {
  bookingReference?: string;
  guestEmail?: string;
};
type BookingWebConfirmationRequest = {
  bookingReference?: string;
  confirmationToken?: string;
};
type BookingWebChangeRequest = {
  guestEmail?: string;
  guest_email?: string;
  checkIn?: string;
  checkOut?: string;
  addonIds?: string[];
  addonQuantities?: Record<string, number>;
  addonDates?: Record<string, string[]>;
};
type BookingWebChangeRequestQuery = {
  email?: string;
};
type BookingWebPromoValidationRequest = {
  code?: string;
};
type BookingWebAttributionClickRequest = {
  referralCode?: string;
  referral_code?: string;
  sessionId?: string;
  session_id?: string;
  landingUrl?: string;
  landing_url?: string;
  referrer?: string;
  metadata?: Record<string, unknown>;
};
type BookingWebTelemetryEventRequest = {
  hotelSlug?: string;
  hotel_slug?: string;
  eventType?: string;
  event_type?: string;
  eventId?: string;
  event_id?: string;
  idempotencyKey?: string;
  idempotency_key?: string;
  sessionId?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
};
type BookingWebAffiliateCheckEmailQuery = {
  email?: string;
};
type BookingWebAffiliateRequest = Record<string, unknown>;
type BookingWebAffiliateParams = BookingWebHotelParams & {
  affiliateId: string;
};

type TargetBookingWebCalendarRow = {
  stayDate: string;
  hasAvailability: boolean;
  hasUnavailableState: boolean;
  minStayNights: number | null;
  maxStayNights: number | null;
  sourceFreshnessValues: string[] | null;
  freshnessStatuses: string[] | null;
  generatedAt: Date | string | null;
  dataSources: string[] | null;
};

export type BookingWebAttributionSink = {
  recordAffiliateClick(event: BookingWebAffiliateClickEvent): Promise<void>;
  recordTelemetryEvent(event: BookingWebTelemetryEvent): Promise<void>;
};

export type BookingWebAffiliateClickEvent = {
  slug: string;
  referralCode: string;
  sessionId?: string;
  landingUrl?: string;
  referrer?: string;
  requestId: string;
  occurredAt: Date;
  userAgent?: string;
  ipAddress?: string;
  metadata: Record<string, unknown>;
};

export type BookingWebTelemetryEvent = {
  propertyId: string;
  hotelSlug: string;
  eventType: string;
  eventId?: string;
  sessionId?: string;
  requestId: string;
  occurredAt: Date;
  userAgent?: string;
  ipAddress?: string;
  metadata: Record<string, unknown>;
};

export type BookingWebPaymentInstructions = {
  bankTransfer: {
    enabled: boolean;
    details: unknown | null;
  };
  paypal: {
    enabled: boolean;
    email: string | null;
    paymentWindowHours: number | null;
  };
};

export type BookingWebCheckoutCommandContext = {
  operation: string;
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  fingerprint: string;
  occurredAt: Date;
};

export type BookingWebCheckoutAdapter = {
  consumeLookupAttempt(
    clientAddressHash: string,
    context: BookingWebCheckoutCommandContext,
  ): Promise<void>;
  getCheckoutConfig(slug: string, context?: BookingWebCheckoutCommandContext): Promise<unknown>;
  quoteBooking(
    slug: string,
    request: BookingWebCheckoutRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  createBooking(
    slug: string,
    request: BookingWebCheckoutRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  confirmAuthorization(
    slug: string,
    handle: string,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  getStatus(
    slug: string,
    query: BookingWebBookingStatusQuery,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  lookup(
    slug: string,
    request: BookingWebLookupRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  confirmation?(
    slug: string,
    request: BookingWebConfirmationRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  withdraw(
    slug: string,
    bookingId: string,
    request: BookingWebGuestActionRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  cancelPreview(
    slug: string,
    bookingId: string,
    request: BookingWebGuestActionRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  cancel(
    slug: string,
    bookingId: string,
    request: BookingWebGuestActionRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  previewChangeRequest(
    slug: string,
    bookingId: string,
    request: BookingWebChangeRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  submitChangeRequest(
    slug: string,
    bookingId: string,
    request: BookingWebChangeRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  getChangeRequest(
    slug: string,
    bookingId: string,
    query: BookingWebChangeRequestQuery,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  getPaymentInstructions(
    slug: string,
    handle: string,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<BookingWebPaymentInstructions>;
  validatePromo(
    slug: string,
    request: BookingWebPromoValidationRequest,
    context?: BookingWebCheckoutCommandContext,
  ): Promise<unknown>;
  close?(): Promise<void>;
};

export type BookingHotelChangeDecisionContext = {
  actorUserId: string;
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  fingerprint: string;
  occurredAt: Date;
};

export type BookingHotelChangeDecisionBinding = {
  propertyId: string;
  bookingId: string;
  changeRequestId: string;
  decision: "accept" | "decline";
  note: string | null;
};

export function bookingHotelChangeDecisionFingerprint(
  binding: BookingHotelChangeDecisionBinding,
): string {
  return sha256Hex(
    stableJson([
      binding.propertyId,
      binding.bookingId,
      binding.changeRequestId,
      binding.decision,
      binding.note,
    ]),
  );
}

export type BookingHotelChangeRequestRepository = {
  findLatestChangeRequest(propertyId: string, bookingId: string): Promise<unknown | null>;
  acceptChangeRequest(
    propertyId: string,
    bookingId: string,
    changeRequestId: string,
    context: BookingHotelChangeDecisionContext,
  ): Promise<unknown>;
  declineChangeRequest(
    propertyId: string,
    bookingId: string,
    changeRequestId: string,
    note: string | null,
    context: BookingHotelChangeDecisionContext,
  ): Promise<unknown>;
  close?(): Promise<void>;
};

export type BookingWebAffiliateAdapter = {
  checkEmail(slug: string, email: string): Promise<unknown>;
  register(slug: string, request: BookingWebAffiliateRequest): Promise<unknown>;
  createStripeConnectLink(
    slug: string,
    affiliateId: string,
    request: BookingWebAffiliateRequest,
  ): Promise<unknown>;
};

export type BookingWebHostResolution = {
  contractVersion: typeof PUBLIC_BOOKABILITY_CONTRACT_VERSION;
  publicVisibility: typeof PUBLIC_BOOKABILITY_VISIBILITY;
  host: string;
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl: string | null;
  shouldRedirect: boolean;
  redirectUrl: string | null;
  redirectStatus: 308 | null;
  hotel: Pick<
    PublicBookabilityProfileProjection["hotel"],
    "slug" | "name" | "defaultLocale" | "supportedLocales"
  >;
  dataSources: PublicBookabilityDataSourceOwner[];
};

export type BookingWebCalendarProjection = {
  contractVersion: typeof PUBLIC_BOOKABILITY_CONTRACT_VERSION;
  generatedAt: string;
  publicVisibility: typeof PUBLIC_BOOKABILITY_VISIBILITY;
  request: {
    hotelSlug: string;
    start: string;
    end: string;
  };
  calendar: {
    unavailableDates: string[];
    minStayByArrival: Record<string, number>;
    maxStayByArrival: Record<string, number>;
  };
  freshness: PublicBookabilityFreshness;
  dataSources: PublicBookabilityDataSourceOwner[];
};

export type BookingWebCalendarRepository = {
  findCalendarByHotel(
    hotel: Pick<PublicBookabilityHotelProfile, "propertyId" | "slug">,
    query: BookingWebCalendarQuery,
  ): Promise<BookingWebCalendarProjection>;
  close?(): Promise<void>;
};

type BookingWebQueryExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type BookingWebCalendarReadPool = BookingWebQueryExecutor & {
  end(): Promise<void>;
};

export type BookingWebPublicRoutesOptions = {
  profileRepository: PublicHotelProfileRepository;
  quoteRepository?: PublicHotelQuoteRepository;
  calendarRepository?: BookingWebCalendarRepository;
  bookingDomainResolutionSource?: BookingDomainResolutionSource;
  checkoutAdapter?: BookingWebCheckoutAdapter;
  affiliateHotelResolver?: BookingWebAffiliateHotelResolver;
  affiliateRepository?: BookingWebAffiliateRepository;
  affiliateAdapter?: BookingWebAffiliateAdapter;
  attributionSink?: BookingWebAttributionSink;
  now?: () => Date;
};

export async function registerBookingWebPublicRoutes(
  app: FastifyInstance,
  options: BookingWebPublicRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const checkoutAdapter = options.checkoutAdapter ?? createUnavailableBookingWebCheckoutAdapter();
  const affiliateAdapter =
    options.affiliateAdapter ?? createUnavailableBookingWebAffiliateAdapter();

  app.addHook("onRequest", async (request, reply) => {
    writeBookingWebCorsHeaders(request, reply);
  });

  app.options("/*", async (_request, reply) => {
    reply.code(204);
    return reply.send();
  });

  if (options.calendarRepository) {
    app.addHook("onClose", async () => {
      await options.calendarRepository?.close?.();
    });
  }
  if (checkoutAdapter.close) {
    app.addHook("onClose", async () => {
      await checkoutAdapter.close?.();
    });
  }

  app.get<{ Params: BookingWebHostParams }>("/hosts/:host", async (request, reply) => {
    const host = normalizeHost(request.params.host);
    const profile = await findProfileForHost({
      repository: options.profileRepository,
      host,
      source: options.bookingDomainResolutionSource ?? "legacy",
    });
    if (!profile) {
      throw createHttpError(404, "Booking Web host not found.");
    }

    const response = serializeHostResolution(host, profile);
    assertPublicBookabilityPublicSafe(response);
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-host-read");
    return response;
  });

  app.get<{ Params: BookingWebHotelParams }>("/hotels/:slug", async (request, reply) => {
    const profile = await options.profileRepository.findProfileBySlug(request.params.slug);
    if (!profile) {
      throw createHttpError(404, "Booking Web hotel profile not found.");
    }

    const response = serializePublicHotelProfileProjection(profile);
    assertPublicBookabilityPublicSafe(response);
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-profile-read");
    return response;
  });

  app.get<{ Params: BookingWebHotelParams; Querystring: PublicHotelQuoteQuery }>(
    "/hotels/:slug/offers",
    async (request, reply) => {
      if (!options.quoteRepository) {
        throw createHttpError(404, "Booking Web offers read model not configured.");
      }

      const quote = await options.quoteRepository.findQuoteBySlug(
        request.params.slug,
        request.query,
      );
      if (!quote) {
        throw createHttpError(404, "Booking Web offers not found.");
      }

      const response = serializePublicHotelQuoteProjection(quote);
      assertPublicBookabilityPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-offers-read");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebHotelParams; Querystring: BookingWebCalendarQuery }>(
    "/hotels/:slug/calendar",
    async (request, reply) => {
      const calendarStart = normalizeDateOnly(request.query.start);
      const calendarEnd = normalizeDateOnly(request.query.end);
      if (
        calendarStart &&
        calendarEnd &&
        calendarStart < calendarEnd &&
        dateRangeLength(calendarStart, calendarEnd) > BOOKING_WEB_CALENDAR_MAX_RANGE_DAYS
      ) {
        throw createHttpError(
          400,
          `Booking Web calendar ranges cannot exceed ${BOOKING_WEB_CALENDAR_MAX_RANGE_DAYS} days.`,
        );
      }

      const profile = await options.profileRepository.findProfileBySlug(request.params.slug);
      if (!profile) {
        throw createHttpError(404, "Booking Web hotel calendar not found.");
      }

      const response = await fetchCalendarProjection({
        hotel: profile.hotel,
        query: request.query,
        repository: options.calendarRepository,
        now: now(),
      });
      assertPublicBookabilityPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-calendar-read");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebHotelParams }>(
    "/hotels/:slug/checkout-config",
    async (request, reply) => {
      const response = await checkoutAdapter.getCheckoutConfig(
        request.params.slug,
        checkoutCommandContext(request, "checkout-config", request.params.slug, request.query, now),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-checkout-config");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebCheckoutRequest }>(
    "/hotels/:slug/bookings/quote",
    async (request, reply) => {
      const body = request.body ?? {};
      const response = await checkoutAdapter.quoteBooking(
        request.params.slug,
        body,
        checkoutCommandContext(request, "booking-quote", request.params.slug, body, now),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-quote");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebCheckoutRequest }>(
    "/hotels/:slug/bookings",
    async (request, reply) => {
      const body = request.body ?? {};
      const response = await checkoutAdapter.createBooking(
        request.params.slug,
        body,
        checkoutCommandContext(request, "booking-create", request.params.slug, body, now),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-create");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingHandleParams }>(
    "/hotels/:slug/bookings/:handle/confirm-authorization",
    async (request, reply) => {
      if (!isUuid(request.params.handle)) {
        throw createHttpError(400, "Booking authorization handle must be a draft ID.");
      }
      const response = await checkoutAdapter.confirmAuthorization(
        request.params.slug,
        request.params.handle,
        checkoutCommandContext(
          request,
          "booking-confirm-authorization",
          `${request.params.slug}:${request.params.handle}`,
          request.params,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-confirm");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebHotelParams; Querystring: BookingWebBookingStatusQuery }>(
    "/hotels/:slug/bookings/status",
    async (request, reply) => {
      const response = await checkoutAdapter.getStatus(
        request.params.slug,
        request.query,
        checkoutCommandContext(request, "booking-status", request.params.slug, request.query, now),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-status");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebLookupRequest }>(
    "/hotels/:slug/bookings/lookup",
    async (request, reply) => {
      const body = request.body ?? {};
      const context = checkoutCommandContext(
        request,
        "booking-lookup",
        request.params.slug,
        body,
        now,
      );
      try {
        await checkoutAdapter.consumeLookupAttempt(
          bookingLookupClientAddressHash(request),
          context,
        );
      } catch (error) {
        if (isHttpError(error) && error.statusCode === 429) {
          reply.header("Retry-After", "60");
        }
        throw error;
      }
      const response = await checkoutAdapter.lookup(request.params.slug, body, context);
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-lookup");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebConfirmationRequest }>(
    "/hotels/:slug/bookings/confirmation",
    async (request, reply) => {
      if (!checkoutAdapter.confirmation) {
        throw createHttpError(404, "Booking confirmation lookup is not configured.");
      }
      const body = request.body ?? {};
      const response = await checkoutAdapter.confirmation(
        request.params.slug,
        body,
        checkoutCommandContext(request, "booking-confirmation", request.params.slug, body, now),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-confirmation");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebGuestActionRequest }>(
    "/hotels/:slug/bookings/:bookingId/withdraw",
    async (request, reply) => {
      const body = normalizeGuestActionRequest(request.body ?? {});
      const response = await checkoutAdapter.withdraw(
        request.params.slug,
        request.params.bookingId,
        body,
        checkoutCommandContext(
          request,
          "booking-withdraw",
          `${request.params.slug}:${request.params.bookingId}`,
          body,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-withdraw");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebGuestActionRequest }>(
    "/hotels/:slug/bookings/:bookingId/cancel-preview",
    async (request, reply) => {
      const body = normalizeGuestActionRequest(request.body ?? {});
      const response = await checkoutAdapter.cancelPreview(
        request.params.slug,
        request.params.bookingId,
        body,
        checkoutCommandContext(
          request,
          "booking-cancel-preview",
          `${request.params.slug}:${request.params.bookingId}`,
          body,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-cancel-preview");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebGuestActionRequest }>(
    "/hotels/:slug/bookings/:bookingId/cancel",
    async (request, reply) => {
      const body = normalizeGuestActionRequest(request.body ?? {});
      const response = await checkoutAdapter.cancel(
        request.params.slug,
        request.params.bookingId,
        body,
        checkoutCommandContext(
          request,
          "booking-cancel",
          `${request.params.slug}:${request.params.bookingId}`,
          body,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-cancel");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebChangeRequest }>(
    "/hotels/:slug/bookings/:bookingId/change-request/preview",
    async (request, reply) => {
      const body = normalizeChangeRequest(request.body ?? {});
      const response = await checkoutAdapter.previewChangeRequest(
        request.params.slug,
        request.params.bookingId,
        body,
        checkoutCommandContext(
          request,
          "booking-change-preview",
          `${request.params.slug}:${request.params.bookingId}`,
          body,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-change-request-preview");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebBookingIdParams; Body: BookingWebChangeRequest }>(
    "/hotels/:slug/bookings/:bookingId/change-request",
    async (request, reply) => {
      const body = normalizeChangeRequest(request.body ?? {});
      const response = await checkoutAdapter.submitChangeRequest(
        request.params.slug,
        request.params.bookingId,
        body,
        checkoutCommandContext(
          request,
          "booking-change-submit",
          `${request.params.slug}:${request.params.bookingId}`,
          body,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-change-request-submit");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebBookingIdParams; Querystring: BookingWebChangeRequestQuery }>(
    "/hotels/:slug/bookings/:bookingId/change-request",
    async (request, reply) => {
      const response = await checkoutAdapter.getChangeRequest(
        request.params.slug,
        request.params.bookingId,
        request.query,
        checkoutCommandContext(
          request,
          "booking-change-get",
          `${request.params.slug}:${request.params.bookingId}`,
          request.query,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-change-request-get");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.get<{ Params: BookingWebBookingHandleParams }>(
    "/hotels/:slug/bookings/:handle/payment-instructions",
    async (request, reply) => {
      const response = await checkoutAdapter.getPaymentInstructions(
        request.params.slug,
        request.params.handle,
        checkoutCommandContext(
          request,
          "booking-payment-instructions",
          `${request.params.slug}:${request.params.handle}`,
          request.params,
          now,
        ),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-payment-instructions");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebPromoValidationRequest }>(
    "/hotels/:slug/promo/validate",
    async (request, reply) => {
      const body = request.body ?? {};
      const response = await checkoutAdapter.validatePromo(
        request.params.slug,
        body,
        checkoutCommandContext(request, "promo-validate", request.params.slug, body, now),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-promo-validate");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );

  app.post<{ Params: BookingWebHotelParams; Body: BookingWebAttributionClickRequest }>(
    "/hotels/:slug/attribution/clicks",
    async (request, reply) => {
      const referralCode = firstString(request.body?.referralCode, request.body?.referral_code);
      if (!referralCode) {
        throw createHttpError(400, "Referral code is required.");
      }
      if (options.attributionSink) {
        await options.attributionSink.recordAffiliateClick({
          slug: request.params.slug,
          referralCode,
          sessionId: firstString(request.body?.sessionId, request.body?.session_id),
          landingUrl: firstString(request.body?.landingUrl, request.body?.landing_url),
          referrer: firstString(request.body?.referrer, request.headers.referer),
          requestId: String(request.id),
          occurredAt: now(),
          userAgent: request.headers["user-agent"],
          ipAddress: request.ip,
          metadata: recordBody(request.body?.metadata),
        });
      }
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-attribution-click");
      return reply.status(204).send();
    },
  );

  app.post<{ Body: BookingWebTelemetryEventRequest }>("/events", async (request, reply) => {
    const hotelSlug = firstString(request.body?.hotelSlug, request.body?.hotel_slug);
    const eventType = firstString(request.body?.eventType, request.body?.event_type);
    if (!hotelSlug || !eventType) {
      throw createHttpError(400, "Hotel slug and event type are required.");
    }
    if (options.attributionSink) {
      const profile = await options.profileRepository.findProfileBySlug(hotelSlug);
      if (!profile) {
        throw createHttpError(404, "Hotel not found.");
      }
      await options.attributionSink.recordTelemetryEvent({
        propertyId: profile.hotel.propertyId,
        hotelSlug,
        eventType,
        eventId: firstString(
          request.body?.eventId,
          request.body?.event_id,
          request.body?.idempotencyKey,
          request.body?.idempotency_key,
        ),
        sessionId: firstString(request.body?.sessionId, request.body?.session_id),
        requestId: String(request.id),
        occurredAt: now(),
        userAgent: request.headers["user-agent"],
        ipAddress: request.ip,
        metadata: recordBody(request.body?.metadata),
      });
    }
    reply.header("Cache-Control", "no-store");
    reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-telemetry");
    return reply.status(204).send();
  });

  if (options.affiliateRepository) {
    await registerBookingWebAffiliateRoutes(app, {
      hotelResolver: options.affiliateHotelResolver ?? {
        findProfileBySlug: (slug) => options.profileRepository.findProfileBySlug(slug),
      },
      repository: options.affiliateRepository,
    });
  } else {
    app.get<{ Params: BookingWebHotelParams; Querystring: BookingWebAffiliateCheckEmailQuery }>(
      "/hotels/:slug/affiliates/check-email",
      async (request, reply) => {
        const email = firstString(request.query.email);
        if (!email) {
          throw createHttpError(400, "Email is required.");
        }
        const response = await affiliateAdapter.checkEmail(request.params.slug, email);
        reply.header("Cache-Control", "no-store");
        reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-check-email");
        reply.header("X-Robots-Tag", "noindex");
        return response;
      },
    );

    app.post<{ Params: BookingWebHotelParams; Body: BookingWebAffiliateRequest }>(
      "/hotels/:slug/affiliates",
      async (request, reply) => {
        const response = await affiliateAdapter.register(request.params.slug, request.body ?? {});
        reply.header("Cache-Control", "no-store");
        reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-register");
        reply.header("X-Robots-Tag", "noindex");
        return response;
      },
    );

    app.post<{ Params: BookingWebAffiliateParams; Body: BookingWebAffiliateRequest }>(
      "/hotels/:slug/affiliates/:affiliateId/stripe/connect",
      async (request, reply) => {
        const response = await affiliateAdapter.createStripeConnectLink(
          request.params.slug,
          request.params.affiliateId,
          request.body ?? {},
        );
        reply.header("Cache-Control", "no-store");
        reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-affiliate-stripe-connect");
        reply.header("X-Robots-Tag", "noindex");
        return response;
      },
    );
  }
}

function writeBookingWebCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
  const origin = request.headers.origin;
  if (!isAllowedBookingWebOrigin(origin)) {
    reply.header("Vary", "Origin");
    return;
  }

  reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header(
    "Access-Control-Allow-Headers",
    "content-type,idempotency-key,x-vayada-session-id,x-vayada-request-id",
  );
  reply.header("Access-Control-Max-Age", "600");
  reply.header("Vary", "Origin");
}

function bookingLookupClientAddressHash(request: FastifyRequest): string {
  return sha256Hex(`booking-lookup-client:${request.ip || "unknown"}`);
}

function isAllowedBookingWebOrigin(origin: unknown): origin is string {
  if (typeof origin !== "string") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "booking.vayada.com" ||
    host.endsWith(".booking.vayada.com") ||
    host === "next-booking.vayada.com" ||
    host.endsWith(".next-booking.vayada.com") ||
    host === "booking.localhost" ||
    host.endsWith(".booking.localhost")
  );
}

export function createTargetBookingWebCalendarRepository(config: {
  connectionString: string;
  max?: number;
  pool?: BookingWebCalendarReadPool;
}): BookingWebCalendarRepository {
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
    });

  return {
    async findCalendarByHotel(hotel, query) {
      const generatedAt = new Date().toISOString();
      const start = normalizeDateOnly(query.start);
      const end = normalizeDateOnly(query.end);
      if (
        !start ||
        !end ||
        start >= end ||
        dateRangeLength(start, end) > BOOKING_WEB_CALENDAR_MAX_RANGE_DAYS
      ) {
        return unavailableCalendar(hotel.slug, start, end, generatedAt);
      }

      try {
        const result = await pool.query<TargetBookingWebCalendarRow>(
          `SELECT
           offer.stay_date::text AS "stayDate",
           BOOL_OR(offer.sellable_publicly AND offer.availability_status IN ('available', 'limited') AND offer.available_rooms > 0 AND offer.freshness_status = 'fresh') AS "hasAvailability",
           BOOL_OR(offer.availability_status IN ('sold_out', 'closed', 'unavailable')) AS "hasUnavailableState",
           MIN(COALESCE(NULLIF(offer.rate_summary ->> 'minStayNights', '')::integer, 1)) AS "minStayNights",
           CASE
             WHEN BOOL_OR(NULLIF(offer.rate_summary ->> 'maxStayNights', '') IS NULL) THEN NULL
             ELSE MAX((offer.rate_summary ->> 'maxStayNights')::integer)
           END AS "maxStayNights",
           ARRAY_AGG(DISTINCT offer.source_freshness::text) AS "sourceFreshnessValues",
           ARRAY_AGG(DISTINCT offer.freshness_status) AS "freshnessStatuses",
           MAX(offer.generated_at) AS "generatedAt",
           ARRAY_AGG(DISTINCT source.owner) FILTER (WHERE source.owner IS NOT NULL) AS "dataSources"
         FROM distribution.public_room_offer_snapshots offer
         JOIN distribution.public_hotel_bookability_profiles profile
           ON profile.property_id = offer.property_id
         LEFT JOIN LATERAL unnest(offer.data_sources) AS source(owner) ON true
         WHERE (profile.property_id::text = $1 OR profile.canonical_slug = $2)
           AND profile.public_visibility = 'public_safe'
           AND profile.profile_status = 'public'
           AND profile.freshness_status = 'fresh'
           AND profile.public_setup_completeness ->> 'status' = 'ready'
           AND (profile.expires_at IS NULL OR profile.expires_at > now())
           AND offer.public_visibility = 'public_safe'
           AND offer.stay_date >= $3::date
           AND offer.stay_date < $4::date
           AND (offer.expires_at IS NULL OR offer.expires_at > now())
         GROUP BY offer.stay_date
         ORDER BY offer.stay_date ASC`,
          [hotel.propertyId, hotel.slug, start, end],
        );

        if (result.rows.length === 0) {
          return {
            ...unavailableCalendar(hotel.slug, start, end, generatedAt),
            freshness: targetCalendarFreshness(generatedAt, [], "unavailable"),
          };
        }

        const requestedDates = dateRange(start, end);
        const coveredDates = new Set(result.rows.map((row) => row.stayDate));
        const missingDates = requestedDates.filter((date) => !coveredDates.has(date));

        const unavailableDates = [
          ...new Set([
            ...missingDates,
            ...result.rows.filter((row) => !row.hasAvailability).map((row) => row.stayDate),
          ]),
        ].sort();
        const latestGeneratedAt =
          result.rows
            .map((row) => toIsoDateTime(row.generatedAt))
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? generatedAt;
        const dataSources = [
          ...new Set(result.rows.flatMap((row) => dataSourcesArray(row.dataSources))),
        ];
        const minStayByArrival = Object.fromEntries(
          result.rows.map((row) => [row.stayDate, Math.max(Number(row.minStayNights ?? 1), 1)]),
        );
        const maxStayByArrival = Object.fromEntries(
          result.rows.flatMap((row) =>
            row.maxStayNights === null
              ? []
              : [[row.stayDate, Math.max(Number(row.maxStayNights), 1)]],
          ),
        );

        return {
          contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
          generatedAt: latestGeneratedAt,
          publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
          request: { hotelSlug: hotel.slug, start, end },
          calendar: {
            unavailableDates,
            minStayByArrival,
            maxStayByArrival,
          },
          freshness: targetCalendarFreshness(
            latestGeneratedAt,
            result.rows.flatMap((row) => row.sourceFreshnessValues ?? []),
            missingDates.length > 0
              ? "unavailable"
              : rollupCalendarFreshness(result.rows.flatMap((row) => row.freshnessStatuses ?? [])),
          ),
          dataSources: dataSources.length > 0 ? dataSources : ["pms", "distribution"],
        };
      } catch {
        return {
          ...unavailableCalendar(hotel.slug, start, end, generatedAt),
          freshness: targetCalendarFreshness(generatedAt, [], "unavailable"),
        };
      }
    },
    async close() {
      await pool.end();
    },
  };
}

type TargetCheckoutPropertyRow = QueryResultRow & {
  propertyId: string;
  displayName: string;
  defaultLocale: string;
  timezone: string;
};

type TargetCheckoutConfigRow = QueryResultRow & {
  propertyId: string;
  acceptanceMode: "instant" | "request" | null;
  defaultCurrency: string | null;
  benefits: unknown;
  showAddonsStep: boolean | null;
  groupAddonsByCategory: boolean | null;
  specialRequestsEnabled: boolean | null;
  arrivalTimeEnabled: boolean | null;
  guestCountEnabled: boolean | null;
  phoneRequired: boolean | null;
  adultAgeThreshold: number | null;
  childrenEnabled: boolean | null;
  termsText: string | null;
  cancellationPolicyText: string | null;
  paymentsEnabled: boolean | null;
  acceptedMethods: string[] | null;
  depositPolicy: unknown;
  refundPolicy: unknown;
  requiresManualReview: boolean | null;
  providerAccountId: string | null;
  providerAccountRef: string | null;
  providerReady: boolean | null;
};

type TargetBookingRow = QueryResultRow & {
  guestBookingId: string;
  propertyId: string;
  publicReference: string;
  sourceSystem: string;
  hotelName?: string;
  guestFirstName?: string;
  guestLastName?: string;
  guestEmail?: string;
  lifecycleStatus: string;
  paymentStatus: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  roomCount: number;
  currency: string;
  totalAmount: string | number;
  balanceAmount: string | number;
  bookingMetadata: unknown;
  expectedPaymentMethod?: string | null;
  operationalStatus?: string | null;
  assignedRoomTypeName?: string | null;
  unitNames?: unknown;
  cancelledAt?: Date | string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  createdAt: Date | string;
};

type TargetCardPaymentRow = QueryResultRow & {
  paymentId: string;
  providerPaymentIntentId: string;
  providerAccountRef: string;
  chargeType: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
};

type TargetCheckoutQuoteOfferRow = QueryResultRow & {
  publicOfferKey: string;
  roomTypeId: string;
  ratePlanId: string | null;
  roomSummary: unknown;
  rateSummary: unknown;
  occupancy: unknown;
  publicPolicy: unknown;
  paymentOptions: string[] | null;
  availableRooms: string | number;
  nightlyRoomAmounts: unknown;
  roomTotal: string | number;
  taxesAndFees: string | number;
  discounts: string | number;
  currency: string;
  generatedAt: Date | string | null;
  sourceFreshness: unknown;
  profileCapabilities: unknown;
};

type TargetCheckoutQuoteRow = QueryResultRow & {
  quoteSessionId: string;
  publicQuoteReference: string;
  requestedCheckIn: string;
  requestedCheckOut: string;
  adults: number;
  children: number;
  roomCount: number;
  currency: string;
  status: string;
  selectedOfferSnapshot: unknown;
  totals: unknown;
  policySnapshot: unknown;
  expiresAt: Date | string;
};

type TargetCheckoutQuoteSnapshot = {
  quoteSessionId: string;
  publicQuoteReference: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  roomCount: number;
  currency: string;
  totalAmount: string;
  balanceAmount: string;
  paymentMethod: string | null;
  acceptanceMode: "instant" | "request";
  selectedOfferSnapshot: Record<string, unknown>;
  totals: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  expiresAt: string;
};

type TargetDateChangePreview = {
  oldCheckIn: string;
  oldCheckOut: string;
  requestedCheckIn: string;
  requestedCheckOut: string;
  oldAddonIds: string[];
  oldAddonQuantities: Record<string, number>;
  oldAddonDates: Record<string, string[]>;
  requestedAddonIds: string[];
  requestedAddonQuantities: Record<string, number>;
  requestedAddonDates: Record<string, string[]>;
  requestedAddonNames: string[];
  oldTotal: number;
  newTotal: number;
  priceDifference: number;
  currency: string;
  available: boolean;
  blocked: boolean;
  blockReason: string | null;
  pricingSnapshot: Record<string, unknown> | null;
};

type TargetChangeRequestRow = QueryResultRow & {
  id: string;
  guestBookingId: string;
  status: string;
  requestedChanges: unknown;
  decisionNote: string | null;
  decidedAt: Date | string | null;
  createdAt: Date | string;
};

type PgTargetBookingWebCheckoutAdapterConfig = {
  connectionString: string;
  inventoryReservationPort: DirectBookingInventoryReservationPort;
  billingConfigReadPortFactory?: (executor: Pick<pg.PoolClient, "query">) => BillingConfigReadPort;
  stripePaymentProvider?: StripeBookingPaymentProvider;
  max?: number;
  pool?: pg.Pool;
};

const TARGET_CHECKOUT_SUPPORTED_PAYMENT_METHODS = [
  "card",
  "pay_at_property",
  "cash",
  "bank_transfer",
  "paypal",
] as const;
const TARGET_REQUEST_HOST_RESPONSE_HOURS = 24;
const BOOKING_CONFIRMATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const BOOKING_LOOKUP_RATE_LIMIT = 5;
const BOOKING_LOOKUP_RATE_WINDOW_MS = 60 * 1000;

type TargetCheckoutCommandReservation =
  | { status: "reserved" }
  | { status: "replay"; body: unknown };

type TargetBookingChangeDecisionReservation =
  | { status: "reserved" }
  | { status: "replay"; body: unknown };

async function withTargetCheckoutTransaction<T>(
  pool: pg.Pool,
  action: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof pool.connect !== "function") {
    const executor = pool as unknown as BookingWebQueryExecutor;
    await executor.query("BEGIN");
    try {
      const result = await action(executor as pg.PoolClient);
      await executor.query("COMMIT");
      return result;
    } catch (error) {
      await executor.query("ROLLBACK");
      throw error;
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original checkout failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function createTargetBookingWebCheckoutAdapter(
  config: PgTargetBookingWebCheckoutAdapterConfig,
): BookingWebCheckoutAdapter & BookingHotelChangeRequestRepository {
  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  const withCommand = async <T>(
    slug: string,
    context: BookingWebCheckoutCommandContext | undefined,
    action: () => Promise<{
      propertyId: string;
      resourceType: string;
      resourceId: string;
      body: T;
    }>,
  ): Promise<T> => {
    const result = await action();
    if (context) {
      await recordTargetCheckoutCommand(pool, {
        propertyId: result.propertyId,
        context,
        resourceType: result.resourceType,
        resourceId: result.resourceId,
        body: result.body,
      });
    }
    return result.body;
  };

  return {
    async consumeLookupAttempt(clientAddressHash, context) {
      await withTargetCheckoutTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `booking-lookup:${clientAddressHash}`,
        ]);
        const attempts = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM platform.product_audit_events
            WHERE product = 'booking'
              AND action = 'booking.guest_lookup.attempt'
              AND target_resource_product = 'booking'
              AND target_resource_type = 'lookup_client_address_hash'
              AND target_resource_id = $1
              AND occurred_at > $2::timestamptz`,
          [
            clientAddressHash,
            new Date(context.occurredAt.getTime() - BOOKING_LOOKUP_RATE_WINDOW_MS).toISOString(),
          ],
        );
        if (Number(attempts.rows[0]?.count ?? 0) >= BOOKING_LOOKUP_RATE_LIMIT) {
          throw createHttpError(429, "Too many booking lookup attempts. Please try again later.");
        }
        await client.query(
          `INSERT INTO platform.product_audit_events (
             audit_key, product, action, occurred_at, tenant_scope,
             actor_type, target_resource_product, target_resource_type,
             target_resource_id, correlation_id, causation_id,
             redacted_payload, private_payload, audit_metadata,
             retention_class, privacy_scope
           ) VALUES (
             $1, 'booking', 'booking.guest_lookup.attempt', $2::timestamptz, 'external',
             'system', 'booking', 'lookup_client_address_hash', $3, $4, $5,
             $6::jsonb, '{}'::jsonb, $7::jsonb, 'security', 'restricted'
           )`,
          [
            `booking.guest_lookup.attempt.${randomBytes(16).toString("hex")}`,
            context.occurredAt.toISOString(),
            clientAddressHash,
            context.correlationId,
            context.requestId,
            JSON.stringify({ operation: context.operation }),
            JSON.stringify({ source: "apps/api-booking-web-public" }),
          ],
        );
      });
    },
    async findLatestChangeRequest(propertyId, bookingId) {
      const result = await loadLatestTargetChangeRequest(pool, propertyId, bookingId);
      return result ? serializeTargetChangeRequest(result) : null;
    },
    async acceptChangeRequest(propertyId, bookingId, changeRequestId, context) {
      return withTargetCheckoutTransaction(pool, async (client) => {
        const decision = await reserveTargetBookingChangeDecision(client, {
          propertyId,
          bookingId,
          changeRequestId,
          decision: "accept",
          note: null,
          context,
        });
        if (decision.status === "replay") return decision.body;

        const booking = await loadTargetHotelBooking(client, propertyId, bookingId, true);
        assertTargetDateChangeDecisionAllowed(booking);
        const changeRequest = await loadTargetChangeRequestForHotelById(
          client,
          propertyId,
          booking.guestBookingId,
          changeRequestId,
          true,
        );
        if (!changeRequest) {
          throw createHttpError(404, "Booking change request not found.");
        }
        if (changeRequest.status !== "pending") {
          throw createHttpError(409, "Booking change request status changed.");
        }
        const property = await loadTargetPropertyById(client, propertyId);
        const requested = targetDateChangeRequestFromSnapshot(changeRequest.requestedChanges);
        const preview = await previewTargetDateChange(
          client,
          property,
          booking,
          requested,
          context.occurredAt,
        );
        if (preview.blocked || !preview.pricingSnapshot) {
          throw createHttpError(
            409,
            preview.blockReason ?? "The requested dates are no longer available.",
          );
        }
        assertTargetDateChangePriceUnchanged(changeRequest.requestedChanges, preview);

        const currentReservation = inventoryReservationReceiptFromBookingMetadata(
          booking.bookingMetadata,
          propertyId,
        );
        if (currentReservation) {
          await config.inventoryReservationPort.release({
            transaction: client,
            propertyId,
            reservation: currentReservation,
            occurredAt: context.occurredAt,
          });
        }
        const selectedOffer = objectValue(preview.pricingSnapshot["selectedOffer"]);
        const roomTypeId = stringValue(selectedOffer["roomTypeId"]);
        const publicOfferKey = stringValue(selectedOffer["publicOfferKey"]);
        if (!roomTypeId || !publicOfferKey) {
          throw createHttpError(409, "The requested room offer is no longer available.");
        }
        const reservation = await config.inventoryReservationPort.reserve({
          transaction: client,
          propertyId,
          quoteSessionId: `change-request:${changeRequest.id}`,
          roomTypeId,
          publicOfferKey,
          checkIn: preview.requestedCheckIn,
          checkOut: preview.requestedCheckOut,
          roomCount: booking.roomCount,
          currency: booking.currency,
          occurredAt: context.occurredAt,
        });
        if (!reservation) {
          throw createHttpError(409, "The requested dates are no longer available.");
        }

        const updatedBooking = await applyAcceptedTargetDateChange(client, {
          booking,
          changeRequest,
          preview,
          selectedOffer,
          inventoryReservation: reservation,
          context,
        });
        await captureDirectNightlyRevenueEvidence(client, updatedBooking, {
          selectedOffer,
          fingerprint: context.fingerprint,
          recognizedOn: targetPropertyDateOnly(property.timezone, context.occurredAt),
          required: true,
        });
        await enqueuePmsReservationHandoff(
          client,
          propertyId,
          updatedBooking,
          {
            operation: "booking-change-accept",
            requestId: context.requestId,
            correlationId: context.correlationId,
            idempotencyKey: context.idempotencyKey,
            fingerprint: context.fingerprint,
            occurredAt: context.occurredAt,
          },
          "update",
          { revision: changeRequest.id, actorType: "property_user" },
        );
        const accepted = await loadChangeRequestById(client, changeRequest.id);
        if (!accepted) throw createHttpError(409, "Booking change request status changed.");
        const body = serializeTargetChangeRequest(accepted);
        await completeTargetBookingChangeDecision(client, {
          propertyId,
          bookingId,
          changeRequestId,
          decision: "accept",
          note: null,
          context,
          body,
        });
        return body;
      });
    },
    async declineChangeRequest(propertyId, bookingId, changeRequestId, note, context) {
      return withTargetCheckoutTransaction(pool, async (client) => {
        const decision = await reserveTargetBookingChangeDecision(client, {
          propertyId,
          bookingId,
          changeRequestId,
          decision: "decline",
          note,
          context,
        });
        if (decision.status === "replay") return decision.body;

        const booking = await loadTargetHotelBooking(client, propertyId, bookingId, true);
        const changeRequest = await loadTargetChangeRequestForHotelById(
          client,
          propertyId,
          booking.guestBookingId,
          changeRequestId,
          true,
        );
        if (!changeRequest) {
          throw createHttpError(404, "Booking change request not found.");
        }
        if (changeRequest.status !== "pending") {
          throw createHttpError(409, "Booking change request status changed.");
        }
        const result = await client.query<TargetChangeRequestRow>(
          `UPDATE booking.booking_change_requests change_request
              SET status = 'declined',
                  decision_actor_user_id = $3::uuid,
                  decision_note = $4,
                  decided_at = $5::timestamptz,
                  updated_at = $5::timestamptz
             FROM booking.guest_bookings booking
            WHERE change_request.id = $1::uuid
              AND change_request.guest_booking_id = booking.id
              AND booking.property_id = $2::uuid
              AND change_request.status = 'pending'
          RETURNING
            change_request.id::text AS id,
            change_request.guest_booking_id::text AS "guestBookingId",
            change_request.status,
            change_request.requested_changes AS "requestedChanges",
            change_request.decision_note AS "decisionNote",
            change_request.decided_at AS "decidedAt",
            change_request.created_at AS "createdAt"`,
          [
            changeRequest.id,
            propertyId,
            context.actorUserId,
            note,
            context.occurredAt.toISOString(),
          ],
        );
        const declined = result.rows[0];
        if (!declined) throw createHttpError(409, "Booking change request status changed.");
        const body = serializeTargetChangeRequest(declined);
        await completeTargetBookingChangeDecision(client, {
          propertyId,
          bookingId,
          changeRequestId,
          decision: "decline",
          note,
          context,
          body,
        });
        return body;
      });
    },
    async getCheckoutConfig(slug, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
        const row = await loadTargetCheckoutConfig(pool, property.propertyId);
        return {
          propertyId: property.propertyId,
          resourceType: "checkout_config",
          resourceId: property.propertyId,
          body: serializeTargetCheckoutConfig(property, row),
        };
      });
    },
    async createBooking(slug, request, context) {
      if (!context) {
        throw createHttpError(400, "Checkout command context is required.");
      }
      return withTargetCheckoutTransaction(pool, async (client) => {
        const property = await resolveTargetCheckoutProperty(client, slug, true);
        const reservation = await reserveTargetCheckoutCommand(
          client,
          property.propertyId,
          context,
        );
        if (reservation.status === "replay") {
          return hydrateTargetCardCheckoutReplay(
            client,
            config,
            property.propertyId,
            reservation.body,
            context,
          );
        }
        const guestPhone = await resolveTargetGuestPhone(client, property.propertyId, request);
        const quote = await loadTargetCheckoutQuoteSnapshot(
          client,
          property.propertyId,
          request,
          context.occurredAt,
        );
        const billingConfigReadPort = config.billingConfigReadPortFactory?.(client);
        if (!billingConfigReadPort) {
          throw createHttpError(503, "Finance billing configuration is not available.");
        }
        const billingConfig = await billingConfigReadPort.getBillingConfig(property.propertyId);
        if (!billingConfig) {
          throw createHttpError(409, "Finance billing configuration is not available.");
        }
        const checkoutConfig = await loadTargetCheckoutConfig(client, property.propertyId);
        assertTargetCheckoutConfigMatchesQuote(checkoutConfig, quote);
        resolveTargetCheckoutAmountSnapshot(request, quote);
        const booking = await createTargetGuestBooking(
          client,
          config.inventoryReservationPort,
          property,
          request,
          context,
          quote,
          guestPhone,
          billingConfig,
          checkoutConfig,
        );
        const confirmation = await issueTargetBookingConfirmationToken(
          client,
          booking,
          context.occurredAt,
        );
        if (booking.lifecycleStatus === "confirmed") {
          await captureDirectNightlyRevenueEvidence(client, booking, {
            selectedOffer: quote.selectedOfferSnapshot,
            fingerprint: context.fingerprint,
            required: true,
          });
        }
        await enqueueBookingTransitionNotifications(client, {
          propertyId: property.propertyId,
          guestBookingId: booking.guestBookingId,
          occurredAt: context.occurredAt.toISOString(),
          correlationId: context.correlationId,
          causationId: context.requestId,
          actor: { type: "system" },
          source: "apps/api-booking-checkout",
          transition: {
            eventType: "guest_booking.created",
            fromStatus: null,
            toStatus: booking.lifecycleStatus,
          },
        });
        const cardPayment =
          quote.paymentMethod === "card"
            ? await createTargetCardPayment(
                client,
                config,
                booking,
                checkoutConfig,
                billingConfig,
                quote.acceptanceMode,
                context,
              )
            : null;
        if (!cardPayment) {
          await enqueuePmsReservationHandoff(
            client,
            property.propertyId,
            booking,
            context,
            "create",
          );
        }
        const body = {
          bookingReference: booking.publicReference,
          booking: serializeTargetBooking(booking),
          clientSecret: cardPayment?.clientSecret ?? null,
          xenditInvoiceUrl: null,
          paymentMethod: quote.paymentMethod,
          confirmationToken: confirmation.token,
          confirmationTokenExpiresAt: confirmation.expiresAt,
          ...(cardPayment ? { draftId: booking.guestBookingId } : {}),
          ...(cardPayment ? { providerPaymentIntentId: cardPayment.paymentIntentId } : {}),
          ...(cardPayment ? { stripeAccountId: cardPayment.providerAccountRef } : {}),
          pmsHandoff: { status: cardPayment ? "awaiting_payment" : "pending_handoff" },
        };
        await recordTargetCheckoutCommand(client, {
          propertyId: property.propertyId,
          context,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: cardPayment ? { ...body, clientSecret: null } : body,
        });
        return body;
      });
    },
    async quoteBooking(slug, request, context) {
      assertTargetQuotePricingInputsSupported(request);
      const action = async (executor: BookingWebQueryExecutor) => {
        const property = await resolveTargetCheckoutProperty(executor, slug, true);
        if (context) {
          const reservation = await reserveTargetCheckoutCommand(
            executor,
            property.propertyId,
            context,
          );
          if (reservation.status === "replay") return reservation.body;
        }
        const quote = await createTargetCheckoutQuote(
          executor,
          property,
          request,
          context?.occurredAt ?? new Date(),
        );
        const body = serializeTargetCheckoutQuote(quote);
        if (context) {
          await recordTargetCheckoutCommand(executor, {
            propertyId: property.propertyId,
            context,
            resourceType: "checkout_quote",
            resourceId: quote.publicQuoteReference,
            body,
          });
        }
        return body;
      };
      return context ? withTargetCheckoutTransaction(pool, action) : action(pool);
    },
    async confirmAuthorization(slug, handle, context) {
      if (!context) throw createHttpError(400, "Checkout command context is required.");
      if (!isUuid(handle)) {
        throw createHttpError(400, "Booking authorization handle must be a draft ID.");
      }
      if (!config.stripePaymentProvider) {
        throw createHttpError(503, "Target card authorization is not configured.");
      }
      return withTargetCheckoutTransaction(pool, async (client) => {
        const property = await resolveTargetHistoricalBookingProperty(client, slug);
        const reservation = await reserveTargetCheckoutCommand(
          client,
          property.propertyId,
          context,
        );
        if (reservation.status === "replay") return reservation.body;
        const booking = await loadTargetHotelBooking(client, property.propertyId, handle, true);
        const payment = await loadTargetCardPayment(client, booking);
        const acceptanceMode = targetAcceptanceMode(
          objectValue(booking.bookingMetadata)["acceptanceMode"],
        );
        const authorizationComplete =
          (booking.paymentStatus === "paid" && booking.lifecycleStatus === "confirmed") ||
          (acceptanceMode === "request" &&
            booking.paymentStatus === "authorized" &&
            booking.lifecycleStatus === "pending_payment");
        if (!authorizationComplete || !payment.cardBrand || !payment.cardLast4) {
          const intent = await config.stripePaymentProvider!.retrievePaymentIntent(
            payment.providerPaymentIntentId,
            payment.chargeType === "direct" ? payment.providerAccountRef : null,
          );
          assertStripePaymentReady(
            booking,
            payment.providerAccountRef,
            intent,
            booking.paymentStatus === "paid" ? "instant" : acceptanceMode,
          );
          await reconcileStripeBookingPaymentProviderDetails(client, intent, context.occurredAt);
          if (!authorizationComplete) {
            if (acceptanceMode === "request") {
              await authorizeStripeBookingPayment(client, {
                paymentIntentId: intent.paymentIntentId,
                providerAccountRef: intent.providerAccountRef,
                amountMinor: intent.amountMinor,
                currency: intent.currency,
                occurredAt: context.occurredAt,
              });
            } else {
              await settleStripeBookingPayment(client, {
                paymentIntentId: intent.paymentIntentId,
                providerAccountRef: intent.providerAccountRef,
                amountMinor: intent.amountMinor,
                currency: intent.currency,
                occurredAt: context.occurredAt,
                correlationId: context.correlationId,
              });
            }
          }
        }
        const finalized = await loadTargetHotelBooking(client, property.propertyId, handle);
        if (
          !(finalized.paymentStatus === "paid" && finalized.lifecycleStatus === "confirmed") &&
          !(
            acceptanceMode === "request" &&
            finalized.paymentStatus === "authorized" &&
            finalized.lifecycleStatus === "pending_payment"
          )
        ) {
          throw createHttpError(409, "Card payment authorization is not complete.");
        }
        const body = serializeTargetBooking(finalized);
        await recordTargetCheckoutCommand(client, {
          propertyId: property.propertyId,
          context,
          resourceType: "guest_booking",
          resourceId: finalized.guestBookingId,
          body,
        });
        return body;
      });
    },
    async getStatus(slug, query, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetHistoricalBookingProperty(pool, slug);
        const reference = firstString(query.reference);
        if (!reference) {
          throw createHttpError(400, "Booking reference is required.");
        }
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          reference,
          requireGuestEmail(query.email),
        );
        return {
          propertyId: property.propertyId,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: serializeTargetBookingStatus(booking),
        };
      });
    },
    async lookup(slug, request, context) {
      if (!context) throw createHttpError(400, "Checkout command context is required.");
      return withTargetCheckoutTransaction(pool, async (client) => {
        let property: TargetCheckoutPropertyRow;
        try {
          property = await resolveTargetHistoricalBookingProperty(client, slug);
        } catch (error) {
          if (isHttpError(error) && error.statusCode === 404) {
            throw createHttpError(404, "Booking not found.");
          }
          throw error;
        }
        const reference = firstString(request.bookingReference);
        if (!reference) {
          throw createHttpError(400, "Booking reference is required.");
        }
        const booking = await loadTargetBooking(
          client,
          property.propertyId,
          reference,
          requireGuestEmail(request.guestEmail),
        );
        const confirmation = await issueTargetBookingConfirmationToken(
          client,
          booking,
          context.occurredAt,
        );
        const body = {
          ...serializeTargetBooking(booking),
          confirmationToken: confirmation.token,
          confirmationTokenExpiresAt: confirmation.expiresAt,
        };
        await recordTargetCheckoutCommand(client, {
          propertyId: property.propertyId,
          context,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: serializeTargetBooking(booking),
        });
        return body;
      });
    },
    async confirmation(slug, request, context) {
      return withCommand(slug, context, async () => {
        const bookingReference = firstString(request.bookingReference);
        const confirmationToken = firstString(request.confirmationToken);
        if (
          !bookingReference ||
          !confirmationToken ||
          !/^[A-Za-z0-9_-]{40,80}$/.test(confirmationToken)
        ) {
          throw createHttpError(400, "Booking reference and confirmation token are required.");
        }
        const property = await resolveTargetHistoricalBookingProperty(pool, slug);
        let booking = await loadTargetBooking(
          pool,
          property.propertyId,
          bookingReference,
          null,
          sha256Hex(confirmationToken),
        );
        assertTargetBookingConfirmationTokenActive(
          booking,
          sha256Hex(confirmationToken),
          context?.occurredAt ?? new Date(),
        );
        if (booking.lifecycleStatus === "draft") {
          throw createHttpError(409, "Booking confirmation is still processing.");
        }
        if (
          stringValue(objectValue(booking.bookingMetadata)["paymentMethod"]) === "card" &&
          (!booking.cardBrand || !booking.cardLast4)
        ) {
          if (!config.stripePaymentProvider) {
            throw createHttpError(503, "Target card authorization is not configured.");
          }
          const payment = await loadTargetCardPayment(pool, booking);
          const intent = await config.stripePaymentProvider.retrievePaymentIntent(
            payment.providerPaymentIntentId,
            payment.chargeType === "direct" ? payment.providerAccountRef : null,
          );
          const acceptanceMode = targetAcceptanceMode(
            objectValue(booking.bookingMetadata)["acceptanceMode"],
          );
          assertStripePaymentReady(
            booking,
            payment.providerAccountRef,
            intent,
            booking.paymentStatus === "paid" ? "instant" : acceptanceMode,
          );
          await reconcileStripeBookingPaymentProviderDetails(
            pool,
            intent,
            context?.occurredAt ?? new Date(),
          );
          booking = await loadTargetBooking(
            pool,
            property.propertyId,
            bookingReference,
            null,
            sha256Hex(confirmationToken),
          );
        }
        return {
          propertyId: property.propertyId,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: serializeTargetBooking(booking),
        };
      });
    },
    async withdraw(slug, bookingId, request, context) {
      return withGuestLifecycleMutation(
        pool,
        config.inventoryReservationPort,
        slug,
        bookingId,
        request,
        context,
        {
          status: "canceled",
          action: "withdraw",
          eventType: "guest_booking.withdrawn",
        },
      );
    },
    async cancelPreview(slug, bookingId, request, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetHistoricalBookingProperty(pool, slug);
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          bookingId,
          requireGuestEmail(request.guest_email),
        );
        assertLifecycleMutationAllowed(booking, "cancel");
        const preview = resolveTargetCancellationPreview(
          booking,
          property.timezone,
          context?.occurredAt ?? new Date(),
        );
        return {
          propertyId: property.propertyId,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: preview,
        };
      });
    },
    async cancel(slug, bookingId, request, context) {
      return withGuestLifecycleMutation(
        pool,
        config.inventoryReservationPort,
        slug,
        bookingId,
        request,
        context,
        {
          status: "canceled",
          action: "cancel",
          eventType: "guest_booking.canceled",
        },
      );
    },
    async previewChangeRequest(slug, bookingId, request, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetHistoricalBookingProperty(pool, slug);
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          bookingId,
          requireGuestEmail(request.guestEmail ?? request.guest_email),
        );
        const preview = await previewTargetDateChange(
          pool,
          property,
          booking,
          normalizeChangeRequest(request),
          context?.occurredAt ?? new Date(),
        );
        return {
          propertyId: property.propertyId,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: serializeTargetDateChangePreview(preview),
        };
      });
    },
    async submitChangeRequest(slug, bookingId, request, context) {
      if (!context) {
        throw createHttpError(400, "Checkout command context is required.");
      }
      return withTargetCheckoutTransaction(pool, async (client) => {
        const property = await resolveTargetHistoricalBookingProperty(client, slug);
        const reservation = await reserveTargetCheckoutCommand(
          client,
          property.propertyId,
          context,
        );
        if (reservation.status === "replay") return reservation.body;
        const booking = await loadTargetBooking(
          client,
          property.propertyId,
          bookingId,
          requireGuestEmail(request.guestEmail ?? request.guest_email),
        );
        await lockTargetBookingChangeRequests(client, booking);
        const pending = await loadPendingTargetChangeRequest(client, booking.guestBookingId);
        if (pending) {
          throw createHttpError(409, "A booking change request is already pending.");
        }
        const preview = await previewTargetDateChange(
          client,
          property,
          booking,
          normalizeChangeRequest(request),
          context.occurredAt,
        );
        if (preview.blocked) {
          throw createHttpError(409, preview.blockReason ?? "The requested dates are unavailable.");
        }
        const changeRequest = await insertTargetChangeRequest(client, booking, preview);
        const body = serializeTargetChangeRequest(changeRequest);
        await recordTargetCheckoutCommand(client, {
          propertyId: property.propertyId,
          context,
          resourceType: "booking_change_request",
          resourceId: changeRequest.id,
          body,
        });
        return body;
      });
    },
    async getChangeRequest(slug, bookingId, query, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetHistoricalBookingProperty(pool, slug);
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          bookingId,
          requireGuestEmail(query.email),
        );
        const result = await pool.query<TargetChangeRequestRow>(
          `SELECT
             id::text AS id,
             guest_booking_id::text AS "guestBookingId",
             status,
             requested_changes AS "requestedChanges",
             decision_note AS "decisionNote",
             decided_at AS "decidedAt",
             created_at AS "createdAt"
             FROM booking.booking_change_requests
            WHERE guest_booking_id = $1
              AND request_type = 'date_change'
            ORDER BY created_at DESC
            LIMIT 1`,
          [booking.guestBookingId],
        );
        return {
          propertyId: property.propertyId,
          resourceType: "booking_change_request",
          resourceId: booking.guestBookingId,
          body: result.rows[0] ? serializeTargetChangeRequest(result.rows[0]) : { status: "none" },
        };
      });
    },
    async getPaymentInstructions(slug, handle, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetHistoricalBookingProperty(pool, slug);
        const booking = await loadTargetHotelBooking(pool, property.propertyId, handle);
        const metadata = objectValue(booking.bookingMetadata);
        const paymentInstructions = objectValue(metadata["paymentInstructions"]);
        const paypalEmail = stringValue(paymentInstructions["paypalEmail"]);
        const paypalEnabled =
          booking.lifecycleStatus === "pending_payment" &&
          booking.paymentStatus === "unpaid" &&
          stringValue(metadata["paymentMethod"]) === "paypal" &&
          isValidPaymentEmail(paypalEmail);
        return {
          propertyId: property.propertyId,
          resourceType: "payment_instructions",
          resourceId: handle,
          body: {
            bankTransfer: {
              enabled: false,
              details: null,
            },
            paypal: {
              enabled: paypalEnabled,
              email: paypalEnabled ? paypalEmail : null,
              paymentWindowHours: paypalEnabled
                ? boundedPaymentWindowHours(paymentInstructions["paypalPaymentWindowHours"])
                : null,
            },
          },
        };
      });
    },
    async validatePromo(slug, request, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
        const code = typeof request.code === "string" ? request.code.trim() : "";
        const body = code
          ? await validateTargetPromo(pool, property.propertyId, code)
          : { valid: false, code, message: "Promo code is required" };
        return {
          propertyId: property.propertyId,
          resourceType: "promo_code",
          resourceId: code || property.propertyId,
          body,
        };
      });
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

async function issueTargetBookingConfirmationToken(
  pool: BookingWebQueryExecutor,
  booking: Pick<TargetBookingRow, "guestBookingId" | "propertyId">,
  issuedAt: Date,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(issuedAt.getTime() + BOOKING_CONFIRMATION_TOKEN_TTL_MS).toISOString();
  await pool.query(
    `UPDATE booking.guest_bookings
        SET booking_metadata = jsonb_set(
              booking_metadata,
              '{confirmationTokens}',
              COALESCE(
                (
                  SELECT jsonb_object_agg(token.key, token.value)
                  FROM jsonb_each_text(
                    CASE
                      WHEN jsonb_typeof(booking_metadata -> 'confirmationTokens') = 'object'
                        THEN booking_metadata -> 'confirmationTokens'
                      ELSE '{}'::jsonb
                    END
                  ) token
                  WHERE token.value > $4::text
                ),
                '{}'::jsonb
              ) || jsonb_build_object($3::text, $5::text),
              true
            ),
            updated_at = $4::timestamptz
      WHERE property_id = $1::uuid AND id = $2::uuid`,
    [booking.propertyId, booking.guestBookingId, tokenHash, issuedAt.toISOString(), expiresAt],
  );
  return { token, expiresAt };
}

function assertTargetBookingConfirmationTokenActive(
  booking: Pick<TargetBookingRow, "bookingMetadata" | "createdAt">,
  tokenHash: string,
  now: Date,
): void {
  const metadata = objectValue(booking.bookingMetadata);
  const legacyTokenExpiresAt = stringValue(metadata["confirmationTokenExpiresAt"]);
  const createdAt = toIsoDateTime(booking.createdAt);
  const expiresAt =
    stringValue(objectValue(metadata["confirmationTokens"])[tokenHash]) ??
    (stringValue(metadata["confirmationTokenHash"]) === tokenHash
      ? (legacyTokenExpiresAt ??
        (createdAt
          ? new Date(Date.parse(createdAt) + BOOKING_CONFIRMATION_TOKEN_TTL_MS).toISOString()
          : null))
      : null);
  if (
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= now.getTime()
  ) {
    throw createHttpError(404, "Booking confirmation link has expired.");
  }
}

export function createUnavailableBookingWebCheckoutAdapter(): BookingWebCheckoutAdapter {
  return {
    async consumeLookupAttempt() {
      throw createHttpError(404, "Booking Web checkout adapter is not configured.");
    },
    async getCheckoutConfig() {
      throw createHttpError(404, "Booking Web checkout adapter is not configured.");
    },
    async createBooking() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async quoteBooking() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async confirmAuthorization() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async getStatus() {
      throw createHttpError(404, "Booking Web checkout adapter is not configured.");
    },
    async lookup() {
      throw createHttpError(404, "Booking Web checkout adapter is not configured.");
    },
    async withdraw() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async cancelPreview() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async cancel() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async previewChangeRequest() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async submitChangeRequest() {
      throw createHttpError(404, "Booking Web checkout command adapter is not configured.");
    },
    async getChangeRequest() {
      throw createHttpError(404, "Booking Web checkout adapter is not configured.");
    },
    async getPaymentInstructions() {
      throw createHttpError(404, "Booking-scoped payment instructions are not configured.");
    },
    async validatePromo(_slug, request) {
      const code = typeof request.code === "string" ? request.code.trim() : "";
      if (!code) {
        return { valid: false, code, message: "Promo code is required" };
      }
      throw createHttpError(404, "Booking Web promo validation adapter is not configured.");
    },
  };
}

async function resolveTargetCheckoutProperty(
  pool: BookingWebQueryExecutor,
  slug: string,
  requireBookable = false,
): Promise<TargetCheckoutPropertyRow> {
  const bookabilityPredicate = requireBookable
    ? `AND profile.freshness_status = 'fresh'
       AND profile.public_setup_completeness ->> 'status' = 'ready'
       AND jsonb_typeof(profile.capabilities -> 'paymentMethods') = 'array'
       AND jsonb_array_length(profile.capabilities -> 'paymentMethods') > 0`
    : "";
  const result = await pool.query<TargetCheckoutPropertyRow>(
    `SELECT
       p.id::text AS "propertyId",
       p.display_name AS "displayName",
       p.default_locale AS "defaultLocale",
       profile.timezone
     FROM hotel_catalog.property_slugs s
     JOIN hotel_catalog.properties p ON p.id = s.property_id
     JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = p.id
     WHERE s.slug = $1
       AND s.purpose = 'canonical'
       AND s.status = 'active'
       AND profile.public_visibility = 'public_safe'
       AND profile.profile_status = 'public'
       AND (profile.expires_at IS NULL OR profile.expires_at > now())
       ${bookabilityPredicate}
     LIMIT 1`,
    [slug],
  );
  const property = result.rows[0];
  if (!property) {
    throw createHttpError(404, "Booking Web hotel checkout target not found.");
  }
  return property;
}

async function resolveTargetHistoricalBookingProperty(
  pool: BookingWebQueryExecutor,
  slug: string,
): Promise<TargetCheckoutPropertyRow> {
  const result = await pool.query<TargetCheckoutPropertyRow>(
    `SELECT
       p.id::text AS "propertyId",
       p.display_name AS "displayName",
       p.default_locale AS "defaultLocale",
       COALESCE(profile.timezone, 'Etc/UTC') AS timezone
     FROM hotel_catalog.property_slugs s
     JOIN hotel_catalog.properties p ON p.id = s.property_id
     LEFT JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = p.id
     WHERE s.slug = $1
       AND s.purpose IN ('canonical', 'alias')
       AND s.status = 'active'
     LIMIT 1`,
    [slug],
  );
  const property = result.rows[0];
  if (!property) {
    throw createHttpError(404, "Booking Web hotel target not found.");
  }
  return property;
}

async function loadTargetCheckoutConfig(
  pool: BookingWebQueryExecutor,
  propertyId: string,
): Promise<TargetCheckoutConfigRow | null> {
  const result = await pool.query<TargetCheckoutConfigRow>(
    `SELECT
       p.id::text AS "propertyId",
       bs.acceptance_mode AS "acceptanceMode",
       bs.default_currency AS "defaultCurrency",
       bs.benefits,
       bs.show_addons_step AS "showAddonsStep",
       bs.group_addons_by_category AS "groupAddonsByCategory",
       bs.special_requests_enabled AS "specialRequestsEnabled",
       bs.arrival_time_enabled AS "arrivalTimeEnabled",
       bs.guest_count_enabled AS "guestCountEnabled",
       bs.phone_required AS "phoneRequired",
       bs.adult_age_threshold AS "adultAgeThreshold",
       bs.children_enabled AS "childrenEnabled",
       policy.terms_and_conditions AS "termsText",
       policy.cancellation_summary AS "cancellationPolicyText",
       fs.payments_enabled AS "paymentsEnabled",
       fs.accepted_methods AS "acceptedMethods",
       fs.deposit_policy AS "depositPolicy",
       fs.refund_policy AS "refundPolicy",
       fs.requires_manual_review AS "requiresManualReview",
       account.id::text AS "providerAccountId",
       account.provider_account_id AS "providerAccountRef",
       (
         account.provider = 'stripe'
         AND account.status = 'active'
         AND account.onboarding_status = 'completed'
         AND account.charges_enabled = TRUE
       ) AS "providerReady"
     FROM hotel_catalog.properties p
     LEFT JOIN booking.booking_settings bs ON bs.property_id = p.id
     LEFT JOIN hotel_catalog.property_policy_summaries policy ON policy.property_id = p.id
     LEFT JOIN finance.payment_settings fs ON fs.property_id = p.id
     LEFT JOIN finance.payment_provider_accounts account
       ON account.id = fs.provider_account_id
      AND account.property_id = p.id
     WHERE p.id = $1::uuid
     LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function serializeTargetCheckoutConfig(
  property: TargetCheckoutPropertyRow,
  row: TargetCheckoutConfigRow | null,
): Record<string, unknown> {
  const depositPolicy = objectValue(row?.depositPolicy);
  const methods = targetCheckoutSupportedPaymentMethods(row?.acceptedMethods).filter((method) => {
    if (method === "card") return row?.providerReady === true;
    if (method === "bank_transfer") {
      return bankTransferDetailsFromPolicy(depositPolicy) !== null;
    }
    if (method === "paypal") return isValidPaymentEmail(depositPolicy["paypalEmail"]);
    return true;
  });
  const refundPolicy = objectValue(row?.refundPolicy);
  return {
    hotelName: property.displayName,
    defaultCurrency: row?.defaultCurrency ?? "EUR",
    payAtPropertyEnabled: methods.includes("pay_at_property"),
    onlineCardPayment: methods.includes("card"),
    bankTransfer: methods.includes("bank_transfer"),
    paypalEnabled: methods.includes("paypal"),
    paypalPaymentWindowHours: boundedPaymentWindowHours(depositPolicy["paypalPaymentWindowHours"]),
    paymentsEnabled: (row?.paymentsEnabled ?? false) && methods.length > 0,
    acceptedPaymentMethods: methods,
    payAtHotelMethods: [
      ...(row?.acceptedMethods?.includes("cash") ? ["cash"] : []),
      ...(row?.acceptedMethods?.includes("manual_card") ? ["card"] : []),
    ],
    requiresManualReview: row?.requiresManualReview ?? false,
    showAddonsStep: row?.showAddonsStep ?? true,
    groupAddonsByCategory: row?.groupAddonsByCategory ?? true,
    specialRequestsEnabled: row?.specialRequestsEnabled ?? true,
    arrivalTimeEnabled: row?.arrivalTimeEnabled ?? false,
    guestCountEnabled: row?.guestCountEnabled ?? false,
    phoneRequired: row?.phoneRequired ?? true,
    adultAgeThreshold: row?.adultAgeThreshold ?? 18,
    childrenEnabled: row?.childrenEnabled ?? true,
    termsText: row?.termsText ?? "",
    cancellationPolicyText: row?.cancellationPolicyText ?? "",
    benefits: Array.isArray(row?.benefits) ? row?.benefits : [],
    cancellationSummary: stringValue(refundPolicy["summary"]),
    depositSummary: stringValue(depositPolicy["summary"]),
  };
}

function isValidPaymentEmail(value: unknown): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

async function createTargetCheckoutQuote(
  pool: BookingWebQueryExecutor,
  property: TargetCheckoutPropertyRow,
  request: BookingWebCheckoutRequest,
  requestedAt: Date,
): Promise<TargetCheckoutQuoteSnapshot> {
  const checkIn = dateField(request, "checkIn");
  const checkOut = dateField(request, "checkOut");
  if (!checkIn || !checkOut || checkIn >= checkOut) {
    throw createHttpError(400, "Valid check-in and check-out dates are required.");
  }
  if (checkIn < targetPropertyDateOnly(property.timezone, requestedAt)) {
    throw createHttpError(400, "checkIn cannot be in the past.");
  }
  const roomTypeId = stringField(request, "roomTypeId");
  if (!roomTypeId) {
    throw createHttpError(400, "roomTypeId is required for target checkout quotes.");
  }

  const settings = await loadTargetCheckoutConfig(pool, property.propertyId);
  const acceptanceMode = settings?.acceptanceMode === "request" ? "request" : "instant";
  const currency = uppercaseCurrency(
    stringField(request, "currency") ?? settings?.defaultCurrency ?? "EUR",
  );
  const adults = Math.max(integerField(request, "adults", 1), 1);
  const children = integerField(request, "children", 0);
  const roomCount = Math.max(
    integerField(request, "numberOfRooms", integerField(request, "roomCount", 1)),
    1,
  );
  const nights = dateRange(checkIn, checkOut).length;
  const rateType = canonicalTargetCheckoutRateType(stringField(request, "rateType"));
  const offer = await loadTargetCheckoutOffer(pool, {
    propertyId: property.propertyId,
    checkIn,
    checkOut,
    currency,
    adults,
    children,
    roomCount,
    nights,
    roomTypeId,
    rateType,
    requestedAt,
  });
  const paymentOptions = offer.paymentOptions ?? [];
  const paymentMethod =
    stringField(request, "paymentMethod") ??
    (paymentOptions.includes("pay_at_property")
      ? "pay_at_property"
      : (paymentOptions[0] ?? "pay_at_property"));
  if (paymentOptions.length > 0 && !paymentOptions.includes(paymentMethod)) {
    throw createHttpError(409, "Selected payment method is no longer available.");
  }

  const roomTotal = moneyNumber(offer.roomTotal) ?? 0;
  const taxesAndFees = moneyNumber(offer.taxesAndFees) ?? 0;
  const discounts = moneyNumber(offer.discounts) ?? 0;
  const totalAmount = roundMoney(roomTotal + taxesAndFees - discounts);
  // Manual payment methods do not capture a deposit during checkout, so the
  // full amount remains outstanding until the property verifies payment.
  const depositPercentage = 0;
  const depositRequired = false;
  const depositAmount = 0;
  const balanceAmount = totalAmount;
  const expiresAt = new Date(requestedAt.getTime() + 15 * 60 * 1000).toISOString();
  const selectedOfferSnapshot = {
    publicOfferKey: offer.publicOfferKey,
    roomTypeId: offer.roomTypeId,
    ratePlanId: offer.ratePlanId,
    rateType,
    roomName:
      stringValue(objectValue(offer.roomSummary)["name"]) ??
      stringValue(objectValue(offer.roomSummary)["roomTypeName"]) ??
      offer.publicOfferKey,
    roomSummary: objectValue(offer.roomSummary),
    rateSummary: objectValue(offer.rateSummary),
    occupancy: objectValue(offer.occupancy),
    publicPolicy: objectValue(offer.publicPolicy),
    paymentOptions,
    paymentMethod,
    acceptanceMode,
    availableRooms: integerValue(offer.availableRooms, roomCount),
    nightlyRoomAmounts: targetNightlyRoomAmounts(offer.nightlyRoomAmounts, checkIn, checkOut),
    sourceFreshness: objectValue(offer.sourceFreshness),
    generatedAt: toIsoDateTime(offer.generatedAt),
  };
  const totals = {
    currency,
    roomTotal,
    taxesAndFees,
    discounts,
    addonTotal: 0,
    promoDiscount: 0,
    totalAmount,
    depositRequired,
    depositPercentage,
    depositAmount,
    balanceAmount,
  };
  const requestHash = sha256Hex(
    stableJson({
      propertyId: property.propertyId,
      checkIn,
      checkOut,
      adults,
      children,
      roomCount,
      currency,
      roomTypeId,
      rateType,
      paymentMethod,
      acceptanceMode,
      promoCode: stringField(request, "promoCode"),
      referralCode: stringField(request, "referralCode"),
    }),
  );
  const publicQuoteReference = targetPublicReference("Q", [
    property.propertyId,
    requestHash,
    requestedAt.toISOString(),
  ]);
  const result = await pool.query<
    QueryResultRow & { quoteSessionId: string; publicQuoteReference: string }
  >(
    `INSERT INTO booking.quote_sessions
       (
         property_id,
         request_hash,
         public_quote_reference,
         requested_check_in,
         requested_check_out,
         adults,
         children,
         requested_room_count,
         currency,
         status,
         selected_offer_snapshot,
         totals,
         policy_snapshot,
         source_freshness,
         promo_code,
         referral_code,
         expires_at,
         created_at,
         updated_at
       )
     VALUES
       (
         $1::uuid,
         $2,
         $3,
         $4::date,
         $5::date,
         $6,
         $7,
         $8,
         $9,
         'active',
         $10::jsonb,
         $11::jsonb,
         $12::jsonb,
         $13::jsonb,
         $14,
         $15,
         $16::timestamptz,
         $17::timestamptz,
         $17::timestamptz
       )
     ON CONFLICT (public_quote_reference) DO NOTHING
     RETURNING id::text AS "quoteSessionId", public_quote_reference AS "publicQuoteReference"`,
    [
      property.propertyId,
      requestHash,
      publicQuoteReference,
      checkIn,
      checkOut,
      adults,
      children,
      roomCount,
      currency,
      JSON.stringify(selectedOfferSnapshot),
      JSON.stringify(totals),
      JSON.stringify(objectValue(offer.publicPolicy)),
      JSON.stringify(objectValue(offer.sourceFreshness)),
      stringField(request, "promoCode"),
      stringField(request, "referralCode"),
      expiresAt,
      requestedAt.toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }
  return {
    quoteSessionId: row.quoteSessionId,
    publicQuoteReference: row.publicQuoteReference,
    checkIn,
    checkOut,
    adults,
    children,
    roomCount,
    currency,
    totalAmount: totalAmount.toFixed(2),
    balanceAmount: balanceAmount.toFixed(2),
    paymentMethod,
    acceptanceMode,
    selectedOfferSnapshot,
    totals,
    policySnapshot: objectValue(offer.publicPolicy),
    expiresAt,
  };
}

async function loadTargetCheckoutOffer(
  pool: BookingWebQueryExecutor,
  input: {
    propertyId: string;
    checkIn: string;
    checkOut: string;
    currency: string;
    adults: number;
    children: number;
    roomCount: number;
    nights: number;
    roomTypeId: string;
    rateType: string;
    requestedAt: Date;
    availabilityCredit?: {
      checkIn: string;
      checkOut: string;
      roomCount: number;
    };
  },
): Promise<TargetCheckoutQuoteOfferRow> {
  const result = await pool.query<TargetCheckoutQuoteOfferRow>(
    `SELECT
       offer.public_offer_key AS "publicOfferKey",
       offer.room_type_id::text AS "roomTypeId",
       offer.rate_plan_id::text AS "ratePlanId",
       (array_agg(offer.room_summary ORDER BY offer.stay_date))[1] AS "roomSummary",
       (array_agg(offer.rate_summary ORDER BY offer.stay_date))[1] AS "rateSummary",
       (array_agg(offer.occupancy ORDER BY offer.stay_date))[1] AS occupancy,
       (array_agg(offer.public_policy ORDER BY offer.stay_date))[1] AS "publicPolicy",
       (jsonb_agg(offer.payment_options ORDER BY offer.stay_date)->0) AS "paymentOptions",
       MIN(
         offer.available_rooms + CASE
           WHEN $12::date IS NOT NULL
            AND offer.stay_date >= $12::date
            AND offer.stay_date < $13::date
             THEN $14::int
           ELSE 0
         END
       ) AS "availableRooms",
       jsonb_agg(jsonb_build_object(
         'stayDate', offer.stay_date, 'grossRoomAmount', offer.base_price_amount
       ) ORDER BY offer.stay_date) AS "nightlyRoomAmounts",
       SUM(offer.base_price_amount) * $7::int AS "roomTotal",
       SUM(offer.taxes_and_fees_amount) * $7::int AS "taxesAndFees",
       SUM(offer.discounts_amount) * $7::int AS discounts,
       offer.currency,
       MAX(offer.generated_at) AS "generatedAt",
       (array_agg(offer.source_freshness ORDER BY offer.stay_date DESC))[1] AS "sourceFreshness",
       profile.capabilities AS "profileCapabilities"
     FROM distribution.public_room_offer_snapshots offer
     JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = offer.property_id
     WHERE offer.property_id = $1::uuid
       AND profile.public_visibility = 'public_safe'
       AND profile.profile_status = 'public'
       AND profile.freshness_status = 'fresh'
       AND profile.public_setup_completeness ->> 'status' = 'ready'
       AND (profile.expires_at IS NULL OR profile.expires_at > $10::timestamptz)
       AND offer.public_visibility = 'public_safe'
       AND offer.stay_date >= $2::date
       AND offer.stay_date < $3::date
       AND offer.currency = $4
       AND offer.sellable_publicly = TRUE
       AND offer.availability_status IN ('available', 'limited')
       AND (
         offer.available_rooms + CASE
           WHEN $12::date IS NOT NULL
            AND offer.stay_date >= $12::date
            AND offer.stay_date < $13::date
             THEN $14::int
           ELSE 0
         END
       ) > 0
       AND offer.freshness_status = 'fresh'
       AND COALESCE((offer.occupancy ->> 'maxAdults')::int, $5::int) >= $5::int
       AND COALESCE((offer.occupancy ->> 'maxChildren')::int, $6::int) >= $6::int
       AND COALESCE((offer.occupancy ->> 'maxOccupancy')::int, $5::int + $6::int) >= ($5::int + $6::int)
       AND (offer.expires_at IS NULL OR offer.expires_at > $10::timestamptz)
       AND (offer.room_type_id::text = $8 OR offer.public_offer_key = $8)
       AND (
         $9 = ''
         OR lower(offer.public_offer_key) LIKE '%' || lower($9) || '%'
         OR lower(offer.rate_summary ->> 'name') LIKE '%' || lower($9) || '%'
         OR lower(offer.rate_summary ->> 'rateType') = lower($9)
         OR (
           $9 = 'non_refundable'
           AND (
             lower(offer.public_offer_key) LIKE '%:nrf'
             OR lower(offer.rate_summary ->> 'code') = 'nrf'
             OR lower(offer.rate_summary ->> 'refundable') = 'false'
           )
         )
         OR (
           $9 = 'flexible'
           AND (
             lower(offer.public_offer_key) LIKE '%:flex'
             OR lower(offer.rate_summary ->> 'code') IN ('flex', 'flexible')
             OR lower(offer.rate_summary ->> 'refundable') = 'true'
           )
         )
         OR offer.rate_plan_id::text = $9
       )
     GROUP BY
       offer.public_offer_key,
       offer.room_type_id,
       offer.rate_plan_id,
       offer.currency,
       profile.capabilities
     HAVING COUNT(DISTINCT offer.stay_date) = $11::int
        AND MIN(
          offer.available_rooms + CASE
            WHEN $12::date IS NOT NULL
             AND offer.stay_date >= $12::date
             AND offer.stay_date < $13::date
              THEN $14::int
            ELSE 0
          END
        ) >= $7::int
        AND COALESCE(
          MAX(NULLIF(offer.rate_summary ->> 'minStayNights', '')::integer)
            FILTER (WHERE offer.stay_date = $2::date),
          1
        ) <= $11::int
        AND (
          MAX(NULLIF(offer.rate_summary ->> 'maxStayNights', '')::integer)
            FILTER (WHERE offer.stay_date = $2::date) IS NULL
          OR MAX(NULLIF(offer.rate_summary ->> 'maxStayNights', '')::integer)
            FILTER (WHERE offer.stay_date = $2::date) >= $11::int
        )
     ORDER BY SUM(offer.base_price_amount), offer.public_offer_key
     LIMIT 1`,
    [
      input.propertyId,
      input.checkIn,
      input.checkOut,
      input.currency,
      input.adults,
      input.children,
      input.roomCount,
      input.roomTypeId,
      input.rateType,
      input.requestedAt.toISOString(),
      input.nights,
      input.availabilityCredit?.checkIn ?? null,
      input.availabilityCredit?.checkOut ?? null,
      input.availabilityCredit?.roomCount ?? 0,
    ],
  );
  const offer = result.rows[0];
  if (!offer) {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }
  const paymentOptions = targetCheckoutPaymentOptions(
    offer.paymentOptions,
    objectValue(offer.profileCapabilities),
  );
  if (paymentOptions.length === 0) {
    throw createHttpError(409, "Checkout payment methods are no longer available. Please refresh.");
  }
  return { ...offer, paymentOptions };
}

function targetCheckoutPaymentOptions(
  options: string[] | null,
  _capabilities: Record<string, unknown>,
): string[] {
  return targetCheckoutSupportedPaymentMethods(options);
}

function targetCheckoutSupportedPaymentMethods(options: string[] | null | undefined): string[] {
  return [
    ...new Set(
      (options ?? []).filter((option) =>
        TARGET_CHECKOUT_SUPPORTED_PAYMENT_METHODS.includes(
          option as (typeof TARGET_CHECKOUT_SUPPORTED_PAYMENT_METHODS)[number],
        ),
      ),
    ),
  ];
}

function assertTargetCheckoutConfigMatchesQuote(
  config: TargetCheckoutConfigRow | null,
  quote: TargetCheckoutQuoteSnapshot,
): void {
  const method = quote.paymentMethod === "cash" ? "pay_at_property" : quote.paymentMethod;
  const policy = objectValue(config?.depositPolicy);
  const accepted = config?.acceptedMethods ?? [];
  const methodReady =
    config?.paymentsEnabled === true &&
    Boolean(method) &&
    (method === "card"
      ? accepted.includes("card") && config?.providerReady === true
      : method === "pay_at_property"
        ? accepted.includes("pay_at_property") &&
          accepted.some((candidate) => candidate === "cash" || candidate === "manual_card")
        : method === "bank_transfer"
          ? accepted.includes("bank_transfer") && bankTransferDetailsFromPolicy(policy) !== null
          : method === "paypal"
            ? accepted.includes("paypal") && isValidPaymentEmail(policy["paypalEmail"])
            : false);
  if (!methodReady) {
    throw createHttpError(409, "Selected payment method is no longer available. Please refresh.");
  }
  if (uppercaseCurrency(config?.defaultCurrency ?? "") !== quote.currency) {
    throw createHttpError(409, "Property currency changed. Please refresh the checkout quote.");
  }
}

async function loadTargetCheckoutQuoteSnapshot(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  request: BookingWebCheckoutRequest,
  now: Date,
): Promise<TargetCheckoutQuoteSnapshot> {
  const quoteId = firstString(
    request["quoteId"],
    request["quoteReference"],
    request["publicQuoteReference"],
  );
  if (!quoteId) {
    throw createHttpError(400, "quoteId is required for target checkout booking creation.");
  }
  const result = await pool.query<TargetCheckoutQuoteRow>(
    `SELECT
       id::text AS "quoteSessionId",
       public_quote_reference AS "publicQuoteReference",
       requested_check_in::text AS "requestedCheckIn",
       requested_check_out::text AS "requestedCheckOut",
       adults,
       children,
       requested_room_count AS "roomCount",
       currency,
       status,
       selected_offer_snapshot AS "selectedOfferSnapshot",
       totals,
       policy_snapshot AS "policySnapshot",
       expires_at AS "expiresAt"
     FROM booking.quote_sessions
     WHERE property_id = $1::uuid
       AND (public_quote_reference = $2 OR id::text = $2)
       AND EXISTS (
         SELECT 1
         FROM distribution.public_hotel_bookability_profiles profile
         WHERE profile.property_id = booking.quote_sessions.property_id
           AND profile.public_visibility = 'public_safe'
           AND profile.profile_status = 'public'
           AND profile.freshness_status = 'fresh'
           AND profile.public_setup_completeness ->> 'status' = 'ready'
           AND (profile.expires_at IS NULL OR profile.expires_at > $3::timestamptz)
           AND profile.default_currency = booking.quote_sessions.currency
           AND profile.capabilities -> 'paymentMethods' ?
             (booking.quote_sessions.selected_offer_snapshot ->> 'paymentMethod')
           AND booking.quote_sessions.selected_offer_snapshot ->> 'paymentMethod'
             IN ('card', 'pay_at_property', 'cash', 'bank_transfer', 'paypal')
           AND EXISTS (
             SELECT 1
             FROM distribution.public_room_offer_snapshots offer
             WHERE offer.property_id = booking.quote_sessions.property_id
               AND offer.public_offer_key =
                 booking.quote_sessions.selected_offer_snapshot ->> 'publicOfferKey'
               AND offer.currency = booking.quote_sessions.currency
               AND offer.stay_date >= booking.quote_sessions.requested_check_in
               AND offer.stay_date < booking.quote_sessions.requested_check_out
               AND offer.public_visibility = 'public_safe'
               AND offer.sellable_publicly = TRUE
               AND offer.availability_status IN ('available', 'limited')
               AND offer.freshness_status = 'fresh'
               AND offer.payment_options @> ARRAY[
                 booking.quote_sessions.selected_offer_snapshot ->> 'paymentMethod'
               ]::text[]
               AND (offer.expires_at IS NULL OR offer.expires_at > $3::timestamptz)
             GROUP BY offer.public_offer_key
             HAVING count(DISTINCT offer.stay_date) =
               booking.quote_sessions.requested_check_out
                 - booking.quote_sessions.requested_check_in
           )
       )
     LIMIT 1`,
    [propertyId, quoteId, now.toISOString()],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }
  const expiresAt = toIsoDateTime(row.expiresAt);
  if (!expiresAt || new Date(expiresAt).getTime() <= now.getTime()) {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }

  const checkIn = dateOnly(row.requestedCheckIn);
  const checkOut = dateOnly(row.requestedCheckOut);
  const adults = Number(row.adults);
  const children = Number(row.children);
  const roomCount = Number(row.roomCount);
  const selectedOfferSnapshot = objectValue(row.selectedOfferSnapshot);
  const totals = objectValue(row.totals);
  const totalAmount = moneyString(totals["totalAmount"]);
  const balanceAmount = moneyString(totals["balanceAmount"]) ?? totalAmount;
  if (!totalAmount || !balanceAmount) {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }

  const requestedCheckIn = dateField(request, "checkIn");
  const requestedCheckOut = dateField(request, "checkOut");
  const requestedAdults = Math.max(integerField(request, "adults", 1), 1);
  const requestedChildren = integerField(request, "children", 0);
  const requestedRoomCount = Math.max(
    integerField(request, "numberOfRooms", integerField(request, "roomCount", 1)),
    1,
  );
  if (
    requestedCheckIn !== checkIn ||
    requestedCheckOut !== checkOut ||
    requestedAdults !== adults ||
    requestedChildren !== children ||
    requestedRoomCount !== roomCount
  ) {
    throw createHttpError(409, "Booking details changed. Please refresh the checkout quote.");
  }
  const requestedCurrency = stringField(request, "currency");
  if (requestedCurrency && uppercaseCurrency(requestedCurrency) !== row.currency) {
    throw createHttpError(409, "Booking currency changed. Please refresh the checkout quote.");
  }
  const requestedRoomTypeId = stringField(request, "roomTypeId");
  if (
    requestedRoomTypeId &&
    stringValue(selectedOfferSnapshot["roomTypeId"]) !== requestedRoomTypeId
  ) {
    throw createHttpError(409, "Booking room changed. Please refresh the checkout quote.");
  }
  const paymentMethod = stringValue(selectedOfferSnapshot["paymentMethod"]);
  const acceptanceMode = targetAcceptanceMode(selectedOfferSnapshot["acceptanceMode"]);
  assertTargetPaymentMethodReady(paymentMethod);
  const requestedPaymentMethod = stringField(request, "paymentMethod");
  if (paymentMethod && requestedPaymentMethod && paymentMethod !== requestedPaymentMethod) {
    throw createHttpError(
      409,
      "Booking payment method changed. Please refresh the checkout quote.",
    );
  }

  return {
    quoteSessionId: row.quoteSessionId,
    publicQuoteReference: row.publicQuoteReference,
    checkIn,
    checkOut,
    adults,
    children,
    roomCount,
    currency: row.currency,
    totalAmount,
    balanceAmount,
    paymentMethod,
    acceptanceMode,
    selectedOfferSnapshot,
    totals,
    policySnapshot: objectValue(row.policySnapshot),
    expiresAt,
  };
}

function serializeTargetCheckoutQuote(quote: TargetCheckoutQuoteSnapshot): Record<string, unknown> {
  const roomTotal = moneyNumber(quote.totals["roomTotal"]) ?? Number(quote.totalAmount);
  const totalAmount = Number(quote.totalAmount);
  const roomName =
    stringValue(quote.selectedOfferSnapshot["roomName"]) ??
    stringValue(quote.selectedOfferSnapshot["publicOfferKey"]) ??
    stringValue(quote.selectedOfferSnapshot["roomTypeId"]) ??
    "Room";

  return {
    quoteId: quote.publicQuoteReference,
    expiresAt: quote.expiresAt,
    roomTypeId: stringValue(quote.selectedOfferSnapshot["roomTypeId"]),
    roomName,
    rateType: publicTargetCheckoutRateType(
      stringValue(quote.selectedOfferSnapshot["rateType"]) ?? "flexible",
    ),
    paymentMethod: quote.paymentMethod ?? "pay_at_property",
    acceptanceMode: quote.acceptanceMode,
    nightlyRate: roundMoney(
      roomTotal / Math.max(dateRange(quote.checkIn, quote.checkOut).length, 1) / quote.roomCount,
    ),
    numberOfRooms: quote.roomCount,
    roomTotal,
    addonTotal: moneyNumber(quote.totals["addonTotal"]) ?? 0,
    promoCode: null,
    promoDiscount: moneyNumber(quote.totals["promoDiscount"]) ?? 0,
    lastMinuteDiscountPercent: 0,
    lastMinuteDiscountAmount: 0,
    totalAmount,
    currency: quote.currency,
    depositRequired: false,
    depositPercentage: 0,
    depositAmount: 0,
    balanceAmount: totalAmount,
  };
}

async function createTargetGuestBooking(
  pool: BookingWebQueryExecutor,
  inventoryReservationPort: DirectBookingInventoryReservationPort,
  property: TargetCheckoutPropertyRow,
  request: BookingWebCheckoutRequest,
  context: BookingWebCheckoutCommandContext,
  quote: TargetCheckoutQuoteSnapshot,
  guestPhone: string | null,
  billingConfig: BillingConfigReadModel | null,
  checkoutConfig: TargetCheckoutConfigRow | null,
): Promise<TargetBookingRow> {
  const { totalAmount, balanceAmount } = resolveTargetCheckoutAmountSnapshot(request, quote);
  const publicReference = await allocateTargetBookingPublicReference(pool, [
    property.propertyId,
    quote.quoteSessionId,
    context.fingerprint,
  ]);
  const roomTypeId = stringValue(quote.selectedOfferSnapshot["roomTypeId"]);
  const publicOfferKey = stringValue(quote.selectedOfferSnapshot["publicOfferKey"]);
  if (!roomTypeId || !publicOfferKey) {
    throw createHttpError(409, "Checkout quote inventory is no longer available. Please refresh.");
  }
  const inventoryReservation = await inventoryReservationPort.reserve({
    transaction: pool,
    propertyId: property.propertyId,
    quoteSessionId: quote.quoteSessionId,
    roomTypeId,
    publicOfferKey,
    checkIn: quote.checkIn,
    checkOut: quote.checkOut,
    roomCount: quote.roomCount,
    currency: quote.currency,
    occurredAt: context.occurredAt,
  });
  if (!inventoryReservation) {
    throw createHttpError(409, "Checkout quote inventory is no longer available. Please refresh.");
  }
  const depositPolicy = objectValue(checkoutConfig?.depositPolicy);
  const paypalPaymentWindowHours = boundedPaymentWindowHours(
    depositPolicy["paypalPaymentWindowHours"],
  );
  const paymentInstructions =
    quote.paymentMethod === "bank_transfer"
      ? { bankTransferDetails: bankTransferDetailsFromPolicy(depositPolicy) }
      : quote.paymentMethod === "paypal"
        ? {
            paypalEmail: stringValue(depositPolicy["paypalEmail"]),
            paypalPaymentWindowHours,
          }
        : null;
  const metadata = {
    targetSource: "booking_checkout_command",
    quoteReference: quote.publicQuoteReference,
    requestFingerprint: context.fingerprint,
    selectedOffer: quote.selectedOfferSnapshot,
    policySnapshot: quote.policySnapshot,
    paymentMethod: quote.paymentMethod,
    acceptanceMode: quote.acceptanceMode,
    pmsHandoffStatus: "pending_handoff",
    inventoryReservation,
    ...(quote.acceptanceMode === "request" &&
    (quote.paymentMethod === "card" ||
      quote.paymentMethod === "pay_at_property" ||
      quote.paymentMethod === "cash")
      ? {
          hostResponseDeadlineAt: new Date(
            context.occurredAt.getTime() + TARGET_REQUEST_HOST_RESPONSE_HOURS * 60 * 60 * 1000,
          ).toISOString(),
        }
      : {}),
    ...(paymentInstructions ? { paymentInstructions } : {}),
    ...(quote.paymentMethod === "bank_transfer" || quote.paymentMethod === "paypal"
      ? {
          pendingExpiresAt: new Date(
            context.occurredAt.getTime() +
              (quote.paymentMethod === "paypal" ? paypalPaymentWindowHours : 24) * 60 * 60 * 1000,
          ).toISOString(),
        }
      : {}),
  };

  const result = await pool.query<TargetBookingRow>(
    `WITH active_quote AS (
       SELECT quote.id
       FROM booking.quote_sessions quote
       WHERE quote.id = $29::uuid
         AND quote.property_id = $1::uuid
         AND quote.status = 'active'
       FOR UPDATE OF quote
     ),
     quote AS (
       UPDATE booking.quote_sessions quote
          SET status = 'converted',
              updated_at = $20::timestamptz
       FROM active_quote
       WHERE quote.id = active_quote.id
       RETURNING quote.id
     ),
     checkout AS (
       INSERT INTO booking.checkout_contexts
         (
           property_id,
           quote_session_id,
           locale,
           currency,
           status,
           guest_input,
           selected_addons,
           payment_context,
           promo_context,
           expires_at
         )
       SELECT
           $1::uuid,
           quote.id,
           $2,
           $3,
           'converted',
           $4::jsonb,
           $5::jsonb,
           $6::jsonb,
           $7::jsonb,
           $8::timestamptz
       FROM quote
       RETURNING id, quote_session_id
     ),
     booking_row AS (
       INSERT INTO booking.guest_bookings
         (
           property_id,
           quote_session_id,
           checkout_context_id,
           public_reference,
           source_system,
           lifecycle_status,
           payment_status,
           check_in,
           check_out,
           adults,
           children,
           room_count,
           currency,
           total_amount,
           balance_amount,
           booking_metadata,
           billing_plan_snapshot,
           commission_terms_snapshot,
           finance_terms_captured_at,
           created_at,
           updated_at
         )
       SELECT
         $1::uuid,
         checkout.quote_session_id,
         checkout.id,
         $9,
         'booking',
         $10,
         $11,
         $12::date,
         $13::date,
         $14,
         $15,
         $16,
         $3,
         $17::numeric,
         $18::numeric,
         $19::jsonb,
         $30,
         $31::jsonb,
         $20::timestamptz,
         $20::timestamptz,
         $20::timestamptz
       FROM checkout
       ON CONFLICT (public_reference) DO NOTHING
       RETURNING
         id::text AS "guestBookingId",
         property_id::text AS "propertyId",
         public_reference AS "publicReference",
         source_system AS "sourceSystem",
         lifecycle_status AS "lifecycleStatus",
         payment_status AS "paymentStatus",
         check_in::text AS "checkIn",
         check_out::text AS "checkOut",
         adults,
         children,
         room_count AS "roomCount",
         currency,
         total_amount AS "totalAmount",
         balance_amount AS "balanceAmount",
         booking_metadata AS "bookingMetadata",
         created_at AS "createdAt"
     ),
     booker AS (
       INSERT INTO booking.booking_guests
         (
           guest_booking_id,
           guest_role,
           first_name,
           last_name,
           email,
           phone,
           country_code,
           arrival_time,
           special_requests
         )
       SELECT
         booking_row."guestBookingId"::uuid,
         'booker',
         $21,
         $22,
         $23,
         $24,
         $25,
         $26,
         $27
       FROM booking_row
       ON CONFLICT DO NOTHING
     ),
     status_event AS (
       INSERT INTO booking.booking_status_events
         (
           guest_booking_id,
           event_type,
           to_status,
           actor_type,
           public_visible,
           public_message,
           event_payload,
           occurred_at
         )
       SELECT
         booking_row."guestBookingId"::uuid,
         'guest_booking.created',
         booking_row."lifecycleStatus",
         'guest',
         true,
         'Booking received.',
         $28::jsonb,
         $20::timestamptz
       FROM booking_row
       ON CONFLICT DO NOTHING
     ),
     summary AS (
       INSERT INTO booking.direct_booking_summary_read_model
         (
           guest_booking_id,
           property_id,
           public_reference,
           lifecycle_status,
           payment_status,
           check_in,
           check_out,
           guest_counts,
           room_summary,
           amount_summary,
           public_policy,
           source_freshness,
           projected_at
         )
       SELECT
         booking_row."guestBookingId"::uuid,
         booking_row."propertyId"::uuid,
         booking_row."publicReference",
         booking_row."lifecycleStatus",
         booking_row."paymentStatus",
         booking_row."checkIn"::date,
         booking_row."checkOut"::date,
         jsonb_build_object('adults', booking_row.adults, 'children', booking_row.children),
         jsonb_build_object('roomCount', booking_row."roomCount"),
         jsonb_build_object(
           'totalAmount', booking_row."totalAmount",
           'balanceAmount', booking_row."balanceAmount",
           'currency', booking_row.currency
         ),
         '{}'::jsonb,
         jsonb_build_object('booking_checkout', jsonb_build_object('status', 'fresh', 'snapshotAt', $20::text)),
         $20::timestamptz
       FROM booking_row
       ON CONFLICT (guest_booking_id) DO UPDATE
         SET lifecycle_status = EXCLUDED.lifecycle_status,
             payment_status = EXCLUDED.payment_status,
             projected_at = EXCLUDED.projected_at
     )
     SELECT * FROM booking_row`,
    [
      property.propertyId,
      stringField(request, "locale") ?? property.defaultLocale,
      quote.currency,
      JSON.stringify(redactGuestInput(request)),
      JSON.stringify(Array.isArray(request["selectedAddons"]) ? request["selectedAddons"] : []),
      JSON.stringify(objectValue(request["paymentContext"])),
      JSON.stringify(objectValue(request["promoContext"])),
      new Date(context.occurredAt.getTime() + 30 * 60 * 1000).toISOString(),
      publicReference,
      lifecycleStatusFromCheckout(quote),
      "unpaid",
      quote.checkIn,
      quote.checkOut,
      quote.adults,
      quote.children,
      quote.roomCount,
      totalAmount,
      balanceAmount,
      JSON.stringify(metadata),
      context.occurredAt.toISOString(),
      stringField(request, "firstName") ?? stringField(request, "guestFirstName") ?? "Guest",
      stringField(request, "lastName") ?? stringField(request, "guestLastName") ?? "Guest",
      stringField(request, "guestEmail") ?? stringField(request, "email"),
      guestPhone,
      uppercaseCountry(stringField(request, "country") ?? stringField(request, "countryCode")),
      stringField(request, "arrivalTime") ?? stringField(request, "estimatedArrivalTime"),
      stringField(request, "specialRequests"),
      JSON.stringify({ requestId: context.requestId, correlationId: context.correlationId }),
      quote.quoteSessionId,
      billingConfig?.activePlan ?? "commission",
      JSON.stringify(
        billingConfig
          ? {
              bookingEngineFeePercent: billingConfig.bookingEngineFeePercent,
              channelManagerFeePercent: billingConfig.channelManagerFeePercent,
              affiliatePlatformFeePercent: billingConfig.affiliatePlatformFeePercent,
              financeConfigUpdatedAt: billingConfig.updatedAt,
            }
          : {},
      ),
    ],
  );
  const booking = result.rows[0];
  if (!booking) {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }
  return booking;
}

async function createTargetCardPayment(
  client: BookingWebQueryExecutor,
  config: PgTargetBookingWebCheckoutAdapterConfig,
  booking: TargetBookingRow,
  checkoutConfig: TargetCheckoutConfigRow | null,
  billingConfig: BillingConfigReadModel | null,
  acceptanceMode: "instant" | "request",
  context: BookingWebCheckoutCommandContext,
): Promise<StripeBookingPaymentIntent> {
  if (
    !config.stripePaymentProvider ||
    checkoutConfig?.providerReady !== true ||
    !checkoutConfig.providerAccountId ||
    !checkoutConfig.providerAccountRef
  ) {
    throw createHttpError(503, "This property has not finished Stripe Connect setup.");
  }
  let amountMinor: number;
  let applicationFeeAmountMinor: number;
  try {
    amountMinor = stripeAmountMinor(decimalString(booking.totalAmount), booking.currency);
    applicationFeeAmountMinor = stripeApplicationFeeMinor(
      amountMinor,
      billingConfig?.activePlan,
      billingConfig?.bookingEngineFeePercent,
    );
  } catch (error) {
    throw createHttpError(
      409,
      error instanceof Error ? error.message : "Card currency is unsupported.",
    );
  }
  const paymentIdempotencyKey = targetCardPaymentIdempotencyKey(
    booking.propertyId,
    context.idempotencyKey,
  );
  let intent: StripeBookingPaymentIntent;
  try {
    intent = await config.stripePaymentProvider.createPaymentIntent({
      propertyId: booking.propertyId,
      bookingReference: booking.publicReference,
      providerAccountRef: checkoutConfig.providerAccountRef,
      amountMinor,
      applicationFeeAmountMinor,
      currency: booking.currency,
      captureMethod: acceptanceMode === "request" ? "manual" : "automatic",
      idempotencyKey: paymentIdempotencyKey,
    });
  } catch (error) {
    throw createHttpError(
      502,
      error instanceof Error ? error.message : "Stripe could not start card payment.",
    );
  }
  if (
    !intent.clientSecret ||
    intent.amountMinor !== amountMinor ||
    intent.currency !== booking.currency
  ) {
    throw createHttpError(502, "Stripe returned an invalid card payment authorization.");
  }
  await client.query(
    `INSERT INTO finance.payments (
       property_id, guest_booking_id, provider_account_id, source_system,
       idempotency_key, payment_kind, payment_method, status, amount,
       fee_amount, net_amount, refunded_amount, currency,
       provider_payment_intent_id, processor_fee_breakdown, payment_metadata, visibility_class,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'finance', $4, 'full', 'card',
       'requires_action', $5::numeric, $6::numeric, $7::numeric, 0, $8, $9,
       $10::jsonb, $11::jsonb, 'pms_finance', $12::timestamptz, $12::timestamptz
     )
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [
      booking.propertyId,
      booking.guestBookingId,
      checkoutConfig.providerAccountId,
      paymentIdempotencyKey,
      decimalString(booking.totalAmount),
      stripeAmountDecimal(applicationFeeAmountMinor, booking.currency),
      stripeAmountDecimal(amountMinor - applicationFeeAmountMinor, booking.currency),
      booking.currency,
      intent.paymentIntentId,
      JSON.stringify({
        contractVersion: "stripe-direct-charge.v1",
        status: "pending",
        currency: booking.currency,
      }),
      JSON.stringify({
        providerStatus: intent.status,
        captureMethod: acceptanceMode === "request" ? "manual" : "automatic",
        acceptanceMode,
        bookingReference: booking.publicReference,
        billingPlan: billingConfig?.activePlan ?? "commission",
        platformFeePercent:
          billingConfig?.activePlan === "commission" ? billingConfig.bookingEngineFeePercent : 0,
        chargeType: "direct",
        applicationFeeAmount: stripeAmountDecimal(applicationFeeAmountMinor, booking.currency),
        applicationFeeCurrency: booking.currency,
        reconciliationStatus: "pending",
      }),
      context.occurredAt.toISOString(),
    ],
  );
  await client.query(
    `UPDATE booking.guest_bookings
        SET booking_metadata = booking_metadata || $3::jsonb,
            updated_at = $4::timestamptz
      WHERE property_id = $1::uuid AND id = $2::uuid`,
    [
      booking.propertyId,
      booking.guestBookingId,
      JSON.stringify({ providerPaymentIntentId: intent.paymentIntentId }),
      context.occurredAt.toISOString(),
    ],
  );
  return intent;
}

export function targetCardPaymentIdempotencyKey(propertyId: string, checkoutKey: string): string {
  return `booking-card:${propertyId}:${sha256Hex(checkoutKey)}`;
}

async function hydrateTargetCardCheckoutReplay(
  client: BookingWebQueryExecutor,
  config: PgTargetBookingWebCheckoutAdapterConfig,
  propertyId: string,
  value: unknown,
  context: BookingWebCheckoutCommandContext,
): Promise<unknown> {
  const body = objectValue(value);
  const paymentIntentId = stringValue(body["providerPaymentIntentId"]);
  const stripeAccountId = stringValue(body["stripeAccountId"]);
  if (!paymentIntentId) return value;
  if (!config.stripePaymentProvider) {
    throw createHttpError(503, "Target card authorization is not configured.");
  }
  const intent = await config.stripePaymentProvider.retrievePaymentIntent(
    paymentIntentId,
    stripeAccountId,
  );
  const bookingId = stringValue(body["draftId"]);
  if (intent.status === "canceled") {
    return {
      ...body,
      clientSecret: null,
      authorizationComplete: false,
      authorizationExpired: true,
    };
  }
  if ((intent.status === "succeeded" || intent.status === "requires_capture") && bookingId) {
    const booking = await loadTargetHotelBooking(client, propertyId, bookingId, true);
    const payment = await loadTargetCardPayment(client, booking);
    const acceptanceMode = targetAcceptanceMode(
      objectValue(booking.bookingMetadata)["acceptanceMode"],
    );
    if (intent.status === "succeeded") {
      if (acceptanceMode === "request" && booking.paymentStatus !== "paid") {
        throw createHttpError(409, "Card payment was captured before booking acceptance.");
      }
      assertStripePaymentReady(booking, payment.providerAccountRef, intent, "instant");
      if (booking.paymentStatus !== "paid") {
        await settleStripeBookingPayment(client, {
          paymentIntentId,
          providerAccountRef: intent.providerAccountRef,
          amountMinor: intent.amountMinor,
          currency: intent.currency,
          occurredAt: context.occurredAt,
          correlationId: context.correlationId,
        });
      }
    } else {
      assertStripePaymentReady(booking, payment.providerAccountRef, intent, acceptanceMode);
      await authorizeStripeBookingPayment(client, {
        paymentIntentId,
        providerAccountRef: intent.providerAccountRef,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        occurredAt: context.occurredAt,
      });
    }
    await reconcileStripeBookingPaymentProviderDetails(client, intent, context.occurredAt);
    const finalized = await loadTargetHotelBooking(client, propertyId, bookingId);
    return {
      ...body,
      booking: serializeTargetBooking(finalized),
      clientSecret: null,
      authorizationComplete: true,
      pmsHandoff: {
        status: acceptanceMode === "request" ? "awaiting_acceptance" : "pending_handoff",
      },
    };
  }
  if (!intent.clientSecret)
    throw createHttpError(409, "Card payment authorization is unavailable.");
  return { ...body, clientSecret: intent.clientSecret };
}

async function loadTargetCardPayment(
  client: BookingWebQueryExecutor,
  booking: TargetBookingRow,
): Promise<TargetCardPaymentRow> {
  const result = await client.query<TargetCardPaymentRow>(
    `SELECT payment.id::text AS "paymentId",
            payment.provider_payment_intent_id AS "providerPaymentIntentId",
            payment.payment_metadata ->> 'cardBrand' AS "cardBrand",
            payment.payment_metadata ->> 'cardLast4' AS "cardLast4",
            payment.payment_metadata ->> 'chargeType' AS "chargeType",
            account.provider_account_id AS "providerAccountRef"
       FROM finance.payments payment
       JOIN finance.payment_provider_accounts account ON account.id = payment.provider_account_id
      WHERE payment.property_id = $1::uuid
        AND payment.guest_booking_id = $2::uuid
        AND payment.payment_method = 'card'
        AND payment.provider_payment_intent_id IS NOT NULL
      ORDER BY payment.created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [booking.propertyId, booking.guestBookingId],
  );
  const payment = result.rows[0];
  if (!payment) throw createHttpError(404, "Card payment authorization was not found.");
  return payment;
}

function assertStripePaymentReady(
  booking: TargetBookingRow,
  providerAccountRef: string,
  intent: StripeBookingPaymentIntent,
  acceptanceMode: "instant" | "request",
): void {
  const expectedAmount = stripeAmountMinor(decimalString(booking.totalAmount), booking.currency);
  if (
    intent.status !== (acceptanceMode === "request" ? "requires_capture" : "succeeded") ||
    intent.amountMinor !== expectedAmount ||
    intent.currency !== booking.currency ||
    intent.propertyId !== booking.propertyId ||
    intent.bookingReference !== booking.publicReference ||
    intent.providerAccountRef !== providerAccountRef
  ) {
    throw createHttpError(409, "Card payment authorization is not complete.");
  }
}

async function resolveTargetGuestPhone(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  request: BookingWebCheckoutRequest,
): Promise<string | null> {
  const settings = await loadTargetCheckoutConfig(pool, propertyId);
  const guestPhone = stringField(request, "phone") ?? stringField(request, "guestPhone");
  if ((settings?.phoneRequired ?? true) && !guestPhone) {
    throw createHttpError(400, "Guest phone is required.");
  }
  return guestPhone;
}

async function withGuestLifecycleMutation(
  pool: pg.Pool,
  inventoryReservationPort: DirectBookingInventoryReservationPort,
  slug: string,
  bookingId: string,
  request: BookingWebGuestActionRequest,
  context: BookingWebCheckoutCommandContext | undefined,
  mutation: { status: string; action: string; eventType: string },
): Promise<Record<string, unknown>> {
  if (!context) {
    throw createHttpError(400, "Checkout command context is required.");
  }
  return withTargetCheckoutTransaction(pool, async (client) => {
    const property = await resolveTargetHistoricalBookingProperty(client, slug);
    const reservation = await reserveTargetCheckoutCommand(client, property.propertyId, context);
    if (reservation.status === "replay") {
      return objectValue(reservation.body);
    }
    const booking = await loadTargetBooking(
      client,
      property.propertyId,
      bookingId,
      requireGuestEmail(request.guest_email),
    );
    assertLifecycleMutationAllowed(booking, mutation.action);
    if (mutation.action === "cancel") {
      resolveTargetCancellationPreview(booking, property.timezone, context.occurredAt);
    }
    const result = await client.query<TargetBookingRow>(
      `WITH updated AS (
         UPDATE booking.guest_bookings
            SET lifecycle_status = $3,
                cancellation_reason = COALESCE(cancellation_reason, $4),
                updated_at = $5::timestamptz
          WHERE id = $1::uuid
            AND property_id = $2::uuid
            AND lifecycle_status = $7
          RETURNING
            id::text AS "guestBookingId",
            property_id::text AS "propertyId",
            public_reference AS "publicReference",
            source_system AS "sourceSystem",
            lifecycle_status AS "lifecycleStatus",
            payment_status AS "paymentStatus",
            check_in::text AS "checkIn",
            check_out::text AS "checkOut",
            adults,
            children,
            room_count AS "roomCount",
            currency,
            total_amount AS "totalAmount",
            balance_amount AS "balanceAmount",
            booking_metadata AS "bookingMetadata",
            created_at AS "createdAt"
       ),
       status_event AS (
         INSERT INTO booking.booking_status_events
           (
             guest_booking_id,
             event_type,
             from_status,
             to_status,
             actor_type,
             public_visible,
             public_message,
             event_payload,
             occurred_at
           )
         SELECT
           updated."guestBookingId"::uuid,
           $6,
           $7,
           updated."lifecycleStatus",
           'guest',
           true,
           'Booking updated.',
           $8::jsonb,
           $5::timestamptz
         FROM updated
       )
       SELECT * FROM updated`,
      [
        booking.guestBookingId,
        property.propertyId,
        mutation.status,
        mutation.action,
        context.occurredAt.toISOString(),
        mutation.eventType,
        booking.lifecycleStatus,
        JSON.stringify({ requestId: context.requestId, correlationId: context.correlationId }),
      ],
    );
    const updated = result.rows[0];
    if (!updated) {
      throw createHttpError(409, "Booking status changed. Please refresh and try again.");
    }
    if (updated.sourceSystem === "booking") {
      await captureDirectNightlyRevenueEvidence(client, updated, {
        clear: true,
        fingerprint: context.fingerprint,
        recognizedOn: targetPropertyDateOnly(property.timezone, context.occurredAt),
        required: true,
      });
    }
    const currentReservation = inventoryReservationReceiptFromBookingMetadata(
      updated.bookingMetadata,
      updated.propertyId,
    );
    if (currentReservation) {
      await inventoryReservationPort.release({
        transaction: client,
        propertyId: updated.propertyId,
        reservation: currentReservation,
        occurredAt: context.occurredAt,
      });
    }
    await enqueuePmsReservationHandoff(client, property.propertyId, updated, context, "cancel");
    const body = serializeTargetBookingStatus(updated);
    await recordTargetCheckoutCommand(client, {
      propertyId: property.propertyId,
      context,
      resourceType: "guest_booking",
      resourceId: updated.guestBookingId,
      body,
    });
    return body;
  });
}

async function loadTargetBooking(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  referenceOrId: string,
  guestEmail: string | null,
  confirmationTokenHash: string | null = null,
): Promise<TargetBookingRow> {
  const result = await pool.query<TargetBookingRow>(
    `SELECT
       b.id::text AS "guestBookingId",
       b.property_id::text AS "propertyId",
       b.public_reference AS "publicReference",
       b.source_system AS "sourceSystem",
       property.display_name AS "hotelName",
       booker.first_name AS "guestFirstName",
       booker.last_name AS "guestLastName",
       booker.email AS "guestEmail",
       b.lifecycle_status AS "lifecycleStatus",
       b.payment_status AS "paymentStatus",
       b.check_in::text AS "checkIn",
       b.check_out::text AS "checkOut",
       b.adults,
       b.children,
       b.room_count AS "roomCount",
       b.currency,
       b.total_amount AS "totalAmount",
       b.balance_amount AS "balanceAmount",
       b.booking_metadata AS "bookingMetadata",
       b.expected_payment_method AS "expectedPaymentMethod",
       primary_assignment.assignment_status AS "operationalStatus",
       assigned_room_type.name AS "assignedRoomTypeName",
       assigned_units.unit_names AS "unitNames",
       cancellation.occurred_at AS "cancelledAt",
       card_payment.card_brand AS "cardBrand",
       card_payment.card_last4 AS "cardLast4",
       b.created_at AS "createdAt"
     FROM booking.guest_bookings b
     JOIN hotel_catalog.properties property
       ON property.id = b.property_id
     JOIN booking.booking_guests booker
       ON booker.guest_booking_id = b.id
      AND booker.guest_role = 'booker'
     LEFT JOIN LATERAL (
       SELECT assignment.assignment_status, assignment.room_type_id
       FROM pms.operational_booking_assignments assignment
       WHERE assignment.guest_booking_id = b.id
         AND assignment.property_id = b.property_id
       ORDER BY assignment.position, assignment.created_at, assignment.id
       LIMIT 1
     ) primary_assignment ON TRUE
     LEFT JOIN pms.room_types assigned_room_type
       ON assigned_room_type.id = primary_assignment.room_type_id
      AND assigned_room_type.property_id = b.property_id
     LEFT JOIN LATERAL (
       SELECT COALESCE(
         jsonb_agg(room.room_number ORDER BY assignment.position, assignment.created_at, assignment.id)
           FILTER (WHERE room.room_number IS NOT NULL),
         '[]'::jsonb
       ) AS unit_names
       FROM pms.operational_booking_assignments assignment
       LEFT JOIN pms.rooms room
         ON room.id = assignment.room_id
        AND room.property_id = assignment.property_id
       WHERE assignment.guest_booking_id = b.id
         AND assignment.property_id = b.property_id
     ) assigned_units ON TRUE
     LEFT JOIN LATERAL (
       SELECT event.occurred_at
       FROM booking.booking_status_events event
       WHERE event.guest_booking_id = b.id
         AND event.to_status = 'canceled'
       ORDER BY event.occurred_at DESC, event.id
       LIMIT 1
     ) cancellation ON TRUE
     LEFT JOIN LATERAL (
       SELECT payment.payment_metadata ->> 'cardBrand' AS card_brand,
              payment.payment_metadata ->> 'cardLast4' AS card_last4
       FROM finance.payments payment
       WHERE payment.property_id = b.property_id
         AND payment.guest_booking_id = b.id
         AND payment.payment_method = 'card'
       ORDER BY payment.created_at DESC
       LIMIT 1
     ) card_payment ON TRUE
     WHERE b.property_id = $1::uuid
       AND (b.id::text = $2 OR b.public_reference = $2)
       AND (
         ($3::text IS NOT NULL AND lower(booker.email) = lower($3))
         OR (
           $4::text IS NOT NULL
           AND (
             b.booking_metadata ->> 'confirmationTokenHash' = $4
             OR b.booking_metadata -> 'confirmationTokens' ? $4
           )
         )
       )
     LIMIT 1`,
    [propertyId, referenceOrId, guestEmail, confirmationTokenHash],
  );
  const booking = result.rows[0];
  if (!booking) {
    throw createHttpError(404, "Booking not found.");
  }
  return booking;
}

function serializeTargetBooking(booking: TargetBookingRow): Record<string, unknown> {
  const metadata = objectValue(booking.bookingMetadata);
  const selectedOffer = objectValue(metadata["selectedOffer"]);
  const paymentInstructions = objectValue(metadata["paymentInstructions"]);
  const nights = Math.max(dateRange(booking.checkIn, booking.checkOut).length, 1);
  const roomCount = Math.max(Number(booking.roomCount), 1);
  const totalAmount = Number(decimalString(booking.totalAmount));
  return {
    id: booking.guestBookingId,
    guestBookingId: booking.guestBookingId,
    bookingReference: booking.publicReference,
    hotelName: booking.hotelName ?? "",
    roomName:
      stringValue(selectedOffer["roomName"]) ??
      stringValue(selectedOffer["publicOfferKey"]) ??
      booking.assignedRoomTypeName ??
      "Room",
    guestFirstName: booking.guestFirstName ?? "",
    guestLastName: booking.guestLastName ?? "",
    guestEmail: booking.guestEmail ?? "",
    status: publicBookingLifecycleStatus(booking.lifecycleStatus, booking.operationalStatus),
    paymentStatus: booking.paymentStatus,
    checkIn: dateOnly(booking.checkIn),
    checkOut: dateOnly(booking.checkOut),
    nights,
    adults: booking.adults,
    children: booking.children,
    roomCount: booking.roomCount,
    numberOfRooms: booking.roomCount,
    nightlyRate: roundMoney(totalAmount / nights / roomCount),
    currency: booking.currency,
    totalAmount,
    balanceAmount: Number(decimalString(booking.balanceAmount)),
    paymentMethod:
      stringValue(metadata["paymentMethod"]) ??
      (booking.expectedPaymentMethod === "unknown" ? null : booking.expectedPaymentMethod),
    paymentDeadline:
      stringValue(metadata["acceptedPaymentDeadlineAt"]) ??
      stringValue(metadata["pendingExpiresAt"]),
    bankTransferDetails: stringValue(paymentInstructions["bankTransferDetails"]),
    unitNames: stringArray(booking.unitNames),
    cancelledAt: toIsoDateTime(booking.cancelledAt ?? null),
    cardBrand: booking.cardBrand ?? null,
    cardLast4: booking.cardLast4 ?? null,
    hostResponseDeadline:
      stringValue(metadata["hostResponseDeadlineAt"]) ?? stringValue(metadata["pendingExpiresAt"]),
    createdAt: toIsoDateTime(booking.createdAt),
  };
}

function publicBookingLifecycleStatus(status: string, operationalStatus?: string | null): string {
  if (operationalStatus === "checked_in" || operationalStatus === "in_house") {
    return "checked_in";
  }
  if (operationalStatus === "checked_out") return "checked_out";
  if (status === "canceled") return "cancelled";
  if (status === "pending_payment") return "pending";
  return status;
}

function serializeTargetBookingStatus(booking: TargetBookingRow): Record<string, unknown> {
  return {
    bookingReference: booking.publicReference,
    status: publicBookingLifecycleStatus(booking.lifecycleStatus, booking.operationalStatus),
    paymentStatus: booking.paymentStatus,
    checkIn: dateOnly(booking.checkIn),
    checkOut: dateOnly(booking.checkOut),
    currency: booking.currency,
    balanceAmount: Number(decimalString(booking.balanceAmount)),
  };
}

async function previewTargetDateChange(
  pool: BookingWebQueryExecutor,
  property: TargetCheckoutPropertyRow,
  booking: TargetBookingRow,
  request: BookingWebChangeRequest,
  requestedAt: Date,
): Promise<TargetDateChangePreview> {
  const oldTotal = Number(decimalString(booking.totalAmount));
  const blocked = (reason: string): TargetDateChangePreview => ({
    oldCheckIn: dateOnly(booking.checkIn),
    oldCheckOut: dateOnly(booking.checkOut),
    requestedCheckIn: request.checkIn ?? "",
    requestedCheckOut: request.checkOut ?? "",
    oldAddonIds: [],
    oldAddonQuantities: {},
    oldAddonDates: {},
    requestedAddonIds: request.addonIds ?? [],
    requestedAddonQuantities: request.addonQuantities ?? {},
    requestedAddonDates: request.addonDates ?? {},
    requestedAddonNames: [],
    oldTotal,
    newTotal: oldTotal,
    priceDifference: 0,
    currency: booking.currency,
    available: false,
    blocked: true,
    blockReason: reason,
    pricingSnapshot: null,
  });

  if (
    (request.addonIds?.length ?? 0) > 0 ||
    Object.keys(request.addonQuantities ?? {}).length > 0 ||
    Object.keys(request.addonDates ?? {}).length > 0
  ) {
    return blocked("Only booking date changes are supported right now.");
  }
  if (booking.lifecycleStatus !== "confirmed") {
    return blocked("This booking can no longer be changed.");
  }
  if (booking.paymentStatus !== "unpaid") {
    return blocked("Paid bookings require a payment adjustment and cannot be changed online yet.");
  }
  const paymentMethod = stringValue(objectValue(booking.bookingMetadata)["paymentMethod"]);
  if (paymentMethod !== "pay_at_property" && paymentMethod !== "cash") {
    return blocked("Only unpaid pay-at-property bookings can be changed online right now.");
  }
  const checkIn = normalizeDateOnly(request.checkIn);
  const checkOut = normalizeDateOnly(request.checkOut);
  if (!checkIn || !checkOut || checkIn >= checkOut) {
    return blocked("Valid check-in and check-out dates are required.");
  }
  if (checkIn < targetPropertyDateOnly(property.timezone, requestedAt)) {
    return blocked("Check-in cannot be in the past.");
  }
  if (checkIn === dateOnly(booking.checkIn) && checkOut === dateOnly(booking.checkOut)) {
    return blocked("Choose different dates before submitting a change request.");
  }
  const selectedOffer = objectValue(objectValue(booking.bookingMetadata)["selectedOffer"]);
  const publicOfferKey = stringValue(selectedOffer["publicOfferKey"]);
  const roomTypeId = stringValue(selectedOffer["roomTypeId"]);
  if (!publicOfferKey || !roomTypeId) {
    return blocked("The original room offer cannot be changed online. Contact the property.");
  }
  const availabilityCredit = targetInventoryAvailabilityCredit(
    booking,
    property.propertyId,
    roomTypeId,
    publicOfferKey,
  );
  if (!availabilityCredit) {
    return blocked("This booking's inventory reservation cannot be changed online.");
  }
  const rateType = canonicalTargetCheckoutRateType(
    stringValue(selectedOffer["rateType"]) ?? publicOfferKey,
  );

  try {
    const offer = await loadTargetCheckoutOffer(pool, {
      propertyId: property.propertyId,
      checkIn,
      checkOut,
      currency: booking.currency,
      adults: booking.adults,
      children: booking.children,
      roomCount: booking.roomCount,
      nights: dateRange(checkIn, checkOut).length,
      roomTypeId: publicOfferKey,
      rateType,
      requestedAt,
      availabilityCredit,
    });
    if (offer.publicOfferKey !== publicOfferKey || offer.roomTypeId !== roomTypeId) {
      return blocked("The original room offer is no longer available for those dates.");
    }
    const roomTotal = moneyNumber(offer.roomTotal) ?? 0;
    const taxesAndFees = moneyNumber(offer.taxesAndFees) ?? 0;
    const discounts = moneyNumber(offer.discounts) ?? 0;
    const newTotal = roundMoney(roomTotal + taxesAndFees - discounts);
    const refreshedSelectedOffer = {
      ...selectedOffer,
      publicOfferKey: offer.publicOfferKey,
      roomTypeId: offer.roomTypeId,
      ratePlanId: offer.ratePlanId,
      rateType,
      roomSummary: objectValue(offer.roomSummary),
      rateSummary: objectValue(offer.rateSummary),
      occupancy: objectValue(offer.occupancy),
      publicPolicy: objectValue(offer.publicPolicy),
      nightlyRoomAmounts: targetNightlyRoomAmounts(offer.nightlyRoomAmounts, checkIn, checkOut),
      sourceFreshness: objectValue(offer.sourceFreshness),
      generatedAt: toIsoDateTime(offer.generatedAt),
    };
    return {
      oldCheckIn: dateOnly(booking.checkIn),
      oldCheckOut: dateOnly(booking.checkOut),
      requestedCheckIn: checkIn,
      requestedCheckOut: checkOut,
      oldAddonIds: [],
      oldAddonQuantities: {},
      oldAddonDates: {},
      requestedAddonIds: [],
      requestedAddonQuantities: {},
      requestedAddonDates: {},
      requestedAddonNames: [],
      oldTotal,
      newTotal,
      priceDifference: roundMoney(newTotal - oldTotal),
      currency: booking.currency,
      available: true,
      blocked: false,
      blockReason: null,
      pricingSnapshot: {
        selectedOffer: refreshedSelectedOffer,
        roomTotal,
        taxesAndFees,
        discounts,
        totalAmount: newTotal,
        balanceAmount: newTotal,
        generatedAt: requestedAt.toISOString(),
      },
    };
  } catch (error) {
    if (isHttpError(error) && (error.statusCode === 404 || error.statusCode === 409)) {
      return blocked("The requested dates are no longer available for this room and rate.");
    }
    throw error;
  }
}

async function lockTargetBookingChangeRequests(
  pool: BookingWebQueryExecutor,
  booking: TargetBookingRow,
): Promise<void> {
  await pool.query(
    `SELECT id
       FROM booking.guest_bookings
      WHERE id = $1::uuid
      FOR UPDATE`,
    [booking.guestBookingId],
  );
}

function targetInventoryAvailabilityCredit(
  booking: TargetBookingRow,
  propertyId: string,
  roomTypeId: string,
  publicOfferKey: string,
): { checkIn: string; checkOut: string; roomCount: number } | undefined {
  const marker = objectValue(objectValue(booking.bookingMetadata)["inventoryReservation"]);
  if (
    marker["owner"] !== "pms" ||
    marker["source"] !== "booking_engine" ||
    stringValue(marker["propertyId"]) !== propertyId ||
    stringValue(marker["roomTypeId"]) !== roomTypeId ||
    stringValue(marker["publicOfferKey"]) !== publicOfferKey
  ) {
    return undefined;
  }
  const checkIn = normalizeDateOnly(stringValue(marker["checkIn"]) ?? undefined);
  const checkOut = normalizeDateOnly(stringValue(marker["checkOut"]) ?? undefined);
  const roomCount = integerValue(marker["roomCount"], 0);
  if (!checkIn || !checkOut || checkIn >= checkOut || roomCount < 1) return undefined;
  return { checkIn, checkOut, roomCount };
}

async function loadPendingTargetChangeRequest(
  pool: BookingWebQueryExecutor,
  guestBookingId: string,
): Promise<TargetChangeRequestRow | null> {
  const result = await pool.query<TargetChangeRequestRow>(
    `SELECT
       id::text AS id,
       guest_booking_id::text AS "guestBookingId",
       status,
       requested_changes AS "requestedChanges",
       decision_note AS "decisionNote",
       decided_at AS "decidedAt",
       created_at AS "createdAt"
     FROM booking.booking_change_requests
     WHERE guest_booking_id = $1::uuid
       AND request_type = 'date_change'
       AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [guestBookingId],
  );
  return result.rows[0] ?? null;
}

async function insertTargetChangeRequest(
  pool: BookingWebQueryExecutor,
  booking: TargetBookingRow,
  preview: TargetDateChangePreview,
): Promise<TargetChangeRequestRow> {
  const result = await pool.query<TargetChangeRequestRow>(
    `INSERT INTO booking.booking_change_requests
       (guest_booking_id, request_type, requested_by, status, requested_changes)
     VALUES
       ($1::uuid, 'date_change', 'guest', 'pending', $2::jsonb)
     RETURNING
       id::text AS id,
       guest_booking_id::text AS "guestBookingId",
       status,
       requested_changes AS "requestedChanges",
       decision_note AS "decisionNote",
       decided_at AS "decidedAt",
       created_at AS "createdAt"`,
    [booking.guestBookingId, JSON.stringify(preview)],
  );
  const changeRequest = result.rows[0];
  if (!changeRequest) throw createHttpError(409, "Booking change request could not be saved.");
  return changeRequest;
}

function serializeTargetChangeRequest(row: TargetChangeRequestRow): Record<string, unknown> {
  const snapshot = objectValue(row.requestedChanges);
  return {
    id: row.id,
    bookingId: row.guestBookingId,
    status: publicTargetChangeRequestStatus(row.status),
    oldCheckIn: stringValue(snapshot["oldCheckIn"]) ?? "",
    oldCheckOut: stringValue(snapshot["oldCheckOut"]) ?? "",
    oldAddonIds: stringArray(snapshot["oldAddonIds"]),
    oldAddonQuantities: numericObject(snapshot["oldAddonQuantities"]),
    oldAddonDates: dateArrayObject(snapshot["oldAddonDates"]),
    oldTotal: moneyNumber(snapshot["oldTotal"]) ?? 0,
    requestedCheckIn: stringValue(snapshot["requestedCheckIn"]) ?? "",
    requestedCheckOut: stringValue(snapshot["requestedCheckOut"]) ?? "",
    requestedAddonIds: stringArray(snapshot["requestedAddonIds"]),
    requestedAddonQuantities: numericObject(snapshot["requestedAddonQuantities"]),
    requestedAddonDates: dateArrayObject(snapshot["requestedAddonDates"]),
    requestedAddonNames: stringArray(snapshot["requestedAddonNames"]),
    newTotal: moneyNumber(snapshot["newTotal"]) ?? 0,
    priceDifference: numberValue(snapshot["priceDifference"]) ?? 0,
    currency: stringValue(snapshot["currency"]) ?? "EUR",
    declineReason: row.decisionNote,
    decidedAt: toIsoDateTime(row.decidedAt),
    createdAt: toIsoDateTime(row.createdAt) ?? "",
  };
}

function publicTargetChangeRequestStatus(status: string): string {
  if (status === "accepted") return "approved";
  if (status === "canceled") return "cancelled";
  return status;
}

function serializeTargetDateChangePreview(
  preview: TargetDateChangePreview,
): Record<string, unknown> {
  const { pricingSnapshot: _pricingSnapshot, ...publicPreview } = preview;
  return publicPreview;
}

async function loadTargetHotelBooking(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  bookingId: string,
  forUpdate = false,
): Promise<TargetBookingRow> {
  const result = await pool.query<TargetBookingRow>(
    `SELECT
       booking.id::text AS "guestBookingId",
       booking.property_id::text AS "propertyId",
       booking.public_reference AS "publicReference",
       booking.source_system AS "sourceSystem",
       booking.lifecycle_status AS "lifecycleStatus",
       booking.payment_status AS "paymentStatus",
       booking.check_in::text AS "checkIn",
       booking.check_out::text AS "checkOut",
       booking.adults,
       booking.children,
       booking.room_count AS "roomCount",
       booking.currency,
       booking.total_amount AS "totalAmount",
       booking.balance_amount AS "balanceAmount",
       booking.booking_metadata AS "bookingMetadata",
       card_payment.card_brand AS "cardBrand",
       card_payment.card_last4 AS "cardLast4",
       booking.created_at AS "createdAt"
     FROM booking.guest_bookings booking
     LEFT JOIN LATERAL (
       SELECT payment.payment_metadata ->> 'cardBrand' AS card_brand,
              payment.payment_metadata ->> 'cardLast4' AS card_last4
       FROM finance.payments payment
       WHERE payment.property_id = booking.property_id
         AND payment.guest_booking_id = booking.id
         AND payment.payment_method = 'card'
       ORDER BY payment.created_at DESC
       LIMIT 1
     ) card_payment ON TRUE
     WHERE booking.property_id = $1::uuid
       AND (booking.id::text = $2 OR booking.public_reference = $2)
     LIMIT 1
     ${forUpdate ? "FOR UPDATE OF booking" : ""}`,
    [propertyId, bookingId],
  );
  const booking = result.rows[0];
  if (!booking) throw createHttpError(404, "Booking not found.");
  return booking;
}

async function loadTargetPropertyById(
  pool: BookingWebQueryExecutor,
  propertyId: string,
): Promise<TargetCheckoutPropertyRow> {
  const result = await pool.query<TargetCheckoutPropertyRow>(
    `SELECT
       property.id::text AS "propertyId",
       property.display_name AS "displayName",
       property.default_locale AS "defaultLocale",
       COALESCE(profile.timezone, 'Etc/UTC') AS timezone
     FROM hotel_catalog.properties property
     LEFT JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = property.id
     WHERE property.id = $1::uuid
     LIMIT 1`,
    [propertyId],
  );
  const property = result.rows[0];
  if (!property) throw createHttpError(404, "Booking property not found.");
  return property;
}

async function loadLatestTargetChangeRequest(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  bookingId: string,
): Promise<TargetChangeRequestRow | null> {
  const result = await pool.query<TargetChangeRequestRow>(
    `SELECT
       change_request.id::text AS id,
       change_request.guest_booking_id::text AS "guestBookingId",
       change_request.status,
       change_request.requested_changes AS "requestedChanges",
       change_request.decision_note AS "decisionNote",
       change_request.decided_at AS "decidedAt",
       change_request.created_at AS "createdAt"
     FROM booking.booking_change_requests change_request
     JOIN booking.guest_bookings booking
       ON booking.id = change_request.guest_booking_id
     WHERE booking.property_id = $1::uuid
       AND (booking.id::text = $2 OR booking.public_reference = $2)
       AND change_request.request_type = 'date_change'
     ORDER BY change_request.created_at DESC
     LIMIT 1`,
    [propertyId, bookingId],
  );
  return result.rows[0] ?? null;
}

async function loadTargetChangeRequestForHotelById(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  bookingId: string,
  changeRequestId: string,
  forUpdate = false,
): Promise<TargetChangeRequestRow | null> {
  const result = await pool.query<TargetChangeRequestRow>(
    `SELECT
       change_request.id::text AS id,
       change_request.guest_booking_id::text AS "guestBookingId",
       change_request.status,
       change_request.requested_changes AS "requestedChanges",
       change_request.decision_note AS "decisionNote",
       change_request.decided_at AS "decidedAt",
       change_request.created_at AS "createdAt"
     FROM booking.booking_change_requests change_request
     JOIN booking.guest_bookings booking
       ON booking.id = change_request.guest_booking_id
     WHERE booking.property_id = $1::uuid
       AND booking.id = $2::uuid
       AND change_request.id = $3::uuid
       AND change_request.request_type = 'date_change'
     LIMIT 1
     ${forUpdate ? "FOR UPDATE OF change_request" : ""}`,
    [propertyId, bookingId, changeRequestId],
  );
  return result.rows[0] ?? null;
}

async function loadChangeRequestById(
  pool: BookingWebQueryExecutor,
  changeRequestId: string,
): Promise<TargetChangeRequestRow | null> {
  const result = await pool.query<TargetChangeRequestRow>(
    `SELECT
       id::text AS id,
       guest_booking_id::text AS "guestBookingId",
       status,
       requested_changes AS "requestedChanges",
       decision_note AS "decisionNote",
       decided_at AS "decidedAt",
       created_at AS "createdAt"
     FROM booking.booking_change_requests
     WHERE id = $1::uuid
     LIMIT 1`,
    [changeRequestId],
  );
  return result.rows[0] ?? null;
}

function targetDateChangeRequestFromSnapshot(snapshotValue: unknown): BookingWebChangeRequest {
  const snapshot = objectValue(snapshotValue);
  return {
    checkIn: stringValue(snapshot["requestedCheckIn"]) ?? undefined,
    checkOut: stringValue(snapshot["requestedCheckOut"]) ?? undefined,
    addonIds: stringArray(snapshot["requestedAddonIds"]),
    addonQuantities: numericObject(snapshot["requestedAddonQuantities"]),
    addonDates: dateArrayObject(snapshot["requestedAddonDates"]),
  };
}

function assertTargetDateChangeDecisionAllowed(booking: TargetBookingRow): void {
  if (booking.lifecycleStatus !== "confirmed") {
    throw createHttpError(409, "Only confirmed bookings can be changed.");
  }
  if (booking.paymentStatus !== "unpaid") {
    throw createHttpError(
      409,
      "Paid bookings require a payment adjustment and cannot be changed online yet.",
    );
  }
  const paymentMethod = stringValue(objectValue(booking.bookingMetadata)["paymentMethod"]);
  if (paymentMethod !== "pay_at_property" && paymentMethod !== "cash") {
    throw createHttpError(
      409,
      "Only unpaid pay-at-property bookings can be changed online right now.",
    );
  }
}

function assertTargetDateChangePriceUnchanged(
  snapshotValue: unknown,
  preview: TargetDateChangePreview,
): void {
  const snapshot = objectValue(snapshotValue);
  const submittedTotal = moneyNumber(snapshot["newTotal"]);
  const currency = stringValue(snapshot["currency"]);
  if (submittedTotal !== preview.newTotal || currency !== preview.currency) {
    throw createHttpError(
      409,
      "The price for the requested dates changed. Ask the guest to submit a new request.",
    );
  }
}

async function applyAcceptedTargetDateChange(
  pool: BookingWebQueryExecutor,
  input: {
    booking: TargetBookingRow;
    changeRequest: TargetChangeRequestRow;
    preview: TargetDateChangePreview;
    selectedOffer: Record<string, unknown>;
    inventoryReservation: Record<string, unknown>;
    context: BookingHotelChangeDecisionContext;
  },
): Promise<TargetBookingRow> {
  const metadata = {
    ...objectValue(input.booking.bookingMetadata),
    selectedOffer: input.selectedOffer,
    inventoryReservation: input.inventoryReservation,
    lastAcceptedChangeRequestId: input.changeRequest.id,
  };
  const result = await pool.query<TargetBookingRow>(
    `WITH accepted AS (
       UPDATE booking.booking_change_requests change_request
          SET status = 'accepted',
              decision_actor_user_id = $3::uuid,
              decided_at = $4::timestamptz,
              updated_at = $4::timestamptz
        WHERE change_request.id = $2::uuid
          AND change_request.guest_booking_id = $1::uuid
          AND change_request.status = 'pending'
      RETURNING change_request.id
     ),
     updated AS (
       UPDATE booking.guest_bookings booking
          SET check_in = $5::date,
              check_out = $6::date,
              total_amount = $7::numeric,
              balance_amount = $7::numeric,
              booking_metadata = $8::jsonb,
              updated_at = $4::timestamptz
         FROM accepted
        WHERE booking.id = $1::uuid
          AND booking.property_id = $9::uuid
          AND booking.lifecycle_status = 'confirmed'
          AND booking.payment_status = 'unpaid'
      RETURNING
        booking.id::text AS "guestBookingId",
        booking.property_id::text AS "propertyId",
        booking.public_reference AS "publicReference",
        booking.source_system AS "sourceSystem",
        booking.lifecycle_status AS "lifecycleStatus",
        booking.payment_status AS "paymentStatus",
        booking.check_in::text AS "checkIn",
        booking.check_out::text AS "checkOut",
        booking.adults,
        booking.children,
        booking.room_count AS "roomCount",
        booking.currency,
        booking.total_amount AS "totalAmount",
        booking.balance_amount AS "balanceAmount",
        booking.booking_metadata AS "bookingMetadata",
        booking.created_at AS "createdAt"
     ),
     status_event AS (
       INSERT INTO booking.booking_status_events
         (guest_booking_id, event_type, from_status, to_status, actor_type,
          actor_user_id, public_visible, public_message, event_payload, occurred_at)
       SELECT
         updated."guestBookingId"::uuid,
         'guest_booking.change_accepted',
         'confirmed',
         'confirmed',
         'property_user',
         $3::uuid,
         true,
         'Booking dates updated.',
         $10::jsonb,
         $4::timestamptz
       FROM updated
     ),
     summary AS (
       UPDATE booking.direct_booking_summary_read_model summary
          SET check_in = updated."checkIn"::date,
              check_out = updated."checkOut"::date,
              amount_summary = jsonb_build_object(
                'totalAmount', updated."totalAmount",
                'balanceAmount', updated."balanceAmount",
                'currency', updated.currency
              ),
              projected_at = $4::timestamptz
         FROM updated
        WHERE summary.guest_booking_id = updated."guestBookingId"::uuid
     )
     SELECT * FROM updated`,
    [
      input.booking.guestBookingId,
      input.changeRequest.id,
      input.context.actorUserId,
      input.context.occurredAt.toISOString(),
      input.preview.requestedCheckIn,
      input.preview.requestedCheckOut,
      input.preview.newTotal.toFixed(2),
      JSON.stringify(metadata),
      input.booking.propertyId,
      JSON.stringify({
        requestId: input.context.requestId,
        correlationId: input.context.correlationId,
        changeRequestId: input.changeRequest.id,
        oldCheckIn: input.preview.oldCheckIn,
        oldCheckOut: input.preview.oldCheckOut,
        requestedCheckIn: input.preview.requestedCheckIn,
        requestedCheckOut: input.preview.requestedCheckOut,
        oldTotal: input.preview.oldTotal,
        newTotal: input.preview.newTotal,
        currency: input.preview.currency,
      }),
    ],
  );
  const updated = result.rows[0];
  if (!updated) throw createHttpError(409, "Booking change request status changed.");
  return updated;
}

async function validateTargetPromo(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  code: string,
): Promise<Record<string, unknown>> {
  const result = await pool.query<{
    promoCode: string;
    discountAmount: string | number;
    currency: string;
  }>(
    `SELECT promo_code AS "promoCode", discount_amount AS "discountAmount", currency
       FROM booking.promo_applications
      WHERE property_id = $1::uuid
        AND lower(promo_code) = lower($2)
        AND application_status = 'applied'
      ORDER BY created_at DESC
      LIMIT 1`,
    [propertyId, code],
  );
  const promo = result.rows[0];
  return promo
    ? {
        valid: true,
        code: promo.promoCode,
        discountAmount: Number(decimalString(promo.discountAmount)),
        currency: promo.currency,
      }
    : { valid: false, code, message: "Promo code is not active for this property." };
}

async function enqueuePmsReservationHandoff(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  booking: TargetBookingRow,
  context: BookingWebCheckoutCommandContext,
  operation: "create" | "update" | "cancel",
  options: { revision?: string; actorType?: "guest" | "property_user" } = {},
): Promise<void> {
  const revision = options.revision ?? "v1";
  const handoffKey = pmsReservationHandoffIdempotencyKey(
    propertyId,
    booking.guestBookingId,
    operation,
    revision,
  );
  await pool.query(
    `INSERT INTO platform.jobs
       (
         job_key,
         queue_name,
         job_type,
         tenant_scope,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
     VALUES
       (
         $1,
         'pms-reservation-handoff',
         $2,
         'property',
         $3::uuid,
         'booking',
         'guest_booking',
         $4,
         $5,
         $6,
         $7::jsonb,
         $8::jsonb
       )
     ON CONFLICT (queue_name, job_key) DO NOTHING`,
    [
      operation === "create"
        ? pmsCreateJobKey(booking.guestBookingId)
        : `booking-checkout:${operation}:${booking.guestBookingId}:${revision}:${context.fingerprint}`,
      `pms.reservation.${operation}`,
      propertyId,
      booking.guestBookingId,
      context.correlationId,
      sha256Hex(handoffKey),
      JSON.stringify({
        operation,
        contractVersion: "pms-reservation.v1",
        commandId: `cmd_pms_${operation}_${sha256Hex(handoffKey).slice(0, 24)}`,
        idempotencyKey: handoffKey,
        audit: {
          requestId: context.requestId,
          correlationId: context.correlationId,
          propertyId,
          actorType: options.actorType ?? "guest",
          source: "booking_engine",
          occurredAt: context.occurredAt.toISOString(),
        },
        propertyId,
        guestBookingId: booking.guestBookingId,
        bookingReference: booking.publicReference,
        stay: {
          checkInDate: dateOnly(booking.checkIn),
          checkOutDate: dateOnly(booking.checkOut),
          adults: booking.adults,
          children: booking.children,
          numberOfRooms: booking.roomCount,
        },
        payment: {
          paymentStatus: booking.paymentStatus,
          balanceAmount: {
            amountDecimal: decimalString(booking.balanceAmount),
            currency: booking.currency,
          },
        },
        pricing: {
          grandTotal: {
            amountDecimal: decimalString(booking.totalAmount),
            currency: booking.currency,
          },
        },
      }),
      JSON.stringify({
        requestId: context.requestId,
        occurredAt: context.occurredAt.toISOString(),
        source: "apps/api-booking-web-public",
      }),
    ],
  );
}

const TARGET_BOOKING_CHANGE_DECISION_OPERATION = "booking.change-request.decision";

type TargetBookingChangeDecisionInput = BookingHotelChangeDecisionBinding & {
  context: BookingHotelChangeDecisionContext;
};

async function reserveTargetBookingChangeDecision(
  pool: BookingWebQueryExecutor,
  input: TargetBookingChangeDecisionInput,
): Promise<TargetBookingChangeDecisionReservation> {
  const fingerprint = bookingHotelChangeDecisionFingerprint(input);
  if (input.context.fingerprint !== fingerprint) {
    throw createHttpError(409, "Booking change decision fingerprint mismatch.");
  }

  const keyHash = sha256Hex(input.context.idempotencyKey);
  const binding = {
    propertyId: input.propertyId,
    bookingId: input.bookingId,
    changeRequestId: input.changeRequestId,
    decision: input.decision,
    note: input.note,
  };
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         property_id,
         correlation_id,
         expires_at,
         idempotency_metadata
       )
     VALUES
       (
         'booking',
         $1,
         $2,
         $3,
         'in_progress',
         'property',
         $4::uuid,
         $5,
         $6::timestamptz,
         $7::jsonb
       )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      TARGET_BOOKING_CHANGE_DECISION_OPERATION,
      keyHash,
      fingerprint,
      input.propertyId,
      input.context.correlationId,
      new Date(input.context.occurredAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({
        requestId: input.context.requestId,
        source: "apps/api-booking-change-decision",
        binding,
      }),
    ],
  );
  if (inserted.rows[0]) return { status: "reserved" };

  const existing = await pool.query<{
    requestFingerprintHash: string;
    status: string;
    idempotencyMetadata: unknown;
  }>(
    `SELECT
       request_fingerprint_hash AS "requestFingerprintHash",
       status,
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'booking'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     LIMIT 1`,
    [TARGET_BOOKING_CHANGE_DECISION_OPERATION, keyHash, input.propertyId],
  );
  const row = existing.rows[0];
  if (!row) throw createHttpError(409, "Booking change decision is already in progress.");
  if (row.requestFingerprintHash !== fingerprint) {
    throw createHttpError(409, "Idempotency key was already used for a different request.");
  }
  if (row.status === "completed") {
    const metadata = objectValue(row.idempotencyMetadata);
    if (Object.prototype.hasOwnProperty.call(metadata, "responseBody")) {
      return { status: "replay", body: metadata["responseBody"] };
    }
    throw createHttpError(409, "Completed booking change decision is unavailable for replay.");
  }
  throw createHttpError(409, "Booking change decision is already in progress.");
}

async function completeTargetBookingChangeDecision(
  pool: BookingWebQueryExecutor,
  input: TargetBookingChangeDecisionInput & { body: unknown },
): Promise<void> {
  const fingerprint = bookingHotelChangeDecisionFingerprint(input);
  const responseBodyHash = sha256Hex(stableJson(input.body));
  const completed = await pool.query<{ id: string }>(
    `UPDATE platform.idempotency_keys
        SET status = 'completed',
            last_seen_at = now(),
            response_status_code = 200,
            response_body_hash = $5,
            response_resource_product = 'booking',
            response_resource_type = 'booking_change_request',
            response_resource_id = $6,
            correlation_id = $7,
            completed_at = $8::timestamptz,
            idempotency_metadata = $9::jsonb
      WHERE operation_scope = 'booking'
        AND operation = $1
        AND key_hash = $2
        AND tenant_scope = 'property'
        AND property_id = $3::uuid
        AND request_fingerprint_hash = $4
        AND status = 'in_progress'
  RETURNING id::text AS id`,
    [
      TARGET_BOOKING_CHANGE_DECISION_OPERATION,
      sha256Hex(input.context.idempotencyKey),
      input.propertyId,
      fingerprint,
      responseBodyHash,
      input.changeRequestId,
      input.context.correlationId,
      input.context.occurredAt.toISOString(),
      JSON.stringify({
        requestId: input.context.requestId,
        source: "apps/api-booking-change-decision",
        binding: {
          propertyId: input.propertyId,
          bookingId: input.bookingId,
          changeRequestId: input.changeRequestId,
          decision: input.decision,
          note: input.note,
        },
        responseBody: input.body,
      }),
    ],
  );
  if (!completed.rows[0]) {
    throw createHttpError(409, "Booking change decision idempotency state changed.");
  }
}

async function reserveTargetCheckoutCommand(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  context: BookingWebCheckoutCommandContext,
): Promise<TargetCheckoutCommandReservation> {
  const keyHash = sha256Hex(context.idempotencyKey);
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         property_id,
         correlation_id,
         expires_at,
         idempotency_metadata
       )
     VALUES
       (
         'booking',
         $1,
         $2,
         $3,
         'in_progress',
         'property',
         $4::uuid,
         $5,
         $6::timestamptz,
         $7::jsonb
       )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO UPDATE
       SET status = 'in_progress',
           last_seen_at = now(),
           correlation_id = EXCLUDED.correlation_id,
           expires_at = EXCLUDED.expires_at,
           idempotency_metadata = EXCLUDED.idempotency_metadata
       WHERE platform.idempotency_keys.request_fingerprint_hash =
             EXCLUDED.request_fingerprint_hash
         AND platform.idempotency_keys.status IN ('in_progress', 'failed', 'expired')
     RETURNING id::text AS id`,
    [
      context.operation,
      keyHash,
      context.fingerprint,
      propertyId,
      context.correlationId,
      new Date(context.occurredAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({ requestId: context.requestId, source: "apps/api-booking-web-public" }),
    ],
  );
  if (inserted.rows[0]) return { status: "reserved" };

  const existing = await findTargetCheckoutCommand(pool, propertyId, context);
  if (existing) return existing;
  throw createHttpError(409, "Checkout command is already in progress.");
}

async function findTargetCheckoutCommand(
  pool: BookingWebQueryExecutor,
  propertyId: string,
  context: BookingWebCheckoutCommandContext,
): Promise<TargetCheckoutCommandReservation | null> {
  const keyHash = sha256Hex(context.idempotencyKey);

  const existing = await pool.query<{
    requestFingerprintHash: string;
    status: string;
    idempotencyMetadata: unknown;
  }>(
    `SELECT
       request_fingerprint_hash AS "requestFingerprintHash",
       status,
       idempotency_metadata AS "idempotencyMetadata"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'booking'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     LIMIT 1`,
    [context.operation, keyHash, propertyId],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.requestFingerprintHash !== context.fingerprint) {
    throw createHttpError(409, "Idempotency key was already used for a different request.");
  }
  if (row.status === "completed") {
    const metadata = objectValue(row.idempotencyMetadata);
    if (Object.prototype.hasOwnProperty.call(metadata, "responseBody")) {
      return { status: "replay", body: metadata["responseBody"] };
    }
    throw createHttpError(409, "Completed checkout response is unavailable for replay.");
  }
  throw createHttpError(409, "Checkout command is already in progress.");
}

export async function recordTargetCheckoutCommand(
  pool: BookingWebQueryExecutor,
  input: {
    propertyId: string;
    context: BookingWebCheckoutCommandContext;
    resourceType: string;
    resourceId: string;
    body: unknown;
  },
): Promise<void> {
  const responseBodyHash = sha256Hex(stableJson(input.body));
  await pool.query(
    `WITH upserted_key AS (
       INSERT INTO platform.idempotency_keys
         (
           operation_scope,
           operation,
           key_hash,
           request_fingerprint_hash,
           status,
           tenant_scope,
           property_id,
           response_status_code,
           response_body_hash,
           response_resource_product,
           response_resource_type,
           response_resource_id,
           correlation_id,
           completed_at,
           expires_at,
           idempotency_metadata
         )
       VALUES
         (
           'booking',
           $1,
           $2,
           $3,
           'completed',
           'property',
           $4::uuid,
           200,
           $5,
           'booking',
           $6,
           $7,
           $8,
           $9::timestamptz,
           $10::timestamptz,
           $11::jsonb
         )
       ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO UPDATE
         SET last_seen_at = now(),
             status = CASE
               WHEN platform.idempotency_keys.request_fingerprint_hash = EXCLUDED.request_fingerprint_hash
               THEN 'completed'
               ELSE 'conflict'
             END,
             response_status_code = EXCLUDED.response_status_code,
             response_body_hash = EXCLUDED.response_body_hash,
             response_resource_product = EXCLUDED.response_resource_product,
             response_resource_type = EXCLUDED.response_resource_type,
             response_resource_id = EXCLUDED.response_resource_id,
             idempotency_metadata = CASE
               WHEN platform.idempotency_keys.request_fingerprint_hash = EXCLUDED.request_fingerprint_hash
               THEN EXCLUDED.idempotency_metadata
               ELSE platform.idempotency_keys.idempotency_metadata
             END,
             completed_at = EXCLUDED.completed_at
       RETURNING id
     )
     INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         property_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         idempotency_key_id,
         correlation_id,
         redacted_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       (
         $12,
         'booking',
         $13,
         $9::timestamptz,
         'property',
         $4::uuid,
         'provider',
         'booking',
         $6,
         $7,
         (SELECT id FROM upserted_key),
         $8,
         $14::jsonb,
         $15::jsonb,
         'guest_pii',
         'confidential'
       )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      input.context.operation,
      sha256Hex(input.context.idempotencyKey),
      input.context.fingerprint,
      input.propertyId,
      responseBodyHash,
      input.resourceType,
      input.resourceId,
      input.context.correlationId,
      input.context.occurredAt.toISOString(),
      new Date(input.context.occurredAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({
        requestId: input.context.requestId,
        source: "apps/api-booking-web-public",
        responseBody: input.body,
      }),
      `${input.context.operation}:${input.resourceId}:${input.context.fingerprint}`,
      `checkout.${input.context.operation}`,
      JSON.stringify({ operation: input.context.operation, resourceId: input.resourceId }),
      JSON.stringify({
        requestId: input.context.requestId,
        source: "apps/api-booking-web-public",
      }),
    ],
  );
}

export function resolveTargetCheckoutAmountSnapshot(
  request: BookingWebCheckoutRequest,
  quote?: Pick<TargetCheckoutQuoteSnapshot, "totalAmount" | "balanceAmount">,
): {
  totalAmount: string;
  balanceAmount: string;
} {
  const expectedTotalAmount = moneyField(request, "expectedTotalAmount");
  if (!expectedTotalAmount) {
    throw createHttpError(
      400,
      "expectedTotalAmount is required for target checkout booking creation.",
    );
  }
  const authoritativeTotalAmount = quote?.totalAmount ?? expectedTotalAmount;
  if (expectedTotalAmount !== authoritativeTotalAmount) {
    throw createHttpError(409, "Booking total changed. Please refresh the checkout quote.");
  }

  const submittedTotalAmount = moneyField(request, "totalAmount") ?? moneyField(request, "total");
  if (submittedTotalAmount && submittedTotalAmount !== authoritativeTotalAmount) {
    throw createHttpError(409, "Booking total changed. Please refresh the checkout quote.");
  }
  const authoritativeBalanceAmount = authoritativeTotalAmount;
  const submittedBalanceAmount = moneyField(request, "balanceAmount");
  if (submittedBalanceAmount && submittedBalanceAmount !== authoritativeBalanceAmount) {
    throw createHttpError(409, "Booking balance changed. Please refresh the checkout quote.");
  }
  const balanceAmount = submittedBalanceAmount ?? authoritativeBalanceAmount;
  if (Number(balanceAmount) > Number(authoritativeTotalAmount)) {
    throw createHttpError(409, "Booking balance cannot exceed the checkout total.");
  }

  return {
    totalAmount: authoritativeTotalAmount,
    balanceAmount,
  };
}

export function createUnavailableBookingWebAffiliateAdapter(): BookingWebAffiliateAdapter {
  return {
    async checkEmail() {
      throw createHttpError(404, "Booking Web affiliate adapter is not configured.");
    },
    async register() {
      throw createHttpError(404, "Booking Web affiliate adapter is not configured.");
    },
    async createStripeConnectLink() {
      throw createHttpError(404, "Booking Web affiliate adapter is not configured.");
    },
  };
}

function normalizeGuestActionRequest(request: BookingWebGuestActionRequest): {
  guest_email: string | undefined;
} {
  return {
    guest_email: request.guest_email ?? request.guestEmail,
  };
}

function normalizeChangeRequest(request: BookingWebChangeRequest): BookingWebChangeRequest {
  return {
    guestEmail: request.guestEmail ?? request.guest_email,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    addonIds: Array.isArray(request.addonIds) ? request.addonIds : [],
    addonQuantities: request.addonQuantities ?? {},
    addonDates: request.addonDates ?? {},
  };
}

async function findProfileForHost(config: {
  repository: PublicHotelProfileRepository;
  host: string;
  source: BookingDomainResolutionSource;
}): Promise<PublicBookabilityProfileProjection | null> {
  const { repository, host } = config;
  const subdomainSlug = slugFromKnownBookingHost(host);
  if (subdomainSlug) {
    return repository.findProfileBySlug(subdomainSlug);
  }

  if (config.source === "target") {
    return repository.findProfileByCustomDomain?.(host) ?? null;
  }

  if (repository.findProfileByCustomDomain) {
    return repository.findProfileByCustomDomain(host);
  }

  return null;
}

function serializeHostResolution(
  host: string,
  projection: PublicBookabilityProfileProjection,
): BookingWebHostResolution {
  const hotel = serializePublicHotelProfileProjection(projection).hotel;
  const canonicalHost = hostFromUrl(hotel.bookingBaseUrl);
  const shouldRedirect = Boolean(canonicalHost && canonicalHost !== host);
  return {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    host,
    slug: hotel.slug,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    shouldRedirect,
    redirectUrl: shouldRedirect ? hotel.canonicalUrl : null,
    redirectStatus: shouldRedirect ? 308 : null,
    hotel: {
      slug: hotel.slug,
      name: hotel.name,
      defaultLocale: hotel.defaultLocale,
      supportedLocales: hotel.supportedLocales.map((locale) => locale),
    },
    dataSources: projection.dataSources.map((source) => source),
  };
}

async function fetchCalendarProjection(config: {
  hotel: Pick<PublicBookabilityHotelProfile, "propertyId" | "slug">;
  query: BookingWebCalendarQuery;
  repository?: BookingWebCalendarRepository;
  now: Date;
}): Promise<BookingWebCalendarProjection> {
  const generatedAt = config.now.toISOString();
  const start = normalizeDateOnly(config.query.start);
  const end = normalizeDateOnly(config.query.end);
  if (config.repository) {
    return config.repository.findCalendarByHotel(config.hotel, config.query);
  }
  return unavailableCalendar(config.hotel.slug, start, end, generatedAt);
}

function unavailableCalendar(
  slug: string,
  start: string | null,
  end: string | null,
  generatedAt: string,
): BookingWebCalendarProjection {
  return {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    request: {
      hotelSlug: slug,
      start: start ?? "",
      end: end ?? "",
    },
    calendar: {
      unavailableDates:
        start &&
        end &&
        start < end &&
        dateRangeLength(start, end) <= BOOKING_WEB_CALENDAR_MAX_RANGE_DAYS
          ? dateRange(start, end)
          : [],
      minStayByArrival: {},
      maxStayByArrival: {},
    },
    freshness: freshness(generatedAt, "unavailable"),
    dataSources: ["pms", "distribution"],
  };
}

function freshness(
  generatedAt: string,
  pmsStatus: PublicBookabilityFreshness["status"],
): PublicBookabilityFreshness {
  return {
    status: pmsStatus === "fresh" ? "fresh" : "unavailable",
    generatedAt,
    sources: [
      {
        owner: "pms",
        lastUpdatedAt: pmsStatus === "fresh" ? generatedAt : undefined,
        status: pmsStatus,
        reasonCode: pmsStatus === "fresh" ? undefined : "source_unavailable",
      },
      {
        owner: "distribution",
        lastUpdatedAt: generatedAt,
        status: "fresh",
      },
    ],
  };
}

function targetCalendarFreshness(
  generatedAt: string,
  sourceFreshnessValues: Array<string | null>,
  status: PublicBookabilityFreshnessStatus,
): PublicBookabilityFreshness {
  const sourcesByOwner = new Map<
    PublicBookabilityDataSourceOwner,
    PublicBookabilityFreshnessSource
  >();

  for (const value of sourceFreshnessValues) {
    for (const source of parseFreshnessSources(value, generatedAt)) {
      sourcesByOwner.set(source.owner, source);
    }
  }

  if (!sourcesByOwner.has("pms")) {
    sourcesByOwner.set("pms", {
      owner: "pms",
      lastUpdatedAt: status === "unavailable" ? undefined : generatedAt,
      status,
      reasonCode: status === "unavailable" ? "source_unavailable" : undefined,
    });
  }
  sourcesByOwner.set("distribution", {
    owner: "distribution",
    lastUpdatedAt: generatedAt,
    status: "fresh",
  });

  return {
    status,
    generatedAt,
    sources: [...sourcesByOwner.values()],
  };
}

function parseFreshnessSources(
  value: string | null,
  generatedAt: string,
): PublicBookabilityFreshnessSource[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  const rawSources = Array.isArray(objectValue(parsed)["sources"])
    ? (objectValue(parsed)["sources"] as unknown[])
    : Object.entries(objectValue(parsed)).map(([owner, source]) => ({
        owner,
        ...objectValue(source),
      }));

  return rawSources.flatMap((entry): PublicBookabilityFreshnessSource[] => {
    const source = objectValue(entry);
    const owner = dataSourceOwner(stringValue(source["owner"]));
    if (!owner) return [];
    const sourceStatus = freshnessStatusValue(stringValue(source["status"]));
    return [
      {
        owner,
        lastUpdatedAt:
          stringValue(source["lastUpdatedAt"]) ?? stringValue(source["generatedAt"]) ?? generatedAt,
        status: sourceStatus,
        reasonCode: freshnessReasonCode(stringValue(source["reasonCode"])),
      },
    ];
  });
}

function rollupCalendarFreshness(values: Array<string | null>): PublicBookabilityFreshnessStatus {
  const statuses = values.map((value) => freshnessStatusValue(value));
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("unknown")) return "unknown";
  return "fresh";
}

function dataSourcesArray(value: string[] | null): PublicBookabilityDataSourceOwner[] {
  const sources = (value ?? [])
    .map((source) => dataSourceOwner(source))
    .filter((source): source is PublicBookabilityDataSourceOwner => Boolean(source));
  return sources.includes("distribution") ? sources : [...sources, "distribution"];
}

function dataSourceOwner(value: string | null): PublicBookabilityDataSourceOwner | null {
  if (["hotel_catalog", "booking", "pms", "finance", "distribution"].includes(value ?? "")) {
    return value as PublicBookabilityDataSourceOwner;
  }
  return null;
}

function freshnessStatusValue(value: string | null): PublicBookabilityFreshnessStatus {
  if (["fresh", "stale", "unavailable", "unknown"].includes(value ?? "")) {
    return value as PublicBookabilityFreshnessStatus;
  }
  return "unknown";
}

function freshnessReasonCode(
  value: string | null,
): PublicBookabilityFreshnessSource["reasonCode"] | undefined {
  if (value === "source_unavailable" || value === "source_stale" || value === "not_configured") {
    return value;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = Date.parse(`${start}T00:00:00.000Z`), endMs = Date.parse(`${end}T00:00:00.000Z`);
    cursor < endMs;
    cursor += 86_400_000
  ) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

function dateRangeLength(start: string, end: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000,
    ),
  );
}

function normalizeHost(value: string): string {
  const decoded = decodeURIComponent(value).trim().toLowerCase();
  if (decoded.startsWith("[")) {
    return decoded.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
  }
  return decoded.replace(/:\d+$/, "").replace(/^\.+|\.+$/g, "");
}

function slugFromKnownBookingHost(host: string): string | null {
  const parts = host.split(".");
  if (
    host.endsWith(".booking.vayada.com") ||
    host.endsWith(".next-booking.vayada.com") ||
    host.endsWith(".booking.localhost")
  ) {
    return parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0]! : null;
  }
  if (host.endsWith(".localhost")) {
    return parts.length === 2 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0]! : null;
  }
  return null;
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeDateOnly(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numericObject(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

function dateArrayObject(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, dates]) => [
      key,
      stringArray(dates).filter((date) => normalizeDateOnly(date) === date),
    ]),
  );
}

function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        /^\d{4}-\d{2}-\d{2}$/.test(entry[0]) &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]),
    ),
  );
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return stringValue(record[key]);
}

function dateField(record: Record<string, unknown>, key: string): string | null {
  return normalizeDateOnly(stringField(record, key) ?? undefined);
}

function moneyField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value.toFixed(2);
  }
  if (typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
    return Number(value).toFixed(2);
  }
  return null;
}

function moneyString(value: unknown): string | null {
  const amount = moneyNumber(value);
  return amount === null ? null : amount.toFixed(2);
}

function moneyNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return roundMoney(value);
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    return roundMoney(Number(value));
  }
  return null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return null;
}

function integerValue(value: unknown, fallback: number): number {
  const parsed = numberValue(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function roundMoney(value: number): number {
  return Number.isFinite(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : 0;
}

function integerField(record: Record<string, unknown>, key: string, fallback: number): number {
  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return fallback;
}

function uppercaseCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "EUR";
}

function uppercaseCountry(value: string | null): string | null {
  if (!value) return null;
  const country = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

function lifecycleStatusFromCheckout(quote: TargetCheckoutQuoteSnapshot): string {
  if (quote.paymentMethod === "card") return "draft";
  if (quote.paymentMethod === "bank_transfer" || quote.paymentMethod === "paypal") {
    return "pending_payment";
  }
  if (quote.acceptanceMode === "request") return "pending_payment";
  return quote.paymentMethod === "pay_at_property" || quote.paymentMethod === "cash"
    ? "confirmed"
    : "pending_payment";
}

function targetAcceptanceMode(value: unknown): "instant" | "request" {
  return value === "request" ? "request" : "instant";
}

function boundedPaymentWindowHours(value: unknown): number {
  const hours = typeof value === "number" ? value : Number(value);
  return Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 24;
}

function assertTargetPaymentMethodReady(method: string | null): void {
  if (
    method &&
    TARGET_CHECKOUT_SUPPORTED_PAYMENT_METHODS.includes(
      method as (typeof TARGET_CHECKOUT_SUPPORTED_PAYMENT_METHODS)[number],
    )
  ) {
    return;
  }
  throw createHttpError(
    503,
    "Target online payment authorization is not configured for Booking Web checkout.",
  );
}

function assertTargetQuotePricingInputsSupported(record: Record<string, unknown>): void {
  const addonIds = Array.isArray(record["addonIds"]) ? record["addonIds"] : [];
  const selectedAddons = Array.isArray(record["selectedAddons"]) ? record["selectedAddons"] : [];
  const addonQuantities = objectValue(record["addonQuantities"]);
  const addonDates = objectValue(record["addonDates"]);
  if (
    addonIds.length > 0 ||
    selectedAddons.length > 0 ||
    Object.keys(addonQuantities).length > 0 ||
    Object.keys(addonDates).length > 0
  ) {
    throw createHttpError(
      409,
      "Target checkout add-on pricing is not configured. Please refresh without add-ons.",
    );
  }
  if (stringField(record, "promoCode")) {
    throw createHttpError(
      409,
      "Target checkout promo pricing is not configured. Please refresh without a promo code.",
    );
  }
}

function requireGuestEmail(value: unknown): string {
  const email = firstString(value);
  if (!email) {
    throw createHttpError(400, "Guest email is required.");
  }
  return email;
}

function assertLifecycleMutationAllowed(booking: TargetBookingRow, action: string): void {
  if (booking.lifecycleStatus === "canceled" || booking.lifecycleStatus === "completed") {
    throw createHttpError(409, "Booking can no longer be changed.");
  }
  if (action === "withdraw" && booking.lifecycleStatus !== "pending_payment") {
    throw createHttpError(409, "Only pending bookings can be withdrawn.");
  }
  if (action === "cancel" && booking.lifecycleStatus !== "confirmed") {
    throw createHttpError(409, "Only confirmed bookings can be cancelled.");
  }
  if (action === "withdraw" || action === "cancel") {
    assertTargetInventoryReleasePaymentStateSupported(booking, action);
  }
}

function assertTargetInventoryReleasePaymentStateSupported(
  booking: TargetBookingRow,
  action: "withdraw" | "cancel",
): void {
  if (booking.paymentStatus !== "unpaid") {
    throw createHttpError(
      409,
      `Paid bookings cannot be ${action === "withdraw" ? "withdrawn" : "cancelled"} online until refund processing is available.`,
    );
  }
}

function resolveTargetCancellationPreview(
  booking: TargetBookingRow,
  propertyTimezone: string | undefined,
  occurredAt: Date,
): Record<string, unknown> {
  const metadata = objectValue(booking.bookingMetadata);
  const selectedOffer = objectValue(metadata["selectedOffer"]);
  const rateSummary = objectValue(selectedOffer["rateSummary"]);
  const policySnapshot = objectValue(metadata["policySnapshot"]);
  const rateType = canonicalTargetCheckoutRateType(
    stringValue(selectedOffer["rateType"]) ??
      stringValue(rateSummary["rateType"]) ??
      stringValue(selectedOffer["publicOfferKey"]),
  );
  const hasCanonicalPolicyDiscriminator = Object.hasOwn(policySnapshot, "type");
  const refundValue = stringValue(policySnapshot["refund"])?.toLowerCase();
  if (
    rateType === "non_refundable" ||
    rateSummary["refundable"] === false ||
    (!hasCanonicalPolicyDiscriminator &&
      (policySnapshot["refundable"] === false || refundValue === "none"))
  ) {
    throw createHttpError(
      409,
      "This booked rate is non-refundable and cannot be cancelled online.",
    );
  }

  if (
    !hasCanonicalPolicyDiscriminator &&
    (Array.isArray(policySnapshot["tiers"]) ||
      Array.isArray(policySnapshot["partialRefundTiers"]) ||
      (refundValue !== null &&
        refundValue !== undefined &&
        !["full", "100", "100%"].includes(refundValue)))
  ) {
    throw createHttpError(
      409,
      "This booking's cancellation policy cannot be verified online. Contact the property.",
    );
  }

  const canonicalTerms = !hasCanonicalPolicyDiscriminator
    ? null
    : parseBookingFlexibleCancellationTerms({
        type: policySnapshot["type"],
        freeCancellationDeadlineDays: policySnapshot["freeCancellationDeadlineDays"],
        afterDeadlinePenalty: policySnapshot["afterDeadlinePenalty"],
        noShowPenalty: policySnapshot["noShowPenalty"],
      });
  const freeCancellationDays = !hasCanonicalPolicyDiscriminator
    ? resolveLegacyFreeCancellationDays(policySnapshot)
    : canonicalTerms?.freeCancellationDeadlineDays;
  if (freeCancellationDays === undefined || freeCancellationDays === null) {
    throw unverifiableFreeCancellationPeriodError();
  }
  const propertyDate = targetPropertyDateOnly(propertyTimezone, occurredAt);
  const daysUntilCheckIn = targetDateDifference(propertyDate, dateOnly(booking.checkIn));
  if (daysUntilCheckIn < freeCancellationDays) {
    throw createHttpError(
      409,
      "This booking's free-cancellation period has expired. Contact the property.",
    );
  }

  return {
    amountPaid: 0,
    cancellationFeeAmount: 0,
    refundAmount: 0,
    refundPercentage: 0,
    freeCancellationDays,
    daysUntilCheckIn,
    currency: booking.currency,
    policy: policySnapshot,
  };
}

function resolveLegacyFreeCancellationDays(policySnapshot: Record<string, unknown>): number {
  const freeCancellationWindows = [
    policySnapshot["freeUntilDays"],
    policySnapshot["freeCancellationDays"],
    policySnapshot["refundWindowDays"],
  ].filter((value) => value !== undefined && value !== null);
  const parsedWindows = freeCancellationWindows.map((value) => numberValue(value));
  if (
    parsedWindows.length === 0 ||
    parsedWindows.some(
      (value) => value === null || !Number.isInteger(value) || value < 0 || value > 3650,
    ) ||
    new Set(parsedWindows).size !== 1
  ) {
    throw unverifiableFreeCancellationPeriodError();
  }
  return parsedWindows[0]!;
}

function unverifiableFreeCancellationPeriodError(): Error {
  return createHttpError(
    409,
    "This booking's free-cancellation period cannot be verified online. Contact the property.",
  );
}

function targetDateDifference(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw createHttpError(
      409,
      "This booking's cancellation period cannot be verified online. Contact the property.",
    );
  }
  return Math.floor((endTime - startTime) / 86_400_000);
}

function pmsReservationHandoffIdempotencyKey(
  propertyId: string,
  guestBookingId: string,
  operation: "create" | "update" | "cancel",
  revision = "v1",
): string {
  return `pms.reservation.${operation}:property:${propertyId}:booking:${guestBookingId}:${revision}`;
}

function redactGuestInput(record: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...record };
  for (const key of ["cardNumber", "cardCvc", "paymentToken", "providerPaymentIntentSecret"]) {
    delete redacted[key];
  }
  return redacted;
}

function decimalString(value: string | number): string {
  if (typeof value === "number") return value.toFixed(2);
  return value;
}

function dateOnly(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function targetPropertyDateOnly(timezone: string | undefined, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone?.trim() || "Etc/UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function canonicalTargetCheckoutRateType(value: string | null | undefined): string {
  const normalized = (value ?? "flexible").trim().toLowerCase();
  if (
    normalized === "nonrefundable" ||
    normalized === "non_refundable" ||
    normalized === "non-refundable" ||
    normalized === "nrf" ||
    normalized.endsWith(":nrf")
  ) {
    return "non_refundable";
  }
  if (normalized === "flex" || normalized.endsWith(":flex")) return "flexible";
  return normalized || "flexible";
}

function publicTargetCheckoutRateType(value: string): string {
  const canonical = canonicalTargetCheckoutRateType(value);
  return canonical === "non_refundable" ? "nonrefundable" : canonical;
}

async function allocateTargetBookingPublicReference(
  pool: BookingWebQueryExecutor,
  components: string[],
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = targetPublicReference("VAY", [...components, String(attempt)]);
    await pool.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [candidate]);
    const collision = await pool.query<{ collided: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM booking.guest_bookings WHERE public_reference = $1
       ) AS collided`,
      [candidate],
    );
    if (collision.rows[0]?.collided !== true) return candidate;
  }
  throw createHttpError(409, "Unable to allocate a booking reference. Please retry.");
}

function targetPublicReference(prefix: "Q" | "VAY", components: string[]): string {
  const digest = sha256Hex([prefix, ...components].join("\u001f"));
  return `${prefix}-${digest.slice(0, prefix === "VAY" ? 6 : 32).toUpperCase()}`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function recordBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function checkoutCommandContext(
  request: FastifyRequest,
  operation: string,
  resource: string,
  payload: unknown,
  now: () => Date,
): BookingWebCheckoutCommandContext {
  const fingerprint = sha256Hex(stableJson({ operation, resource, payload }));
  const headerKey = firstString(request.headers["idempotency-key"]);
  const checkoutAttemptOperation = [
    "booking-quote",
    "booking-create",
    "booking-confirm-authorization",
  ].includes(operation);
  return {
    operation,
    requestId: String(request.id),
    correlationId: firstString(request.headers["x-correlation-id"]) ?? String(request.id),
    idempotencyKey:
      headerKey ??
      `booking.checkout:${operation}:${resource}:${checkoutAttemptOperation ? request.id : fingerprint}`,
    fingerprint,
    occurredAt: now(),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

type HttpError = Error & {
  statusCode: number;
};
