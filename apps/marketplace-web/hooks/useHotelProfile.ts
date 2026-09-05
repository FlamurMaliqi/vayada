import { useState, useEffect, useRef } from "react";
import {
  advanceHotelProfileRevisionsAfterCoverUpload,
  HotelAddressSetupRequiredError,
  hotelService,
  type PlatformImageUploadResponse,
  type UpdateHotelProfileRequest,
} from "@/services/api/hotels";
import { ApiErrorResponse } from "@/services/api/client";
import { checkProfileStatus } from "@/lib/utils";
import { transformHotelProfile } from "@/components/profile/transforms";
import { formatErrorForModal } from "./useErrorModal";
import type { HotelProfileStatus } from "@/lib/types";
import type { ProfileHotelProfile } from "@/components/profile/types";
import { normalizeHotelWebsite } from "@/lib/utils/hotelWebsite";

type HotelProfileDetailsForm = {
  name: string;
  picture: string;
  location: string;
  localityPublic: boolean;
  website: string;
  about: string;
};

type HotelProfileDetailsUpdateRequest = Omit<UpdateHotelProfileRequest, "email">;

export function buildHotelProfileDetailsUpdate(
  hotelProfile: Pick<
    ProfileHotelProfile,
    "name" | "picture" | "location" | "localityPublic" | "website" | "about" | "phone"
  >,
  form: HotelProfileDetailsForm,
  phone: string,
  uploadedPicture?: Pick<PlatformImageUploadResponse, "url" | "mediaObjectId">,
): HotelProfileDetailsUpdateRequest {
  const payload: HotelProfileDetailsUpdateRequest = {};

  if (form.name.trim() !== hotelProfile.name) {
    payload.name = form.name.trim();
  }
  if (form.location.trim() !== hotelProfile.location) {
    payload.location = form.location.trim();
  }
  if (form.localityPublic !== hotelProfile.localityPublic) {
    payload.localityPublic = form.localityPublic;
  }
  if ((form.website || "") !== (hotelProfile.website || "")) {
    payload.website = normalizeHotelWebsite(form.website) || null;
  }
  if ((form.about || "") !== (hotelProfile.about || "")) {
    payload.about = form.about.trim() || null;
  }
  if ((phone || "") !== (hotelProfile.phone || "")) {
    payload.phone = phone || undefined;
  }

  if (uploadedPicture) {
    payload.picture = uploadedPicture.url;
    payload.pictureMediaObjectId = uploadedPicture.mediaObjectId;
    payload.picture_media_object_id = uploadedPicture.mediaObjectId;
  } else {
    const currentPicture = hotelProfile.picture || "";
    const newPicture = form.picture || "";
    if (newPicture !== currentPicture) {
      if (newPicture.trim() === "") {
        payload.picture = null;
      } else if (!newPicture.startsWith("data:")) {
        payload.picture = newPicture.trim();
      }
    }
  }

  return payload;
}

export function useHotelProfile(
  showError: (title: string, message: string | string[], details?: string) => void,
) {
  const [hotelProfile, setHotelProfile] = useState<ProfileHotelProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeHotelTab, setActiveHotelTab] = useState<"overview" | "listings">("overview");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [isEditingContact, setIsEditingContact] = useState(false);
  const [isSavingContact, setIsSavingContact] = useState(false);
  const [isEditingHotelProfile, setIsEditingHotelProfile] = useState(false);
  const [isSavingHotelProfile, setIsSavingHotelProfile] = useState(false);
  const [showHotelPictureModal, setShowHotelPictureModal] = useState(false);
  const [hotelPicturePreview, setHotelPicturePreview] = useState<string | null>(null);
  const [hotelProfilePictureFile, setHotelProfilePictureFile] = useState<File | null>(null);
  const hotelFileInputRef = useRef<HTMLInputElement | null>(null);

  const [hotelEditFormData, setHotelEditFormData] = useState({
    name: "",
    picture: "",
    location: "",
    localityPublic: false,
    website: "",
    about: "",
    collaborationTypes: [] as ("Free Stay" | "Paid" | "Discount" | "Affiliate")[],
    availability: [] as string[],
    platforms: [] as string[],
    freeStayMinNights: undefined as number | undefined,
    freeStayMaxNights: undefined as number | undefined,
    paidMaxAmount: undefined as number | undefined,
    currency: undefined as string | undefined,
    discountPercentage: undefined as number | undefined,
    commissionPercentage: undefined as number | undefined,
    lookingForPlatforms: [] as string[],
    targetGroupCountries: [] as string[],
    targetGroupAgeMin: undefined as number | undefined,
    targetGroupAgeMax: undefined as number | undefined,
  });

  const [collapsedListingCards, setCollapsedListingCards] = useState<Set<string>>(new Set());

  const loadProfile = async () => {
    setLoading(true);
    try {
      const status = (await checkProfileStatus("hotel")) as HotelProfileStatus | null;
      if (status?.missing_offers) {
        setActiveHotelTab("listings");
      }

      try {
        const apiProfile = await hotelService.getMyProfile();
        const profile = transformHotelProfile(apiProfile);
        setHotelProfile(profile);
      } catch (error) {
        if (error instanceof ApiErrorResponse && error.status === 405) {
          console.warn("Profile endpoint not yet implemented:", error.status);
        } else {
          console.error("Failed to fetch hotel profile:", error);
        }
        setHotelProfile(null);
      }
    } catch (error: unknown) {
      console.error(
        "Failed to check profile status:",
        error instanceof Error ? error : String(error),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, []);

  useEffect(() => {
    if (hotelProfile) {
      setHotelEditFormData({
        name: hotelProfile.name,
        picture: hotelProfile.picture || "",
        location: hotelProfile.location,
        localityPublic: hotelProfile.localityPublic,
        website: hotelProfile.website || "",
        about: hotelProfile.about || "",
        collaborationTypes: [],
        availability: [],
        platforms: [],
        freeStayMinNights: undefined,
        freeStayMaxNights: undefined,
        paidMaxAmount: undefined,
        currency: undefined,
        discountPercentage: undefined,
        commissionPercentage: undefined,
        lookingForPlatforms: [],
        targetGroupCountries: [],
        targetGroupAgeMin: undefined,
        targetGroupAgeMax: undefined,
      });
      setEmail(hotelProfile.email);
      setPhone(hotelProfile.phone || "");
      if (hotelProfile.listings && hotelProfile.listings.length > 0) {
        setCollapsedListingCards(new Set(hotelProfile.listings.map((listing) => listing.id)));
      } else {
        setCollapsedListingCards(new Set());
      }
    }
  }, [hotelProfile]);

  const validateHotelEdit = (): string | null => {
    if (hotelEditFormData.name && !hotelEditFormData.name.trim()) {
      return "Name cannot be empty";
    }
    if (hotelEditFormData.location && !hotelEditFormData.location.trim()) {
      return "Location cannot be empty";
    }
    if (
      hotelEditFormData.location &&
      hotelEditFormData.location.trim().toLowerCase() === "not specified"
    ) {
      return 'Location cannot be "Not specified"';
    }
    if (
      hotelEditFormData.about &&
      hotelEditFormData.about.trim().length > 0 &&
      hotelEditFormData.about.trim().length < 50
    ) {
      return "About must be at least 50 characters when provided";
    }
    try {
      normalizeHotelWebsite(hotelEditFormData.website);
    } catch (error) {
      return (error as Error).message;
    }
    if (phone !== undefined && phone !== null && phone.trim() === "") {
      return "Phone cannot be empty if provided";
    }
    return null;
  };

  const handleSaveHotelProfile = async () => {
    const validationError = validateHotelEdit();
    if (validationError) {
      showError("Validation Error", validationError);
      return;
    }

    if (!hotelProfile) return;

    setIsSavingHotelProfile(true);
    try {
      let uploadedPicture: PlatformImageUploadResponse | undefined;
      let revisions = {
        canonicalProfileRevision: hotelProfile.canonicalProfileRevision,
        publicProfileRevision: hotelProfile.publicProfileRevision,
      };
      if (hotelProfilePictureFile) {
        uploadedPicture = await hotelService.uploadProfileImage(
          hotelProfilePictureFile,
          hotelProfile.id,
          revisions.canonicalProfileRevision,
        );
        revisions = advanceHotelProfileRevisionsAfterCoverUpload(revisions);
      }

      const payload = buildHotelProfileDetailsUpdate(
        hotelProfile,
        hotelEditFormData,
        phone,
        uploadedPicture,
      );
      if (Object.keys(payload).length === 0) {
        setIsEditingHotelProfile(false);
        setIsSavingHotelProfile(false);
        return;
      }

      const updatedProfile = await hotelService.updateMyProfile(payload, undefined, revisions);

      if (updatedProfile && updatedProfile.picture) {
        setHotelEditFormData((prev) => ({
          ...prev,
          picture: updatedProfile.picture || "",
        }));
        setHotelProfile((prev) =>
          prev
            ? {
                ...prev,
                picture: updatedProfile.picture || undefined,
              }
            : null,
        );
      }

      await loadProfile();

      setIsEditingHotelProfile(false);

      const hotelInput = hotelFileInputRef.current;
      if (hotelInput) {
        hotelInput.value = "";
      }
      setHotelPicturePreview(null);
      setHotelProfilePictureFile(null);
    } catch (error: unknown) {
      showError(
        "Failed to Save Profile",
        formatErrorForModal(profileSaveErrorMessage(error, "Failed to save profile")),
      );
    } finally {
      setIsSavingHotelProfile(false);
    }
  };

  const handleCancelHotelEdit = () => {
    if (hotelProfile) {
      setHotelEditFormData({
        name: hotelProfile.name,
        picture: hotelProfile.picture || "",
        location: hotelProfile.location,
        localityPublic: hotelProfile.localityPublic,
        website: hotelProfile.website || "",
        about: hotelProfile.about || "",
        collaborationTypes: [],
        availability: [],
        platforms: [],
        freeStayMinNights: undefined,
        freeStayMaxNights: undefined,
        paidMaxAmount: undefined,
        currency: undefined,
        discountPercentage: undefined,
        commissionPercentage: undefined,
        lookingForPlatforms: [],
        targetGroupCountries: [],
        targetGroupAgeMin: undefined,
        targetGroupAgeMax: undefined,
      });
      setEmail(hotelProfile.email);
      setPhone(hotelProfile.phone || "");
      setHotelPicturePreview(null);
      setHotelProfilePictureFile(null);
      if (hotelFileInputRef.current) {
        hotelFileInputRef.current.value = "";
      }
    }
    setIsEditingHotelProfile(false);
  };

  const handleSaveHotelContact = async () => {
    if (!email || !email.includes("@")) {
      showError("Validation Error", "Please enter a valid email address");
      return;
    }

    if (!hotelProfile) return;

    setIsSavingContact(true);
    try {
      const payload: {
        email?: string;
        phone?: string;
      } = {};

      if (email !== hotelProfile.email) {
        payload.email = email;
      }
      if ((phone || "") !== (hotelProfile.phone || "")) {
        payload.phone = phone || undefined;
      }

      if (Object.keys(payload).length === 0) {
        setIsEditingContact(false);
        setIsSavingContact(false);
        return;
      }

      await hotelService.updateMyProfile(payload, undefined, {
        canonicalProfileRevision: hotelProfile.canonicalProfileRevision,
        publicProfileRevision: hotelProfile.publicProfileRevision,
      });
      await loadProfile();
      setIsEditingContact(false);
    } catch (error: unknown) {
      showError(
        "Failed to Save Contact Information",
        formatErrorForModal(profileSaveErrorMessage(error, "Failed to save contact information")),
      );
    } finally {
      setIsSavingContact(false);
    }
  };

  return {
    hotelProfile,
    setHotelProfile,
    loading,
    activeHotelTab,
    setActiveHotelTab,
    email,
    setEmail,
    phone,
    setPhone,
    isEditingContact,
    setIsEditingContact,
    isSavingContact,
    isEditingHotelProfile,
    setIsEditingHotelProfile,
    isSavingHotelProfile,
    showHotelPictureModal,
    setShowHotelPictureModal,
    hotelPicturePreview,
    setHotelPicturePreview,
    hotelProfilePictureFile,
    setHotelProfilePictureFile,
    hotelEditFormData,
    setHotelEditFormData,
    hotelFileInputRef,
    collapsedListingCards,
    setCollapsedListingCards,
    loadProfile,
    handleSaveHotelProfile,
    handleCancelHotelEdit,
    handleSaveHotelContact,
  };
}

export function profileSaveErrorMessage(error: unknown, fallback: string): string | string[] {
  if (error instanceof ApiErrorResponse && error.data.code === "profile_revision_conflict") {
    return "This hotel profile changed in another tab. Refresh the page and make your changes again.";
  }
  if (error instanceof HotelAddressSetupRequiredError) return error.message;

  const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail[0]?.msg) return detail[0].msg;
  return fallback;
}
