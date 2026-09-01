"use client";

import { useState, useRef, useEffect } from "react";
import { PhotoIcon, XMarkIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { bookingSettingsService } from "@/services/booking";
import { COLOR_PRESETS, FONT_PAIRINGS } from "@/lib/constants/booking";
import { hasPropertyHero, propertyHeroService } from "@/services/api/propertyHero";

const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,700;1,400&family=Italiana&display=swap";

const AVAILABLE_FILTERS = [
  { key: "includeBreakfast", label: "Include Breakfast" },
  { key: "freeCancellation", label: "Free Cancellation" },
  { key: "payAtHotel", label: "Pay at Hotel" },
  { key: "bestRated", label: "Best Rated" },
  { key: "mountainView", label: "Mountain View" },
];

type Tab = "media" | "colors" | "fonts" | "filters";

export default function DesignStudioSection({ hotelId }: { hotelId: string }) {
  const [activeTab, setActiveTab] = useState<Tab>("media");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [designSettingsReady, setDesignSettingsReady] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  // Media & Content state
  const [heroImage, setHeroImage] = useState("");
  const [heroMediaObjectId, setHeroMediaObjectId] = useState<string | null>(null);
  const [profileRevision, setProfileRevision] = useState<number | null>(null);
  const [heroHeading, setHeroHeading] = useState("Sundancer Lombok");
  const [heroSubtext, setHeroSubtext] = useState(
    "A boutique escape featuring private pools, ocean views, and tranquil luxury in the pristine shores of Sekotong.",
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaOperationRef = useRef(0);

  // Colors state
  const [primaryColor, setPrimaryColor] = useState("#4F46E5");
  const [accentColor, setAccentColor] = useState("#F5F5F4");

  // Fonts state
  const [selectedFont, setSelectedFont] = useState("high-end-serif");

  // Filters state
  const [bookingFilters, setBookingFilters] = useState<string[]>([
    "includeBreakfast",
    "freeCancellation",
    "payAtHotel",
    "bestRated",
    "mountainView",
  ]);

  useEffect(() => {
    const operation = ++mediaOperationRef.current;
    setLoading(true);
    setFeedback(null);
    setDesignSettingsReady(false);
    setUploading(false);
    setProfileRevision(null);
    setHeroMediaObjectId(null);
    setHeroImage("");
    Promise.allSettled([
      bookingSettingsService.getDesignSettings(hotelId),
      propertyHeroService.get(hotelId),
    ])
      .then(([design, media]) => {
        if (mediaOperationRef.current !== operation) return;
        if (design.status === "fulfilled") {
          const settings = design.value;
          setDesignSettingsReady(true);
          if (settings.hero_heading) setHeroHeading(settings.hero_heading);
          if (settings.hero_subtext) setHeroSubtext(settings.hero_subtext);
          if (settings.primary_color) setPrimaryColor(settings.primary_color);
          if (settings.accent_color) setAccentColor(settings.accent_color);
          if (settings.font_pairing) setSelectedFont(settings.font_pairing);
          if (settings.booking_filters) setBookingFilters(settings.booking_filters);
        }
        if (media.status === "fulfilled") {
          setProfileRevision(media.value.profileRevision);
          setHeroMediaObjectId(media.value.hero?.mediaObjectId ?? null);
          setHeroImage(media.value.hero?.url ?? "");
        }
        const failedLoads = [
          design.status === "rejected" && "design settings",
          media.status === "rejected" && "property media",
        ].filter(Boolean);
        if (failedLoads.length > 0) {
          setFeedback({
            type: "error",
            message: `We could not load ${failedLoads.join(" or ")}. Reload to try again.`,
          });
        }
      })
      .finally(() => {
        if (mediaOperationRef.current === operation) setLoading(false);
      });
    return () => {
      mediaOperationRef.current += 1;
    };
  }, [hotelId]);

  useEffect(
    () => () => {
      if (heroImage.startsWith("blob:")) URL.revokeObjectURL(heroImage);
    },
    [heroImage],
  );

  const [uploading, setUploading] = useState(false);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (profileRevision === null) {
      setFeedback({ type: "error", message: "Property media is not available yet." });
      return;
    }

    // Show local preview immediately
    const previousImage = heroImage;
    const previewUrl = URL.createObjectURL(file);
    setHeroImage(previewUrl);
    const operation = ++mediaOperationRef.current;
    const propertyId = hotelId;

    // Upload privately, then publish through the exact property command.
    try {
      setUploading(true);
      const updated = await propertyHeroService.uploadAndReplace(file, propertyId, profileRevision);
      if (mediaOperationRef.current !== operation) return;
      setProfileRevision(updated.profileRevision);
      setHeroMediaObjectId(updated.hero?.mediaObjectId ?? null);
      setFeedback({ type: "success", message: "Hero image published successfully" });
      try {
        const current = await propertyHeroService.get(propertyId);
        if (mediaOperationRef.current !== operation) return;
        setProfileRevision(current.profileRevision);
        setHeroMediaObjectId(current.hero?.mediaObjectId ?? null);
        setHeroImage(current.hero?.url ?? "");
        if (current.hero?.mediaObjectId !== updated.hero?.mediaObjectId) {
          setFeedback({
            type: "error",
            message: "Hero changed again; showing the latest version.",
          });
        }
      } catch {
        // Keep the local preview; the command result remains the source of truth.
      }
    } catch (err) {
      if (mediaOperationRef.current !== operation) return;
      console.error("Image upload failed:", err);
      try {
        const current = await propertyHeroService.get(propertyId);
        if (mediaOperationRef.current !== operation) return;
        setProfileRevision(current.profileRevision);
        setHeroMediaObjectId(current.hero?.mediaObjectId ?? null);
        setHeroImage(current.hero?.url ?? "");
      } catch {
        if (mediaOperationRef.current !== operation) return;
        setHeroImage(previousImage.startsWith("blob:") ? "" : previousImage);
      }
      setFeedback({ type: "error", message: "Image upload failed. Please try again." });
    } finally {
      if (mediaOperationRef.current === operation) setUploading(false);
    }
  };

  const removeHeroImage = async () => {
    if (profileRevision === null) return;
    const operation = ++mediaOperationRef.current;
    const propertyId = hotelId;
    try {
      setUploading(true);
      const updated = await propertyHeroService.replace(propertyId, profileRevision, null);
      if (mediaOperationRef.current !== operation) return;
      setProfileRevision(updated.profileRevision);
      setHeroMediaObjectId(null);
      setHeroImage("");
      setFeedback({ type: "success", message: "Hero image removed successfully" });
      if (fileInputRef.current) fileInputRef.current.value = "";
      try {
        const current = await propertyHeroService.get(propertyId);
        if (mediaOperationRef.current !== operation) return;
        setProfileRevision(current.profileRevision);
        setHeroMediaObjectId(current.hero?.mediaObjectId ?? null);
        setHeroImage(current.hero?.url ?? "");
        if (current.hero?.mediaObjectId !== updated.hero?.mediaObjectId) {
          setFeedback({
            type: "error",
            message: "Hero changed again; showing the latest version.",
          });
        }
      } catch {
        // The revision-fenced clear result remains authoritative.
      }
    } catch {
      if (mediaOperationRef.current !== operation) return;
      try {
        const current = await propertyHeroService.get(propertyId);
        if (mediaOperationRef.current !== operation) return;
        setProfileRevision(current.profileRevision);
        setHeroMediaObjectId(current.hero?.mediaObjectId ?? null);
        setHeroImage(current.hero?.url ?? "");
      } catch {
        // Keep the revision-fenced clear result when refresh is unavailable.
      }
      setFeedback({ type: "error", message: "Failed to remove hero image" });
    } finally {
      if (mediaOperationRef.current === operation) setUploading(false);
    }
  };

  const resetContent = () => {
    setHeroHeading("Sundancer Lombok");
    setHeroSubtext(
      "A boutique escape featuring private pools, ocean views, and tranquil luxury in the pristine shores of Sekotong.",
    );
  };

  const handleSave = async () => {
    if (!designSettingsReady) {
      setFeedback({ type: "error", message: "Reload before saving design settings." });
      return;
    }
    try {
      setSaving(true);
      setFeedback(null);
      await bookingSettingsService.updateDesignSettings(hotelId, {
        hero_heading: heroHeading,
        hero_subtext: heroSubtext,
        primary_color: primaryColor,
        accent_color: accentColor,
        font_pairing: selectedFont,
        booking_filters: bookingFilters,
      });
      setFeedback({ type: "success", message: "Design settings saved successfully" });
    } catch {
      setFeedback({ type: "error", message: "Failed to save design settings" });
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (preset: (typeof COLOR_PRESETS)[number]) => {
    setPrimaryColor(preset.primary);
    setAccentColor(preset.accent);
  };

  const tabs = [
    { id: "media" as const, label: "Media & Content", icon: MediaIcon },
    { id: "colors" as const, label: "Colors", icon: ColorsIcon },
    { id: "fonts" as const, label: "Fonts", icon: FontsIcon },
    { id: "filters" as const, label: "Filters", icon: FiltersIcon },
  ];

  const currentFont = FONT_PAIRINGS.find((f) => f.id === selectedFont) || FONT_PAIRINGS[0];

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <link rel="stylesheet" href={GOOGLE_FONTS_URL} />
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {}
      <link rel="stylesheet" href={GOOGLE_FONTS_URL} />

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`mb-3 px-3 py-2.5 rounded-lg text-[13px] shrink-0 ${
            feedback.type === "success"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Main split layout */}
      <div className="flex gap-5 flex-1 min-h-0">
        {/* LEFT: Controls panel */}
        <div className="w-[380px] shrink-0 flex flex-col min-h-0">
          {/* Tab bar */}
          <div className="bg-gray-100 rounded-lg p-1 grid grid-cols-4 shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center justify-center gap-1 py-1.5 rounded-md text-[12px] transition-all ${
                  activeTab === tab.id
                    ? "bg-white text-gray-900 font-semibold shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content — scrollable */}
          <div className="mt-3 flex-1 overflow-y-auto space-y-3 pb-3">
            {/* Media & Content tab */}
            {activeTab === "media" && (
              <>
                {/* Hero Image */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-[13px] font-semibold text-gray-900">
                    Hero Image <span className="text-red-500">*</span>
                  </h2>
                  <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">1920x1080 recommended</p>

                  {hasPropertyHero(heroMediaObjectId, heroImage) ? (
                    <div className="relative rounded-lg overflow-hidden bg-gray-200">
                      {!heroImage && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-gray-500">
                          <PhotoIcon className="w-6 h-6" />
                          <span className="text-[12px]">Preview unavailable</span>
                        </div>
                      )}
                      <img
                        key={heroMediaObjectId ?? heroImage}
                        src={heroImage || undefined}
                        alt="Hero"
                        className="w-full h-36 object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                      <button
                        onClick={removeHeroImage}
                        disabled={uploading || profileRevision === null}
                        className="absolute top-1.5 right-1.5 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <XMarkIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || profileRevision === null}
                      className="w-full h-36 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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

                  {hasPropertyHero(heroMediaObjectId, heroImage) && (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading || profileRevision === null}
                      className="mt-2 w-full py-1.5 text-[12px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Replace Image
                    </button>
                  )}
                </div>

                {/* Text Overrides */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <h2 className="text-[13px] font-semibold text-gray-900">Hero Text</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5 mb-2.5">
                    Customize heading and subtext
                  </p>

                  <div className="space-y-2.5">
                    <div>
                      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                        Heading
                      </label>
                      <input
                        type="text"
                        value={heroHeading}
                        onChange={(e) => setHeroHeading(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                        placeholder="Enter hero heading"
                      />
                    </div>
                    <div>
                      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                        Subtext
                      </label>
                      <textarea
                        value={heroSubtext}
                        onChange={(e) => {
                          if (e.target.value.length <= 200) setHeroSubtext(e.target.value);
                        }}
                        rows={3}
                        className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                        placeholder="Enter hero subtext"
                      />
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {heroSubtext.length}/200 characters
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
            )}

            {/* Colors tab */}
            {activeTab === "colors" && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h2 className="text-[13px] font-semibold text-gray-900">Color Profile</h2>
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
                        className="w-20 px-2 py-1 border border-gray-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      />
                    </div>
                  </div>

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
                          onChange={(e) => setAccentColor(e.target.value)}
                          className="opacity-0 w-0 h-0"
                        />
                      </label>
                      <input
                        type="text"
                        value={accentColor}
                        onChange={(e) => setAccentColor(e.target.value)}
                        className="w-20 px-2 py-1 border border-gray-300 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      />
                    </div>
                  </div>

                  <div>
                    <h3 className="text-[12px] font-semibold text-gray-900 mb-1.5">
                      Quick Presets
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {COLOR_PRESETS.map((preset) => (
                        <button
                          key={preset.name}
                          onClick={() => applyPreset(preset)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 border border-gray-200 rounded-full text-[12px] text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: preset.primary }}
                          />
                          {preset.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Fonts tab */}
            {activeTab === "fonts" && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h2 className="text-[13px] font-semibold text-gray-900">Typography</h2>
                <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Select a font pairing</p>

                <div className="space-y-1.5">
                  {FONT_PAIRINGS.map((pairing) => (
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
                            <svg
                              className="w-3.5 h-3.5 text-primary-500"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
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
            )}

            {/* Filters tab */}
            {activeTab === "filters" && (
              <div className="bg-white rounded-lg border border-gray-200 p-4">
                <h2 className="text-[13px] font-semibold text-gray-900">Booking Filters</h2>
                <p className="text-[12px] text-gray-500 mt-0.5 mb-3">
                  Choose which filters guests see on the booking page
                </p>

                <div className="space-y-2">
                  {AVAILABLE_FILTERS.map((filter) => {
                    const enabled = bookingFilters.includes(filter.key);
                    return (
                      <button
                        key={filter.key}
                        onClick={() => {
                          setBookingFilters((prev) =>
                            enabled ? prev.filter((k) => k !== filter.key) : [...prev, filter.key],
                          );
                        }}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                          enabled
                            ? "border-primary-500 bg-primary-50/30"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <span className="text-[12px] font-medium text-gray-900">
                          {filter.label}
                        </span>
                        <div
                          className={`w-8 h-5 rounded-full transition-colors relative ${enabled ? "bg-primary-500" : "bg-gray-300"}`}
                        >
                          <div
                            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? "left-3.5" : "left-0.5"}`}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Save button — always visible at bottom */}
          <div className="pt-3 shrink-0 border-t border-gray-100">
            <button
              onClick={handleSave}
              disabled={saving || uploading || !designSettingsReady}
              className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
            >
              {saving ? (
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
                  />
                </svg>
              )}
              Save Changes
            </button>
          </div>
        </div>

        {/* RIGHT: Live website preview */}
        <div className="flex-1 min-w-0 bg-white rounded-lg border border-gray-200 flex flex-col min-h-0">
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

          {/* Preview content — scrollable */}
          <div
            className="flex-1 overflow-y-auto bg-white"
            style={{ fontFamily: currentFont.bodyFamily }}
          >
            {/* ===== HERO SECTION ===== */}
            <div className="relative h-[280px] w-full bg-gray-300">
              {heroImage && (
                <img
                  src={heroImage}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />

              {/* Navigation — absolute over hero */}
              <div className="absolute top-0 left-0 right-0 z-10">
                <div className="flex items-center justify-between px-4 h-10">
                  <span
                    className="text-[11px] font-semibold text-white"
                    style={{ fontFamily: currentFont.bodyFamily }}
                  >
                    {heroHeading || "Your Hotel"}
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
                      EN
                    </span>
                    <span className="px-2 py-0.5 text-[9px] font-semibold text-white rounded-full border border-white/60">
                      EUR
                    </span>
                  </div>
                </div>
              </div>

              {/* Hero Content — centered */}
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
                <h2
                  className="text-2xl italic text-white mb-1.5"
                  style={{ fontFamily: currentFont.headingFamily }}
                >
                  {heroHeading || "Your Hotel Name"}
                </h2>
                <p
                  className="text-[11px] text-white/90 leading-relaxed max-w-sm"
                  style={{ fontFamily: currentFont.bodyFamily }}
                >
                  {heroSubtext || "Your hotel description will appear here."}
                </p>
              </div>
            </div>

            {/* ===== SEARCH BAR — overlaps hero ===== */}
            <div className="relative z-20 max-w-[92%] mx-auto -mt-6">
              <div className="bg-white rounded-xl shadow-lg border border-gray-100 px-3 py-2.5 flex items-center gap-2">
                {/* Dates */}
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

                {/* Guests */}
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

                <div className="w-px h-8 bg-gray-200" />

                {/* Promo */}
                <div className="flex items-center gap-1 text-gray-400 flex-shrink-0">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                    />
                  </svg>
                  <span
                    className="text-[9px] font-medium"
                    style={{ fontFamily: currentFont.bodyFamily }}
                  >
                    Promo
                  </span>
                </div>

                {/* Check Availability */}
                <button
                  className="px-3 py-1.5 rounded-full text-[9px] font-semibold text-white shrink-0"
                  style={{ backgroundColor: primaryColor }}
                >
                  Check Availability
                </button>
              </div>
            </div>

            {/* ===== MAIN CONTENT ===== */}
            <div className="px-4 py-5">
              {/* Section header + Step indicator */}
              <div className="flex items-center justify-between mb-4">
                <h3
                  className="text-sm text-gray-900"
                  style={{ fontFamily: currentFont.headingFamily }}
                >
                  Available Accommodations
                </h3>

                {/* Step Indicator */}
                <div className="flex items-center gap-1">
                  {[
                    { n: 1, label: "Rooms" },
                    { n: 2, label: "Add-ons" },
                    { n: 3, label: "Details" },
                    { n: 4, label: "Payment" },
                  ].map((step, idx) => (
                    <div key={step.n} className="flex items-center">
                      <div className="flex items-center gap-0.5">
                        <div
                          className="w-4 h-4 rounded-full flex items-center justify-center text-[7px] font-bold"
                          style={{
                            backgroundColor: step.n === 1 ? primaryColor : "#E5E7EB",
                            color: step.n === 1 ? "white" : "#6B7280",
                          }}
                        >
                          {step.n}
                        </div>
                        <span
                          className="text-[8px] font-medium"
                          style={{
                            color: step.n === 1 ? "#111827" : "#9CA3AF",
                            fontFamily: currentFont.bodyFamily,
                          }}
                        >
                          {step.label}
                        </span>
                      </div>
                      {idx < 3 && <div className="w-4 h-px bg-gray-300 mx-0.5" />}
                    </div>
                  ))}
                </div>
              </div>

              {/* Filters */}
              <div className="mb-4">
                <div
                  className="flex items-center gap-1 text-[9px] text-gray-500 mb-1.5"
                  style={{ fontFamily: currentFont.bodyFamily }}
                >
                  <svg
                    className="w-2.5 h-2.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                    />
                  </svg>
                  Popular filters
                </div>
                <div className="h-px bg-gray-200 mb-2" />
                <div className="flex flex-wrap gap-1.5">
                  {["Include Breakfast", "Free Cancellation", "Pay at Hotel", "Best Rated"].map(
                    (filter, i) => (
                      <span
                        key={filter}
                        className="px-2 py-0.5 rounded-full text-[8px] font-medium border transition-colors"
                        style={{
                          borderColor: i === 0 ? "#111827" : "#D1D5DB",
                          color: i === 0 ? "#111827" : "#6B7280",
                          fontFamily: currentFont.bodyFamily,
                        }}
                      >
                        {filter}
                      </span>
                    ),
                  )}
                </div>
              </div>

              {/* ===== ROOM CARD ===== */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="flex">
                  <div className="relative w-[160px] flex-shrink-0">
                    <img
                      src="https://images.unsplash.com/photo-1590490360182-c33d57733427?w=400&q=80"
                      alt="Deluxe Room"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute bottom-1.5 left-1.5 right-1.5 flex gap-0.5">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="h-1 flex-1 rounded-full"
                          style={{ backgroundColor: i === 0 ? "white" : "rgba(255,255,255,0.5)" }}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 p-3">
                    <div className="flex items-start justify-between mb-1.5">
                      <div>
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
                      </div>
                      <span className="text-[8px] font-medium text-gray-600 border border-gray-300 rounded-full px-2 py-0.5">
                        View Details
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-1 mb-2">
                      {["Mountain View", "Balcony", "Minibar", "Safe"].map((feat) => (
                        <span
                          key={feat}
                          className="inline-flex items-center gap-0.5 text-[8px] text-gray-700 border border-gray-200 px-1.5 py-0.5 rounded-full"
                          style={{ fontFamily: currentFont.bodyFamily }}
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
                      <p
                        className="text-[7px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5"
                        style={{ fontFamily: currentFont.bodyFamily }}
                      >
                        Rate Options
                      </p>

                      <div
                        className="rounded-lg border-2 mb-1.5"
                        style={{ borderColor: primaryColor }}
                      >
                        <div className="flex items-center justify-between px-2.5 py-2">
                          <div className="flex items-center gap-1.5">
                            <svg
                              className="w-3 h-3 text-gray-400 flex-shrink-0"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              />
                            </svg>
                            <div>
                              <p
                                className="text-[9px] font-bold text-gray-900"
                                style={{ fontFamily: currentFont.bodyFamily }}
                              >
                                Flexible Rate
                              </p>
                              <p
                                className="text-[7px] text-gray-500"
                                style={{ fontFamily: currentFont.bodyFamily }}
                              >
                                Free cancellation until 24h before
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p
                              className="text-[12px] font-bold text-gray-900"
                              style={{ fontFamily: currentFont.bodyFamily }}
                            >
                              &euro;600
                            </p>
                            <p
                              className="text-[7px] text-gray-500"
                              style={{ fontFamily: currentFont.bodyFamily }}
                            >
                              &euro;120/night
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg border border-gray-200">
                        <div className="flex items-center justify-between px-2.5 py-2">
                          <div className="flex items-center gap-1.5">
                            <svg
                              className="w-3 h-3 text-gray-400 flex-shrink-0"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                            <div>
                              <p
                                className="text-[9px] font-bold text-gray-900 flex items-center gap-1"
                                style={{ fontFamily: currentFont.bodyFamily }}
                              >
                                Non-Refundable
                                <span
                                  className="text-[7px] font-bold text-white px-1 py-px rounded"
                                  style={{ backgroundColor: primaryColor }}
                                >
                                  -15%
                                </span>
                              </p>
                              <p
                                className="text-[7px] text-gray-500"
                                style={{ fontFamily: currentFont.bodyFamily }}
                              >
                                No cancellation or changes
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p
                              className="text-[12px] font-bold text-gray-900"
                              style={{ fontFamily: currentFont.bodyFamily }}
                            >
                              &euro;510
                            </p>
                            <p
                              className="text-[7px] text-gray-500"
                              style={{ fontFamily: currentFont.bodyFamily }}
                            >
                              &euro;102/night
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ===== FOOTER ===== */}
            <div className="px-4 py-4 text-white" style={{ backgroundColor: primaryColor }}>
              <div className="flex gap-6 mb-3">
                <div className="flex-1">
                  <p
                    className="text-[11px] font-bold mb-1"
                    style={{ fontFamily: currentFont.headingFamily }}
                  >
                    {heroHeading || "Your Hotel"}
                  </p>
                  <p
                    className="text-[8px] text-white/80 leading-relaxed"
                    style={{ fontFamily: currentFont.bodyFamily }}
                  >
                    {heroSubtext
                      ? heroSubtext.slice(0, 80) + (heroSubtext.length > 80 ? "..." : "")
                      : "Your hotel description."}
                  </p>
                </div>
                <div>
                  <p
                    className="text-[8px] font-bold uppercase tracking-wider mb-1.5"
                    style={{ fontFamily: currentFont.bodyFamily }}
                  >
                    Contact
                  </p>
                  <div
                    className="space-y-0.5 text-[8px] text-white/80"
                    style={{ fontFamily: currentFont.bodyFamily }}
                  >
                    <p>Alpengasse 12, 6020 Innsbruck</p>
                    <p>Phone: +43 512 123 456</p>
                    <p>Email: reservations@hotel.com</p>
                  </div>
                </div>
              </div>
              <div
                className="border-t border-white/20 pt-2 flex items-center justify-between text-[7px] text-white/70"
                style={{ fontFamily: currentFont.bodyFamily }}
              >
                <span>&copy; 2026 All rights reserved</span>
                <span>
                  Powered by <span className="text-white font-semibold underline">vayada</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MediaIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

function ColorsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a4.5 4.5 0 0 0 0 9 4.5 4.5 0 0 1 0 9" />
      <circle cx="12" cy="7.5" r="1.5" fill="currentColor" />
      <circle cx="12" cy="16.5" r="1.5" />
    </svg>
  );
}

function FontsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7V4h16v3" />
      <path d="M12 4v16" />
      <path d="M8 20h8" />
    </svg>
  );
}

function FiltersIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
    </svg>
  );
}
