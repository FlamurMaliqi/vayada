"use client";

import { MutableRefObject } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { HotelFormState, ListingFormData } from "@/lib/types";
import { FormNavigationButtons } from "../FormNavigationButtons";
import { HotelBasicInfoStep } from "./HotelBasicInfoStep";
import { HotelListingsStep } from "./HotelListingsStep";
import type { ListingCardSection } from "./ListingCard";

interface HotelProfileFormProps {
  // Form state
  form: HotelFormState;
  listings: ListingFormData[];

  // Step management
  currentStep: number;
  totalSteps: number;

  // UI state
  error: string;
  submitting: boolean;
  canProceed: boolean;
  collapsedCards: Set<number>;
  countryInputs: Record<number, string>;
  countries: string[];

  // Refs
  imageInputRefs: MutableRefObject<(HTMLInputElement | null)[]>;

  // Form handlers
  onFormChange: (updates: Partial<HotelFormState>) => void;

  // Listing handlers
  onToggleCollapse: (index: number) => void;
  onUpdateListing: (
    index: number,
    field: keyof ListingFormData,
    value: ListingFormData[keyof ListingFormData],
  ) => void;
  onImageChange: (listingIndex: number, e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveImage: (listingIndex: number, imageIndex: number) => void;
  onCountryInputChange: (index: number, value: string) => void;

  // Navigation handlers
  onPrevStep: () => void;
  onNextStep: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function HotelProfileForm({
  form,
  listings,
  currentStep,
  totalSteps,
  error,
  submitting,
  canProceed,
  collapsedCards,
  countryInputs,
  countries,
  imageInputRefs,
  onFormChange,
  onToggleCollapse,
  onUpdateListing,
  onImageChange,
  onRemoveImage,
  onCountryInputChange,
  onPrevStep,
  onNextStep,
  onSubmit,
}: HotelProfileFormProps) {
  const listingSection: ListingCardSection =
    currentStep === 2 ? "details" : currentStep === 3 ? "offerings" : "requirements";

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (currentStep === totalSteps) {
      onSubmit(e);
    } else {
      onNextStep();
    }
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={handleFormSubmit}
        className={`rounded-xl border border-gray-200 bg-white ${
          currentStep > 1 ? "space-y-4 border-0 bg-transparent" : "space-y-6 p-5 sm:p-6"
        }`}
      >
        {/* Step 1: Basic Information */}
        {currentStep === 1 && (
          <HotelBasicInfoStep form={form} onFormChange={onFormChange} error={error} />
        )}

        {/* Steps 2–4: one focused collaboration-offer section at a time */}
        {currentStep > 1 && (
          <HotelListingsStep
            listings={listings}
            section={listingSection}
            collapsedCards={collapsedCards}
            countryInputs={countryInputs}
            countries={countries}
            imageInputRefs={imageInputRefs}
            onToggleCollapse={onToggleCollapse}
            onUpdateListing={onUpdateListing}
            onImageChange={onImageChange}
            onRemoveImage={onRemoveImage}
            onCountryInputChange={onCountryInputChange}
          />
        )}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4"
          >
            <XMarkIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" />
            <p className="whitespace-pre-line text-sm font-medium text-red-800">{error}</p>
          </div>
        )}

        <FormNavigationButtons
          currentStep={currentStep}
          totalSteps={totalSteps}
          submitting={submitting}
          canProceed={canProceed}
          onPrevious={onPrevStep}
          submitLabel="Complete Marketplace setup"
          stackOnMobile
        />
      </form>
    </div>
  );
}
