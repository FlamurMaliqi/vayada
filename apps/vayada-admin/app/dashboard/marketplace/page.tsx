"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import {
  marketplaceService,
  MarketplaceListing,
  MarketplaceCreator,
} from "@/services/api/marketplace";
import { ApiErrorResponse } from "@/services/api/client";
import { MarketplaceListingModal } from "@/components/marketplace/MarketplaceListingModal";
import { MarketplaceCreatorModal } from "@/components/marketplace/MarketplaceCreatorModal";
import { HotelIcon } from "@vayada/product-onboarding";
import {
  UserGroupIcon,
  MapPinIcon,
  MagnifyingGlassIcon,
  StarIcon,
  PhotoIcon,
} from "@heroicons/react/24/outline";

type Tab = "listings" | "creators";

export default function MarketplacePreviewPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>("listings");
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [creators, setCreators] = useState<MarketplaceCreator[]>([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [loadingCreators, setLoadingCreators] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const [selectedListing, setSelectedListing] = useState<MarketplaceListing | null>(null);
  const [selectedCreator, setSelectedCreator] = useState<MarketplaceCreator | null>(null);

  useEffect(() => {
    let cancelled = false;
    authService.ensureSession().then((authorized) => {
      if (cancelled) return;
      if (!authorized) {
        router.push("/login");
        return;
      }
      loadData();
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const loadData = async () => {
    await Promise.all([loadListings(), loadCreators()]);
  };

  const loadListings = async () => {
    try {
      setLoadingListings(true);
      const data = await marketplaceService.getListings();
      setListings(data);
    } catch (err) {
      console.error("Error loading listings:", err);
      if (err instanceof ApiErrorResponse) {
        setError(err.message);
      }
    } finally {
      setLoadingListings(false);
    }
  };

  const loadCreators = async () => {
    try {
      setLoadingCreators(true);
      const data = await marketplaceService.getCreators();
      setCreators(data);
    } catch (err) {
      console.error("Error loading creators:", err);
      if (err instanceof ApiErrorResponse) {
        setError(err.message);
      }
    } finally {
      setLoadingCreators(false);
    }
  };

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

  const getPlatformColor = (name: string) => {
    switch (name) {
      case "Instagram":
        return "bg-pink-100 text-pink-800";
      case "TikTok":
        return "bg-gray-900 text-white";
      case "YouTube":
        return "bg-red-100 text-red-800";
      case "Facebook":
        return "bg-blue-100 text-blue-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const q = search.trim().toLowerCase();
  const filteredListings = q
    ? listings.filter((l) =>
        [l.name, l.hotel_name, l.location, l.description, l.accommodation_type]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(q)),
      )
    : listings;
  const filteredCreators = q
    ? creators.filter((c) =>
        [c.name, c.location, c.short_description, ...c.platforms.flatMap((p) => [p.name, p.handle])]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(q)),
      )
    : creators;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4">
          <h1 className="text-xl font-bold text-gray-900">Marketplace</h1>
          <p className="text-sm text-gray-500">View the public marketplace as users see it</p>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        {/* Tabs */}
        <div className="mb-6 bg-white rounded-lg shadow p-1 inline-flex">
          <button
            onClick={() => setActiveTab("listings")}
            className={`px-6 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === "listings"
                ? "bg-primary-600 text-white"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            <HotelIcon className="w-4 h-4 inline-block mr-2" />
            Offers ({listings.length})
          </button>
          <button
            onClick={() => setActiveTab("creators")}
            className={`px-6 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === "creators"
                ? "bg-primary-600 text-white"
                : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
            }`}
          >
            <UserGroupIcon className="w-4 h-4 inline-block mr-2" />
            Creators ({creators.length})
          </button>
        </div>

        {/* Search */}
        <div className="mb-6 bg-white p-4 rounded-lg shadow">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder={
                activeTab === "listings"
                  ? "Search by hotel, location, description..."
                  : "Search by creator, location, platform..."
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-400"
            />
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        )}

        {/* Listings Tab */}
        {activeTab === "listings" && (
          <>
            {loadingListings ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <p className="text-gray-600">Loading offers...</p>
              </div>
            ) : filteredListings.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <HotelIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">
                  {q ? "No matching offers" : "No offers"}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {q
                    ? "Try a different search."
                    : "No verified hotels with complete profiles have offers yet."}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredListings.map((listing) => (
                  <div
                    key={listing.id}
                    className="bg-white rounded-lg shadow overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
                    onClick={() => setSelectedListing(listing)}
                  >
                    {/* Image */}
                    <div className="h-48 bg-gray-200 relative">
                      {listing.images && listing.images.length > 0 ? (
                        <img
                          src={listing.images[0]}
                          alt={listing.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <PhotoIcon className="w-16 h-16 text-gray-400" />
                        </div>
                      )}
                      {listing.images && listing.images.length > 1 && (
                        <span className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
                          +{listing.images.length - 1} photos
                        </span>
                      )}
                    </div>

                    {/* Content */}
                    <div className="p-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h3 className="font-semibold text-gray-900">{listing.name}</h3>
                          <p className="text-sm text-gray-500">{listing.hotel_name}</p>
                        </div>
                        {listing.accommodation_type && (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                            {listing.accommodation_type}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center text-sm text-gray-500 mb-3">
                        <MapPinIcon className="w-4 h-4 mr-1" />
                        {listing.location}
                      </div>

                      {listing.description && (
                        <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                          {listing.description}
                        </p>
                      )}

                      {/* Collaboration types */}
                      <div className="flex flex-wrap gap-1 mb-3">
                        {listing.collaboration_offerings.map((offering) => (
                          <span
                            key={offering.id}
                            className={`text-xs px-2 py-1 rounded-full ${getCollaborationTypeBadge(offering.collaboration_type)}`}
                          >
                            {offering.collaboration_type}
                          </span>
                        ))}
                      </div>

                      {/* Creator requirements */}
                      {listing.creator_requirements && (
                        <div className="text-xs text-gray-500 border-t pt-2">
                          {listing.creator_requirements.platforms &&
                            listing.creator_requirements.platforms.length > 0 && (
                              <span>{listing.creator_requirements.platforms.join(", ")}</span>
                            )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Creators Tab */}
        {activeTab === "creators" && (
          <>
            {loadingCreators ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <p className="text-gray-600">Loading creators...</p>
              </div>
            ) : filteredCreators.length === 0 ? (
              <div className="text-center py-12 bg-white rounded-lg shadow">
                <UserGroupIcon className="mx-auto h-12 w-12 text-gray-400" />
                <h3 className="mt-2 text-sm font-medium text-gray-900">
                  {q ? "No matching creators" : "No creators"}
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  {q
                    ? "Try a different search."
                    : "No verified creators with complete profiles yet."}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredCreators.map((creator) => (
                  <div
                    key={creator.id}
                    className="bg-white rounded-lg shadow overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
                    onClick={() => setSelectedCreator(creator)}
                  >
                    {/* Header with avatar */}
                    <div className="p-4 flex items-center gap-4">
                      <div className="w-16 h-16 rounded-full bg-gray-200 overflow-hidden flex-shrink-0">
                        {creator.profile_picture ? (
                          <img
                            src={creator.profile_picture}
                            alt={creator.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <UserGroupIcon className="w-8 h-8 text-gray-400" />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900 truncate">{creator.name}</h3>
                        <div className="flex items-center text-sm text-gray-500">
                          <MapPinIcon className="w-4 h-4 mr-1 flex-shrink-0" />
                          <span className="truncate">{creator.location || "No location"}</span>
                        </div>
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="px-4 pb-4">
                      <div className="flex items-center gap-4 mb-3">
                        <div className="text-center">
                          <p className="text-lg font-semibold text-gray-900">
                            {formatNumber(creator.audience_size)}
                          </p>
                          <p className="text-xs text-gray-500">Audience</p>
                        </div>
                        {creator.total_reviews > 0 && (
                          <div className="text-center">
                            <p className="text-lg font-semibold text-gray-900 flex items-center justify-center">
                              <StarIcon className="w-4 h-4 text-yellow-400 mr-1" />
                              {creator.average_rating.toFixed(1)}
                            </p>
                            <p className="text-xs text-gray-500">{creator.total_reviews} reviews</p>
                          </div>
                        )}
                      </div>

                      {creator.short_description && (
                        <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                          {creator.short_description}
                        </p>
                      )}

                      {/* Platforms */}
                      <div className="flex flex-wrap gap-2">
                        {creator.platforms.map((platform) => (
                          <span
                            key={platform.id}
                            className={`text-xs px-2 py-1 rounded ${getPlatformColor(platform.name)}`}
                          >
                            {platform.name}: {formatNumber(platform.followers)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <MarketplaceListingModal
        isOpen={!!selectedListing}
        onClose={() => setSelectedListing(null)}
        listing={selectedListing}
      />

      <MarketplaceCreatorModal
        isOpen={!!selectedCreator}
        onClose={() => setSelectedCreator(null)}
        creator={selectedCreator}
      />
    </div>
  );
}
