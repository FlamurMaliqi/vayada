"use client";

import { RefObject } from "react";
import { PhotoIcon, XMarkIcon, CheckIcon } from "@heroicons/react/24/outline";

export interface ColorPreset {
  name: string;
  primary: string;
  accent?: string;
}

export interface FontPairing {
  id: string;
  name: string;
  fonts: string;
  preview: string;
  headingFamily: string;
  bodyFamily: string;
}

interface BrandMediaStepProps {
  heroImage: string;
  setHeroImage: (v: string) => void;
  primaryColor: string;
  setPrimaryColor: (v: string) => void;
  accentColor?: string;
  setAccentColor?: (v: string) => void;
  selectedFont: string;
  setSelectedFont: (v: string) => void;
  propertyDescription: string;
  setPropertyDescription: (v: string) => void;
  uploading: boolean;
  fileInputRef: RefObject<HTMLInputElement>;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  propertyName: string;
  currency: string;
  defaultLanguage: string;
  error: string;
  canProceed: boolean;
  onBack: () => void;
  onContinue: () => void;
  stepIndicators: React.ReactNode;
  colorPresets: ColorPreset[];
  fontPairings: FontPairing[];
  formatPrice?: (amount: number, currency: string) => string;
}

const defaultFormatPrice = (amount: number, currency: string) => `${currency} ${amount}`;

export default function BrandMediaStep({
  heroImage,
  setHeroImage,
  primaryColor,
  setPrimaryColor,
  accentColor,
  setAccentColor,
  selectedFont,
  setSelectedFont,
  propertyDescription,
  setPropertyDescription,
  uploading,
  fileInputRef,
  handleImageUpload,
  propertyName,
  currency,
  defaultLanguage,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
  colorPresets,
  fontPairings,
  formatPrice = defaultFormatPrice,
}: BrandMediaStepProps) {
  const currentFont = fontPairings.find((f) => f.id === selectedFont) || fontPairings[0];
  const showAccentPicker = accentColor !== undefined && setAccentColor !== undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto lg:overflow-visible">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6 w-full shrink-0">{stepIndicators}</div>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-5 flex flex-col lg:flex-row gap-5 flex-1 min-h-0 w-full">
        {/* LEFT: Controls panel */}
        <div className="w-full lg:w-[380px] lg:shrink-0 flex flex-col lg:min-h-0">
          <div className="flex-1 lg:overflow-y-auto space-y-3 pb-3">
            {/* Hero Image */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">
                Hero Image <span className="text-red-500">*</span>
              </h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">1920x800px recommended</p>

              {heroImage ? (
                <div className="relative rounded-lg overflow-hidden">
                  <img src={heroImage} alt="Hero" className="w-full h-36 object-cover" />
                  {uploading && (
                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  <button
                    onClick={() => {
                      setHeroImage("");
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
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
                  <span className="text-[12px]">Drop image or click to upload</span>
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

            {/* Colour Profile */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">Colour Profile</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Define your brand colors</p>

              <div className="space-y-4">
                <div>
                  <h3 className="text-[12px] font-semibold text-gray-900">Primary Brand Color</h3>
                  <p className="text-[11px] text-gray-500 mt-0.5 mb-1.5">
                    Buttons, links, and accents
                  </p>
                  <div className="flex items-center gap-2">
                    <label
                      className="w-8 h-8 rounded-full border border-gray-200 cursor-pointer shrink-0"
                      style={{ backgroundColor: primaryColor }}
                    >
                      <input
                        type="color"
                        value={primaryColor}
                        onChange={(e) => setPrimaryColor(e.target.value)}
                        className="opacity-0 w-0 h-0"
                      />
                    </label>
                    <input
                      type="text"
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      className="w-24 px-2 py-1 border border-gray-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                    />
                  </div>
                </div>

                {showAccentPicker && (
                  <div>
                    <h3 className="text-[12px] font-semibold text-gray-900">Background Accent</h3>
                    <p className="text-[11px] text-gray-500 mt-0.5 mb-1.5">
                      Card and section backgrounds
                    </p>
                    <div className="flex items-center gap-2">
                      <label
                        className="w-8 h-8 rounded-full border border-gray-200 cursor-pointer shrink-0"
                        style={{ backgroundColor: accentColor }}
                      >
                        <input
                          type="color"
                          value={accentColor}
                          onChange={(e) => setAccentColor!(e.target.value)}
                          className="opacity-0 w-0 h-0"
                        />
                      </label>
                      <input
                        type="text"
                        value={accentColor}
                        onChange={(e) => setAccentColor!(e.target.value)}
                        className="w-24 px-2 py-1 border border-gray-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                      />
                    </div>
                  </div>
                )}

                {/* Quick Presets */}
                <div>
                  <h3 className="text-[12px] font-semibold text-gray-900 mb-1.5">Quick Presets</h3>
                  <div className="grid grid-cols-2 gap-1.5">
                    {colorPresets.map((preset) => (
                      <button
                        key={preset.name}
                        onClick={() => {
                          setPrimaryColor(preset.primary);
                          if (showAccentPicker && preset.accent) {
                            setAccentColor!(preset.accent);
                          }
                        }}
                        className={`flex items-center gap-2 px-2.5 py-1.5 border rounded-lg text-[12px] text-gray-700 hover:bg-gray-50 transition-colors ${
                          primaryColor === preset.primary
                            ? "border-primary-500 bg-primary-50/30"
                            : "border-gray-200"
                        }`}
                      >
                        <span
                          className="w-4 h-4 rounded-full shrink-0 border border-gray-200"
                          style={{ backgroundColor: preset.primary }}
                        />
                        {preset.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Typography */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">Typography</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Select a font pairing</p>

              <div className="space-y-1.5">
                {fontPairings.map((pairing) => (
                  <button
                    key={pairing.id}
                    onClick={() => setSelectedFont(pairing.id)}
                    className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                      selectedFont === pairing.id
                        ? "border-primary-500 bg-primary-50/30 ring-1 ring-primary-500"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="text-[12px] font-semibold text-gray-900">
                          {pairing.name}
                        </span>
                        {selectedFont === pairing.id && (
                          <CheckIcon className="w-3.5 h-3.5 text-primary-500" />
                        )}
                      </div>
                      <span className="text-[11px] text-gray-500">{pairing.fonts}</span>
                    </div>
                    <span
                      className="text-sm text-gray-600"
                      style={{ fontFamily: pairing.headingFamily }}
                    >
                      {pairing.preview}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Property Description */}
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h2 className="text-[13px] font-semibold text-gray-900">Property Description</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">
                Shown below your property name on the booking page
              </p>
              <textarea
                value={propertyDescription}
                onChange={(e) => {
                  if (e.target.value.length <= 1000) setPropertyDescription(e.target.value);
                }}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 resize-none"
                placeholder="A boutique escape featuring private pools, ocean views, and tranquil luxury..."
              />
              <p className="text-[11px] text-gray-400 mt-1 text-right">
                {propertyDescription.length}/1000 characters
              </p>
            </div>
          </div>

          {/* Bottom buttons */}
          <div className="mt-6 shrink-0 flex items-center justify-between gap-3">
            <button
              onClick={onBack}
              className="px-5 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Back
            </button>
            <button
              onClick={onContinue}
              disabled={!canProceed}
              className="px-5 py-2 bg-primary-500 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Continue
            </button>
          </div>

          {error && (
            <div className="mt-2 bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-[12px] text-red-700 font-medium">{error}</p>
            </div>
          )}
        </div>

        {/* RIGHT: Live preview */}
        <div className="flex-1 min-w-0 bg-white rounded-lg border border-gray-200 flex flex-col min-h-[500px] lg:min-h-0">
          {/* Browser chrome bar */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 shrink-0 bg-gray-50">
            <div className="flex gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
            </div>
            <div className="flex-1 bg-white rounded-md px-3 py-0.5 text-[11px] text-gray-500 text-center truncate border border-gray-200">
              yourhotel.vayada.com
            </div>
          </div>

          {/* Preview content */}
          <div
            className="flex-1 overflow-y-auto bg-white"
            style={{ fontFamily: currentFont.bodyFamily }}
          >
            {/* Hero section */}
            <div className="relative h-[280px] w-full">
              {heroImage ? (
                <img src={heroImage} alt="Hero" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gray-300" />
              )}
              <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

              {/* Navigation */}
              <div className="absolute top-0 left-0 right-0 z-10">
                <div className="flex items-center justify-between px-4 h-10">
                  <span
                    className="text-[11px] font-semibold text-white"
                    style={{ fontFamily: currentFont.bodyFamily }}
                  >
                    {propertyName || "Your Hotel"}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span
                      className="px-2.5 py-0.5 text-[9px] font-semibold text-white rounded-full"
                      style={{ backgroundColor: primaryColor }}
                    >
                      Contact
                    </span>
                    <span className="px-2.5 py-0.5 text-[9px] font-semibold text-white rounded-full border border-white/60">
                      Refer a Guest
                    </span>
                    <span className="px-2 py-0.5 text-[9px] font-semibold text-white rounded-full border border-white/60">
                      {defaultLanguage.toUpperCase()}
                    </span>
                    <span className="px-2 py-0.5 text-[9px] font-semibold text-white rounded-full border border-white/60">
                      {currency}
                    </span>
                  </div>
                </div>
              </div>

              {/* Hero content */}
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
                <h2
                  className="text-2xl italic text-white mb-1.5"
                  style={{ fontFamily: currentFont.headingFamily }}
                >
                  {propertyName || "Your Hotel Name"}
                </h2>
                <p
                  className="text-[11px] text-white/90 leading-relaxed max-w-sm"
                  style={{ fontFamily: currentFont.bodyFamily }}
                >
                  {propertyDescription || "Your hotel description will appear here."}
                </p>
              </div>
            </div>

            {/* Search bar */}
            <div className="relative z-20 max-w-[92%] mx-auto -mt-6">
              <div className="bg-white rounded-xl shadow-lg border border-gray-100 px-3 py-2.5 flex items-center gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: primaryColor + "15" }}
                  >
                    <svg
                      className="w-3 h-3"
                      style={{ color: primaryColor }}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                  <div>
                    <p
                      className="text-[8px] text-gray-500 font-medium uppercase tracking-wide"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      Your Stay
                    </p>
                    <p
                      className="text-[10px] font-semibold text-gray-900"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      Feb 13 — Feb 18, 2026
                    </p>
                    <p
                      className="text-[8px] text-gray-500"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      5 nights
                    </p>
                  </div>
                </div>
                <div className="w-px h-8 bg-gray-200" />
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: primaryColor + "15" }}
                  >
                    <svg
                      className="w-3 h-3"
                      style={{ color: primaryColor }}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                  </div>
                  <div>
                    <p
                      className="text-[8px] text-gray-500 font-medium uppercase tracking-wide"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      Guests
                    </p>
                    <p
                      className="text-[10px] font-semibold text-gray-900"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      2 Adults
                    </p>
                    <p
                      className="text-[8px] text-gray-500"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      1 Room
                    </p>
                  </div>
                </div>
                <button
                  className="px-3 py-1.5 rounded-full text-[9px] font-semibold text-white shrink-0"
                  style={{ backgroundColor: primaryColor }}
                >
                  Check Availability
                </button>
              </div>
            </div>

            {/* Room card preview */}
            <div className="px-4 py-5">
              <h3
                className="text-sm text-gray-900 mb-3"
                style={{ fontFamily: currentFont.headingFamily }}
              >
                Available Accommodations
              </h3>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="flex">
                  <div className="relative w-[160px] flex-shrink-0">
                    <img
                      src="https://images.unsplash.com/photo-1590490360182-c33d57733427?w=400&q=80"
                      alt="Room"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex-1 p-3">
                    <h4
                      className="text-[12px] font-bold text-gray-900"
                      style={{ fontFamily: currentFont.headingFamily }}
                    >
                      Deluxe Mountain Room
                    </h4>
                    <div
                      className="flex items-center gap-2 text-[9px] text-gray-500 mt-0.5"
                      style={{ fontFamily: currentFont.bodyFamily }}
                    >
                      <span>32 m&sup2;</span>
                      <span>Up to 2 guests</span>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2 mb-2">
                      {["Mountain View", "Balcony", "Minibar"].map((feat) => (
                        <span
                          key={feat}
                          className="inline-flex items-center gap-0.5 text-[8px] text-gray-700 border border-gray-200 px-1.5 py-0.5 rounded-full"
                        >
                          <svg
                            className="w-2 h-2 flex-shrink-0"
                            style={{ color: primaryColor }}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          {feat}
                        </span>
                      ))}
                    </div>
                    <div className="border-t border-gray-100 pt-2">
                      <div
                        className="rounded-lg border-2 px-2.5 py-2"
                        style={{ borderColor: primaryColor }}
                      >
                        <div className="flex items-center justify-between">
                          <p
                            className="text-[9px] font-bold text-gray-900"
                            style={{ fontFamily: currentFont.bodyFamily }}
                          >
                            Flexible Rate
                          </p>
                          <p
                            className="text-[11px] font-bold"
                            style={{ color: primaryColor, fontFamily: currentFont.bodyFamily }}
                          >
                            {formatPrice(120, currency || "USD")}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
