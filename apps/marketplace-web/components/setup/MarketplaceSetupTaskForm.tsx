"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, CheckIcon } from "@heroicons/react/24/outline";

import { HotelProfileForm } from "@/components/profile-complete/hotel/HotelProfileForm";
import { useHotelProfileForm } from "@/hooks/useHotelProfileForm";
import { formatErrorDetail } from "@/hooks/useErrorModal";
import type { ListingFormData } from "@/lib/types";
import {
  buildHotelMarketplaceCreatorRequirements,
  buildHotelMarketplaceOfferings,
  clearHotelMarketplaceDraft,
  createHotelMarketplaceDraft,
  ensureHotelMarketplaceOfferIdempotency,
  markHotelMarketplaceDraftOfferProgress,
  readHotelMarketplaceDraft,
  recoverHotelMarketplaceDraftFromSourceMediaFailure,
  recoverHotelMarketplaceOfferFromSourceMediaFailure,
  resolveHotelMarketplaceCoverSource,
  resolveHotelMarketplaceDraftResume,
  restoreHotelMarketplaceDraftForm,
  saveHotelMarketplaceDraft,
  type HotelMarketplaceDraft,
} from "@/lib/utils/hotelMarketplaceDraft";
import { ApiErrorResponse } from "@/services/api/client";
import {
  advanceHotelProfileRevisionsAfterCoverUpload,
  CanonicalHotelPhotoReuseError,
  hotelService,
  type HotelProfileRevisionSnapshot,
} from "@/services/api/hotels";

import { MarketplaceOfferFields } from "./marketplace/MarketplaceOfferFields";
import {
  hydrateMarketplaceSetupTask,
  type MarketplaceSetupTaskId,
} from "./marketplace/marketplaceSetupTaskFormData";

export type MarketplaceSetupTaskFormProps = {
  taskId: MarketplaceSetupTaskId;
  propertyId: string;
  onBeforeSave: () => Promise<void>;
  onCompleted: () => void | Promise<void>;
  onBack: (() => void) | null;
  onDirty: () => void;
};

type CoverSelection = {
  file: File | null;
  previewUrl: string | null;
};

class HotelCoverPhotoRequiredError extends Error {
  constructor() {
    super("Choose a hotel cover photo to continue.");
    this.name = "HotelCoverPhotoRequiredError";
  }
}

export function MarketplaceSetupTaskForm({
  taskId,
  propertyId,
  onBeforeSave,
  onCompleted,
  onBack,
  onDirty,
}: MarketplaceSetupTaskFormProps) {
  const submitPublicProfile = taskId === "public_profile";
  const submitCreatorOffer = taskId === "creator_offer";
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [completionRefreshPending, setCompletionRefreshPending] = useState(false);
  const [error, setError] = useState("");
  const [taskReady, setTaskReady] = useState(false);
  const [canonicalCoverUrl, setCanonicalCoverUrl] = useState<string | null>(null);
  const [existingOfferCoverUrl, setExistingOfferCoverUrl] = useState<string | null>(null);
  const [coverSelection, setCoverSelection] = useState<CoverSelection>({
    file: null,
    previewUrl: null,
  });
  const coverInputRef = useRef<HTMLInputElement>(null);
  const profileRevisionsRef = useRef<HotelProfileRevisionSnapshot | null>(null);
  const latestCreatorOfferDraftRef = useRef<HotelMarketplaceDraft | null>(null);
  const creatorOfferCompletedRef = useRef(false);
  const hotelForm = useHotelProfileForm({ onError: setError });
  const setForm = hotelForm.setForm;
  const setListings = hotelForm.setListings;

  const showCoverPicker = taskId === "public_profile" && !canonicalCoverUrl;
  const coverSelectionRequired = showCoverPicker && !existingOfferCoverUrl;
  const canProceed =
    taskId === "public_profile"
      ? hotelForm.canProceedStep1(true) && (!coverSelectionRequired || Boolean(coverSelection.file))
      : hotelForm.canProceedListingStep("details") &&
        hotelForm.canProceedListingStep("offerings") &&
        hotelForm.canProceedListingStep("requirements");

  useEffect(() => {
    if (submitCreatorOffer && taskReady && !completionRefreshPending) {
      latestCreatorOfferDraftRef.current = createHotelMarketplaceDraft(
        hotelForm.form,
        hotelForm.listings,
        1,
      );
    }
  }, [completionRefreshPending, hotelForm.form, hotelForm.listings, submitCreatorOffer, taskReady]);

  useEffect(() => {
    if (!submitCreatorOffer) return;
    creatorOfferCompletedRef.current = false;
    const persistLatestDraft = () => {
      const draft = latestCreatorOfferDraftRef.current;
      if (creatorOfferCompletedRef.current || !draft) return;
      try {
        saveHotelMarketplaceDraft(localStorage, propertyId, draft);
      } catch (cause) {
        console.warn("Could not save the Marketplace setup draft before leaving", cause);
      }
    };
    window.addEventListener("beforeunload", persistLatestDraft);
    return () => {
      window.removeEventListener("beforeunload", persistLatestDraft);
      persistLatestDraft();
    };
  }, [propertyId, submitCreatorOffer]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    let cancelled = false;

    setLoading(true);
    setLoadFailed(false);
    setTaskReady(false);
    setCompletionRefreshPending(false);
    setError("");
    setCanonicalCoverUrl(null);
    setExistingOfferCoverUrl(null);
    setCoverSelection({ file: null, previewUrl: null });
    profileRevisionsRef.current = null;

    void hotelService
      .getMyProfile(propertyId, { signal: controller.signal })
      .then((profile) => {
        if (cancelled) return;
        const hydration = hydrateMarketplaceSetupTask(profile, taskId);
        profileRevisionsRef.current = {
          canonicalProfileRevision: profile.canonicalProfileRevision,
          publicProfileRevision: profile.publicProfileRevision,
        };
        setCanonicalCoverUrl(hydration.canonicalCoverUrl);
        setExistingOfferCoverUrl(hydration.existingOfferCoverUrl);
        setCoverSelection({
          file: null,
          previewUrl:
            !hydration.canonicalCoverUrl && hydration.existingOfferCoverUrl
              ? hydration.existingOfferCoverUrl
              : null,
        });
        setForm(hydration.form);
        setListings(hydration.listings);

        if (taskId === "creator_offer") {
          const savedDraft = readHotelMarketplaceDraft(localStorage, propertyId);
          if (savedDraft) {
            const resumed = resolveHotelMarketplaceDraftResume(
              savedDraft,
              hydration.hasExistingOffer,
            );
            setForm(restoreHotelMarketplaceDraftForm(savedDraft.form, profile.localityPublic));
            if (resumed.listings.length > 0) {
              setListings(resumed.listings);
              if (
                savedDraft.omittedLocalPhotos &&
                resumed.listings.some((listing) => listing.images.length === 0)
              ) {
                setError(
                  "Your saved offer details were restored. Select the local photos again to continue.",
                );
              }
            } else if (hydration.hasExistingOffer) {
              clearHotelMarketplaceDraft(localStorage, propertyId);
            }
          }
        }

        setTaskReady(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadFailed(true);
        setError(
          controller.signal.aborted
            ? "Loading this setup step took too long. Try again."
            : errorMessage(cause, "This setup step could not be loaded. Try again."),
        );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [propertyId, reloadToken, setForm, setListings, taskId]);

  useEffect(() => {
    if (taskId !== "creator_offer" || !taskReady || submitting || completionRefreshPending) {
      return;
    }

    const saveTimeout = window.setTimeout(() => {
      try {
        saveHotelMarketplaceDraft(
          localStorage,
          propertyId,
          createHotelMarketplaceDraft(hotelForm.form, hotelForm.listings, 1),
        );
      } catch (cause) {
        console.warn("Could not save the Marketplace setup draft", cause);
      }
    }, 250);

    return () => window.clearTimeout(saveTimeout);
  }, [
    completionRefreshPending,
    hotelForm.form,
    hotelForm.listings,
    propertyId,
    submitting,
    taskId,
    taskReady,
  ]);

  const handleBack = () => {
    if (submitting) return;
    if (taskId === "creator_offer" && taskReady && !completionRefreshPending) {
      try {
        const draft = latestCreatorOfferDraftRef.current;
        if (draft) saveHotelMarketplaceDraft(localStorage, propertyId, draft);
      } catch (cause) {
        console.warn("Could not save the Marketplace setup draft", cause);
        setError("We couldn't save your Marketplace draft. Try again.");
        return;
      }
    }
    onBack?.();
  };

  const handleCoverChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choose a JPG, PNG, or WEBP hotel cover photo.");
      event.target.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Hotel cover photo must be 10 MB or smaller.");
      event.target.value = "";
      return;
    }

    setError("");
    onDirty();
    setCoverSelection((current) => ({ ...current, file }));
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== "string") return;
      setCoverSelection((current) =>
        current.file === file ? { ...current, previewUrl: reader.result as string } : current,
      );
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const clearCoverSelection = () => {
    onDirty();
    setCoverSelection({
      file: null,
      previewUrl: existingOfferCoverUrl,
    });
    if (coverInputRef.current) coverInputRef.current.value = "";
  };

  const ensureCanonicalCover = async () => {
    if (canonicalCoverUrl) return;
    const revisions = profileRevisionsRef.current;
    if (!revisions) throw new Error("The hotel profile revision is unavailable");

    const source = resolveHotelMarketplaceCoverSource({
      selectedFile: coverSelection.file,
      existingOfferCoverUrl,
    });
    if (!source) throw new HotelCoverPhotoRequiredError();

    const uploaded =
      source.kind === "file"
        ? await hotelService.uploadProfileImage(
            source.file,
            propertyId,
            revisions.canonicalProfileRevision,
          )
        : await hotelService.uploadProfileImageFromSource(
            source.url,
            propertyId,
            revisions.canonicalProfileRevision,
          );

    profileRevisionsRef.current = advanceHotelProfileRevisionsAfterCoverUpload(revisions);
    setCanonicalCoverUrl(uploaded.url);
    setCoverSelection((current) => ({ ...current, previewUrl: uploaded.url }));
  };

  const submitOffers = async (): Promise<boolean> => {
    const submissionListings = hotelForm.listings.map(ensureHotelMarketplaceOfferIdempotency);
    hotelForm.setListings(submissionListings);
    saveHotelMarketplaceDraft(
      localStorage,
      propertyId,
      createHotelMarketplaceDraft(hotelForm.form, submissionListings, 1),
    );

    for (const listing of submissionListings) {
      const onboarding = listing.marketplaceOnboarding!;
      if (
        onboarding.createdOfferId &&
        onboarding.mediaPending !== true &&
        !onboarding.existingOffer
      ) {
        continue;
      }

      const offerPayload = {
        name: listing.name,
        location: listing.location,
        description: listing.description,
        accommodation_type: listing.accommodation_type || undefined,
        images: listing.images.filter((image) => !image.startsWith("data:")),
        image_media_object_ids: listing.imageMediaObjectIds ?? [],
        deliverables: listing.platforms.map((platform) => ({
          platform,
          deliverable_type: "content",
          quantity: 1,
          timing_guidance: null,
        })),
        collaboration_offerings: buildHotelMarketplaceOfferings(listing),
        creator_requirements: buildHotelMarketplaceCreatorRequirements(listing),
      };
      let imageUrls = offerPayload.images;
      let imageMediaObjectIds = offerPayload.image_media_object_ids;

      if (imageUrls.length === 0 && !listing.imageFiles.length) {
        setError(`Offer "${listing.name}": At least one image is required.`);
        return false;
      }

      let createdOfferId = onboarding.createdOfferId;
      let mediaResourceId = onboarding.createdOfferMediaResourceId;
      const copiedImageUrls = imageUrls.slice(imageMediaObjectIds.length);
      const mediaPending = copiedImageUrls.length > 0 || listing.imageFiles.length > 0;

      if (!createdOfferId) {
        const created = await hotelService.createListing(offerPayload, propertyId, {
          idempotencyKey: onboarding.idempotencyKey,
        });
        createdOfferId = created.id;
        mediaResourceId = created.media_resource_id;
        const progress = {
          idempotencyKey: onboarding.idempotencyKey,
          createdOfferId,
          createdOfferMediaResourceId: mediaResourceId,
          mediaPending,
        };
        markHotelMarketplaceDraftOfferProgress(
          localStorage,
          propertyId,
          onboarding.idempotencyKey,
          progress,
        );
        updateOfferProgress(hotelForm.setListings, onboarding.idempotencyKey, progress);
      } else {
        await hotelService.updateListing(createdOfferId, offerPayload, propertyId);
      }

      if (mediaPending) {
        try {
          if (!mediaResourceId) throw new Error("The listing media resource is unavailable");
          const uploaded = await hotelService.uploadListingImagesFromSources(
            copiedImageUrls,
            listing.imageFiles,
            mediaResourceId,
            { idempotencyKey: `${onboarding.idempotencyKey}:media:v1` },
          );
          imageUrls = [
            ...imageUrls.slice(0, imageMediaObjectIds.length),
            ...uploaded.images.map((image) => image.url),
          ];
          imageMediaObjectIds = [
            ...imageMediaObjectIds,
            ...uploaded.images.map((image) => image.mediaObjectId),
          ];
          await hotelService.updateListing(
            createdOfferId,
            {
              images: imageUrls,
              image_media_object_ids: imageMediaObjectIds,
            },
            propertyId,
          );
        } catch (cause) {
          if (cause instanceof CanonicalHotelPhotoReuseError) {
            const recoveryProgress = {
              idempotencyKey: onboarding.idempotencyKey,
              createdOfferId,
              ...(mediaResourceId ? { createdOfferMediaResourceId: mediaResourceId } : {}),
              mediaPending: true,
            };
            const recoverListing = (current: ListingFormData) =>
              current.marketplaceOnboarding?.idempotencyKey === onboarding.idempotencyKey
                ? recoverHotelMarketplaceOfferFromSourceMediaFailure(
                    current,
                    copiedImageUrls,
                    recoveryProgress,
                  )
                : current;
            hotelForm.setListings((current) => current.map(recoverListing));
            const latestDraft = readHotelMarketplaceDraft(localStorage, propertyId);
            const recoveredDraft = latestDraft
              ? recoverHotelMarketplaceDraftFromSourceMediaFailure(
                  latestDraft,
                  onboarding.idempotencyKey,
                  copiedImageUrls,
                  recoveryProgress,
                )
              : createHotelMarketplaceDraft(
                  hotelForm.form,
                  submissionListings.map(recoverListing),
                  1,
                );
            saveHotelMarketplaceDraft(localStorage, propertyId, recoveredDraft);
            setError(
              `We couldn't reuse the shared hotel photo for offer "${listing.name}". Upload the photo manually to continue.`,
            );
          } else {
            setError(
              errorMessage(
                cause,
                `Failed to upload images for offer "${listing.name}". Try again.`,
              ),
            );
          }
          return false;
        }
      }

      const completedProgress = {
        idempotencyKey: onboarding.idempotencyKey,
        createdOfferId,
        ...(mediaResourceId ? { createdOfferMediaResourceId: mediaResourceId } : {}),
        mediaPending: false,
        ...(onboarding.existingOffer ? { existingOffer: true } : {}),
      };
      markHotelMarketplaceDraftOfferProgress(
        localStorage,
        propertyId,
        onboarding.idempotencyKey,
        completedProgress,
      );
      updateOfferProgress(hotelForm.setListings, onboarding.idempotencyKey, completedProgress);
    }

    return true;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (completionRefreshPending) return;
    setError("");

    if (
      !hotelForm.validateForm({
        validateProfile: submitPublicProfile,
        requireLocalityConsent: submitPublicProfile,
        validateOffers: submitCreatorOffer,
        profileFieldName: submitPublicProfile ? "Hotel description" : undefined,
      })
    ) {
      return;
    }
    if (submitPublicProfile && !profileRevisionsRef.current) {
      setError("The hotel profile revision is unavailable. Reload this step and try again.");
      return;
    }

    setSubmitting(true);
    try {
      await onBeforeSave();
      if (submitPublicProfile) {
        await ensureCanonicalCover();
        const updatedProfile = await hotelService.updatePublicSetupProfile(
          {
            about: hotelForm.form.about.trim(),
            localityPublic: hotelForm.form.localityPublic,
          },
          propertyId,
          profileRevisionsRef.current!,
        );
        profileRevisionsRef.current = {
          canonicalProfileRevision: updatedProfile.canonicalProfileRevision,
          publicProfileRevision: updatedProfile.publicProfileRevision,
        };
      }
      if (submitCreatorOffer && !(await submitOffers())) return;

      if (submitCreatorOffer) {
        creatorOfferCompletedRef.current = true;
        clearHotelMarketplaceDraft(localStorage, propertyId);
      }
      setCompletionRefreshPending(true);
      setError("Your changes are saved. Refresh setup progress to continue.");
      try {
        await onCompleted();
      } catch (cause) {
        console.warn("Marketplace task saved but setup status could not refresh", cause);
        setCompletionRefreshPending(true);
        setError("Your changes were saved, but setup could not refresh. Retry the refresh.");
      }
    } catch (cause) {
      if (cause instanceof HotelCoverPhotoRequiredError) {
        setCoverSelection((current) => ({ ...current, previewUrl: null }));
        setError(cause.message);
      } else if (cause instanceof CanonicalHotelPhotoReuseError) {
        setExistingOfferCoverUrl(null);
        setCoverSelection({ file: null, previewUrl: null });
        setError("We couldn't reuse that photo. Choose a replacement hotel cover to continue.");
      } else if (cause instanceof ApiErrorResponse) {
        setError(
          cause.data.code === "profile_revision_conflict"
            ? "This hotel profile changed in another tab. Reload this step and try again."
            : errorMessage(cause, "Failed to save this step."),
        );
      } else {
        setError(errorMessage(cause, "Failed to save this step. Try again."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const retryCompletionRefresh = async () => {
    setSubmitting(true);
    setError("");
    try {
      await onCompleted();
    } catch (cause) {
      console.warn("Setup status still could not refresh", cause);
      setError("Your changes are saved, but setup still could not refresh. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-72 items-center justify-center" aria-label="Loading setup fields">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-primary-600" />
      </div>
    );
  }

  if (loadFailed || !taskReady) {
    return (
      <div className="space-y-5">
        {onBack && <BackButton disabled={false} onClick={handleBack} />}
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4" role="alert">
          <p className="text-sm font-medium text-red-800">{error}</p>
          <button
            type="button"
            onClick={() => setReloadToken((current) => current + 1)}
            className="mt-3 rounded-full bg-white px-4 py-2 text-sm font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {onBack && <BackButton disabled={submitting} onClick={handleBack} />}

      {taskId === "creator_offer" && (
        <p
          data-testid="marketplace-offer-draft-note"
          className="rounded-xl border border-primary-100 bg-primary-50 px-3 py-2 text-xs leading-5 text-primary-900"
        >
          Your text and selections are saved in this browser while you work. Local photos cannot
          survive a refresh, so you may need to select them again.
        </p>
      )}

      {taskId === "creator_offer" ? (
        <form onSubmit={handleSubmit} className="space-y-5">
          <MarketplaceOfferFields
            listings={hotelForm.listings}
            countryInputs={hotelForm.countryInputs}
            countries={hotelForm.countries}
            imageInputRefs={hotelForm.listingImageInputRefs}
            onUpdateListing={(...args) => {
              onDirty();
              hotelForm.updateListing(...args);
            }}
            onImageChange={(...args) => {
              onDirty();
              hotelForm.handleListingImageChange(...args);
            }}
            onRemoveImage={(...args) => {
              onDirty();
              hotelForm.removeListingImage(...args);
            }}
            onCountryInputChange={(...args) => {
              onDirty();
              hotelForm.handleCountryInputChange(...args);
            }}
          />
          {error && !completionRefreshPending && <InlineError message={error} />}
          <div className="flex justify-end border-t border-gray-100 pt-4">
            <button
              type="submit"
              disabled={submitting || completionRefreshPending || !canProceed}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              {submitting ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : (
                <CheckIcon className="h-4 w-4" />
              )}
              {submitting ? "Saving..." : "Save collaboration offer"}
            </button>
          </div>
        </form>
      ) : (
        <HotelProfileForm
          form={hotelForm.form}
          listings={hotelForm.listings}
          currentStep={1}
          totalSteps={1}
          activeSection={taskId}
          error={completionRefreshPending ? "" : error}
          submitting={submitting}
          canProceed={canProceed && !completionRefreshPending}
          collapsedCards={hotelForm.collapsedCards}
          countryInputs={hotelForm.countryInputs}
          countries={hotelForm.countries}
          showCoverPhotoPicker={showCoverPicker}
          coverPhotoPreview={coverSelection.previewUrl}
          coverPhotoRequired={coverSelectionRequired}
          hasSelectedCoverPhoto={Boolean(coverSelection.file)}
          showLocalityConsent={taskId === "public_profile"}
          submitLabel="Save hotel profile"
          embedded
          imageInputRefs={hotelForm.listingImageInputRefs}
          coverPhotoInputRef={coverInputRef}
          onFormChange={(...args) => {
            onDirty();
            hotelForm.handleFormChange(...args);
          }}
          onCoverPhotoChange={handleCoverChange}
          onClearCoverPhoto={clearCoverSelection}
          onToggleCollapse={hotelForm.toggleListingCollapse}
          onUpdateListing={hotelForm.updateListing}
          onImageChange={(...args) => {
            onDirty();
            hotelForm.handleListingImageChange(...args);
          }}
          onRemoveImage={hotelForm.removeListingImage}
          onCountryInputChange={hotelForm.handleCountryInputChange}
          onPrevStep={handleBack}
          onNextStep={() => undefined}
          onSubmit={handleSubmit}
        />
      )}

      {completionRefreshPending && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4" role="status">
          <p className="text-sm text-amber-900">{error}</p>
          <button
            type="button"
            disabled={submitting}
            onClick={retryCompletionRefresh}
            className="mt-3 rounded-full bg-white px-4 py-2 text-sm font-semibold text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100 disabled:opacity-60"
          >
            Refresh setup
          </button>
        </div>
      )}
    </div>
  );
}

function BackButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
      Back
    </button>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="whitespace-pre-line rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800"
    >
      {message}
    </div>
  );
}

function updateOfferProgress(
  setListings: React.Dispatch<React.SetStateAction<ListingFormData[]>>,
  idempotencyKey: string,
  progress: NonNullable<ListingFormData["marketplaceOnboarding"]>,
) {
  setListings((current) =>
    current.map((listing) =>
      listing.marketplaceOnboarding?.idempotencyKey === idempotencyKey
        ? { ...listing, marketplaceOnboarding: progress }
        : listing,
    ),
  );
}

export function errorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiErrorResponse)) return fallback;
  const detail = cause.data.detail;
  const formattedDetail =
    (typeof detail === "string" && detail.trim()) ||
    (Array.isArray(detail) && detail.length > 0 ? formatErrorDetail(detail) : "");
  return (
    formattedDetail ||
    (typeof cause.data.message === "string" && cause.data.message.trim()) ||
    (typeof cause.data.error === "string" && cause.data.error.trim()) ||
    cause.message.trim() ||
    fallback
  );
}
