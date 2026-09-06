import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Hotel } from "@/lib/types";
import { Button, SuccessModal, ErrorModal, PlatformIcon } from "@/components/ui";
import {
  MapPinIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CalendarDaysIcon,
  HomeModernIcon,
} from "@heroicons/react/24/outline";
import { HotelDetailModal } from "./HotelDetailModal";
import {
  CollaborationApplicationModal,
  type CollaborationApplicationData,
  type CollaborationApplicationSubmissionOptions,
} from "./CollaborationApplicationModal";
import {
  collaborationService,
  type CreateCreatorCollaborationRequest,
} from "@/services/api/collaborations";
import { getCurrentUserInfo } from "@/lib/utils/accessControl";
import { getMonthAbbr, sortMonths } from "@/lib/utils/months";
import { formatFollowersCompact } from "@/lib/utils";
import { ROUTES } from "@/lib/constants/routes";

interface HotelCardProps {
  hotel: Hotel;
  creatorPlatforms?: string[];
  isPublic?: boolean;
}

export function HotelCard({ hotel, creatorPlatforms = [], isPublic = false }: HotelCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showApplicationModal, setShowApplicationModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [errorState, setErrorState] = useState<{
    isOpen: boolean;
    message: string;
    title?: string;
  }>({
    isOpen: false,
    message: "",
  });
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  const images = hotel.images && hotel.images.length > 0 ? hotel.images : [];
  const imageListKey = JSON.stringify(images);
  const safeImageIndex = images.length > 0 ? Math.min(currentImageIndex, images.length - 1) : 0;
  const currentImage = images[safeImageIndex];

  useEffect(() => {
    setCurrentImageIndex(0);
    setImageError(false);
  }, [hotel.id, imageListKey]);

  const handleApplicationSubmit = async (
    data: CollaborationApplicationData,
    options: CollaborationApplicationSubmissionOptions,
  ) => {
    try {
      const userInfo = getCurrentUserInfo();
      if (!userInfo.userId) {
        throw new Error("Please log in to apply for collaborations");
      }

      const selectedOffering = hotel.collaborationOfferings?.find(
        (offering) => offering.id === data.compensationOptionId,
      );
      if (!selectedOffering) {
        throw new Error("Choose one of this hotel's compensation options before applying.");
      }
      if (!data.consent) throw new Error("Consent is required before applying.");

      // Transform frontend data to API format
      const request: CreateCreatorCollaborationRequest = {
        initiator_type: "creator",
        listing_id: hotel.id,
        compensation_option_id: selectedOffering.id,
        collaboration_type: selectedOffering.collaboration_type,
        free_stay_min_nights: selectedOffering.free_stay_min_nights ?? undefined,
        free_stay_max_nights: selectedOffering.free_stay_max_nights ?? undefined,
        paid_amount: selectedOffering.paid_max_amount ?? undefined,
        currency: selectedOffering.currency ?? undefined,
        discount_percentage: selectedOffering.discount_percentage ?? undefined,
        creator_fee: selectedOffering.commission_percentage ?? undefined,
        why_great_fit: data.whyGreatFit,
        consent: data.consent,
        travel_date_from: data.travelDateFrom || undefined,
        travel_date_to: data.travelDateTo || undefined,
        preferred_months: data.preferredMonths.length > 0 ? data.preferredMonths : undefined,
        platform_deliverables: (data.platformDeliverables || []).map((pd) => ({
          platform: pd.platform as "Instagram" | "TikTok" | "YouTube",
          deliverables: pd.deliverables.map((d) => ({
            type: d.type,
            quantity: d.quantity,
          })),
        })),
      };

      await collaborationService.create(request, options);
      setShowSuccessModal(true);
    } catch (error) {
      console.error("Failed to submit application:", error);
      const rawMessage =
        error instanceof Error ? error.message : "Failed to submit application. Please try again.";

      let displayMessage = rawMessage;
      let displayTitle = "Application Error";

      if (
        rawMessage.includes("An active collaboration already exists") ||
        (rawMessage.includes("unique constraint") &&
          rawMessage.includes("idx_collaborations_unique_active"))
      ) {
        displayMessage =
          "You already have an active collaboration or pending request with this hotel. You can only have one active conversation per property.";
        displayTitle = "Duplicate Application";
      } else if (rawMessage.includes("log in")) {
        displayTitle = "Authentication Required";
      } else if (rawMessage.includes("compensation")) {
        displayTitle = "Compensation Required";
      }

      setErrorState({
        isOpen: true,
        message: displayMessage,
        title: displayTitle,
      });
      throw error;
    }
  };

  const hasMultipleImages = images.length > 1;
  const visibleMonths = hotel.availability ? sortMonths(hotel.availability).slice(0, 3) : [];

  const goToPreviousImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setImageError(false);
    setCurrentImageIndex((prev) => {
      const index = Math.min(prev, images.length - 1);
      return index === 0 ? images.length - 1 : index - 1;
    });
  };

  const goToNextImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setImageError(false);
    setCurrentImageIndex((prev) => {
      const index = Math.min(prev, images.length - 1);
      return index === images.length - 1 ? 0 : index + 1;
    });
  };

  const goToImage = (index: number) => {
    setImageError(false);
    setCurrentImageIndex(index);
  };

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-colors hover:border-gray-300">
        {/* Image Gallery */}
        <div className="relative h-40 flex-shrink-0 overflow-hidden bg-gray-100">
          {currentImage && !imageError ? (
            <Image
              key={currentImage}
              src={currentImage}
              alt={`${hotel.name} - Image ${safeImageIndex + 1}`}
              fill
              className="object-cover transition-opacity duration-300"
              onError={() => setImageError(true)}
              unoptimized
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-3xl font-bold text-primary-600">{hotel.name.charAt(0)}</span>
            </div>
          )}

          {hasMultipleImages && (
            <>
              <button
                type="button"
                onClick={goToPreviousImage}
                className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-md bg-black/45 p-1.5 text-white transition-colors hover:bg-black/65"
                aria-label="Previous image"
              >
                <ChevronLeftIcon className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={goToNextImage}
                className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-md bg-black/45 p-1.5 text-white transition-colors hover:bg-black/65"
                aria-label="Next image"
              >
                <ChevronRightIcon className="w-5 h-5" />
              </button>

              <div className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 gap-1.5">
                {images.map((_, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      goToImage(index);
                    }}
                    className={`h-2 rounded-full transition-all ${
                      index === safeImageIndex
                        ? "w-6 bg-white"
                        : "w-2 bg-white/50 hover:bg-white/75"
                    }`}
                    aria-label={`Go to image ${index + 1}`}
                    aria-current={index === safeImageIndex ? "true" : undefined}
                  />
                ))}
              </div>
            </>
          )}
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
            {hotel.accommodationType && (
              <span className="inline-flex items-center gap-1 rounded-md bg-white/95 px-2 py-1 text-xs font-medium text-gray-700 shadow-sm">
                <HomeModernIcon className="h-3.5 w-3.5 text-gray-500" />
                {hotel.accommodationType}
              </span>
            )}
            {hotel.collaborationType && (
              <span className="inline-flex rounded-md bg-white/95 px-2 py-1 text-xs font-medium text-gray-700 shadow-sm">
                {hotel.collaborationType === "Kostenlos" ? "Free stay" : "Paid stay"}
              </span>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col p-4">
          {/* Name */}
          <h3 className="line-clamp-1 text-base font-semibold text-gray-950" title={hotel.name}>
            {hotel.name}
          </h3>

          {/* Location */}
          <div className="mt-1 flex items-center text-sm text-gray-500">
            <MapPinIcon className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" />
            <span className="truncate">{hotel.location}</span>
          </div>

          <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
            <p className="text-[11px] font-medium text-gray-500">Stay length</p>
            <p className="mt-1 truncate text-sm font-semibold text-gray-950">
              {hotel.minNumberOfNights || hotel.numberOfNights
                ? `${hotel.minNumberOfNights ?? 1}-${hotel.numberOfNights ?? hotel.minNumberOfNights} nights`
                : "Flexible"}
            </p>
          </div>

          {hotel.collaborationOfferings?.map((offering) =>
            offering.min_followers ? (
              <p key={offering.id} className="mt-3 text-xs text-gray-600">
                <span className="font-medium">{offering.collaboration_type}</span>
                {": Minimum "}
                {formatFollowersCompact(offering.min_followers)} followers
              </p>
            ) : null,
          )}

          {/* Availability */}
          {hotel.availability && hotel.availability.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600">
                <CalendarDaysIcon className="h-3.5 w-3.5 text-gray-400" />
                {hotel.availability.length === 12 ? "All year" : "Available"}
              </span>
              {hotel.availability.length !== 12 &&
                visibleMonths.map((month) => (
                  <span
                    key={month}
                    className="inline-flex rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600"
                  >
                    {getMonthAbbr(month)}
                  </span>
                ))}
              {hotel.availability.length > 3 && hotel.availability.length !== 12 && (
                <span className="inline-flex rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
                  +{hotel.availability.length - 3}
                </span>
              )}
            </div>
          )}

          {hotel.platforms && hotel.platforms.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {hotel.platforms.slice(0, 4).map((platform, index) => (
                <span
                  key={index}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600"
                  title={platform === "YT" ? "YouTube" : platform}
                >
                  <PlatformIcon platform={platform} className="h-3.5 w-3.5" />
                  {platform === "YT" ? "YouTube" : platform}
                </span>
              ))}
            </div>
          )}

          {/* Spacer to push buttons to bottom */}
          <div className="flex-1"></div>

          {/* Action Buttons */}
          <div className="mt-4 flex gap-2 border-t border-gray-100 pt-3">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 rounded-md border-gray-300 text-gray-700 hover:bg-gray-50"
              onClick={() => setIsModalOpen(true)}
            >
              Details
            </Button>
            {isPublic ? (
              <Link href={`${ROUTES.LOGIN}?redirect=/marketplace`} className="flex-1">
                <Button variant="primary" size="sm" className="w-full rounded-md">
                  Sign in to Apply
                </Button>
              </Link>
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="flex-1 rounded-md"
                onClick={(e) => {
                  e.preventDefault();
                  setShowApplicationModal(true);
                }}
              >
                Apply
              </Button>
            )}
          </div>
        </div>
      </div>
      <HotelDetailModal
        hotel={hotel}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        creatorPlatforms={creatorPlatforms}
      />
      <CollaborationApplicationModal
        propertyTimezone={hotel.propertyTimezone}
        key={hotel.id}
        isOpen={showApplicationModal}
        onClose={() => setShowApplicationModal(false)}
        listingId={hotel.id}
        onSubmit={handleApplicationSubmit}
        compensationOptions={hotel.collaborationOfferings}
        creatorPlatforms={creatorPlatforms}
        isCovered={showSuccessModal || errorState.isOpen}
      />

      {/* Success Modal */}
      <SuccessModal
        isOpen={showSuccessModal}
        onClose={() => setShowSuccessModal(false)}
        title="Application Sent!"
        message={`Your application has been sent to ${hotel.name}. They will be notified immediately.`}
      />

      {/* Error Modal */}
      <ErrorModal
        isOpen={errorState.isOpen}
        onClose={() => setErrorState((prev) => ({ ...prev, isOpen: false }))}
        title={errorState.title}
        message={errorState.message}
      />
    </>
  );
}
