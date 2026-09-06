"use client";
import { useRef } from "react";
import type { PropertyProfileLocation } from "@vayada/domain-hotels";
import GooglePlacesAddressField from "./GooglePlacesAddressField";
import GoogleAddressMap from "./GoogleAddressMap";

export const nearbyInputClass =
  "mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-950 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";
export default function NearbyLocationForm({
  value,
  onChange,
  apiKey,
  disabled,
}: {
  value: PropertyProfileLocation;
  onChange: (value: PropertyProfileLocation) => void;
  apiKey: string;
  disabled: boolean;
}) {
  const revision = useRef(0);
  function change(patch: Partial<PropertyProfileLocation>) {
    revision.current += 1;
    onChange({ ...value, ...patch });
  }
  return (
    <fieldset disabled={disabled} className="space-y-5">
      <legend className="mb-2 text-lg font-semibold text-gray-950">Location</legend>
      <p className="text-sm text-gray-500">
        Confirm your address and pin. We’ll suggest places nearby automatically.
      </p>
      {apiKey && (
        <GooglePlacesAddressField
          apiKey={apiKey}
          addressRevision={revision}
          onUnavailable={() => {}}
          onSelect={(address) => {
            if (disabled) return;
            change({
              streetAddress: address.streetAddress,
              postalCode: address.postalCode,
              city: address.city,
              countryCode: address.countryCode,
              latitude: address.latitude,
              longitude: address.longitude,
            });
          }}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ["streetAddress", "Street address"],
            ["city", "City"],
            ["postalCode", "Postal code"],
            ["countryCode", "Country code"],
            ["timezone", "Time zone"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="text-sm font-medium text-gray-700">
            {label}
            <input
              className={nearbyInputClass}
              value={value[key]}
              maxLength={key === "countryCode" ? 2 : 200}
              placeholder={key === "timezone" ? "Asia/Makassar" : undefined}
              onChange={(event) =>
                change({
                  [key]:
                    key === "countryCode" ? event.target.value.toUpperCase() : event.target.value,
                })
              }
            />
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        {(["latitude", "longitude"] as const).map((key) => (
          <label key={key} className="text-sm font-medium capitalize text-gray-700">
            {key}
            <input
              className={nearbyInputClass}
              type="number"
              step="any"
              min={key === "latitude" ? -90 : -180}
              max={key === "latitude" ? 90 : 180}
              value={value[key] ?? ""}
              onChange={(event) =>
                change({ [key]: event.target.value === "" ? null : Number(event.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-gray-500">
        You can enter coordinates manually when address search is unavailable.
      </p>
      {apiKey && value.latitude !== null && value.longitude !== null && (
        <div className="relative h-48 overflow-hidden rounded-xl">
          <GoogleAddressMap
            active
            apiKey={apiKey}
            latitude={value.latitude}
            longitude={value.longitude}
          />
        </div>
      )}
      <label className="block text-sm font-medium text-gray-700">
        Guest map visibility
        <select
          className={nearbyInputClass}
          value={value.geoPublic ? value.mapDisplayMode : "hidden"}
          onChange={(event) =>
            change({
              mapDisplayMode: event.target.value as PropertyProfileLocation["mapDisplayMode"],
              geoPublic: event.target.value !== "hidden",
            })
          }
        >
          <option value="hidden">Hidden</option>
          <option value="approximate">Approximate area</option>
          <option value="exact">Exact location</option>
        </select>
      </label>
      <p className="text-xs text-gray-500">
        Approximate shows your area without the exact pin. Hidden removes the map and nearby places.
      </p>
    </fieldset>
  );
}
