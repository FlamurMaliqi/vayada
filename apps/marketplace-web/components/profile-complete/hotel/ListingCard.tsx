"use client";

import { RefObject } from "react";
import { Input, Textarea } from "@/components/ui";
import { XMarkIcon, PlusIcon, ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import type { ListingFormData } from "@/lib/types";
import { ListingOfferings } from "./ListingOfferings";
import { ListingRequirements } from "./ListingRequirements";

export type ListingCardSection = "details" | "offerings" | "requirements";

interface ListingCardProps {
  listing: ListingFormData;
  index: number;
  section: ListingCardSection;
  isCollapsed: boolean;
  countryInput: string;
  countries: string[];
  imageInputRef: RefObject<HTMLInputElement>;
  onToggleCollapse: () => void;
  onUpdateListing: (
    index: number,
    field: keyof ListingFormData,
    value: ListingFormData[keyof ListingFormData],
  ) => void;
  onImageChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveImage: (imageIndex: number) => void;
  onCountryInputChange: (index: number, value: string) => void;
}

export function ListingCard({
  listing,
  index,
  section,
  isCollapsed,
  countryInput,
  countries,
  imageInputRef,
  onToggleCollapse,
  onUpdateListing,
  onImageChange,
  onRemoveImage,
  onCountryInputChange,
}: ListingCardProps) {
  // Show completion for the section the user is currently working on.
  const isComplete =
    section === "details"
      ? Boolean(
          listing.name.trim() &&
          listing.description.trim().length >= 10 &&
          listing.images.length > 0,
        )
      : section === "offerings"
        ? Boolean(
            listing.collaborationTypes.length > 0 &&
            listing.availability.length > 0 &&
            listing.platforms.length > 0,
          )
        : listing.lookingForPlatforms.length > 0;

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${
              isComplete ? "bg-green-100 text-green-700" : "bg-primary-50 text-primary-700"
            }`}
          >
            {index + 1}
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="break-words text-base font-semibold text-gray-900">
              {listing.name || `Collaboration Offer ${index + 1}`}
            </h4>
            {isCollapsed && listing.name && (
              <p className="mt-0 text-xs text-gray-500">
                {listing.location && `${listing.location}`}{" "}
                {listing.accommodation_type && `${listing.accommodation_type}`}
              </p>
            )}
          </div>
          {isCollapsed ? (
            <ChevronDownIcon className="h-4 w-4 shrink-0 text-gray-500" />
          ) : (
            <ChevronUpIcon className="h-4 w-4 shrink-0 text-gray-500" />
          )}
        </button>
      </div>

      {!isCollapsed && (
        <div className="space-y-4">
          {/* Basic Information */}
          {section === "details" && (
            <div className="space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-5">
              <h5 className="text-base font-semibold text-gray-900">Offer details</h5>

              <Input
                label="Offer title"
                aria-label="Offer title"
                type="text"
                value={listing.name}
                onChange={(e) => onUpdateListing(index, "name", e.target.value)}
                required
                placeholder="Three-night creator stay in Munich"
                className="rounded-xl border-gray-200 bg-white px-3 py-2.5 focus:ring-primary-100"
              />

              <Textarea
                label="Description"
                aria-label="Description"
                value={listing.description}
                onChange={(e) => onUpdateListing(index, "description", e.target.value)}
                required
                rows={2}
                placeholder="A stunning beachfront villa with private pool and ocean views."
                helperText="Minimum 10 characters"
                className="rounded-xl border-gray-200 bg-white px-3 py-2.5 focus:ring-primary-100"
              />

              {/* Images */}
              <div>
                <label
                  htmlFor={`offer-photos-${index}`}
                  className="mb-3 block text-sm font-semibold text-gray-700"
                >
                  Offer photos{" "}
                  <span className="text-red-500" aria-hidden="true">
                    *
                  </span>
                  <span className="sr-only"> (required)</span>
                </label>
                {listing.images.length > 0 ? (
                  <div className="grid grid-cols-4 gap-2 md:grid-cols-5">
                    <div className="group relative aspect-square overflow-hidden rounded-lg border border-gray-200">
                      <img
                        src={listing.images[0]}
                        alt={`${listing.name} - Main photo`}
                        className="h-full w-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                      <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        Main
                      </span>
                      <button
                        type="button"
                        onClick={() => onRemoveImage(0)}
                        className="absolute right-1.5 top-1.5 rounded-full bg-red-600 p-1.5 text-white opacity-100 transition-opacity hover:bg-red-700 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                        title="Remove image"
                        aria-label="Remove main photo"
                      >
                        <XMarkIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {listing.images.slice(1, 5).map((image, imageIndex) => (
                      <div key={imageIndex + 1} className="group relative aspect-square">
                        <img
                          src={image}
                          alt={`${listing.name} - Photo ${imageIndex + 2}`}
                          className="h-full w-full rounded-lg border border-gray-200 object-cover transition-colors group-hover:border-primary-300"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => onRemoveImage(imageIndex + 1)}
                          className="absolute right-1.5 top-1.5 rounded-full bg-red-600 p-1.5 text-white opacity-100 transition-opacity hover:bg-red-700 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                          title="Remove image"
                          aria-label={`Remove photo ${imageIndex + 2}`}
                        >
                          <XMarkIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}

                    {listing.images.length < 10 && (
                      <button
                        type="button"
                        onClick={() => imageInputRef.current?.click()}
                        className="group flex aspect-square flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-50 text-gray-500 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-600"
                      >
                        <PlusIcon className="mb-1 h-5 w-5" />
                        <span className="text-[10px] font-medium">Add more</span>
                      </button>
                    )}

                    {listing.images.length > 5 && (
                      <div className="flex aspect-square items-center justify-center rounded-lg bg-gray-800/80 text-xs font-semibold text-white">
                        +{listing.images.length - 5}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="group flex w-full cursor-pointer items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-left transition-colors hover:border-primary-300 hover:bg-primary-50"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-400 transition-colors group-hover:border-primary-300 group-hover:text-primary-600">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={1.5}
                        stroke="currentColor"
                        className="h-5 w-5"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z"
                        />
                      </svg>
                    </span>
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="text-sm font-semibold text-gray-800 transition-colors group-hover:text-primary-700">
                        Upload offer photos
                      </span>
                      <span className="mt-0.5 text-xs text-gray-400">
                        JPG, PNG, WEBP · max 10 MB each
                      </span>
                      {index === 0 && (
                        <span className="mt-1 text-xs text-gray-500">
                          Your first photo also becomes your public hotel cover.
                        </span>
                      )}
                    </span>
                  </button>
                )}
                <input
                  id={`offer-photos-${index}`}
                  ref={imageInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={onImageChange}
                  multiple
                  aria-required="true"
                />
                {listing.images.length > 0 && index === 0 && (
                  <p className="mt-2 text-xs text-gray-500">
                    Your first photo also becomes your public hotel cover.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Offerings Section */}
          {section === "offerings" && (
            <ListingOfferings listing={listing} index={index} onUpdateListing={onUpdateListing} />
          )}

          {/* Looking For Section */}
          {section === "requirements" && (
            <ListingRequirements
              listing={listing}
              index={index}
              countryInput={countryInput}
              countries={countries}
              onUpdateListing={onUpdateListing}
              onCountryInputChange={onCountryInputChange}
            />
          )}
        </div>
      )}
    </div>
  );
}
