"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

export type GooglePlacesAddress = {
  streetAddress: string;
  postalCode: string;
  city: string;
  countryCode: string;
  region: string;
  latitude: number | null;
  longitude: number | null;
};

type GoogleAddressComponent = {
  longText: string;
  shortText: string;
  types: string[];
};

type GooglePostalAddress = {
  addressLines: string[];
  administrativeArea?: string;
  locality?: string;
  postalCode?: string;
  regionCode: string;
};

type GooglePlace = {
  addressComponents?: GoogleAddressComponent[];
  location?: { lat: () => number; lng: () => number };
  postalAddress?: GooglePostalAddress;
  fetchFields: (input: { fields: string[] }) => Promise<void>;
};

type GooglePlacePrediction = {
  toPlace: () => GooglePlace;
};

type GooglePlaceSelectEvent = Event & {
  placePrediction: GooglePlacePrediction;
};

type GooglePlaceAutocompleteElement = HTMLElement;
type GooglePlacesLibrary = {
  PlaceAutocompleteElement: new (options: {
    description: string;
    includedPrimaryTypes: string[];
    placeholder: string;
  }) => GooglePlaceAutocompleteElement;
};

type GoogleMapsWindow = Window & {
  google?: {
    maps?: {
      importLibrary?: (library: string) => Promise<unknown>;
    };
  };
  __vayadaGoogleMapsReady?: () => void;
};

let googlePlacesLibraryPromise: Promise<GooglePlacesLibrary> | null = null;

export default function GooglePlacesAddressField({
  addressRevision,
  apiKey,
  onSelect,
}: {
  addressRevision: RefObject<number>;
  apiKey: string;
  onSelect: (address: GooglePlacesAddress) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const latestSelection = useRef(0);
  const onSelectRef = useRef(onSelect);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let autocomplete: GooglePlaceAutocompleteElement | null = null;
    const container = containerRef.current;

    void loadGooglePlaces(apiKey)
      .then(({ PlaceAutocompleteElement }) => {
        if (disposed) return;

        autocomplete = new PlaceAutocompleteElement({
          description: "Search for your hotel address",
          includedPrimaryTypes: ["street_address"],
          placeholder: "Start typing a street address",
        });
        autocomplete.className = "vayada-google-place-autocomplete";

        autocomplete.addEventListener("gmp-select", handleSelect);
        autocomplete.addEventListener("gmp-error", handleUnavailable);
        container.replaceChildren(autocomplete);
        setStatus("ready");
      })
      .catch(handleUnavailable);

    async function handleSelect(event: Event) {
      const selection = ++latestSelection.current;
      const revision = addressRevision.current;

      try {
        const place = (event as GooglePlaceSelectEvent).placePrediction.toPlace();
        await place.fetchFields({ fields: ["addressComponents", "location", "postalAddress"] });
        if (
          !disposed &&
          selection === latestSelection.current &&
          revision === addressRevision.current
        ) {
          onSelectRef.current(addressFromGooglePlace(place));
        }
      } catch {
        if (selection === latestSelection.current && revision === addressRevision.current) {
          handleUnavailable();
        }
      }
    }

    function handleUnavailable() {
      if (disposed) return;
      latestSelection.current += 1;
      container.replaceChildren();
      setStatus("unavailable");
    }

    return () => {
      disposed = true;
      latestSelection.current += 1;
      autocomplete?.removeEventListener("gmp-select", handleSelect);
      autocomplete?.removeEventListener("gmp-error", handleUnavailable);
      container.replaceChildren();
    };
  }, [addressRevision, apiKey]);

  return (
    <div>
      <p className="text-sm font-medium text-gray-700">Search for your hotel address</p>
      <p className="mt-1 text-xs text-gray-500">
        Choose a Google suggestion to fill the address fields below.
      </p>
      {status === "loading" && (
        <div
          className="mt-2 h-[2.625rem] animate-pulse rounded-xl border border-gray-200 bg-gray-50"
          aria-label="Loading Google address suggestions"
        />
      )}
      {status === "unavailable" && (
        <p className="mt-2 rounded-xl bg-gray-50 px-3 py-2.5 text-sm text-gray-600" role="status">
          Google suggestions are unavailable. Enter the address manually below.
        </p>
      )}
      <div ref={containerRef} className={status === "ready" ? "mt-2" : "hidden"} />
      <style>{`
        .vayada-google-place-autocomplete {
          width: 100%;
          color-scheme: light;
          border: 1px solid rgb(229 231 235);
          border-radius: 0.75rem;
          background: white;
          font: inherit;
        }
        .vayada-google-place-autocomplete::part(input) {
          min-height: 2.5rem;
          padding: 0.625rem 1rem;
          font-size: 0.875rem;
        }
        .vayada-google-place-autocomplete:focus-within {
          border-color: rgb(47 82 245);
          box-shadow: 0 0 0 2px rgb(223 229 255);
        }
        .vayada-google-place-autocomplete::part(prediction-list) {
          border-radius: 0.75rem;
        }
      `}</style>
    </div>
  );
}

export function addressFromGooglePlace(
  place: Pick<GooglePlace, "addressComponents" | "location" | "postalAddress">,
): GooglePlacesAddress {
  const components = place.addressComponents ?? [];
  const postalAddress = place.postalAddress;
  const longText = (type: string) =>
    components.find((component) => component.types.includes(type))?.longText ?? "";
  const shortText = (type: string) =>
    components.find((component) => component.types.includes(type))?.shortText ?? "";
  const route = longText("route");
  const streetNumber = longText("street_number");
  const postalCode = longText("postal_code");
  const postalCodeSuffix = longText("postal_code_suffix");

  return {
    streetAddress:
      postalAddress?.addressLines.filter(Boolean).join(", ") ||
      [route, streetNumber].filter(Boolean).join(" "),
    postalCode:
      postalAddress?.postalCode ||
      (postalCodeSuffix ? `${postalCode}-${postalCodeSuffix}` : postalCode),
    city:
      postalAddress?.locality ||
      longText("locality") ||
      longText("postal_town") ||
      longText("sublocality_level_1") ||
      longText("administrative_area_level_2"),
    countryCode: (postalAddress?.regionCode || shortText("country")).toUpperCase(),
    region: postalAddress?.administrativeArea || longText("administrative_area_level_1"),
    latitude: place.location?.lat() ?? null,
    longitude: place.location?.lng() ?? null,
  };
}

function loadGooglePlaces(apiKey: string): Promise<GooglePlacesLibrary> {
  const googleWindow = window as GoogleMapsWindow;
  const importLibrary = googleWindow.google?.maps?.importLibrary;
  if (importLibrary) return importLibrary("places") as Promise<GooglePlacesLibrary>;
  if (googlePlacesLibraryPromise) return googlePlacesLibraryPromise;

  googlePlacesLibraryPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const url = new URL("https://maps.googleapis.com/maps/api/js");
    url.search = new URLSearchParams({
      key: apiKey,
      v: "weekly",
      loading: "async",
      libraries: "places",
      auth_referrer_policy: "origin",
      callback: "__vayadaGoogleMapsReady",
    }).toString();

    googleWindow.__vayadaGoogleMapsReady = () => {
      delete googleWindow.__vayadaGoogleMapsReady;
      resolve();
    };
    script.src = url.toString();
    script.async = true;
    script.dataset.vayadaGoogleMaps = "true";
    script.onerror = () => {
      delete googleWindow.__vayadaGoogleMapsReady;
      script.remove();
      reject(new Error("Google Maps could not load."));
    };
    document.head.appendChild(script);
  })
    .then(async () => {
      const loadedImportLibrary = googleWindow.google?.maps?.importLibrary;
      if (!loadedImportLibrary) throw new Error("Google Places is unavailable.");
      return loadedImportLibrary("places") as Promise<GooglePlacesLibrary>;
    })
    .catch((error) => {
      googlePlacesLibraryPromise = null;
      throw error;
    });

  return googlePlacesLibraryPromise;
}
