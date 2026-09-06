/** Hotel-owned curation. Provider display content is deliberately absent. */
export const NEARBY_CATEGORIES = ["nature", "food", "activities", "transport"] as const;
export type NearbyCategory = (typeof NEARBY_CATEGORIES)[number];
export const NEARBY_MAX_REQUEST_BYTES = 65_536;

export type NearbyChoice = {
  placeId: string;
  category: NearbyCategory;
  hidden: boolean;
  favorite: boolean;
  added: boolean;
  note: string | null;
};
export type NearbyCustomPlace = {
  id: string;
  category: NearbyCategory;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  favorite: boolean;
  hidden: boolean;
  note: string | null;
};
export type NearbyCuration = {
  choices: NearbyChoice[];
  customPlaces: NearbyCustomPlace[];
};
export type NearbyCurationWrite = NearbyCuration & {
  schemaVersion: 1;
  expectedProfileRevision: number;
  expectedCurationRevision: number;
};
export type NearbyCurationState = NearbyCuration & {
  schemaVersion: 1;
  profileRevision: number;
  curationRevision: number;
  /** Last profile revision against which the host saved these choices. */
  savedProfileRevision: number | null;
};
export type NearbyWriteError =
  | "invalid_request"
  | "payload_too_large"
  | "revision_conflict"
  | "unknown_place";
export type NearbyParseResult =
  | { ok: true; value: NearbyCurationWrite }
  | { ok: false; code: NearbyWriteError };

const WRITE_KEYS = [
  "schemaVersion",
  "expectedProfileRevision",
  "expectedCurationRevision",
  "choices",
  "customPlaces",
];
const CHOICE_KEYS = ["placeId", "category", "hidden", "favorite", "added", "note"];
const CUSTOM_KEYS = [
  "id",
  "category",
  "name",
  "address",
  "latitude",
  "longitude",
  "favorite",
  "hidden",
  "note",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseNearbyCurationWrite(input: unknown): NearbyParseResult {
  if (
    !recordWithKeys(input, WRITE_KEYS) ||
    input.schemaVersion !== 1 ||
    !revision(input.expectedProfileRevision) ||
    !revision(input.expectedCurationRevision) ||
    !Array.isArray(input.choices) ||
    input.choices.length > 100 ||
    !Array.isArray(input.customPlaces) ||
    input.customPlaces.length > 20
  )
    return invalid();

  const choices: NearbyChoice[] = [];
  for (const choice of input.choices) {
    if (
      !recordWithKeys(choice, CHOICE_KEYS) ||
      !isNearbyPlaceId(choice.placeId) ||
      !category(choice.category) ||
      !flags(choice) ||
      typeof choice.added !== "boolean" ||
      !text(choice.note, 500, true)
    )
      return invalid();
    choices.push({
      placeId: choice.placeId,
      category: choice.category,
      hidden: choice.hidden as boolean,
      favorite: choice.favorite as boolean,
      added: choice.added,
      note: normalize(choice.note as string | null),
    });
  }
  const customPlaces: NearbyCustomPlace[] = [];
  for (const place of input.customPlaces) {
    if (
      !recordWithKeys(place, CUSTOM_KEYS) ||
      typeof place.id !== "string" ||
      !UUID.test(place.id) ||
      !category(place.category) ||
      !flags(place) ||
      !text(place.name, 120, false) ||
      !text(place.address, 300, true) ||
      !text(place.note, 500, true) ||
      !coordinate(place.latitude, 90) ||
      !coordinate(place.longitude, 180)
    )
      return invalid();
    customPlaces.push({
      id: place.id.toLowerCase(),
      category: place.category,
      name: (place.name as string).trim(),
      address: normalize(place.address as string | null),
      latitude: place.latitude,
      longitude: place.longitude,
      favorite: place.favorite as boolean,
      hidden: place.hidden as boolean,
      note: normalize(place.note as string | null),
    });
  }
  if (
    new Set(choices.map(({ placeId }) => placeId)).size !== choices.length ||
    new Set(customPlaces.map(({ id }) => id)).size !== customPlaces.length ||
    choices.filter(({ added }) => added).length + customPlaces.length > 20
  )
    return invalid();

  const value: NearbyCurationWrite = {
    schemaVersion: 1,
    expectedProfileRevision: input.expectedProfileRevision,
    expectedCurationRevision: input.expectedCurationRevision,
    choices,
    customPlaces,
  };
  // The HTTP adapter must also enforce the raw body limit before JSON parsing.
  if (new TextEncoder().encode(JSON.stringify(value)).length > NEARBY_MAX_REQUEST_BYTES) {
    return { ok: false, code: "payload_too_large" };
  }
  return { ok: true, value };
}

/** Call under the same transaction/lock as persistence, with trusted property-scoped IDs. */
export function checkNearbyCurationWrite(
  write: NearbyCurationWrite,
  current: NearbyCurationState,
  discoveredPlaceIds: ReadonlySet<string>,
): "revision_conflict" | "unknown_place" | null {
  if (
    write.expectedProfileRevision !== current.profileRevision ||
    write.expectedCurationRevision !== current.curationRevision
  )
    return "revision_conflict";
  // Only validated persisted choices qualify; legacy imports must not enter this set unchecked.
  const savedIds = new Set(current.choices.map(({ placeId }) => placeId));
  return write.choices.some(
    ({ placeId }) => !savedIds.has(placeId) && !discoveredPlaceIds.has(placeId),
  )
    ? "unknown_place"
    : null;
}

export function isNearbyPlaceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value);
}
function recordWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function revision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
  );
}
function category(value: unknown): value is NearbyCategory {
  return typeof value === "string" && (NEARBY_CATEGORIES as readonly string[]).includes(value);
}
function flags(value: Record<string, unknown>): boolean {
  return (
    typeof value.hidden === "boolean" &&
    typeof value.favorite === "boolean" &&
    !(value.hidden && value.favorite)
  );
}
function text(value: unknown, max: number, nullable: boolean): boolean {
  if (value === null) return nullable;
  return (
    typeof value === "string" &&
    value.length <= max &&
    (nullable || value.trim().length > 0) &&
    !/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)
  );
}
function normalize(value: string | null): string | null {
  return value?.trim() || null;
}
function coordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}
function invalid(): NearbyParseResult {
  return { ok: false, code: "invalid_request" };
}
