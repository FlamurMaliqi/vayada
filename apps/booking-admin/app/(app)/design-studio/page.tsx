"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { EyeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { BOOKING_PAGE_FONT_STYLESHEET_URL, BookingPagePreview } from "@vayada/product-onboarding";
import { settingsService, type CustomDomainStatus } from "@/services/settings";
import { requireSelectedBookingHotelId } from "@/services/api/bookingHotelScope";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { publishPublicBookabilityProfile } from "@/services/api/publicBookabilityPublicationClient";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { COLOR_PRESETS, FONT_PAIRINGS } from "@/lib/constants/branding";
import { FeedbackAlert, SaveButton } from "@/components/ui";
import {
  MAX_PROPERTY_GALLERY_PHOTOS,
  uploadPropertyGalleryImages,
  uploadSingleImage,
  uploadSingleImageWithMediaReference,
} from "@/lib/utils/uploadImage";
import {
  headerLogoDimensionsError,
  headerLogoFileFromUrl,
  headerLogoUploadError,
} from "@/lib/utils/headerLogo";
import { buildBookingPreviewUrl } from "@/lib/utils/bookingPreviewUrl";
import { useTranslation } from "@/lib/i18n";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

import CustomDomainCard from "@/components/design-studio/CustomDomainCard";
import MediaTab, { type PropertyGalleryImage } from "@/components/design-studio/MediaTab";
import ColorsTab from "@/components/design-studio/ColorsTab";
import FontsTab from "@/components/design-studio/FontsTab";

type Tab = "media" | "colors" | "fonts" | "layout" | "domain";

export default function DesignStudioPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("media");
  const [saving, setSaving] = useState(false);
  const [domainBusy, setDomainBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const [domainInput, setDomainInput] = useState("");
  const [domainStatus, setDomainStatus] = useState<CustomDomainStatus | null>(null);

  // Media & Content state
  const [heroImage, setHeroImage] = useState("");
  const [headerLogo, setHeaderLogo] = useState("");
  const [headerLogoUrl, setHeaderLogoUrl] = useState("");
  const [headerLogoMediaObjectId, setHeaderLogoMediaObjectId] = useState<string | null>(null);
  const [showContactButton, setShowContactButton] = useState(true);
  const [showReferAGuestButton, setShowReferAGuestButton] = useState(false);
  const [referAGuestModuleEnabled, setReferAGuestModuleEnabled] = useState<boolean | null>(null);
  const [showLanguageSelector, setShowLanguageSelector] = useState(true);
  const [showCurrencySelector, setShowCurrencySelector] = useState(true);
  const [heroHeading, setHeroHeading] = useState("");
  const [heroSubtext, setHeroSubtext] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [propertySlug, setPropertySlug] = useState("");
  const [defaultCurrency, setDefaultCurrency] = useState("EUR");
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([]);
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>([]);
  const [galleryImages, setGalleryImages] = useState<PropertyGalleryImage[]>([]);
  const [galleryOverflowCount, setGalleryOverflowCount] = useState(0);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const designHotelIdRef = useRef<string | null>(null);
  const propertyIdRef = useRef<string | null>(null);
  const profileRevisionRef = useRef<number | null>(null);
  const galleryOverflowRef = useRef<PropertyGalleryImage[]>([]);
  const galleryWriteInFlightRef = useRef(false);
  const pendingGalleryPreviewUrlsRef = useRef(new Set<string>());
  const coverAssignmentRef = useRef<{
    mediaObjectId: string;
    altText: string | null;
  } | null>(null);

  // Colors state
  const [primaryColor, setPrimaryColor] = useState("#4F46E5");

  // Fonts state
  const [selectedFont, setSelectedFont] = useState("high-end-serif");
  const defaultBookingPreviewUrl = propertySlug
    ? buildBookingPreviewUrl({
        slug: propertySlug,
        template: process.env.NEXT_PUBLIC_BOOKING_PREVIEW_URL_TEMPLATE,
        location: typeof window === "undefined" ? undefined : window.location,
      })
    : null;
  const bookingPreviewUrl =
    domainStatus?.configured && domainStatus.domain
      ? domainStatus.domain
      : defaultBookingPreviewUrl;

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
      setGalleryImages(gallery.slice(0, MAX_PROPERTY_GALLERY_PHOTOS));
      galleryOverflowRef.current = gallery.slice(MAX_PROPERTY_GALLERY_PHOTOS);
      setGalleryOverflowCount(galleryOverflowRef.current.length);
      pendingGalleryPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingGalleryPreviewUrlsRef.current.clear();
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

  const beginGalleryWrite = () => {
    if (galleryWriteInFlightRef.current) return false;
    galleryWriteInFlightRef.current = true;
    setGalleryBusy(true);
    return true;
  };

  const endGalleryWrite = () => {
    galleryWriteInFlightRef.current = false;
    setGalleryBusy(false);
  };

  useEffect(
    () => () => {
      pendingGalleryPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      pendingGalleryPreviewUrlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    setLoadFailed(false);
    setDomainStatus(null);
    setReferAGuestModuleEnabled(null);
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
    settingsService
      .getCustomDomainStatus()
      .then((status) => {
        setDomainStatus(status);
        setDomainInput("");
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Failed to load custom domain status.";
        setFeedback({ type: "error", message });
      });
    moduleActivationClient
      .list()
      .then(({ activeModules }) =>
        setReferAGuestModuleEnabled(activeModules.includes("affiliates")),
      )
      .catch(() => setReferAGuestModuleEnabled(null));
    Promise.all([
      settingsService.getDesignSettings(hotelId),
      settingsService.getPropertySettings(hotelId).catch(() => null),
      getBookingHotelPropertyLink({ hotelId }).then(async ({ propertyId }) => {
        propertyIdRef.current = propertyId;
        return Promise.all([
          sharedHotelSetupApi.getPropertyProfile(propertyId),
          sharedHotelSetupApi.getPublicPropertyProfile(propertyId),
        ]);
      }),
    ])
      .then(([settings, property, [canonicalProfile, publicProfile]]) => {
        applyPublicGallery(publicProfile);
        setHeaderLogo(settings.header_logo || "");
        setHeaderLogoMediaObjectId(settings.header_logo_media_object_id);
        setShowContactButton(settings.show_contact_button);
        setShowReferAGuestButton(settings.show_refer_a_guest_button);
        setShowLanguageSelector(settings.show_language_selector);
        setShowCurrencySelector(settings.show_currency_selector);
        if (settings.hero_image) setHeroImage(settings.hero_image);
        if (settings.hero_heading) setHeroHeading(settings.hero_heading);
        if (settings.hero_subtext) setHeroSubtext(settings.hero_subtext);
        if (settings.primary_color) setPrimaryColor(settings.primary_color);
        if (settings.font_pairing) setSelectedFont(settings.font_pairing);
        setPropertyName(property?.property_name || canonicalProfile.profile.displayName);
        if (property?.slug) setPropertySlug(property.slug);
        if (property?.default_currency) setDefaultCurrency(property.default_currency);
        if (property?.default_language) setDefaultLanguage(property.default_language);
        if (property?.supported_currencies) setSupportedCurrencies(property.supported_currencies);
        if (property?.supported_languages) setSupportedLanguages(property.supported_languages);
      })
      .catch(() => {
        setLoadFailed(true);
      })
      .finally(() => setLoading(false));
  }, [applyPublicGallery, loadAttempt]);

  const [uploading, setUploading] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

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
      try {
        await refreshCanonicalGallery();
      } catch {
        profileRevisionRef.current = null;
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
    if (!propertyId || files.length === 0) return;
    const remaining = Math.max(
      0,
      MAX_PROPERTY_GALLERY_PHOTOS - galleryImages.length - galleryOverflowRef.current.length,
    );
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
    if (!beginGalleryWrite()) return;

    setFeedback(null);
    const previewUrls = files.map((file) => URL.createObjectURL(file));
    previewUrls.forEach((url) => pendingGalleryPreviewUrlsRef.current.add(url));
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
      if (refreshed) {
        previewUrls.forEach((url) => pendingGalleryPreviewUrlsRef.current.delete(url));
      }
      if (published) setFeedback({ type: "success", message: "Property gallery updated" });
    } catch (error) {
      previewUrls.forEach((url) => {
        URL.revokeObjectURL(url);
        pendingGalleryPreviewUrlsRef.current.delete(url);
      });
      await refreshCanonicalGallery().catch(() => undefined);
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "Gallery upload failed. Try again.",
      });
    } finally {
      endGalleryWrite();
    }
  };

  const removeGalleryImage = async (index: number) => {
    if (!window.confirm("Remove this photo from the property gallery?")) return;
    if (!beginGalleryWrite()) return;
    const previous = galleryImages;
    const nextGallery = previous.filter((_, photoIndex) => photoIndex !== index);
    setGalleryImages(nextGallery);
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
      endGalleryWrite();
    }
  };

  const reorderGalleryImage = async (sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex || !beginGalleryWrite()) return;
    const previous = galleryImages;
    const nextGallery = [...previous];
    const [moved] = nextGallery.splice(sourceIndex, 1);
    if (!moved) {
      endGalleryWrite();
      return;
    }
    nextGallery.splice(targetIndex, 0, moved);
    setGalleryImages(nextGallery);
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
      endGalleryWrite();
    }
  };

  const handleLogoUpload = async (file: File) => {
    const validationError = headerLogoUploadError(file) ?? (await headerLogoDimensionsError(file));
    if (validationError) {
      setFeedback({ type: "error", message: validationError });
      if (logoInputRef.current) logoInputRef.current.value = "";
      return;
    }

    const hotelId = designHotelIdRef.current;
    if (!hotelId) {
      setFeedback({
        type: "error",
        message:
          "The Booking property is unavailable. Refresh Design Studio before uploading a logo.",
      });
      if (logoInputRef.current) logoInputRef.current.value = "";
      return;
    }

    const previousLogo = headerLogo;
    const previousLogoMediaObjectId = headerLogoMediaObjectId;
    const previewUrl = URL.createObjectURL(file);
    setHeaderLogo(previewUrl);
    setFeedback(null);

    try {
      setUploadingLogo(true);
      const uploadedLogo = await uploadSingleImageWithMediaReference(
        file,
        "booking.header_logo",
        hotelId,
      );

      URL.revokeObjectURL(previewUrl);
      setHeaderLogo(uploadedLogo.publicUrl);
      setHeaderLogoMediaObjectId(uploadedLogo.mediaObjectId);
      try {
        await settingsService.updateDesignSettings(
          { header_logo_media_object_id: uploadedLogo.mediaObjectId },
          hotelId,
        );
        await publishPublicBookabilityProfile(hotelId);
      } catch {
        setFeedback({
          type: "error",
          message:
            "Logo uploaded, but the booking header could not be refreshed. Save to try again.",
        });
      }
    } catch (error) {
      console.error("Header logo upload failed:", error);
      URL.revokeObjectURL(previewUrl);
      setHeaderLogo(previousLogo);
      setHeaderLogoMediaObjectId(previousLogoMediaObjectId);
      setFeedback({ type: "error", message: "Logo upload failed. Please try again." });
    } finally {
      setUploadingLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const addHeaderLogoUrl = async () => {
    try {
      setUploadingLogo(true);
      setFeedback(null);
      const file = await headerLogoFileFromUrl(headerLogoUrl);
      setUploadingLogo(false);
      await handleLogoUpload(file);
      setHeaderLogoUrl("");
    } catch (error) {
      setFeedback({
        type: "error",
        message: error instanceof Error ? error.message : "The logo URL could not be added.",
      });
    } finally {
      setUploadingLogo(false);
    }
  };

  const removeHeaderLogo = () => {
    setHeaderLogo("");
    setHeaderLogoMediaObjectId(null);
    if (logoInputRef.current) logoInputRef.current.value = "";
  };

  const resetContent = () => {
    setHeroHeading("");
    setHeroSubtext("");
  };

  const handleConnectDomain = async () => {
    if (!domainInput.trim()) {
      setFeedback({ type: "error", message: "Enter a custom domain." });
      return;
    }

    try {
      setSaving(true);
      setDomainBusy(true);
      setFeedback(null);
      const status = await settingsService.connectCustomDomain(domainInput);
      setDomainStatus(status);
      setDomainInput("");
      setFeedback({ type: "success", message: t("settings.feedback.domainConnected") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect custom domain.";
      setFeedback({ type: "error", message });
    } finally {
      setSaving(false);
      setDomainBusy(false);
    }
  };

  const handleDisconnectDomain = async () => {
    try {
      setSaving(true);
      setDomainBusy(true);
      setFeedback(null);
      await settingsService.disconnectCustomDomain();
      const status = await settingsService.getCustomDomainStatus();
      setDomainStatus(status);
      setDomainInput("");
      setFeedback({ type: "success", message: t("settings.feedback.domainRemoved") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove custom domain.";
      setFeedback({ type: "error", message });
    } finally {
      setSaving(false);
      setDomainBusy(false);
    }
  };

  const handleRefreshDomainStatus = async () => {
    try {
      setDomainBusy(true);
      const status = await settingsService.getCustomDomainStatus();
      setDomainStatus(status);
      if (!status.configured) setDomainInput("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh custom domain.";
      setFeedback({ type: "error", message });
    } finally {
      setDomainBusy(false);
    }
  };

  const handleSave = async () => {
    const hotelId = designHotelIdRef.current;
    if (!hotelId) return;
    try {
      setSaving(true);
      setFeedback(null);
      await settingsService.updateDesignSettings(
        {
          header_logo_media_object_id: headerLogoMediaObjectId,
          show_contact_button: showContactButton,
          ...(referAGuestModuleEnabled ? { show_refer_a_guest_button: showReferAGuestButton } : {}),
          show_language_selector: showLanguageSelector,
          show_currency_selector: showCurrencySelector,
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
    { id: "media" as const, label: "Content", icon: MediaIcon },
    { id: "colors" as const, label: "Colors", icon: ColorsIcon },
    { id: "fonts" as const, label: "Typography", icon: FontsIcon },
    { id: "layout" as const, label: "Layout", icon: LayoutIcon },
    { id: "domain" as const, label: "Domain", icon: DomainIcon },
  ];

  const currentFont = FONT_PAIRINGS.find((f) => f.id === selectedFont) || FONT_PAIRINGS[0];

  if (loading) {
    return (
      <div className="p-4 md:p-6 h-full flex items-center justify-center">
        <link href={BOOKING_PAGE_FONT_STYLESHEET_URL} rel="stylesheet" />
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="p-4 md:p-6 h-full flex items-center justify-center">
        <link href={BOOKING_PAGE_FONT_STYLESHEET_URL} rel="stylesheet" />
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
      <link href={BOOKING_PAGE_FONT_STYLESHEET_URL} rel="stylesheet" />
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
          <div className="bg-gray-100 rounded-lg p-1 grid grid-cols-5 shrink-0 sticky top-0 z-10 lg:static">
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
                headerLogo={headerLogo}
                headerLogoUrl={headerLogoUrl}
                logoInputRef={logoInputRef}
                handleLogoUpload={handleLogoUpload}
                addHeaderLogoUrl={addHeaderLogoUrl}
                setHeaderLogoUrl={setHeaderLogoUrl}
                removeHeaderLogo={removeHeaderLogo}
                uploadingLogo={uploadingLogo}
                showContactButton={showContactButton}
                setShowContactButton={setShowContactButton}
                showReferAGuestButton={showReferAGuestButton}
                setShowReferAGuestButton={setShowReferAGuestButton}
                referAGuestModuleEnabled={referAGuestModuleEnabled}
                showLanguageSelector={showLanguageSelector}
                setShowLanguageSelector={setShowLanguageSelector}
                showCurrencySelector={showCurrencySelector}
                setShowCurrencySelector={setShowCurrencySelector}
                resetContent={resetContent}
                galleryImages={galleryImages}
                galleryAtCapacity={
                  galleryImages.length + galleryOverflowCount >= MAX_PROPERTY_GALLERY_PHOTOS
                }
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

            {activeTab === "layout" && (
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <h2 className="text-[13px] font-semibold text-gray-900">Layout</h2>
                <p className="mt-1 text-[12px] text-gray-500">
                  Your responsive booking layout is applied automatically.
                </p>
              </div>
            )}

            {activeTab === "domain" && (
              <CustomDomainCard
                bookingUrl={propertySlug ? `${propertySlug}.booking.vayada.com` : ""}
                domainInput={domainInput}
                domainStatus={domainStatus}
                saving={domainBusy}
                onConnect={handleConnectDomain}
                onDisconnect={handleDisconnectDomain}
                onDomainInputChange={setDomainInput}
                onRefresh={handleRefreshDomainStatus}
              />
            )}
          </div>

          {/* Save button — desktop inline */}
          <div className="hidden lg:block pt-3 shrink-0 border-t border-gray-100">
            <SaveButton
              onClick={handleSave}
              saving={saving}
              disabled={uploading || uploadingLogo || galleryBusy}
            />
          </div>
        </div>

        {/* RIGHT: Shared live website preview */}
        <div
          className={`bg-white flex-col lg:flex lg:flex-1 lg:min-w-0 lg:min-h-0 ${
            previewOpen ? "flex fixed inset-0 z-50 lg:relative lg:inset-auto lg:z-auto" : "hidden"
          }`}
        >
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
          <BookingPagePreview
            bookingUrl={bookingPreviewUrl ?? "Your booking URL"}
            className="flex-1 rounded-none border-0 lg:rounded-lg lg:border"
            currency={defaultCurrency}
            defaultLanguage={defaultLanguage}
            font={currentFont}
            headerLogo={headerLogo}
            showContactButton={showContactButton}
            showReferAGuestButton={Boolean(referAGuestModuleEnabled && showReferAGuestButton)}
            showLanguageSelector={showLanguageSelector}
            showCurrencySelector={showCurrencySelector}
            supportedLanguages={supportedLanguages}
            supportedCurrencies={supportedCurrencies}
            heroHeading={heroHeading}
            heroImage={heroImage}
            heroSubtext={heroSubtext}
            primaryColor={primaryColor}
            propertyName={propertyName}
          />
        </div>
      </div>

      {/* Mobile-only sticky Save footer */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          onClick={handleSave}
          disabled={saving || uploading || uploadingLogo || galleryBusy}
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

function LayoutIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 9v11" />
    </svg>
  );
}

function DomainIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
