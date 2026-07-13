"use client";

import { RefObject } from "react";
import Image from "next/image";
import { Input, Textarea } from "@/components/ui";
import {
  UserIcon,
  MapPinIcon,
  LinkIcon,
  PhoneIcon,
  EnvelopeIcon,
  CameraIcon,
} from "@heroicons/react/24/outline";
import { STORAGE_KEYS } from "@/lib/constants";
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
  return (
    <div className="space-y-7">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
          Profile details
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-gray-950">Introduce yourself to hotels</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
          Add a clear photo, a short introduction, and the contact details hotels can use after a
          collaboration is accepted.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="grid content-start gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            type="text"
            value={form.name}
            onChange={(e) => onFormChange({ name: e.target.value })}
            required
            placeholder="Your full name"
            error={error && error.includes("Name") ? error : undefined}
            leadingIcon={<UserIcon className="h-5 w-5 text-gray-400" />}
            className="rounded-xl border-gray-200 bg-gray-50"
          />

          <Input
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

          <div className="space-y-1 sm:col-span-2">
            <Textarea
              label="Creator bio"
              value={form.short_description}
              onChange={(e) => onFormChange({ short_description: e.target.value })}
              required
              placeholder="Tell hotels about your content, audience, and point of view."
              rows={5}
              maxLength={500}
              error={error && error.includes("description") ? error : undefined}
              className="rounded-xl border-gray-200 bg-gray-50"
            />
            <p
              className={`mt-1 text-xs ${
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

        <div className="rounded-3xl border border-gray-100 bg-gray-50/70 p-4">
          <span className="block text-sm font-medium text-gray-700">
            Profile picture <span className="text-red-500">*</span>
          </span>
          <button
            type="button"
            className={`group relative mx-auto mt-4 flex aspect-square w-full max-w-44 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-full border-2 border-dashed transition focus:outline-none focus:ring-2 focus:ring-primary-200 ${
              profilePictureError
                ? "border-red-500 bg-red-50 hover:bg-red-50"
                : "border-gray-300 bg-white hover:border-primary-300"
            }`}
            onClick={() => imageInputRef.current?.click()}
          >
            {form.profile_image ? (
              <>
                <Image
                  src={form.profile_image}
                  alt={form.name ? `${form.name} profile preview` : "Creator profile preview"}
                  fill
                  unoptimized
                  sizes="176px"
                  className="object-cover"
                />
                <span className="absolute inset-0 flex items-center justify-center bg-gray-950/45 text-sm font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100">
                  Change photo
                </span>
              </>
            ) : (
              <>
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-50 text-primary-600">
                  <CameraIcon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="mt-3 text-sm font-semibold text-gray-950">Upload a photo</span>
                <span className="mt-1 px-4 text-center text-xs leading-5 text-gray-500">
                  JPG, PNG, or WebP
                </span>
              </>
            )}
          </button>
          <input
            type="file"
            ref={imageInputRef}
            onChange={onImageChange}
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
          />
          {profilePictureError && (
            <p className="mt-2 text-center text-xs font-medium text-red-500">
              Profile picture is required
            </p>
          )}
        </div>
      </div>

      <div className="border-t border-gray-100 pt-7">
        <h3 className="text-lg font-semibold text-gray-950">Portfolio</h3>
        <p className="mt-1 text-sm text-gray-500">Share one strong example of your work.</p>
        <Input
          label="Portfolio link"
          type="url"
          value={form.portfolio_link}
          onChange={(e) => onFormChange({ portfolio_link: e.target.value })}
          placeholder="https://your-portfolio.com"
          helperText="Optional · your website, media kit, or best-performing content"
          leadingIcon={<LinkIcon className="h-5 w-5 text-gray-400" />}
          className="mt-4 rounded-xl border-gray-200 bg-gray-50"
        />
      </div>

      <div className="space-y-4 border-t border-gray-100 pt-7">
        <div>
          <h3 className="text-lg font-semibold text-gray-950">Contact details</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-500">
            Hotels only use these details for direct communication after both sides accept a
            collaboration.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Input
            label="Email"
            type="email"
            value={
              typeof window !== "undefined"
                ? localStorage.getItem(STORAGE_KEYS.USER_EMAIL) || ""
                : ""
            }
            disabled
            required
            leadingIcon={<EnvelopeIcon className="h-5 w-5 text-gray-400" />}
            className="rounded-xl border-gray-200 bg-gray-50 text-gray-500"
          />
          <Input
            label="Phone"
            type="tel"
            required
            value={form.phone}
            onChange={(e) => onFormChange({ phone: e.target.value })}
            placeholder="+49 123 456 789"
            leadingIcon={<PhoneIcon className="h-5 w-5 text-gray-400" />}
            className="rounded-xl border-gray-200 bg-gray-50"
          />
        </div>
      </div>
    </div>
  );
}
