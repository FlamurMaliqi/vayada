import type { Metadata } from "next";
import { headers } from "next/headers";

import { getRequestHost } from "@/lib/requestHost";
import {
  buildPublicHotelMetadata,
  fallbackHotelMetadata,
  fetchPublicHotel,
  requestProtocol,
  resolveHotelUrlPolicy,
} from "@/lib/server/publicHotelMetadata";
import { resolveSlugFromHost } from "@/lib/server/resolveSlug";

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

  return buildPublicHotelMetadata({ hotel, policy, path: "/rooms" });
}

export default function RoomsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
