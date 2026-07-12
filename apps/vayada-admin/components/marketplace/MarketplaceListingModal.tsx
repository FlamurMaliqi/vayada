"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { MarketplaceListing } from "@/services/api/marketplace";
import { getCurrencySymbol } from "@/lib/utils/getCurrencySymbol";
import {
  MapPinIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";

interface MarketplaceListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  listing: MarketplaceListing | null;
  notFoundMessage?: string;
}

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
};

const getCollaborationTypeBadge = (type: string) => {
  switch (type) {
    case "Free Stay":
      return "bg-green-100 text-green-800";
    case "Paid":
      return "bg-blue-100 text-blue-800";
    case "Discount":
      return "bg-yellow-100 text-yellow-800";
    case "Affiliate":
      return "bg-purple-100 text-purple-800";
    default:
      return "bg-gray-100 text-gray-800";
  }
};

export function MarketplaceListingModal({
  isOpen,
  onClose,
  listing,
  notFoundMessage,
}: MarketplaceListingModalProps) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  useEffect(() => {
    setCurrentImageIndex(0);
  }, [listing?.id]);

  const nextImage = () => {
    if (listing && listing.images.length > 0) {
      setCurrentImageIndex((prev) => (prev + 1) % listing.images.length);
    }
  };

  const prevImage = () => {
    if (listing && listing.images.length > 0) {
      setCurrentImageIndex((prev) => (prev - 1 + listing.images.length) % listing.images.length);
    }
  };

  if (notFoundMessage) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Collaboration Offer" size="md">
        <p className="text-sm text-gray-600">{notFoundMessage}</p>
      </Modal>
    );
  }

  if (!listing) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={listing.name} size="xl">
      <div className="space-y-6">
        <div className="flex justify-end">
          <button
            type="button"
            disabled
            title="Public discovery offers no longer include owner user IDs. Use the authenticated admin user lookup when that vertical is available."
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-md hover:bg-primary-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-50"
          >
            <PencilSquareIcon className="w-4 h-4" />
            Edit hotel settings
          </button>
        </div>

        {/* Image Gallery */}
        {listing.images && listing.images.length > 0 && (
          <div className="relative">
            <div className="aspect-video bg-gray-200 rounded-lg overflow-hidden">
              <img
                src={listing.images[currentImageIndex]}
                alt={`${listing.name} - Image ${currentImageIndex + 1}`}
                className="w-full h-full object-cover"
              />
            </div>
            {listing.images.length > 1 && (
              <>
                <button
                  onClick={prevImage}
                  className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/80 hover:bg-white rounded-full p-2 shadow"
                >
                  <ChevronLeftIcon className="w-5 h-5" />
                </button>
                <button
                  onClick={nextImage}
                  className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/80 hover:bg-white rounded-full p-2 shadow"
                >
                  <ChevronRightIcon className="w-5 h-5" />
                </button>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1 rounded-full">
                  {currentImageIndex + 1} / {listing.images.length}
                </div>
              </>
            )}
          </div>
        )}

        {/* Hotel Info */}
        <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
          {listing.hotel_picture && (
            <img
              src={listing.hotel_picture}
              alt={listing.hotel_name}
              className="w-12 h-12 rounded-full object-cover"
            />
          )}
          <div>
            <p className="font-semibold text-gray-900">{listing.hotel_name}</p>
            <div className="flex items-center text-sm text-gray-500">
              <MapPinIcon className="w-4 h-4 mr-1" />
              {listing.location}
            </div>
          </div>
          {listing.accommodation_type && (
            <span className="ml-auto text-sm bg-gray-200 text-gray-700 px-3 py-1 rounded-full">
              {listing.accommodation_type}
            </span>
          )}
        </div>

        {/* Description */}
        {listing.description && (
          <div>
            <h4 className="font-semibold text-gray-900 mb-2">Description</h4>
            <p className="text-gray-600">{listing.description}</p>
          </div>
        )}

        {/* Collaboration Offerings */}
        <div>
          <h4 className="font-semibold text-gray-900 mb-3">Collaboration Offerings</h4>
          <div className="space-y-3">
            {listing.collaboration_offerings.map((offering) => (
              <div key={offering.id} className="p-4 border rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span
                    className={`px-3 py-1 rounded-full text-sm font-medium ${getCollaborationTypeBadge(offering.collaboration_type)}`}
                  >
                    {offering.collaboration_type}
                  </span>
                  <span className="text-sm text-gray-500">{offering.platforms.join(", ")}</span>
                </div>
                <div className="text-sm text-gray-600 space-y-1">
                  {offering.collaboration_type === "Free Stay" &&
                    (offering.free_stay_min_nights || offering.free_stay_max_nights) && (
                      <p>
                        Stay duration:{" "}
                        {offering.free_stay_min_nights &&
                        offering.free_stay_max_nights &&
                        offering.free_stay_min_nights !== offering.free_stay_max_nights
                          ? `${offering.free_stay_min_nights} - ${offering.free_stay_max_nights} nights`
                          : `${offering.free_stay_max_nights || offering.free_stay_min_nights} night${(offering.free_stay_max_nights || offering.free_stay_min_nights) === 1 ? "" : "s"}`}
                      </p>
                    )}
                  {offering.collaboration_type === "Paid" && offering.paid_max_amount && (
                    <p>
                      Budget: up to {getCurrencySymbol(offering.currency || "USD")}
                      {Number(offering.paid_max_amount).toLocaleString()}
                    </p>
                  )}
                  {offering.collaboration_type === "Discount" && offering.discount_percentage && (
                    <p>Discount: {offering.discount_percentage}% off</p>
                  )}
                  {offering.collaboration_type === "Affiliate" &&
                    offering.commission_percentage != null && (
                      <p>Commission: {offering.commission_percentage}%</p>
                    )}
                  {offering.availability_months && offering.availability_months.length > 0 && (
                    <p>
                      Available:{" "}
                      {[...offering.availability_months]
                        .sort((a, b) => {
                          const order = [
                            "January",
                            "February",
                            "March",
                            "April",
                            "May",
                            "June",
                            "July",
                            "August",
                            "September",
                            "October",
                            "November",
                            "December",
                          ];
                          return order.indexOf(a) - order.indexOf(b);
                        })
                        .join(", ")}
                    </p>
                  )}
                  {offering.min_followers != null && (
                    <p>Min followers for this offering: {formatNumber(offering.min_followers)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Creator Requirements */}
        {listing.creator_requirements && (
          <div>
            <h4 className="font-semibold text-gray-900 mb-3">Creator Requirements</h4>
            <div className="p-4 border rounded-lg space-y-2">
              {listing.creator_requirements.platforms &&
                listing.creator_requirements.platforms.length > 0 && (
                  <p className="text-sm">
                    <span className="text-gray-500">Platforms:</span>{" "}
                    <span className="text-gray-900">
                      {listing.creator_requirements.platforms.join(", ")}
                    </span>
                  </p>
                )}
              {listing.creator_requirements.target_countries &&
                listing.creator_requirements.target_countries.length > 0 && (
                  <p className="text-sm">
                    <span className="text-gray-500">Target Countries:</span>{" "}
                    <span className="text-gray-900">
                      {listing.creator_requirements.target_countries.join(", ")}
                    </span>
                  </p>
                )}
              {listing.creator_requirements.target_age_groups &&
                listing.creator_requirements.target_age_groups.length > 0 && (
                  <p className="text-sm">
                    <span className="text-gray-500">Target Age Groups:</span>{" "}
                    <span className="text-gray-900">
                      {listing.creator_requirements.target_age_groups.join(", ")}
                    </span>
                  </p>
                )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
