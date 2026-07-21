"use client";

import { Input } from "@/components/ui";
import {
  CheckCircleIcon,
  GiftIcon,
  CurrencyDollarIcon,
  TagIcon,
  CalendarDaysIcon,
  LinkIcon,
} from "@heroicons/react/24/outline";
import { MONTHS_FULL, PLATFORM_OPTIONS, COLLABORATION_TYPES } from "@/lib/constants";
import { CURRENCY_OPTIONS } from "@/lib/utils/getCurrencySymbol";
import type { ListingFormData } from "@/lib/types";

interface ListingOfferingsProps {
  listing: ListingFormData;
  index: number;
  onUpdateListing: (
    index: number,
    field: keyof ListingFormData,
    value: ListingFormData[keyof ListingFormData],
  ) => void;
}

export function ListingOfferings({ listing, index, onUpdateListing }: ListingOfferingsProps) {
  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-center gap-2">
        <div className="h-5 w-1 rounded-full bg-primary-600" />
        <h5 className="text-base font-semibold text-gray-900">Offerings</h5>
      </div>
      <div className="space-y-4">
        {/* Collaboration Types */}
        <div>
          <label className="mb-2 block text-sm font-semibold text-gray-900">
            Collaboration Types <span className="text-red-500">*</span>
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {COLLABORATION_TYPES.map((type) => {
              const isSelected = listing.collaborationTypes.includes(type);
              const icons = {
                "Free Stay": GiftIcon,
                Paid: CurrencyDollarIcon,
                Discount: TagIcon,
                Affiliate: LinkIcon,
              };
              const Icon = icons[type as keyof typeof icons];

              return (
                <label
                  key={type}
                  className={`relative flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 text-left transition-colors focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 ${
                    isSelected
                      ? "border-primary-500 bg-primary-50"
                      : "border-gray-200 bg-white text-gray-800 hover:border-primary-200"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      if (e.target.checked) {
                        onUpdateListing(index, "collaborationTypes", [
                          ...listing.collaborationTypes,
                          type,
                        ]);
                        // Prefill the Affiliate commission to 5% only when the
                        // field is still empty/untouched, so user input or a
                        // stored value is never overwritten.
                        if (type === "Affiliate" && listing.commissionPercentage == null) {
                          onUpdateListing(index, "commissionPercentage", 5);
                        }
                      } else {
                        onUpdateListing(
                          index,
                          "collaborationTypes",
                          listing.collaborationTypes.filter((t) => t !== type),
                        );
                      }
                    }}
                    className="sr-only"
                  />
                  <div
                    className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
                      isSelected ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${isSelected ? "text-white" : "text-gray-700"}`} />
                  </div>
                  <span className="text-sm font-semibold text-gray-900">{type}</span>
                  {isSelected && <CheckCircleIcon className="ml-auto h-4 w-4 text-primary-700" />}
                </label>
              );
            })}
          </div>
        </div>

        {/* Free Stay Details */}
        {listing.collaborationTypes.includes("Free Stay") && (
          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                <GiftIcon className="w-5 h-5" />
              </div>
              <div>
                <h6 className="text-sm font-semibold text-gray-900">Free Stay Details</h6>
                <p className="text-xs text-gray-600">Specify the night range for free stays</p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label="Min. Nights"
                type="number"
                value={listing.freeStayMinNights || ""}
                min={1}
                onChange={(e) => {
                  const { value } = e.target;
                  if (value === "") {
                    onUpdateListing(index, "freeStayMinNights", undefined);
                    return;
                  }
                  const parsed = parseInt(value);
                  onUpdateListing(
                    index,
                    "freeStayMinNights",
                    Number.isNaN(parsed) ? undefined : Math.max(1, parsed),
                  );
                }}
                placeholder="1"
                required
                className="bg-gray-50 border-gray-200"
              />
              <Input
                label="Max. Nights"
                type="number"
                value={listing.freeStayMaxNights || ""}
                min={1}
                onChange={(e) => {
                  const { value } = e.target;
                  if (value === "") {
                    onUpdateListing(index, "freeStayMaxNights", undefined);
                    return;
                  }
                  const parsed = parseInt(value);
                  onUpdateListing(
                    index,
                    "freeStayMaxNights",
                    Number.isNaN(parsed) ? undefined : Math.max(1, parsed),
                  );
                }}
                placeholder="5"
                required
                className="bg-gray-50 border-gray-200"
              />
            </div>
          </div>
        )}

        {/* Paid Details */}
        {listing.collaborationTypes.includes("Paid") && (
          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                <CurrencyDollarIcon className="w-5 h-5" />
              </div>
              <div>
                <h6 className="text-sm font-semibold text-gray-900">Paid Details</h6>
                <p className="text-xs text-gray-600">Set the maximum payment amount</p>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="w-32">
                <label className="block text-xs font-semibold text-gray-700 mb-1">Currency</label>
                <select
                  value={listing.currency || "USD"}
                  onChange={(e) => onUpdateListing(index, "currency", e.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none transition focus:border-primary-500 focus:bg-white focus:ring-2 focus:ring-primary-100"
                >
                  {CURRENCY_OPTIONS.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <Input
                  label="Max. Amount"
                  type="number"
                  value={listing.paidMaxAmount || ""}
                  onChange={(e) =>
                    onUpdateListing(index, "paidMaxAmount", parseInt(e.target.value) || undefined)
                  }
                  placeholder="5000"
                  required
                  className="bg-gray-50 border-gray-200"
                />
              </div>
            </div>
          </div>
        )}

        {/* Discount Details */}
        {listing.collaborationTypes.includes("Discount") && (
          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                <TagIcon className="w-5 h-5" />
              </div>
              <div>
                <h6 className="text-sm font-semibold text-gray-900">Discount Details</h6>
                <p className="text-xs text-gray-600">Set the discount percentage</p>
              </div>
            </div>
            <Input
              label="Discount Percentage (%)"
              type="number"
              value={listing.discountPercentage || ""}
              onChange={(e) =>
                onUpdateListing(index, "discountPercentage", parseInt(e.target.value) || undefined)
              }
              placeholder="20"
              min={1}
              max={100}
              required
              className="bg-gray-50 border-gray-200"
            />
          </div>
        )}

        {/* Affiliate Details */}
        {listing.collaborationTypes.includes("Affiliate") && (
          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700">
                <LinkIcon className="w-5 h-5" />
              </div>
              <div>
                <h6 className="text-sm font-semibold text-gray-900">Affiliate Details</h6>
                <p className="text-xs text-gray-600">
                  Commission paid on bookings driven by the creator&apos;s link
                </p>
              </div>
            </div>
            <Input
              label="Commission Percentage (%)"
              type="number"
              value={listing.commissionPercentage || ""}
              onChange={(e) =>
                onUpdateListing(
                  index,
                  "commissionPercentage",
                  parseInt(e.target.value) || undefined,
                )
              }
              placeholder="5"
              min={1}
              max={100}
              required
              className="bg-gray-50 border-gray-200"
            />
          </div>
        )}

        {/* Availability */}
        <div>
          <div className="mb-3 flex items-center gap-2">
            <CalendarDaysIcon className="w-5 h-5 text-primary-600" />
            <label className="block text-sm font-semibold text-gray-900">
              Availability <span className="text-red-500">*</span>
            </label>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-3">
            {/* All Year Button */}
            <div className="mb-3">
              <button
                type="button"
                onClick={() => {
                  const allMonthsSelected = MONTHS_FULL.every((month) =>
                    listing.availability.includes(month),
                  );
                  if (allMonthsSelected) {
                    onUpdateListing(index, "availability", []);
                  } else {
                    onUpdateListing(index, "availability", [...MONTHS_FULL]);
                  }
                }}
                className={`w-full rounded-xl border px-4 py-3 text-sm font-semibold transition-colors ${
                  MONTHS_FULL.every((month) => listing.availability.includes(month))
                    ? "border-primary-600 bg-primary-600 text-white"
                    : "border-primary-200 bg-primary-50 text-primary-700 hover:border-primary-300 hover:bg-primary-100"
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <CalendarDaysIcon className="w-5 h-5" />
                  {MONTHS_FULL.every((month) => listing.availability.includes(month))
                    ? "All Year Selected"
                    : "Select All Year"}
                </span>
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {MONTHS_FULL.map((month) => {
                const isSelected = listing.availability.includes(month);
                const monthAbbr = month.substring(0, 3);

                return (
                  <label
                    key={month}
                    className={`relative flex cursor-pointer flex-col items-center justify-center rounded-xl border py-3 transition-colors focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 ${
                      isSelected
                        ? "border-primary-600 bg-primary-600 text-white"
                        : "border-gray-200 bg-gray-50 text-gray-700 hover:border-primary-200"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) => {
                        if (e.target.checked) {
                          onUpdateListing(index, "availability", [...listing.availability, month]);
                        } else {
                          onUpdateListing(
                            index,
                            "availability",
                            listing.availability.filter((m) => m !== month),
                          );
                        }
                      }}
                      className="sr-only"
                    />
                    <div
                      className={`text-sm font-semibold ${isSelected ? "text-white" : "text-gray-700"}`}
                    >
                      {monthAbbr}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Platforms */}
        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-900">
            Content platforms <span className="text-red-500">*</span>
          </label>
          <p className="mb-2 text-xs text-gray-600">
            Where should creators publish content for this offer?
          </p>
          <div className="flex flex-wrap gap-2">
            {PLATFORM_OPTIONS.map((platform) => {
              const isSelected = listing.platforms.includes(platform);
              return (
                <label
                  key={platform}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-primary-600 focus-within:ring-offset-2 ${
                    isSelected
                      ? "border-primary-500 bg-primary-50 text-primary-700"
                      : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      if (e.target.checked) {
                        onUpdateListing(index, "platforms", [...listing.platforms, platform]);
                      } else {
                        onUpdateListing(
                          index,
                          "platforms",
                          listing.platforms.filter((p) => p !== platform),
                        );
                      }
                    }}
                    className="sr-only"
                  />
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                      isSelected ? "border-primary-600 bg-primary-600" : "border-gray-400 bg-white"
                    }`}
                  >
                    {isSelected && <span className="w-2 h-2 rounded-full bg-white"></span>}
                  </span>
                  <span className={isSelected ? "text-primary-700" : "text-gray-700"}>
                    {platform}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
