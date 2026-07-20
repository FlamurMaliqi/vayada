import type { CreatorPlatformConnection, PlatformFormData } from "@/lib/types";

export function mergeCreatorPlatformDraft(
  draftPlatforms: PlatformFormData[],
  hydratedPlatforms: PlatformFormData[],
  connections: CreatorPlatformConnection[],
): PlatformFormData[] {
  const hydratedById = new Map(
    hydratedPlatforms
      .filter((platform): platform is PlatformFormData & { id: string } => Boolean(platform.id))
      .map((platform) => [platform.id, platform]),
  );
  const connectionsByPlatformId = new Map(
    connections
      .filter((connection): connection is CreatorPlatformConnection & { platformId: string } =>
        Boolean(connection.platformId),
      )
      .map((connection) => [connection.platformId, connection]),
  );
  const draftIds = new Set(draftPlatforms.map((platform) => platform.id).filter(Boolean));

  return [
    ...draftPlatforms.map((draft) => {
      if (!draft.id) return draft;
      const hydrated = hydratedById.get(draft.id);
      const connection = connectionsByPlatformId.get(draft.id);
      if (!hydrated || !connection) return draft;

      const importedFields = new Set(connection.importedFields);
      return {
        ...draft,
        name: hydrated.name,
        handle: hydrated.handle,
        profile_url: hydrated.profile_url,
        ...(importedFields.has("followerCount") && { followers: hydrated.followers }),
        ...(importedFields.has("engagementRate") && {
          engagement_rate: hydrated.engagement_rate,
        }),
        ...(importedFields.has("audienceCountries") && {
          top_countries: hydrated.top_countries,
        }),
        ...(importedFields.has("audienceAgeGroups") && {
          top_age_groups: hydrated.top_age_groups,
        }),
        ...(importedFields.has("audienceGenderSplit") && {
          gender_split: hydrated.gender_split,
        }),
      };
    }),
    ...hydratedPlatforms.filter((platform) => !platform.id || !draftIds.has(platform.id)),
  ];
}
