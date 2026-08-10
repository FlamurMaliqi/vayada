"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { EyeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { settingsService } from "@/services/settings";
import { requireSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { publishPublicBookabilityProfile } from "@/services/api/publicBookabilityPublicationClient";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { COLOR_PRESETS, FONT_PAIRINGS } from "@/lib/constants/branding";
import { FeedbackAlert, SaveButton } from "@/components/ui";
import { uploadPropertyGalleryImages, uploadSingleImage } from "@/lib/utils/uploadImage";
import { generateColorPalette } from "@/lib/utils/colors";
import { buildBookingPreviewUrl } from "@/lib/utils/bookingPreviewUrl";

import MediaTab, { type PropertyGalleryImage } from "@/components/design-studio/MediaTab";
import ColorsTab from "@/components/design-studio/ColorsTab";
import FontsTab from "@/components/design-studio/FontsTab";

const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,700;1,400&family=Cinzel:wght@400;600;700&family=Italiana&display=swap";

type Tab = "media" | "colors" | "fonts";

export default function DesignStudioPage() {
  const [activeTab, setActiveTab] = useState<Tab>("media");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );

  // Media & Content state
  const [heroImage, setHeroImage] = useState("");
  const [heroHeading, setHeroHeading] = useState("");
  const [heroSubtext, setHeroSubtext] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [propertySlug, setPropertySlug] = useState("");
  const [propertyAddress, setPropertyAddress] = useState("");
  const [propertyPhone, setPropertyPhone] = useState("");
  const [propertyEmail, setPropertyEmail] = useState("");
  const [galleryImages, setGalleryImages] = useState<PropertyGalleryImage[]>([]);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const designHotelIdRef = useRef<string | null>(null);
  const propertyIdRef = useRef<string | null>(null);
  const profileRevisionRef = useRef<number | null>(null);
  const galleryOverflowRef = useRef<PropertyGalleryImage[]>([]);
  const coverAssignmentRef = useRef<{
    mediaObjectId: string;
    altText: string | null;
  } | null>(null);

  // Colors state
  const [primaryColor, setPrimaryColor] = useState("#4F46E5");
  const previewRef = useRef<HTMLDivElement>(null);

  // Fonts state
  const [selectedFont, setSelectedFont] = useState("high-end-serif");
  const bookingPreviewUrl = propertySlug
    ? buildBookingPreviewUrl({
        slug: propertySlug,
        template: process.env.NEXT_PUBLIC_BOOKING_PREVIEW_URL_TEMPLATE,
        location: typeof window === "undefined" ? undefined : window.location,
      })
    : null;

  const applyPublicGallery = useCallback(
    (profile: Awaited<ReturnType<typeof sharedHotelSetupApi.getPublicPropertyProfile>>) => {
      profileRevisionRef.current = profile.profileRevision;
      const media = [...profile.publicProfile.media].sort(
        (left, right) => left.sortOrder - right.sortOrder,
      );
      const cover = media.find(({ mediaType }) => mediaType === "hero_image");
      coverAssignmentRef.current = cover
        ? { mediaObjectId: cover.mediaObjectId, altText: cover.altText }
        : null;
      const gallery = media
        .filter(({ mediaType }) => mediaType === "gallery_image")
        .map(({ mediaObjectId, url, altText }) => ({ mediaObjectId, url, altText }));
      setGalleryImages(gallery.slice(0, 10));
      galleryOverflowRef.current = gallery.slice(10);
    },
    [],
  );

  const galleryAssignments = (visibleGallery: PropertyGalleryImage[]) => {
    const visibleIds = new Set(visibleGallery.map(({ mediaObjectId }) => mediaObjectId));
    return [
      ...visibleGallery,
      ...galleryOverflowRef.current.filter(({ mediaObjectId }) => !visibleIds.has(mediaObjectId)),
    ];
  };

  // Mirror the live booking engine's palette onto the preview pane so the
  // preview renders with the same shade tokens (bg-primary-600 for CTAs,
  // bg-primary-50 for tints, etc.) as the live site, not the raw input hex.
  // Depends on `loading` so the effect re-fires once the preview mounts.
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const palette = generateColorPalette(primaryColor);
    for (const [shade, color] of Object.entries(palette)) {
      el.style.setProperty(`--color-primary-${shade}`, color);
    }
  }, [primaryColor, loading]);

  useEffect(() => {
    setLoadFailed(false);
    propertyIdRef.current = null;
    profileRevisionRef.current = null;
    try {
      designHotelIdRef.current ??= requireSelectedBookingHotelId();
    } catch {
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    const hotelId = designHotelIdRef.current;
    Promise.all([
      settingsService.getDesignSettings(hotelId),
      settingsService.getPropertySettings(hotelId).catch(() => null),
      getBookingHotelPropertyLink({ hotelId }).then(async ({ propertyId }) => {
        propertyIdRef.current = propertyId;
        return sharedHotelSetupApi.getPublicPropertyProfile(propertyId);
      }),
    ])
      .then(([settings, property, publicProfile]) => {
        applyPublicGallery(publicProfile);
        if (settings.hero_image) setHeroImage(settings.hero_image);
        if (settings.hero_heading) setHeroHeading(settings.hero_heading);
        if (settings.hero_subtext) setHeroSubtext(settings.hero_subtext);
        if (settings.primary_color) setPrimaryColor(settings.primary_color);
        if (settings.font_pairing) setSelectedFont(settings.font_pairing);
        if (property?.property_name) setPropertyName(property.property_name);
        if (property?.slug) setPropertySlug(property.slug);
        if (property?.address) setPropertyAddress(property.address);
        if (property?.phone_number) setPropertyPhone(property.phone_number);
        if (property?.reservation_email) setPropertyEmail(property.reservation_email);
      })
      .catch(() => {
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [applyPublicGallery, loadAttempt]);

  const [uploading, setUploading] = useState(false);

  const refreshCanonicalGallery = async () => {
    const propertyId = propertyIdRef.current;
    if (!propertyId) return;
    const publicProfile = await sharedHotelSetupApi.getPublicPropertyProfile(propertyId);
    applyPublicGallery(publicProfile);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const hotelId = designHotelIdRef.current;
    const expectedProfileRevision = profileRevisionRef.current;
    if (!hotelId || expectedProfileRevision === null) {
      e.target.value = "";
      setFeedback({
        type: "error",
        message:
          "The property profile version is unavailable. Refresh Design Studio before uploading a hero image.",
      });
      return;
    }

    const previousImage = heroImage;
    const previewUrl = URL.createObjectURL(file);
    setHeroImage(previewUrl);

    try {
      setUploading(true);
      const s3Url = await uploadSingleImage(
        file,
        "property.hero_image",
        hotelId,
        expectedProfileRevision,
      );
      profileRevisionRef.current = expectedProfileRevision + 1;
      URL.revokeObjectURL(previewUrl);
      setHeroImage(s3Url);
      try {
        await refreshCanonicalGallery();
      } catch {
        profileRevisionRef.current = null;
      }

      try {
        await settingsService.updateDesignSettings({ hero_image: s3Url }, hotelId);
        await publishPublicBookabilityProfile(hotelId);
      } catch {
        console.error("Failed to auto-save or publish hero image");
      }
    } catch (err) {
      console.error("Image upload failed:", err);
      const propertyId = propertyIdRef.current;
      if (propertyId) {
        try {
          await refreshCanonicalGallery();
        } catch {
          profileRevisionRef.current = null;
        }
      }
      URL.revokeObjectURL(previewUrl);
      setHeroImage(previousImage);
      setFeedback({ type: "error", message: "Image upload failed. Please try again." });
    } finally {
      setUploading(false);
    }
  };

  const removeHeroImage = () => {
    setHeroImage("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const persistGallery = async (
    nextGallery: PropertyGalleryImage[],
  ): Promise<{ published: boolean; refreshed: boolean }> => {
    const propertyId = propertyIdRef.current;
    const hotelId = designHotelIdRef.current;
    const expectedProfileRevision = profileRevisionRef.current;
    if (!propertyId || !hotelId || expectedProfileRevision === null) {
      throw new Error("The property gallery version is unavailable. Refresh and try again.");
    }
    const cover = coverAssignmentRef.current;
    const sortOffset = cover ? 1 : 0;
    const response = await sharedHotelSetupApi.replacePropertyPresentationMedia(
      propertyId,
      {
        expectedProfileRevision,
        assignments: [
          ...(cover
            ? [
                {
                  mediaObjectId: cover.mediaObjectId,
                  role: "cover" as const,
                  altText: cover.altText,
                  sortOrder: 0,
                },
              ]
            : []),
          ...galleryAssignments(nextGallery).map((image, index) => ({
            mediaObjectId: image.mediaObjectId,
            role: "gallery" as const,
            altText: image.altText,
            sortOrder: index + sortOffset,
          })),
        ],
      },
      `booking.property-gallery.assign:${propertyId}:${crypto.randomUUID()}`,
    );
    profileRevisionRef.current = response.profileRevision;

    let refreshed = false;
    try {
      applyPublicGallery(await sharedHotelSetupApi.getPublicPropertyProfile(propertyId));
      refreshed = true;
    } catch {
      // Keep the optimistic thumbnails; the assignment itself already succeeded.
    }
    let published = true;
    try {
      await publishPublicBookabilityProfile(hotelId);
    } catch {
      published = false;
      setFeedback({
        type: "error",
        message: "Gallery saved, but the booking preview could not be refreshed. Try again.",
      });
    }
    return { published, refreshed };
  };

  const addGalleryImages = async (files: File[]) => {
    const propertyId = propertyIdRef.current;
    if (!propertyId || galleryBusy || files.length === 0) return;
    const remaining = Math.max(0, 10 - galleryImages.length);
    if (files.length > remaining) {
      setFeedback({
        type: "error",
        message: `You can add ${remaining} more ${remaining === 1 ? "photo" : "photos"} to this gallery.`,
      });
      return;
    }
    if (files.some((file) => !["image/jpeg", "image/png", "image/webp"].includes(file.type))) {
      setFeedback({ type: "error", message: "Gallery photos must be JPG, PNG, or WebP files." });
      return;
    }

    setGalleryBusy(true);
    setFeedback(null);
    const previewUrls = files.map((file) => URL.createObjectURL(file));
    try {
      const mediaObjectIds = await uploadPropertyGalleryImages(files, propertyId);
      const nextGallery = [
        ...galleryImages,
        ...mediaObjectIds.map((mediaObjectId, index) => ({
          mediaObjectId,
          url: previewUrls[index]!,
          altText: null,
        })),
      ];
      setGalleryImages(nextGallery);
      const { published, refreshed } = await persistGallery(nextGallery);
      if (refreshed) previewUrls.forEach(URL.revokeObjectURL);
      if (published) setFeedback({ type: "success", message: "Property gallery updated" });
    } catch (error) {
      previewUrls.forEach(URL.revokeObjectURL);
      await refreshCanonicalGallery().catch(() => undefined);
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Gallery upload failed. Try again.",
      });
    } finally {
      setGalleryBusy(false);
    }
  };

  const removeGalleryImage = async (index: number) => {
    if (galleryBusy) return;
    const previous = galleryImages;
    const nextGallery = previous.filter((_, photoIndex) => photoIndex !== index);
    setGalleryImages(nextGallery);
    setGalleryBusy(true);
    setFeedback(null);
    try {
      const { published } = await persistGallery(nextGallery);
      if (published) setFeedback({ type: "success", message: "Property gallery updated" });
    } catch (error) {
      setGalleryImages(previous);
      await refreshCanonicalGallery().catch(() => undefined);
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Photo could not be removed.",
      });
    } finally {
      setGalleryBusy(false);
    }
  };

  const reorderGalleryImage = async (sourceIndex: number, targetIndex: number) => {
    if (galleryBusy || sourceIndex === targetIndex) return;
    const previous = galleryImages;
    const nextGallery = [...previous];
    const [moved] = nextGallery.splice(sourceIndex, 1);
    if (!moved) return;
    nextGallery.splice(targetIndex, 0, moved);
    setGalleryImages(nextGallery);
    setGalleryBusy(true);
    setFeedback(null);
    try {
      const { published } = await persistGallery(nextGallery);
      if (published) setFeedback({ type: "success", message: "Property gallery order saved" });
    } catch (error) {
      setGalleryImages(previous);
      await refreshCanonicalGallery().catch(() => undefined);
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Gallery order could not be saved.",
      });
    } finally {
      setGalleryBusy(false);
    }
  };

  const resetContent = () => {
    setHeroHeading("");
    setHeroSubtext("");
  };

  const handleSave = async () => {
    const hotelId = designHotelIdRef.current;
    if (!hotelId) return;
    try {
      setSaving(true);
      setFeedback(null);
      await settingsService.updateDesignSettings(
        {
          hero_image: heroImage,
          hero_heading: heroHeading,
          hero_subtext: heroSubtext,
          primary_color: primaryColor,
          font_pairing: selectedFont,
        },
        hotelId,
      );
      try {
        await publishPublicBookabilityProfile(hotelId);
      } catch {
        setFeedback({
          type: "error",
          message: "Design saved, but the booking preview could not be refreshed. Try again.",
        });
        return;
      }
      setFeedback({ type: "success", message: "Design settings saved successfully" });
    } catch {
      setFeedback({ type: "error", message: "Failed to save design settings" });
    } finally {
      setSaving(false);
    }
  };

  const applyPreset = (preset: (typeof COLOR_PRESETS)[number]) => {
    setPrimaryColor(preset.primary);
  };

  const tabs = [
    { id: "media" as const, label: "Media & Content", icon: MediaIcon },
    { id: "colors" as const, label: "Colors", icon: ColorsIcon },
    { id: "fonts" as const, label: "Fonts", icon: FontsIcon },
  ];

  const currentFont = FONT_PAIRINGS.find((f) => f.id === selectedFont) || FONT_PAIRINGS[0];

  if (loading) {
    return (
      <div className="p-4 md:p-6 h-full flex items-center justify-center">
        <link rel="stylesheet" href={GOOGLE_FONTS_URL} />
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="p-4 md:p-6 h-full flex items-center justify-center">
        <link rel="stylesheet" href={GOOGLE_FONTS_URL} />
        <div className="w-full max-w-md text-center">
          <h1 className="text-xl font-bold text-gray-900">Design Studio</h1>
          <FeedbackAlert
            type="error"
            message="Failed to load design settings. Your saved design has not been changed."
            className="mt-4 text-left"
          />
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setLoadAttempt((attempt) => attempt + 1);
            }}
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 pb-24 lg:pb-6 lg:h-full flex flex-col">
      {}
      <link rel="stylesheet" href={GOOGLE_FONTS_URL} />
      <div className="shrink-0 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-xl font-bold text-gray-900">Design Studio</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Customize your booking engine&apos;s look and feel
          </p>
        </div>
        <button
          onClick={() => setPreviewOpen(true)}
          className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors shrink-0"
        >
          <EyeIcon className="w-4 h-4" />
          Preview
        </button>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mt-3 shrink-0" />
      )}

      {/* Main split layout */}
      <div className="mt-4 md:mt-5 flex flex-col lg:flex-row gap-5 lg:flex-1 lg:min-h-0">
        {/* LEFT: Controls panel */}
        <div className="w-full lg:w-[380px] lg:shrink-0 flex flex-col lg:min-h-0">
          {/* Tab bar */}
          <div className="bg-gray-100 rounded-lg p-1 grid grid-cols-3 shrink-0 sticky top-0 z-10 lg:static">
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
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.label.split(" ")[0]}</span>
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="mt-3 space-y-3 lg:flex-1 lg:overflow-y-auto lg:pb-3">
            {activeTab === "media" && (
              <MediaTab
                heroImage={heroImage}
                setHeroImage={setHeroImage}
                heroHeading={heroHeading}
                setHeroHeading={setHeroHeading}
                heroSubtext={heroSubtext}
                setHeroSubtext={setHeroSubtext}
                fileInputRef={fileInputRef}
                handleImageUpload={handleImageUpload}
                removeHeroImage={removeHeroImage}
                resetContent={resetContent}
                galleryImages={galleryImages}
                galleryBusy={galleryBusy}
                addGalleryImages={addGalleryImages}
                removeGalleryImage={removeGalleryImage}
                reorderGalleryImage={reorderGalleryImage}
              />
            )}

            {activeTab === "colors" && (
              <ColorsTab
                primaryColor={primaryColor}
                setPrimaryColor={setPrimaryColor}
                applyPreset={applyPreset}
              />
            )}

            {activeTab === "fonts" && (
              <FontsTab selectedFont={selectedFont} setSelectedFont={setSelectedFont} />
            )}
          </div>

          {/* Save button — desktop inline */}
          <div className="hidden lg:block pt-3 shrink-0 border-t border-gray-100">
            <SaveButton onClick={handleSave} saving={saving} disabled={uploading || galleryBusy} />
          </div>
        </div>

        {/* RIGHT: Live website preview
            Desktop: side panel. Mobile: hidden by default; full-screen overlay when previewOpen. */}
        <div
          ref={previewRef}
          className={`bg-white border border-gray-200 flex-col lg:flex lg:flex-1 lg:min-w-0 lg:min-h-0 lg:rounded-lg ${
            previewOpen ? "flex fixed inset-0 z-50 lg:relative lg:inset-auto lg:z-auto" : "hidden"
          }`}
        >
          {/* Mobile-only drawer header */}
          {previewOpen && (
            <div className="lg:hidden flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0">
              <h2 className="text-sm font-semibold text-gray-900">Live Preview</h2>
              <button
                onClick={() => setPreviewOpen(false)}
                className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-full transition-colors"
                aria-label="Close preview"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Browser chrome bar — desktop only */}
          <div className="hidden lg:flex items-center gap-2 px-3 py-2 border-b border-gray-200 shrink-0 bg-gray-50">
            <div className="flex gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
            </div>
            <div className="flex-1 bg-white rounded-md px-3 py-0.5 text-[11px] text-gray-500 text-center truncate border border-gray-200">
              {bookingPreviewUrl?.replace(/^https?:\/\//, "") ?? "Your booking URL"}
            </div>
          </div>

          {/* Preview content */}
          <div
            className="flex-1 overflow-y-auto overflow-x-hidden bg-white"
            style={{ fontFamily: currentFont.bodyFamily }}
          >
            {/* HERO SECTION */}
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
                    <span className="px-2.5 py-0.5 text-[9px] font-semibold text-white rounded-full bg-primary-600">
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

              {/* Hero Content */}
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

            {/* SEARCH BAR */}
            <div className="relative z-20 max-w-[92%] mx-auto -mt-6">
              <div className="bg-white rounded-xl shadow-lg border border-gray-100 px-3 py-2.5 flex items-center gap-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-primary-50">
                    <svg
                      className="w-3 h-3 text-primary-600"
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
                  <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-primary-50">
                    <svg
                      className="w-3 h-3 text-primary-600"
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

                <button className="px-3 py-1.5 rounded-full text-[9px] font-semibold text-white shrink-0 bg-primary-600 hover:bg-primary-700 transition-colors">
                  Check Availability
                </button>
              </div>
            </div>

            {/* MAIN CONTENT */}
            <div className="px-4 py-5">
              <div className="flex items-center justify-between mb-4">
                <h3
                  className="text-sm text-gray-900"
                  style={{ fontFamily: currentFont.headingFamily }}
                >
                  Available Accommodations
                </h3>

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
                          className={`w-4 h-4 rounded-full flex items-center justify-center text-[7px] font-bold ${
                            step.n === 1 ? "bg-primary-600 text-white" : "bg-gray-200 text-gray-500"
                          }`}
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

              {/* ROOM CARD */}
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
                            className="w-2 h-2 flex-shrink-0 text-primary-600"
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

                      <div className="rounded-lg border-2 mb-1.5 border-primary-500">
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
                                <span className="text-[7px] font-bold text-white px-1 py-px rounded bg-primary-600">
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

              {/* Second Room Card (collapsed) */}
              <div className="border border-gray-200 rounded-xl overflow-hidden mt-3">
                <div className="flex">
                  <div className="relative w-[160px] flex-shrink-0">
                    <img
                      src="https://images.unsplash.com/photo-1582719508461-905c673771fd?w=400&q=80"
                      alt="Ocean Suite"
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
                          Premium Ocean Suite
                        </h4>
                        <div
                          className="flex items-center gap-2 text-[9px] text-gray-500 mt-0.5"
                          style={{ fontFamily: currentFont.bodyFamily }}
                        >
                          <span>48 m&sup2;</span>
                          <span>Up to 3 guests</span>
                        </div>
                      </div>
                      <span className="text-[8px] font-medium text-gray-600 border border-gray-300 rounded-full px-2 py-0.5">
                        View Details
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 mb-2">
                      {["Ocean View", "Private Pool", "Living Area", "Breakfast"].map((feat) => (
                        <span
                          key={feat}
                          className="inline-flex items-center gap-0.5 text-[8px] text-gray-700 border border-gray-200 px-1.5 py-0.5 rounded-full"
                          style={{ fontFamily: currentFont.bodyFamily }}
                        >
                          <svg
                            className="w-2 h-2 flex-shrink-0 text-primary-600"
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
                          <div className="text-right flex items-center gap-2">
                            <div>
                              <p
                                className="text-[12px] font-bold text-gray-900"
                                style={{ fontFamily: currentFont.bodyFamily }}
                              >
                                &euro;1,250
                              </p>
                              <p
                                className="text-[7px] text-gray-500"
                                style={{ fontFamily: currentFont.bodyFamily }}
                              >
                                &euro;250/night
                              </p>
                            </div>
                            <svg
                              className="w-3 h-3 text-gray-400"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 9l-7 7-7-7"
                              />
                            </svg>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* FOOTER */}
            <div className="px-4 py-4 text-white bg-primary-600">
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
                    {propertyAddress && <p>{propertyAddress}</p>}
                    {propertyPhone && <p>Phone: {propertyPhone}</p>}
                    {propertyEmail && <p>Email: {propertyEmail}</p>}
                    {!propertyAddress && !propertyPhone && !propertyEmail && (
                      <p>Add contact details in Property settings.</p>
                    )}
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

      {/* Mobile-only sticky Save footer */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          onClick={handleSave}
          disabled={saving || uploading || galleryBusy}
          className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-primary-500 text-white text-[14px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg
              className="w-4 h-4"
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
