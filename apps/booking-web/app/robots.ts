import type { MetadataRoute } from "next";
import { headers } from "next/headers";

import { routing } from "@/i18n/routing";
import { getRequestHost } from "@/lib/requestHost";
import { privateDisallowRules, publicAllowRules } from "@/lib/server/crawlRules";
import { resolveSlugFromHost } from "@/lib/server/resolveSlug";
import {
  fetchPublicHotel,
  requestProtocol,
  resolveHotelUrlPolicy,
} from "@/lib/server/publicHotelMetadata";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const headersList = await headers();
  const hostname = getRequestHost(headersList);
  const slug = await resolveSlugFromHost(hostname);
  const sitemap = slug ? await resolveSitemapUrl(headersList, hostname, slug) : undefined;

  return {
    rules: {
      userAgent: "*",
      allow: publicAllowRules(routing.locales),
      disallow: privateDisallowRules(routing.locales),
    },
    ...(sitemap ? { sitemap } : {}),
  };
}

async function resolveSitemapUrl(
  headersList: Headers,
  hostname: string,
  slug: string,
): Promise<string | undefined> {
  const hotel = await fetchPublicHotel(slug, routing.defaultLocale);
  if (!hotel) return undefined;
  const policy = resolveHotelUrlPolicy(
    hostname,
    requestProtocol(headersList),
    routing.defaultLocale,
    hotel,
    slug,
  );
  return policy.sitemapUrl;
}
