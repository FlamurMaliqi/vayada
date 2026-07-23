import { apiClient, omitHotelContext, type ApiClient } from "./client";

export const PUBLIC_BOOKABILITY_PUBLICATION_PATH =
  "/api/booking/hotels/:hotelId/public-bookability";

type PublicationApiClient = Pick<ApiClient, "post">;

export type PublicBookabilityPublication = {
  propertyId: string;
  canonicalSlug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  profileStatus: "public" | "incomplete" | "unpublished" | "stale" | "unavailable";
  freshnessStatus: "fresh" | "stale" | "unavailable" | "unknown";
  missingReadiness: string[];
};

export async function publishPublicBookabilityProfile(
  hotelId: string,
  client: PublicationApiClient = apiClient,
): Promise<PublicBookabilityPublication> {
  const normalizedHotelId = hotelId.trim();
  if (!normalizedHotelId) throw new Error("Booking hotel id is required.");

  return client.post<PublicBookabilityPublication>(
    PUBLIC_BOOKABILITY_PUBLICATION_PATH.replace(":hotelId", encodeURIComponent(normalizedHotelId)),
    undefined,
    omitHotelContext,
  );
}

export function publicationReadinessError(
  publication: PublicBookabilityPublication,
): string | null {
  const missing = new Set(publication.missingReadiness);
  const actions: string[] = [];

  if (missing.has("availability_source") || missing.has("availability")) {
    actions.push("connect and configure the property's availability source in PMS");
  }
  if (missing.has("sellable_availability")) {
    actions.push("add future room inventory and rates in PMS");
  }
  if (missing.has("payment_method") || missing.has("payments")) {
    actions.push("choose a usable payment method and finish its setup");
  }
  if (missing.has("booking_settings")) {
    actions.push("complete the required Booking settings");
  }
  if (missing.has("default_currency")) {
    actions.push("set the property's default booking currency");
  }
  if (missing.has("freshness")) {
    actions.push("refresh the PMS availability data");
  }
  if (missing.has("profile") || publication.profileStatus === "unpublished") {
    actions.push("complete the public hotel profile and Brand & Media details");
  }

  if (
    publication.profileStatus === "public" &&
    publication.freshnessStatus === "fresh" &&
    publication.missingReadiness.length === 0
  ) {
    return null;
  }

  const nextSteps = actions.length > 0 ? ` Please ${formatActions(actions)}, then try again.` : "";
  return `Your Booking settings were saved, but the booking page is not ready to go live.${nextSteps}`;
}

function formatActions(actions: string[]): string {
  if (actions.length === 1) return actions[0]!;
  if (actions.length === 2) return `${actions[0]} and ${actions[1]}`;
  return `${actions.slice(0, -1).join(", ")}, and ${actions.at(-1)}`;
}
