"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { AuthenticatedNavigation, ProfileWarningBanner } from "@/components/layout";
import { useSidebar } from "@/components/layout/AuthenticatedNavigation";
import { MarketplaceFilters } from "@/components/marketplace/MarketplaceFilters";
import { HotelCard } from "@/components/marketplace/HotelCard";
import { CreatorCard } from "@/components/marketplace/CreatorCard";
import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import type { Hotel, Creator, UserType } from "@/lib/types";
import { hotelService } from "@/services/api/hotels";
import { creatorService } from "@/services/api/creators";
import { ApiErrorResponse } from "@/services/api/client";
import { checkProfileStatus } from "@/lib/utils";
import {
  marketplaceGuardRedirectPath,
  resolveMarketplaceSetupGuard,
} from "@/lib/utils/sharedSetupGuard";
import { hasRequiredCreatorAccountDetails } from "@/lib/utils/creatorAccountRequirements";
import {
  filterMarketplaceHotels,
  sortMarketplaceHotels,
  type MarketplaceHotelSort,
} from "@/lib/utils/marketplaceHotels";
import { authService } from "@/services/auth";

export default function MarketplacePage() {
  const router = useRouter();
  const { isCollapsed } = useSidebar();
  const [userType, setUserType] = useState<UserType | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [currentCreator, setCurrentCreator] = useState<Creator | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOption, setSortOption] = useState<MarketplaceHotelSort>("relevance");
  const [filters, setFilters] = useState<{
    hotelType?: string | string[];
    offering?: string | string[];
    availability?: string | string[];
    budget?: number;
    minFollowers?: number;
    minEngagementRate?: number;
    creatorPlatforms?: string | string[];
    topCountries?: string | string[];
    creatorTypes?: string | string[];
  }>({});
  // Get userType from localStorage on mount, then verify the user has a
  // marketplace profile. If not (or if it's incomplete) send them to the
  // onboarding flow — covers both fresh signups and users who arrived here
  // via the cross-app handoff from PMS / Booking Engine. Mirrors the same
  // gate the /login flow runs after authenticating.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
    setUserType(storedUserType);

    let cancelled = false;
    void (async () => {
      try {
        const authenticated = await authService.ensureSession();
        if (cancelled) return;
        if (!authenticated) {
          router.replace(loginPathForCurrentRoute(ROUTES.MARKETPLACE));
          return;
        }
        const sessionUserType = authService.getUserType();
        const refreshedUserType = sessionUserType ?? storedUserType;
        setUserType(refreshedUserType);
        if (!refreshedUserType) {
          router.replace(ROUTES.ONBOARDING);
          return;
        }
        if (sessionUserType === "hotel") {
          const decision = await resolveMarketplaceSetupGuard(currentReturnTo(ROUTES.MARKETPLACE));
          if (cancelled) return;
          localStorage.setItem(
            STORAGE_KEYS.PROFILE_COMPLETE,
            String(decision.action === "enter_product"),
          );
          const redirectPath = marketplaceGuardRedirectPath(decision);
          if (redirectPath) {
            router.replace(redirectPath);
            return;
          }
          setProfileReady(true);
          return;
        }

        if (refreshedUserType !== "creator") {
          setProfileReady(true);
          return;
        }
        const [status, profile] = await Promise.all([
          checkProfileStatus(refreshedUserType),
          creatorService.getMyProfile(),
        ]);
        if (cancelled) return;
        if (!hasRequiredCreatorAccountDetails(authService.getSessionUser(), profile)) {
          localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
          router.replace(ROUTES.ONBOARDING);
          return;
        }
        if (!status || !status.profile_complete) {
          localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
          router.replace(ROUTES.PROFILE_COMPLETE);
          return;
        }
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "true");
        setProfileReady(true);
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to verify marketplace session:", error);
        setError("Failed to verify your session. Please refresh the page.");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (userType && profileReady) {
      loadData();
    }
  }, [userType, profileReady]);

  const loadData = async () => {
    if (!userType) return;

    setLoading(true);
    setError(null);
    try {
      // Load hotels if user is creator
      if (userType === "creator") {
        const [hotelsResponse, creatorProfile] = await Promise.all([
          hotelService.getAll(),
          creatorService.getMyProfile(),
        ]);
        setHotels(hotelsResponse.data);
        setCurrentCreator(creatorProfile);
      } else {
        setHotels([]);
        setCurrentCreator(null);
      }

      // Load creators if user is hotel
      if (userType === "hotel") {
        const creatorsResponse = await creatorService.getAll();
        setCreators(creatorsResponse.data);
      } else {
        setCreators([]);
      }
    } catch (err) {
      console.error("Error loading marketplace data:", err);
      const errorMessage =
        err instanceof ApiErrorResponse
          ? "Failed to load marketplace data. Please try again."
          : "An unexpected error occurred. Please refresh the page.";
      setError(errorMessage);
      setHotels([]);
      setCreators([]);
    } finally {
      setLoading(false);
    }
  };

  const filteredHotels = useMemo(
    () => filterMarketplaceHotels(hotels, searchQuery, filters),
    [hotels, searchQuery, filters],
  );

  const filteredCreators = useMemo(
    () =>
      creators.filter((creator) => {
        // Search filter
        if (searchQuery) {
          const query = searchQuery.toLowerCase();
          const matchesSearch =
            creator.name.toLowerCase().includes(query) ||
            creator.location.toLowerCase().includes(query);
          if (!matchesSearch) return false;
        }

        // Minimum Followers filter
        if (filters.minFollowers) {
          if (creator.audienceSize < filters.minFollowers) {
            return false;
          }
        }

        // Minimum Engagement Rate filter
        if (
          filters.minEngagementRate &&
          creatorEngagementRate(creator) < filters.minEngagementRate
        ) {
          return false;
        }

        // Platforms filter (multiselect)
        if (filters.creatorPlatforms) {
          const selectedPlatforms = Array.isArray(filters.creatorPlatforms)
            ? filters.creatorPlatforms
            : [filters.creatorPlatforms];

          const creatorPlatformNames = creator.platforms.map((p) => p.name);
          const hasMatchingPlatform = selectedPlatforms.some((platform) =>
            creatorPlatformNames.includes(platform),
          );

          if (!hasMatchingPlatform) return false;
        }

        // Top Countries filter (multiselect)
        if (filters.topCountries) {
          const selectedCountries = Array.isArray(filters.topCountries)
            ? filters.topCountries
            : [filters.topCountries];

          // Check if any platform has any of the selected countries in topCountries
          const hasMatchingCountry = creator.platforms.some((platform) => {
            if (!platform.topCountries || platform.topCountries.length === 0) return false;
            return platform.topCountries.some((countryData) =>
              selectedCountries.includes(countryData.country),
            );
          });

          if (!hasMatchingCountry) return false;
        }

        // Creator Types filter (multiselect)
        if (filters.creatorTypes) {
          const selectedTypes = Array.isArray(filters.creatorTypes)
            ? filters.creatorTypes
            : [filters.creatorTypes];

          if (!creator.creatorType || !selectedTypes.includes(creator.creatorType)) {
            return false;
          }
        }

        return true;
      }),
    [
      creators,
      searchQuery,
      filters.minFollowers,
      filters.minEngagementRate,
      filters.creatorPlatforms,
      filters.topCountries,
      filters.creatorTypes,
    ],
  );

  // Memoized sorted results
  const sortedHotels = useMemo(
    () => sortMarketplaceHotels(filteredHotels, sortOption, searchQuery, currentCreator),
    [filteredHotels, sortOption, searchQuery, currentCreator],
  );

  const sortedCreators = useMemo(() => {
    const sorted = [...filteredCreators];
    switch (sortOption) {
      case "name-asc":
        return sorted.sort((a, b) => a.name.localeCompare(b.name));
      case "name-desc":
        return sorted.sort((a, b) => b.name.localeCompare(a.name));
      case "newest":
        return sorted.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      case "oldest":
        return sorted.sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      case "relevance":
      default:
        return sorted.sort(compareCreatorRelevance);
    }
  }, [filteredCreators, sortOption]);

  return (
    <main className="min-h-screen bg-gray-50">
      <AuthenticatedNavigation />
      <div className={`transition-all duration-200 ${isCollapsed ? "md:pl-14" : "md:pl-52"} pt-12`}>
        <div className="pt-4">
          <ProfileWarningBanner />
        </div>

        <div className="mx-auto max-w-7xl px-4 py-4 md:px-6 md:py-6">
          {/* Header */}
          <div className="mb-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Creator hotel network
              </p>
              <h1 className="mt-1 text-2xl font-bold tracking-normal text-gray-950 md:text-3xl">
                vayada Marketplace
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Find the right collaboration match, compare fit signals, and start the next
                conversation.
              </p>
            </div>
          </div>

          {/* Filters */}
          <section className="mb-5 rounded-lg border border-gray-200 bg-white/80 px-3 py-3 shadow-sm">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-gray-500">
                Showing {userType === "creator" ? "hotel stays" : "creator partners"} sorted by fit
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  value={sortOption}
                  onChange={(e) => setSortOption(e.target.value as MarketplaceHotelSort)}
                  className="h-8 rounded border border-gray-200 bg-white px-2 text-xs font-medium text-gray-700 focus:border-gray-300 focus:ring-2 focus:ring-gray-100"
                  aria-label="Sort marketplace results"
                >
                  <option value="relevance">Relevance</option>
                  <option value="name-asc">Name (A-Z)</option>
                  <option value="name-desc">Name (Z-A)</option>
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                </select>
              </div>
            </div>
            <MarketplaceFilters
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              filters={filters}
              onFiltersChange={setFilters}
              viewType={
                userType === "creator" ? "hotels" : userType === "hotel" ? "creators" : "all"
              }
            />
          </section>

          {/* Error notification */}
          {error && (
            <div className="mb-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-red-700">{error}</p>
              <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
                <span className="sr-only">Dismiss</span>✕
              </button>
            </div>
          )}

          {/* Results */}
          {loading ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="h-64 animate-pulse rounded-lg border border-gray-200 bg-white shadow-sm"
                >
                  <div className="h-28 rounded-t-lg bg-gray-100" />
                  <div className="space-y-3 p-4">
                    <div className="h-4 w-2/3 rounded bg-gray-100" />
                    <div className="h-3 w-1/2 rounded bg-gray-100" />
                    <div className="grid grid-cols-3 gap-2 pt-3">
                      <div className="h-12 rounded bg-gray-100" />
                      <div className="h-12 rounded bg-gray-100" />
                      <div className="h-12 rounded bg-gray-100" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Hotels Section - Only show if user is creator */}
              {userType === "creator" && (
                <div className="mb-12">
                  {sortedHotels.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      {sortedHotels.map((hotel) => (
                        <HotelCard
                          key={hotel.id}
                          hotel={hotel}
                          creatorPlatforms={currentCreator?.platforms.map((p) => p.name)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-gray-200 bg-white py-16 text-center shadow-sm">
                      <p className="text-sm font-medium text-gray-900">No hotels found</p>
                      <p className="mt-1 text-sm text-gray-500">Adjust filters or search terms.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Creators Section - Only show if user is hotel */}
              {userType === "hotel" && (
                <div>
                  {sortedCreators.length > 0 ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {sortedCreators.map((creator) => (
                        <CreatorCard key={creator.id} creator={creator} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-gray-200 bg-white py-16 text-center shadow-sm">
                      <p className="text-sm font-medium text-gray-900">No creators found</p>
                      <p className="mt-1 text-sm text-gray-500">Adjust filters or search terms.</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function loginPathForCurrentRoute(fallbackReturnTo: string): string {
  return `${ROUTES.LOGIN}?returnTo=${encodeURIComponent(currentReturnTo(fallbackReturnTo))}`;
}

function currentReturnTo(fallbackReturnTo: string): string {
  const returnTo =
    typeof window === "undefined"
      ? fallbackReturnTo
      : `${window.location.pathname}${window.location.search}`;
  return returnTo;
}

function compareCreatorRelevance(a: Creator, b: Creator): number {
  return (
    (b.rating?.averageRating ?? 0) - (a.rating?.averageRating ?? 0) ||
    creatorEngagementRate(b) - creatorEngagementRate(a) ||
    b.audienceSize - a.audienceSize ||
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

function creatorEngagementRate(creator: Creator): number {
  if (creator.avgEngagementRate !== undefined) return creator.avgEngagementRate;
  const totalFollowers = creator.platforms.reduce(
    (total, platform) => total + platform.followers,
    0,
  );
  if (totalFollowers === 0) return 0;
  return (
    creator.platforms.reduce(
      (total, platform) => total + platform.followers * platform.engagementRate,
      0,
    ) / totalFollowers
  );
}
