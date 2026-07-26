export const SETUP_TRACKS = Object.freeze(["hotel_operations", "creator_marketplace"] as const);

export type SetupTrack = (typeof SETUP_TRACKS)[number];

export const SETUP_TRACK_COMPONENT_PRODUCTS = Object.freeze({
  hotel_operations: Object.freeze(["pms", "booking"] as const),
  creator_marketplace: Object.freeze(["marketplace"] as const),
}) satisfies Record<SetupTrack, readonly string[]>;

export type UpdateTracksRequest = {
  selectedTracks: SetupTrack[];
  expectedRevision: number;
};

export type SetupComponentProduct = "pms" | "booking" | "marketplace";

export type TrackStatus = {
  track: SetupTrack;
  provisioning: "not_selected" | "active" | "blocked";
  components: Array<{
    product: SetupComponentProduct;
    access: "absent" | "active" | "suspended" | "unavailable";
  }>;
  allowedActions: Array<"add" | "manage_service">;
};

export type UpdateTracksResponse = {
  trackRevision: number;
  selectedTracks: SetupTrack[];
  tracks: TrackStatus[];
};

export type SetupCommandError = {
  code:
    | "invalid_setup_request"
    | "track_revision_conflict"
    | "idempotency_key_conflict"
    | "command_in_progress"
    | "track_removal_requires_service_management";
  currentRevision?: number;
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
