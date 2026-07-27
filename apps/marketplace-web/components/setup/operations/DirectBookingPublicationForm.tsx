"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SetupTrack } from "@vayada/product-onboarding";

import {
  hotelOperationsErrorMessage,
  hotelOperationsSetupApi,
  isPublicationReady,
  type DirectBookingSetup,
  type PublicBookabilityPublication,
} from "@/services/api/hotelOperationsSetupClient";

import {
  OperationField,
  OperationFormLoadError,
  OperationFormLoading,
  OperationFormShell,
  operationInputClassName,
} from "./OperationFormShell";

export function DirectBookingPublicationForm({
  onBack,
  onBeforeSave,
  onCompleted,
  propertyId,
  selectedTracks,
}: {
  onBack: (() => void) | null;
  onBeforeSave: () => Promise<void>;
  onCompleted: () => void | Promise<void>;
  propertyId: string;
  selectedTracks: readonly SetupTrack[];
}) {
  const [setup, setSetup] = useState<DirectBookingSetup | null>(null);
  const [heroImage, setHeroImage] = useState<File | null>(null);
  const [publication, setPublication] = useState<PublicBookabilityPublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [completionRefreshPending, setCompletionRefreshPending] = useState(false);
  const [error, setError] = useState("");
  const heroImageInput = useRef<HTMLInputElement>(null);
  const collectPublicDescription = shouldCollectDirectBookingDescription(selectedTracks);

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

  const update = <Key extends keyof DirectBookingSetup>(
    key: Key,
    value: DirectBookingSetup[Key],
  ) => {
    setSettingsSaved(false);
    setCompletionRefreshPending(false);
    setPublication(null);
    setSetup((current) => (current ? { ...current, [key]: value } : current));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!setup) return;
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
          setSetup((current) => (current ? { ...current, heroImageUrl } : current));
          setHeroImage(null);
          if (heroImageInput.current) heroImageInput.current.value = "";
        }
        await hotelOperationsSetupApi.saveDirectBookingSetup(propertyId, {
          localityPublic: setup.localityPublic,
          ...(collectPublicDescription ? { publicDescription: setup.shortDescription } : {}),
          heroHeading: setup.heroHeading,
          heroSubtext: setup.heroSubtext,
          primaryColor: setup.primaryColor,
          fontPairing: setup.fontPairing,
          heroImageUrl,
        });
        setSettingsSaved(true);
        saved = true;
      } catch (cause) {
        setError(hotelOperationsErrorMessage(cause, "Direct booking settings could not be saved."));
        setSubmitting(false);
        return;
      }
    }

    try {
      if (settingsSaved) await onBeforeSave();
      const result = await hotelOperationsSetupApi.publishDirectBooking(propertyId);
      setPublication(result);
      if (isPublicationReady(result)) {
        await refreshCompletion();
      }
    } catch (cause) {
      setError(
        hotelOperationsErrorMessage(
          cause,
          saved
            ? "Your direct booking settings are saved, but publication could not be checked."
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

  return (
    <OperationFormShell
      error={error}
      notice={
        completionRefreshPending || (publication && isPublicationReady(publication)) ? (
          "Direct booking is published. Retry the setup refresh to continue."
        ) : publication && !isPublicationReady(publication) ? (
          <div className="space-y-2">
            <p className="font-semibold">Direct booking is not ready to publish yet.</p>
            <ul className="list-disc space-y-1 pl-5">
              {publicationReadinessMessages(publication).map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null
      }
      onBack={onBack}
      onSubmit={handleSubmit}
      submitLabel={
        completionRefreshPending || (publication && isPublicationReady(publication))
          ? "Refresh setup progress"
          : settingsSaved
            ? "Check publish readiness"
            : "Save and publish direct booking"
      }
      submitting={submitting}
      submittingLabel={
        completionRefreshPending || (publication && isPublicationReady(publication))
          ? "Refreshing..."
          : settingsSaved
            ? "Checking..."
            : "Saving..."
      }
    >
      <OperationField className="sm:col-span-2" label="Booking page heading">
        <input
          className={operationInputClassName}
          maxLength={160}
          onChange={(event) => update("heroHeading", event.target.value)}
          required
          value={setup.heroHeading}
        />
      </OperationField>
      {collectPublicDescription && (
        <OperationField
          className="sm:col-span-2"
          hint="This public description also helps guests understand what makes your hotel distinct."
          label="Public hotel description"
        >
          <textarea
            className={`${operationInputClassName} min-h-28 resize-y`}
            maxLength={500}
            onChange={(event) => {
              update("shortDescription", event.target.value);
              if (!setup.heroSubtext || setup.heroSubtext === setup.shortDescription) {
                update("heroSubtext", event.target.value);
              }
            }}
            required
            value={setup.shortDescription}
          />
        </OperationField>
      )}
      <OperationField className="sm:col-span-2" label="Booking page introduction">
        <textarea
          className={`${operationInputClassName} min-h-24 resize-y`}
          maxLength={1000}
          onChange={(event) => update("heroSubtext", event.target.value)}
          required
          value={setup.heroSubtext}
        />
      </OperationField>
      <OperationField label="Brand color">
        <div className="flex items-center gap-3">
          <input
            aria-label="Choose brand color"
            className="h-11 w-14 cursor-pointer rounded-lg border border-gray-300 bg-white p-1"
            onChange={(event) => update("primaryColor", event.target.value)}
            type="color"
            value={setup.primaryColor}
          />
          <input
            className={operationInputClassName}
            maxLength={7}
            onChange={(event) => update("primaryColor", event.target.value)}
            pattern="#[0-9A-Fa-f]{6}"
            required
            value={setup.primaryColor}
          />
        </div>
      </OperationField>
      <OperationField label="Typography">
        <select
          className={operationInputClassName}
          onChange={(event) => update("fontPairing", event.target.value)}
          value={setup.fontPairing}
        >
          <option value="modern-minimalist">Modern minimalist</option>
          <option value="high-end-serif">High-end serif</option>
          <option value="grand-classic">Grand classic</option>
          <option value="imperial-serif">Imperial serif</option>
          <option value="italiana-serif">Italiana serif</option>
        </select>
      </OperationField>
      <OperationField
        className="sm:col-span-2"
        hint={
          setup.heroImageUrl
            ? "A public hotel image is already available. Choose another only to replace it."
            : "JPG, PNG, or WEBP. Maximum 10 MB."
        }
        label="Public hotel image"
      >
        <input
          accept="image/jpeg,image/png,image/webp"
          className={`${operationInputClassName} file:mr-3 file:rounded-full file:border-0 file:bg-primary-50 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-primary-800`}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            if (selected && !["image/jpeg", "image/png", "image/webp"].includes(selected.type)) {
              setHeroImage(null);
              setError("Choose a JPG, PNG, or WEBP image.");
              event.target.value = "";
              return;
            }
            if (selected && selected.size > 10 * 1024 * 1024) {
              setHeroImage(null);
              setError("Choose an image smaller than 10 MB.");
              event.target.value = "";
              return;
            }
            setError("");
            setHeroImage(selected);
            setSettingsSaved(false);
            setCompletionRefreshPending(false);
            setPublication(null);
          }}
          ref={heroImageInput}
          required={!setup.heroImageUrl}
          type="file"
        />
      </OperationField>
      <label className="flex items-start gap-3 rounded-xl border border-gray-300 p-4 sm:col-span-2">
        <input
          checked={setup.localityPublic}
          className="mt-0.5 h-4 w-4 accent-primary-600"
          onChange={(event) => update("localityPublic", event.target.checked)}
          required
          type="checkbox"
        />
        <span>
          <span className="block text-sm font-semibold text-gray-950">
            Show the hotel city and country publicly
          </span>
          <span className="mt-1 block text-xs leading-5 text-gray-600">
            Your full street address stays private unless you publish it separately.
          </span>
        </span>
      </label>
    </OperationFormShell>
  );
}

export function shouldCollectDirectBookingDescription(
  selectedTracks: readonly SetupTrack[],
): boolean {
  return !selectedTracks.includes("creator_marketplace");
}

function directBookingValidationError(
  setup: DirectBookingSetup,
  heroImage: File | null,
): string | null {
  if (!setup.localityPublic) {
    return "Allow the hotel city and country to be shown before publishing direct booking.";
  }
  if (!setup.heroImageUrl && !heroImage) {
    return "Choose a public hotel image before publishing direct booking.";
  }
  if (heroImage && !["image/jpeg", "image/png", "image/webp"].includes(heroImage.type)) {
    return "Choose a JPG, PNG, or WEBP image.";
  }
  if (heroImage && heroImage.size > 10 * 1024 * 1024) {
    return "Choose an image smaller than 10 MB.";
  }
  return null;
}

function publicationReadinessMessages(publication: PublicBookabilityPublication): string[] {
  const missing = new Set(publication.missingReadiness);
  const messages: string[] = [];
  if (missing.has("profile") || publication.profileStatus !== "public") {
    messages.push("Complete the public hotel description and image.");
  }
  if (
    missing.has("availability_source") ||
    missing.has("sellable_availability") ||
    missing.has("freshness")
  ) {
    messages.push("Wait for rooms, rates, and availability to finish syncing.");
  }
  if (missing.has("payment_method")) {
    messages.push("Finish setting up a supported payment method.");
  }
  if (missing.has("booking_settings") || missing.has("default_currency")) {
    messages.push("Complete the remaining guest and currency settings.");
  }
  if (messages.length === 0) {
    messages.push("The booking profile is still syncing. Try publishing again shortly.");
  }
  return messages;
}
