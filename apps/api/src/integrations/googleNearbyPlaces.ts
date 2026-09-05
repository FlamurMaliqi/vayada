import {
  isNearbyPlaceId,
  type NearbyCategory,
  type PropertyProfileLocation,
} from "@vayada/domain-hotels";

export type NearbyOrigin = { latitude: number; longitude: number };
export type NearbyCandidate = NearbyOrigin & { placeId: string; category: NearbyCategory };
export type NearbyDiscoveryFailure =
  | "not_configured"
  | "location_required"
  | "quota_exhausted"
  | "timeout"
  | "provider_unavailable"
  | "invalid_response";
export type NearbyDiscoveryResult =
  | { status: "ready" | "empty"; places: NearbyCandidate[] }
  | { status: NearbyDiscoveryFailure; places: [] };
export const NEARBY_POLICY_VERSION = "nearby-v1";
// Match the public PostgreSQL numeric round(..., 2), including negative ties.
const PUBLIC_COORDINATE_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: false,
});
export const NEARBY_SEARCH_POLICY = [
  { category: "nature", types: ["beach", "park", "national_park", "hiking_area"], radius: 5000 },
  { category: "food", types: ["restaurant", "cafe", "bar", "bakery"], radius: 2000 },
  { category: "activities", types: ["tourist_attraction", "museum", "art_gallery"], radius: 5000 },
  {
    category: "transport",
    types: ["airport", "train_station", "bus_station", "ferry_terminal"],
    radius: 20000,
  },
] as const satisfies readonly {
  category: NearbyCategory;
  types: readonly string[];
  radius: number;
}[];
const LODGING_TYPES = [
  "bed_and_breakfast",
  "budget_japanese_inn",
  "campground",
  "camping_cabin",
  "cottage",
  "extended_stay_hotel",
  "farmstay",
  "guest_house",
  "hostel",
  "hotel",
  "inn",
  "japanese_inn",
  "lodging",
  "mobile_home_park",
  "motel",
  "private_guest_room",
  "resort_hotel",
  "rv_park",
];

/** Public discovery must never depend on a private exact pin. */
export function nearbySearchOrigin(location: PropertyProfileLocation): NearbyOrigin | null {
  if (
    !location.geoPublic ||
    location.mapDisplayMode === "hidden" ||
    !coordinate(location.latitude, 90) ||
    !coordinate(location.longitude, 180)
  )
    return null;
  if (location.mapDisplayMode === "approximate")
    return {
      latitude: Number(PUBLIC_COORDINATE_FORMAT.format(location.latitude)),
      longitude: Number(PUBLIC_COORDINATE_FORMAT.format(location.longitude)),
    };
  if (location.mapDisplayMode !== "exact") return null;
  return { latitude: location.latitude, longitude: location.longitude };
}

/** Fixed endpoint, four bounded calls, no retries, provider text never escapes this boundary. */
export async function discoverGoogleNearby(input: {
  origin: NearbyOrigin | null;
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
}): Promise<NearbyDiscoveryResult> {
  if (
    !input.origin ||
    !coordinate(input.origin.latitude, 90) ||
    !coordinate(input.origin.longitude, 180)
  ) {
    return { status: "location_required", places: [] };
  }
  if (!input.apiKey?.trim()) return { status: "not_configured", places: [] };
  const fetcher = input.fetch ?? globalThis.fetch;
  const origin = { latitude: input.origin.latitude, longitude: input.origin.longitude };
  const results = await Promise.all(
    NEARBY_SEARCH_POLICY.map(async (policy) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetcher("https://places.googleapis.com/v1/places:searchNearby", {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": input.apiKey!,
            "X-Goog-FieldMask": "places.id,places.location,places.types",
          },
          body: JSON.stringify({
            includedTypes: policy.types,
            excludedTypes: LODGING_TYPES,
            maxResultCount: 10,
            rankPreference: "DISTANCE",
            locationRestriction: { circle: { center: origin, radius: policy.radius } },
          }),
        });
        if (!response.ok)
          return {
            status: response.status === 429 ? "quota_exhausted" : "provider_unavailable",
            places: [],
          } as NearbyDiscoveryResult;
        const body: unknown = await response.json();
        if (!record(body) || (body.places !== undefined && !Array.isArray(body.places))) {
          return { status: "invalid_response", places: [] } as NearbyDiscoveryResult;
        }
        const places: NearbyCandidate[] = [];
        for (const place of ((body.places ?? []) as unknown[]).slice(0, 10)) {
          if (
            !record(place) ||
            !isNearbyPlaceId(place.id) ||
            !record(place.location) ||
            !coordinate(place.location.latitude, 90) ||
            !coordinate(place.location.longitude, 180) ||
            !Array.isArray(place.types) ||
            !place.types.every((type) => typeof type === "string")
          )
            continue;
          if (
            place.types.some((type) => LODGING_TYPES.includes(type)) ||
            !place.types.some((type) => (policy.types as readonly string[]).includes(type))
          )
            continue;
          places.push({
            placeId: place.id,
            category: policy.category,
            latitude: place.location.latitude,
            longitude: place.location.longitude,
          });
        }
        return { status: places.length ? "ready" : "empty", places } as NearbyDiscoveryResult;
      } catch {
        return {
          status: controller.signal.aborted ? "timeout" : "provider_unavailable",
          places: [],
        } as NearbyDiscoveryResult;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const failure = results.find((result) => result.status !== "ready" && result.status !== "empty");
  if (failure) return failure;
  const seen = new Set<string>();
  const places = results
    .flatMap((result) => result.places)
    .filter(({ placeId }) => {
      if (seen.has(placeId)) return false;
      seen.add(placeId);
      return true;
    });
  return { status: places.length ? "ready" : "empty", places };
}
function coordinate(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
