"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { HotelBadgeIcon } from "@/components/ui";
import { ROUTES } from "@/lib/constants/routes";
import { STORAGE_KEYS } from "@/lib/constants";
import { checkProfileStatus, isProfileComplete } from "@/lib/utils";
import type { UserType, CreatorProfileStatus, HotelProfileStatus, Creator } from "@/lib/types";
import { creatorService } from "@/services/api/creators";
import { hotelService } from "@/services/api/hotels";
import { ApiErrorResponse } from "@/services/api/client";
import { UserIcon, ArrowLeftIcon } from "@heroicons/react/24/outline";
import { useCreatorProfileForm } from "@/hooks/useCreatorProfileForm";
import { useHotelProfileForm } from "@/hooks/useHotelProfileForm";
import { formatErrorDetail } from "@/hooks/useErrorModal";
import { marketplaceSetupRedirectPath } from "@/lib/utils/sharedSetupGuard";
import {
  LoadingScreen,
  ProfileCompletionScreen,
  ProfileCompletionProgress,
  StepIndicators,
  CreatorProfileForm,
  HotelProfileForm,
} from "@/components/profile-complete";

export default function ProfileCompletePage() {
  const router = useRouter();
  const [userType, setUserType] = useState<UserType | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [profileStatus, setProfileStatus] = useState<
    CreatorProfileStatus | HotelProfileStatus | null
  >(null);
  const [profileStatusLoadFailed, setProfileStatusLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [profileCompleted, setProfileCompleted] = useState(false);
  const [currentStep, setCurrentStep] = useState<number>(1);

  const creatorSteps = ["Creator Type", "Basic Information", "Social Media Platforms"];
  const hotelSteps = ["Basic Information", "Property Listings"];

  // Initialize hooks with error handler
  const creatorForm = useCreatorProfileForm({ onError: setError });
  const hotelForm = useHotelProfileForm({ onError: setError });

  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
      setUserType(storedUserType);

      if (storedUserType === "hotel") {
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
        router.replace(marketplaceSetupRedirectPath(ROUTES.MARKETPLACE));
        return;
      }

      if (storedUserType === "admin") {
        router.replace(ROUTES.MARKETPLACE);
        return;
      }

      const userName = localStorage.getItem(STORAGE_KEYS.USER_NAME) || "";

      if (storedUserType === "creator") {
        creatorForm.setForm((prev) => ({ ...prev, name: userName }));
      }

      if (storedUserType) {
        void loadProfileStatus(storedUserType, true);
      } else {
        router.push(ROUTES.LOGIN);
      }
    }
  }, [router]);

  const loadProfileStatus = async (
    type: "creator" | "hotel",
    skipRedirect = false,
  ): Promise<CreatorProfileStatus | HotelProfileStatus | null> => {
    setLoading(true);
    setProfileStatusLoadFailed(false);
    try {
      const status = await checkProfileStatus(type);
      setProfileStatus(status);
      if (status?.profile_complete && !skipRedirect && !profileCompleted) {
        setProfileCompleted(true);
      }
      return status;
    } catch (err) {
      console.error("Failed to load profile status:", err);
      setProfileStatusLoadFailed(true);
      setError(
        err instanceof ApiErrorResponse
          ? formatErrorDetail(err.data.detail) || "Failed to load profile status."
          : "Failed to load profile status. Please try again.",
      );
      return null;
    } finally {
      setLoading(false);
    }
  };

  const nextStep = () => {
    const steps = userType === "creator" ? creatorSteps : hotelSteps;
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1);
      setError("");
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
      setError("");
    }
  };

  const canProceedToNextStep = (): boolean => {
    if (userType === "creator") {
      if (currentStep === 1) return creatorForm.canProceedCreatorType();
      if (currentStep === 2) return creatorForm.canProceedStep1();
      return true;
    }
    if (userType === "hotel") {
      return currentStep === 1 ? hotelForm.canProceedStep1() : true;
    }
    return false;
  };

  const handleCreatorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!creatorForm.validateForm()) return;

    setSubmitting(true);
    try {
      const platforms = creatorForm.platforms.map((p) => {
        const validAgeGroups =
          p.top_age_groups
            ?.filter((tag) => tag.ageRange?.trim())
            .map((tag) => ({ ageRange: tag.ageRange.trim(), percentage: tag.percentage })) || [];

        return {
          name: p.name,
          handle: p.handle,
          followers: Number(p.followers),
          engagementRate: Number(p.engagement_rate),
          ...(p.top_countries?.length && {
            topCountries: p.top_countries.map((tc) => ({
              country: tc.country,
              percentage: tc.percentage,
            })),
          }),
          ...(validAgeGroups.length && { topAgeGroups: validAgeGroups }),
          ...(p.gender_split &&
            (p.gender_split.male > 0 || p.gender_split.female > 0) && {
              genderSplit: { male: p.gender_split.male, female: p.gender_split.female },
            }),
        };
      });

      const audienceSize = platforms.reduce((sum, p) => sum + p.followers, 0);

      let profilePictureUrl: string | undefined;
      let profilePictureMediaObjectId: string | undefined;
      if (creatorForm.profilePictureFile) {
        try {
          const currentProfile = await creatorService.getMyProfile();
          const uploadResponse = await creatorService.uploadProfilePicture(
            creatorForm.profilePictureFile,
            currentProfile.id,
          );
          profilePictureUrl = uploadResponse.url;
          profilePictureMediaObjectId = uploadResponse.mediaObjectId;
        } catch (err) {
          if (err instanceof ApiErrorResponse) {
            setError(formatErrorDetail(err.data.detail) || "Failed to upload profile picture");
          } else {
            setError("Failed to upload profile picture. Please try again.");
          }
          setSubmitting(false);
          return;
        }
      }

      const updatePayload = {
        name: creatorForm.form.name,
        location: creatorForm.form.location,
        platforms,
        audienceSize,
        creatorType: creatorForm.form.creator_type,
        ...(creatorForm.form.portfolio_link?.trim() && {
          portfolioLink: creatorForm.form.portfolio_link.trim(),
        }),
        ...(creatorForm.form.short_description?.trim() && {
          shortDescription: creatorForm.form.short_description.trim(),
        }),
        ...(creatorForm.form.phone?.trim() && { phone: creatorForm.form.phone.trim() }),
        ...(profilePictureUrl && { profilePicture: profilePictureUrl }),
        ...(profilePictureMediaObjectId && {
          profilePictureMediaObjectId,
          profile_picture_media_object_id: profilePictureMediaObjectId,
        }),
      };

      const updatedProfile = await creatorService.updateMyProfile(updatePayload);
      const responseWithSnakeCase = updatedProfile as Creator & { profile_picture?: string | null };
      const pictureUrl = updatedProfile.profilePicture || responseWithSnakeCase.profile_picture;
      if (pictureUrl?.trim()) {
        creatorForm.setForm((prev) => ({ ...prev, profile_image: pictureUrl }));
      }

      const complete = await isProfileComplete("creator");
      if (complete) {
        setProfileCompleted(true);
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "true");
      } else {
        const updatedStatus = await loadProfileStatus("creator", true);
        handleIncompleteProfile(updatedStatus as CreatorProfileStatus);
      }
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        setError(formatErrorDetail(err.data.detail) || "Failed to update profile");
      } else {
        setError("Failed to update profile. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleHotelSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!hotelForm.validateForm()) return;

    setSubmitting(true);
    try {
      const userEmail = localStorage.getItem(STORAGE_KEYS.USER_EMAIL);
      if (!userEmail) {
        setError("Email is required. Please log in again.");
        setSubmitting(false);
        return;
      }

      let profilePictureUrl: string | undefined;
      let profilePictureMediaObjectId: string | undefined;
      if (hotelForm.profilePictureFile) {
        try {
          const currentProfile = await hotelService.getMyProfile();
          const uploadResponse = await hotelService.uploadProfileImage(
            hotelForm.profilePictureFile,
            currentProfile.id,
          );
          profilePictureUrl = uploadResponse.url;
          profilePictureMediaObjectId = uploadResponse.mediaObjectId;
        } catch (err) {
          if (err instanceof ApiErrorResponse) {
            setError(formatErrorDetail(err.data.detail) || "Failed to upload profile picture");
          } else {
            setError("Failed to upload profile picture. Please try again.");
          }
          setSubmitting(false);
          return;
        }
      }

      const updatePayload = {
        name: hotelForm.form.name.trim(),
        location: hotelForm.form.location.trim(),
        about: hotelForm.form.about.trim(),
        website: hotelForm.form.website.trim(),
        phone: hotelForm.form.phone.trim(),
        email: userEmail,
        ...(profilePictureUrl && { picture: profilePictureUrl }),
        ...(profilePictureMediaObjectId && {
          pictureMediaObjectId: profilePictureMediaObjectId,
          picture_media_object_id: profilePictureMediaObjectId,
        }),
      };

      const updatedProfile = await hotelService.updateMyProfile(updatePayload);
      if (updatedProfile?.picture) {
        hotelForm.setForm((prev) => ({ ...prev, picture: updatedProfile.picture || "" }));
      }

      // Create listings
      for (const listing of hotelForm.listings) {
        const offerings = buildListingOfferings(listing);
        let imageUrls = listing.images.filter((img) => !img.startsWith("data:"));
        let imageMediaObjectIds = listing.imageMediaObjectIds ?? [];

        if (imageUrls.length === 0 && !listing.imageFiles?.length) {
          setError(`Listing "${listing.name}": At least one image is required`);
          setSubmitting(false);
          return;
        }

        const createdListing = await hotelService.createListing({
          name: listing.name,
          location: listing.location,
          description: listing.description,
          accommodation_type: listing.accommodation_type || undefined,
          images: imageUrls,
          image_media_object_ids: imageMediaObjectIds,
          collaboration_offerings: offerings,
          creator_requirements: buildCreatorRequirements(listing),
        });

        if (listing.imageFiles?.length) {
          try {
            const uploadResponse = await hotelService.uploadListingImages(
              listing.imageFiles,
              createdListing.id,
            );
            imageUrls = [...imageUrls, ...uploadResponse.images.map((img) => img.url)];
            imageMediaObjectIds = [
              ...imageMediaObjectIds,
              ...uploadResponse.images.map((img) => img.mediaObjectId),
            ];

            await hotelService.updateListing(createdListing.id, {
              images: imageUrls,
              image_media_object_ids: imageMediaObjectIds,
            });
          } catch (err) {
            await hotelService.deleteListing(createdListing.id).catch((deleteError) => {
              console.error("Failed to clean up listing after media upload failure:", deleteError);
            });
            if (err instanceof ApiErrorResponse) {
              setError(
                formatErrorDetail(err.data.detail) ||
                  `Failed to upload images for listing "${listing.name}"`,
              );
            } else {
              setError(`Failed to upload images for listing "${listing.name}". Please try again.`);
            }
            setSubmitting(false);
            return;
          }
        }
      }

      const complete = await isProfileComplete("hotel");
      if (complete) {
        setProfileCompleted(true);
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "true");
      } else {
        const updatedStatus = await loadProfileStatus("hotel", true);
        handleIncompleteProfile(updatedStatus as HotelProfileStatus);
      }
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        setError(formatErrorDetail(err.data.detail) || "Failed to update profile");
      } else {
        setError("Failed to update profile. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleIncompleteProfile = (status: CreatorProfileStatus | HotelProfileStatus | null) => {
    if (!status || status.profile_complete) {
      setError(
        "Profile updated, but some fields may still be missing. Please check the requirements.",
      );
      return;
    }
    const { missing_fields = [], completion_steps = [] } = status;
    let errorMessage =
      "Profile updated successfully, but some required information is still missing:\n\n";
    if (completion_steps.length > 0) {
      errorMessage += completion_steps
        .slice(0, 5)
        .map((step, idx) => `${idx + 1}. ${step}`)
        .join("\n");
      if (completion_steps.length > 5) {
        errorMessage += `\n...and ${completion_steps.length - 5} more requirement${completion_steps.length - 5 > 1 ? "s" : ""}`;
      }
    } else if (missing_fields.length > 0) {
      errorMessage += "Missing fields: " + missing_fields.join(", ");
    } else {
      errorMessage += "Please review all sections and ensure all required fields are completed.";
    }
    setError(errorMessage);
  };

  const buildListingOfferings = (listing: (typeof hotelForm.listings)[0]) => {
    const offerings: Array<{
      collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate";
      availability_months: string[];
      platforms: string[];
      free_stay_min_nights?: number;
      free_stay_max_nights?: number;
      paid_max_amount?: number;
      currency?: string;
      discount_percentage?: number;
      commission_percentage?: number;
    }> = [];

    if (listing.collaborationTypes.includes("Free Stay")) {
      offerings.push({
        collaboration_type: "Free Stay",
        availability_months: listing.availability,
        platforms: listing.platforms,
        free_stay_min_nights: listing.freeStayMinNights,
        free_stay_max_nights: listing.freeStayMaxNights,
      });
    }
    if (listing.collaborationTypes.includes("Paid")) {
      offerings.push({
        collaboration_type: "Paid",
        availability_months: listing.availability,
        platforms: listing.platforms,
        paid_max_amount: listing.paidMaxAmount,
        currency: listing.currency || "USD",
      });
    }
    if (listing.collaborationTypes.includes("Discount")) {
      offerings.push({
        collaboration_type: "Discount",
        availability_months: listing.availability,
        platforms: listing.platforms,
        discount_percentage: listing.discountPercentage,
      });
    }
    if (listing.collaborationTypes.includes("Affiliate")) {
      offerings.push({
        collaboration_type: "Affiliate",
        availability_months: listing.availability,
        platforms: listing.platforms,
        commission_percentage: listing.commissionPercentage,
      });
    }
    return offerings;
  };

  const buildCreatorRequirements = (listing: (typeof hotelForm.listings)[0]) => {
    const ageGroups = listing.targetGroupAgeGroups || [];
    let targetAgeMin: number | undefined;
    let targetAgeMax: number | undefined;

    if (ageGroups.length > 0) {
      let min = Infinity,
        max = -Infinity,
        has55Plus = false;
      ageGroups.forEach((g) => {
        if (g === "18-24") {
          min = Math.min(min, 18);
          max = Math.max(max, 24);
        } else if (g === "25-34") {
          min = Math.min(min, 25);
          max = Math.max(max, 34);
        } else if (g === "35-44") {
          min = Math.min(min, 35);
          max = Math.max(max, 44);
        } else if (g === "45-54") {
          min = Math.min(min, 45);
          max = Math.max(max, 54);
        } else if (g === "55+") {
          min = Math.min(min, 55);
          has55Plus = true;
        }
      });
      targetAgeMin = min === Infinity ? undefined : min;
      targetAgeMax = has55Plus ? undefined : max === -Infinity ? undefined : max;
    } else {
      targetAgeMin = listing.targetGroupAgeMin;
      targetAgeMax = listing.targetGroupAgeMax;
    }

    return {
      platforms: listing.lookingForPlatforms,
      target_countries: listing.targetGroupCountries,
      target_age_min: targetAgeMin,
      target_age_max: targetAgeMax,
    };
  };

  if (loading) return <LoadingScreen />;
  if (!userType) return null;
  if (userType !== "creator" && userType !== "hotel") return null;
  if (profileStatusLoadFailed) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6 lg:px-8">
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error || "Failed to load profile status. Please refresh the page."}
          </div>
        </div>
      </div>
    );
  }
  const effectiveProfileStatus = profileStatus ?? emptyProfileStatus(userType);

  if (profileCompleted || effectiveProfileStatus.profile_complete) {
    return (
      <ProfileCompletionScreen
        userType={userType}
        onGoHome={() => router.push(ROUTES.HOME)}
        onEditProfile={() => router.push(ROUTES.PROFILE)}
      />
    );
  }

  const steps = userType === "creator" ? creatorSteps : hotelSteps;
  const totalSteps = steps.length;
  const completionPercentage = effectiveProfileStatus.profile_complete
    ? 100
    : userType === "creator"
      ? creatorForm.calculateProgress()
      : hotelForm.calculateProgress();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-4 py-3">
        <div className="relative mx-auto flex max-w-5xl items-center justify-center">
          <Link
            href="/"
            className="absolute left-0 -ml-2 rounded-md p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            title="Back to Home"
          >
            <ArrowLeftIcon className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2">
            <Image
              src="/vayada-logo.png"
              alt="vayada"
              width={120}
              height={48}
              className="h-10 w-auto"
            />
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 py-5 sm:px-6 lg:px-8">
        <ProfileCompletionProgress percentage={completionPercentage} />

        {/* Header Card with Steps */}
        <div className="mb-4 flex flex-col items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:flex-row">
          <div className="flex items-center gap-3 text-center md:text-left">
            {userType === "creator" ? (
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-primary-600 shadow-sm">
                <UserIcon className="w-5 h-5 text-white" />
              </div>
            ) : (
              <HotelBadgeIcon active />
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Marketplace setup
              </p>
              <h1 className="text-lg font-semibold leading-tight text-gray-950">
                Complete Your Profile
              </h1>
              <p className="text-xs text-gray-500 max-w-xs">
                {userType === "creator"
                  ? "Add info to connect with hotels"
                  : "Update info to collaborate"}
              </p>
            </div>
          </div>
          <StepIndicators steps={steps} currentStep={currentStep} />
        </div>

        {/* Forms */}
        {userType === "creator" && (
          <CreatorProfileForm
            form={creatorForm.form}
            platforms={creatorForm.platforms}
            currentStep={currentStep}
            totalSteps={totalSteps}
            error={error}
            submitting={submitting}
            canProceed={canProceedToNextStep()}
            expandedPlatforms={creatorForm.expandedPlatforms}
            platformCountryInputs={creatorForm.platformCountryInputs}
            imageInputRef={creatorForm.imageInputRef}
            onFormChange={creatorForm.handleFormChange}
            onImageChange={creatorForm.handleImageChange}
            onAddPlatform={creatorForm.addPlatform}
            onRemovePlatform={creatorForm.removePlatform}
            onUpdatePlatform={creatorForm.updatePlatform}
            onTogglePlatformExpanded={creatorForm.togglePlatformExpanded}
            onCountryInputChange={creatorForm.handleCountryInputChange}
            onAddCountry={creatorForm.addCountryFromInput}
            onRemoveCountry={creatorForm.removeCountry}
            onUpdateCountryPercentage={creatorForm.updateCountryPercentage}
            getAvailableCountries={creatorForm.getAvailableCountries}
            onToggleAgeGroup={creatorForm.toggleAgeGroup}
            onUpdateGenderSplit={creatorForm.updateGenderSplit}
            onPrevStep={prevStep}
            onNextStep={nextStep}
            onSubmit={handleCreatorSubmit}
          />
        )}

        {userType === "hotel" && (
          <HotelProfileForm
            form={hotelForm.form}
            listings={hotelForm.listings}
            currentStep={currentStep}
            totalSteps={totalSteps}
            error={error}
            submitting={submitting}
            canProceed={canProceedToNextStep()}
            collapsedCards={hotelForm.collapsedCards}
            countryInputs={hotelForm.countryInputs}
            countries={hotelForm.countries}
            imageInputRefs={hotelForm.listingImageInputRefs}
            onFormChange={hotelForm.handleFormChange}
            onAddListing={hotelForm.addListing}
            onRemoveListing={hotelForm.removeListing}
            onToggleCollapse={hotelForm.toggleListingCollapse}
            onUpdateListing={hotelForm.updateListing}
            onImageChange={hotelForm.handleListingImageChange}
            onRemoveImage={hotelForm.removeListingImage}
            onCountryInputChange={hotelForm.handleCountryInputChange}
            onPrevStep={prevStep}
            onNextStep={nextStep}
            onSubmit={handleHotelSubmit}
          />
        )}
      </div>
    </div>
  );
}

function emptyProfileStatus(
  userType: "creator" | "hotel",
): CreatorProfileStatus | HotelProfileStatus {
  if (userType === "creator") {
    return {
      profile_complete: false,
      missing_fields: [],
      missing_platforms: true,
      completion_steps: [],
    };
  }
  return {
    profile_complete: false,
    missing_fields: [],
    has_defaults: { location: false },
    missing_listings: true,
    completion_steps: [],
  };
}
