"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { Addon } from "@/lib/types";
import { useCurrency } from "@/contexts/CurrencyContext";
import { useHotel } from "@/contexts/HotelContext";
import { bookingImageSizes } from "@/components/booking/imageSizes";

interface AddonDetailModalProps {
  addon: Addon;
  open: boolean;
  onClose: () => void;
  isAdded: boolean;
  onToggle: () => void;
  currentIndex: number;
  totalAddons: number;
  onPrev: () => void;
  onNext: () => void;
}

export default function AddonDetailModal({
  addon,
  open,
  onClose,
  isAdded,
  onToggle,
  currentIndex,
  totalAddons,
  onPrev,
  onNext,
}: AddonDetailModalProps) {
  const [imgIndex, setImgIndex] = useState(0);
  useEffect(() => {
    setImgIndex(0);
  }, [addon.id]);
  const { formatPrice } = useCurrency();
  const { hotel } = useHotel();
  const t = useTranslations("addons");

  if (!open) return null;

  const images = Array.from(new Set([addon.image, ...(addon.images ?? [])].filter(Boolean)));

  return (
    <div
      role="dialog"
      aria-label={addon.name}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero Image */}
        <div className="relative h-64 sm:h-72 flex-shrink-0">
          <Image
            src={images[imgIndex]}
            alt={addon.name}
            fill
            className="object-cover"
            sizes={bookingImageSizes.addonModal}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />

          {/* Navigation + Close */}
          <div className="absolute top-3 right-3 flex items-center gap-2">
            <button
              onClick={onPrev}
              className="p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <span className="text-sm text-white font-medium">
              {currentIndex + 1} / {totalAddons}
            </span>
            <button
              onClick={onNext}
              className="p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
            <button
              aria-label={t("closeDetails")}
              onClick={onClose}
              className="p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white transition-colors ml-1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Category badge + Title overlay */}
          <div className="absolute bottom-4 left-5 right-5">
            <span className="inline-block text-xs font-medium px-3 py-1 rounded-full bg-primary-600/90 text-white mb-2 capitalize">
              {addon.category}
            </span>
            <h2 className="text-2xl font-bold text-white">{addon.name}</h2>
          </div>

          {/* Image thumbnails */}
          {images.length > 1 && (
            <div className="absolute bottom-4 right-5 flex gap-1.5">
              {images.map((img, i) => (
                <button
                  key={i}
                  aria-label={t("showPhoto", { number: i + 1 })}
                  aria-pressed={i === imgIndex}
                  onClick={() => setImgIndex(i)}
                  className={`relative w-12 h-9 rounded-lg overflow-hidden border-2 transition-colors ${i === imgIndex ? "border-white" : "border-white/40"}`}
                >
                  <Image
                    src={img}
                    alt=""
                    fill
                    className="object-cover"
                    sizes={bookingImageSizes.addonThumb}
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-5 sm:p-6 overflow-y-auto flex-1">
          {/* Meta info row */}
          {(addon.duration || addon.maxGuests || addon.location) && (
            <div className="flex items-center gap-5 text-sm text-gray-500 mb-5 flex-wrap">
              {addon.duration && (
                <span className="flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  {addon.duration}
                </span>
              )}
              {addon.maxGuests && (
                <span className="flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  {addon.maxGuests}
                </span>
              )}
              {addon.location && (
                <span className="flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  {addon.location}
                </span>
              )}
            </div>
          )}

          {/* About this experience */}
          <div className="mb-5">
            <h3 className="text-base font-bold text-gray-900 mb-2">{t("aboutThisExperience")}</h3>
            <p className="text-sm text-gray-600 leading-relaxed">{addon.description}</p>
            {addon.leadTime && (
              <p className="mt-3 text-sm text-gray-500">
                {t("leadTime")}: {addon.leadTime}
              </p>
            )}
          </div>

          {/* Highlights */}
          {addon.highlights && addon.highlights.length > 0 && (
            <div className="mb-5">
              <h3 className="text-base font-bold text-gray-900 mb-2">{t("highlights")}</h3>
              <div className="flex flex-wrap gap-2">
                {addon.highlights.map((h) => (
                  <span
                    key={h}
                    className="text-sm px-3 py-1.5 rounded-full bg-primary-50 text-primary-700 border border-primary-200 font-medium"
                  >
                    {h}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* What's included */}
          {addon.includedItems && addon.includedItems.length > 0 && (
            <div className="mb-5">
              <h3 className="text-base font-bold text-gray-900 mb-2">{t("whatsIncluded")}</h3>
              <div className="grid grid-cols-2 gap-1.5">
                {addon.includedItems.map((item) => (
                  <span key={item} className="flex items-center gap-2 text-sm text-gray-600">
                    <svg
                      className="w-4 h-4 text-primary-500 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {item}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer — price + action */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-t border-gray-200 flex-shrink-0 bg-white">
          <div>
            <p className="text-xs text-gray-500">
              {addon.perPerson && addon.perNight
                ? t("pricePerPersonNight")
                : addon.perPerson
                  ? t("pricePerPerson")
                  : addon.perNight
                    ? t("pricePerDay")
                    : t("priceLabel")}
            </p>
            <p className="text-2xl font-bold text-gray-900">
              {formatPrice(addon.price, hotel?.currency || "EUR")}
            </p>
          </div>
          <button
            onClick={onToggle}
            className={`px-8 py-3 rounded-full text-sm font-semibold transition-colors flex items-center gap-2 ${
              isAdded
                ? "bg-primary-600 text-white hover:bg-primary-700"
                : "bg-primary-600 text-white hover:bg-primary-700"
            }`}
          >
            {isAdded ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                {t("addedToTrip")}
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                {t("addToTrip")}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
