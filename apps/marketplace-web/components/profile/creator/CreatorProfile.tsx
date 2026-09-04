"use client";

import { useRouter } from "next/navigation";
import { PencilIcon } from "@heroicons/react/24/solid";
import { Button, ErrorModal } from "@/components/ui";
import { ROUTES } from "@/lib/constants/routes";
import { ProfilePictureModal } from "../ProfilePictureModal";
import { CreatorOverviewTab } from "./CreatorOverviewTab";
import { PlatformCardView } from "./PlatformCardView";
import { CreatorReviewsTab } from "./CreatorReviewsTab";
import { CreatorMatchingPreferencesTab } from "./CreatorMatchingPreferencesTab";
import { useCreatorProfile } from "@/hooks/useCreatorProfile";
import { useErrorModal } from "@/hooks/useErrorModal";
import { creatorService } from "@/services/api/creators";
import type { CreatorProfileStatus } from "@/lib/types";

export function CreatorProfile() {
  const router = useRouter();
  const { errorModal, showError, closeError } = useErrorModal();

  const creator = useCreatorProfile(showError);
  const {
    creatorProfile,
    setCreatorProfile,
    loading,
    profileStatus,
    isProfileIncomplete,
    activeCreatorTab,
    setActiveCreatorTab,
    phone,
    setPhone,
    isEditingProfile,
    setIsEditingProfile,
    isSavingProfile,
    showPictureModal,
    setShowPictureModal,
    setProfilePicturePreview,
    editFormData,
    setEditFormData,
    fileInputRef,
    handleSaveProfile,
    handleCancelEdit,
    handleCreatorImageChange,
  } = creator;

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

  if (isProfileIncomplete) {
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
          <h3 className="text-xl font-semibold text-gray-900 mb-2">Complete Your Profile</h3>
          <p className="text-gray-600 mb-6">
            {(profileStatus as CreatorProfileStatus)?.missing_fields
              ? `Please complete the following: ${(profileStatus as CreatorProfileStatus).missing_fields.join(", ")}`
              : "Your profile setup is not complete. Please finish the onboarding process."}
          </p>
          <Button variant="primary" onClick={() => router.push(ROUTES.PROFILE_COMPLETE)}>
            Complete Profile
          </Button>
        </div>
      </div>
    );
  }

  if (!creatorProfile) {
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
          <Button variant="primary" onClick={() => router.push(ROUTES.PROFILE_COMPLETE)}>
            Go to Profile Completion
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header with Tabs and Action Buttons */}
      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1">
            <button
              onClick={() => setActiveCreatorTab("overview")}
              aria-pressed={activeCreatorTab === "overview"}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                activeCreatorTab === "overview"
                  ? "bg-white text-gray-950 shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveCreatorTab("matching")}
              disabled={isEditingProfile}
              aria-pressed={activeCreatorTab === "matching"}
              title={isEditingProfile ? "Save or cancel profile details first" : undefined}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                activeCreatorTab === "matching"
                  ? "bg-white text-gray-950 shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              Matching
            </button>
            <button
              onClick={() => setActiveCreatorTab("platforms")}
              aria-pressed={activeCreatorTab === "platforms"}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                activeCreatorTab === "platforms"
                  ? "bg-white text-gray-950 shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              Platforms
            </button>
            <button
              onClick={() => setActiveCreatorTab("reviews")}
              aria-pressed={activeCreatorTab === "reviews"}
              className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                activeCreatorTab === "reviews"
                  ? "bg-white text-gray-950 shadow-sm"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              Reviews
            </button>
          </div>
          {activeCreatorTab === "matching" ? null : isEditingProfile ? (
            <div className="flex gap-3">
              <button
                onClick={handleCancelEdit}
                disabled={isSavingProfile}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveProfile}
                disabled={
                  isSavingProfile ||
                  !editFormData.name ||
                  !editFormData.shortDescription ||
                  !editFormData.location
                }
                className="rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingProfile ? "Saving..." : "Save Changes"}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsEditingProfile(true)}
              className="flex items-center justify-center rounded-md border border-gray-300 bg-white p-2 text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
              title="Edit Profile"
            >
              <PencilIcon className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Tab Content */}
      <div className="space-y-5 rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:p-5">
        {activeCreatorTab === "overview" && (
          <CreatorOverviewTab
            profile={creatorProfile}
            isEditing={isEditingProfile}
            editFormData={editFormData}
            phone={phone}
            onEditFormChange={setEditFormData}
            onPhoneChange={setPhone}
            onImageChange={handleCreatorImageChange}
            fileInputRef={fileInputRef}
          />
        )}

        {activeCreatorTab === "platforms" && (
          <div>
            <div className="mb-6 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-gray-950">Social Media Platforms</h2>
              <button
                type="button"
                onClick={() => router.push(`${ROUTES.PROFILE_COMPLETE}?manage-platforms=1`)}
                disabled={isEditingProfile}
                title={isEditingProfile ? "Save or cancel profile details first" : undefined}
                className="rounded-full border border-primary-200 px-3 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Manage connections
              </button>
            </div>

            {isEditingProfile && (
              <p
                role="status"
                className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              >
                Save or cancel your profile details before managing platform connections.
              </p>
            )}
            <div className="space-y-4">
              {creatorProfile.platforms && creatorProfile.platforms.length > 0 ? (
                creatorProfile.platforms.map((platform, index) => (
                  <PlatformCardView key={index} platform={platform} />
                ))
              ) : (
                <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
                  <p className="text-gray-500">
                    No platforms added yet. Use Manage connections to add an account.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <div hidden={activeCreatorTab !== "matching"}>
          <CreatorMatchingPreferencesTab
            initialPreferences={creatorProfile.matchingPreferences ?? null}
            onManageTrips={() => router.push(ROUTES.CALENDAR)}
            onSave={async (preferences) => {
              const updated = await creatorService.updateMatchingPreferences(preferences);
              const matchingPreferences = updated.matchingPreferences ?? null;
              setCreatorProfile((current) =>
                current ? { ...current, matchingPreferences } : current,
              );
              return matchingPreferences;
            }}
          />
        </div>

        {activeCreatorTab === "reviews" && <CreatorReviewsTab rating={creatorProfile.rating} />}
      </div>

      {/* Profile Picture Modal */}
      <ProfilePictureModal
        isOpen={showPictureModal}
        onClose={() => setShowPictureModal(false)}
        title="Profile Picture"
        name={creatorProfile.name}
        picture={creatorProfile.profilePicture}
        onChangePicture={(_file, preview) => {
          setProfilePicturePreview(preview);
          setEditFormData({ ...editFormData, profilePicture: preview });
          setShowPictureModal(false);
          setIsEditingProfile(true);
        }}
        onDeletePicture={() => {
          setCreatorProfile({ ...creatorProfile, profilePicture: undefined });
          setEditFormData({ ...editFormData, profilePicture: "" });
          setProfilePicturePreview(null);
        }}
        showDeleteButton={!!creatorProfile.profilePicture}
      />

      {/* Error Modal */}
      <ErrorModal
        isOpen={errorModal.isOpen}
        onClose={closeError}
        title={errorModal.title}
        message={errorModal.message}
        details={errorModal.details}
      />
    </>
  );
}
