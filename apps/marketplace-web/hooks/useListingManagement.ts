import { useState, useRef } from "react";
import { hotelService } from "@/services/api/hotels";
import { ApiErrorResponse } from "@/services/api/client";
import { transformListingToApi } from "@/components/profile/transforms";
import { createEmptyListingFormData } from "@/components/profile/types";
import { formatErrorForModal } from "./useErrorModal";
import type {
  ProfileHotelListing,
  ProfileHotelProfile,
  DeleteConfirmModalState,
} from "@/components/profile/types";

export function useListingManagement(
  hotelProfile: ProfileHotelProfile | null,
  reloadProfile: () => Promise<void>,
  showError: (title: string, message: string | string[], details?: string) => void,
  collapsedListingCards: Set<string>,
  setCollapsedListingCards: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  const [editingListingId, setEditingListingId] = useState<string | null>(null);
  const [isAddingNewListing, setIsAddingNewListing] = useState(false);
  const [isSavingListing, setIsSavingListing] = useState(false);
  const [listingFormData, setListingFormData] = useState(createEmptyListingFormData());
  const [listingImagePreview, setListingImagePreview] = useState<string | null>(null);
  const [listingCountryInput, setListingCountryInput] = useState("");
  const [isManagePhotosOpen, setIsManagePhotosOpen] = useState(false);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<DeleteConfirmModalState>({
    isOpen: false,
    listingId: null,
    listingName: "",
  });
  const listingImageInputRef = useRef<HTMLInputElement | null>(null);

  const openAddListingModal = () => {
    setListingFormData(createEmptyListingFormData());
    setEditingListingId(null);
    setListingImagePreview(null);
    setListingCountryInput("");
    setIsAddingNewListing(true);
  };

  const openEditListingModal = (listing: ProfileHotelListing) => {
    setListingFormData({
      name: listing.name,
      location: listing.location,
      description: listing.description,
      images: listing.images || [],
      accommodationType: listing.accommodationType || "",
      offerings: listing.offerings.map((o) => ({ ...o })),
      lookingForPlatforms: listing.lookingForPlatforms || [],
      targetGroupCountries: listing.targetGroupCountries || [],
      targetGroupAgeMin: listing.targetGroupAgeMin,
      targetGroupAgeMax: listing.targetGroupAgeMax,
      targetGroupAgeGroups: listing.targetGroupAgeGroups || [],
      lookingForCreatorTypes: listing.lookingForCreatorTypes || [],
    });
    setEditingListingId(listing.id);
    setListingImagePreview(null);
    setListingCountryInput("");
    setIsAddingNewListing(false);
    const newCollapsed = new Set(collapsedListingCards);
    newCollapsed.delete(listing.id);
    setCollapsedListingCards(newCollapsed);
  };

  const handleSaveListing = async () => {
    if (!listingFormData.name || !listingFormData.location || !listingFormData.description) {
      showError(
        "Validation Error",
        "Please fill in all required fields: name, location, and description.",
      );
      return;
    }

    if (listingFormData.offerings.length === 0) {
      showError("Validation Error", "Please add at least one collaboration offering.");
      return;
    }

    const incomplete = listingFormData.offerings.find(
      (o) => o.availabilityMonths.length === 0 || o.platforms.length === 0,
    );
    if (incomplete) {
      showError(
        "Validation Error",
        `Each offering needs at least one availability month and one platform (check the "${incomplete.type}" offering).`,
      );
      return;
    }

    if (!listingFormData.lookingForPlatforms.length) {
      showError("Validation Error", "Please specify platforms for creator requirements.");
      return;
    }

    setIsSavingListing(true);
    try {
      let imageUrls = listingFormData.images.filter((img) => !img.startsWith("data:"));
      let imageMediaObjectIds = listingFormData.imageMediaObjectIds ?? [];
      const base64Images = listingFormData.images.filter((img) => img.startsWith("data:"));
      const base64Files: File[] = [];

      if (base64Images.length > 0) {
        try {
          for (const base64 of base64Images) {
            const response = await fetch(base64);
            const blob = await response.blob();
            const file = new File([blob], "image.jpg", { type: blob.type });
            base64Files.push(file);
          }

          if (editingListingId) {
            const uploadResponse = await hotelService.uploadListingImages(
              base64Files,
              editingListingId,
            );
            const newImageUrls = uploadResponse.images.map((img) => img.url);
            const newMediaObjectIds = uploadResponse.images.map((img) => img.mediaObjectId);
            imageUrls = [...imageUrls, ...newImageUrls];
            imageMediaObjectIds = [...imageMediaObjectIds, ...newMediaObjectIds];
          }
        } catch (error: unknown) {
          const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
          const message =
            typeof detail === "string"
              ? detail
              : Array.isArray(detail) && detail[0]?.msg
                ? detail[0].msg
                : "Failed to upload images";
          showError("Failed to Upload Images", formatErrorForModal(detail || message));
          setIsSavingListing(false);
          return;
        }
      }

      const apiListingData = transformListingToApi({
        ...listingFormData,
        images: imageUrls,
        imageMediaObjectIds,
      });

      if (editingListingId) {
        await hotelService.updateListing(editingListingId, apiListingData);
      } else {
        const createdListing = await hotelService.createListing(apiListingData);
        if (base64Files.length > 0) {
          try {
            const uploadResponse = await hotelService.uploadListingImages(
              base64Files,
              createdListing.id,
            );
            imageUrls = [...imageUrls, ...uploadResponse.images.map((img) => img.url)];
            imageMediaObjectIds = [
              ...imageMediaObjectIds,
              ...uploadResponse.images.map((img) => img.mediaObjectId),
            ];
            await hotelService.updateListing(createdListing.id, {
              images: imageUrls,
              image_media_object_ids: imageMediaObjectIds,
            });
          } catch (error) {
            await hotelService.deleteListing(createdListing.id).catch((deleteError) => {
              console.error("Failed to clean up offer after media upload failure:", deleteError);
            });
            throw error;
          }
        }
      }

      await reloadProfile();
      handleCancelListing();
      setIsSavingListing(false);
    } catch (error: unknown) {
      const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
      const logError = error instanceof Error ? error : new Error(String(error));
      console.error("Failed to save offer:", logError);

      if (detail) {
        showError("Failed to Save Offer", formatErrorForModal(detail));
      } else {
        showError("Failed to Save Offer", "Failed to save offer. Please try again.");
      }
      setIsSavingListing(false);
    }
  };

  const handleCancelListing = () => {
    setEditingListingId(null);
    setIsAddingNewListing(false);
    setListingFormData(createEmptyListingFormData());
    setListingImagePreview(null);
    setListingCountryInput("");
    if (listingImageInputRef.current) {
      listingImageInputRef.current.value = "";
    }
  };

  const openDeleteConfirmModal = (listingId: string, listingName: string) => {
    if (!hotelProfile || hotelProfile.listings.length <= 1) {
      showError(
        "Cannot Delete Offer",
        "You must have at least one offer. Add another offer before deleting this one.",
      );
      return;
    }
    setDeleteConfirmModal({
      isOpen: true,
      listingId,
      listingName,
    });
  };

  const handleDeleteListing = async () => {
    if (!deleteConfirmModal.listingId) return;

    try {
      await hotelService.deleteListing(deleteConfirmModal.listingId);
      setDeleteConfirmModal({ isOpen: false, listingId: null, listingName: "" });
      await reloadProfile();
    } catch (error: unknown) {
      const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
      const message =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail) && detail[0]?.msg
            ? detail[0].msg
            : "Failed to delete offer";
      showError("Failed to Delete Offer", formatErrorForModal(detail || message));
      setDeleteConfirmModal({ isOpen: false, listingId: null, listingName: "" });
    }
  };

  const addListingImage = () => {
    listingImageInputRef.current?.click();
  };

  const handleListingImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);

    for (const file of fileList) {
      if (!file.type.startsWith("image/")) {
        showError("Invalid File Type", "Please select image files only");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        showError("File Too Large", `${file.name} is larger than 20MB`);
        return;
      }
    }

    if (listingFormData.images.length + fileList.length > 10) {
      showError("Too Many Images", "Maximum 10 images allowed per offer");
      return;
    }

    try {
      if (!editingListingId) {
        const previews = await Promise.all(
          fileList.map(
            (file) =>
              new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"));
                reader.readAsDataURL(file);
              }),
          ),
        );
        setListingFormData((prev) => ({
          ...prev,
          images: [...prev.images, ...previews],
        }));
        return;
      }

      const uploadResponse = await hotelService.uploadListingImages(fileList, editingListingId);
      const newImageUrls = uploadResponse.images.map((img) => img.url);
      const newMediaObjectIds = uploadResponse.images.map((img) => img.mediaObjectId);

      setListingFormData((prev) => ({
        ...prev,
        images: [...prev.images, ...newImageUrls],
        imageMediaObjectIds: [...(prev.imageMediaObjectIds ?? []), ...newMediaObjectIds],
      }));
    } catch (error: unknown) {
      const detail = error instanceof ApiErrorResponse ? error.data.detail : null;
      const message =
        typeof detail === "string"
          ? detail
          : Array.isArray(detail) && detail[0]?.msg
            ? detail[0].msg
            : "Failed to upload images";
      showError("Failed to Upload Images", formatErrorForModal(detail || message));
    } finally {
      const listingInput = listingImageInputRef.current;
      if (listingInput) {
        listingInput.value = "";
      }
    }
  };

  const moveListingImage = (index: number, direction: "left" | "right") => {
    const newImages = [...listingFormData.images];
    if (direction === "left") {
      if (index === 0) return;
      const temp = newImages[index];
      newImages[index] = newImages[index - 1];
      newImages[index - 1] = temp;
    } else {
      if (index === newImages.length - 1) return;
      const temp = newImages[index];
      newImages[index] = newImages[index + 1];
      newImages[index + 1] = temp;
    }
    setListingFormData((prev) => ({ ...prev, images: newImages }));
  };

  const removeListingImage = (index: number) => {
    setListingFormData((prev) => ({
      ...prev,
      images: prev.images.filter((_, i) => i !== index),
    }));
  };

  return {
    editingListingId,
    isAddingNewListing,
    isSavingListing,
    listingFormData,
    setListingFormData,
    listingImagePreview,
    listingCountryInput,
    setListingCountryInput,
    isManagePhotosOpen,
    setIsManagePhotosOpen,
    deleteConfirmModal,
    setDeleteConfirmModal,
    listingImageInputRef,
    openAddListingModal,
    openEditListingModal,
    handleSaveListing,
    handleCancelListing,
    openDeleteConfirmModal,
    handleDeleteListing,
    addListingImage,
    handleListingImageChange,
    moveListingImage,
    removeListingImage,
  };
}
