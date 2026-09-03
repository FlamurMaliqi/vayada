"use client";

import { RefObject } from "react";
import Image from "next/image";
import { PhotoIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Textarea, HotelBadgeIcon } from "@/components/ui";
import type { HotelFormState } from "@/lib/types";

interface HotelBasicInfoStepProps {
  form: HotelFormState;
  onFormChange: (updates: Partial<HotelFormState>) => void;
  error: string;
  showCoverPhotoPicker?: boolean;
  coverPhotoPreview?: string | null;
  coverPhotoRequired?: boolean;
  hasSelectedCoverPhoto?: boolean;
  publicProfileMode?: boolean;
  showLocalityConsent?: boolean;
  coverPhotoInputRef?: RefObject<HTMLInputElement>;
  onCoverPhotoChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClearCoverPhoto?: () => void;
  showIntro?: boolean;
}

export function HotelBasicInfoStep({
  form,
  onFormChange,
  error,
  showCoverPhotoPicker = false,
  coverPhotoPreview = null,
  coverPhotoRequired = false,
  hasSelectedCoverPhoto = false,
  publicProfileMode = false,
  showLocalityConsent = true,
  coverPhotoInputRef,
  onCoverPhotoChange,
  onClearCoverPhoto,
  showIntro = true,
}: HotelBasicInfoStepProps) {
  return (
    <div className="space-y-5">
      {showIntro && (
        <div className="flex items-center gap-3 pb-1">
          <HotelBadgeIcon active={false} />
          <div>
            <h3 className="text-base font-semibold text-gray-950">
              {publicProfileMode
                ? "Complete your public hotel profile"
                : "Introduce your hotel to creators"}
            </h3>
            <p className="mt-1 text-sm leading-5 text-gray-500">
              {publicProfileMode
                ? "Add the description and visibility choices used across vayada’s public surfaces."
                : "Your shared hotel details are already saved. Add only the pitch creators should see."}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <Textarea
          label={publicProfileMode ? "Hotel description" : "Creator-facing introduction"}
          aria-label={publicProfileMode ? "Hotel description" : "Creator-facing introduction"}
          value={form.about}
          onChange={(e) => onFormChange({ about: e.target.value })}
          placeholder={
            publicProfileMode
              ? "Tell guests and creators what makes your hotel special."
              : "Tell creators what makes your hotel and collaboration opportunity special."
          }
          rows={4}
          maxLength={5000}
          required
          helperText={`Minimum 50 characters · ${form.about.length}/5000`}
          className="min-h-36 resize-none rounded-xl border-gray-200 bg-gray-50 px-4 py-3 focus:bg-white focus:ring-primary-100"
          error={
            (error && (error.includes("introduction") || error.includes("description"))
              ? error
              : undefined) ||
            (form.about.trim().length > 0 && form.about.trim().length < 50
              ? `${publicProfileMode ? "Description" : "Introduction"} must be at least 50 characters (${form.about.length}/5000)`
              : undefined)
          }
        />
      </div>

      {showLocalityConsent && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <label className="flex cursor-pointer items-start gap-3 text-sm text-gray-900">
            <input
              type="checkbox"
              checked={form.localityPublic}
              onChange={(event) => onFormChange({ localityPublic: event.target.checked })}
              required
              aria-describedby="marketplace-locality-consent-help"
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <span>
              <span className="block font-semibold">
                Show city and country on public vayada surfaces
              </span>
              <span
                id="marketplace-locality-consent-help"
                className="mt-1 block text-xs leading-5 text-gray-600"
              >
                This can display your locality in Creator Marketplace and direct-booking
                experiences. Your exact street address and coordinates stay private.
              </span>
            </span>
          </label>
        </div>
      )}

      {showCoverPhotoPicker && (
        <section
          aria-labelledby="existing-offer-cover-heading"
          className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-4"
        >
          <div>
            <h4 id="existing-offer-cover-heading" className="text-sm font-semibold text-gray-900">
              Public hotel cover
              {coverPhotoRequired && (
                <>
                  <span className="text-red-500" aria-hidden="true">
                    {" "}
                    *
                  </span>
                  <span className="sr-only"> (required)</span>
                </>
              )}
            </h4>
            <p className="mt-1 text-xs leading-5 text-gray-500">
              Choose the cover used on your public hotel profile. If an offer photo is available,
              you can reuse it or choose a replacement.
            </p>
          </div>

          {coverPhotoPreview ? (
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3">
              <Image
                src={coverPhotoPreview}
                alt="Public hotel cover preview"
                width={96}
                height={80}
                unoptimized
                className="h-20 w-24 shrink-0 rounded-lg object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900">
                  {hasSelectedCoverPhoto ? "Selected replacement" : "Existing offer photo"}
                </p>
                <button
                  type="button"
                  onClick={() => coverPhotoInputRef?.current?.click()}
                  className="mt-2 text-sm font-semibold text-primary-700 hover:text-primary-800"
                >
                  Choose a different photo
                </button>
              </div>
              {hasSelectedCoverPhoto && onClearCoverPhoto && (
                <button
                  type="button"
                  onClick={onClearCoverPhoto}
                  aria-label="Remove selected cover photo"
                  className="rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => coverPhotoInputRef?.current?.click()}
              className="flex w-full items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-left text-gray-700 transition-colors hover:border-primary-300 hover:bg-primary-50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
                <PhotoIcon className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-sm font-semibold">Choose a hotel cover photo</span>
                <span className="mt-0.5 block text-xs text-gray-500">
                  JPG, PNG, WEBP · max 10 MB
                </span>
              </span>
            </button>
          )}

          <input
            id="existing-offer-cover-photo"
            ref={coverPhotoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onCoverPhotoChange}
            aria-label="Hotel cover photo file"
            aria-required={coverPhotoRequired}
          />
        </section>
      )}
    </div>
  );
}
