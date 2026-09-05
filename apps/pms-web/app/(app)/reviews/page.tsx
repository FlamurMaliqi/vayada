"use client";

import { useEffect, useState } from "react";
import { StarIcon } from "@heroicons/react/24/solid";
import { getStoredPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { listPmsReviews, type PmsReview } from "@/services/api/pmsReviewsClient";
import { useTranslation } from "@/lib/i18n";

export default function ReviewsPage() {
  const { t, locale } = useTranslation();
  const [reviews, setReviews] = useState<PmsReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState("");
  const [minRating, setMinRating] = useState("");

  useEffect(() => {
    const propertyId = getStoredPmsPropertyId();
    if (!propertyId) {
      setError(t("reviews.selectProperty"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void listPmsReviews(propertyId, {
      channel: channel || undefined,
      minRating: minRating ? Number(minRating) : undefined,
    })
      .then((response) => setReviews(response.items))
      .catch(() => setError(t("reviews.loadError")))
      .finally(() => setLoading(false));
  }, [channel, minRating, t]);

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-4xl">
        <h1 className="text-xl font-bold text-gray-900">{t("reviews.title")}</h1>
        <p className="mt-1 text-sm text-gray-500">{t("reviews.description")}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <select
            aria-label={t("calendar.newBookingModal.channelLabel")}
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">{t("reviews.allChannels")}</option>
            <option value="booking.com">{t("calendar.channelBookingCom")}</option>
            <option value="airbnb">{t("calendar.channelAirbnb")}</option>
            <option value="expedia">{t("calendar.channelExpedia")}</option>
          </select>
          <select
            aria-label={t("reviews.minimumRating")}
            value={minRating}
            onChange={(event) => setMinRating(event.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">{t("reviews.anyRating")}</option>
            <option value="4">4+</option>
            <option value="3">3+</option>
            <option value="2">2+</option>
            <option value="1">1+</option>
          </select>
        </div>
        <div className="mt-6 space-y-3">
          {loading && <p className="text-sm text-gray-500">{t("reviews.loading")}</p>}
          {error && <p className="rounded-lg bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
          {!loading && !error && reviews.length === 0 && (
            <p className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
              {t("reviews.empty")}
            </p>
          )}
          {reviews.map((review) => (
            <article
              key={review.reviewId}
              className="rounded-xl border border-gray-200 bg-white p-5"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium text-gray-900">
                    {review.guestDisplayName || t("common.guest")}
                  </p>
                  <p className="text-xs text-gray-500">
                    {review.channel || t("reviews.connectedChannel")}
                  </p>
                </div>
                {review.rating && (
                  <span className="flex items-center gap-1 text-sm font-semibold text-amber-600">
                    <StarIcon className="h-4 w-4" /> {review.rating}
                  </span>
                )}
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-gray-700">
                {review.body}
              </p>
              {review.replyBody && (
                <div className="mt-4 rounded-lg bg-gray-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t("reviews.propertyResponse")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-700">
                    {review.replyBody}
                  </p>
                </div>
              )}
              {review.reviewedAt && (
                <time className="mt-3 block text-xs text-gray-400">
                  {new Date(review.reviewedAt).toLocaleDateString(locale)}
                </time>
              )}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
