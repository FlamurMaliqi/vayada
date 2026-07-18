"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { importGoogleMapsLibrary } from "./googleMaps";

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
  types: string[];
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

export default function GooglePlacesAddressField({
  addressRevision,
  apiKey,
  onUnavailable,
  onSelect,
}: {
  addressRevision: RefObject<number>;
  apiKey: string;
  onUnavailable: (autocompleteWasFocused: boolean) => void;
  onSelect: (address: GooglePlacesAddress, isExactAddress: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const latestSelection = useRef(0);
  const onUnavailableRef = useRef(onUnavailable);
  const onSelectRef = useRef(onSelect);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    onSelectRef.current = onSelect;
    onUnavailableRef.current = onUnavailable;
  }, [onSelect, onUnavailable]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let notifiedUnavailable = false;
    let autocomplete: GooglePlaceAutocompleteElement | null = null;
    const container = containerRef.current;

    void importGoogleMapsLibrary<GooglePlacesLibrary>(apiKey, "places")
      .then(({ PlaceAutocompleteElement }) => {
        if (disposed) return;

        autocomplete = new PlaceAutocompleteElement({
          description: "Property address",
          includedPrimaryTypes: ["street_address", "route"],
          placeholder: "Search for an address",
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
        const prediction = (event as GooglePlaceSelectEvent).placePrediction;
        const place = prediction.toPlace();
        await place.fetchFields({ fields: ["addressComponents", "location", "postalAddress"] });
        if (
          !disposed &&
          selection === latestSelection.current &&
          revision === addressRevision.current
        ) {
          const isExactAddress = prediction.types.includes("street_address");
          onSelectRef.current(addressFromGooglePlace(place, isExactAddress), isExactAddress);
        }
      } catch {
        if (selection === latestSelection.current && revision === addressRevision.current) {
          handleUnavailable();
        }
      }
    }

    function handleUnavailable() {
      if (disposed) return;
      const autocompleteWasFocused = Boolean(
        autocomplete &&
        (document.activeElement === autocomplete || autocomplete.contains(document.activeElement)),
      );
      latestSelection.current += 1;
      container.replaceChildren();
      setStatus("unavailable");
      if (!notifiedUnavailable) {
        notifiedUnavailable = true;
        onUnavailableRef.current(autocompleteWasFocused);
      }
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
      {status === "loading" && (
        <div
          className="h-12 animate-pulse rounded-xl border border-gray-200 bg-gray-50"
          aria-label="Loading Google address suggestions"
        />
      )}
      <div ref={containerRef} className={status === "ready" ? undefined : "hidden"} />
      <style>{`
        .vayada-google-place-autocomplete {
          display: block;
          width: 100%;
          box-sizing: border-box;
          color-scheme: light;
          border: 1px solid rgb(229 231 235);
          border-radius: 0.75rem;
          background: white;
          font: inherit;
        }
        .vayada-google-place-autocomplete::part(input) {
          width: 100%;
          box-sizing: border-box;
          min-height: 3rem;
          padding: 0.75rem 0.875rem;
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
  isExactAddress = true,
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
    latitude: isExactAddress ? (place.location?.lat() ?? null) : null,
    longitude: isExactAddress ? (place.location?.lng() ?? null) : null,
  };
}
