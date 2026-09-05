"use client";
import { useEffect, useRef, useState } from "react";
import {
  NEARBY_CATEGORIES,
  type NearbyPreview as Preview,
  type NearbyPublicPlace,
} from "@vayada/domain-hotels";
import { importGoogleMapsLibrary } from "./googleMaps";

export const nearbyCategoryLabels = {
  nature: "Beaches & nature",
  food: "Food & drink",
  activities: "Things to do",
  transport: "Transport",
};
type Position = { lat: number; lng: number };
type PlaceElement = HTMLElement & { place?: { location?: { lat(): number; lng(): number } } };

/** Google renders its own content/attribution; only ephemeral coordinates leave the widget. */
export function GoogleNearbyPlace({
  apiKey,
  placeId,
  onPosition,
  onUnavailable,
}: {
  apiKey: string;
  placeId: string;
  onPosition?: (position: Position) => void;
  onUnavailable?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPosition, onUnavailable });
  callbacks.current = { onPosition, onUnavailable };
  const [failed, setFailed] = useState(!apiKey);
  useEffect(() => {
    let disposed = false;
    let settled = false;
    let element: PlaceElement | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const target = container.current;
    const fail = () => {
      if (!disposed && !settled) {
        settled = true;
        clearTimeout(timer);
        setFailed(true);
        callbacks.current.onUnavailable?.();
        target?.replaceChildren();
      }
    };
    const load = () => {
      if (disposed || settled) return;
      clearTimeout(timer);
      const position = element?.place?.location;
      if (position && !disposed)
        callbacks.current.onPosition?.({ lat: position.lat(), lng: position.lng() });
    };
    setFailed(!apiKey);
    if (!apiKey) {
      fail();
      return;
    }
    timer = setTimeout(fail, 8000);
    void importGoogleMapsLibrary(apiKey, "places")
      .then(() => {
        if (disposed || settled || !target) return;
        element = document.createElement("gmp-place-details-compact") as PlaceElement;
        element.setAttribute("orientation", "horizontal");
        element.style.width = "100%";
        const request = document.createElement("gmp-place-details-place-request");
        request.setAttribute("place", placeId);
        const config = document.createElement("gmp-place-content-config");
        config.append(
          document.createElement("gmp-place-address"),
          document.createElement("gmp-place-rating"),
        );
        element.append(request, config);
        element.addEventListener("gmp-load", load);
        element.addEventListener("gmp-error", fail);
        target.replaceChildren(element);
      })
      .catch(fail);
    return () => {
      disposed = true;
      clearTimeout(timer);
      element?.removeEventListener("gmp-load", load);
      element?.removeEventListener("gmp-error", fail);
      target?.replaceChildren();
    };
  }, [apiKey, placeId]);
  return (
    <div>
      {failed && (
        <p className="text-sm text-gray-500">
          Place details unavailable. You can still remove this saved place.
        </p>
      )}
      <div ref={container} />
    </div>
  );
}

type MapInstance = { setCenter(position: Position): void; setZoom(zoom: number): void };
type MapItem = { setMap(map: MapInstance | null): void };
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapInstance;
  Circle: new (options: Record<string, unknown>) => MapItem;
};
type MarkerLibrary = { Marker: new (options: Record<string, unknown>) => MapItem };

export function NearbyMap({
  apiKey,
  location,
  destinations,
}: {
  apiKey: string;
  location: NonNullable<Preview["location"]>;
  destinations: Position[];
}) {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<MapInstance>();
  const markers = useRef<MapItem[]>([]);
  const [library, setLibrary] = useState<MarkerLibrary | null>(null);
  const [failed, setFailed] = useState(!apiKey);
  useEffect(() => {
    let disposed = false;
    let hotel: MapItem | undefined;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (!disposed) setFailed(true);
    }, 8000);
    setFailed(!apiKey);
    if (!apiKey) {
      clearTimeout(timer);
      return;
    }
    void Promise.all([
      importGoogleMapsLibrary<MapsLibrary>(apiKey, "maps"),
      importGoogleMapsLibrary<MarkerLibrary>(apiKey, "marker"),
    ])
      .then(([maps, marker]) => {
        if (disposed || expired || !target.current) return;
        clearTimeout(timer);
        const center = { lat: location.latitude, lng: location.longitude };
        map.current = new maps.Map(target.current, {
          center,
          zoom: location.mode === "approximate" ? 14 : 15,
          clickableIcons: false,
          streetViewControl: false,
          mapTypeControl: false,
          gestureHandling: "cooperative",
        });
        hotel =
          location.mode === "approximate"
            ? new maps.Circle({
                map: map.current,
                center,
                radius: 1000,
                fillColor: "#2563eb",
                fillOpacity: 0.12,
                strokeColor: "#2563eb",
                strokeWeight: 1,
              })
            : new marker.Marker({ map: map.current, position: center, title: "Our location" });
        setLibrary(marker);
      })
      .catch(() => {
        clearTimeout(timer);
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
      hotel?.setMap(null);
      markers.current.forEach((marker) => marker.setMap(null));
      map.current = undefined;
      setLibrary(null);
    };
  }, [apiKey, location.latitude, location.longitude, location.mode]);
  useEffect(() => {
    markers.current.forEach((marker) => marker.setMap(null));
    markers.current =
      library && map.current
        ? destinations.map(
            (position, index) =>
              new library.Marker({
                map: map.current,
                position,
                title: `Nearby place ${index + 1}`,
                label: String(index + 1),
              }),
          )
        : [];
    return () => markers.current.forEach((marker) => marker.setMap(null));
  }, [destinations, library]);
  return (
    <div>
      <div
        ref={target}
        role="region"
        aria-label="Map of our surroundings"
        className="h-72 w-full rounded-xl bg-gray-100"
      />
      {failed && (
        <p className="mt-2 text-sm text-gray-500">
          Map unavailable. Explore the places in the list below.
        </p>
      )}
    </div>
  );
}

export default function NearbyPreview({ preview, apiKey }: { preview: Preview; apiKey: string }) {
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!preview.location)
    return (
      <p className="rounded-xl bg-gray-50 p-5 text-gray-600">
        The map and nearby places are hidden from guests.
      </p>
    );
  const candidates = preview.places.filter((place) => place.source === "custom" || Boolean(apiKey));
  const windowed = candidates.filter(
    (place) =>
      expanded.includes(place.category) ||
      candidates.filter((other) => other.category === place.category).indexOf(place) < 5,
  );
  const visible = candidates.filter(
    (place) => place.source === "custom" || !unavailable.includes(place.placeId),
  );
  const displayed = windowed.filter(
    (place) => place.source === "custom" || !unavailable.includes(place.placeId),
  );
  const destinations = displayed.flatMap((place) =>
    place.source === "custom"
      ? [{ lat: place.latitude, lng: place.longitude }]
      : positions[place.placeId]
        ? [positions[place.placeId]]
        : [],
  );
  return (
    <section aria-label="Guest preview" className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-950">Around us</h2>
        <p className="mt-1 text-sm text-gray-500">
          {preview.location.mode === "approximate"
            ? "Our approximate area is shown. The exact address stays private."
            : "Explore our neighborhood and the places we recommend."}
        </p>
      </div>
      <NearbyMap apiKey={apiKey} location={preview.location} destinations={destinations} />
      {!visible.length && (
        <p className="text-sm text-gray-600">Nearby places are unavailable right now.</p>
      )}
      {NEARBY_CATEGORIES.map((category) => {
        const places = displayed.filter((place) => place.category === category);
        if (!places.length && candidates.filter((place) => place.category === category).length <= 5)
          return null;
        return (
          <section key={category} aria-label={nearbyCategoryLabels[category]}>
            <h3 className="mb-3 font-semibold text-gray-900">{nearbyCategoryLabels[category]}</h3>
            <ul className="space-y-4">
              {places.map((place: NearbyPublicPlace) => (
                <li
                  key={place.source === "google" ? place.placeId : place.id}
                  className="rounded-xl border border-gray-200 bg-white p-4"
                >
                  <p className="mb-2 text-xs font-semibold text-blue-700">
                    {place.favorite ? "Recommended by us" : "Nearby"}
                  </p>
                  {place.source === "google" ? (
                    <GoogleNearbyPlace
                      apiKey={apiKey}
                      placeId={place.placeId}
                      onPosition={(position) =>
                        setPositions((current) => ({ ...current, [place.placeId]: position }))
                      }
                      onUnavailable={() => setUnavailable((current) => [...current, place.placeId])}
                    />
                  ) : (
                    <div>
                      <h4 className="font-medium text-gray-900">{place.name}</h4>
                      {place.address && (
                        <p className="mt-1 text-sm text-gray-500">{place.address}</p>
                      )}
                      <a
                        className="mt-2 inline-block text-sm text-blue-700 underline"
                        href={`https://www.google.com/maps/dir/?api=1&destination=${place.latitude},${place.longitude}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Directions
                      </a>
                    </div>
                  )}
                  {place.note && <p className="mt-3 text-sm text-gray-600">{place.note}</p>}
                </li>
              ))}
            </ul>
            {!expanded.includes(category) &&
              candidates.filter((place) => place.category === category).length > 5 && (
                <button
                  type="button"
                  className="mt-3 text-sm font-medium text-blue-700"
                  onClick={() => setExpanded((current) => [...current, category])}
                >
                  Show more {nearbyCategoryLabels[category].toLowerCase()}
                </button>
              )}
          </section>
        );
      })}
    </section>
  );
}
