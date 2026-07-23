import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { getRequestHost } from "./lib/requestHost";
import {
  getCanonicalHostRedirectUrl,
  isFallbackBookingHost,
  resolvePublicHotelUrls,
} from "./lib/server/publicUrls";
import {
  bookingWebPublicApi,
  PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS,
  type BookingWebPublicHostResponse,
} from "./services/api/bookingWebPublic";

const intlMiddleware = createMiddleware(routing);

function normalizeHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    return normalized.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1");
  }
  return normalized.replace(/:\d+$/, "");
}

function getKnownSubdomainSlug(hostname: string): string | null {
  const host = normalizeHost(hostname);
  const parts = host.split(".");

  if (
    host.endsWith(".booking.vayada.com") ||
    host.endsWith(".next-booking.vayada.com") ||
    host.endsWith(".booking.localhost")
  ) {
    return parts.length >= 3 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
  }

  if (host.endsWith(".localhost")) {
    return parts.length === 2 && parts[0] !== "www" && parts[0] !== "booking" ? parts[0] : null;
  }

  return null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.startsWith("127.0.0.1") || hostname === "::1";
}

export default async function middleware(request: NextRequest) {
  const response = intlMiddleware(request);

  // Hostnames are case-insensitive per RFC 1035 §2.3.3 but the backend
  // lookup keys are stored lowercased — normalize here so a stray
  // uppercase Host header still resolves.
  const requestHost = getRequestHost(request.headers);
  const hostname = normalizeHost(requestHost);

  const knownSlug = getKnownSubdomainSlug(hostname);
  let hostResolution: BookingWebPublicHostResponse | null = null;
  let slug = knownSlug;

  if (
    !isLocalHost(hostname) &&
    (knownSlug ||
      (!hostname.includes("localhost") &&
        !hostname.endsWith(".booking.vayada.com") &&
        !hostname.endsWith(".next-booking.vayada.com")))
  ) {
    hostResolution = await fetchHostResolution(hostname);
    slug = hostResolution?.slug || knownSlug;
  }

  if (slug) {
    const canonicalRedirect = hostResolution
      ? resolveCanonicalRedirect(request, hostname, slug, hostResolution)
      : null;
    if (canonicalRedirect) return canonicalRedirect;
    response.cookies.set("hotel-slug", slug, { path: "/" });
  }

  // Capture referral code from ?ref= query param → 30-day cookie
  const refCode = request.nextUrl.searchParams.get("ref");
  if (refCode) {
    response.cookies.set("ref", refCode, {
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      sameSite: "lax",
    });
  }

  return response;
}

async function fetchHostResolution(hostname: string): Promise<BookingWebPublicHostResponse | null> {
  try {
    return await bookingWebPublicApi.resolveHost(hostname, {
      next: { revalidate: PUBLIC_BOOKING_HOST_REVALIDATE_SECONDS },
    });
  } catch {
    return null;
  }
}

function resolveCanonicalRedirect(
  request: NextRequest,
  hostname: string,
  slug: string,
  hostResolution: BookingWebPublicHostResponse,
): NextResponse | null {
  if (!isFallbackBookingHost(hostname)) return null;

  const requestHost = getRequestHost(request.headers) || hostname;
  const policy = resolvePublicHotelUrls({
    requestHost,
    requestProtocol: request.nextUrl.protocol === "http:" ? "http" : "https",
    slug: hostResolution.hotel?.slug || slug,
    locale: firstLocaleSegment(request.nextUrl.pathname) || "en",
    supportedLocales: hostResolution.hotel?.supportedLocales,
    customDomainUrl: hostResolution.customDomainUrl,
  });
  const publicRequestUrl = new URL(request.nextUrl.toString());
  publicRequestUrl.host = requestHost;
  const redirectUrl = getCanonicalHostRedirectUrl(policy, publicRequestUrl);
  return redirectUrl ? NextResponse.redirect(redirectUrl, 308) : null;
}

function firstLocaleSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return routing.locales.includes(segment as (typeof routing.locales)[number]) ? segment : null;
}

export const config = {
  matcher: "/((?!api|trpc|_next|_vercel|.*\\..*).*)",
};
