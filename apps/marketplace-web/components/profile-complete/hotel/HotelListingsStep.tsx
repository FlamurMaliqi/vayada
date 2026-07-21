"use client";

import { MutableRefObject } from "react";
import { HotelBadgeIcon } from "@/components/ui";
import type { ListingFormData } from "@/lib/types";
import { ListingCard, type ListingCardSection } from "./ListingCard";

interface HotelListingsStepProps {
  listings: ListingFormData[];
  section: ListingCardSection;
  collapsedCards: Set<number>;
  countryInputs: Record<number, string>;
  countries: string[];
  imageInputRefs: MutableRefObject<(HTMLInputElement | null)[]>;
  onToggleCollapse: (index: number) => void;
  onUpdateListing: (
    index: number,
    field: keyof ListingFormData,
    value: ListingFormData[keyof ListingFormData],
  ) => void;
  onImageChange: (listingIndex: number, e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveImage: (listingIndex: number, imageIndex: number) => void;
  onCountryInputChange: (index: number, value: string) => void;
}

export function HotelListingsStep({
  listings,
  section,
  collapsedCards,
  countryInputs,
  countries,
  imageInputRefs,
  onToggleCollapse,
  onUpdateListing,
  onImageChange,
  onRemoveImage,
  onCountryInputChange,
}: HotelListingsStepProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <HotelBadgeIcon active />
        <div className="flex-1">
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-base font-semibold text-gray-950">Your collaboration offer</h3>
            <span className="w-fit rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
              First offer
            </span>
          </div>
          <p className="mt-1 text-sm leading-5 text-gray-500">
            {section === "details"
              ? "Add a clear title, description, and photos. You can create more offers after setup."
              : section === "offerings"
                ? "Choose the collaboration terms, availability, and content platforms."
                : "Choose the creator platforms and audience fit for this offer."}
          </p>
        </div>
      </div>

      {listings.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg">
            <HotelBadgeIcon />
          </div>
          <p className="mb-1 text-sm font-semibold text-gray-900">Your offer could not be loaded</p>
          <p className="text-sm text-gray-500">Return to setup and try again.</p>
        </div>
      )}

      {listings.map((listing, index) => (
        <ListingCard
          key={index}
          listing={listing}
          index={index}
          section={section}
          isCollapsed={collapsedCards.has(index)}
          countryInput={countryInputs[index] || ""}
          countries={countries}
          imageInputRef={{ current: imageInputRefs.current[index] ?? null }}
          onToggleCollapse={() => onToggleCollapse(index)}
          onUpdateListing={onUpdateListing}
          onImageChange={(e) => onImageChange(index, e)}
          onRemoveImage={(imageIndex) => onRemoveImage(index, imageIndex)}
          onCountryInputChange={onCountryInputChange}
        />
      ))}
    </div>
  );
}
