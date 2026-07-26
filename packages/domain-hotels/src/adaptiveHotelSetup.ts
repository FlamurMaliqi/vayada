export const SETUP_TRACKS = ["hotel_operations", "creator_marketplace"] as const;

export type SetupTrack = (typeof SETUP_TRACKS)[number];

export const SETUP_TRACK_COMPONENT_PRODUCTS = {
  hotel_operations: ["pms", "booking"],
  creator_marketplace: ["marketplace"],
} as const satisfies Record<SetupTrack, readonly string[]>;

export type UpdateTracksRequest = {
  selectedTracks: SetupTrack[];
  expectedRevision: number;
};

const MAX_EXPECTED_REVISION = 2_147_483_646;

export function isSetupTrack(value: unknown): value is SetupTrack {
  return typeof value === "string" && SETUP_TRACKS.includes(value as SetupTrack);
}

export function parseUpdateTracksRequest(value: unknown): UpdateTracksRequest | null {
  if (!isRecord(value)) return null;

  const selectedTracks = value["selectedTracks"];
  const expectedRevision = value["expectedRevision"];
  const materializedTracks = Array.isArray(selectedTracks) ? Array.from(selectedTracks) : null;
  if (
    materializedTracks === null ||
    materializedTracks.length === 0 ||
    !materializedTracks.every(isSetupTrack) ||
    new Set(materializedTracks).size !== materializedTracks.length ||
    !Number.isSafeInteger(expectedRevision) ||
    (expectedRevision as number) < 0 ||
    (expectedRevision as number) > MAX_EXPECTED_REVISION
  ) {
    return null;
  }

  return {
    selectedTracks: SETUP_TRACKS.filter((track) => materializedTracks.includes(track)),
    expectedRevision: expectedRevision as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
