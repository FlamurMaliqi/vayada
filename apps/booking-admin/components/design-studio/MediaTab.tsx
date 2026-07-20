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
  resetContent: () => void;
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
  resetContent,
}: MediaTabProps) {
  return (
    <>
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
            <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Subtext</label>
            <textarea
              aria-label="Hero subtext"
              value={heroSubtext}
              onChange={(e) => setHeroSubtext(e.target.value)}
              maxLength={1000}
              rows={3}
              className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
              placeholder="Enter hero subtext"
            />
            <p className="text-[11px] text-gray-400 mt-0.5">{heroSubtext.length}/1000 characters</p>
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
