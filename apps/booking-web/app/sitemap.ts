import type { MetadataRoute } from "next";
import { headers } from "next/headers";

import { routing } from "@/i18n/routing";
import { getRequestHost } from "@/lib/requestHost";
import { publicHotelSitemapEntries } from "@/lib/server/publicUrls";
import { resolveSlugFromHost } from "@/lib/server/resolveSlug";
import {
  fetchPublicHotel,
  requestProtocol,
  resolveHotelUrlPolicy,
} from "@/lib/server/publicHotelMetadata";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const headersList = await headers();
  const hostname = getRequestHost(headersList);
  const slug = await resolveSlugFromHost(hostname);
  if (!slug) return [];

  const hotel = await fetchPublicHotel(slug, routing.defaultLocale);
  if (!hotel) return [];

  const policy = resolveHotelUrlPolicy(
    hostname,
    requestProtocol(headersList),
    routing.defaultLocale,
    hotel,
    slug,
  );

  return publicHotelSitemapEntries(policy).map((entry) => ({
    url: entry.url,
    changeFrequency: "daily",
    priority: entry.url === policy.canonicalUrl ? 1 : 0.8,
    alternates: {
      languages: entry.alternates,
    },
  }));
}
