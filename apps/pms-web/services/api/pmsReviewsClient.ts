import { pmsOperationsClient, pmsOperationsRequestOptions } from "./pmsOperationsClient";

export type PmsReview = {
  reviewId: string;
  channel: string | null;
  guestDisplayName: string | null;
  rating: string | null;
  body: string;
  replyBody: string | null;
  reviewedAt: string | null;
  updatedAt: string;
};

export function listPmsReviews(
  propertyId: string,
  filters: { channel?: string; minRating?: number } = {},
): Promise<{
  items: PmsReview[];
  pagination: { total: number; limit: number; offset: number };
}> {
  const query = new URLSearchParams();
  if (filters.channel) query.set("channel", filters.channel);
  if (filters.minRating !== undefined) query.set("minRating", String(filters.minRating));
  return pmsOperationsClient.get(
    `/api/pms/properties/${encodeURIComponent(propertyId)}/reviews?${query}`,
    pmsOperationsRequestOptions,
  );
}
