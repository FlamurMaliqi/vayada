"use client";

import { XMarkIcon, SparklesIcon, PaperAirplaneIcon } from "@heroicons/react/24/outline";
import { PLATFORM_OPTIONS, AGE_GROUP_OPTIONS, CREATOR_TYPE_OPTIONS } from "@/lib/constants";
import type { ListingFormData, CreatorType } from "@/lib/types";

interface ListingRequirementsProps {
  listing: ListingFormData;
  index: number;
  countryInput: string;
  countries: string[];
  onUpdateListing: (
    index: number,
    field: keyof ListingFormData,
    value: ListingFormData[keyof ListingFormData],
  ) => void;
  onCountryInputChange: (index: number, value: string) => void;
}

export function ListingRequirements({
  listing,
  index,
  countryInput,
  countries,
  onUpdateListing,
  onCountryInputChange,
}: ListingRequirementsProps) {
  const filteredCountries = countryInput
    ? countries.filter(
        (c) =>
          c.toLowerCase().includes(countryInput.toLowerCase()) &&
          !listing.targetGroupCountries.includes(c),
      )
    : [];

  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-center gap-2">
        <div className="h-5 w-1 rounded-full bg-primary-600" />
        <h5 className="text-base font-semibold text-gray-900">Looking For</h5>
      </div>
      <div className="space-y-4">
        {/* Platforms */}
        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-900">
            Creator&apos;s platforms <span className="text-red-500">*</span>
          </label>
          <p className="mb-2 text-xs text-gray-600">Which platforms should the creator have?</p>
          <div className="flex flex-wrap gap-2">
            {PLATFORM_OPTIONS.map((platform) => {
              const isSelected = listing.lookingForPlatforms.includes(platform);
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
                        onUpdateListing(index, "lookingForPlatforms", [
                          ...listing.lookingForPlatforms,
                          platform,
                        ]);
                      } else {
                        onUpdateListing(
                          index,
                          "lookingForPlatforms",
                          listing.lookingForPlatforms.filter((p) => p !== platform),
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

        {/* Creator Types */}
        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-900">
            Creator Type (optional)
          </label>
          <p className="mb-2 text-xs text-gray-600">What type of creators are you looking for?</p>
          <div className="flex flex-wrap gap-2">
            {CREATOR_TYPE_OPTIONS.map((type) => {
              const isSelected =
                listing.lookingForCreatorTypes?.includes(type as CreatorType) || false;
              return (
                <label
                  key={type}
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
                      const currentTypes = listing.lookingForCreatorTypes || [];
                      if (e.target.checked) {
                        onUpdateListing(index, "lookingForCreatorTypes", [
                          ...currentTypes,
                          type as CreatorType,
                        ]);
                      } else {
                        onUpdateListing(
                          index,
                          "lookingForCreatorTypes",
                          currentTypes.filter((t) => t !== type),
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
                  {type === "Lifestyle" ? (
                    <SparklesIcon
                      className={`mr-1 h-4 w-4 ${isSelected ? "text-primary-700" : "text-gray-500"}`}
                    />
                  ) : (
                    <PaperAirplaneIcon
                      className={`mr-1 h-4 w-4 ${isSelected ? "text-primary-700" : "text-gray-500"}`}
                    />
                  )}
                  <span className={isSelected ? "text-primary-700" : "text-gray-700"}>
                    {type} Creator
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Top Countries */}
        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-900">
            Top Countries (optional)
          </label>
          <p className="mb-2 text-xs text-gray-600">
            Select up to 3 countries your target audience is from
          </p>
          <div className="space-y-2">
            <input
              type="text"
              aria-label="Search target countries"
              value={countryInput}
              onChange={(e) => onCountryInputChange(index, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const country = countryInput.trim();
                  if (
                    country &&
                    countries.includes(country) &&
                    !listing.targetGroupCountries.includes(country) &&
                    listing.targetGroupCountries.length < 3
                  ) {
                    onUpdateListing(index, "targetGroupCountries", [
                      ...listing.targetGroupCountries,
                      country,
                    ]);
                    onCountryInputChange(index, "");
                  }
                }
              }}
              placeholder="Search countries..."
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 outline-none focus:border-primary-300 focus:ring-2 focus:ring-primary-200"
            />
            {/* Dropdown suggestions */}
            {filteredCountries.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-sm">
                {filteredCountries.map((country) => (
                  <button
                    key={country}
                    type="button"
                    onClick={() => {
                      if (
                        listing.targetGroupCountries.length < 3 &&
                        !listing.targetGroupCountries.includes(country)
                      ) {
                        onUpdateListing(index, "targetGroupCountries", [
                          ...listing.targetGroupCountries,
                          country,
                        ]);
                        onCountryInputChange(index, "");
                      }
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-primary-50"
                  >
                    {country}
                  </button>
                ))}
              </div>
            )}
            {listing.targetGroupCountries.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {listing.targetGroupCountries.map((country, countryIndex) => (
                  <span
                    key={countryIndex}
                    className="inline-flex items-center gap-1 rounded-full bg-primary-50 text-primary-700 text-xs font-semibold px-3 py-1 border border-primary-100"
                  >
                    {country}
                    <button
                      type="button"
                      aria-label={`Remove ${country}`}
                      onClick={() => {
                        onUpdateListing(
                          index,
                          "targetGroupCountries",
                          listing.targetGroupCountries.filter((c) => c !== country),
                        );
                      }}
                      className="text-primary-500 hover:text-primary-700"
                    >
                      <XMarkIcon className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Age Groups */}
        <div>
          <label className="mb-1 block text-sm font-semibold text-gray-900">
            Age Groups (optional)
          </label>
          <p className="mb-2 text-xs text-gray-600">Select up to 3 age groups you want to target</p>
          <div className="flex flex-wrap gap-2">
            {AGE_GROUP_OPTIONS.map((range) => {
              const isSelected = listing.targetGroupAgeGroups?.includes(range) || false;
              return (
                <button
                  key={range}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => {
                    const currentGroups = listing.targetGroupAgeGroups || [];
                    if (isSelected) {
                      onUpdateListing(
                        index,
                        "targetGroupAgeGroups",
                        currentGroups.filter((g) => g !== range),
                      );
                    } else {
                      if (currentGroups.length < 3) {
                        onUpdateListing(index, "targetGroupAgeGroups", [...currentGroups, range]);
                      }
                    }
                  }}
                  disabled={!isSelected && (listing.targetGroupAgeGroups?.length || 0) >= 3}
                  className={`px-3 py-1.5 rounded-full border text-sm font-semibold transition-colors ${
                    isSelected
                      ? "bg-primary-50 text-primary-700 border-primary-200"
                      : "bg-white text-gray-700 border-gray-200 hover:border-primary-200 hover:text-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  }`}
                >
                  {range}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
