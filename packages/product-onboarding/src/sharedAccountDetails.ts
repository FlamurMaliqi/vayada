export type SharedAccountDetailsInput = {
  firstName: string;
  lastName: string;
  phone: string;
  profilePictureUrl?: string;
  profilePictureMediaObjectId?: string;
};

export type SharedAccountDetailsProfile = {
  name?: string | null;
  phone?: string | null;
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
  const phone = profile?.phone?.trim() ?? "";
  return Boolean(firstName && lastName && phone && isValidSharedAccountPhone(phone));
}

export function sharedAccountInitials(firstName: string, lastName: string): string {
  const parts = normalizeSharedAccountName(firstName, lastName).split(" ").filter(Boolean);
  if (parts.length === 0) return "?";
  return `${parts[0]?.charAt(0) ?? ""}${parts.at(-1)?.charAt(0) ?? ""}`
    .slice(0, parts.length === 1 ? 1 : 2)
    .toLocaleUpperCase();
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
