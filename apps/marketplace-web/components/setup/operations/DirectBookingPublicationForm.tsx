"use client";

import {
  BOOKING_PAGE_COLOR_PRESETS,
  BOOKING_PAGE_FONT_PAIRINGS,
  BrandMediaStep,
} from "@vayada/product-onboarding";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { ApiErrorResponse } from "@/services/api/client";
import {
  DIRECT_BOOKING_SUBTEXT_MAX_LENGTH,
  directBookingSubtextError,
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  isPublicationReady,
  type DirectBookingSetup,
  type PublicBookabilityPublication,
} from "@/services/api/hotelOperationsSetupClient";

import { OperationFormLoadError, OperationFormLoading } from "./OperationFormShell";

export function DirectBookingPublicationForm({
  onBack,
  onBeforeSave,
  onCompleted,
  propertyId,
}: {
  onBack: (() => void) | null;
  onBeforeSave: () => Promise<void>;
  onCompleted: () => void | Promise<void>;
  propertyId: string;
}) {
  const [setup, setSetup] = useState<DirectBookingSetup | null>(null);
  const [heroImage, setHeroImage] = useState<File | null>(null);
  const [heroPreviewUrl, setHeroPreviewUrl] = useState("");
  const [publication, setPublication] = useState<PublicBookabilityPublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [completionRefreshPending, setCompletionRefreshPending] = useState(false);
  const [error, setError] = useState("");
  const heroImageInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setPublication(null);
    setHeroImage(null);
    setSettingsSaved(false);
    setCompletionRefreshPending(false);
    void hotelOperationsSetupApi
      .getDirectBookingSetup(propertyId, controller.signal)
      .then(setSetup)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setLoadError(
            hotelOperationsErrorMessage(cause, "Direct booking settings could not be loaded."),
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [propertyId, reloadToken]);

  useEffect(() => {
    if (!heroImage) {
      setHeroPreviewUrl(setup?.heroImageUrl ?? "");
      return;
    }
    const previewUrl = URL.createObjectURL(heroImage);
    setHeroPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [heroImage, setup?.heroImageUrl]);

  const update = <Key extends keyof DirectBookingSetup>(
    key: Key,
    value: DirectBookingSetup[Key],
  ) => {
    setSettingsSaved(false);
    setCompletionRefreshPending(false);
    setPublication(null);
    setSetup((current) => (current ? { ...current, [key]: value } : current));
  };

  const selectHeroFile = (selected: File) => {
    const fileError = directBookingHeroFileError(selected);
    if (fileError) {
      setHeroImage(null);
      setError(fileError);
      if (heroImageInput.current) heroImageInput.current.value = "";
      return;
    }
    setError("");
    setHeroImage(selected);
    setSettingsSaved(false);
    setCompletionRefreshPending(false);
    setPublication(null);
  };

  const handleImageUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (selected) selectHeroFile(selected);
  };

  const handleSubmit = async () => {
    if (!setup || submitting) return;
    setSubmitting(true);
    setError("");
    if (completionRefreshPending || (publication && isPublicationReady(publication))) {
      await refreshCompletion();
      setSubmitting(false);
      return;
    }

    let saved = settingsSaved;
    if (!saved) {
      const validationError = directBookingValidationError(setup, heroImage);
      if (validationError) {
        setError(validationError);
        setSubmitting(false);
        return;
      }

      try {
        await onBeforeSave();
        let heroImageUrl = setup.heroImageUrl;
        if (heroImage) {
          heroImageUrl = await hotelOperationsSetupApi.uploadDirectBookingHero(
            propertyId,
            heroImage,
            setup.profileRevision,
          );
          setSetup((current) =>
            current
              ? {
                  ...current,
                  heroImageUrl,
                  profileRevision: Math.max(current.profileRevision, setup.profileRevision + 1),
                }
              : current,
          );
          setHeroImage(null);
          if (heroImageInput.current) heroImageInput.current.value = "";
        }
        await hotelOperationsSetupApi.saveDirectBookingSetup(propertyId, {
          heroHeading: setup.heroHeading,
          heroSubtext: setup.heroSubtext,
          primaryColor: setup.primaryColor,
          fontPairing: setup.fontPairing,
          heroImageUrl,
        });
        setSettingsSaved(true);
        saved = true;
      } catch (cause) {
        if (cause instanceof ApiErrorResponse && cause.data.code === "profile_revision_conflict") {
          try {
            const refreshed = await hotelOperationsSetupApi.getDirectBookingSetup(propertyId);
            setSetup((current) =>
              current ? { ...current, profileRevision: refreshed.profileRevision } : current,
            );
          } catch {
            // Preserve the original conflict; a later page reload can recover if refresh fails.
          }
        }
        setError(hotelOperationsErrorMessage(cause, "Direct booking settings could not be saved."));
        setSubmitting(false);
        return;
      }
    }

    try {
      if (settingsSaved) await onBeforeSave();
      const result =
        publication &&
        "status" in publication &&
        (publication.status === "pending" || publication.status === "unknown")
          ? await hotelOperationsSetupApi.getDirectBookingPublication(
              propertyId,
              publication.operationId,
            )
          : await hotelOperationsSetupApi.publishDirectBooking(propertyId);
      setPublication(result);
      if (isPublicationReady(result)) await refreshCompletion();
    } catch (cause) {
      setError(
        hotelOperationsErrorMessage(
          cause,
          saved
            ? "Your booking page design is saved, but publication could not be checked."
            : "Direct booking could not be published.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const refreshCompletion = async () => {
    try {
      await onCompleted();
      setCompletionRefreshPending(false);
    } catch (cause) {
      console.warn("Direct booking published but setup status could not refresh", cause);
      setCompletionRefreshPending(true);
      setError("Direct booking was published, but setup could not refresh. Try again.");
    }
  };

  if (loading) return <OperationFormLoading />;
  if (loadError || !setup) {
    return (
      <OperationFormLoadError
        message={loadError || "Direct booking settings could not be loaded."}
        onBack={onBack}
        onRetry={() => setReloadToken((current) => current + 1)}
      />
    );
  }

  const ready = publication && isPublicationReady(publication);
  const notice =
    completionRefreshPending || ready ? (
      "Direct booking is published. Retry the setup refresh to continue."
    ) : publication ? (
      <div className="space-y-2">
        <p className="font-semibold">
          {"status" in publication && publication.status === "pending"
            ? "Direct booking publication is in progress."
            : "Direct booking is not ready to publish yet."}
        </p>
        <ul className="list-disc space-y-1 pl-5">
          {publicationReadinessMessages(publication).map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </div>
    ) : null;
  const validationError = directBookingValidationError(setup, heroImage);

  return (
    <BrandMediaStep
      bookingUrl="Your booking URL"
      canProceed={!validationError}
      colorPresets={BOOKING_PAGE_COLOR_PRESETS}
      continueLabel={
        completionRefreshPending || ready
          ? "Refresh setup progress"
          : settingsSaved
            ? "Check publish readiness"
            : "Publish booking page"
      }
      continuingLabel={completionRefreshPending || ready ? "Refreshing..." : "Publishing..."}
      currency={setup.defaultCurrency}
      defaultLanguage={setup.defaultLanguage}
      error={error}
      fileInputRef={heroImageInput}
      fontPairings={BOOKING_PAGE_FONT_PAIRINGS}
      handleImageUpload={handleImageUpload}
      heroHeading={setup.heroHeading}
      heroImage={heroPreviewUrl}
      imageRecommendation="1920x1080 recommended. JPG, PNG, or WEBP up to 10 MB."
      notice={notice}
      onBack={onBack}
      onContinue={() => void handleSubmit()}
      onImageFile={selectHeroFile}
      onResetSubtext={() => update("heroSubtext", setup.defaultHeroSubtext)}
      primaryColor={setup.primaryColor}
      propertyDescription={setup.heroSubtext}
      propertyName={setup.propertyName}
      selectedFont={setup.fontPairing}
      setHeroHeading={(value) => update("heroHeading", value)}
      setPrimaryColor={(value) => update("primaryColor", value)}
      setPropertyDescription={(value) => update("heroSubtext", value)}
      setSelectedFont={(value) => update("fontPairing", value)}
      submitting={submitting}
      subtextMaxLength={DIRECT_BOOKING_SUBTEXT_MAX_LENGTH}
      subtextPlaceholder="A short tagline about your property."
      uploading={submitting && Boolean(heroImage)}
    />
  );
}

function directBookingHeroFileError(heroImage: File): string | null {
  if (!["image/jpeg", "image/png", "image/webp"].includes(heroImage.type)) {
    return "Choose a JPG, PNG, or WEBP image.";
  }
  return heroImage.size > 10 * 1024 * 1024 ? "Choose an image smaller than 10 MB." : null;
}

function directBookingValidationError(
  setup: DirectBookingSetup,
  heroImage: File | null,
): string | null {
  if (!setup.heroHeading.trim()) return "Add a booking page heading before publishing.";
  const subtextError = directBookingSubtextError(setup.heroSubtext);
  if (subtextError) return subtextError;
  if (!/^#[0-9a-f]{6}$/i.test(setup.primaryColor)) return "Enter a valid six-digit brand color.";
  if (!setup.heroImageUrl && !heroImage) return "Choose a hero image before publishing.";
  return heroImage ? directBookingHeroFileError(heroImage) : null;
}

function publicationReadinessMessages(publication: PublicBookabilityPublication): string[] {
  if ("status" in publication) {
    if (publication.status === "pending")
      return ["Publication is still processing. Check again shortly."];
    if (publication.status === "unknown")
      return ["Publication could not be confirmed. Retry to check the latest result."];
    return ["Publication failed. Review your saved settings and retry publishing."];
  }
  const missing = new Set(publication.missingReadiness);
  const messages: string[] = [];
  if (missing.has("profile") || publication.profileStatus !== "public") {
    messages.push("Complete the public hotel profile and approved image in Hotel details.");
  }
  if (
    missing.has("availability_source") ||
    missing.has("sellable_availability") ||
    missing.has("freshness")
  ) {
    messages.push("Wait for rooms, rates, and availability to finish syncing.");
  }
  if (missing.has("payment_method")) messages.push("Finish setting up a supported payment method.");
  if (missing.has("booking_settings") || missing.has("default_currency")) {
    messages.push("Complete the remaining guest and currency settings.");
  }
  if (messages.length === 0) {
    messages.push("The booking profile is still syncing. Try publishing again shortly.");
  }
  return messages;
}
