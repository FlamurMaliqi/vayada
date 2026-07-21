import { isValidSharedAccountPhone, splitSharedAccountName } from "@vayada/product-onboarding";

type CreatorIdentityDetails = {
  name?: string | null;
  phone?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
};

type CreatorProfileDetails = {
  name?: string | null;
  phone?: string | null;
  profilePicture?: string | null;
  profilePictureMediaObjectId?: string | null;
};

export function hasRequiredCreatorContactDetails(
  identity: CreatorIdentityDetails | null | undefined,
): boolean {
  const { firstName, lastName } = splitSharedAccountName(identity?.name);
  const phone = identity?.phone?.trim() ?? "";
  return Boolean(firstName && lastName && phone && isValidSharedAccountPhone(phone));
}

export function hasRequiredCreatorPhoto(
  profile: CreatorProfileDetails,
  identity?: CreatorIdentityDetails | null,
): boolean {
  return Boolean(
    (profile.profilePicture?.trim() && profile.profilePictureMediaObjectId?.trim()) ||
    (identity?.profilePictureUrl?.trim() && identity.profilePictureMediaObjectId?.trim()),
  );
}

export function hasRequiredCreatorAccountDetails(
  identity: CreatorIdentityDetails | null | undefined,
  profile: CreatorProfileDetails,
): boolean {
  return hasRequiredCreatorContactDetails(identity) && hasRequiredCreatorPhoto(profile, identity);
}

export function resolveCreatorContactDetails(
  identity: CreatorIdentityDetails | null | undefined,
  profile: CreatorProfileDetails,
): { name: string; phone: string } {
  return {
    name: profile.name?.trim() || identity?.name?.trim() || "",
    phone: profile.phone?.trim() || identity?.phone?.trim() || "",
  };
}

export function creatorIdentityPhotoPatch(
  identity: CreatorIdentityDetails | null | undefined,
  profile: CreatorProfileDetails,
): { profilePictureMediaObjectId?: string } {
  if (profile.profilePicture?.trim() && profile.profilePictureMediaObjectId?.trim()) return {};
  const identityUrl = identity?.profilePictureUrl?.trim();
  const identityMediaObjectId = identity?.profilePictureMediaObjectId?.trim();
  return identityUrl && identityMediaObjectId
    ? { profilePictureMediaObjectId: identityMediaObjectId }
    : {};
}
