"use client";
import { useEffect, useState } from "react";
import NearbyEditor from "@vayada/product-onboarding/NearbyEditor";
import { sharedHotelSetupApi, nearbyApi } from "@/services/api/sharedHotelSetupClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { getSelectedBookingHotelId } from "@/services/api/bookingHotelScope";

export default function LocationPage() {
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const hotelId = getSelectedBookingHotelId();
    if (!hotelId) {
      setError("Select a hotel before editing its location.");
      return;
    }
    void getBookingHotelPropertyLink({ hotelId })
      .then((link) => {
        if (!disposed) setPropertyId(link.propertyId);
      })
      .catch(() => {
        if (!disposed)
          setError("This hotel's location could not load. Please reload and try again.");
      });
    return () => {
      disposed = true;
    };
  }, []);
  if (!propertyId)
    return (
      <div className="p-8" role={error ? "alert" : "status"}>
        {error || "Loading location…"}
        {error && (
          <a href="/settings/location" className="ml-3 text-blue-700 underline">
            Reload
          </a>
        )}
      </div>
    );
  return (
    <>
      <a
        href="/settings"
        className="ml-4 mt-6 inline-block text-sm text-blue-700 underline sm:ml-8"
      >
        Back to settings
      </a>
      <NearbyEditor
        key={propertyId}
        propertyId={propertyId}
        api={nearbyApi}
        profileApi={sharedHotelSetupApi}
        apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""}
      />
    </>
  );
}
