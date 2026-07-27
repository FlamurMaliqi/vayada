"use client";

import { MutableRefObject } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import type { HotelFormState, ListingFormData } from "@/lib/types";
import { FormNavigationButtons } from "../FormNavigationButtons";
import { HotelBasicInfoStep } from "./HotelBasicInfoStep";
import { HotelListingsStep } from "./HotelListingsStep";
import type { ListingCardSection } from "./ListingCard";
import type { HotelTaskSection } from "@/app/profile/complete/hotelTaskFlow";

interface HotelProfileFormProps {
  // Form state
  form: HotelFormState;
  listings: ListingFormData[];

  // Step management
  currentStep: number;
  totalSteps: number;
  activeSection: HotelTaskSection;

  // UI state
  error: string;
  submitting: boolean;
  canProceed: boolean;
  collapsedCards: Set<number>;
  countryInputs: Record<number, string>;
  countries: string[];
  showCoverPhotoPicker?: boolean;
  coverPhotoPreview?: string | null;
  coverPhotoRequired?: boolean;
  hasSelectedCoverPhoto?: boolean;
  showLocalityConsent?: boolean;
  submitLabel?: string;
  embedded?: boolean;

  // Refs
  imageInputRefs: MutableRefObject<(HTMLInputElement | null)[]>;
  coverPhotoInputRef?: React.RefObject<HTMLInputElement>;

  // Form handlers
  onFormChange: (updates: Partial<HotelFormState>) => void;
  onCoverPhotoChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClearCoverPhoto?: () => void;

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
  activeSection,
  error,
  submitting,
  canProceed,
  collapsedCards,
  countryInputs,
  countries,
  showCoverPhotoPicker,
  coverPhotoPreview,
  coverPhotoRequired,
  hasSelectedCoverPhoto,
  showLocalityConsent,
  submitLabel,
  embedded = false,
  imageInputRefs,
  coverPhotoInputRef,
  onFormChange,
  onCoverPhotoChange,
  onClearCoverPhoto,
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
    activeSection === "offer_details"
      ? "details"
      : activeSection === "offerings"
        ? "offerings"
        : "requirements";
  const isProfileSection =
    activeSection === "public_profile" || activeSection === "creator_profile";

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
        className={
          isProfileSection
            ? `space-y-6 ${embedded ? "" : "rounded-xl border border-gray-200 bg-white p-5 sm:p-6"}`
            : "space-y-4"
        }
      >
        {isProfileSection && (
          <HotelBasicInfoStep
            form={form}
            onFormChange={onFormChange}
            error={error}
            showIntro={!embedded}
            publicProfileMode={activeSection === "public_profile"}
            showLocalityConsent={showLocalityConsent}
            showCoverPhotoPicker={showCoverPhotoPicker}
            coverPhotoPreview={coverPhotoPreview}
            coverPhotoRequired={coverPhotoRequired}
            hasSelectedCoverPhoto={hasSelectedCoverPhoto}
            coverPhotoInputRef={coverPhotoInputRef}
            onCoverPhotoChange={onCoverPhotoChange}
            onClearCoverPhoto={onClearCoverPhoto}
          />
        )}

        {!isProfileSection && (
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
          submitLabel={submitLabel ?? "Complete setup task"}
          stackOnMobile
        />
      </form>
    </div>
  );
}
