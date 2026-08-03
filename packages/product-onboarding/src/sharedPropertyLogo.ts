const PROPERTY_LOGO_MAX_BYTES = 10 * 1024 * 1024;
const PROPERTY_LOGO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PENDING_PROPERTY_LOGO_PREFIX = "vayada:hotel-prerequisite:pending-logo:";

export type PendingPropertyLogoAssignment = {
  mediaObjectId: string;
  expectedProfileRevision: number;
  assignmentIdempotencyKey: string;
};

type PropertyLogoStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function sharedPropertyLogoError(file: File): string | null {
  if (
    ["image/heic", "image/heif"].includes(file.type.toLowerCase()) ||
    /\.(heic|heif)$/i.test(file.name)
  ) {
    return "HEIC and HEIF logos aren’t supported yet. Convert the logo to JPG, PNG, or WebP and try again.";
  }
  if (
    !PROPERTY_LOGO_TYPES.has(file.type) &&
    !(file.type === "" && /\.(jpe?g|png|webp)$/i.test(file.name))
  ) {
    return "Choose a JPG, PNG, or WebP logo.";
  }
  if (file.size === 0) return "Choose a logo that isn’t empty.";
  if (file.size > PROPERTY_LOGO_MAX_BYTES) return "Choose a logo smaller than 10 MB.";
  return null;
}

export function sharedPropertyLogoContentType(file: File): string {
  if (file.type) return file.type;
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
}

export function readPendingPropertyLogo(
  storage: PropertyLogoStorage,
  propertyId: string,
): PendingPropertyLogoAssignment | null {
  try {
    const value = JSON.parse(storage.getItem(pendingPropertyLogoKey(propertyId)) ?? "null");
    return isPendingPropertyLogo(value) ? value : null;
  } catch {
    return null;
  }
}

export function writePendingPropertyLogo(
  storage: PropertyLogoStorage,
  propertyId: string,
  pending: PendingPropertyLogoAssignment,
): void {
  storage.setItem(pendingPropertyLogoKey(propertyId), JSON.stringify(pending));
}

export function clearPendingPropertyLogo(storage: PropertyLogoStorage, propertyId: string): void {
  storage.removeItem(pendingPropertyLogoKey(propertyId));
}

function pendingPropertyLogoKey(propertyId: string): string {
  return `${PENDING_PROPERTY_LOGO_PREFIX}${propertyId}`;
}

function isPendingPropertyLogo(value: unknown): value is PendingPropertyLogoAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  return (
    Reflect.ownKeys(pending).length === 3 &&
    typeof pending.mediaObjectId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      pending.mediaObjectId,
    ) &&
    Number.isSafeInteger(pending.expectedProfileRevision) &&
    (pending.expectedProfileRevision as number) > 0 &&
    typeof pending.assignmentIdempotencyKey === "string" &&
    pending.assignmentIdempotencyKey.length > 0 &&
    pending.assignmentIdempotencyKey.length <= 200
  );
}
