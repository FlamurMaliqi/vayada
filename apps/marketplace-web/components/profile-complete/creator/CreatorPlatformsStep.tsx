"use client";

import { LinkIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import { PLATFORM_OPTIONS } from "@/lib/constants";
import type { PlatformFormData } from "@/lib/types";
import { PlatformCard } from "./PlatformCard";

interface CreatorPlatformsStepProps {
  platforms: PlatformFormData[];
  expandedPlatforms: Set<number>;
  platformCountryInputs: Record<number, string>;
  onAddPlatform: (name: string) => void;
  onRemovePlatform: (index: number) => void;
  onUpdatePlatform: (
    index: number,
    field: keyof PlatformFormData,
    value: PlatformFormData[keyof PlatformFormData],
  ) => void;
  onTogglePlatformExpanded: (index: number) => void;
  onCountryInputChange: (platformIndex: number, value: string) => void;
  onAddCountry: (platformIndex: number, country?: string) => void;
  onRemoveCountry: (platformIndex: number, countryIndex: number) => void;
  onUpdateCountryPercentage: (
    platformIndex: number,
    countryIndex: number,
    percentage: number,
  ) => void;
  onToggleAgeGroup: (platformIndex: number, ageRange: string) => void;
  onUpdateGenderSplit: (platformIndex: number, field: "male" | "female", value: string) => void;
  getAvailableCountries: (platformIndex: number) => string[];
}

export function CreatorPlatformsStep({
  platforms,
  expandedPlatforms,
  platformCountryInputs,
  onAddPlatform,
  onRemovePlatform,
  onUpdatePlatform,
  onTogglePlatformExpanded,
  onCountryInputChange,
  onAddCountry,
  onRemoveCountry,
  onUpdateCountryPercentage,
  onToggleAgeGroup,
  onUpdateGenderSplit,
  getAvailableCountries,
}: CreatorPlatformsStepProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-600 text-white">
          <LinkIcon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
            Audience & platforms
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-gray-950">Show hotels your reach</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
            Add at least one active account. Audience details help hotels understand whether your
            community fits their guests.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {PLATFORM_OPTIONS.map((platformName) => (
          <PlatformCard
            key={platformName}
            platformName={platformName}
            platforms={platforms}
            allPlatforms={platforms}
            expandedPlatforms={expandedPlatforms}
            platformCountryInputs={platformCountryInputs}
            onAddPlatform={onAddPlatform}
            onRemovePlatform={onRemovePlatform}
            onUpdatePlatform={onUpdatePlatform}
            onTogglePlatformExpanded={onTogglePlatformExpanded}
            onCountryInputChange={onCountryInputChange}
            onAddCountry={onAddCountry}
            onRemoveCountry={onRemoveCountry}
            onUpdateCountryPercentage={onUpdateCountryPercentage}
            onToggleAgeGroup={onToggleAgeGroup}
            onUpdateGenderSplit={onUpdateGenderSplit}
            getAvailableCountries={getAvailableCountries}
          />
        ))}
      </div>

      {platforms.length === 0 && (
        <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          Add at least one platform to complete your profile.
        </p>
      )}

      <div className="flex items-start gap-3 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-600">
        <InformationCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-primary-600" />
        <p className="leading-6">
          Use numbers you can verify in tools such as Instagram Insights or YouTube Analytics.
        </p>
      </div>
    </div>
  );
}
