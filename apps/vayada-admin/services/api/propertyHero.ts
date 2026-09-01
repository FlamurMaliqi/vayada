import { apiClient, ApiErrorResponse } from "./client";
import { uploadService } from "./upload";

export type PlatformAdminPropertyHero = {
  contractVersion: "platform-admin-property-hero.v1";
  propertyId: string;
  profileRevision: number;
  hero: { mediaObjectId: string; url: string | null } | null;
  outcome?: "updated" | "idempotent_replay";
};

export class PropertyHeroPublicationError extends Error {
  readonly cause: unknown;

  constructor(
    readonly mediaObjectId: string | null,
    cause: unknown,
  ) {
    super("Property hero publication could not be confirmed.");
    this.name = "PropertyHeroPublicationError";
    this.cause = cause;
  }
}

export function isPropertyHeroPublicationConfirmed(
  current: PlatformAdminPropertyHero,
  error: unknown,
): boolean {
  return (
    error instanceof PropertyHeroPublicationError &&
    (current.hero?.mediaObjectId ?? null) === error.mediaObjectId
  );
}

export function hasPropertyHero(mediaObjectId: string | null, previewUrl: string): boolean {
  return mediaObjectId !== null || previewUrl.startsWith("blob:");
}

function isExpectedPropertyHero(
  value: unknown,
  propertyId: string,
  mediaObjectId: string | null,
): value is PlatformAdminPropertyHero {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Partial<PlatformAdminPropertyHero>;
  const heroMatches =
    mediaObjectId === null
      ? response.hero === null
      : typeof response.hero === "object" &&
        response.hero !== null &&
        response.hero.mediaObjectId === mediaObjectId &&
        (response.hero.url === null || typeof response.hero.url === "string");
  return (
    response.contractVersion === "platform-admin-property-hero.v1" &&
    response.propertyId === propertyId &&
    Number.isSafeInteger(response.profileRevision) &&
    (response.profileRevision ?? 0) >= 1 &&
    (response.profileRevision ?? 0) <= 2_147_483_647 &&
    heroMatches &&
    (response.outcome === undefined ||
      response.outcome === "updated" ||
      response.outcome === "idempotent_replay")
  );
}

export const propertyHeroService = {
  get(propertyId: string): Promise<PlatformAdminPropertyHero> {
    return apiClient.get(`/api/platform/admin/properties/${propertyId}/media/hero`);
  },

  async replace(
    propertyId: string,
    expectedProfileRevision: number,
    mediaObjectId: string | null,
  ): Promise<PlatformAdminPropertyHero> {
    try {
      const updated: unknown = await apiClient.put(
        `/api/platform/admin/properties/${propertyId}/media/hero`,
        { expectedProfileRevision, mediaObjectId },
        {
          headers: {
            "Idempotency-Key": `admin:property-hero:${propertyId}:${expectedProfileRevision}:${mediaObjectId ?? "clear"}`,
          },
        },
      );
      if (!isExpectedPropertyHero(updated, propertyId, mediaObjectId)) {
        throw new TypeError("The property hero command returned an invalid response.");
      }
      return updated;
    } catch (error) {
      if (error instanceof ApiErrorResponse) throw error;
      throw new PropertyHeroPublicationError(mediaObjectId, error);
    }
  },

  async uploadAndReplace(
    file: File,
    propertyId: string,
    expectedProfileRevision: number,
  ): Promise<PlatformAdminPropertyHero> {
    const uploaded = await uploadService.uploadHotelProfileImage(file, propertyId);
    const updated = await propertyHeroService.replace(
      propertyId,
      expectedProfileRevision,
      uploaded.mediaObjectId,
    );
    return updated;
  },
};
