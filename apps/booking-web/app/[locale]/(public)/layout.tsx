import type { Metadata } from "next";
import { headers } from "next/headers";

import { getRequestHost } from "@/lib/requestHost";
import { resolveSlugFromHost } from "@/lib/server/resolveSlug";
import type { PublicHotelUrlPolicy } from "@/lib/server/publicUrls";
import {
  absoluteImages,
  buildPublicHotelMetadata,
  fallbackHotelMetadata,
  fetchPublicHotel,
  requestProtocol,
  resolveHotelUrlPolicy,
  type PublicHotelMetadata,
} from "@/lib/server/publicHotelMetadata";

// VAY-394/VAY-663/VAY-832: public hotel SEO metadata belongs only on
// public listing routes. Checkout routes inherit the minimal root metadata
// plus their noindex child metadata instead of paying for public profile
// lookups during task-focused navigation.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const headersList = await headers();
  const hostname = getRequestHost(headersList);
  const slug = await resolveSlugFromHost(hostname);
  if (!slug) return fallbackHotelMetadata;

  const hotel = await fetchPublicHotel(slug, locale);
  if (!hotel) return fallbackHotelMetadata;
  const policy = resolveHotelUrlPolicy(hostname, requestProtocol(headersList), locale, hotel, slug);
  return buildPublicHotelMetadata({ hotel, policy, path: "/" });
}

export default async function PublicHotelLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const headersList = await headers();
  const hostname = getRequestHost(headersList);
  const slug = await resolveSlugFromHost(hostname);
  const hotel = slug ? await fetchPublicHotel(slug, locale) : null;
  const policy = hotel
    ? resolveHotelUrlPolicy(
        hostname,
        requestProtocol(headersList),
        locale,
        hotel,
        slug || hotel.slug || "",
      )
    : null;

  return (
    <>
      <HotelStructuredData hotel={hotel} policy={policy} />
      {children}
    </>
  );
}

function HotelStructuredData({
  hotel,
  policy,
}: {
  hotel: PublicHotelMetadata | null;
  policy: PublicHotelUrlPolicy | null;
}) {
  if (!hotel || !policy) return null;

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Hotel",
    "@id": `${policy.jsonLdUrl}#hotel`,
    name: hotel.name,
    description: hotel.description,
    url: policy.jsonLdUrl,
    image: absoluteImages(policy.bookingBaseUrl, [hotel.heroImage, ...(hotel.images || [])]),
    starRating: hotel.starRating ? { "@type": "Rating", ratingValue: hotel.starRating } : undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: hotel.contact?.address,
      addressLocality: hotel.location,
      addressCountry: hotel.country,
    },
    checkinTime: hotel.checkInTime,
    checkoutTime: hotel.checkOutTime,
  };
  const structuredDataJson = JSON.stringify(structuredData).replace(/</g, "\\u003c");

  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredDataJson }} />
  );
}
