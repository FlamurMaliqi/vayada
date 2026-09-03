import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { creatorService } from "@/services/api/creators";
import { ApiErrorResponse } from "@/services/api/client";
import { checkProfileStatus } from "@/lib/utils";
import { ROUTES } from "@/lib/constants/routes";
import { transformCreatorProfile } from "@/components/profile/transforms";
import { formatErrorForModal } from "./useErrorModal";
import type { CreatorProfileStatus, CreatorType } from "@/lib/types";
import type { Creator as ApiCreator } from "@/lib/types";
import { sharedAccountProfileImageError } from "@vayada/product-onboarding";
import type {
  ProfilePlatform,
  PlatformAgeGroup,
  ApiCreatorResponse,
  CreatorUpdatePayload,
  CreatorProfile,
  CreatorTab,
  PlatformName,
} from "@/components/profile/types";

function normalizeProfilePlatforms(platforms: ProfilePlatform[]): ProfilePlatform[] {
  return platforms.map((platform) => {
    const cleanAgeGroups = platform.topAgeGroups?.filter(
      (ageGroup): ageGroup is PlatformAgeGroup =>
        ageGroup !== null &&
        ageGroup.ageRange !== undefined &&
        ageGroup.ageRange !== "" &&
        ageGroup.ageRange !== "null",
    );

    return {
      ...platform,
      ...(cleanAgeGroups !== undefined ? { topAgeGroups: cleanAgeGroups } : {}),
    };
  });
}

export function useCreatorProfile(
  showError: (title: string, message: string | string[], details?: string) => void,
) {
  const router = useRouter();
  const [creatorProfile, setCreatorProfile] = useState<CreatorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileStatus, setProfileStatus] = useState<CreatorProfileStatus | null>(null);
  const [isProfileIncomplete, setIsProfileIncomplete] = useState(false);
  const [activeCreatorTab, setActiveCreatorTab] = useState<CreatorTab>("overview");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [isEditingContact, setIsEditingContact] = useState(false);
  const [isSavingContact, setIsSavingContact] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [showPictureModal, setShowPictureModal] = useState(false);
  const [profilePicturePreview, setProfilePicturePreview] = useState<string | null>(null);
  const [creatorProfilePictureFile, setCreatorProfilePictureFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const creatorImageInputRef = useRef<HTMLInputElement | null>(null);

  const [editFormData, setEditFormData] = useState({
    name: "",
    profilePicture: "",
    shortDescription: "",
    location: "",
    portfolioLink: "",
    creatorType: "Lifestyle" as CreatorType,
    platforms: [] as ProfilePlatform[],
  });

  const loadProfile = async () => {
    setLoading(true);
    try {
      const status = (await checkProfileStatus("creator")) as CreatorProfileStatus | null;
      setProfileStatus(status);

      // Treat a missing status (e.g. endpoint 404'd because profile row
      // doesn't exist yet) the same as an incomplete profile — send the
      // user straight to the completion flow.
      if (!status || !status.profile_complete) {
        setIsProfileIncomplete(true);
        setCreatorProfile(null);
        router.push(ROUTES.PROFILE_COMPLETE);
        return;
      }

      setIsProfileIncomplete(false);

      try {
        const apiProfile = await creatorService.getMyProfile();
        const profile = transformCreatorProfile(apiProfile as unknown as ApiCreatorResponse);
        setCreatorProfile(profile);
      } catch (error) {
        if (error instanceof ApiErrorResponse && error.status === 405) {
          console.warn("Profile endpoint not yet implemented:", error.status);
        } else {
          console.error("Failed to fetch creator profile:", error);
        }
        setCreatorProfile(null);
      }
    } catch (error: unknown) {
      console.error(
        "Failed to check profile status:",
        error instanceof Error ? error : String(error),
      );
      setIsProfileIncomplete(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, []);

  useEffect(() => {
    if (creatorProfile?.email) {
      setEmail(creatorProfile.email);
    }
    if (creatorProfile?.phone) {
      setPhone(creatorProfile.phone);
    }
    if (creatorProfile) {
      setEditFormData({
        name: creatorProfile.name,
        profilePicture: creatorProfile.profilePicture || "",
        shortDescription: creatorProfile.shortDescription,
        location: creatorProfile.location,
        portfolioLink: creatorProfile.portfolioLink || "",
        creatorType: creatorProfile.creatorType || "Lifestyle",
        platforms: normalizeProfilePlatforms(creatorProfile.platforms || []),
      });
    }
  }, [creatorProfile]);

  const handleSaveContact = async () => {
    if (!email || !email.includes("@")) {
      return;
    }
    if (!phone.trim()) {
      showError("Validation Error", "Phone number is required");
      return;
    }

    setIsSavingContact(true);
    try {
      const updatedProfile = await creatorService.updateMyProfile({ phone: phone.trim() });
      setCreatorProfile((current) =>
        current
          ? {
              ...current,
              email,
              phone: updatedProfile.phone ?? phone.trim(),
            }
          : current,
      );
      setIsEditingContact(false);
    } catch (error) {
      const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
      showError(
        "Failed to Save Contact Details",
        typeof detail === "string" ? detail : "Please try again.",
      );
    } finally {
      setIsSavingContact(false);
    }
  };

  const validateCreatorEdit = (): string | null => {
    if (!editFormData.name || !editFormData.name.trim()) {
      return "Name is required";
    }
    if (!editFormData.location || !editFormData.location.trim()) {
      return "Location is required";
    }
    if (!editFormData.shortDescription || editFormData.shortDescription.trim().length < 10) {
      return "Short description must be at least 10 characters";
    }
    if (editFormData.shortDescription.trim().length > 500) {
      return "Short description must be at most 500 characters";
    }
    if (
      editFormData.portfolioLink &&
      editFormData.portfolioLink.trim() &&
      !/^https?:\/\//i.test(editFormData.portfolioLink.trim())
    ) {
      return "Portfolio link must start with http or https";
    }
    if (editFormData.platforms.length === 0) {
      return "At least one platform is required";
    }
    for (let i = 0; i < editFormData.platforms.length; i++) {
      const platform = editFormData.platforms[i];
      if (
        !platform.name ||
        !["Instagram", "TikTok", "YouTube", "Facebook", "Blog", "X", "Other"].includes(
          platform.name,
        )
      ) {
        return `Platform ${i + 1}: Platform name is not supported`;
      }
      if (!platform.handle || !platform.handle.trim()) {
        return `Platform ${i + 1}: ${platform.name === "Other" ? "Platform name" : "Handle"} is required`;
      }
      if (platform.name === "Other") {
        const profileUrl = platform.profileUrl?.trim();
        if (!profileUrl) return `Platform ${i + 1}: Profile link is required`;
        try {
          if (new URL(profileUrl).protocol !== "https:") throw new Error();
        } catch {
          return `Platform ${i + 1}: Profile link must be a valid HTTPS URL`;
        }
      }
      if (!platform.followers || platform.followers <= 0) {
        return `Platform ${i + 1}: Followers must be greater than 0`;
      }
      if (!Number.isFinite(platform.engagementRate) || platform.engagementRate < 0) {
        return `Platform ${i + 1}: Engagement rate must be a non-negative number`;
      }
      if (platform.topAgeGroups && platform.topAgeGroups.length > 0) {
        const invalidAgeGroups = platform.topAgeGroups.filter((tag) => {
          const ageRange = (tag.ageRange || "").toString().trim();
          return !ageRange || ageRange === "" || ageRange === "null";
        });
        if (invalidAgeGroups.length > 0) {
          return `Platform ${i + 1}: All age groups must have a valid age range selected`;
        }
      }
    }
    return null;
  };

  const handleSaveProfile = async () => {
    const validationError = validateCreatorEdit();
    if (validationError) {
      showError("Validation Error", validationError);
      return;
    }

    if (!creatorProfile) return;

    setIsSavingProfile(true);
    try {
      const toPlatformUpdate = (platform: ProfilePlatform) => {
        const validAgeGroups =
          platform.topAgeGroups
            ?.filter((tag): tag is PlatformAgeGroup => {
              const ageRange = tag.ageRange?.trim() || "";
              return ageRange !== "" && ageRange !== "null";
            })
            .map((tag) => ({
              ageRange: tag.ageRange.trim(),
              percentage: tag.percentage,
            })) ?? [];

        return {
          id: platform.id ?? null,
          name: platform.name as PlatformName,
          handle: platform.handle.trim(),
          ...(platform.profileUrl !== undefined
            ? { profileUrl: platform.profileUrl?.trim() || null }
            : {}),
          followers: platform.followers,
          engagementRate: platform.engagementRate,
          ...(platform.topCountries !== undefined
            ? {
                topCountries: platform.topCountries.map((country) => ({
                  country: country.country,
                  percentage: country.percentage,
                })),
              }
            : {}),
          ...(platform.topAgeGroups !== undefined ? { topAgeGroups: validAgeGroups } : {}),
          ...(platform.genderSplit !== undefined
            ? {
                genderSplit: {
                  male: platform.genderSplit.male,
                  female: platform.genderSplit.female,
                  ...(platform.genderSplit.other !== undefined
                    ? { other: platform.genderSplit.other }
                    : {}),
                },
              }
            : {}),
        };
      };
      const platforms = editFormData.platforms.map(toPlatformUpdate);
      const originalPlatforms = creatorProfile.platforms.map(toPlatformUpdate);
      const platformsChanged = JSON.stringify(platforms) !== JSON.stringify(originalPlatforms);

      let profilePictureUrl: string | undefined = undefined;
      let profilePictureMediaObjectId: string | undefined = undefined;
      if (creatorProfilePictureFile) {
        try {
          const profileId = creatorProfile?.id;
          if (!profileId) {
            throw new Error("Creator profile ID is required to upload profile media.");
          }
          const uploadResponse = await creatorService.uploadProfilePicture(
            creatorProfilePictureFile,
            profileId,
          );
          profilePictureUrl = uploadResponse.url;
          profilePictureMediaObjectId = uploadResponse.mediaObjectId;
        } catch (error: unknown) {
          const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
          const message =
            typeof detail === "string"
              ? detail
              : Array.isArray(detail) && detail[0]?.msg
                ? detail[0].msg
                : "Failed to upload profile picture";
          showError("Failed to Upload Image", formatErrorForModal(detail || message));
          setIsSavingProfile(false);
          return;
        }
      }

      const updatePayload: CreatorUpdatePayload = {
        name: editFormData.name.trim(),
        location: editFormData.location.trim(),
        shortDescription: editFormData.shortDescription.trim(),
        creatorType: editFormData.creatorType,
        portfolioLink: editFormData.portfolioLink.trim() || null,
        ...(platformsChanged && { platforms }),
        ...(phone &&
          phone.trim() && {
            phone: phone.trim(),
          }),
        ...(profilePictureUrl && {
          profilePicture: profilePictureUrl,
        }),
        ...(profilePictureMediaObjectId && {
          profilePictureMediaObjectId,
        }),
      };

      const updatedProfile = await creatorService.updateMyProfile(
        updatePayload as Partial<ApiCreator>,
      );

      const responseWithSnakeCase = updatedProfile as ApiCreator & {
        profile_picture?: string | null;
      };
      const pictureUrl = updatedProfile.profilePicture || responseWithSnakeCase.profile_picture;
      if (pictureUrl && pictureUrl.trim() !== "") {
        setEditFormData((prev) => ({
          ...prev,
          profilePicture: pictureUrl,
        }));
        if (creatorProfile) {
          setCreatorProfile((prev) =>
            prev
              ? {
                  ...prev,
                  profilePicture: pictureUrl,
                }
              : null,
          );
        }
      }

      await loadProfile();

      setCreatorProfilePictureFile(null);
      setProfilePicturePreview(null);
      setIsEditingProfile(false);
    } catch (error: unknown) {
      const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
      const message =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail) && detail[0]?.msg
            ? detail[0].msg
            : "Failed to save profile";
      showError("Failed to Save Profile", formatErrorForModal(detail || message));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleCancelEdit = () => {
    if (creatorProfile) {
      setEditFormData({
        name: creatorProfile.name,
        profilePicture: creatorProfile.profilePicture || "",
        shortDescription: creatorProfile.shortDescription,
        location: creatorProfile.location,
        portfolioLink: creatorProfile.portfolioLink || "",
        creatorType: creatorProfile.creatorType || "Lifestyle",
        platforms: normalizeProfilePlatforms(creatorProfile.platforms || []),
      });
      setProfilePicturePreview(null);
      setCreatorProfilePictureFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
    setIsEditingProfile(false);
  };

  const handleCreatorImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const validationError = sharedAccountProfileImageError(file);
    if (validationError) {
      showError("Invalid Profile Photo", validationError);
      return;
    }

    try {
      setCreatorProfilePictureFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setProfilePicturePreview(reader.result as string);
        setEditFormData((prev) => ({
          ...prev,
          profilePicture: reader.result as string,
        }));
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error("Error handling image:", error);
    }
  };

  return {
    creatorProfile,
    setCreatorProfile,
    loading,
    profileStatus,
    isProfileIncomplete,
    activeCreatorTab,
    setActiveCreatorTab,
    email,
    setEmail,
    phone,
    setPhone,
    isEditingContact,
    setIsEditingContact,
    isSavingContact,
    isEditingProfile,
    setIsEditingProfile,
    isSavingProfile,
    showPictureModal,
    setShowPictureModal,
    profilePicturePreview,
    setProfilePicturePreview,
    creatorProfilePictureFile,
    setCreatorProfilePictureFile,
    editFormData,
    setEditFormData,
    fileInputRef,
    creatorImageInputRef,
    loadProfile,
    handleSaveContact,
    handleSaveProfile,
    handleCancelEdit,
    handleCreatorImageChange,
  };
}
