import { apiClient } from "./client";
import { uploadService } from "./upload";

export type PlatformAdminPropertyHero = {
  contractVersion: "platform-admin-property-hero.v1";
  propertyId: string;
  profileRevision: number;
  hero: { mediaObjectId: string; url: string | null } | null;
  outcome?: "updated" | "idempotent_replay";
};

export function hasPropertyHero(mediaObjectId: string | null, previewUrl: string): boolean {
  return mediaObjectId !== null || previewUrl.startsWith("blob:");
}

export const propertyHeroService = {
  get(propertyId: string): Promise<PlatformAdminPropertyHero> {
    return apiClient.get(`/api/platform/admin/properties/${propertyId}/media/hero`);
  },

  replace(
    propertyId: string,
    expectedProfileRevision: number,
    mediaObjectId: string | null,
  ): Promise<PlatformAdminPropertyHero> {
    return apiClient.put(
      `/api/platform/admin/properties/${propertyId}/media/hero`,
      { expectedProfileRevision, mediaObjectId },
      {
        headers: {
          "Idempotency-Key": `admin:property-hero:${propertyId}:${expectedProfileRevision}:${mediaObjectId ?? "clear"}`,
        },
      },
    );
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
    if (updated.hero?.mediaObjectId !== uploaded.mediaObjectId) {
      throw new Error("The published hero did not match the uploaded media object.");
    }
    return updated;
  },
};
