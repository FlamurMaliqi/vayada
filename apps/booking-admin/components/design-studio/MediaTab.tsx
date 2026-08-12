"use client";

import { type RefObject } from "react";
import { PhotoIcon, XMarkIcon, ArrowPathIcon } from "@heroicons/react/24/outline";

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
  logoInputRef: RefObject<HTMLInputElement>;
  handleLogoUpload: (file: File) => void;
  removeHeaderLogo: () => void;
  uploadingLogo: boolean;
  resetContent: () => void;
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
  logoInputRef,
  handleLogoUpload,
  removeHeaderLogo,
  uploadingLogo,
  resetContent,
  publicationSetup = null,
}: MediaTabProps) {
  const subtextMaxLength = publicationSetup ? 500 : 1000;
  const displayedSubtext = publicationSetup?.publicDescription ?? heroSubtext;

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

      {/* Header Logo */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 className="text-[13px] font-semibold text-gray-900">Header Logo</h2>
        <p className="text-[12px] text-gray-500 mt-0.5">
          Recommended height: 80px (renders at 40px for retina). Max width: 300px.
        </p>
        <p className="text-[11px] text-gray-400 mt-1 mb-2.5">
          PNG, SVG, or JPEG up to 500 KB. Transparent background recommended.
        </p>

        {headerLogo ? (
          <div
            data-testid="header-logo-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (uploadingLogo) return;
              const file = event.dataTransfer.files[0];
              if (file) handleLogoUpload(file);
            }}
            className="flex h-24 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-gray-100 p-3"
          >
            <img
              src={headerLogo}
              alt="Header logo preview"
              className="max-h-10 max-w-full object-contain"
            />
          </div>
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

        {headerLogo && (
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

        <p className="text-[11px] text-gray-400 mt-2">
          Make sure your logo is visible on your header background color.
        </p>
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
