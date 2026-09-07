"use client";

import { trackEvent } from "@/services/api/tracking";
import { useState, useEffect } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import BookingFooter from "@/components/layout/BookingFooter";
import HeroSection from "@/components/booking/HeroSection";
import StepIndicator from "@/components/booking/StepIndicator";
import AddonDetailModal from "@/components/booking/AddonDetailModal";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { ADDON_CATEGORIES } from "@/lib/constants/addons";
import { useHotel, useAddons, useSlug, useRooms } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { calculateNights, ensureMinOneNight } from "@/lib/utils";
import RoomSelectionSummary from "@/components/booking/RoomSelectionSummary";
import SelectionUnavailable from "@/components/booking/SelectionUnavailable";
import { usePricing } from "@/lib/hooks/usePricing";
import { useBookingSteps } from "@/lib/hooks/useBookingSteps";

export default function AddonsPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("addons");
  const tc = useTranslations("common");
  const tr = useTranslations("roomSelection");
  const { refetchRooms, loading: roomsInitialLoading, roomsLoading } = useRooms();
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const { addons } = useAddons();
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();
  const [activeCategory, setActiveCategory] = useState("all");
  // selections[id] = number of people (perPerson) or items (per-booking-only)
  const [selections, setSelections] = useState<Record<string, number>>({});
  // selectedDates[id] = ISO dates the guest wants the perNight addon on
  const [selectedDates, setSelectedDates] = useState<Record<string, string[]>>({});
  const [packages, setPackages] = useState<Record<string, number>>({});
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const { steps: STEPS, currentStep } = useBookingSteps("addons");

  // Defensively coerce a same-day or invalid URL range so the page never
  // shows / forwards a 0-night stay.
  const { checkIn, checkOut } = ensureMinOneNight(
    searchParams.get("checkIn") || "",
    searchParams.get("checkOut") || "",
  );
  const adultsParam = parseInt(searchParams.get("adults") || "2");
  const nights = calculateNights(checkIn, checkOut);
  const childrenParam = Number(searchParams.get("children") || "0");
  const roomId = searchParams.get("room") || "";
  const roomsParam = Number(searchParams.get("rooms") || "1");
  useEffect(() => {
    if (roomId.startsWith("selection-") && checkIn && checkOut)
      void refetchRooms(checkIn, checkOut, adultsParam, childrenParam, roomsParam);
  }, [roomId, checkIn, checkOut, adultsParam, childrenParam, roomsParam, refetchRooms]);

  // Generate array of stay dates (each night of the stay)
  const stayDates = (() => {
    if (!checkIn || !checkOut) return [];
    const dates: string[] = [];
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split("T")[0]);
    }
    return dates;
  })();

  const availableCategories = ADDON_CATEGORIES.filter(
    (cat) => cat.key === "all" || addons.some((a) => a.category === cat.key),
  );

  const filteredAddons =
    activeCategory === "all" ? addons : addons.filter((a) => a.category === activeCategory);

  const selectedIds = Object.keys(selections);
  const { room, selectedRoomLines, quoteReady, promoError } = usePricing({
    roomId,
    checkIn,
    checkOut,
    adults: adultsParam,
    children: childrenParam,
    roomsParam,
    rateType: searchParams.get("rateType") || "flexible",
    selectedAddonIds: selectedIds,
    addonQuantities: selections,
    addonPackageQuantities: packages,
    addonDates: selectedDates,
    promoCode: searchParams.get("promoCode") || "",
  });

  // What dimension is the count selector for? perPerson → people (max=adults),
  // per-booking-only → items (cap at 10). Per-day-only addons don't get a count
  // selector at all — the day toggles below are the dimension.
  const getCountMax = (addon: {
    perPerson?: boolean;
    perNight?: boolean;
    maxQuantity?: number;
  }) => {
    if (addon.perPerson) return Math.max(1, adultsParam);
    if (addon.perNight) return 1; // count is fixed; day toggles drive the dimension
    return addon.maxQuantity ?? 1;
  };
  const getCountDefault = (addon: { perPerson?: boolean; perNight?: boolean }) => {
    if (addon.perPerson) return Math.max(1, adultsParam); // default to "all guests opt in"
    return 1;
  };
  const showCountSelector = (addon: { perPerson?: boolean; perNight?: boolean }) =>
    addon.perPerson || (!addon.perPerson && !addon.perNight);

  // Total multiplier used for displayed prices: people × days (× items for
  // per-booking-only). Mirrors the backend pricing in
  // pms-backend/services/booking_service._compute_addon_total.
  const computeMultiplier = (
    addon: { id: string; perPerson?: boolean; perNight?: boolean },
    count: number,
    dates: string[],
  ) => {
    const people = addon.perPerson ? count : 1;
    const days = addon.perNight ? Math.max(1, dates.length) : 1;
    const items = !addon.perPerson && !addon.perNight ? count : 1;
    return people * days * items * (packages[addon.id] ?? 1);
  };

  const toggleAddon = (id: string) => {
    setSelections((prev) => {
      if (prev[id] !== undefined) {
        const next = { ...prev };
        delete next[id];
        setPackages((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
        setSelectedDates((pd) => {
          const nd = { ...pd };
          delete nd[id];
          return nd;
        });
        return next;
      }
      const addon = addons.find((a) => a.id === id);
      if (addon?.perNight) {
        setSelectedDates((pd) => ({ ...pd, [id]: [...stayDates] }));
      }
      return { ...prev, [id]: addon ? getCountDefault(addon) : 1 };
    });
  };

  const toggleDate = (addonId: string, date: string) => {
    setSelectedDates((prev) => {
      const current = prev[addonId] || [];
      const updated = current.includes(date)
        ? current.filter((d) => d !== date)
        : [...current, date].sort();
      if (updated.length === 0) return prev; // must keep at least 1 day
      return { ...prev, [addonId]: updated };
    });
  };

  const setCount = (
    id: string,
    count: number,
    addon: { perPerson?: boolean; perNight?: boolean },
  ) => {
    const max = getCountMax(addon);
    const clamped = Math.max(1, Math.min(count, max));
    setSelections((prev) => ({ ...prev, [id]: clamped }));
  };

  if (roomId.startsWith("selection-") && !room)
    return (
      <SelectionUnavailable
        loading={roomsInitialLoading || roomsLoading}
        search={searchParams.toString()}
      />
    );

  return (
    <div className="min-h-screen bg-white">
      <HeroSection
        heroImage={hotel.heroImage}
        hotelName={hotel.name}
        description={hotel.description}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-8 gap-6">
          <div>
            <h1 className="text-3xl font-heading text-gray-900 mb-1">{t("title")}</h1>
            <p className="text-gray-500">{t("subtitle")}</p>
          </div>

          <StepIndicator steps={STEPS} currentStep={currentStep} />
        </div>

        {room?.combination && selectedRoomLines && (
          <section className="mb-8 rounded-2xl border border-gray-200 bg-white p-6">
            <h2 className="mb-4 text-xl font-heading">
              {tr("accommodation", { count: adultsParam + childrenParam })}
            </h2>
            <RoomSelectionSummary
              lines={selectedRoomLines}
              currency={room.currency}
              checkIn={checkIn}
              timezone={hotel.timezone}
              beforeDiscounts
            />
            {promoError && (
              <p role="alert" className="mt-3 text-sm text-red-700">
                {promoError}
              </p>
            )}
          </section>
        )}
        {/* Category Filters */}
        <div className="flex items-center gap-2 mb-8 flex-wrap">
          {availableCategories.map((cat) => (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                activeCategory === cat.key
                  ? "bg-primary-600 text-white border-primary-600"
                  : "bg-white text-gray-700 border-gray-300 hover:border-gray-400"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Add-on Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
          {filteredAddons.map((addon, idx) => {
            const isAdded = selections[addon.id] !== undefined;
            const count = selections[addon.id] ?? 1;
            const dates = selectedDates[addon.id] ?? [];
            const showCount = showCountSelector(addon);
            return (
              <div
                key={addon.id}
                className={`bg-white border rounded-2xl overflow-hidden transition-shadow hover:shadow-lg cursor-pointer ${
                  isAdded ? "border-primary-500 shadow-md" : "border-gray-200"
                }`}
                onClick={() => setDetailIndex(idx)}
              >
                <div className="relative h-48">
                  <Image
                    src={addon.image}
                    alt={addon.name}
                    fill
                    className="object-cover"
                    sizes={bookingImageSizes.addonCard}
                    loading="lazy"
                  />
                </div>
                <div className="p-4">
                  <h3 className="text-base font-bold text-gray-900 mb-1">{addon.name}</h3>
                  <p className="text-sm text-gray-500 mb-4 line-clamp-2">{addon.description}</p>
                  <div className="flex items-center justify-between">
                    <p className="text-lg font-bold text-gray-900">
                      {formatPrice(addon.price, hotel?.currency || "EUR")}
                      {addon.perNight && (
                        <span className="text-xs font-normal text-gray-500"> {tc("perDay")}</span>
                      )}
                      {addon.perPerson && (
                        <span className="text-xs font-normal text-gray-500"> /person</span>
                      )}
                    </p>
                    {isAdded ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {showCount && (
                          <>
                            <button
                              onClick={() => setCount(addon.id, count - 1, addon)}
                              disabled={count <= 1}
                              className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <svg
                                className="w-3 h-3"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M20 12H4"
                                />
                              </svg>
                            </button>
                            <span className="w-10 text-center text-sm font-semibold text-gray-900">
                              {addon.perPerson ? `${count}/${adultsParam}` : count}
                            </span>
                            <button
                              onClick={() => setCount(addon.id, count + 1, addon)}
                              disabled={count >= getCountMax(addon)}
                              className="w-7 h-7 rounded-full border border-gray-300 flex items-center justify-center text-gray-600 hover:border-gray-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <svg
                                className="w-3 h-3"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M12 4v16m8-8H4"
                                />
                              </svg>
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => toggleAddon(addon.id)}
                          className="ml-1 w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors"
                        >
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
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAddon(addon.id);
                        }}
                        className="px-5 py-1.5 rounded-full text-sm font-semibold border-2 transition-colors bg-white text-gray-700 border-gray-300 hover:border-gray-400"
                      >
                        {t("add")}
                      </button>
                    )}
                  </div>
                  {isAdded &&
                    (addon.perPerson || addon.perNight) &&
                    (addon.maxQuantity ?? 1) > 1 && (
                      <label
                        className="mt-3 flex items-center justify-between text-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {tc("qty")}
                        <input
                          type="number"
                          min={1}
                          max={addon.maxQuantity}
                          step={1}
                          aria-label={`${addon.name} quantity`}
                          value={packages[addon.id] ?? 1}
                          onChange={(e) =>
                            setPackages((previous) => ({
                              ...previous,
                              [addon.id]: Math.max(
                                1,
                                Math.min(
                                  addon.maxQuantity ?? 1,
                                  Math.trunc(Number(e.target.value)) || 1,
                                ),
                              ),
                            }))
                          }
                          className="w-20 rounded-lg border border-gray-300 px-3 py-1"
                        />
                      </label>
                    )}
                  {/* Date toggles for perNight addons. Independent of the
                      people-count stepper above for combined per-day/per-person
                      addons (e.g. Scooter Rental). */}
                  {isAdded && addon.perNight && stayDates.length > 0 && (
                    <div
                      className="mt-3 pt-3 border-t border-gray-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <p className="text-xs text-gray-500 mb-2">{t("selectDays")}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {stayDates.map((date) => {
                          const isSelected = dates.includes(date);
                          const d = new Date(date);
                          const dayLabel = d.toLocaleDateString(undefined, { weekday: "short" });
                          const dateLabel = d.toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                          });
                          return (
                            <button
                              key={date}
                              onClick={() => toggleDate(addon.id, date)}
                              disabled={isSelected && dates.length <= 1}
                              className={`px-2 py-1 rounded-lg text-xs font-medium border transition-colors ${
                                isSelected
                                  ? "bg-primary-50 text-primary-700 border-primary-300"
                                  : "bg-gray-50 text-gray-400 border-gray-200 hover:border-gray-300"
                              } disabled:cursor-not-allowed`}
                            >
                              <span className="block leading-tight">{dayLabel}</span>
                              <span className="block leading-tight text-[10px]">{dateLabel}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected Add-ons Summary */}
        {selectedIds.length > 0 && (
          <div className="bg-gradient-to-br from-primary-50 to-white border border-primary-100 rounded-2xl p-6 mb-8">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-white"
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
              </div>
              <h3 className="text-lg font-bold text-gray-900">
                {t("yourSelections", { count: selectedIds.length })}
              </h3>
            </div>
            <div className="space-y-3 mb-5">
              {addons
                .filter((a) => selections[a.id] !== undefined)
                .map((addon) => {
                  const count = selections[addon.id];
                  const dates = selectedDates[addon.id] ?? [];
                  const computedPrice = addon.price * computeMultiplier(addon, count, dates);
                  const detailParts: string[] = [];
                  if ((packages[addon.id] ?? 1) > 1)
                    detailParts.push(`${tc("qty")}: ${packages[addon.id]}`);
                  if (addon.perPerson) {
                    detailParts.push(`${count} / ${adultsParam} ${tc("guests").toLowerCase()}`);
                  }
                  if (addon.perNight) {
                    detailParts.push(`${dates.length} / ${tc("days", { count: nights })}`);
                  }
                  if (!addon.perPerson && !addon.perNight && count > 1) {
                    detailParts.push(`${tc("qty")}: ${count}`);
                  }
                  const detail = detailParts.length ? detailParts.join(" · ") : addon.description;
                  return (
                    <div
                      key={addon.id}
                      className="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-gray-100"
                    >
                      <div className="flex items-center gap-3">
                        <div className="relative w-12 h-12 rounded-lg overflow-hidden flex-shrink-0">
                          <Image
                            src={addon.image}
                            alt={addon.name}
                            fill
                            className="object-cover"
                            sizes={bookingImageSizes.addonThumb}
                            loading="lazy"
                          />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{addon.name}</p>
                          <p className="text-xs text-gray-500">{detail}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <p className="text-sm font-bold text-gray-900">
                          {formatPrice(computedPrice, hotel?.currency || "EUR")}
                        </p>
                        <button
                          onClick={() => toggleAddon(addon.id)}
                          className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-400 hover:text-red-500 hover:border-red-200 transition-colors"
                        >
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
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
            <div className="flex items-center justify-between pt-4 border-t border-primary-100">
              <p className="text-sm text-gray-500">{t("addonsTotal")}</p>
              <p className="text-xl font-bold text-gray-900">
                {(() => {
                  // Sum line totals in displayed currency so total = sum of shown per-line prices
                  // (avoids "$25 × 3 = $76" conversion rounding mismatch).
                  let total = 0;
                  for (const addon of addons) {
                    if (!selectedIds.includes(addon.id)) continue;
                    const count = selections[addon.id] ?? 1;
                    const dates = selectedDates[addon.id] ?? [];
                    const linePrice = addon.price * computeMultiplier(addon, count, dates);
                    total += convertAndRound(linePrice, hotel?.currency || "EUR");
                  }
                  return formatPrice(total, selectedCurrency);
                })()}
              </p>
            </div>
          </div>
        )}

        {/* Bottom Action Bar */}
        <div className="flex items-center justify-between border-t border-gray-200 pt-6">
          <button
            onClick={() => {
              const params = new URLSearchParams();
              if (checkIn) params.set("checkIn", checkIn);
              if (checkOut) params.set("checkOut", checkOut);
              params.set("adults", String(adultsParam));
              const childrenParam = parseInt(searchParams.get("children") || "0");
              if (childrenParam > 0) params.set("children", String(childrenParam));
              const qs = params.toString();
              router.push(qs ? `/?${qs}` : "/");
            }}
            className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            {t("backToRooms")}
          </button>
          <button
            disabled={Boolean(room?.combination && !quoteReady)}
            onClick={() => {
              if (room?.combination && !quoteReady) return;
              const params = new URLSearchParams(searchParams.toString());
              const packageEntries = selectedIds
                .filter((id) => (packages[id] ?? 1) > 1)
                .map((id) => `${id}:${packages[id]}`)
                .join(",");
              if (packageEntries) params.set("addonPackages", packageEntries);
              else params.delete("addonPackages");
              if (selectedIds.length > 0) {
                // For perPerson/per-booking addons, encode the count after a colon.
                // For perNight-only addons, the count is implicit (= dates.length)
                // so we omit it. Combined per-person/per-day addons encode the
                // people count here and the date list in addonDates below.
                params.set(
                  "addons",
                  selectedIds
                    .map((id) => {
                      const addon = addons.find((a) => a.id === id);
                      const count = selections[id] ?? 1;
                      if (addon?.perPerson || (!addon?.perPerson && !addon?.perNight)) {
                        return count > 1 ? `${id}:${count}` : id;
                      }
                      return id;
                    })
                    .join(","),
                );
                // Encode selected dates for perNight addons that have something
                // other than every stay date selected.
                const dateEntries: string[] = [];
                for (const id of selectedIds) {
                  const addon = addons.find((a) => a.id === id);
                  if (!addon?.perNight) continue;
                  const dates = selectedDates[id] ?? [];
                  if (dates.length > 0 && dates.length < stayDates.length) {
                    dateEntries.push(`${id}:${dates.join("|")}`);
                  }
                }
                if (dateEntries.length > 0) {
                  params.set("addonDates", dateEntries.join(","));
                } else {
                  params.delete("addonDates");
                }
              } else {
                params.delete("addons");
                params.delete("addonDates");
              }
              if (addons.length > 0) trackEvent(slug, "addons_step_passed");
              router.push(`/book?${params.toString()}`);
            }}
            className="px-8 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
          >
            {t("proceedToGuest")}
          </button>
        </div>
      </div>

      {detailIndex !== null && filteredAddons[detailIndex] && (
        <AddonDetailModal
          addon={filteredAddons[detailIndex]}
          open
          onClose={() => setDetailIndex(null)}
          isAdded={selections[filteredAddons[detailIndex].id] !== undefined}
          onToggle={() => toggleAddon(filteredAddons[detailIndex].id)}
          currentIndex={detailIndex}
          totalAddons={filteredAddons.length}
          onPrev={() =>
            setDetailIndex(detailIndex > 0 ? detailIndex - 1 : filteredAddons.length - 1)
          }
          onNext={() =>
            setDetailIndex(detailIndex < filteredAddons.length - 1 ? detailIndex + 1 : 0)
          }
        />
      )}

      <BookingFooter />
    </div>
  );
}
