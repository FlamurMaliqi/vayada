export type SharedAccountDetailsInput = {
  firstName: string;
  lastName: string;
  phone?: string;
  profilePictureUrl?: string;
  profilePictureMediaObjectId?: string;
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

export function isSharedAccountDetailsComplete(name?: string | null): boolean {
  const { firstName, lastName } = splitSharedAccountName(name);
  return Boolean(firstName && lastName);
}

export function normalizeSharedAccountName(firstName: string, lastName: string): string {
  return `${firstName.trim()} ${lastName.trim()}`.replace(/\s+/g, " ");
}
