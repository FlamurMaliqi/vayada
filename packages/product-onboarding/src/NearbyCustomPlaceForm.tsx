"use client";
import type { FormEvent } from "react";
import {
  NEARBY_CATEGORIES,
  parseNearbyCurationWrite,
  type NearbyCustomPlace,
} from "@vayada/domain-hotels";
import { nearbyCategoryLabels } from "./NearbyPreview";
import { nearbyInputClass } from "./NearbyLocationForm";
export default function NearbyCustomPlaceForm({
  onAdd,
  onCancel,
  onError,
}: {
  onAdd: (place: NearbyCustomPlace) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const place = {
      id: crypto.randomUUID(),
      name: String(data.get("name")),
      address: String(data.get("address")) || null,
      category: data.get("category"),
      latitude: Number(data.get("latitude")),
      longitude: Number(data.get("longitude")),
      favorite: false,
      hidden: false,
      note: String(data.get("note")) || null,
    };
    const parsed = parseNearbyCurationWrite({
      schemaVersion: 1,
      expectedProfileRevision: 1,
      expectedCurationRevision: 0,
      choices: [],
      customPlaces: [place],
    });
    if (!parsed.ok)
      return onError("Check the place name, coordinates and note. Use plain text only.");
    onAdd(parsed.value.customPlaces[0]);
  }
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-xl border border-blue-200 bg-blue-50/30 p-5"
      aria-label="Add a custom place"
    >
      <h3 className="font-semibold text-gray-950">Add your own place</h3>
      <p className="text-sm text-gray-600">
        Use details you know. The address, coordinates and note will be public when your map is
        visible.
      </p>
      <label className="block text-sm font-medium text-gray-700">
        Place name
        <input name="name" required maxLength={120} className={nearbyInputClass} autoFocus />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        Address
        <input name="address" maxLength={300} className={nearbyInputClass} />
      </label>
      <label className="block text-sm font-medium text-gray-700">
        Category
        <select name="category" className={nearbyInputClass}>
          {NEARBY_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {nearbyCategoryLabels[category]}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-4">
        {(["latitude", "longitude"] as const).map((name) => (
          <label key={name} className="text-sm font-medium capitalize text-gray-700">
            {name}
            <input
              required
              name={name}
              type="number"
              step="any"
              min={name === "latitude" ? -90 : -180}
              max={name === "latitude" ? 90 : 180}
              className={nearbyInputClass}
            />
          </label>
        ))}
      </div>
      <label className="block text-sm font-medium text-gray-700">
        Your note
        <textarea name="note" maxLength={500} rows={2} className={nearbyInputClass} />
      </label>
      <div className="flex gap-3">
        <button
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
          type="submit"
        >
          Add place
        </button>
        <button
          className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700"
          type="button"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
