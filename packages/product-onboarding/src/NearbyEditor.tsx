"use client";
import { useState } from "react";
import { NEARBY_CATEGORIES, projectNearbyPreview, type NearbyChoice } from "@vayada/domain-hotels";
import type { NearbyApi } from "./nearbyApi";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";
import NearbyPreview, { GoogleNearbyPlace, nearbyCategoryLabels } from "./NearbyPreview";
import NearbyLocationForm, { nearbyInputClass } from "./NearbyLocationForm";
import NearbyCustomPlaceForm from "./NearbyCustomPlaceForm";
import { useNearbyEditor } from "./useNearbyEditor";
import { useNearbyNavigationGuard } from "./useNearbyNavigationGuard";
const button =
  "rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50";
const primary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

export default function NearbyEditor({
  propertyId,
  api,
  profileApi,
  apiKey,
}: {
  propertyId: string;
  api: NearbyApi;
  profileApi: SharedHotelSetupApi;
  apiKey: string;
}) {
  const editor = useNearbyEditor(propertyId, api, profileApi);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState(false);
  useNearbyNavigationGuard(editor.locationDirty || editor.placesDirty || adding);
  const { profile, location, draft, saved } = editor;
  const reload = () => {
    if (
      !(editor.locationDirty || editor.placesDirty || adding) ||
      window.confirm("Discard your edits and reload the latest version?")
    ) {
      setAdding(false);
      editor.reload();
    }
  };
  if (!profile || !location || !draft || !saved)
    return (
      <div className="p-6">
        {editor.error ? (
          <div role="alert">
            <p>{editor.error}</p>
            <button className={`${button} mt-3`} onClick={reload}>
              Reload latest
            </button>
          </div>
        ) : (
          <p role="status">Loading location…</p>
        )}
      </div>
    );
  const currentDiscovery =
    editor.discovery?.profileRevision === profile.profileRevision ? editor.discovery : null;
  const candidates = new Map(
    (currentDiscovery?.status === "ready" ? currentDiscovery.places : []).map((place) => [
      place.placeId,
      place.category,
    ]),
  );
  for (const choice of draft.choices) candidates.set(choice.placeId, choice.category);
  const reconfirm =
    saved.savedProfileRevision !== null && saved.savedProfileRevision !== profile.profileRevision;
  function changeChoice(
    placeId: string,
    category: NearbyChoice["category"],
    patch: Partial<NearbyChoice>,
  ) {
    editor.setDraft((current) => {
      if (!current) return current;
      const existing = current.choices.find((choice) => choice.placeId === placeId) ?? {
        placeId,
        category,
        hidden: false,
        favorite: false,
        added: false,
        note: null,
      };
      const choice = { ...existing, ...patch };
      if (patch.hidden) choice.favorite = false;
      if (patch.favorite) choice.hidden = false;
      return {
        ...current,
        choices: [...current.choices.filter((choice) => choice.placeId !== placeId), choice],
      };
    });
  }
  const projected = projectNearbyPreview(
    location,
    profile.profileRevision,
    editor.locationDirty
      ? { ...draft, savedProfileRevision: null }
      : editor.placesDirty
        ? { ...draft, savedProfileRevision: profile.profileRevision }
        : draft,
    editor.locationDirty ? null : currentDiscovery,
  );
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-950">Location & surroundings</h1>
          <p className="mt-1 text-sm text-gray-500">{profile.profile.displayName}</p>
        </div>
        <button
          className={button}
          type="button"
          disabled={adding || editor.busy}
          onClick={() => setPreview((value) => !value)}
        >
          {preview ? "Back to editing" : "Preview guest view"}
        </button>
      </div>
      {editor.error && (
        <div role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-800">
          <p>{editor.error}</p>
          <button type="button" className="mt-2 underline" onClick={reload}>
            Reload latest
          </button>
        </div>
      )}
      {editor.notice && (
        <p role="status" className="rounded-xl bg-green-50 p-4 text-sm text-green-800">
          {editor.notice}
        </p>
      )}
      {preview ? (
        <div className="mx-auto max-w-2xl">
          <p className="mb-4 text-xs text-gray-500">
            Preview of your settings. Unsaved changes are not published.
          </p>
          <NearbyPreview key={JSON.stringify(projected)} preview={projected} apiKey={apiKey} />
        </div>
      ) : (
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <form
            className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void editor.saveLocation();
            }}
          >
            <NearbyLocationForm
              apiKey={apiKey}
              value={location}
              onChange={editor.setLocation}
              disabled={editor.busy}
            />
            <button
              className={primary}
              disabled={editor.busy || !editor.locationDirty}
              type="submit"
            >
              {editor.busy ? "Saving…" : "Save location"}
            </button>
          </form>
          <section aria-label="Nearby places" className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-gray-950">Nearby places</h2>
              <p className="mt-1 text-sm text-gray-500">
                Suggestions appear automatically. Choose favorites to show as “Recommended by us”.
              </p>
            </div>
            {editor.providerMessage && (
              <p role="status" className="rounded-xl bg-gray-100 p-4 text-sm text-gray-600">
                {editor.providerMessage}
              </p>
            )}
            {editor.locationDirty && (
              <p role="status" className="text-sm text-amber-800">
                Save your location before editing nearby places.
              </p>
            )}
            {reconfirm && (
              <p role="status" className="text-sm text-amber-800">
                Your location changed. Review these places, then save to recommend them again.
              </p>
            )}
            <fieldset disabled={editor.busy || editor.locationDirty} className="space-y-5">
              <div className="flex flex-wrap gap-3">
                <button
                  className={button}
                  type="button"
                  disabled={editor.refreshing}
                  onClick={() => void editor.refresh()}
                >
                  {editor.refreshing ? "Refreshing…" : "Refresh suggestions"}
                </button>
                <button
                  className={button}
                  type="button"
                  disabled={
                    draft.customPlaces.length +
                      draft.choices.filter((choice) => choice.added).length >=
                    20
                  }
                  onClick={() => setAdding(true)}
                >
                  Add your own place
                </button>
              </div>
              {NEARBY_CATEGORIES.map((category) => {
                const places = Array.from(candidates).filter(([, value]) => value === category);
                const custom = draft.customPlaces.filter((place) => place.category === category);
                if (!places.length && !custom.length) return null;
                return (
                  <section
                    key={category}
                    aria-label={nearbyCategoryLabels[category]}
                    className="space-y-3"
                  >
                    <h3 className="font-medium text-gray-900">{nearbyCategoryLabels[category]}</h3>
                    {places.map(([placeId]) => {
                      const choice = draft.choices.find((choice) => choice.placeId === placeId);
                      return (
                        <div
                          key={placeId}
                          className="space-y-3 rounded-xl border border-gray-200 bg-white p-4"
                        >
                          <GoogleNearbyPlace apiKey={apiKey} placeId={placeId} />
                          <div className="flex flex-wrap gap-4 text-sm">
                            <label>
                              <input
                                type="checkbox"
                                checked={Boolean(choice?.favorite)}
                                onChange={(event) =>
                                  changeChoice(placeId, category, {
                                    favorite: event.target.checked,
                                  })
                                }
                              />{" "}
                              Favorite
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={Boolean(choice?.hidden)}
                                onChange={(event) =>
                                  changeChoice(placeId, category, { hidden: event.target.checked })
                                }
                              />{" "}
                              Hide from guests
                            </label>
                            <button
                              type="button"
                              className="text-gray-500 underline"
                              onClick={() =>
                                editor.setDraft(
                                  (current) =>
                                    current && {
                                      ...current,
                                      choices: current.choices.filter(
                                        (choice) => choice.placeId !== placeId,
                                      ),
                                    },
                                )
                              }
                            >
                              Reset
                            </button>
                          </div>
                          <label className="block text-sm text-gray-600">
                            Your note
                            <textarea
                              className={nearbyInputClass}
                              rows={2}
                              maxLength={500}
                              value={choice?.note ?? ""}
                              onChange={(event) =>
                                changeChoice(placeId, category, {
                                  note: event.target.value || null,
                                })
                              }
                            />
                          </label>
                        </div>
                      );
                    })}
                    {custom.map((place) => (
                      <div
                        key={place.id}
                        className="rounded-xl border border-gray-200 bg-white p-4"
                      >
                        <h4 className="font-medium text-gray-950">{place.name}</h4>
                        <p className="mt-1 text-xs text-gray-500">Added by you</p>
                        <div className="mt-3 flex flex-wrap gap-4 text-sm">
                          {(["favorite", "hidden"] as const).map((flag) => (
                            <label key={flag}>
                              <input
                                type="checkbox"
                                checked={place[flag]}
                                onChange={(event) =>
                                  editor.setDraft(
                                    (current) =>
                                      current && {
                                        ...current,
                                        customPlaces: current.customPlaces.map((item) =>
                                          item.id === place.id
                                            ? {
                                                ...item,
                                                [flag]: event.target.checked,
                                                ...(event.target.checked
                                                  ? {
                                                      [flag === "favorite" ? "hidden" : "favorite"]:
                                                        false,
                                                    }
                                                  : {}),
                                              }
                                            : item,
                                        ),
                                      },
                                  )
                                }
                              />{" "}
                              {flag === "favorite" ? "Favorite" : "Hide from guests"}
                            </label>
                          ))}
                          <button
                            type="button"
                            className="text-red-700 underline"
                            onClick={() =>
                              editor.setDraft(
                                (current) =>
                                  current && {
                                    ...current,
                                    customPlaces: current.customPlaces.filter(
                                      (item) => item.id !== place.id,
                                    ),
                                  },
                              )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </section>
                );
              })}
            </fieldset>
            {adding && (
              <NearbyCustomPlaceForm
                onError={editor.setError}
                onCancel={() => setAdding(false)}
                onAdd={(place) => {
                  editor.setDraft(
                    (current) =>
                      current && { ...current, customPlaces: [...current.customPlaces, place] },
                  );
                  setAdding(false);
                }}
              />
            )}
            <div className="flex gap-3">
              <button
                className={primary}
                type="button"
                disabled={
                  editor.busy ||
                  editor.locationDirty ||
                  adding ||
                  (!editor.placesDirty && !reconfirm)
                }
                onClick={() => void editor.savePlaces()}
              >
                Save places
              </button>
              <button
                className={button}
                type="button"
                disabled={editor.busy || (!editor.placesDirty && !editor.locationDirty && !adding)}
                onClick={() => {
                  editor.discard();
                  setAdding(false);
                }}
              >
                Discard changes
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
