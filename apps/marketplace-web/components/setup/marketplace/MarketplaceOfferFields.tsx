"use client";

import type { MutableRefObject } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import { Input, Textarea } from "@/components/ui";
import { ListingOfferings } from "@/components/profile-complete/hotel/ListingOfferings";
import { ListingRequirements } from "@/components/profile-complete/hotel/ListingRequirements";
import type { ListingFormData } from "@/lib/types";
import { canRemoveListingImage } from "@/lib/utils/listingImageState";

type MarketplaceOfferFieldsProps = {
  listings: ListingFormData[];
  countryInputs: Record<number, string>;
  countries: string[];
  imageInputRefs: MutableRefObject<(HTMLInputElement | null)[]>;
  onUpdateListing: (
    index: number,
    field: keyof ListingFormData,
    value: ListingFormData[keyof ListingFormData],
  ) => void;
  onImageChange: (listingIndex: number, event: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveImage: (listingIndex: number, imageIndex: number) => void;
  onCountryInputChange: (index: number, value: string) => void;
};

export function MarketplaceOfferFields({
  listings,
  countryInputs,
  countries,
  imageInputRefs,
  onUpdateListing,
  onImageChange,
  onRemoveImage,
  onCountryInputChange,
}: MarketplaceOfferFieldsProps) {
  if (listings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
        <p className="text-sm font-semibold text-gray-900">Your offer could not be loaded</p>
        <p className="mt-1 text-sm text-gray-500">Go back and open this step again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {listings.map((listing, index) => (
        <section
          key={listing.marketplaceOnboarding?.idempotencyKey ?? index}
          className="space-y-5 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5"
          aria-labelledby={`marketplace-offer-${index}-heading`}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">
              Collaboration offer {index + 1}
            </p>
            <h3
              id={`marketplace-offer-${index}-heading`}
              className="mt-1 text-lg font-semibold text-gray-950"
            >
              {listing.name || "Describe the creator experience"}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              Complete the offer, compensation, deliverables, and creator requirements below.
            </p>
          </div>

          <div className="space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <h4 className="text-base font-semibold text-gray-900">Offer details</h4>
            <Input
              label="Offer title"
              aria-label="Offer title"
              type="text"
              value={listing.name}
              onChange={(event) => onUpdateListing(index, "name", event.target.value)}
              required
              placeholder="Three-night creator stay in Munich"
              className="rounded-xl border-gray-200 bg-white px-3 py-2.5 focus:ring-primary-100"
            />
            <Textarea
              label="Description"
              aria-label="Description"
              value={listing.description}
              onChange={(event) => onUpdateListing(index, "description", event.target.value)}
              required
              rows={3}
              placeholder="Describe the stay and what makes the collaboration special."
              helperText="Minimum 10 characters"
              className="rounded-xl border-gray-200 bg-white px-3 py-2.5 focus:ring-primary-100"
            />

            <div>
              <label
                htmlFor={`inline-offer-photos-${index}`}
                className="mb-3 block text-sm font-semibold text-gray-700"
              >
                Offer photos <span className="text-red-500">*</span>
              </label>
              {listing.images.length > 0 ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {listing.images.slice(0, 10).map((image, imageIndex) => (
                    <div
                      key={`${image}-${imageIndex}`}
                      className="group relative aspect-square overflow-hidden rounded-lg border border-gray-200 bg-white"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={image}
                        alt={
                          imageIndex === 0
                            ? `${listing.name || "Offer"} main photo`
                            : `${listing.name || "Offer"} photo ${imageIndex + 1}`
                        }
                        className="h-full w-full object-cover"
                      />
                      {imageIndex === 0 && (
                        <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          Main
                        </span>
                      )}
                      {canRemoveListingImage(listing, imageIndex) ? (
                        <button
                          type="button"
                          onClick={() => onRemoveImage(index, imageIndex)}
                          className="absolute right-1.5 top-1.5 rounded-full bg-red-600 p-1.5 text-white opacity-100 hover:bg-red-700 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                          aria-label={`Remove photo ${imageIndex + 1}`}
                        >
                          <XMarkIcon className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <span className="sr-only">Existing saved photo</span>
                      )}
                    </div>
                  ))}
                  {listing.images.length < 10 && (
                    <button
                      type="button"
                      onClick={() => imageInputRefs.current[index]?.click()}
                      className="flex aspect-square flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white text-gray-500 hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
                    >
                      <PlusIcon className="h-5 w-5" />
                      <span className="mt-1 text-[10px] font-medium">Add more</span>
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => imageInputRefs.current[index]?.click()}
                  className="flex w-full items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white p-4 text-left hover:border-primary-300 hover:bg-primary-50"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
                    <PlusIcon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-gray-800">
                      Upload offer photos
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-500">
                      JPG, PNG, WEBP · max 10 MB each
                    </span>
                  </span>
                </button>
              )}
              {listing.marketplaceOnboarding?.existingOffer &&
              listing.images.length > listing.imageFiles.length ? (
                <p className="mt-2 text-xs leading-5 text-gray-500">
                  Existing saved photos stay in place. You can add more photos here.
                </p>
              ) : null}
              <input
                id={`inline-offer-photos-${index}`}
                ref={(element) => {
                  imageInputRefs.current[index] = element;
                }}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(event) => onImageChange(index, event)}
                multiple
                aria-required="true"
              />
            </div>
          </div>

          <ListingOfferings listing={listing} index={index} onUpdateListing={onUpdateListing} />
          <ListingRequirements
            listing={listing}
            index={index}
            countryInput={countryInputs[index] || ""}
            countries={countries}
            onUpdateListing={onUpdateListing}
            onCountryInputChange={onCountryInputChange}
          />
        </section>
      ))}
    </div>
  );
}
