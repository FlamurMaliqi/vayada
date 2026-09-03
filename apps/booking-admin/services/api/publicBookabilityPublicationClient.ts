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

export type ActiveBookingPublicationRefresh = {
  operationId: string;
  propertyId: string;
  status: "pending" | "succeeded";
  resultContentRevisionId: string | null;
};

export type PublicationReadinessStep = {
  id: "pms" | "payments" | "booking" | "profile";
  label: string;
};

export async function publishPublicBookabilityProfile(
  hotelId: string,
  client: PublicationApiClient = apiClient,
): Promise<PublicBookabilityPublication | ActiveBookingPublicationRefresh> {
  const normalizedHotelId = hotelId.trim();
  if (!normalizedHotelId) throw new Error("Booking hotel id is required.");

  return client.post<PublicBookabilityPublication | ActiveBookingPublicationRefresh>(
    PUBLIC_BOOKABILITY_PUBLICATION_PATH.replace(":hotelId", encodeURIComponent(normalizedHotelId)),
    undefined,
    omitHotelContext,
  );
}

export function isPublicBookabilityReady(publication: PublicBookabilityPublication): boolean {
  return (
    publication.profileStatus === "public" &&
    publication.freshnessStatus === "fresh" &&
    publication.missingReadiness.length === 0
  );
}

export function publicationReadinessSteps(
  publication: PublicBookabilityPublication,
): PublicationReadinessStep[] {
  const missing = new Set(publication.missingReadiness);
  const steps: PublicationReadinessStep[] = [];

  if (
    missing.has("availability_source") ||
    missing.has("availability") ||
    missing.has("sellable_availability") ||
    missing.has("freshness") ||
    publication.freshnessStatus !== "fresh"
  ) {
    steps.push({
      id: "pms",
      label: "Finish PMS setup: connect availability, then add rooms, inventory, and rates",
    });
  }
  if (missing.has("payment_method") || missing.has("payments")) {
    steps.push({
      id: "payments",
      label: "Finish setting up a payment method",
    });
  }
  if (missing.has("booking_settings") || missing.has("default_currency")) {
    steps.push({
      id: "booking",
      label: "Complete the remaining Booking settings",
    });
  }
  if (missing.has("profile") || publication.profileStatus !== "public") {
    steps.push({
      id: "profile",
      label: "Complete the public hotel profile and Brand & Media details",
    });
  }

  if (steps.length === 0 && !isPublicBookabilityReady(publication)) {
    steps.push({
      id: "booking",
      label: "Review the remaining Booking settings",
    });
  }

  return steps;
}
