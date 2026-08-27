"use client";

import { useState, useRef, useEffect, Suspense, useCallback, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import Image from "next/image";
import { useRouter } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import DatePickerCalendar from "@/components/booking/DatePickerCalendar";
import GuestSelector from "@/components/booking/GuestSelector";
import RoomDetailModal from "@/components/booking/RoomDetailModal";
import RoomCard from "@/components/booking/RoomCard";
import RoomFiltersBar from "@/components/booking/RoomFiltersBar";
import RoomMapPanel from "@/components/booking/RoomMapPanel";
import PublicStructuredData from "@/components/booking/PublicStructuredData";
import PropertyGallery from "@/components/booking/PropertyGallery";
import { useHotel, useRooms, useAddons, useSlug } from "@/contexts/HotelContext";
import { calculateNights, formatDateShort, formatDate, ensureMinOneNight } from "@/lib/utils";
import { useCurrency } from "@/contexts/CurrencyContext";
import { trackEvent } from "@/services/api/tracking";
import { hotelService } from "@/services/api/hotel";
import { useBookingSteps } from "@/lib/hooks/useBookingSteps";
import { getFlexibleNightlyRates, isFlexibleCancellationExpired } from "@/lib/constants/booking";
import type { RoomType } from "@/lib/types";

interface AppliedPromo {
  code: string;
  discountType: string;
  discountValue: number;
}

type RateType = "flexible" | "nonrefundable";

interface PendingRateSelection {
  roomId: string;
  rateType: RateType;
}

function PromoPopover({
  open,
  onClose,
  value,
  onChange,
  onApply,
  loading,
  error,
  t,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
  loading: boolean;
  error: string;
  t: (key: string) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 bg-white rounded-xl shadow-xl border border-gray-100 p-4 z-50 w-64"
    >
      <p className="text-sm font-semibold text-gray-900 mb-2.5">{t("promoTitle")}</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          placeholder={t("enterCode")}
          className="flex-1 min-w-0 px-3 py-1.5 rounded-full border border-gray-300 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
        />
        <button
          onClick={onApply}
          disabled={loading || !value.trim()}
          className="px-4 py-1.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-xs disabled:opacity-50"
        >
          {loading ? "..." : t("apply")}
        </button>
      </div>
      {error && <p className="text-[11px] text-red-500 mt-1.5">{error}</p>}
    </div>
  );
}

function HomePageContent() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("home");
  const tc = useTranslations("common");
  const { hotel } = useHotel();
  const { rooms, loading: roomsLoading, roomsLoading: roomsRefetching, refetchRooms } = useRooms();
  const { addons } = useAddons();
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();
  const { slug } = useSlug();
  const searchParams = useSearchParams();

  useEffect(() => {
    trackEvent(slug, "page_visit");
  }, [slug]);

  // Initialize from URL params so back-navigation from /book or /addons
  // preserves the user's selected dates and guests. Sanitize so a same-day
  // or invalid range from the URL never lands the page on "0 nights".
  const initialDates = (() => {
    const ciQ = searchParams.get("checkIn");
    const coQ = searchParams.get("checkOut");
    const today = new Date();
    const defaultCheckIn = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      return d.toISOString().split("T")[0];
    })();
    const defaultCheckOut = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 2);
      return d.toISOString().split("T")[0];
    })();
    return ensureMinOneNight(ciQ || defaultCheckIn, coQ || defaultCheckOut);
  })();
  const [checkIn, setCheckIn] = useState(initialDates.checkIn);
  const [checkOut, setCheckOut] = useState(initialDates.checkOut);
  const [adults, setAdults] = useState(() => parseInt(searchParams.get("adults") || "2"));
  const [children, setChildren] = useState(() => parseInt(searchParams.get("children") || "0"));
  const guestTypeSettings = hotel?.guestTypeSettings ?? {
    adultAgeThreshold: 18,
    childrenEnabled: true,
  };
  const effectiveChildren = guestTypeSettings.childrenEnabled ? children : 0;

  // "Committed" search params — only update when user clicks "Check Availability"
  const [committedCheckIn, setCommittedCheckIn] = useState(checkIn);
  const [committedCheckOut, setCommittedCheckOut] = useState(checkOut);
  const [committedAdults, setCommittedAdults] = useState(adults);
  const [committedChildren, setCommittedChildren] = useState(children);
  const effectiveCommittedChildren = guestTypeSettings.childrenEnabled ? committedChildren : 0;

  // Fetch rooms with default dates on initial load so prices reflect seasonal rates
  const [initialFetchDone, setInitialFetchDone] = useState(false);
  useEffect(() => {
    if (!roomsLoading && rooms.length > 0 && !initialFetchDone) {
      setInitialFetchDone(true);
      refetchRooms(checkIn, checkOut, adults, effectiveChildren);
    }
  }, [
    adults,
    checkIn,
    checkOut,
    effectiveChildren,
    initialFetchDone,
    refetchRooms,
    rooms.length,
    roomsLoading,
  ]);

  // Auto-refetch when the user changes dates or guests, so availability updates
  // without requiring a click on "Check Availability". Debounced to coalesce
  // rapid +/- clicks in the guest selector into a single request.
  const skipNextAutoRefetch = useRef(true);
  useEffect(() => {
    if (skipNextAutoRefetch.current) {
      skipNextAutoRefetch.current = false;
      return;
    }
    const handle = setTimeout(() => {
      setCommittedCheckIn(checkIn);
      setCommittedCheckOut(checkOut);
      setCommittedAdults(adults);
      setCommittedChildren(effectiveChildren);
      refetchRooms(checkIn, checkOut, adults, effectiveChildren);
    }, 300);
    return () => clearTimeout(handle);
  }, [adults, checkIn, checkOut, effectiveChildren, refetchRooms]);

  // roomCount removed — now computed dynamically per room type
  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [sortOption, setSortOption] = useState("recommended");
  const [currentStep] = useState(1);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<AppliedPromo | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState("");
  const [imageIndices, setImageIndices] = useState<Record<string, number>>({});
  const [selectedRates, setSelectedRates] = useState<Record<string, string | null>>({});
  const [detailModalIndex, setDetailModalIndex] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [hoveredRoomId, setHoveredRoomId] = useState<string | null>(null);
  const [mobileResultView, setMobileResultView] = useState<"list" | "map">("list");
  const [pendingRateSelection, setPendingRateSelection] = useState<PendingRateSelection | null>(
    null,
  );
  const [isRateNavigationPending, startRateNavigation] = useTransition();
  const roomsSectionRef = useRef<HTMLDivElement>(null);
  const roomRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Reset stale modal index if the underlying room list shrinks (e.g. after a refetch)
  useEffect(() => {
    if (detailModalIndex !== null && detailModalIndex >= rooms.length) {
      setDetailModalIndex(null);
    }
  }, [rooms.length, detailModalIndex]);

  // Default per-room rate selection: prefer non-refundable when available, else flexible.
  useEffect(() => {
    if (rooms.length > 0 && Object.keys(selectedRates).length === 0) {
      const defaults: Record<string, string> = {};
      rooms.forEach((room) => {
        const hasNonRefundable = room.nonRefundableRate != null;
        const hasFlexible = room.flexibleRateEnabled !== false;
        if (hasNonRefundable) {
          defaults[room.id] = "nonrefundable";
        } else if (hasFlexible) {
          defaults[room.id] = "flexible";
        }
      });
      setSelectedRates(defaults);
    }
  }, [rooms]);

  const nights = calculateNights(committedCheckIn, committedCheckOut);

  // Build filter key→label map, only including filters that match at least one room
  const FILTER_ENTRIES = (hotel?.bookingFilters || [])
    .map((key) => ({
      key,
      label: hotel?.customFilters?.[key] || t(key),
    }))
    .filter(({ key, label }) => {
      if (hotel?.filterRooms?.[key]?.length) {
        return rooms.some((room) => hotel.filterRooms?.[key]?.includes(room.id));
      }
      const lower = label.toLowerCase();
      return rooms.some(
        (room) =>
          room.features.some((f) => f.toLowerCase().includes(lower)) ||
          room.amenities.some((a) => a.toLowerCase().includes(lower)),
      );
    });
  const FILTERS = FILTER_ENTRIES.map((f) => f.label);

  // Filter rooms using filterRooms mapping (room ID based) with fallback to text matching
  const filteredRooms = (() => {
    const result =
      activeFilters.length === 0
        ? [...rooms]
        : rooms.filter((room) =>
            activeFilters.every((label) => {
              const entry = FILTER_ENTRIES.find((f) => f.label === label);
              if (entry && hotel?.filterRooms?.[entry.key]?.length) {
                return hotel.filterRooms[entry.key].includes(room.id);
              }
              const lower = label.toLowerCase();
              return (
                room.features.some((f) => f.toLowerCase().includes(lower)) ||
                room.amenities.some((a) => a.toLowerCase().includes(lower))
              );
            }),
          );
    const stayTotal = (room: (typeof rooms)[number]) => {
      const rates = getFlexibleNightlyRates(room, nights);
      return rates.reduce((sum, rate) => sum + rate, 0);
    };
    if (sortOption === "priceLow") result.sort((a, b) => stayTotal(a) - stayTotal(b));
    else if (sortOption === "priceHigh") result.sort((a, b) => stayTotal(b) - stayTotal(a));
    else if (sortOption === "roomSize") result.sort((a, b) => (b.size || 0) - (a.size || 0));
    const totalGuests = committedAdults + effectiveCommittedChildren;
    const isSoldOut = (room: (typeof rooms)[number]) =>
      room.remainingRooms < Math.ceil(totalGuests / room.maxOccupancy);
    result.sort((a, b) => Number(isSoldOut(a)) - Number(isSoldOut(b)));
    return result;
  })();

  const { steps: STEPS, hasAddons } = useBookingSteps("rooms");
  const isSelectingRate = pendingRateSelection !== null || isRateNavigationPending;

  const buildRateTarget = useCallback(
    (roomId: string, requiredRooms: number, rateType: RateType) => {
      const params = new URLSearchParams({
        room: roomId,
        checkIn: committedCheckIn,
        checkOut: committedCheckOut,
        adults: String(committedAdults),
        children: String(effectiveCommittedChildren),
        rooms: String(requiredRooms),
        rateType,
      });
      if (appliedPromo) params.set("promoCode", appliedPromo.code);
      return `${hasAddons ? "/addons" : "/book"}?${params.toString()}`;
    },
    [
      appliedPromo,
      committedAdults,
      committedCheckIn,
      committedCheckOut,
      effectiveCommittedChildren,
      hasAddons,
    ],
  );

  const getSelectedAvailableRate = useCallback(
    (room: RoomType): RateType | null => {
      const selectedRate = selectedRates[room.id] as RateType | null | undefined;
      const flexibleExpired = isFlexibleCancellationExpired(committedCheckIn, room, hotel.timezone);
      const showFlexibleRate =
        room.flexibleRateEnabled !== false && (!flexibleExpired || room.nonRefundableRate == null);
      const hasNonRefundable = room.nonRefundableRate != null;

      if (selectedRate === "flexible" && showFlexibleRate) return "flexible";
      if (selectedRate === "nonrefundable" && hasNonRefundable) return "nonrefundable";
      if (hasNonRefundable) return "nonrefundable";
      if (showFlexibleRate) return "flexible";
      return null;
    },
    [committedCheckIn, hotel.timezone, selectedRates],
  );

  useEffect(() => {
    if (rooms.length === 0) return;
    const totalGuests = committedAdults + effectiveCommittedChildren;
    const targets = new Set<string>();
    for (const room of rooms.slice(0, 8)) {
      const requiredRooms = Math.ceil(totalGuests / room.maxOccupancy);
      if (room.remainingRooms < requiredRooms) continue;
      const rateType = getSelectedAvailableRate(room);
      if (!rateType) continue;
      targets.add(buildRateTarget(room.id, requiredRooms, rateType));
    }
    targets.forEach((target) => {
      router.prefetch(target);
    });
  }, [
    buildRateTarget,
    committedAdults,
    effectiveCommittedChildren,
    getSelectedAvailableRate,
    rooms,
    router,
  ]);

  const handleSelectRate = (room: RoomType, rateType: RateType, requiredRooms: number) => {
    if (pendingRateSelection || isRateNavigationPending) return;
    const target = buildRateTarget(room.id, requiredRooms, rateType);

    setPendingRateSelection({ roomId: room.id, rateType });

    startRateNavigation(() => {
      try {
        router.push(target);
      } catch (error) {
        setPendingRateSelection(null);
        throw error;
      }
    });
  };

  const toggleFilter = (filter: string) => {
    setActiveFilters((prev) =>
      prev.includes(filter) ? prev.filter((f) => f !== filter) : [...prev, filter],
    );
  };

  const selectRoomFromMap = (roomId: string) => {
    setActiveRoomId(roomId);
    setMobileResultView("list");
    requestAnimationFrame(() => {
      roomRefs.current[roomId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const mapViewEnabled = hotel.mapViewEnabled === true;
  const heroImage = hotel.heroImage;
  const heroHeading = hotel.branding?.heroHeading || hotel.name;
  const heroSubtext = hotel.branding?.heroSubtext || hotel.description;

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      <PublicStructuredData hotel={hotel} rooms={rooms} locale={locale} />

      {/* Hero Section */}
      <div className="relative h-[520px] w-full">
        <Image
          src={heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
          quality={90}
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

        <BookingNavigation />

        <PropertyGallery hotelName={hotel.name} images={hotel.images} />

        {/* Hero Content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-5xl md:text-6xl lg:text-7xl font-heading italic text-white mb-4">
            {heroHeading}
          </h1>
          <p className="text-white/90 text-lg md:text-xl max-w-2xl leading-relaxed">
            {heroSubtext}
          </p>
        </div>
      </div>

      {/* Search Bar — sticky on scroll */}
      <div className="sticky top-4 z-30 max-w-5xl mx-auto px-4 -mt-10">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 md:p-6 flex flex-row flex-wrap items-center gap-4 md:gap-6">
          {/* Dates — clickable to open calendar */}
          <div className="relative flex-1 min-w-[120px]">
            <button
              onClick={() => {
                setCalendarOpen(!calendarOpen);
                setGuestsOpen(false);
              }}
              className="flex items-center gap-3 w-full text-left hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
            >
              <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-5 h-5 text-primary-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t("yourStay")}
                </p>
                <p className="text-base font-semibold text-gray-900">
                  {formatDateShort(checkIn, locale)} — {formatDate(checkOut, locale)}
                </p>
                <p className="text-sm text-gray-500">{tc("nights", { count: nights })}</p>
              </div>
            </button>
            <DatePickerCalendar
              open={calendarOpen}
              onClose={() => setCalendarOpen(false)}
              checkIn={checkIn}
              checkOut={checkOut}
              onSelect={(ci, co) => {
                setCheckIn(ci);
                setCheckOut(co);
              }}
            />
          </div>

          {/* Divider */}
          <div className="w-px h-12 bg-gray-200" />

          {/* Guests — clickable to open selector */}
          <div className="relative w-auto min-w-[100px]">
            <button
              onClick={() => {
                setGuestsOpen(!guestsOpen);
                setCalendarOpen(false);
              }}
              className="flex items-center gap-3 w-full hover:bg-gray-50 rounded-xl p-1 -m-1 transition-colors"
            >
              <div className="hidden md:flex w-10 h-10 rounded-full bg-primary-50 items-center justify-center flex-shrink-0">
                <svg
                  className="w-5 h-5 text-primary-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </div>
              <div className="text-left">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {tc("guests")}
                </p>
                <p className="text-base font-semibold text-gray-900 whitespace-nowrap">
                  {tc("adults", { count: adults })}
                  {effectiveChildren > 0 && `, ${tc("children", { count: effectiveChildren })}`}
                </p>
                <p className="text-sm text-gray-500">{tc("guests")}</p>
              </div>
            </button>
            <GuestSelector
              open={guestsOpen}
              onClose={() => setGuestsOpen(false)}
              adults={adults}
              childCount={effectiveChildren}
              adultAgeThreshold={guestTypeSettings.adultAgeThreshold}
              childrenEnabled={guestTypeSettings.childrenEnabled}
              onUpdate={(a, c) => {
                setAdults(a);
                setChildren(c);
              }}
            />
          </div>

          {/* Divider */}
          <div className="hidden md:block w-px h-12 bg-gray-200" />

          {/* Promo */}
          <div className="relative flex justify-center md:justify-start w-full md:w-auto">
            {appliedPromo ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 rounded-full text-xs font-semibold">
                  <svg
                    className="w-3.5 h-3.5"
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
                  {appliedPromo.code}
                  {appliedPromo.discountType === "percentage"
                    ? ` (-${appliedPromo.discountValue}%)`
                    : ` (-${appliedPromo.discountValue})`}
                </span>
                <button
                  onClick={() => {
                    setAppliedPromo(null);
                    setPromoCode("");
                    setPromoError("");
                  }}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
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
            ) : (
              <>
                <button
                  onClick={() => {
                    setPromoOpen(!promoOpen);
                    setCalendarOpen(false);
                    setGuestsOpen(false);
                  }}
                  className="flex items-center gap-2 text-gray-500 hover:text-primary-600 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                    />
                  </svg>
                  <span className="text-sm font-medium">{t("addPromo")}</span>
                </button>
                {promoOpen && (
                  <PromoPopover
                    open={promoOpen}
                    onClose={() => setPromoOpen(false)}
                    value={promoCode}
                    onChange={(v) => {
                      setPromoCode(v);
                      setPromoError("");
                    }}
                    onApply={async () => {
                      if (!promoCode.trim() || !slug) return;
                      setPromoLoading(true);
                      setPromoError("");
                      try {
                        const result = await hotelService.validatePromoCode(slug, promoCode, {
                          checkIn: checkIn || undefined,
                        });
                        if (result.valid) {
                          setAppliedPromo({
                            code: result.code,
                            discountType: result.discountType!,
                            discountValue: result.discountValue!,
                          });
                          setPromoOpen(false);
                        } else {
                          setPromoError(result.message);
                        }
                      } catch {
                        setPromoError("Failed to validate promo code");
                      } finally {
                        setPromoLoading(false);
                      }
                    }}
                    loading={promoLoading}
                    error={promoError}
                    t={t}
                  />
                )}
              </>
            )}
          </div>

          {/* Check Availability Button */}
          <button
            onClick={async () => {
              setCalendarOpen(false);
              setGuestsOpen(false);
              setPromoOpen(false);
              setCommittedCheckIn(checkIn);
              setCommittedCheckOut(checkOut);
              setCommittedAdults(adults);
              setCommittedChildren(effectiveChildren);
              setSearching(true);
              roomsSectionRef.current?.scrollIntoView({ behavior: "smooth" });
              await refetchRooms(checkIn, checkOut, adults, effectiveChildren);
              setSearching(false);
            }}
            disabled={searching || roomsRefetching}
            className="w-full md:w-auto px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors whitespace-nowrap disabled:opacity-80 flex items-center justify-center gap-2"
          >
            {searching ? (
              <>
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                {tc("loading")}
              </>
            ) : (
              tc("checkAvailability")
            )}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div ref={roomsSectionRef} className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Section Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
          <h2 className="text-2xl md:text-3xl font-heading text-gray-900">
            {t("availableAccommodations")}
          </h2>

          {/* Step Indicator */}
          <div className="flex items-center gap-2">
            {STEPS.map((step, index) => (
              <div key={step.number} className="flex items-center">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      step.number === currentStep
                        ? "bg-primary-600 text-white"
                        : step.number < currentStep
                          ? "bg-success-500 text-white"
                          : "bg-gray-200 text-gray-500"
                    }`}
                  >
                    {step.number}
                  </div>
                  <span
                    className={`hidden md:inline text-sm font-medium ${
                      step.number === currentStep ? "text-gray-900" : "text-gray-400"
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && <div className="w-8 md:w-12 h-px bg-gray-300 mx-2" />}
              </div>
            ))}
          </div>
        </div>

        <RoomFiltersBar
          filters={FILTERS}
          activeFilters={activeFilters}
          onToggleFilter={toggleFilter}
          sortOption={sortOption}
          onSortChange={setSortOption}
        />

        {/* Room Cards */}
        {mapViewEnabled && !roomsLoading && (
          <div className="mb-5 flex rounded-full border border-gray-200 bg-gray-50 p-1 md:hidden">
            {(["list", "map"] as const).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setMobileResultView(view)}
                className={`flex-1 rounded-full px-4 py-2 text-sm font-semibold capitalize transition-colors ${
                  mobileResultView === view
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                {t(`mobileView.${view}`)}
              </button>
            ))}
          </div>
        )}

        <div
          className={
            mapViewEnabled && !roomsLoading
              ? "grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_420px] gap-6"
              : ""
          }
        >
          <div
            className={`space-y-6 ${
              mapViewEnabled && mobileResultView === "map" ? "hidden md:block" : ""
            } ${mapViewEnabled ? "md:max-h-[calc(100vh-120px)] md:overflow-y-auto md:pr-2" : ""}`}
          >
            {roomsLoading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="bg-white border border-gray-200 rounded-2xl overflow-hidden animate-pulse"
                  >
                    <div className="flex flex-col md:flex-row">
                      <div className="w-full md:w-[420px] h-64 md:min-h-[320px] bg-gray-200" />
                      <div className="flex-1 p-5 space-y-4">
                        <div className="h-6 bg-gray-200 rounded w-48" />
                        <div className="h-4 bg-gray-200 rounded w-32" />
                        <div className="flex gap-2">
                          <div className="h-8 bg-gray-200 rounded-full w-24" />
                          <div className="h-8 bg-gray-200 rounded-full w-20" />
                          <div className="h-8 bg-gray-200 rounded-full w-28" />
                        </div>
                        <div className="h-px bg-gray-100" />
                        <div className="h-16 bg-gray-200 rounded-xl" />
                        <div className="h-16 bg-gray-200 rounded-xl" />
                      </div>
                    </div>
                  </div>
                ))
              : filteredRooms.map((room, roomIndex) => (
                  <div
                    key={room.id}
                    id={`room-${room.id}`}
                    ref={(node) => {
                      roomRefs.current[room.id] = node;
                    }}
                  >
                    <RoomCard
                      room={room}
                      nights={nights}
                      totalGuests={committedAdults + effectiveCommittedChildren}
                      imageIndex={imageIndices[room.id] ?? 0}
                      checkIn={committedCheckIn}
                      hotelTimezone={hotel.timezone}
                      active={activeRoomId === room.id}
                      highlighted={hoveredRoomId === room.id}
                      onHover={(hovered) => setHoveredRoomId(hovered ? room.id : null)}
                      onSelectCard={() => setActiveRoomId(room.id)}
                      onChangeImageIndex={(i) =>
                        setImageIndices((prev) => ({ ...prev, [room.id]: i }))
                      }
                      selectedRate={
                        (selectedRates[room.id] as "flexible" | "nonrefundable" | null) ?? null
                      }
                      onChangeSelectedRate={(next) =>
                        setSelectedRates((prev) => ({ ...prev, [room.id]: next }))
                      }
                      onView={() => {
                        trackEvent(slug, "viewed_room", { roomId: room.id });
                        setDetailModalIndex(roomIndex);
                      }}
                      onSelectRate={(rateType, requiredRooms) => {
                        handleSelectRate(room, rateType, requiredRooms);
                      }}
                      selectRateDisabled={isSelectingRate}
                      selectRatePending={pendingRateSelection?.roomId === room.id}
                    />
                  </div>
                ))}
          </div>

          {mapViewEnabled && !roomsLoading && (
            <div className={mobileResultView === "list" ? "hidden md:block" : "block"}>
              <div className="md:sticky md:top-28">
                <RoomMapPanel
                  rooms={filteredRooms}
                  activeRoomId={activeRoomId}
                  hoveredRoomId={hoveredRoomId}
                  onHoverRoom={setHoveredRoomId}
                  onSelectRoom={selectRoomFromMap}
                  className="md:h-[calc(100vh-140px)]"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Room Detail Modal */}
      {detailModalIndex !== null &&
        filteredRooms[detailModalIndex] &&
        (() => {
          const modalRoom = filteredRooms[detailModalIndex];
          const modalRequiredRooms = Math.ceil(
            (committedAdults + effectiveCommittedChildren) / modalRoom.maxOccupancy,
          );
          const modalSoldOut = modalRoom.remainingRooms < modalRequiredRooms;
          return (
            <RoomDetailModal
              room={modalRoom}
              nights={nights}
              open={true}
              onClose={() => setDetailModalIndex(null)}
              currentIndex={detailModalIndex}
              totalRooms={filteredRooms.length}
              onPrev={() =>
                setDetailModalIndex(
                  detailModalIndex === 0 ? filteredRooms.length - 1 : detailModalIndex - 1,
                )
              }
              onNext={() =>
                setDetailModalIndex(
                  detailModalIndex === filteredRooms.length - 1 ? 0 : detailModalIndex + 1,
                )
              }
              soldOut={modalSoldOut}
              checkInTime={hotel.checkInTime}
              checkOutTime={hotel.checkOutTime}
              checkIn={committedCheckIn}
              hotelTimezone={hotel.timezone}
              propertyName={hotel.name}
              showLocationMap={hotel.showRoomDetailMap}
              pointsOfInterest={hotel.pointsOfInterest || []}
              onSelectRate={(rateType) => {
                if (modalSoldOut) return;
                handleSelectRate(modalRoom, rateType, modalRequiredRooms);
              }}
              selectRateDisabled={isSelectingRate}
              selectRatePending={pendingRateSelection?.roomId === modalRoom.id}
            />
          );
        })()}

      <BookingFooter />
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <HomePageContent />
    </Suspense>
  );
}
