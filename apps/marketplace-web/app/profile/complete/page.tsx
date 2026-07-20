"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon } from "@heroicons/react/24/outline";
import { splitSharedAccountName } from "@vayada/product-onboarding";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { ROUTES } from "@/lib/constants/routes";
import { STORAGE_KEYS } from "@/lib/constants";
import { checkProfileStatus, isProfileComplete } from "@/lib/utils";
import type {
  UserType,
  CreatorProfileStatus,
  HotelProfileStatus,
  HotelProfile,
  ListingFormData,
  Creator,
  PlatformFormData,
} from "@/lib/types";
import { creatorService } from "@/services/api/creators";
import { hotelService } from "@/services/api/hotels";
import { ApiErrorResponse } from "@/services/api/client";
import { sharedAccountProfileImageUploader } from "@/services/api/sharedHotelSetupClient";
import { authService } from "@/services/auth";
import { useCreatorProfileForm } from "@/hooks/useCreatorProfileForm";
import { useHotelProfileForm } from "@/hooks/useHotelProfileForm";
import { formatErrorDetail } from "@/hooks/useErrorModal";
import {
  isMarketplaceActivationDecision,
  marketplaceSetupRedirectPath,
  resolveMarketplaceActivationGuard,
  SELECTED_SHARED_PROPERTY_ID_KEY,
} from "@/lib/utils/sharedSetupGuard";
import {
  LoadingScreen,
  ProfileCompletionScreen,
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
  const [hasExistingMarketplaceOffer, setHasExistingMarketplaceOffer] = useState(false);
  const marketplacePropertyIdRef = useRef<string | null>(null);
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [creatorPhotoPersisted, setCreatorPhotoPersisted] = useState(false);
  const [creatorPhotoMediaObjectId, setCreatorPhotoMediaObjectId] = useState<string | null>(null);
  const [uploadedCreatorPhoto, setUploadedCreatorPhoto] = useState<{
    file: File;
    url: string;
    mediaObjectId: string;
    identitySynced: boolean;
  } | null>(null);
  const [initialCreatorPlatformsSignature, setInitialCreatorPlatformsSignature] = useState("[]");
  const creatorPhotoRequired =
    (profileStatus as CreatorProfileStatus | null)?.profile_photo_required ?? false;

  const creatorSteps = ["Creator category", "About your work", "Audience & platforms"];
  const hotelSteps = hasExistingMarketplaceOffer
    ? ["Introduce your hotel"]
    : [
        "Introduce your hotel",
        "Describe your offer",
        "What are you offering?",
        "Who are you looking for?",
      ];

  // Initialize hooks with error handler
  const creatorForm = useCreatorProfileForm({
    onError: setError,
    profileImageRequired: creatorPhotoRequired,
  });
  const hotelForm = useHotelProfileForm({ onError: setError });

  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
      setUserType(storedUserType);

      if (storedUserType === "hotel") {
        localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
        const activationParams = new URLSearchParams(window.location.search);
        const isMarketplaceActivation = activationParams.get("activation") === "marketplace";
        const requestedPropertyId = activationParams.get("propertyId")?.trim() || null;
        if (!isMarketplaceActivation || !requestedPropertyId) {
          router.replace(marketplaceSetupRedirectPath(ROUTES.MARKETPLACE));
          return;
        }

        const hydrationController = new AbortController();
        const hydrationTimeout = window.setTimeout(() => hydrationController.abort(), 5_000);
        let cancelled = false;
        let navigatingAway = false;
        setLoading(true);
        void (async () => {
          try {
            const decision = await resolveMarketplaceActivationGuard(
              ROUTES.MARKETPLACE,
              requestedPropertyId,
              { signal: hydrationController.signal },
            );
            if (cancelled) return;

            if (decision.propertyId !== requestedPropertyId) {
              navigatingAway = true;
              router.replace(marketplaceSetupRedirectPath(ROUTES.MARKETPLACE));
              return;
            }
            if (decision.action === "enter_product") {
              localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, requestedPropertyId);
              navigatingAway = true;
              router.replace(ROUTES.MARKETPLACE);
              return;
            }
            if (!isMarketplaceActivationDecision(decision)) {
              navigatingAway = true;
              router.replace(decision.redirectPath);
              return;
            }

            marketplacePropertyIdRef.current = requestedPropertyId;
            localStorage.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, requestedPropertyId);
            const profile = await hotelService.getMyProfile(requestedPropertyId, {
              signal: hydrationController.signal,
            });
            if (cancelled) return;

            hydrateHotelMarketplaceProfile(
              profile,
              !decision.missingSteps.some((step) => MARKETPLACE_OFFER_SETUP_STEPS.has(step)),
            );
          } catch {
            if (cancelled) return;
            setProfileStatusLoadFailed(true);
            setError(
              hydrationController.signal.aborted
                ? "Loading Marketplace setup took too long. Please refresh and try again."
                : "Failed to load Marketplace setup. Please refresh and try again.",
            );
          }
        })().finally(() => {
          window.clearTimeout(hydrationTimeout);
          if (!cancelled && !navigatingAway) setLoading(false);
        });
        return () => {
          cancelled = true;
          window.clearTimeout(hydrationTimeout);
          hydrationController.abort();
        };
      }

      if (storedUserType === "admin") {
        router.replace(ROUTES.MARKETPLACE);
        return;
      }

      const userName = localStorage.getItem(STORAGE_KEYS.USER_NAME) || "";

      if (storedUserType === "creator") {
        creatorForm.setForm((prev) => ({ ...prev, name: userName }));
        const hydrationController = new AbortController();
        const hydrationTimeout = window.setTimeout(() => hydrationController.abort(), 5_000);
        let cancelled = false;
        setLoading(true);
        void Promise.allSettled([
          hydrateCreatorProfile(userName, hydrationController.signal),
          loadProfileStatus("creator", true, false, hydrationController.signal),
        ])
          .then(([hydrationResult, statusResult]) => {
            if (cancelled) return;
            if (hydrationResult.status === "rejected") {
              setProfileStatusLoadFailed(true);
              setError(
                hydrationController.signal.aborted
                  ? "Loading your creator profile took too long. Please refresh and try again."
                  : "Failed to load your creator profile. Please refresh and try again.",
              );
              return;
            }
            if (statusResult.status === "rejected") {
              setProfileStatusLoadFailed(true);
              setError(
                hydrationController.signal.aborted
                  ? "Loading your creator profile took too long. Please refresh and try again."
                  : "Failed to load profile status. Please try again.",
              );
              return;
            }
            const creatorStatus = statusResult.value as CreatorProfileStatus | null;
            if (
              creatorStatus?.profile_photo_required &&
              !hydrationResult.value.effectiveProfilePictureMediaObjectId
            ) {
              creatorForm.setForm((prev) => ({ ...prev, profile_image: "" }));
            }
            if (
              creatorStatus?.profile_complete &&
              creatorStatus.profile_photo_required &&
              !hydrationResult.value.creatorPhotoPersisted
            ) {
              setCurrentStep(2);
            }
          })
          .finally(() => {
            window.clearTimeout(hydrationTimeout);
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
          window.clearTimeout(hydrationTimeout);
          hydrationController.abort();
        };
      }

      if (storedUserType) {
        void loadProfileStatus(storedUserType, true);
      } else {
        router.push(ROUTES.LOGIN);
      }
    }
  }, [router]);

  const hydrateCreatorProfile = async (fallbackName: string, signal: AbortSignal) => {
    const profile = await creatorService.getMyProfile({ signal });
    const account = authService.getSessionUser();
    const creatorProfilePicture = profile.profilePicture?.trim() || "";
    const creatorProfilePictureMediaObjectId = profile.profilePictureMediaObjectId?.trim() || "";
    const creatorPhotoPersisted = Boolean(
      creatorProfilePicture && creatorProfilePictureMediaObjectId,
    );
    const sharedProfilePicture = account?.profilePictureUrl?.trim() || "";
    const sharedProfilePictureMediaObjectId = account?.profilePictureMediaObjectId?.trim() || "";
    const sharedPhotoComplete = Boolean(sharedProfilePicture && sharedProfilePictureMediaObjectId);
    const effectiveProfilePicture = creatorPhotoPersisted
      ? creatorProfilePicture
      : sharedPhotoComplete
        ? sharedProfilePicture
        : creatorProfilePicture;
    const effectiveProfilePictureMediaObjectId = creatorPhotoPersisted
      ? creatorProfilePictureMediaObjectId
      : sharedPhotoComplete
        ? sharedProfilePictureMediaObjectId
        : creatorProfilePictureMediaObjectId;
    const hasStartedCreatorProfile = Boolean(
      profile.location.trim() ||
      profile.shortDescription?.trim() ||
      profile.portfolioLink?.trim() ||
      profile.platforms.length,
    );
    creatorForm.setForm((prev) => ({
      ...prev,
      name: profile.name.trim() || fallbackName || prev.name,
      location: profile.location.trim() || prev.location,
      short_description: profile.shortDescription?.trim() || prev.short_description,
      portfolio_link: profile.portfolioLink?.trim() || prev.portfolio_link,
      phone: profile.phone?.trim() || account?.phone?.trim() || prev.phone,
      profile_image: effectiveProfilePicture || prev.profile_image,
      creator_type: hasStartedCreatorProfile ? profile.creatorType : prev.creator_type,
    }));
    const hydratedPlatforms = profile.platforms.map((platform) => ({
      id: platform.id,
      name: platform.name,
      handle: platform.handle,
      followers: platform.followers,
      engagement_rate: platform.engagementRate,
      top_countries: platform.topCountries,
      top_age_groups: platform.topAgeGroups,
      gender_split: platform.genderSplit,
    }));
    creatorForm.setPlatforms(hydratedPlatforms);
    setInitialCreatorPlatformsSignature(
      JSON.stringify(hydratedPlatforms.map(toCreatorPlatformUpdate)),
    );
    setCreatorPhotoPersisted(creatorPhotoPersisted);
    setCreatorPhotoMediaObjectId(effectiveProfilePictureMediaObjectId || null);
    return {
      ...profile,
      creatorPhotoPersisted,
      effectiveProfilePictureMediaObjectId,
    };
  };

  const hydrateHotelMarketplaceProfile = (
    profile: HotelProfile,
    canReuseExistingOffer: boolean,
  ) => {
    const hasExistingOffer = profile.listings.some(
      (listing) =>
        canReuseExistingOffer && (listing.status === "pending" || listing.status === "verified"),
    );
    hotelForm.setForm({
      about: profile.about ?? "",
    });
    setHasExistingMarketplaceOffer(hasExistingOffer);
    hotelForm.setListings(hasExistingOffer ? [] : [newMarketplaceOffer(profile)]);
  };

  const loadProfileStatus = async (
    type: "creator" | "hotel",
    skipRedirect = false,
    manageLoading = true,
    signal?: AbortSignal,
  ): Promise<CreatorProfileStatus | HotelProfileStatus | null> => {
    if (manageLoading) setLoading(true);
    setProfileStatusLoadFailed(false);
    try {
      const status = await checkProfileStatus(type, { signal });
      setProfileStatus(status);
      if (status?.profile_complete && !skipRedirect && !profileCompleted) {
        setProfileCompleted(true);
      }
      return status;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.error("Failed to load profile status:", err);
      setProfileStatusLoadFailed(true);
      setError(
        err instanceof ApiErrorResponse
          ? formatErrorDetail(err.data.detail) || "Failed to load profile status."
          : "Failed to load profile status. Please try again.",
      );
      return null;
    } finally {
      if (manageLoading) setLoading(false);
    }
  };

  const nextStep = () => {
    const steps = userType === "creator" ? creatorSteps : hotelSteps;
    if (currentStep < steps.length) {
      if (userType === "hotel") hotelForm.expandAllListings();
      setCurrentStep(currentStep + 1);
      setError("");
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      if (userType === "hotel") hotelForm.expandAllListings();
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
      if (currentStep === 1) return hotelForm.canProceedStep1();
      if (currentStep === 2) return hotelForm.canProceedListingStep("details");
      if (currentStep === 3) return hotelForm.canProceedListingStep("offerings");
      return hotelForm.canProceedListingStep("requirements");
    }
    return false;
  };

  const handleCreatorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!creatorForm.validateForm()) return;

    setSubmitting(true);
    try {
      const platforms = creatorForm.platforms.map(toCreatorPlatformUpdate);
      const platformsChanged = JSON.stringify(platforms) !== initialCreatorPlatformsSignature;

      let profilePictureMediaObjectId = creatorPhotoPersisted
        ? undefined
        : (creatorPhotoMediaObjectId ?? undefined);
      if (creatorForm.profilePictureFile) {
        try {
          let uploaded =
            uploadedCreatorPhoto?.file === creatorForm.profilePictureFile
              ? uploadedCreatorPhoto
              : null;
          if (!uploaded) {
            const user = authService.getSessionUser();
            if (!user?.id) throw new Error("Your session has expired. Please sign in again.");
            const uploadResponse = await sharedAccountProfileImageUploader(
              user.id,
              creatorForm.profilePictureFile,
            );
            uploaded = {
              file: creatorForm.profilePictureFile,
              url: uploadResponse.profilePictureUrl,
              mediaObjectId: uploadResponse.profilePictureMediaObjectId,
              identitySynced: false,
            };
            setUploadedCreatorPhoto(uploaded);
          }
          if (!uploaded.identitySynced) {
            await authService.updateAccountDetails({
              profilePictureUrl: uploaded.url,
              profilePictureMediaObjectId: uploaded.mediaObjectId,
            });
            uploaded = { ...uploaded, identitySynced: true };
            setUploadedCreatorPhoto(uploaded);
          }
          profilePictureMediaObjectId = uploaded.mediaObjectId;
          setCreatorPhotoMediaObjectId(uploaded.mediaObjectId);
          creatorForm.setForm((prev) => ({ ...prev, profile_image: uploaded.url }));
        } catch (err) {
          if (err instanceof ApiErrorResponse) {
            setError(formatErrorDetail(err.data.detail) || "Failed to upload profile picture");
          } else {
            setError(
              err instanceof Error ? err.message : "Failed to upload profile picture. Try again.",
            );
          }
          setSubmitting(false);
          return;
        }
      }

      const updatePayload = {
        name: creatorForm.form.name,
        location: creatorForm.form.location,
        ...(platformsChanged && { platforms }),
        creatorType: creatorForm.form.creator_type,
        portfolioLink: creatorForm.form.portfolio_link.trim() || null,
        ...(creatorForm.form.short_description?.trim() && {
          shortDescription: creatorForm.form.short_description.trim(),
        }),
        ...(creatorForm.form.phone?.trim() && { phone: creatorForm.form.phone.trim() }),
        ...(profilePictureMediaObjectId && {
          profilePictureMediaObjectId,
          profile_picture_media_object_id: profilePictureMediaObjectId,
        }),
      };

      const updatedProfile = await creatorService.updateMyProfile(updatePayload);
      const responseWithSnakeCase = updatedProfile as Creator & { profile_picture?: string | null };
      const pictureUrl = updatedProfile.profilePicture || responseWithSnakeCase.profile_picture;
      const persistedPictureUrl = pictureUrl?.trim() || "";
      if (persistedPictureUrl && updatedProfile.profilePictureMediaObjectId?.trim()) {
        creatorForm.setForm((prev) => ({ ...prev, profile_image: persistedPictureUrl }));
        setCreatorPhotoMediaObjectId(updatedProfile.profilePictureMediaObjectId.trim());
        setCreatorPhotoPersisted(true);
      }
      if (platformsChanged) setInitialCreatorPlatformsSignature(JSON.stringify(platforms));

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
    if (!hotelForm.validateForm(hasExistingMarketplaceOffer)) return;
    const propertyId = marketplacePropertyIdRef.current;
    if (!propertyId) {
      setError("Marketplace setup is missing its hotel. Return to setup and try again.");
      return;
    }

    setSubmitting(true);
    try {
      await hotelService.updateMyProfile(
        {
          about: hotelForm.form.about.trim(),
        },
        propertyId,
      );

      // Create listings
      for (const listing of hotelForm.listings) {
        const offerings = buildListingOfferings(listing);
        let imageUrls = listing.images.filter((img) => !img.startsWith("data:"));
        let imageMediaObjectIds = listing.imageMediaObjectIds ?? [];

        if (imageUrls.length === 0 && !listing.imageFiles?.length) {
          setError(`Offer "${listing.name}": At least one image is required`);
          setSubmitting(false);
          return;
        }

        const createdListing = await hotelService.createListing(
          {
            name: listing.name,
            location: listing.location,
            description: listing.description,
            accommodation_type: listing.accommodation_type || undefined,
            images: imageUrls,
            image_media_object_ids: imageMediaObjectIds,
            deliverables: listing.platforms.map((platform) => ({
              platform,
              deliverable_type: "content",
              quantity: 1,
              timing_guidance: null,
            })),
            collaboration_offerings: offerings,
            creator_requirements: buildCreatorRequirements(listing),
          },
          propertyId,
        );

        if (listing.imageFiles?.length) {
          try {
            if (!createdListing.media_resource_id) {
              throw new Error("The listing media resource is unavailable");
            }
            const uploadResponse = await hotelService.uploadListingImages(
              listing.imageFiles,
              createdListing.media_resource_id,
            );
            imageUrls = [...imageUrls, ...uploadResponse.images.map((img) => img.url)];
            imageMediaObjectIds = [
              ...imageMediaObjectIds,
              ...uploadResponse.images.map((img) => img.mediaObjectId),
            ];

            await hotelService.updateListing(
              createdListing.id,
              {
                images: imageUrls,
                image_media_object_ids: imageMediaObjectIds,
              },
              propertyId,
            );
          } catch (err) {
            await hotelService.deleteListing(createdListing.id, propertyId).catch((deleteError) => {
              console.error("Failed to clean up offer after media upload failure:", deleteError);
            });
            if (err instanceof ApiErrorResponse) {
              setError(
                formatErrorDetail(err.data.detail) ||
                  `Failed to upload images for offer "${listing.name}"`,
              );
            } else {
              setError(`Failed to upload images for offer "${listing.name}". Please try again.`);
            }
            setSubmitting(false);
            return;
          }
        }
      }

      router.replace(marketplaceSetupRedirectPath(ROUTES.MARKETPLACE, propertyId));
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
      target_age_groups: ageGroups,
      creator_types: listing.lookingForCreatorTypes ?? [],
    };
  };

  if (loading) return <LoadingScreen />;
  if (!userType) return null;
  if (userType !== "creator" && userType !== "hotel") return null;
  if (profileStatusLoadFailed) {
    if (userType === "hotel") {
      return (
        <HotelMarketplaceSetupLayout steps={hotelSteps} currentStep={currentStep}>
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error || "Failed to load Marketplace setup. Please refresh the page."}
          </div>
        </HotelMarketplaceSetupLayout>
      );
    }

    return (
      <OnboardingShell
        currentStep={2}
        title={profileShellTitle(userType)}
        description={profileShellDescription(userType)}
        compact
        showProgress={false}
      >
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error || "Failed to load profile status. Please refresh the page."}
        </div>
      </OnboardingShell>
    );
  }
  const effectiveProfileStatus = profileStatus ?? emptyProfileStatus(userType);

  if (
    (profileCompleted || effectiveProfileStatus.profile_complete) &&
    (userType !== "creator" || !creatorPhotoRequired || creatorPhotoPersisted)
  ) {
    return (
      <ProfileCompletionScreen
        userType={userType}
        onGoHome={() => router.push(ROUTES.MARKETPLACE)}
        onEditProfile={() => router.push(ROUTES.PROFILE)}
      />
    );
  }

  const steps = userType === "creator" ? creatorSteps : hotelSteps;
  const totalSteps = steps.length;
  const isCreatorCategoryStep = userType === "creator" && currentStep === 1;
  const creatorFirstName = splitSharedAccountName(creatorForm.form.name).firstName;
  const creatorCategoryTitle = creatorFirstName
    ? `Hi, ${creatorFirstName}! What kind of creator are you?`
    : "Which creator type are you?";
  const creatorProfileTitle =
    currentStep === 2 ? "Tell hotels about your work" : "Show hotels your reach";
  const creatorProfileDescription =
    currentStep === 2
      ? "Your account details are already saved. Add what hotels need to understand your content."
      : "Add the audience and platform details hotels use to assess a collaboration.";

  if (userType === "hotel") {
    return (
      <HotelMarketplaceSetupLayout steps={hotelSteps} currentStep={currentStep}>
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
          onToggleCollapse={hotelForm.toggleListingCollapse}
          onUpdateListing={hotelForm.updateListing}
          onImageChange={hotelForm.handleListingImageChange}
          onRemoveImage={hotelForm.removeListingImage}
          onCountryInputChange={hotelForm.handleCountryInputChange}
          onPrevStep={prevStep}
          onNextStep={nextStep}
          onSubmit={handleHotelSubmit}
        />
      </HotelMarketplaceSetupLayout>
    );
  }

  return (
    <OnboardingShell
      currentStep={2}
      title={isCreatorCategoryStep ? creatorCategoryTitle : creatorProfileTitle}
      description={isCreatorCategoryStep ? "" : creatorProfileDescription}
      compact={!isCreatorCategoryStep}
      showProgress={false}
      wideContent={isCreatorCategoryStep}
    >
      <div className={isCreatorCategoryStep ? "mx-auto w-full xl:pt-5" : "space-y-2"}>
        {!isCreatorCategoryStep && <StepIndicators steps={steps} currentStep={currentStep} />}

        <div
          className={
            isCreatorCategoryStep
              ? ""
              : "overflow-hidden rounded-3xl border border-gray-100 bg-white shadow-[0_24px_80px_-50px_rgba(15,23,42,0.55)]"
          }
        >
          {/* Forms */}
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
        </div>
      </div>
    </OnboardingShell>
  );
}

function HotelMarketplaceSetupLayout({
  steps,
  currentStep,
  children,
}: {
  steps: string[];
  currentStep: number;
  children: React.ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const currentTitle = steps[currentStep - 1] ?? steps[0];
  const currentDescription =
    currentStep === 1
      ? "Write the short introduction creators will see on your Marketplace profile."
      : currentStep === 2
        ? "Give creators a clear title, short description, and photos of the experience."
        : currentStep === 3
          ? "Choose how you want to collaborate, when the offer is available, and where creators should publish content."
          : "Choose the creator platforms and audience fit that best match this collaboration.";

  useEffect(() => {
    headingRef.current?.focus();
  }, [currentStep]);

  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white px-4 py-3 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-600 text-white">
              <CheckIcon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="text-[15px] font-semibold text-gray-900">
              Creator Marketplace Setup
            </span>
          </div>
          <span className="whitespace-nowrap text-xs text-gray-500 sm:text-[13px]">
            Step {currentStep} of {steps.length}
          </span>
        </div>
      </header>

      <div className="h-[3px] bg-gray-100" aria-hidden="true">
        <div
          className="h-full bg-primary-600 transition-all duration-300"
          style={{ width: `${(currentStep / steps.length) * 100}%` }}
        />
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <HotelMarketplaceStepIndicators steps={steps} currentStep={currentStep} />
        <header className="mx-auto max-w-2xl text-center">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight text-gray-950 outline-none"
          >
            {currentTitle}
          </h1>
          <p className="mt-2 text-sm text-gray-500">{currentDescription}</p>
        </header>
        <div className="mx-auto mt-4 max-w-3xl">{children}</div>
      </div>
    </main>
  );
}

function HotelMarketplaceStepIndicators({
  steps,
  currentStep,
}: {
  steps: string[];
  currentStep: number;
}) {
  return (
    <ol
      className="mb-5 flex items-center justify-center sm:mb-6"
      aria-label="Creator Marketplace setup progress"
    >
      {steps.map((step, index) => {
        const stepNumber = index + 1;
        const isComplete = currentStep > stepNumber;
        const isActive = currentStep === stepNumber;
        return (
          <li key={step} className="flex items-center" aria-current={isActive ? "step" : undefined}>
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                  isComplete || isActive ? "bg-primary-600 text-white" : "bg-gray-200 text-gray-500"
                }`}
              >
                {isComplete ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : stepNumber}
              </span>
              <span
                className={`sr-only whitespace-nowrap text-xs font-medium lg:not-sr-only ${
                  isComplete || isActive ? "text-gray-900" : "text-gray-400"
                }`}
              >
                {step}
              </span>
            </span>
            {index < steps.length - 1 && (
              <span
                className={`mx-2 h-px w-8 shrink-0 sm:mx-3 sm:w-10 lg:w-14 ${
                  isComplete ? "bg-primary-600" : "bg-gray-300"
                }`}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function toCreatorPlatformUpdate(platform: PlatformFormData) {
  const validAgeGroups =
    platform.top_age_groups
      ?.filter((tag) => tag.ageRange?.trim())
      .map((tag) => ({ ageRange: tag.ageRange.trim(), percentage: tag.percentage })) || [];

  return {
    id: platform.id ?? null,
    name: platform.name,
    handle: platform.handle,
    followers: Number(platform.followers),
    engagementRate: Number(platform.engagement_rate),
    ...(platform.top_countries !== undefined
      ? {
          topCountries: platform.top_countries.map((country) => ({
            country: country.country,
            percentage: country.percentage,
          })),
        }
      : {}),
    ...(platform.top_age_groups !== undefined ? { topAgeGroups: validAgeGroups } : {}),
    ...(platform.gender_split !== undefined ? { genderSplit: platform.gender_split } : {}),
  };
}

function profileShellTitle(userType: "creator" | "hotel"): string {
  return userType === "creator" ? "Create your creator profile" : "Set up Creator Marketplace";
}

function profileShellDescription(userType: "creator" | "hotel"): string {
  return userType === "creator"
    ? "Build the profile hotels use to decide whether to collaborate with you."
    : "Introduce your hotel to creators, then create your first collaboration offer.";
}

function newMarketplaceOffer(profile: HotelProfile): ListingFormData {
  return {
    name: "",
    location: profile.location,
    description: "",
    accommodation_type: profile.propertyType ?? "",
    images: [],
    imageMediaObjectIds: [],
    imageFiles: [],
    collaborationTypes: [],
    availability: [],
    platforms: [],
    lookingForPlatforms: [],
    targetGroupCountries: [],
    targetGroupAgeGroups: [],
  };
}

const MARKETPLACE_OFFER_SETUP_STEPS = new Set([
  "marketplaceOffer",
  "offerDeliverables",
  "compensationOptions",
  "creatorRequirements",
]);

function emptyProfileStatus(
  userType: "creator" | "hotel",
): CreatorProfileStatus | HotelProfileStatus {
  if (userType === "creator") {
    return {
      profile_photo_required: false,
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
    missing_offers: true,
    completion_steps: [],
  };
}
