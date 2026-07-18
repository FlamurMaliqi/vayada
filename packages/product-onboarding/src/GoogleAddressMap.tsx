"use client";

import { useEffect, useRef, useState } from "react";

import { importGoogleMapsLibrary } from "./googleMaps";

type MapPosition = { lat: number; lng: number };
type GoogleMap = {
  setCenter: (position: MapPosition) => void;
  setZoom: (zoom: number) => void;
};
type GoogleMarker = {
  setPosition: (position: MapPosition | null) => void;
};
type GoogleMapsLibrary = {
  Map: new (
    element: HTMLElement,
    options: {
      center: MapPosition;
      zoom: number;
      clickableIcons: boolean;
      disableDefaultUI: boolean;
      gestureHandling: string;
      keyboardShortcuts: boolean;
    },
  ) => GoogleMap;
};
type GoogleMarkerLibrary = {
  Marker: new (options: { map: GoogleMap; position?: MapPosition; title: string }) => GoogleMarker;
};

const WORLD_CENTER = { lat: 20, lng: 0 };

export default function GoogleAddressMap({
  active,
  apiKey,
  latitude,
  longitude,
}: {
  active: boolean;
  apiKey: string;
  latitude: number | null;
  longitude: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMap | null>(null);
  const markerRef = useRef<GoogleMarker | null>(null);
  const position = mapPosition(latitude, longitude);
  const positionRef = useRef(position);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
  positionRef.current = position;

  useEffect(() => {
    if (!active || !containerRef.current || mapRef.current) return;

    let disposed = false;
    setStatus("loading");
    void Promise.all([
      importGoogleMapsLibrary<GoogleMapsLibrary>(apiKey, "maps"),
      importGoogleMapsLibrary<GoogleMarkerLibrary>(apiKey, "marker"),
    ])
      .then(([{ Map }, { Marker }]) => {
        if (disposed || !containerRef.current) return;
        const map = new Map(containerRef.current, {
          center: positionRef.current ?? WORLD_CENTER,
          zoom: positionRef.current ? 17 : 2,
          clickableIcons: false,
          disableDefaultUI: true,
          gestureHandling: "cooperative",
          keyboardShortcuts: false,
        });
        mapRef.current = map;
        // ponytail: Legacy Marker avoids a required cloud map ID; migrate when map IDs are configured.
        markerRef.current = new Marker({
          map,
          ...(positionRef.current ? { position: positionRef.current } : {}),
          title: "Hotel location",
        });
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) setStatus("unavailable");
      });

    return () => {
      disposed = true;
    };
  }, [active, apiKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const nextPosition = mapPosition(latitude, longitude);
    map.setCenter(nextPosition ?? WORLD_CENTER);
    map.setZoom(nextPosition ? 17 : 2);
    markerRef.current?.setPosition(nextPosition);
  }, [latitude, longitude]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-slate-100" aria-hidden="true">
      <div
        ref={containerRef}
        className="absolute inset-0"
        data-testid="google-address-map-canvas"
      />
      {(status === "idle" || status === "loading") && (
        <div className="absolute inset-0 animate-pulse bg-slate-100" />
      )}
      {status === "unavailable" && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100 text-sm font-medium text-slate-500">
          Map unavailable
        </div>
      )}
    </div>
  );
}

function mapPosition(latitude: number | null, longitude: number | null): MapPosition | null {
  return typeof latitude === "number" &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === "number" &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180
    ? { lat: latitude, lng: longitude }
    : null;
}
