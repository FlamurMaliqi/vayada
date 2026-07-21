import { isSharedAccountDetailsComplete } from "@vayada/product-onboarding";

type CreatorIdentityDetails = {
  name?: string | null;
  phone?: string | null;
};

type CreatorProfileDetails = {
  profilePicture?: string | null;
  profilePictureMediaObjectId?: string | null;
};

export function hasRequiredCreatorContactDetails(
  identity: CreatorIdentityDetails | null | undefined,
): boolean {
  return Boolean(isSharedAccountDetailsComplete(identity?.name) && identity?.phone?.trim());
}

export function hasRequiredCreatorPhoto(profile: CreatorProfileDetails): boolean {
  return Boolean(profile.profilePicture?.trim() && profile.profilePictureMediaObjectId?.trim());
}

export function hasRequiredCreatorAccountDetails(
  identity: CreatorIdentityDetails | null | undefined,
  profile: CreatorProfileDetails,
): boolean {
  return hasRequiredCreatorContactDetails(identity) && hasRequiredCreatorPhoto(profile);
}
