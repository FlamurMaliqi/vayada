"use client";

import { type RefObject, useState } from "react";
import Image from "next/image";
import { Input, Textarea } from "@/components/ui";
import {
  CameraIcon,
  CheckCircleIcon,
  LinkIcon,
  MapPinIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import type { CreatorFormState } from "@/lib/types";

interface CreatorBasicInfoStepProps {
  form: CreatorFormState;
  onFormChange: (updates: Partial<CreatorFormState>) => void;
  error: string;
  imageInputRef: RefObject<HTMLInputElement>;
  onImageChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function CreatorBasicInfoStep({
  form,
  onFormChange,
  error,
  imageInputRef,
  onImageChange,
}: CreatorBasicInfoStepProps) {
  const profilePictureError =
    !!error && error.toLowerCase().includes("profile picture") && !form.profile_image;
  const profilePictureErrorId = "creator-profile-picture-error";
  const [showFallbackName] = useState(() => !form.name.trim());
  const canRenderProfilePicture =
    form.profile_image.startsWith("https://") || form.profile_image.startsWith("data:image/");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
            About your work
          </p>
          <h2 className="mt-1.5 text-xl font-semibold text-gray-950 sm:text-2xl">
            What makes your content stand out?
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-6 text-gray-600">
            Share your point of view and one strong example. We already saved your account and
            contact details.
          </p>
        </div>

        {form.profile_image && (
          <div className="flex shrink-0 items-center gap-3 rounded-2xl border border-primary-100 bg-primary-50/60 px-3 py-2.5 text-left sm:min-w-56">
            <div className="relative h-11 w-11 overflow-hidden rounded-full bg-white ring-2 ring-white">
              {canRenderProfilePicture ? (
                <Image
                  src={form.profile_image}
                  alt={form.name ? `${form.name} profile photo` : "Creator profile photo"}
                  fill
                  unoptimized
                  sizes="44px"
                  className="object-cover"
                />
              ) : (
                <span
                  role="img"
                  aria-label="Saved creator profile photo"
                  data-testid="creator-photo-placeholder"
                  className="flex h-full w-full items-center justify-center text-primary-600"
                >
                  <UserCircleIcon className="h-8 w-8" aria-hidden="true" />
                </span>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-950">
                {form.name || "Your profile"}
              </p>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-primary-700">
                <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
                Account details saved
              </p>
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                className="mt-1 text-xs font-semibold text-primary-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300"
              >
                Change photo
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(260px,0.7fr)]">
        <div className="space-y-4 rounded-2xl border border-gray-100 bg-gray-50/60 p-4 sm:p-5">
          {showFallbackName && (
            <Input
              id="creator-name"
              aria-label="Name"
              label="Name"
              type="text"
              value={form.name}
              onChange={(e) => onFormChange({ name: e.target.value })}
              required
              placeholder="Your full name"
              error={error && error.includes("Name") ? error : undefined}
              className="rounded-xl border-gray-200 bg-white"
            />
          )}
          <div className="space-y-1">
            <Textarea
              id="creator-bio"
              aria-label="Creator bio"
              label="Creator bio"
              value={form.short_description}
              onChange={(e) => onFormChange({ short_description: e.target.value })}
              required
              placeholder="Tell hotels about your content, audience, and point of view."
              rows={7}
              maxLength={500}
              error={error && error.includes("description") ? error : undefined}
              className="rounded-xl border-gray-200 bg-white"
            />
            <p
              className={`text-xs ${
                form.short_description.trim().length >= 10
                  ? "text-emerald-600"
                  : form.short_description.trim().length > 0
                    ? "text-red-500"
                    : "text-gray-500"
              }`}
            >
              {form.short_description.length}/500 characters
              {form.short_description.trim().length > 0 &&
                form.short_description.trim().length < 10 && <span> · minimum 10 characters</span>}
            </p>
          </div>
        </div>

        <div className="grid content-start gap-4 rounded-2xl border border-gray-100 bg-white p-4 sm:p-5">
          <Input
            id="creator-location"
            aria-label="Location"
            label="Location"
            type="text"
            value={form.location}
            onChange={(e) => onFormChange({ location: e.target.value })}
            required
            placeholder="e.g. Berlin, Germany"
            error={error && error.includes("Location") ? error : undefined}
            leadingIcon={<MapPinIcon className="h-5 w-5 text-gray-400" />}
            className="rounded-xl border-gray-200 bg-gray-50"
          />

          <Input
            id="creator-portfolio"
            aria-label="Portfolio link"
            label="Portfolio link"
            type="url"
            value={form.portfolio_link}
            onChange={(e) => onFormChange({ portfolio_link: e.target.value })}
            placeholder="https://your-portfolio.com"
            helperText="Optional · website, media kit, or featured content"
            leadingIcon={<LinkIcon className="h-5 w-5 text-gray-400" />}
            className="rounded-xl border-gray-200 bg-gray-50"
          />

          {!form.profile_image && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3">
              <p className="text-sm font-semibold text-gray-950">Add your creator photo</p>
              <p className="mt-1 text-xs leading-5 text-gray-600">
                We could not find a photo on your account. Add a JPG, PNG, or WebP up to 5 MB.
              </p>
              <button
                type="button"
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-3 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-primary-200 ${
                  profilePictureError
                    ? "border-red-500 bg-red-50 text-red-700"
                    : "border-gray-300 bg-white text-primary-700 hover:border-primary-300"
                }`}
                onClick={() => imageInputRef.current?.click()}
                aria-describedby={profilePictureError ? profilePictureErrorId : undefined}
              >
                <CameraIcon className="h-5 w-5" aria-hidden="true" />
                Upload photo
              </button>
              {profilePictureError && (
                <p id={profilePictureErrorId} className="mt-2 text-xs font-medium text-red-600">
                  {error}
                </p>
              )}
            </div>
          )}

          <input
            type="file"
            ref={imageInputRef}
            onChange={onImageChange}
            accept="image/jpeg,image/png,image/webp"
            aria-label="Creator profile photo file"
            aria-invalid={profilePictureError || undefined}
            aria-describedby={profilePictureError ? profilePictureErrorId : undefined}
            className="hidden"
          />
        </div>
      </div>
    </div>
  );
}
