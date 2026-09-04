"use client";

import { type RefObject, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PhotoIcon,
  PlusIcon,
  XMarkIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import { MAX_PROPERTY_GALLERY_PHOTOS } from "@/lib/utils/uploadImage";
import { ToggleSwitch } from "@/components/ui";

export type PropertyGalleryImage = {
  mediaObjectId: string;
  url: string;
  altText: string | null;
};

interface MediaTabProps {
  heroImage: string;
  setHeroImage: (v: string) => void;
  heroHeading: string;
  setHeroHeading: (v: string) => void;
  heroSubtext: string;
  setHeroSubtext: (v: string) => void;
  fileInputRef: RefObject<HTMLInputElement>;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removeHeroImage: () => void;
  headerLogo: string;
  headerLogoUrl: string;
  logoInputRef: RefObject<HTMLInputElement>;
  handleLogoUpload: (file: File) => void;
  addHeaderLogoUrl: () => void;
  setHeaderLogoUrl: (value: string) => void;
  removeHeaderLogo: () => void;
  uploadingLogo: boolean;
  showContactButton: boolean;
  setShowContactButton: (value: boolean) => void;
  showReferAGuestButton: boolean;
  setShowReferAGuestButton: (value: boolean) => void;
  referAGuestModuleEnabled: boolean | null;
  showLanguageSelector: boolean;
  setShowLanguageSelector: (value: boolean) => void;
  showCurrencySelector: boolean;
  setShowCurrencySelector: (value: boolean) => void;
  resetContent: () => void;
  galleryImages: PropertyGalleryImage[];
  galleryAtCapacity: boolean;
  galleryBusy: boolean;
  addGalleryImages: (files: File[]) => void;
  removeGalleryImage: (index: number) => void;
  reorderGalleryImage: (sourceIndex: number, targetIndex: number) => void;
  publicationSetup?: {
    localityPublic: boolean;
    hasCanonicalPublicMedia: boolean;
    publicDescription: string;
    onLocalityPublicChange: (value: boolean) => void;
    onPublicDescriptionChange: (value: string) => void;
  } | null;
}

export default function MediaTab({
  heroImage,
  setHeroHeading,
  setHeroSubtext,
  heroHeading,
  heroSubtext,
  fileInputRef,
  handleImageUpload,
  removeHeroImage,
  headerLogo,
  headerLogoUrl,
  logoInputRef,
  handleLogoUpload,
  addHeaderLogoUrl,
  setHeaderLogoUrl,
  removeHeaderLogo,
  uploadingLogo,
  showContactButton,
  setShowContactButton,
  showReferAGuestButton,
  setShowReferAGuestButton,
  referAGuestModuleEnabled,
  showLanguageSelector,
  setShowLanguageSelector,
  showCurrencySelector,
  setShowCurrencySelector,
  resetContent,
  galleryImages,
  galleryAtCapacity,
  galleryBusy,
  addGalleryImages,
  removeGalleryImage,
  reorderGalleryImage,
  publicationSetup = null,
}: MediaTabProps) {
  const subtextMaxLength = publicationSetup ? 500 : 1000;
  const displayedSubtext = publicationSetup?.publicDescription ?? heroSubtext;
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const [draggingPhoto, setDraggingPhoto] = useState<number | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [logoActionsOpen, setLogoActionsOpen] = useState(false);
  const canAddGalleryImages =
    !galleryAtCapacity && galleryImages.length < MAX_PROPERTY_GALLERY_PHOTOS && !galleryBusy;

  const chooseGalleryFiles = (files: FileList | null) => {
    if (!files || !canAddGalleryImages) return;
    addGalleryImages(Array.from(files));
  };

  return (
    <>
      {publicationSetup && (
        <div className="rounded-lg border border-primary-200 bg-primary-50 p-4">
          <h2 className="text-[13px] font-semibold text-gray-900">Public booking profile</h2>
          <p className="mt-1 text-[12px] leading-5 text-gray-600">
            Add the description, approved hero image, and locality guests need before your booking
            page can go live.
          </p>
          <label className="mt-3 flex items-start gap-2 text-[12px] leading-5 text-gray-700">
            <input
              type="checkbox"
              checked={publicationSetup.localityPublic}
              onChange={(event) => publicationSetup.onLocalityPublicChange(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            Show the hotel&apos;s city and country on the public booking page
          </label>
          {!publicationSetup.hasCanonicalPublicMedia && (
            <p className="mt-2 text-[12px] font-medium leading-5 text-amber-800">
              Upload a hero image here so Vayada can approve it for the public booking profile.
            </p>
          )}
        </div>
      )}

      {/* Hero Image */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">
          Hero Image <span className="text-red-500">*</span>
        </h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">1920x1080 recommended</p>

        {heroImage ? (
          <div className="relative rounded-lg overflow-hidden bg-gray-200">
            <img
              src={heroImage}
              alt="Hero"
              className="w-full h-36 object-cover"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <button
              onClick={removeHeroImage}
              className="absolute top-1.5 right-1.5 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors"
            >
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full h-36 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
          >
            <PhotoIcon className="w-6 h-6" />
            <span className="text-[12px]">Click to upload</span>
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageUpload}
          className="hidden"
        />

        {heroImage && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 w-full py-1.5 text-[12px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Replace Image
          </button>
        )}
      </div>

      {/* Property Gallery */}
      <div
        className={`bg-white rounded-lg border p-4 transition-colors ${draggingFiles ? "border-primary-400 bg-primary-50/40" : "border-gray-200"}`}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files") && canAddGalleryImages) {
            event.preventDefault();
            setDraggingFiles(true);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files") && canAddGalleryImages) {
            event.preventDefault();
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDraggingFiles(false);
          }
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDraggingFiles(false);
          chooseGalleryFiles(event.dataTransfer.files);
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold text-gray-900">Property Gallery</h2>
            <p className="mt-0.5 text-[12px] leading-5 text-gray-500">
              Showcase your property with up to 10 photos. Guests can view these from the gallery
              icon on your hero image.
            </p>
          </div>
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-gray-400">
            {galleryImages.length}/{MAX_PROPERTY_GALLERY_PHOTOS}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {galleryImages.map((image, index) => (
            <div
              key={image.mediaObjectId}
              draggable={!galleryBusy}
              onDragStart={(event) => {
                setDraggingPhoto(index);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDraggingPhoto(null)}
              onDragOver={(event) => {
                if (draggingPhoto !== null) event.preventDefault();
              }}
              onDrop={(event) => {
                if (draggingPhoto === null) return;
                event.preventDefault();
                reorderGalleryImage(draggingPhoto, index);
                setDraggingPhoto(null);
              }}
              className={`group relative aspect-[4/3] overflow-hidden rounded-lg border bg-gray-100 transition ${draggingPhoto === index ? "border-primary-400 opacity-50" : "border-gray-200"}`}
            >
              <img src={image.url} alt="" className="h-full w-full object-cover" />
              {index === 0 && (
                <span className="absolute bottom-1.5 left-1.5 rounded bg-gray-950/80 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white">
                  COVER
                </span>
              )}
              <button
                type="button"
                onClick={() => removeGalleryImage(index)}
                disabled={galleryBusy}
                aria-label={`Remove property photo ${index + 1}`}
                className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-gray-950/75 text-white transition hover:bg-red-600 disabled:opacity-50"
              >
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
              <div className="absolute bottom-1.5 right-1.5 flex overflow-hidden rounded bg-gray-950/75 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => reorderGalleryImage(index, index - 1)}
                  disabled={galleryBusy || index === 0}
                  aria-label={`Move property photo ${index + 1} earlier`}
                  className="flex h-7 w-7 items-center justify-center text-white transition hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => reorderGalleryImage(index, index + 1)}
                  disabled={galleryBusy || index === galleryImages.length - 1}
                  aria-label={`Move property photo ${index + 1} later`}
                  className="flex h-7 w-7 items-center justify-center text-white transition hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          {galleryImages.length > 0 && canAddGalleryImages && (
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-gray-300 text-gray-400 transition hover:border-primary-400 hover:text-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
            >
              <PlusIcon className="h-5 w-5" />
              <span className="text-[11px] font-medium">Add</span>
            </button>
          )}
        </div>

        {galleryImages.length === 0 && (
          <button
            type="button"
            onClick={() => galleryInputRef.current?.click()}
            disabled={!canAddGalleryImages}
            className="mt-3 flex h-20 w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 text-[12px] text-gray-500 transition hover:border-primary-400 hover:text-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PhotoIcon className="h-5 w-5" />
            Click or drag photos here
          </button>
        )}

        <input
          ref={galleryInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className="hidden"
          onChange={(event) => {
            chooseGalleryFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <p className="mt-2 text-[11px] leading-4 text-gray-400">
          Landscape photos work best. Recommended: 1920×1080.
        </p>
        {galleryBusy && (
          <p className="mt-1 text-[11px] font-medium text-primary-600" role="status">
            Saving gallery…
          </p>
        )}
      </div>

      {/* Header */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">Header</h2>
        <h3 className="mt-3 text-[12px] font-medium text-gray-800">Header logo</h3>

        {headerLogo ? (
          <button
            type="button"
            data-testid="header-logo-dropzone"
            aria-label="Manage header logo"
            onClick={() => setLogoActionsOpen((open) => !open)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (uploadingLogo) return;
              const file = event.dataTransfer.files[0];
              if (file) handleLogoUpload(file);
            }}
            className="flex h-24 w-full items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-100 p-3"
          >
            <img
              src={headerLogo}
              alt="Header logo preview"
              className="max-h-10 max-w-full object-contain"
            />
          </button>
        ) : (
          <button
            type="button"
            data-testid="header-logo-dropzone"
            onClick={() => logoInputRef.current?.click()}
            disabled={uploadingLogo}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (uploadingLogo) return;
              const file = event.dataTransfer.files[0];
              if (file) handleLogoUpload(file);
            }}
            className="w-full h-24 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
          >
            <PhotoIcon className="w-6 h-6" />
            <span className="text-[12px]">Click or drag to upload</span>
          </button>
        )}

        <input
          ref={logoInputRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,.svg"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleLogoUpload(file);
          }}
          className="hidden"
        />

        <div className="mt-2 flex gap-2">
          <input
            type="url"
            aria-label="Header logo URL"
            value={headerLogoUrl}
            onChange={(event) => setHeaderLogoUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addHeaderLogoUrl();
            }}
            placeholder="https://…"
            disabled={uploadingLogo}
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1.5 text-[12px] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50"
          />
          <button
            type="button"
            onClick={addHeaderLogoUrl}
            disabled={uploadingLogo || !headerLogoUrl.trim()}
            className="rounded-lg bg-primary-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>

        {headerLogo && logoActionsOpen && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => logoInputRef.current?.click()}
              disabled={uploadingLogo}
              className="py-1.5 text-[12px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              Replace logo
            </button>
            <button
              type="button"
              onClick={removeHeaderLogo}
              disabled={uploadingLogo}
              className="py-1.5 text-[12px] text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              Remove logo
            </button>
          </div>
        )}

        <p className="mt-2 text-[11px] leading-4 text-gray-400">
          PNG, SVG, or JPEG up to 500KB. 80px tall, max 300px wide, transparent background
          recommended. Make sure it&apos;s visible on your header background color.
        </p>

        <div className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
          <ToggleSwitch
            enabled={showContactButton}
            onChange={() => setShowContactButton(!showContactButton)}
            label="Contact button"
          />
          <div
            title={
              referAGuestModuleEnabled
                ? undefined
                : referAGuestModuleEnabled === false
                  ? "Enable Refer a Guest in Feature Hub first."
                  : "Feature Hub status is unavailable."
            }
          >
            <ToggleSwitch
              enabled={Boolean(referAGuestModuleEnabled && showReferAGuestButton)}
              onChange={() => setShowReferAGuestButton(!showReferAGuestButton)}
              label="Refer a Guest button"
              description="Tied to Feature Hub activation."
              disabled={!referAGuestModuleEnabled}
            />
          </div>
          <ToggleSwitch
            enabled={showLanguageSelector}
            onChange={() => setShowLanguageSelector(!showLanguageSelector)}
            label="Language selector"
            description="Hidden automatically when only one language is configured."
          />
          <ToggleSwitch
            enabled={showCurrencySelector}
            onChange={() => setShowCurrencySelector(!showCurrencySelector)}
            label="Currency selector"
            description="Hidden automatically when only one currency is configured."
          />
        </div>
      </div>

      {/* Text Overrides */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">Hero Text</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">Customize heading and subtext</p>

        <div className="space-y-2.5">
          <div>
            <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Heading</label>
            <input
              type="text"
              aria-label="Hero heading"
              value={heroHeading}
              onChange={(e) => setHeroHeading(e.target.value)}
              maxLength={160}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              placeholder="Enter hero heading"
            />
          </div>
          <div>
            <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
              {publicationSetup ? "Public description" : "Subtext"}
            </label>
            <textarea
              aria-label={publicationSetup ? "Public description" : "Hero subtext"}
              value={displayedSubtext}
              onChange={(event) =>
                publicationSetup
                  ? publicationSetup.onPublicDescriptionChange(event.target.value)
                  : setHeroSubtext(event.target.value)
              }
              maxLength={subtextMaxLength}
              rows={3}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
              placeholder="Enter hero subtext"
            />
            <p className="text-[11px] text-gray-400 mt-0.5">
              {displayedSubtext.length}/{subtextMaxLength} characters
            </p>
          </div>
          <button
            onClick={resetContent}
            className="w-full py-1.5 text-[12px] text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors flex items-center justify-center gap-1"
          >
            <ArrowPathIcon className="w-3 h-3" />
            Reset to Default
          </button>
        </div>
      </div>
    </>
  );
}
