"use client";

import { useState, useRef, useCallback } from "react";
import { countries } from "countries-list";
import type { HotelFormState, ListingFormData } from "@/lib/types";
import { removeListingImageAt } from "@/lib/utils/listingImageState";

const COUNTRIES = Object.values(countries)
  .map((country) => country.name)
  .sort();

interface UseHotelProfileFormOptions {
  onError?: (message: string) => void;
}

export function useHotelProfileForm(options: UseHotelProfileFormOptions = {}) {
  const { onError } = options;

  // Form state
  const [form, setForm] = useState<HotelFormState>({
    about: "",
    localityPublic: false,
  });

  // Listings state
  const [listings, setListings] = useState<ListingFormData[]>([]);
  const [collapsedCards, setCollapsedCards] = useState<Set<number>>(new Set());
  const [countryInputs, setCountryInputs] = useState<Record<number, string>>({});

  const listingImageInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Form change handler
  const handleFormChange = useCallback((updates: Partial<HotelFormState>) => {
    setForm((prev) => ({ ...prev, ...updates }));
  }, []);

  // Listing handlers
  const toggleListingCollapse = useCallback((index: number) => {
    setCollapsedCards((prev) => {
      const newCollapsed = new Set(prev);
      if (newCollapsed.has(index)) {
        newCollapsed.delete(index);
      } else {
        newCollapsed.add(index);
      }
      return newCollapsed;
    });
  }, []);

  const expandAllListings = useCallback(() => {
    setCollapsedCards(new Set());
  }, []);

  const updateListing = useCallback(
    (
      index: number,
      field: keyof ListingFormData,
      value: ListingFormData[keyof ListingFormData],
    ) => {
      setListings((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], [field]: value };
        return updated;
      });
    },
    [],
  );

  // Listing image handlers
  const handleListingImageChange = useCallback(
    (listingIndex: number, e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const fileArray = Array.from(files);
      const maxImages = 10;
      const currentListing = listings[listingIndex];

      // Validate total count
      if (currentListing.images.length + fileArray.length > maxImages) {
        onError?.(`Maximum ${maxImages} images allowed per offer`);
        if (listingImageInputRefs.current[listingIndex]) {
          listingImageInputRefs.current[listingIndex]!.value = "";
        }
        return;
      }

      // Validate all files first
      for (const file of fileArray) {
        if (!file.type.startsWith("image/")) {
          onError?.("Please upload image files only (JPG, PNG, WebP)");
          if (listingImageInputRefs.current[listingIndex]) {
            listingImageInputRefs.current[listingIndex]!.value = "";
          }
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          onError?.("Image must be 10 MB or smaller");
          if (listingImageInputRefs.current[listingIndex]) {
            listingImageInputRefs.current[listingIndex]!.value = "";
          }
          return;
        }
      }

      onError?.("");

      // Process all files
      let processedCount = 0;
      const newImages: string[] = [];
      const newFiles: File[] = [];

      fileArray.forEach((file) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          newImages.push(reader.result as string);
          newFiles.push(file);
          processedCount++;

          // When all files are processed, update state once
          if (processedCount === fileArray.length) {
            setListings((prev) => {
              const updated = [...prev];
              updated[listingIndex] = {
                ...updated[listingIndex],
                images: [...updated[listingIndex].images, ...newImages],
                imageFiles: [...updated[listingIndex].imageFiles, ...newFiles],
              };
              return updated;
            });
          }
        };
        reader.readAsDataURL(file);
      });

      // Reset input
      if (listingImageInputRefs.current[listingIndex]) {
        listingImageInputRefs.current[listingIndex]!.value = "";
      }
    },
    [listings, onError],
  );

  const removeListingImage = useCallback((listingIndex: number, imageIndex: number) => {
    setListings((prev) => {
      const updated = [...prev];
      const listing = updated[listingIndex];
      if (!listing) return prev;
      updated[listingIndex] = removeListingImageAt(listing, imageIndex);
      return updated;
    });
  }, []);

  // Country input handler
  const handleCountryInputChange = useCallback((index: number, value: string) => {
    setCountryInputs((prev) => ({ ...prev, [index]: value }));
  }, []);

  // Validation
  const validateForm = useCallback(
    (options: {
      validateProfile: boolean;
      requireLocalityConsent: boolean;
      validateOffers: boolean;
      profileFieldName?: string;
    }): boolean => {
      const profileFieldName = options.profileFieldName ?? "Creator-facing introduction";
      if (options.validateProfile && !form.about.trim()) {
        onError?.(`${profileFieldName} is required.`);
        return false;
      }

      if (options.validateProfile && form.about.trim().length < 50) {
        onError?.(`${profileFieldName} must be at least 50 characters.`);
        return false;
      }

      if (options.requireLocalityConsent && !form.localityPublic) {
        onError?.("Consent to show your city and country on public vayada surfaces is required.");
        return false;
      }

      if (options.validateOffers && listings.length === 0) {
        onError?.("At least one collaboration offer is required. Please add an offer.");
        return false;
      }

      // Validate each listing
      for (let i = 0; options.validateOffers && i < listings.length; i++) {
        const listing = listings[i];
        if (!listing.name.trim()) {
          onError?.(`Offer ${i + 1}: Offer title is required`);
          return false;
        }
        if (!listing.description.trim()) {
          onError?.(`Offer ${i + 1}: Offer description is required`);
          return false;
        }
        if (listing.description.trim().length < 10) {
          onError?.(`Offer ${i + 1}: Offer description must be at least 10 characters`);
          return false;
        }
        if (listing.images.length === 0 && listing.imageFiles.length === 0) {
          onError?.(`Offer ${i + 1}: At least one offer photo is required`);
          return false;
        }
        if (listing.collaborationTypes.length === 0) {
          onError?.(`Offer ${i + 1}: At least one collaboration type is required`);
          return false;
        }
        if (listing.availability.length === 0) {
          onError?.(`Offer ${i + 1}: At least one availability month is required`);
          return false;
        }
        if (listing.platforms.length === 0) {
          onError?.(`Offer ${i + 1}: At least one platform is required`);
          return false;
        }
        if (listing.lookingForPlatforms.length === 0) {
          onError?.(`Offer ${i + 1}: At least one platform in "Looking For" is required`);
          return false;
        }
        if (listing.collaborationTypes.includes("Free Stay")) {
          if (!listing.freeStayMinNights || listing.freeStayMinNights <= 0) {
            onError?.(`Offer ${i + 1}: Free Stay requires minimum nights greater than 0`);
            return false;
          }
          if (!listing.freeStayMaxNights || listing.freeStayMaxNights < listing.freeStayMinNights) {
            onError?.(`Offer ${i + 1}: Free Stay max nights must be greater than min nights`);
            return false;
          }
        }
        if (listing.collaborationTypes.includes("Paid")) {
          if (!listing.paidMaxAmount || listing.paidMaxAmount <= 0) {
            onError?.(`Offer ${i + 1}: Paid collaboration requires max amount greater than 0`);
            return false;
          }
        }
        if (listing.collaborationTypes.includes("Discount")) {
          if (
            !listing.discountPercentage ||
            listing.discountPercentage <= 0 ||
            listing.discountPercentage > 100
          ) {
            onError?.(`Offer ${i + 1}: Discount percentage must be between 1 and 100`);
            return false;
          }
        }
        if (listing.collaborationTypes.includes("Affiliate")) {
          if (
            !listing.commissionPercentage ||
            listing.commissionPercentage <= 0 ||
            listing.commissionPercentage > 100
          ) {
            onError?.(`Offer ${i + 1}: Affiliate commission must be between 1 and 100`);
            return false;
          }
        }
      }

      return true;
    },
    [form, listings, onError],
  );

  // Can proceed to next step
  const canProceedStep1 = useCallback(
    (requireLocalityConsent = true): boolean => {
      return form.about.trim().length >= 50 && (!requireLocalityConsent || form.localityPublic);
    },
    [form.about, form.localityPublic],
  );

  const canProceedListingStep = useCallback(
    (step: "details" | "offerings" | "requirements"): boolean => {
      if (listings.length === 0) return false;
      return listings.every((listing) => {
        if (step === "details") {
          return Boolean(
            listing.name.trim() &&
            listing.description.trim().length >= 10 &&
            (listing.images.length > 0 || listing.imageFiles.length > 0),
          );
        }

        if (step === "requirements") {
          return listing.lookingForPlatforms.length > 0;
        }

        return Boolean(
          listing.collaborationTypes.length > 0 &&
          listing.availability.length > 0 &&
          listing.platforms.length > 0 &&
          (!listing.collaborationTypes.includes("Free Stay") ||
            (listing.freeStayMinNights &&
              listing.freeStayMinNights > 0 &&
              listing.freeStayMaxNights &&
              listing.freeStayMaxNights >= listing.freeStayMinNights)) &&
          (!listing.collaborationTypes.includes("Paid") ||
            (listing.paidMaxAmount && listing.paidMaxAmount > 0)) &&
          (!listing.collaborationTypes.includes("Discount") ||
            (listing.discountPercentage &&
              listing.discountPercentage > 0 &&
              listing.discountPercentage <= 100)) &&
          (!listing.collaborationTypes.includes("Affiliate") ||
            (listing.commissionPercentage &&
              listing.commissionPercentage > 0 &&
              listing.commissionPercentage <= 100)),
        );
      });
    },
    [listings],
  );

  return {
    // State
    form,
    listings,
    collapsedCards,
    countryInputs,
    countries: COUNTRIES,
    listingImageInputRefs,

    // Form handlers
    handleFormChange,

    // Listing handlers
    toggleListingCollapse,
    expandAllListings,
    updateListing,

    // Image handlers
    handleListingImageChange,
    removeListingImage,

    // Country input handler
    handleCountryInputChange,

    // Validation
    validateForm,
    canProceedStep1,
    canProceedListingStep,

    // State setters for external control
    setForm,
    setListings,
  };
}
