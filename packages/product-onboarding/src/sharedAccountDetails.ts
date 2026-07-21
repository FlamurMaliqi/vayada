export type SharedAccountDetailsInput = {
  firstName: string;
  lastName: string;
  phone?: string;
  profilePictureUrl?: string;
  profilePictureMediaObjectId?: string;
};

export type SharedAccountDetailsProfile = {
  name?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
};

export function splitSharedAccountName(name?: string | null): {
  firstName: string;
  lastName: string;
} {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

export function isSharedAccountDetailsComplete(
  profile?: SharedAccountDetailsProfile | null,
): boolean {
  const { firstName, lastName } = splitSharedAccountName(profile?.name);
  return Boolean(
    firstName &&
    lastName &&
    profile?.profilePictureUrl?.trim() &&
    profile.profilePictureMediaObjectId?.trim(),
  );
}

export function normalizeSharedAccountName(firstName: string, lastName: string): string {
  return `${firstName.trim()} ${lastName.trim()}`.replace(/\s+/g, " ").trim();
}

export function isValidSharedAccountPhone(phone: string): boolean {
  const value = phone.trim();
  if (!value) return true;
  if (!/^\+?[0-9(][0-9\s().-]*$/.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15;
}
