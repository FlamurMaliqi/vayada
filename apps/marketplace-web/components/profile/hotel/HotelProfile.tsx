"use client";

import { useRouter } from "next/navigation";
import { PencilIcon, PlusIcon } from "@heroicons/react/24/solid";
import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import { Button, ErrorModal } from "@/components/ui";
import { ROUTES } from "@/lib/constants/routes";
import { marketplaceSetupRedirectPath } from "@/lib/utils/sharedSetupGuard";
import { ProfilePictureModal } from "../ProfilePictureModal";
import { DeleteConfirmModal } from "../DeleteConfirmModal";
import { HotelOverviewTab } from "./HotelOverviewTab";
import { ListingViewCard } from "./ListingViewCard";
import { ListingEditorForm } from "./ListingEditorForm";
import { ManagePhotosModal } from "./ManagePhotosModal";
import { useHotelProfile } from "@/hooks/useHotelProfile";
import { useListingManagement } from "@/hooks/useListingManagement";
import { useErrorModal } from "@/hooks/useErrorModal";

export function HotelProfile() {
  const router = useRouter();
  const { errorModal, showError, closeError } = useErrorModal();

  const hotel = useHotelProfile(showError);
  const listing = useListingManagement(
    hotel.hotelProfile,
    hotel.loadProfile,
    showError,
    hotel.collapsedListingCards,
    hotel.setCollapsedListingCards,
  );

  const {
    hotelProfile,
    setHotelProfile,
    loading,
    activeHotelTab,
    setActiveHotelTab,
    phone,
    setPhone,
    isEditingHotelProfile,
    setIsEditingHotelProfile,
    isSavingHotelProfile,
    showHotelPictureModal,
    setShowHotelPictureModal,
    setHotelPicturePreview,
    setHotelProfilePictureFile,
    hotelEditFormData,
    setHotelEditFormData,
    collapsedListingCards,
    setCollapsedListingCards,
    handleSaveHotelProfile,
    handleCancelHotelEdit,
  } = hotel;

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-40 animate-pulse rounded-lg border border-gray-200 bg-white shadow-sm"
          />
        ))}
      </div>
    );
  }

  if (!hotelProfile) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
        <div className="max-w-md mx-auto">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary-50 flex items-center justify-center">
            <svg
              className="w-8 h-8 text-primary-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
              />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-gray-900 mb-2">Profile Data Unavailable</h3>
          <p className="text-gray-600 mb-6">
            Your profile status is being checked, but profile data endpoints are currently
            unavailable.
          </p>
          <Button
            variant="primary"
            onClick={() => router.push(marketplaceSetupRedirectPath(ROUTES.PROFILE))}
          >
            Continue Setup
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Tab Navigation with Edit Button */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
          <button
            onClick={() => setActiveHotelTab("overview")}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeHotelTab === "overview"
                ? "bg-white text-gray-950 shadow-sm"
                : "text-gray-500 hover:text-gray-900"
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveHotelTab("listings")}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeHotelTab === "listings"
                ? "bg-white text-gray-950 shadow-sm"
                : "text-gray-500 hover:text-gray-900"
            }`}
          >
            Listings
          </button>
        </div>
        {activeHotelTab === "overview" && (
          <>
            {!isEditingHotelProfile ? (
              <Button
                className="flex items-center justify-center rounded-md border border-gray-300 bg-white p-2 text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
                onClick={() => setIsEditingHotelProfile(true)}
                title="Edit Profile"
              >
                <PencilIcon className="w-5 h-5" />
              </Button>
            ) : (
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={handleCancelHotelEdit}
                  disabled={isSavingHotelProfile}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSaveHotelProfile}
                  isLoading={isSavingHotelProfile}
                  disabled={!hotelEditFormData.name || !hotelEditFormData.location}
                >
                  Save Changes
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Tab Content */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:p-5">
        {activeHotelTab === "overview" && (
          <HotelOverviewTab
            profile={hotelProfile}
            isEditing={isEditingHotelProfile}
            editFormData={{
              name: hotelEditFormData.name,
              picture: hotelEditFormData.picture,
              location: hotelEditFormData.location,
              website: hotelEditFormData.website,
              about: hotelEditFormData.about,
            }}
            phone={phone}
            onEditFormChange={(data) => setHotelEditFormData((prev) => ({ ...prev, ...data }))}
            onPhoneChange={setPhone}
          />
        )}
        {activeHotelTab === "listings" && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 md:p-5">
            {/* Section Header */}
            <div className="mb-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary-50 flex items-center justify-center flex-shrink-0">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-6 h-6 text-primary-600"
                  >
                    <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"></path>
                    <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"></path>
                    <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"></path>
                    <path d="M10 6h4"></path>
                    <path d="M10 10h4"></path>
                    <path d="M10 14h4"></path>
                    <path d="M10 18h4"></path>
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <h2 className="text-base font-semibold text-gray-950">Property Listings</h2>
                    {hotelProfile.listings && hotelProfile.listings.length > 0 && (
                      <span className="px-2 py-0.5 bg-gray-200 text-gray-700 rounded-full text-xs font-semibold">
                        {hotelProfile.listings.length} listing
                        {hotelProfile.listings.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500">Add and manage your property listings</p>
                </div>
              </div>
              <div className="mt-2">
                <p className="text-sm text-gray-600">
                  Define your property offerings and the type of creators you&apos;re looking for.
                </p>
              </div>
            </div>

            {hotelProfile.listings && hotelProfile.listings.length > 0 ? (
              <div className={`mt-6 space-y-3 ${listing.isAddingNewListing ? "" : "mt-6"}`}>
                {hotelProfile.listings.map((listingItem, index) => {
                  const isCollapsed = collapsedListingCards.has(listingItem.id);
                  const isEditingThis = listing.editingListingId === listingItem.id;

                  if (!isCollapsed && isEditingThis) {
                    return (
                      <div
                        key={listingItem.id}
                        className="border border-gray-200 rounded-2xl p-5 bg-white shadow-sm"
                      >
                        <div className="mt-4 pt-4 border-t border-gray-100">
                          <ListingEditorForm
                            formData={listing.listingFormData}
                            onChange={(data) => listing.setListingFormData(data)}
                            onSave={listing.handleSaveListing}
                            onCancel={listing.handleCancelListing}
                            isSaving={listing.isSavingListing}
                            isEditing={true}
                            listingImageInputRef={listing.listingImageInputRef}
                            onManagePhotos={() => listing.setIsManagePhotosOpen(true)}
                            onAddImage={() => listing.listingImageInputRef.current?.click()}
                            onImageChange={listing.handleListingImageChange}
                            countryInput={listing.listingCountryInput}
                            onCountryInputChange={(v) => listing.setListingCountryInput(v)}
                          />
                        </div>
                      </div>
                    );
                  }

                  return (
                    <ListingViewCard
                      key={listingItem.id}
                      listing={listingItem}
                      index={index}
                      isCollapsed={isCollapsed}
                      onToggleCollapse={() => {
                        const newCollapsed = new Set(collapsedListingCards);
                        if (isCollapsed) {
                          newCollapsed.delete(listingItem.id);
                        } else {
                          newCollapsed.add(listingItem.id);
                        }
                        setCollapsedListingCards(newCollapsed);
                      }}
                      onEdit={() => listing.openEditListingModal(listingItem)}
                      onDelete={() =>
                        listing.openDeleteConfirmModal(
                          listingItem.id,
                          listingItem.name || `Property Listing ${index + 1}`,
                        )
                      }
                      canDelete={hotelProfile.listings.length > 1}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 text-center py-16">
                <div className="w-20 h-20 mx-auto mb-4 rounded-xl bg-gray-100 flex items-center justify-center">
                  <HotelIcon className="w-10 h-10 text-gray-400" />
                </div>
                <p className="text-lg font-semibold text-gray-900 mb-2">No listings added yet</p>
                <p className="text-sm text-gray-600 mb-6">
                  Add property listings to complete your profile.
                </p>
                <Button
                  variant="outline"
                  onClick={listing.openAddListingModal}
                  className="border-2 border-dashed border-gray-300 hover:border-primary-400 hover:bg-primary-50"
                >
                  <PlusIcon className="w-5 h-5 mr-2" />
                  Add Property Listing
                </Button>
              </div>
            )}

            {/* New Listing Card */}
            {listing.isAddingNewListing && (
              <div className="mt-6 border border-gray-200 rounded-2xl p-5 bg-white shadow-sm">
                <ListingEditorForm
                  formData={listing.listingFormData}
                  onChange={(data) => listing.setListingFormData(data)}
                  onSave={listing.handleSaveListing}
                  onCancel={listing.handleCancelListing}
                  isSaving={listing.isSavingListing}
                  isEditing={false}
                  listingIndex={hotelProfile.listings ? hotelProfile.listings.length + 1 : 1}
                  listingImageInputRef={listing.listingImageInputRef}
                  onManagePhotos={() => listing.setIsManagePhotosOpen(true)}
                  onAddImage={() => listing.listingImageInputRef.current?.click()}
                  onImageChange={listing.handleListingImageChange}
                  countryInput={listing.listingCountryInput}
                  onCountryInputChange={(v) => listing.setListingCountryInput(v)}
                />
              </div>
            )}

            {/* Add Property Listing Button */}
            {hotelProfile.listings && hotelProfile.listings.length > 0 && (
              <button
                type="button"
                onClick={listing.openAddListingModal}
                className="w-full mt-3 py-3 border-2 border-dashed border-primary-200 rounded-lg text-primary-700 hover:border-primary-400 hover:bg-primary-50 transition-all flex items-center justify-center gap-2 font-semibold text-sm group"
              >
                <PlusIcon className="w-4 h-4 group-hover:scale-110 transition-transform" />
                Add Property Listing
              </button>
            )}

            {/* Informational Note */}
            <div className="mt-6 flex items-start gap-3 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3">
              <InformationCircleIcon className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-gray-700 leading-snug">
                Each listing can have different collaboration types, availability, and target
                audience settings.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Hotel Picture Modal */}
      <ProfilePictureModal
        isOpen={showHotelPictureModal}
        onClose={() => setShowHotelPictureModal(false)}
        title="Hotel Picture"
        name={hotelProfile.name}
        picture={hotelProfile.picture}
        onChangePicture={(file, preview) => {
          setHotelProfilePictureFile(file);
          setHotelPicturePreview(preview);
          setHotelEditFormData({ ...hotelEditFormData, picture: preview });
          setShowHotelPictureModal(false);
          setIsEditingHotelProfile(true);
        }}
        onDeletePicture={() => {
          setHotelProfile({ ...hotelProfile, picture: undefined });
          setHotelEditFormData({ ...hotelEditFormData, picture: "" });
          setHotelPicturePreview(null);
        }}
        showDeleteButton={!!hotelProfile.picture}
      />

      {/* Error Modal */}
      <ErrorModal
        isOpen={errorModal.isOpen}
        onClose={closeError}
        title={errorModal.title}
        message={errorModal.message}
        details={errorModal.details}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={listing.deleteConfirmModal.isOpen}
        onClose={() =>
          listing.setDeleteConfirmModal({ isOpen: false, listingId: null, listingName: "" })
        }
        onConfirm={listing.handleDeleteListing}
        itemName={listing.deleteConfirmModal.listingName}
        itemType="listing"
      />

      {/* Manage Photos Modal */}
      <ManagePhotosModal
        isOpen={listing.isManagePhotosOpen}
        onClose={() => listing.setIsManagePhotosOpen(false)}
        images={listing.listingFormData.images}
        onRemoveImage={listing.removeListingImage}
        onMoveImage={listing.moveListingImage}
        onAddImage={() => listing.listingImageInputRef.current?.click()}
      />
    </>
  );
}
