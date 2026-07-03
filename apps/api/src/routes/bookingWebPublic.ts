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
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { enqueueBookingLifecycleEmailJob } from "../jobs/bookingEmails.js";
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

export type BookingWebCalendarReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
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
      const response = await checkoutAdapter.lookup(
        request.params.slug,
        body,
        checkoutCommandContext(request, "booking-lookup", request.params.slug, body, now),
      );
      reply.header("Cache-Control", "no-store");
      reply.header("X-Vayada-RateLimit-Policy", "public-booking-web-booking-lookup");
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
      await options.attributionSink.recordTelemetryEvent({
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
      if (!start || !end || start >= end) {
        return unavailableCalendar(hotel.slug, start, end, generatedAt);
      }

      try {
        const result = await pool.query<TargetBookingWebCalendarRow>(
          `SELECT
           offer.stay_date::text AS "stayDate",
           BOOL_OR(offer.sellable_publicly AND offer.availability_status IN ('available', 'limited') AND offer.available_rooms > 0) AS "hasAvailability",
           BOOL_OR(offer.availability_status IN ('sold_out', 'closed', 'unavailable')) AS "hasUnavailableState",
           ARRAY_AGG(DISTINCT offer.source_freshness::text) AS "sourceFreshnessValues",
           ARRAY_AGG(DISTINCT offer.freshness_status) AS "freshnessStatuses",
           MAX(offer.generated_at) AS "generatedAt",
           ARRAY_AGG(DISTINCT source.owner) FILTER (WHERE source.owner IS NOT NULL) AS "dataSources"
         FROM distribution.public_room_offer_snapshots offer
         JOIN distribution.public_hotel_bookability_profiles profile
           ON profile.property_id = offer.property_id
         LEFT JOIN LATERAL unnest(offer.data_sources) AS source(owner) ON true
         WHERE (profile.property_id::text = $1 OR profile.canonical_slug = $2)
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
        if (requestedDates.some((date) => !coveredDates.has(date))) {
          return {
            ...unavailableCalendar(hotel.slug, start, end, generatedAt),
            freshness: targetCalendarFreshness(
              generatedAt,
              result.rows.flatMap((row) => row.sourceFreshnessValues ?? []),
              "unavailable",
            ),
          };
        }

        const unavailableDates = result.rows
          .filter((row) => !row.hasAvailability && row.hasUnavailableState)
          .map((row) => row.stayDate);
        const latestGeneratedAt =
          result.rows
            .map((row) => toIsoDateTime(row.generatedAt))
            .filter((value): value is string => Boolean(value))
            .sort()
            .at(-1) ?? generatedAt;
        const dataSources = [
          ...new Set(result.rows.flatMap((row) => dataSourcesArray(row.dataSources))),
        ];

        return {
          contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
          generatedAt: latestGeneratedAt,
          publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
          request: { hotelSlug: hotel.slug, start, end },
          calendar: {
            unavailableDates,
            minStayByArrival: {},
            maxStayByArrival: {},
          },
          freshness: targetCalendarFreshness(
            latestGeneratedAt,
            result.rows.flatMap((row) => row.sourceFreshnessValues ?? []),
            rollupCalendarFreshness(result.rows.flatMap((row) => row.freshnessStatuses ?? [])),
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
};

type TargetCheckoutConfigRow = QueryResultRow & {
  propertyId: string;
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
  paymentsEnabled: boolean | null;
  acceptedMethods: string[] | null;
  depositPolicy: unknown;
  refundPolicy: unknown;
  requiresManualReview: boolean | null;
};

type TargetBookingRow = QueryResultRow & {
  guestBookingId: string;
  propertyId: string;
  publicReference: string;
  lifecycleStatus: string;
  paymentStatus: string;
  checkIn: Date | string;
  checkOut: Date | string;
  adults: number;
  children: number;
  roomCount: number;
  currency: string;
  totalAmount: string | number;
  balanceAmount: string | number;
  bookingMetadata: unknown;
  createdAt: Date | string;
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
  roomTotal: string | number;
  taxesAndFees: string | number;
  discounts: string | number;
  currency: string;
  generatedAt: Date | string | null;
  sourceFreshness: unknown;
};

type TargetCheckoutQuoteRow = QueryResultRow & {
  quoteSessionId: string;
  publicQuoteReference: string;
  requestedCheckIn: Date | string;
  requestedCheckOut: Date | string;
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
  selectedOfferSnapshot: Record<string, unknown>;
  totals: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
  expiresAt: string;
};

type TargetPaymentSettingsRow = QueryResultRow & {
  acceptedMethods: string[] | null;
  depositPolicy: unknown;
};

type PgTargetBookingWebCheckoutAdapterConfig = {
  connectionString: string;
  max?: number;
  pool?: pg.Pool;
};

export function createTargetBookingWebCheckoutAdapter(
  config: PgTargetBookingWebCheckoutAdapterConfig,
): BookingWebCheckoutAdapter {
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
    } else {
      await resolveTargetCheckoutProperty(pool, slug);
    }
    return result.body;
  };

  return {
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
      assertTargetPaymentMethodReady(request);
      const property = await resolveTargetCheckoutProperty(pool, slug);
      const guestPhone = await resolveTargetGuestPhone(pool, property.propertyId, request);
      await reserveTargetCheckoutCommand(pool, property.propertyId, context);
      const quote = await loadTargetCheckoutQuoteSnapshot(
        pool,
        property.propertyId,
        request,
        context.occurredAt,
      );
      const booking = await createTargetGuestBooking(
        pool,
        property,
        request,
        context,
        quote,
        guestPhone,
      );
      await enqueueBankTransferReservedPendingPaymentEmail(
        pool,
        property,
        booking,
        quote,
        request,
        context,
      );
      await enqueuePmsReservationHandoff(pool, property.propertyId, booking, context, "create");
      const body = serializeTargetBooking(booking);
      await recordTargetCheckoutCommand(pool, {
        propertyId: property.propertyId,
        context,
        resourceType: "guest_booking",
        resourceId: booking.guestBookingId,
        body,
      });
      return {
        bookingReference: booking.publicReference,
        booking: body,
        pmsHandoff: { status: "pending_handoff" },
      };
    },
    async quoteBooking(slug, request, context) {
      const property = await resolveTargetCheckoutProperty(pool, slug);
      assertTargetQuotePricingInputsSupported(request);
      if (context) {
        await reserveTargetCheckoutCommand(pool, property.propertyId, context);
      }
      const quote = await createTargetCheckoutQuote(
        pool,
        property,
        request,
        context?.occurredAt ?? new Date(),
      );
      const body = serializeTargetCheckoutQuote(quote);
      if (!context) return body;
      await recordTargetCheckoutCommand(pool, {
        propertyId: property.propertyId,
        context,
        resourceType: "checkout_quote",
        resourceId: quote.publicQuoteReference,
        body,
      });
      return body;
    },
    async confirmAuthorization(slug, handle, context) {
      const property = await resolveTargetCheckoutProperty(pool, slug);
      if (context) {
        await reserveTargetCheckoutCommand(pool, property.propertyId, context);
        await recordTargetCheckoutCommand(pool, {
          propertyId: property.propertyId,
          context,
          resourceType: "checkout_authorization",
          resourceId: handle,
          body: { status: "payment_authorization_unavailable" },
        });
      }
      throw createHttpError(
        503,
        "Target card authorization is not configured for Booking Web checkout.",
      );
    },
    async getStatus(slug, query, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
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
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
        const reference = firstString(request.bookingReference);
        if (!reference) {
          throw createHttpError(400, "Booking reference is required.");
        }
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          reference,
          requireGuestEmail(request.guestEmail),
        );
        return {
          propertyId: property.propertyId,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: serializeTargetBooking(booking),
        };
      });
    },
    async withdraw(slug, bookingId, request, context) {
      return withGuestLifecycleMutation(pool, slug, bookingId, request, context, {
        status: "canceled",
        action: "withdraw",
        eventType: "guest_booking.withdrawn",
      });
    },
    async cancelPreview(slug, bookingId, request, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          bookingId,
          requireGuestEmail(request.guest_email),
        );
        const amount = decimalString(booking.balanceAmount);
        return {
          propertyId: property.propertyId,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: {
            refundAmount: Number(amount),
            refundPercentage: Number(amount) > 0 ? 100 : 0,
            currency: booking.currency,
            policy: objectValue(booking.bookingMetadata)["policy"] ?? null,
          },
        };
      });
    },
    async cancel(slug, bookingId, request, context) {
      const response = await withGuestLifecycleMutation(pool, slug, bookingId, request, context, {
        status: "canceled",
        action: "cancel",
        eventType: "guest_booking.canceled",
      });
      const property = await resolveTargetCheckoutProperty(pool, slug);
      const booking = await loadTargetBooking(
        pool,
        property.propertyId,
        bookingId,
        requireGuestEmail(request.guest_email),
      );
      if (context) {
        await enqueuePmsReservationHandoff(pool, property.propertyId, booking, context, "cancel");
      }
      return response;
    },
    async previewChangeRequest(slug, bookingId, request, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          bookingId,
          requireGuestEmail(request.guestEmail ?? request.guest_email),
        );
        return {
          propertyId: property.propertyId,
          resourceType: "guest_booking",
          resourceId: booking.guestBookingId,
          body: {
            oldTotal: Number(decimalString(booking.totalAmount)),
            newTotal: Number(decimalString(booking.totalAmount)),
            priceDifference: 0,
            currency: booking.currency,
            available: true,
            blocked: false,
            requestedChanges: normalizeChangeRequest(request),
          },
        };
      });
    },
    async submitChangeRequest(slug, bookingId, request, context) {
      if (!context) {
        throw createHttpError(400, "Checkout command context is required.");
      }
      const property = await resolveTargetCheckoutProperty(pool, slug);
      await reserveTargetCheckoutCommand(pool, property.propertyId, context);
      const booking = await loadTargetBooking(
        pool,
        property.propertyId,
        bookingId,
        requireGuestEmail(request.guestEmail ?? request.guest_email),
      );
      await insertTargetChangeRequest(pool, booking, normalizeChangeRequest(request));
      await enqueuePmsReservationHandoff(pool, property.propertyId, booking, context, "update");
      const body = { status: "pending", priceDifference: 0, currency: booking.currency };
      await recordTargetCheckoutCommand(pool, {
        propertyId: property.propertyId,
        context,
        resourceType: "booking_change_request",
        resourceId: booking.guestBookingId,
        body,
      });
      return body;
    },
    async getChangeRequest(slug, bookingId, query, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
        const booking = await loadTargetBooking(
          pool,
          property.propertyId,
          bookingId,
          requireGuestEmail(query.email),
        );
        const result = await pool.query<{
          status: string;
          requestedChanges: unknown;
          createdAt: Date | string;
        }>(
          `SELECT status, requested_changes AS "requestedChanges", created_at AS "createdAt"
             FROM booking.booking_change_requests
            WHERE guest_booking_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [booking.guestBookingId],
        );
        return {
          propertyId: property.propertyId,
          resourceType: "booking_change_request",
          resourceId: booking.guestBookingId,
          body: result.rows[0] ?? { status: "none" },
        };
      });
    },
    async getPaymentInstructions(slug, handle, context) {
      return withCommand(slug, context, async () => {
        const property = await resolveTargetCheckoutProperty(pool, slug);
        const settings = await loadTargetPaymentSettings(pool, property.propertyId);
        const methods = settings?.acceptedMethods ?? [];
        return {
          propertyId: property.propertyId,
          resourceType: "payment_instructions",
          resourceId: handle,
          body: {
            bankTransfer: {
              enabled: methods.includes("bank_transfer"),
              details: bankTransferInstructionsFromPolicy(settings?.depositPolicy),
            },
            paypal: {
              enabled: false,
              email: null,
              paymentWindowHours: null,
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

export function createUnavailableBookingWebCheckoutAdapter(): BookingWebCheckoutAdapter {
  return {
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
  pool: BookingWebCalendarReadPool,
  slug: string,
): Promise<TargetCheckoutPropertyRow> {
  const result = await pool.query<TargetCheckoutPropertyRow>(
    `SELECT
       p.id::text AS "propertyId",
       p.display_name AS "displayName",
       p.default_locale AS "defaultLocale"
     FROM hotel_catalog.property_slugs s
     JOIN hotel_catalog.properties p ON p.id = s.property_id
     WHERE s.slug = $1
       AND s.purpose = 'canonical'
       AND s.status = 'active'
       AND p.profile_status <> 'disabled'
     LIMIT 1`,
    [slug],
  );
  const property = result.rows[0];
  if (!property) {
    throw createHttpError(404, "Booking Web hotel checkout target not found.");
  }
  return property;
}

async function loadTargetCheckoutConfig(
  pool: BookingWebCalendarReadPool,
  propertyId: string,
): Promise<TargetCheckoutConfigRow | null> {
  const result = await pool.query<TargetCheckoutConfigRow>(
    `SELECT
       p.id::text AS "propertyId",
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
       fs.payments_enabled AS "paymentsEnabled",
       fs.accepted_methods AS "acceptedMethods",
       fs.deposit_policy AS "depositPolicy",
       fs.refund_policy AS "refundPolicy",
       fs.requires_manual_review AS "requiresManualReview"
     FROM hotel_catalog.properties p
     LEFT JOIN booking.booking_settings bs ON bs.property_id = p.id
     LEFT JOIN finance.payment_settings fs ON fs.property_id = p.id
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
  const methods = row?.acceptedMethods ?? [];
  const depositPolicy = objectValue(row?.depositPolicy);
  const refundPolicy = objectValue(row?.refundPolicy);
  return {
    hotelName: property.displayName,
    defaultCurrency: row?.defaultCurrency ?? "EUR",
    payAtPropertyEnabled: methods.includes("pay_at_property"),
    bankTransfer: methods.includes("bank_transfer"),
    paypalEnabled: false,
    paymentsEnabled: row?.paymentsEnabled ?? false,
    acceptedPaymentMethods: methods,
    requiresManualReview: row?.requiresManualReview ?? false,
    showAddonsStep: row?.showAddonsStep ?? true,
    groupAddonsByCategory: row?.groupAddonsByCategory ?? true,
    specialRequestsEnabled: row?.specialRequestsEnabled ?? true,
    arrivalTimeEnabled: row?.arrivalTimeEnabled ?? false,
    guestCountEnabled: row?.guestCountEnabled ?? false,
    phoneRequired: row?.phoneRequired ?? true,
    adultAgeThreshold: row?.adultAgeThreshold ?? 18,
    childrenEnabled: row?.childrenEnabled ?? true,
    benefits: Array.isArray(row?.benefits) ? row?.benefits : [],
    cancellationSummary: stringValue(refundPolicy["summary"]),
    depositSummary: stringValue(depositPolicy["summary"]),
  };
}

async function createTargetCheckoutQuote(
  pool: pg.Pool,
  property: TargetCheckoutPropertyRow,
  request: BookingWebCheckoutRequest,
  requestedAt: Date,
): Promise<TargetCheckoutQuoteSnapshot> {
  const checkIn = dateField(request, "checkIn");
  const checkOut = dateField(request, "checkOut");
  if (!checkIn || !checkOut || checkIn >= checkOut) {
    throw createHttpError(400, "Valid check-in and check-out dates are required.");
  }
  const roomTypeId = stringField(request, "roomTypeId");
  if (!roomTypeId) {
    throw createHttpError(400, "roomTypeId is required for target checkout quotes.");
  }

  const settings = await loadTargetCheckoutConfig(pool, property.propertyId);
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
  const rateType = stringField(request, "rateType") ?? "flexible";
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
  const depositPercentage =
    depositPercentageFromPolicy(offer.publicPolicy) ??
    depositPercentageFromPolicy(settings?.depositPolicy) ??
    0;
  const depositRequired = depositPercentage > 0;
  const depositAmount = depositRequired
    ? Math.min(totalAmount, roundMoney((totalAmount * depositPercentage) / 100))
    : 0;
  const balanceAmount = depositRequired
    ? Math.max(0, roundMoney(totalAmount - depositAmount))
    : totalAmount;
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
    availableRooms: integerValue(offer.availableRooms, roomCount),
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
      promoCode: stringField(request, "promoCode"),
      referralCode: stringField(request, "referralCode"),
    }),
  );
  const publicQuoteReference = `Q-${sha256Hex(`${requestHash}:${requestedAt.toISOString()}`)
    .slice(0, 12)
    .toUpperCase()}`;
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
     ON CONFLICT (public_quote_reference) DO UPDATE
       SET updated_at = EXCLUDED.updated_at
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
    selectedOfferSnapshot,
    totals,
    policySnapshot: objectValue(offer.publicPolicy),
    expiresAt,
  };
}

async function loadTargetCheckoutOffer(
  pool: BookingWebCalendarReadPool,
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
       (array_agg(offer.payment_options ORDER BY offer.stay_date))[1] AS "paymentOptions",
       MIN(offer.available_rooms) AS "availableRooms",
       SUM(offer.base_price_amount) * $7::int AS "roomTotal",
       SUM(offer.taxes_and_fees_amount) * $7::int AS "taxesAndFees",
       SUM(offer.discounts_amount) * $7::int AS discounts,
       offer.currency,
       MAX(offer.generated_at) AS "generatedAt",
       (array_agg(offer.source_freshness ORDER BY offer.stay_date DESC))[1] AS "sourceFreshness"
     FROM distribution.public_room_offer_snapshots offer
     WHERE offer.property_id = $1::uuid
       AND offer.stay_date >= $2::date
       AND offer.stay_date < $3::date
       AND offer.currency = $4
       AND offer.sellable_publicly = TRUE
       AND offer.availability_status IN ('available', 'limited')
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
         OR offer.rate_plan_id::text = $9
       )
     GROUP BY offer.public_offer_key, offer.room_type_id, offer.rate_plan_id, offer.currency
     HAVING COUNT(DISTINCT offer.stay_date) = $11::int
        AND MIN(offer.available_rooms) >= $7::int
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
    ],
  );
  const offer = result.rows[0];
  if (!offer) {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }
  return offer;
}

async function loadTargetCheckoutQuoteSnapshot(
  pool: BookingWebCalendarReadPool,
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
       requested_check_in AS "requestedCheckIn",
       requested_check_out AS "requestedCheckOut",
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
     LIMIT 1`,
    [propertyId, quoteId],
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
    selectedOfferSnapshot,
    totals,
    policySnapshot: objectValue(row.policySnapshot),
    expiresAt,
  };
}

function serializeTargetCheckoutQuote(quote: TargetCheckoutQuoteSnapshot): Record<string, unknown> {
  const roomTotal = moneyNumber(quote.totals["roomTotal"]) ?? Number(quote.totalAmount);
  const totalAmount = Number(quote.totalAmount);
  const depositPercentage = numberValue(quote.totals["depositPercentage"]);
  const depositAmount = moneyNumber(quote.totals["depositAmount"]) ?? 0;
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
    rateType: stringValue(quote.selectedOfferSnapshot["rateType"]) ?? "flexible",
    paymentMethod: quote.paymentMethod ?? "pay_at_property",
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
    depositRequired: quote.totals["depositRequired"] === true,
    depositPercentage,
    depositAmount,
    balanceAmount: Number(quote.balanceAmount),
  };
}

async function createTargetGuestBooking(
  pool: pg.Pool,
  property: TargetCheckoutPropertyRow,
  request: BookingWebCheckoutRequest,
  context: BookingWebCheckoutCommandContext,
  quote: TargetCheckoutQuoteSnapshot,
  guestPhone: string | null,
): Promise<TargetBookingRow> {
  const { totalAmount, balanceAmount } = resolveTargetCheckoutAmountSnapshot(request, quote);
  const publicReference = `B-${context.fingerprint.slice(0, 10).toUpperCase()}`;
  const metadata = {
    targetSource: "booking_checkout_command",
    quoteReference: quote.publicQuoteReference,
    requestFingerprint: context.fingerprint,
    selectedOffer: quote.selectedOfferSnapshot,
    paymentMethod: quote.paymentMethod,
    pmsHandoffStatus: "pending_handoff",
  };

  const result = await pool.query<TargetBookingRow>(
    `WITH quote AS (
       UPDATE booking.quote_sessions
          SET status = 'converted',
              updated_at = $20::timestamptz
        WHERE id = $29::uuid
          AND property_id = $1::uuid
          AND status = 'active'
       RETURNING id
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
         $20::timestamptz,
         $20::timestamptz
       FROM checkout
       ON CONFLICT (public_reference) DO UPDATE
         SET updated_at = EXCLUDED.updated_at
       RETURNING
         id::text AS "guestBookingId",
         property_id::text AS "propertyId",
         public_reference AS "publicReference",
         lifecycle_status AS "lifecycleStatus",
         payment_status AS "paymentStatus",
         check_in AS "checkIn",
         check_out AS "checkOut",
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
      paymentStatusFromRequest(request),
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
    ],
  );
  const booking = result.rows[0];
  if (!booking) {
    throw createHttpError(409, "Checkout quote is no longer available. Please refresh.");
  }
  return booking;
}

async function resolveTargetGuestPhone(
  pool: BookingWebCalendarReadPool,
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
  slug: string,
  bookingId: string,
  request: BookingWebGuestActionRequest,
  context: BookingWebCheckoutCommandContext | undefined,
  mutation: { status: string; action: string; eventType: string },
): Promise<Record<string, unknown>> {
  if (!context) {
    throw createHttpError(400, "Checkout command context is required.");
  }
  const property = await resolveTargetCheckoutProperty(pool, slug);
  await reserveTargetCheckoutCommand(pool, property.propertyId, context);
  const booking = await loadTargetBooking(
    pool,
    property.propertyId,
    bookingId,
    requireGuestEmail(request.guest_email),
  );
  assertLifecycleMutationAllowed(booking, mutation.action);
  const result = await pool.query<TargetBookingRow>(
    `WITH updated AS (
       UPDATE booking.guest_bookings
          SET lifecycle_status = $3,
              cancellation_reason = COALESCE(cancellation_reason, $4),
              updated_at = $5::timestamptz
        WHERE id = $1::uuid
          AND property_id = $2::uuid
        RETURNING
          id::text AS "guestBookingId",
          property_id::text AS "propertyId",
          public_reference AS "publicReference",
          lifecycle_status AS "lifecycleStatus",
          payment_status AS "paymentStatus",
          check_in AS "checkIn",
          check_out AS "checkOut",
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
  const updated = result.rows[0] ?? booking;
  const body = serializeTargetBookingStatus(updated);
  await recordTargetCheckoutCommand(pool, {
    propertyId: property.propertyId,
    context,
    resourceType: "guest_booking",
    resourceId: updated.guestBookingId,
    body,
  });
  return body;
}

async function loadTargetBooking(
  pool: BookingWebCalendarReadPool,
  propertyId: string,
  referenceOrId: string,
  guestEmail: string,
): Promise<TargetBookingRow> {
  const result = await pool.query<TargetBookingRow>(
    `SELECT
       b.id::text AS "guestBookingId",
       b.property_id::text AS "propertyId",
       b.public_reference AS "publicReference",
       b.lifecycle_status AS "lifecycleStatus",
       b.payment_status AS "paymentStatus",
       b.check_in AS "checkIn",
       b.check_out AS "checkOut",
       b.adults,
       b.children,
       b.room_count AS "roomCount",
       b.currency,
       b.total_amount AS "totalAmount",
       b.balance_amount AS "balanceAmount",
       b.booking_metadata AS "bookingMetadata",
       b.created_at AS "createdAt"
     FROM booking.guest_bookings b
     WHERE b.property_id = $1::uuid
       AND (b.id::text = $2 OR b.public_reference = $2)
       AND EXISTS (
         SELECT 1
         FROM booking.booking_guests g
         WHERE g.guest_booking_id = b.id
           AND lower(g.email) = lower($3)
       )
     LIMIT 1`,
    [propertyId, referenceOrId, guestEmail],
  );
  const booking = result.rows[0];
  if (!booking) {
    throw createHttpError(404, "Booking not found.");
  }
  return booking;
}

function serializeTargetBooking(booking: TargetBookingRow): Record<string, unknown> {
  return {
    guestBookingId: booking.guestBookingId,
    bookingReference: booking.publicReference,
    status: booking.lifecycleStatus,
    paymentStatus: booking.paymentStatus,
    checkIn: dateOnly(booking.checkIn),
    checkOut: dateOnly(booking.checkOut),
    adults: booking.adults,
    children: booking.children,
    roomCount: booking.roomCount,
    currency: booking.currency,
    totalAmount: Number(decimalString(booking.totalAmount)),
    balanceAmount: Number(decimalString(booking.balanceAmount)),
  };
}

function serializeTargetBookingStatus(booking: TargetBookingRow): Record<string, unknown> {
  return {
    bookingReference: booking.publicReference,
    status: booking.lifecycleStatus,
    paymentStatus: booking.paymentStatus,
    checkIn: dateOnly(booking.checkIn),
    checkOut: dateOnly(booking.checkOut),
    currency: booking.currency,
    balanceAmount: Number(decimalString(booking.balanceAmount)),
  };
}

async function insertTargetChangeRequest(
  pool: pg.Pool,
  booking: TargetBookingRow,
  request: BookingWebChangeRequest,
): Promise<void> {
  await pool.query(
    `INSERT INTO booking.booking_change_requests
       (guest_booking_id, request_type, requested_by, status, requested_changes)
     VALUES
       ($1::uuid, 'date_change', 'guest', 'pending', $2::jsonb)`,
    [booking.guestBookingId, JSON.stringify(request)],
  );
}

async function loadTargetPaymentSettings(
  pool: BookingWebCalendarReadPool,
  propertyId: string,
): Promise<TargetPaymentSettingsRow | null> {
  const result = await pool.query<TargetPaymentSettingsRow>(
    `SELECT accepted_methods AS "acceptedMethods", deposit_policy AS "depositPolicy"
       FROM finance.payment_settings
      WHERE property_id = $1::uuid
      LIMIT 1`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

function bankTransferInstructionsFromPolicy(policy: unknown): unknown | null {
  const instructions = objectValue(policy)["bankTransferInstructions"];
  if (typeof instructions === "string") {
    const text = instructions.trim();
    return text || null;
  }
  if (!instructions || typeof instructions !== "object" || Array.isArray(instructions)) return null;
  return Object.keys(instructions).length > 0 ? instructions : null;
}

async function enqueueBankTransferReservedPendingPaymentEmail(
  pool: BookingWebCalendarReadPool,
  property: TargetCheckoutPropertyRow,
  booking: TargetBookingRow,
  quote: TargetCheckoutQuoteSnapshot,
  request: BookingWebCheckoutRequest,
  context: BookingWebCheckoutCommandContext,
): Promise<void> {
  if (quote.paymentMethod !== "bank_transfer") return;
  if (booking.lifecycleStatus !== "pending_payment" || booking.paymentStatus !== "unpaid") return;

  const settings = await loadTargetPaymentSettings(pool, property.propertyId);
  if (!settings?.acceptedMethods?.includes("bank_transfer")) return;
  const bankTransferDetails = bankTransferInstructionsFromPolicy(settings.depositPolicy);
  if (!bankTransferDetails) return;

  await enqueueBookingLifecycleEmailJob(pool, {
    kind: "reserved_pending_payment",
    occurredAt: context.occurredAt.toISOString(),
    correlationId: context.correlationId,
    causationId: `booking.checkout.create:${context.idempotencyKey}`,
    actor: { type: "provider" },
    source: "apps/api-booking-web-public",
    paymentDeadlineAt: new Date(context.occurredAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    bankTransferDetails,
    booking: {
      propertyId: property.propertyId,
      guestBookingId: booking.guestBookingId,
      bookingReference: booking.publicReference,
      guestEmail: stringField(request, "guestEmail") ?? stringField(request, "email"),
      guestName:
        [stringField(request, "firstName"), stringField(request, "lastName")]
          .filter(Boolean)
          .join(" ") || null,
      propertyName: property.displayName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      totalAmount: booking.totalAmount,
      balanceAmount: booking.balanceAmount,
      currency: booking.currency,
      paymentMethod: "bank_transfer",
    },
  });
}

async function validateTargetPromo(
  pool: BookingWebCalendarReadPool,
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
  pool: pg.Pool,
  propertyId: string,
  booking: TargetBookingRow,
  context: BookingWebCheckoutCommandContext,
  operation: "create" | "update" | "cancel",
): Promise<void> {
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
      `booking-checkout:${operation}:${booking.guestBookingId}:${context.fingerprint}`,
      `pms.reservation.${operation}`,
      propertyId,
      booking.guestBookingId,
      context.correlationId,
      sha256Hex(pmsReservationHandoffIdempotencyKey(propertyId, booking.guestBookingId, operation)),
      JSON.stringify({
        operation,
        contractVersion: "pms-reservation.v1",
        commandId: `cmd_pms_${operation}_${sha256Hex(`${propertyId}:${booking.guestBookingId}:${operation}`).slice(0, 24)}`,
        idempotencyKey: pmsReservationHandoffIdempotencyKey(
          propertyId,
          booking.guestBookingId,
          operation,
        ),
        audit: {
          requestId: context.requestId,
          correlationId: context.correlationId,
          propertyId,
          actorType: "guest",
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

async function reserveTargetCheckoutCommand(
  pool: BookingWebCalendarReadPool,
  propertyId: string,
  context: BookingWebCheckoutCommandContext,
): Promise<void> {
  const keyHash = sha256Hex(context.idempotencyKey);
  const existing = await pool.query<{ requestFingerprintHash: string; status: string }>(
    `SELECT request_fingerprint_hash AS "requestFingerprintHash", status
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
  if (row && row.requestFingerprintHash !== context.fingerprint) {
    throw createHttpError(409, "Idempotency key was already used for a different request.");
  }
  if (row?.status === "completed") {
    throw createHttpError(409, "Checkout command was already completed.");
  }
  await pool.query(
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
       SET last_seen_at = now(),
           status = CASE
             WHEN platform.idempotency_keys.request_fingerprint_hash = EXCLUDED.request_fingerprint_hash
             THEN platform.idempotency_keys.status
             ELSE 'conflict'
           END`,
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
}

export async function recordTargetCheckoutCommand(
  pool: BookingWebCalendarReadPool,
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
         $11::jsonb,
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
      }),
      `${input.context.operation}:${input.resourceId}:${input.context.fingerprint}`,
      `checkout.${input.context.operation}`,
      JSON.stringify({ operation: input.context.operation, resourceId: input.resourceId }),
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
  const authoritativeBalanceAmount = quote?.balanceAmount ?? authoritativeTotalAmount;
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
      unavailableDates: [],
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

function depositPercentageFromPolicy(value: unknown): number | null {
  const policy = objectValue(value);
  const deposit = objectValue(policy["deposit"]);
  const direct =
    numberValue(policy["depositPercentage"]) ??
    numberValue(policy["percentage"]) ??
    numberValue(deposit["percentage"]);
  if (direct !== null && direct > 0) return direct;

  const summary =
    stringValue(policy["depositSummary"]) ??
    stringValue(policy["summary"]) ??
    stringValue(policy["deposit"]) ??
    stringValue(deposit["summary"]);
  const match = summary?.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
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

function paymentStatusFromRequest(record: Record<string, unknown>): string {
  const value = stringField(record, "paymentStatus");
  if (
    value === "unpaid" ||
    value === "authorized" ||
    value === "partially_paid" ||
    value === "paid" ||
    value === "refunded" ||
    value === "failed" ||
    value === "waived"
  ) {
    return value;
  }
  return stringField(record, "paymentMethod") === "card" ? "authorized" : "unpaid";
}

function lifecycleStatusFromCheckout(quote: TargetCheckoutQuoteSnapshot): string {
  return quote.paymentMethod === "bank_transfer" ? "pending_payment" : "confirmed";
}

function assertTargetPaymentMethodReady(record: Record<string, unknown>): void {
  const method = stringField(record, "paymentMethod");
  if (method === "card" || method === "xendit") {
    throw createHttpError(
      503,
      "Target card authorization is not configured for Booking Web checkout.",
    );
  }
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
}

function pmsReservationHandoffIdempotencyKey(
  propertyId: string,
  guestBookingId: string,
  operation: "create" | "update" | "cancel",
): string {
  return `pms.reservation.${operation}:property:${propertyId}:booking:${guestBookingId}:v1`;
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
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
  return {
    operation,
    requestId: String(request.id),
    correlationId: firstString(request.headers["x-correlation-id"]) ?? String(request.id),
    idempotencyKey: headerKey ?? `booking.checkout:${operation}:${resource}:${fingerprint}`,
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
