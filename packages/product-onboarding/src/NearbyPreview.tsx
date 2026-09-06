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
type Destination = Position & { id?: string; label?: string; title?: string };
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
      if (position && !disposed) {
        const lat = position.lat(),
          lng = position.lng();
        if (
          Number.isFinite(lat) &&
          Math.abs(lat) <= 90 &&
          Number.isFinite(lng) &&
          Math.abs(lng) <= 180
        )
          callbacks.current.onPosition?.({ lat, lng });
        else fail();
      }
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
        element.style.colorScheme = "light";
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
type MapItem = {
  setMap(map: MapInstance | null): void;
  addListener?(event: string, callback: () => void): { remove(): void };
};
type MapsLibrary = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapInstance;
  Circle: new (options: Record<string, unknown>) => MapItem;
};
type MarkerLibrary = { Marker: new (options: Record<string, unknown>) => MapItem };

export function NearbyMap({
  apiKey,
  location,
  destinations,
  selectedId,
  onSelect,
}: {
  apiKey: string;
  location: NonNullable<Preview["location"]>;
  destinations: Destination[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<MapInstance>();
  const markers = useRef<MapItem[]>([]);
  const [library, setLibrary] = useState<MarkerLibrary | null>(null);
  const [failed, setFailed] = useState(!apiKey);
  const select = useRef(onSelect);
  select.current = onSelect;
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
    const listeners: { remove(): void }[] = [];
    markers.current =
      library && map.current
        ? destinations.map((position, index) => {
            const marker = new library.Marker({
              map: map.current,
              position: { lat: position.lat, lng: position.lng },
              title: position.title ?? `Nearby place ${index + 1}`,
              label: position.label ?? String(index + 1),
              zIndex: selectedId === position.id ? 1000 : index,
              opacity: selectedId && selectedId !== position.id ? 0.5 : 1,
            });
            const listener = marker.addListener?.("click", () => {
              if (position.id) select.current?.(position.id);
            });
            if (listener) listeners.push(listener);
            return marker;
          })
        : [];
    return () => {
      listeners.forEach((listener) => listener.remove());
      markers.current.forEach((marker) => marker.setMap(null));
    };
  }, [destinations, library, selectedId]);
  return (
    <div>
      <div
        ref={target}
        role="region"
        aria-label="Map of our surroundings"
        className="h-72 w-full rounded-2xl bg-gray-100 md:h-[440px]"
      />
      {failed && (
        <p className="mt-2 text-sm text-gray-500">
          Map unavailable. Explore the places in the list below.
        </p>
      )}
    </div>
  );
}

export default function NearbyPreview({
  preview,
  apiKey,
  guest = false,
}: {
  preview: Preview;
  apiKey: string;
  guest?: boolean;
}) {
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>();
  const cards = useRef<Record<string, HTMLButtonElement | null>>({});
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
  const id = (place: NearbyPublicPlace) => (place.source === "custom" ? place.id : place.placeId);
  const destinations = displayed.flatMap((place, index) => {
    const position =
      place.source === "custom"
        ? { lat: place.latitude, lng: place.longitude }
        : positions[place.placeId];
    return position
      ? [
          {
            ...position,
            id: id(place),
            label: String(index + 1),
            title: place.source === "custom" ? place.name : `Nearby place ${index + 1}`,
          },
        ]
      : [];
  });
  return (
    <section
      aria-label={guest ? "Our surroundings" : "Guest preview"}
      className="space-y-8 rounded-[2rem] bg-white p-5 text-left shadow-[0_30px_90px_-50px_rgba(15,23,42,0.45)] sm:p-8"
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-gray-950">Around us</h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          {preview.location.mode === "approximate"
            ? "Discover places to eat, explore and enjoy around us."
            : "Explore our neighborhood and the places we recommend."}
        </p>
      </div>
      <div className="grid items-start gap-8 md:grid-cols-2 lg:gap-10">
        <div className="min-w-0 md:sticky md:top-24">
          <NearbyMap
            apiKey={apiKey}
            location={preview.location}
            destinations={destinations}
            selectedId={selected}
            onSelect={(key) => {
              setSelected(key);
              cards.current[key]?.focus({ preventScroll: true });
            }}
          />
          {preview.location.mode === "approximate" && (
            <p className="mt-3 text-xs leading-relaxed text-gray-500">
              Our approximate area is shown. The exact address stays private.
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-8">
          {!visible.length && (
            <p className="text-sm text-gray-600">Nearby places are unavailable right now.</p>
          )}
          {NEARBY_CATEGORIES.map((category) => {
            const places = displayed.filter((place) => place.category === category);
            if (
              !places.length &&
              candidates.filter((place) => place.category === category).length <= 5
            )
              return null;
            return (
              <section key={category} aria-label={nearbyCategoryLabels[category]}>
                <h3 className="mb-3 text-base font-semibold text-gray-900">
                  {nearbyCategoryLabels[category]}
                </h3>
                <ul className="space-y-3">
                  {places.map((place: NearbyPublicPlace) => (
                    <li
                      key={place.source === "google" ? place.placeId : place.id}
                      className={`scroll-mt-28 rounded-2xl border bg-white p-4 sm:p-5 ${selected === id(place) ? "border-gray-900 ring-1 ring-gray-900" : "border-gray-100"}`}
                    >
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <button
                          type="button"
                          ref={(node) => {
                            cards.current[id(place)] = node;
                          }}
                          aria-label={`${displayed.indexOf(place) + 1}. Highlight on map: ${place.source === "custom" ? place.name : "nearby place"}`}
                          aria-pressed={selected === id(place)}
                          onClick={() => setSelected(id(place))}
                          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-gray-50 px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                        >
                          <span
                            className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-900 text-xs text-white"
                            aria-hidden="true"
                          >
                            {displayed.indexOf(place) + 1}
                          </span>
                          Highlight on map
                        </button>
                        {place.favorite && (
                          <span className="text-xs font-medium text-gray-600">
                            Recommended by us
                          </span>
                        )}
                      </div>
                      {place.source === "google" ? (
                        <GoogleNearbyPlace
                          apiKey={apiKey}
                          placeId={place.placeId}
                          onPosition={(position) =>
                            setPositions((current) => ({ ...current, [place.placeId]: position }))
                          }
                          onUnavailable={() =>
                            setUnavailable((current) => [...current, place.placeId])
                          }
                        />
                      ) : (
                        <div>
                          <h4 className="font-medium text-gray-900">{place.name}</h4>
                          {place.address && (
                            <p className="mt-1 text-sm text-gray-500">{place.address}</p>
                          )}
                        </div>
                      )}
                      {(place.source === "custom" || positions[place.placeId]) && (
                        <a
                          className="mt-3 inline-flex min-h-11 items-center rounded-full border border-gray-200 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                          href={
                            place.source === "custom"
                              ? `https://www.google.com/maps/dir/?api=1&destination=${place.latitude},${place.longitude}`
                              : `https://www.google.com/maps/dir/?api=1&destination=${positions[place.placeId].lat},${positions[place.placeId].lng}&destination_place_id=${encodeURIComponent(place.placeId)}`
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          Directions
                        </a>
                      )}
                      {place.note && (
                        <p className="mt-3 border-l-2 border-gray-200 pl-3 text-sm leading-relaxed text-gray-600">
                          {place.note}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {!expanded.includes(category) &&
                  candidates.filter((place) => place.category === category).length > 5 && (
                    <button
                      type="button"
                      className="mt-3 min-h-11 rounded-full border border-gray-200 px-4 text-sm font-medium text-gray-900 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
                      onClick={() => setExpanded((current) => [...current, category])}
                    >
                      Show more {nearbyCategoryLabels[category].toLowerCase()}
                    </button>
                  )}
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
}
