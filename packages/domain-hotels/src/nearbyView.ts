import {
  NEARBY_CATEGORIES,
  isNearbyPlaceId,
  parseNearbyCurationWrite,
  type NearbyCategory,
  type NearbyCurationState,
  type NearbyCustomPlace,
} from "./propertyNearby.js";
import type { PropertyProfileLocation } from "./propertyProfile.js";

export type NearbyDiscoveryState = {
  schemaVersion: 1;
  profileRevision: number;
  status:
    | "ready"
    | "empty"
    | "refreshing"
    | "stale"
    | "not_configured"
    | "location_required"
    | "quota_exhausted"
    | "timeout"
    | "provider_unavailable"
    | "invalid_response";
  places: { placeId: string; category: NearbyCategory }[];
  retryAfter: string | null;
};
export type NearbyPublicPlace =
  | {
      source: "google";
      placeId: string;
      category: NearbyCategory;
      favorite: boolean;
      note: string | null;
    }
  | ({ source: "custom" } & Omit<NearbyCustomPlace, "hidden">);
export type NearbyPreview = {
  location: { mode: "exact" | "approximate"; latitude: number; longitude: number } | null;
  places: NearbyPublicPlace[];
};

/** Used by the editor preview and the guest projection; never expose private origins. */
export function projectNearbyPreview(
  location: PropertyProfileLocation,
  revision: number,
  curation: NearbyCurationState,
  discovery: NearbyDiscoveryState | null,
): NearbyPreview {
  if (
    !location.geoPublic ||
    location.mapDisplayMode === "hidden" ||
    location.latitude === null ||
    location.longitude === null ||
    !Number.isFinite(location.latitude) ||
    Math.abs(location.latitude) > 90 ||
    !Number.isFinite(location.longitude) ||
    Math.abs(location.longitude) > 180
  )
    return { location: null, places: [] };
  const round = (value: number) =>
    Number(
      new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, useGrouping: false }).format(
        value,
      ),
    );
  const current =
    curation.profileRevision === revision && curation.savedProfileRevision === revision;
  const choices = new Map(curation.choices.map((choice) => [choice.placeId, choice]));
  const candidates = new Map<string, NearbyCategory>();
  if (discovery?.profileRevision === revision && discovery.status === "ready")
    for (const place of discovery.places) candidates.set(place.placeId, place.category);
  if (current)
    for (const choice of curation.choices)
      if (choice.added || choice.favorite) candidates.set(choice.placeId, choice.category);
  const places: NearbyPublicPlace[] = [];
  for (const [placeId, category] of candidates) {
    const choice = choices.get(placeId);
    if (choice?.hidden) continue; // Exclusions survive location changes.
    places.push({
      source: "google",
      placeId,
      category: current ? (choice?.category ?? category) : category,
      favorite: current && Boolean(choice?.favorite),
      note: current ? (choice?.note ?? null) : null,
    });
  }
  if (current)
    for (const { hidden, ...place } of curation.customPlaces)
      if (!hidden) places.push({ source: "custom", ...place });
  // Stable order preserves provider ranking within each category/favorite group.
  places.sort((a, b) => Number(b.favorite) - Number(a.favorite));
  return {
    location: {
      mode: location.mapDisplayMode,
      latitude:
        location.mapDisplayMode === "approximate" ? round(location.latitude) : location.latitude,
      longitude:
        location.mapDisplayMode === "approximate" ? round(location.longitude) : location.longitude,
    },
    places,
  };
}

export function parseNearbyCurationState(value: unknown): NearbyCurationState {
  const row = object(value);
  const parsed = parseNearbyCurationWrite({
    schemaVersion: row.schemaVersion,
    expectedProfileRevision: row.profileRevision,
    expectedCurationRevision: row.curationRevision,
    choices: row.choices,
    customPlaces: row.customPlaces,
  });
  if (
    !parsed.ok ||
    !positiveRevision(row.profileRevision) ||
    (row.savedProfileRevision !== null && !positiveRevision(row.savedProfileRevision))
  )
    throw new Error("Nearby place data is invalid. Reload and try again.");
  return {
    schemaVersion: 1,
    profileRevision: row.profileRevision,
    curationRevision: parsed.value.expectedCurationRevision,
    savedProfileRevision: row.savedProfileRevision as number | null,
    choices: parsed.value.choices,
    customPlaces: parsed.value.customPlaces,
  };
}
export function parseNearbyDiscoveryState(value: unknown): NearbyDiscoveryState {
  const row = object(value);
  const statuses: NearbyDiscoveryState["status"][] = [
    "ready",
    "empty",
    "refreshing",
    "stale",
    "not_configured",
    "location_required",
    "quota_exhausted",
    "timeout",
    "provider_unavailable",
    "invalid_response",
  ];
  if (
    row.schemaVersion !== 1 ||
    !positiveRevision(row.profileRevision) ||
    !statuses.includes(row.status as NearbyDiscoveryState["status"]) ||
    !Array.isArray(row.places) ||
    row.places.length > 40 ||
    (row.retryAfter !== null &&
      (typeof row.retryAfter !== "string" || !Number.isFinite(Date.parse(row.retryAfter))))
  )
    throw new Error("Nearby suggestions are invalid. Reload and try again.");
  const places = row.places.map((value) => {
    const place = object(value);
    if (
      !isNearbyPlaceId(place.placeId) ||
      !NEARBY_CATEGORIES.includes(place.category as NearbyCategory)
    )
      throw new Error("Nearby suggestion is invalid.");
    return { placeId: place.placeId, category: place.category as NearbyCategory };
  });
  if (
    new Set(places.map((place) => place.placeId)).size !== places.length ||
    (row.status !== "ready" && places.length > 0)
  )
    throw new Error("Nearby suggestions are invalid.");
  return {
    schemaVersion: 1,
    profileRevision: row.profileRevision,
    status: row.status as NearbyDiscoveryState["status"],
    places,
    retryAfter: row.retryAfter as string | null,
  };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function positiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) < Number.MAX_SAFE_INTEGER
  );
}
