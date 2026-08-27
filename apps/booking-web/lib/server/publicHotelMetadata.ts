import type { Metadata } from "next";
import { cache } from "react";

import { routing } from "@/i18n/routing";
import { getRequestHost } from "@/lib/requestHost";
import {
  publicHotelPageHreflangUrls,
  publicHotelPageUrl,
  resolvePublicHotelUrls,
  type PublicHotelCrawlPath,
  type PublicHotelUrlPolicy,
} from "@/lib/server/publicUrls";

export type PublicHotelMetadata = {
  name?: string;
  slug?: string;
  description?: string;
  country?: string;
  location?: string;
  starRating?: number;
  heroImage?: string;
  images?: string[];
  checkInTime?: string;
  checkOutTime?: string;
  contact?: { address?: string; phone?: string; email?: string };
  branding?: { faviconUrl?: string };
  customDomainUrl?: string | null;
  supportedLanguages?: string[];
};

export type PublicHotelProfileResponse = {
  hotel: {
    slug: string;
    name: string;
    description?: string | null;
    summary?: string | null;
    country?: string;
    location: {
      country: string;
      city: string;
      region?: string | null;
    };
    starRating?: number;
    canonicalUrl: string;
    bookingBaseUrl: string;
    customDomainUrl: string | null;
    branding?: {
      heroImage: string | null;
    } | null;
    images: Array<{ url: string; alt?: string | null }>;
    policies: {
      checkInFrom: string | null;
      checkOutUntil: string | null;
    };
    supportedLocales: string[];
  };
};

export const fallbackHotelMetadata: Metadata = {
  title: "Book Your Stay",
  description: "Book your perfect hotel stay.",
  icons: { icon: [{ url: "/vayada-logo.png" }] },
};

export const PUBLIC_HOTEL_METADATA_REVALIDATE_SECONDS = 60;

export const fetchPublicHotel = cache(
  async (slug: string, locale: string): Promise<PublicHotelMetadata | null> =>
    fetchPublicHotelUncached(slug, locale),
);

async function fetchPublicHotelUncached(
  slug: string,
  locale: string,
): Promise<PublicHotelMetadata | null> {
  const apiUrl =
    process.env.BOOKING_WEB_API_URL ||
    process.env.NEXT_PUBLIC_BOOKING_WEB_API_URL ||
    "https://api.localhost";
  const params = new URLSearchParams();
  if (locale) params.set("locale", locale);
  const qs = params.toString();
  try {
    const res = await fetch(
      `${apiUrl}/api/booking-web/hotels/${encodeURIComponent(slug)}${qs ? `?${qs}` : ""}`,
      {
        next: { revalidate: PUBLIC_HOTEL_METADATA_REVALIDATE_SECONDS },
      },
    );
    if (!res.ok) throw new Error(`Booking Web API returned ${res.status}`);
    return toPublicHotelMetadata((await res.json()) as PublicHotelProfileResponse);
  } catch {
    return null;
  }
}

export function resolveHotelUrlPolicy(
  hostname: string,
  protocol: "http" | "https",
  locale: string,
  hotel: PublicHotelMetadata,
  fallbackSlug: string,
): PublicHotelUrlPolicy {
  return resolvePublicHotelUrls({
    requestHost: hostname,
    requestProtocol: protocol,
    slug: hotel.slug || fallbackSlug,
    locale,
    supportedLocales: supportedRoutingLocales(hotel.supportedLanguages, locale),
    customDomainUrl: hotel.customDomainUrl,
  });
}

export function buildPublicHotelMetadata({
  hotel,
  policy,
  path,
}: {
  hotel: PublicHotelMetadata;
  policy: PublicHotelUrlPolicy;
  path: PublicHotelCrawlPath;
}): Metadata {
  const canonicalUrl = publicHotelPageUrl(policy, path);
  const favicon = hotel.branding?.faviconUrl || "/vayada-logo.png";

  return {
    title: hotel.name || fallbackHotelMetadata.title,
    description: hotel.description || String(fallbackHotelMetadata.description),
    icons: { icon: [{ url: favicon }] },
    alternates: {
      canonical: canonicalUrl,
      languages: publicHotelPageHreflangUrls(policy, path),
    },
    openGraph: {
      title: hotel.name || "Book Your Stay",
      description: hotel.description || "Book your perfect hotel stay.",
      url: canonicalUrl,
      type: "website",
      images: absoluteImages(policy.bookingBaseUrl, [hotel.heroImage, ...(hotel.images || [])]),
    },
  };
}

export function requestProtocol(headersList: Headers): "http" | "https" {
  const forwardedProto = headersList.get("x-forwarded-proto");
  if (forwardedProto === "http" || forwardedProto === "https") return forwardedProto;
  const host = getRequestHost(headersList);
  return host.includes("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("::1") ||
    host.startsWith("[::1]")
    ? "http"
    : "https";
}

export function absoluteImages(baseUrl: string, images: Array<string | undefined>): string[] {
  return images
    .filter((image): image is string => Boolean(image))
    .map((image) => new URL(image, baseUrl).toString());
}

function supportedRoutingLocales(locales: string[] | undefined, fallbackLocale: string): string[] {
  const supported = (locales || []).filter((locale) =>
    routing.locales.includes(locale as (typeof routing.locales)[number]),
  );
  if (supported.length > 0) return supported;
  return routing.locales.includes(fallbackLocale as (typeof routing.locales)[number])
    ? [fallbackLocale]
    : [routing.defaultLocale];
}

export function toPublicHotelMetadata(data: PublicHotelProfileResponse): PublicHotelMetadata {
  const hotel = data.hotel;
  const images = hotel.images.map((image) => image.url).filter(Boolean);
  return {
    name: hotel.name,
    slug: hotel.slug,
    description: hotel.summary || hotel.description || undefined,
    country: hotel.location.country || hotel.country,
    location: [hotel.location.city, hotel.location.region].filter(Boolean).join(", "),
    starRating: hotel.starRating || 0,
    heroImage: hotel.branding?.heroImage || undefined,
    images,
    checkInTime: hotel.policies.checkInFrom || undefined,
    checkOutTime: hotel.policies.checkOutUntil || undefined,
    customDomainUrl: hotel.customDomainUrl,
    supportedLanguages: hotel.supportedLocales,
  };
}
