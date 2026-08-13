"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { RoomType } from "@/lib/types";
import type { PointOfInterest } from "@/lib/types";
import { useCurrency } from "@/contexts/CurrencyContext";
import LocationMap from "@/components/booking/LocationMap";
import {
  getFlexibleNightlyRates,
  getFreeCancellationDays,
  getNonRefundableNightlyRates,
  hasVariableNightlyRates,
  isFlexibleCancellationExpired,
} from "@/lib/constants/booking";
import { bookingImageSizes } from "@/components/booking/imageSizes";

const AMENITIES_PREVIEW_COUNT = 6;

interface RoomDetailModalProps {
  room: RoomType;
  nights: number;
  open: boolean;
  onClose: () => void;
  currentIndex: number;
  totalRooms: number;
  onPrev: () => void;
  onNext: () => void;
  onSelectRate: (rateType: "flexible" | "nonrefundable") => void;
  soldOut?: boolean;
  checkInTime?: string;
  checkOutTime?: string;
  checkIn: string;
  hotelTimezone?: string;
  propertyName: string;
  showLocationMap?: boolean;
  pointsOfInterest?: PointOfInterest[];
  selectRateDisabled?: boolean;
  selectRatePending?: boolean;
}

export default function RoomDetailModal({
  room,
  nights,
  open,
  onClose,
  currentIndex,
  totalRooms,
  onPrev,
  onNext,
  onSelectRate,
  soldOut = false,
  checkInTime,
  checkOutTime,
  checkIn,
  hotelTimezone,
  propertyName,
  showLocationMap = false,
  pointsOfInterest = [],
  selectRateDisabled = false,
  selectRatePending = false,
}: RoomDetailModalProps) {
  const flexibleExpired = isFlexibleCancellationExpired(checkIn, room, hotelTimezone);
  // VAY-370: hide Flexible Rate when its cancellation deadline has passed, unless there is
  // no Non-Refundable Rate (in which case keep it shown with replacement copy).
  const showFlexibleRate =
    room.flexibleRateEnabled !== false && (!flexibleExpired || room.nonRefundableRate == null);
  const [imgIndex, setImgIndex] = useState(0);
  const [showAllAmenities, setShowAllAmenities] = useState(false);
  const [selectedRate, setSelectedRate] = useState<"flexible" | "nonrefundable">(
    showFlexibleRate ? "flexible" : "nonrefundable",
  );
  // If Flexible disappears (e.g. user changes check-in date while modal is open) and the
  // current selection is no longer available, fall back to nonrefundable.
  useEffect(() => {
    if (!showFlexibleRate && selectedRate === "flexible" && room.nonRefundableRate != null) {
      setSelectedRate("nonrefundable");
    }
  }, [showFlexibleRate, selectedRate, room.nonRefundableRate]);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const navigatingAwayRef = useRef(false);
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();
  const tc = useTranslations("common");
  const t = useTranslations("home");

  const hasMultipleImages = room.images.length > 1;
  const hasRoomCoordinates = Number.isFinite(room.latitude) && Number.isFinite(room.longitude);
  const goPrevImage = () => setImgIndex((i) => (i - 1 + room.images.length) % room.images.length);
  const goNextImage = () => setImgIndex((i) => (i + 1) % room.images.length);
  const handleTouchStart = (e: React.TouchEvent) => setTouchStartX(e.touches[0].clientX);
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(delta) > 50) {
      if (delta < 0) goNextImage();
      else goPrevImage();
    }
    setTouchStartX(null);
  };

  // Reset image index when switching between rooms
  useEffect(() => {
    setImgIndex(0);
    setShowAllAmenities(false);
  }, [room]);

  // Lock body scroll when modal is open to prevent background scroll-bleed on mobile
  useEffect(() => {
    if (open) {
      const original = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [open]);

  // Map browser back button to closing the modal instead of leaving the page
  useEffect(() => {
    if (!open) return;
    let closedByPop = false;
    window.history.pushState({ vayRoomModal: true }, "");
    const onPop = () => {
      closedByPop = true;
      onClose();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (
        !navigatingAwayRef.current &&
        !closedByPop &&
        typeof window !== "undefined" &&
        (window.history.state as { vayRoomModal?: boolean } | null)?.vayRoomModal
      ) {
        window.history.back();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const flexibleNightlies = getFlexibleNightlyRates(room, nights).map((rate) =>
    convertAndRound(rate, room.currency),
  );
  const flexibleFromNightly = flexibleNightlies.length > 0 ? Math.min(...flexibleNightlies) : 0;
  const flexibleTotal = flexibleNightlies.reduce((sum, rate) => sum + rate, 0);
  const flexibleVaries = hasVariableNightlyRates(flexibleNightlies);
  const nonRefundableNightlies = getNonRefundableNightlyRates(room, nights).map((rate) =>
    convertAndRound(rate, room.currency),
  );
  const nonRefundableFromNightly =
    nonRefundableNightlies.length > 0 ? Math.min(...nonRefundableNightlies) : 0;
  const nonRefundableTotal = nonRefundableNightlies.reduce((sum, rate) => sum + rate, 0);
  const nonRefundableVaries = hasVariableNightlyRates(nonRefundableNightlies);
  const discount =
    flexibleTotal > 0 ? Math.round((1 - nonRefundableTotal / flexibleTotal) * 100) : 0;
  const flexibleNightlyLabel = flexibleVaries
    ? tc("fromPrice", { price: formatPrice(flexibleFromNightly, selectedCurrency) })
    : formatPrice(flexibleFromNightly, selectedCurrency);
  const nonRefundableNightlyLabel = nonRefundableVaries
    ? tc("fromPrice", { price: formatPrice(nonRefundableFromNightly, selectedCurrency) })
    : formatPrice(nonRefundableFromNightly, selectedCurrency);
  const handleSelectRate = () => {
    if (soldOut || selectRateDisabled) return;
    navigatingAwayRef.current = true;
    try {
      onSelectRate(selectedRate);
    } catch (error) {
      navigatingAwayRef.current = false;
      throw error;
    }
  };
  const visibleAmenities = showAllAmenities
    ? room.amenities
    : room.amenities.slice(0, AMENITIES_PREVIEW_COUNT);
  const remainingAmenities = Math.max(room.amenities.length - AMENITIES_PREVIEW_COUNT, 0);
  const amenitiesId = `room-amenities-${room.id}`;

  // Rate option buttons — shared between mobile scroll body and desktop sticky footer
  const rateOptionsJsx = (
    <div className="space-y-3">
      {/* Flexible Rate */}
      {showFlexibleRate && (
        <button
          onClick={() => setSelectedRate("flexible")}
          disabled={selectRateDisabled}
          className={`w-full text-left rounded-xl border-2 p-4 transition-colors disabled:cursor-not-allowed ${selectRateDisabled ? "opacity-60" : ""} ${selectedRate === "flexible" ? "border-primary-500" : "border-gray-200 hover:border-gray-300"}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <svg
                className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900">Flexible Rate</p>
                {flexibleExpired ? (
                  <p className="text-xs text-gray-500">Cancellation no longer available</p>
                ) : room.flexibleCancellationType === "partial_refund" ? (
                  (() => {
                    const tiers =
                      room.partialRefundTiers && room.partialRefundTiers.length > 0
                        ? [...room.partialRefundTiers].sort(
                            (a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn,
                          )
                        : null;
                    if (tiers) {
                      return (
                        <ul className="text-xs text-gray-500 space-y-0.5">
                          {tiers.map((t, i) => (
                            <li key={i}>
                              {i === 0
                                ? `≥ ${t.minDaysBeforeCheckIn} days before: ${t.refundPercent}% refund`
                                : `${tiers[i - 1].minDaysBeforeCheckIn - 1}–${t.minDaysBeforeCheckIn} days before: ${t.refundPercent}% refund`}
                            </li>
                          ))}
                          {tiers[tiers.length - 1].minDaysBeforeCheckIn > 0 && (
                            <li>{`< ${tiers[tiers.length - 1].minDaysBeforeCheckIn} days before: non-refundable`}</li>
                          )}
                        </ul>
                      );
                    }
                    return (
                      <p className="text-xs text-gray-500">
                        {`${room.partialRefundAmountPercent ?? 50}% refund if cancelled at least ${room.partialRefundCancelWindowDays ?? 30} days before`}
                      </p>
                    );
                  })()
                ) : (
                  <p className="text-xs text-gray-500">
                    {`Free cancellation until ${getFreeCancellationDays(room.cancellationPolicy)} days before`}
                  </p>
                )}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-base md:text-lg font-bold text-gray-900 whitespace-nowrap">
                {flexibleNightlyLabel}
              </p>
              <p className="text-xs text-gray-500">/night</p>
            </div>
          </div>
        </button>
      )}

      {/* Non-Refundable */}
      {room.nonRefundableRate != null && (
        <button
          onClick={() => setSelectedRate("nonrefundable")}
          disabled={selectRateDisabled}
          className={`w-full text-left rounded-xl border-2 p-4 transition-colors disabled:cursor-not-allowed ${selectRateDisabled ? "opacity-60" : ""} ${selectedRate === "nonrefundable" ? "border-primary-500" : "border-gray-200 hover:border-gray-300"}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <svg
                className="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900 flex items-center gap-2 flex-wrap">
                  Non-Refundable Rate
                  {discount > 0 && (
                    <span className="text-[10px] font-bold bg-primary-600 text-white px-1.5 py-0.5 rounded whitespace-nowrap">
                      -{discount}% OFF
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500">Non-refundable</p>
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-base md:text-lg font-bold text-gray-900 whitespace-nowrap">
                {nonRefundableNightlyLabel}
              </p>
              <p className="text-xs text-gray-500">/night</p>
            </div>
          </div>
        </button>
      )}
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`room-detail-title-${room.id}`}
      className="fixed inset-0 z-[100] flex items-stretch md:items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white md:rounded-2xl shadow-2xl w-full md:max-w-5xl h-full md:h-[90vh] overflow-hidden flex flex-col overscroll-contain"
      >
        {/* Top bar with nav */}
        <div className="flex items-center justify-end gap-2 px-4 pt-3 pb-1 flex-shrink-0">
          <button
            onClick={onPrev}
            className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500"
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
          <span className="text-sm text-gray-500 font-medium">
            {currentIndex + 1} / {totalRooms}
          </span>
          <button
            onClick={onNext}
            className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-500 ml-1"
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

        {/* VAY-444: on mobile the entire content scrolls as one flow; on desktop keep two-column layout */}
        <div className="flex flex-col md:flex-row overflow-y-auto md:overflow-hidden flex-1 min-h-0 overscroll-contain">
          {/* Left — Images */}
          <div className="md:w-1/2 md:flex-shrink-0 flex flex-col md:min-h-0">
            <div
              className="relative h-72 md:h-auto md:flex-1 md:min-h-[300px] flex-shrink-0 select-none"
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              <Image
                src={room.images[imgIndex]}
                alt={room.name}
                fill
                className="object-cover"
                sizes={bookingImageSizes.roomModal}
              />
              <div className="absolute bottom-3 left-3 bg-black/60 text-white text-xs px-3 py-1 rounded-full">
                {room.name}
              </div>
              {hasMultipleImages && (
                <>
                  <button
                    onClick={goPrevImage}
                    aria-label="Previous image"
                    className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/85 hover:bg-white text-gray-700 shadow-md transition-colors"
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
                  <button
                    onClick={goNextImage}
                    aria-label="Next image"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/85 hover:bg-white text-gray-700 shadow-md transition-colors"
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
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                    {room.images.map((_, i) => (
                      <span
                        key={i}
                        className={`h-1.5 rounded-full transition-all ${i === imgIndex ? "w-4 bg-white" : "w-1.5 bg-white/60"}`}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
            {hasMultipleImages && (
              <div className="flex gap-1.5 p-3 flex-shrink-0 bg-white overflow-x-auto">
                {room.images.map((img, i) => (
                  <button
                    key={i}
                    onClick={() => setImgIndex(i)}
                    className={`relative w-16 h-12 flex-shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${i === imgIndex ? "border-primary-500" : "border-transparent"}`}
                  >
                    <Image
                      src={img}
                      alt=""
                      fill
                      className="object-cover"
                      sizes={bookingImageSizes.roomThumb}
                      loading="lazy"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right — Details */}
          <div className="md:w-1/2 flex flex-col md:flex-1 md:min-h-0">
            {/* On desktop this div scrolls; on mobile the parent wrapper scrolls */}
            <div className="md:flex-1 md:overflow-y-auto overscroll-contain p-6">
              {soldOut && (
                <div className="mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-gray-100 border border-gray-200 text-gray-800">
                  <svg
                    className="w-5 h-5 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-2.99l-7.07-12a2 2 0 00-3.48 0l-7.07 12A2 2 0 004.93 19z"
                    />
                  </svg>
                  <span className="text-sm font-semibold">Sold Out for your selected dates</span>
                </div>
              )}
              <div className="flex items-center gap-2 mb-2">
                <h2
                  id={`room-detail-title-${room.id}`}
                  className="text-2xl font-bold text-gray-900"
                >
                  {room.name}
                </h2>
                {room.category && (
                  <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-primary-50 text-primary-700 border border-primary-200">
                    {room.category}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3 text-sm text-gray-500 mb-4 flex-wrap">
                <span className="flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                    />
                  </svg>
                  {room.size} m&sup2;
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  Up to {room.maxOccupancy} guests
                </span>
                <span className="flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"
                    />
                  </svg>
                  {room.bedType}
                </span>
              </div>

              <p className="text-sm text-gray-600 leading-relaxed mb-4">{room.description}</p>

              {(checkInTime || checkOutTime) && (
                <div className="flex items-center gap-2 text-sm text-gray-700 mb-4 px-3 py-2 rounded-lg bg-gray-50 border border-gray-100">
                  <svg
                    className="w-4 h-4 text-primary-600 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {checkInTime && <span>{tc("checkInFrom", { time: checkInTime })}</span>}
                    {checkInTime && checkOutTime && (
                      <span className="text-gray-300" aria-hidden>
                        ·
                      </span>
                    )}
                    {checkOutTime && <span>{tc("checkOutBy", { time: checkOutTime })}</span>}
                  </span>
                </div>
              )}

              {/* Amenities */}
              {room.amenities.length > 0 && (
                <div className="mb-4">
                  <div id={amenitiesId} className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {visibleAmenities.map((amenity, index) => (
                      <span
                        key={`${amenity}-${index}`}
                        className="flex min-w-0 items-center gap-1.5 text-sm text-gray-600"
                      >
                        <svg
                          className="w-3.5 h-3.5 text-primary-500 flex-shrink-0"
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
                        <span className="truncate" title={amenity}>
                          {amenity}
                        </span>
                      </span>
                    ))}
                  </div>
                  {remainingAmenities > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowAllAmenities(!showAllAmenities)}
                      aria-expanded={showAllAmenities}
                      aria-controls={amenitiesId}
                      className="mt-2 flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700"
                    >
                      {showAllAmenities
                        ? t("showLess")
                        : t("viewFullAmenities", { count: remainingAmenities })}
                      <svg
                        className={`w-4 h-4 transition-transform ${showAllAmenities ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              )}

              {showLocationMap && hasRoomCoordinates && (
                <div className="mb-4 border-t border-gray-100 pt-4">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                    Location
                  </p>
                  <LocationMap
                    propertyName={propertyName}
                    property={{ latitude: room.latitude!, longitude: room.longitude! }}
                    pois={pointsOfInterest}
                  />
                </div>
              )}

              {/* Book Direct Benefits */}
              {room.benefits && room.benefits.length > 0 && (
                <div className="bg-accent rounded-xl p-4 mb-4 border border-gray-100">
                  <p className="text-sm font-bold text-gray-900 flex items-center gap-2 mb-2">
                    <svg
                      className="w-4 h-4 text-primary-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                      />
                    </svg>
                    Book Direct Benefits
                  </p>
                  <div className="space-y-1.5">
                    {room.benefits.map((benefit) => (
                      <p key={benefit} className="text-sm text-gray-600 flex items-center gap-2">
                        <svg
                          className="w-3.5 h-3.5 text-primary-500 flex-shrink-0"
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
                        {benefit}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {/* Mobile: rate options flow inline so user scrolls past them naturally */}
              <div className="md:hidden pt-4 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Select Your Rate
                </p>
                {rateOptionsJsx}
              </div>
            </div>

            {/* Desktop sticky footer — rate selection always visible regardless of scroll */}
            <div className="hidden md:block flex-shrink-0 border-t border-gray-100 bg-white px-6 py-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Select Your Rate
              </p>
              {rateOptionsJsx}
              <button
                data-testid={`select-rate-modal-desktop-${room.id}`}
                onClick={handleSelectRate}
                disabled={soldOut || selectRateDisabled}
                aria-busy={selectRatePending}
                aria-live={selectRatePending ? "polite" : undefined}
                className="w-full mt-4 py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-600"
              >
                <span className="inline-flex items-center justify-center gap-2">
                  {selectRatePending && (
                    <span
                      className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  <span>
                    {soldOut
                      ? t("soldOut")
                      : selectRatePending
                        ? t("selectingRate")
                        : t("selectThisRate")}
                  </span>
                </span>
              </button>

              {!soldOut && room.remainingRooms <= 3 && (
                <p
                  className={`text-sm mt-3 flex items-center gap-1.5 font-medium ${
                    room.remainingRooms === 1 ? "text-red-700" : "text-amber-800"
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      room.remainingRooms === 1 ? "bg-red-500" : "bg-amber-500"
                    }`}
                  />
                  {room.remainingRooms === 1
                    ? tc("lastRoomLeft")
                    : tc("onlyLeft", { count: room.remainingRooms })}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Mobile sticky CTA — outside scroll area so it's always reachable */}
        <div className="md:hidden flex-shrink-0 border-t border-gray-100 bg-white px-6 py-4">
          <button
            data-testid={`select-rate-modal-mobile-${room.id}`}
            onClick={handleSelectRate}
            disabled={soldOut || selectRateDisabled}
            aria-busy={selectRatePending}
            aria-live={selectRatePending ? "polite" : undefined}
            className="w-full py-3 bg-primary-600 text-white font-semibold rounded-xl hover:bg-primary-700 transition-colors text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-600"
          >
            <span className="inline-flex items-center justify-center gap-2">
              {selectRatePending && (
                <span
                  className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
                  aria-hidden="true"
                />
              )}
              <span>
                {soldOut
                  ? t("soldOut")
                  : selectRatePending
                    ? t("selectingRate")
                    : t("selectThisRate")}
              </span>
            </span>
          </button>

          {!soldOut && room.remainingRooms <= 3 && (
            <p
              className={`text-sm mt-3 flex items-center gap-1.5 font-medium ${
                room.remainingRooms === 1 ? "text-red-700" : "text-amber-800"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  room.remainingRooms === 1 ? "bg-red-500" : "bg-amber-500"
                }`}
              />
              {room.remainingRooms === 1
                ? tc("lastRoomLeft")
                : tc("onlyLeft", { count: room.remainingRooms })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
