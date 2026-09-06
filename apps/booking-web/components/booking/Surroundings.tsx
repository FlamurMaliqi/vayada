"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { NearbyPreview as Preview } from "@vayada/domain-hotels";
import { bookingWebPublic } from "@/services/api/client";

const NearbyPreview = dynamic(() => import("@vayada/product-onboarding/NearbyPreview"), {
  ssr: false,
});
type Response = Preview & { schemaVersion: 1; status: string };

export default function Surroundings({ slug, locality }: { slug: string; locality: string }) {
  const [opened, setOpened] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<Response | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 12000);
    setData(null);
    setFailed(false);
    void bookingWebPublic
      .get<Response>(`/api/booking-web/hotels/${encodeURIComponent(slug)}/nearby`, {
        cache: "no-store",
        signal: controller.signal,
      })
      .then((response) => {
        if (disposed) return;
        if (response.schemaVersion !== 1 || !Array.isArray(response.places))
          throw new Error("Invalid surroundings");
        setData(response);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [opened, slug, attempt]);
  return (
    <section
      aria-label="Location"
      className="mx-auto max-w-7xl bg-gray-50 px-4 py-12 sm:px-6 lg:px-8"
    >
      <h2 className="text-2xl font-semibold text-gray-950">Location</h2>
      {locality && <p className="mt-2 text-gray-600">{locality}</p>}
      {!opened ? (
        <button
          type="button"
          onClick={() => setOpened(true)}
          className="mt-5 rounded-full border border-gray-300 px-5 py-3 font-medium hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          Explore our surroundings
        </button>
      ) : (
        <div className="mt-6" aria-live="polite">
          {failed ? (
            <div>
              <p>Surroundings are unavailable right now. You can still choose a room.</p>
              <button
                type="button"
                className="mt-3 underline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          ) : !data ? (
            <p role="status">Loading our surroundings…</p>
          ) : !data.location ? (
            <p>Contact us for location details.</p>
          ) : (
            <>
              {data.status === "empty" && (
                <p className="mb-4 text-sm text-gray-600">No nearby places have been added yet.</p>
              )}
              {data.status === "refreshing" && (
                <p className="mb-4 text-sm text-gray-600">
                  Nearby suggestions are being updated. Our saved recommendations are shown below.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Check for updated places
                  </button>
                </p>
              )}
              <NearbyPreview
                key={`${slug}-${attempt}`}
                guest
                preview={data}
                apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ""}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
