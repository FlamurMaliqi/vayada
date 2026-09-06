"use client";
import { useEffect, useRef, useState } from "react";
import {
  type NearbyCurationState,
  type NearbyDiscoveryState,
  type PropertyProfileLocation,
  type PropertyProfileResponse,
} from "@vayada/domain-hotels";
import type { NearbyApi } from "./nearbyApi";
import type { SharedHotelSetupApi } from "./sharedHotelSetupApi";

export function useNearbyEditor(
  propertyId: string,
  api: NearbyApi,
  profileApi: SharedHotelSetupApi,
) {
  const [profile, setProfile] = useState<PropertyProfileResponse | null>(null);
  const [location, setLocation] = useState<PropertyProfileLocation | null>(null);
  const [saved, setSaved] = useState<NearbyCurationState | null>(null);
  const [draft, setDraft] = useState<NearbyCurationState | null>(null);
  const [discovery, setDiscovery] = useState<NearbyDiscoveryState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [providerMessage, setProviderMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshGeneration = useRef(0);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false;
    const generation = ++refreshGeneration.current;
    setProfile(null);
    setSaved(null);
    setDraft(null);
    setLocation(null);
    setDiscovery(null);
    setError("");
    void Promise.all([profileApi.getPropertyProfile(propertyId), api.read(propertyId)])
      .then(async ([profile, curation]) => {
        if (disposed) return;
        if (
          profile.propertyId !== propertyId ||
          profile.profileRevision !== curation.profileRevision
        )
          throw new Error("Location changed while loading. Reload and try again.");
        setProfile(profile);
        setLocation(profile.profile.location);
        setSaved(curation);
        setDraft(curation);
        try {
          const result = await api.refresh(propertyId, profile.profileRevision);
          if (!disposed && generation === refreshGeneration.current) {
            setDiscovery(result);
            setProviderMessage(discoveryMessage(result));
          }
        } catch {
          if (!disposed && generation === refreshGeneration.current)
            setProviderMessage(
              "Automatic suggestions are unavailable. Retry later or add your own place.",
            );
        }
      })
      .catch((error) => {
        if (!disposed)
          setError(error instanceof Error ? error.message : "Location could not load.");
      });
    return () => {
      disposed = true;
      refreshGeneration.current += 1;
    };
  }, [propertyId, api, profileApi, reload]);
  const locationDirty = Boolean(
    profile && location && JSON.stringify(profile.profile.location) !== JSON.stringify(location),
  );
  const placesDirty = Boolean(
    saved &&
    draft &&
    (JSON.stringify(saved.choices) !== JSON.stringify(draft.choices) ||
      JSON.stringify(saved.customPlaces) !== JSON.stringify(draft.customPlaces)),
  );
  async function refresh(revision = profile?.profileRevision, force = true) {
    if (!revision) return;
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    setProviderMessage("");
    try {
      const result = await api.refresh(propertyId, revision, force);
      if (generation !== refreshGeneration.current) return;
      setDiscovery(result);
      setProviderMessage(discoveryMessage(result));
    } catch {
      if (generation !== refreshGeneration.current) return;
      setProviderMessage(
        "Suggestions could not refresh yet. Please retry later. Your saved places are safe.",
      );
    } finally {
      if (generation === refreshGeneration.current) setRefreshing(false);
    }
  }
  async function saveLocation() {
    if (!profile || !location) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await profileApi.updatePropertyProfile(propertyId, {
        expectedProfileRevision: profile.profileRevision,
        patch: { location },
      });
      setProfile(next);
      setLocation(next.profile.location);
      setDiscovery(null);
      setSaved((current) => current && { ...current, profileRevision: next.profileRevision });
      setDraft((current) => current && { ...current, profileRevision: next.profileRevision });
      setNotice("Location saved. Review your saved places for this location.");
      await refresh(next.profileRevision, false);
    } catch (error) {
      setError(saveError(error));
    } finally {
      setBusy(false);
    }
  }
  async function savePlaces() {
    if (!profile || !draft || !saved || locationDirty) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.save(propertyId, {
        schemaVersion: 1,
        expectedProfileRevision: profile.profileRevision,
        expectedCurationRevision: saved.curationRevision,
        choices: draft.choices,
        customPlaces: draft.customPlaces,
      });
      setSaved(next);
      setDraft(next);
      setNotice("Places saved.");
    } catch (error) {
      setError(saveError(error));
    } finally {
      setBusy(false);
    }
  }
  return {
    profile,
    location,
    setLocation,
    saved,
    draft,
    setDraft,
    discovery,
    error,
    setError,
    notice,
    providerMessage,
    busy,
    refreshing,
    locationDirty,
    placesDirty,
    refresh,
    saveLocation,
    savePlaces,
    reload: () => setReload((value) => value + 1),
    discard: () => {
      if (profile) setLocation(profile.profile.location);
      setDraft(saved);
      setError("");
      setNotice("");
    },
  };
}
function discoveryMessage(state: NearbyDiscoveryState): string {
  if (state.status === "ready") return "";
  if (state.status === "empty") return "No automatic places found. You can add your own.";
  if (state.status === "location_required")
    return "Save a valid pin and enable the guest map to discover nearby places.";
  if (state.status === "refreshing")
    return "Suggestions are being refreshed. Select Refresh suggestions in a moment.";
  return "Automatic suggestions are unavailable. You can still add your own places.";
}
function saveError(error: unknown): string {
  const status =
    (error as { status?: number; statusCode?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  return status === 409
    ? "Someone changed this property's settings. Your edits are preserved. Reload the latest version before saving again."
    : "Changes could not be saved. Your edits are preserved. Check the fields and try again.";
}
