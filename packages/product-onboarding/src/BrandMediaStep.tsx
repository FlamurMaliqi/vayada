"use client";

import { CheckIcon, PhotoIcon } from "@heroicons/react/24/outline";
import type { ChangeEvent, DragEvent, ReactNode, RefObject } from "react";

import { BookingPagePreview } from "./BookingPagePreview";
import {
  BOOKING_PAGE_FONT_STYLESHEET_URL,
  type ColorPreset,
  type FontPairing,
} from "./bookingPageBranding";

interface BrandMediaStepProps {
  heroImage: string;
  heroHeading: string;
  setHeroHeading: (value: string) => void;
  primaryColor: string;
  setPrimaryColor: (value: string) => void;
  selectedFont: string;
  setSelectedFont: (value: string) => void;
  propertyDescription: string;
  setPropertyDescription: (value: string) => void;
  uploading: boolean;
  fileInputRef: RefObject<HTMLInputElement>;
  handleImageUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onImageFile: (file: File) => void;
  propertyName: string;
  currency: string;
  defaultLanguage: string;
  bookingUrl: string;
  error: string;
  notice?: ReactNode;
  canProceed: boolean;
  onBack: (() => void) | null;
  onContinue: () => void;
  continueLabel: string;
  continuingLabel: string;
  submitting: boolean;
  colorPresets: readonly ColorPreset[];
  fontPairings: readonly FontPairing[];
  imageRecommendation: string;
  subtextMaxLength: number;
  subtextPlaceholder: string;
  onResetSubtext: () => void;
}

export default function BrandMediaStep({
  bookingUrl,
  canProceed,
  colorPresets,
  continueLabel,
  continuingLabel,
  currency,
  defaultLanguage,
  error,
  fileInputRef,
  fontPairings,
  handleImageUpload,
  heroHeading,
  heroImage,
  imageRecommendation,
  notice,
  onBack,
  onContinue,
  onImageFile,
  onResetSubtext,
  primaryColor,
  propertyDescription,
  propertyName,
  selectedFont,
  setHeroHeading,
  setPrimaryColor,
  setPropertyDescription,
  setSelectedFont,
  submitting,
  subtextMaxLength,
  subtextPlaceholder,
  uploading,
}: BrandMediaStepProps) {
  const currentFont = fontPairings.find((font) => font.id === selectedFont) ?? fontPairings[0];
  if (!currentFont) throw new Error("At least one booking page font pairing is required.");

  const receiveDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) onImageFile(file);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <link href={BOOKING_PAGE_FONT_STYLESHEET_URL} rel="stylesheet" />
      <div className="flex min-h-0 w-full flex-1 flex-col gap-5 lg:flex-row">
        <div className="flex w-full min-w-0 flex-col lg:w-[360px] lg:shrink-0">
          <div className="space-y-3 lg:max-h-[620px] lg:overflow-y-auto lg:pr-1">
            <section className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">
                Hero Image<span className="text-red-600"> *</span>
              </h2>
              <p className="mb-2.5 mt-0.5 text-[12px] text-gray-500">{imageRecommendation}</p>
              <div
                data-testid="booking-hero-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={receiveDrop}
              >
                {heroImage ? (
                  <div className="relative overflow-hidden rounded-xl bg-gray-100">
                    <img alt="Hero preview" className="h-36 w-full object-cover" src={heroImage} />
                    {uploading ? (
                      <div className="absolute inset-0 flex items-center justify-center bg-gray-950/35">
                        <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <button
                    aria-label="Upload hero image"
                    className="flex h-36 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 text-gray-500 transition hover:border-primary-500 hover:text-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    <PhotoIcon className="h-7 w-7" />
                    <span className="text-[12px] font-medium">Drop image or click to upload</span>
                  </button>
                )}
              </div>
              <input
                accept="image/jpeg,image/png,image/webp"
                aria-label="Hero image"
                aria-required="true"
                className="hidden"
                onChange={handleImageUpload}
                ref={fileInputRef}
                type="file"
              />
              {heroImage ? (
                <button
                  className="mt-2 w-full rounded-lg border border-gray-300 py-2 text-[12px] font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  Replace Image
                </button>
              ) : null}
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">Hero Text</h2>
              <p className="mb-3 mt-0.5 text-[12px] text-gray-500">
                Customize the heading and tagline guests see first.
              </p>
              <div className="space-y-3">
                <label className="block text-[12px] font-medium text-gray-700">
                  Heading<span className="text-red-600"> *</span>
                  <input
                    aria-label="Hero heading"
                    className="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100"
                    maxLength={160}
                    onChange={(event) => setHeroHeading(event.target.value)}
                    placeholder={propertyName || "Your hotel name"}
                    required
                    type="text"
                    value={heroHeading}
                  />
                </label>
                <label className="block text-[12px] font-medium text-gray-700">
                  Subtext<span className="text-red-600"> *</span>
                  <textarea
                    aria-label="Hero subtext"
                    className="mt-1 min-h-24 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none placeholder:text-gray-500 focus:border-primary-600 focus:ring-2 focus:ring-primary-100"
                    maxLength={subtextMaxLength}
                    onChange={(event) => setPropertyDescription(event.target.value)}
                    placeholder={subtextPlaceholder}
                    required
                    value={propertyDescription}
                  />
                  <span className="mt-1 block text-right text-[11px] text-gray-500">
                    {propertyDescription.length}/{subtextMaxLength} characters
                  </span>
                </label>
                <button
                  className="w-full rounded-lg border border-gray-200 py-2 text-[12px] font-medium text-gray-600 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
                  onClick={onResetSubtext}
                  type="button"
                >
                  Reset to Default
                </button>
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">Color Profile</h2>
              <p className="mb-3 mt-0.5 text-[12px] text-gray-500">
                Set the color used for buttons, links, and accents.
              </p>
              <div className="flex items-center gap-2">
                <label
                  className="h-9 w-9 shrink-0 cursor-pointer rounded-full border border-gray-300"
                  style={{ backgroundColor: primaryColor }}
                >
                  <input
                    aria-label="Primary brand color picker"
                    className="h-0 w-0 opacity-0"
                    onChange={(event) => setPrimaryColor(event.target.value)}
                    type="color"
                    value={primaryColor}
                  />
                </label>
                <input
                  aria-label="Primary brand color"
                  className="min-h-10 w-28 rounded-lg border border-gray-300 px-2 py-2 text-[12px] text-gray-900 outline-none focus:border-primary-600 focus:ring-2 focus:ring-primary-100"
                  maxLength={7}
                  onChange={(event) => setPrimaryColor(event.target.value)}
                  pattern="#[0-9A-Fa-f]{6}"
                  value={primaryColor}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {colorPresets.map((preset) => (
                  <button
                    aria-pressed={primaryColor === preset.primary}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] text-gray-700 transition ${
                      primaryColor === preset.primary
                        ? "border-primary-500 bg-primary-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                    key={preset.name}
                    onClick={() => setPrimaryColor(preset.primary)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 rounded-full border border-gray-200"
                      style={{ backgroundColor: preset.primary }}
                    />
                    {preset.name}
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">Typography</h2>
              <p className="mb-3 mt-0.5 text-[12px] text-gray-500">Select a font pairing.</p>
              <div className="space-y-2">
                {fontPairings.map((pairing) => (
                  <button
                    aria-pressed={selectedFont === pairing.id}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition ${
                      selectedFont === pairing.id
                        ? "border-primary-500 bg-primary-50 ring-1 ring-primary-500"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                    key={pairing.id}
                    onClick={() => setSelectedFont(pairing.id)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1 text-[12px] font-semibold text-gray-900">
                        {pairing.name}
                        {selectedFont === pairing.id ? (
                          <CheckIcon className="h-3.5 w-3.5 text-primary-600" />
                        ) : null}
                      </span>
                      <span className="block text-[11px] text-gray-500">{pairing.fonts}</span>
                    </span>
                    <span
                      className="shrink-0 text-right text-[13px] text-gray-700"
                      style={{ fontFamily: pairing.headingFamily }}
                    >
                      {pairing.preview}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          {notice ? (
            <div
              className="mt-3 rounded-xl border border-primary-200 bg-primary-50 p-3 text-[12px] text-primary-900"
              role="status"
            >
              {notice}
            </div>
          ) : null}
          {error ? (
            <div
              className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] font-medium text-red-800"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            {onBack ? (
              <button
                className="min-h-11 rounded-full border border-gray-300 px-6 py-2.5 text-[13px] font-semibold text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2"
                disabled={submitting}
                onClick={onBack}
                type="button"
              >
                Back
              </button>
            ) : (
              <span />
            )}
            <button
              className="min-h-11 rounded-full bg-primary-600 px-6 py-2.5 text-[13px] font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canProceed || submitting}
              onClick={onContinue}
              type="button"
            >
              {submitting ? continuingLabel : continueLabel}
            </button>
          </div>
        </div>

        <BookingPagePreview
          bookingUrl={bookingUrl}
          className="min-w-0 flex-1 lg:sticky lg:top-4 lg:self-start"
          currency={currency}
          defaultLanguage={defaultLanguage}
          font={currentFont}
          heroHeading={heroHeading}
          heroImage={heroImage}
          heroSubtext={propertyDescription}
          primaryColor={primaryColor}
          propertyName={propertyName}
        />
      </div>
    </div>
  );
}
