"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { roomsService, RoomTypeCreate } from "@/services/rooms";
import { bookingsService } from "@/services/bookings";
import RoomTypeForm from "@/components/rooms/RoomTypeForm";
import {
  hasPmsSetupTaskContext,
  parsePmsSetupTaskHandoff,
  type PmsSetupTaskContext,
} from "@/lib/utils/pmsSetupTaskFlow";

const MARKETPLACE_FRONTEND_URL =
  process.env.NEXT_PUBLIC_MARKETPLACE_URL || "https://app.vayada.com";
const SETUP_HUB_URL = new URL("/setup", MARKETPLACE_FRONTEND_URL).toString();

export default function NewRoomPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setupTaskQuery = searchParams.toString();
  const hasSetupTaskContext = hasPmsSetupTaskContext(searchParams);
  const [setupTaskResolution, setSetupTaskResolution] = useState<{
    query: string;
    handoff: PmsSetupTaskContext | null;
  } | null>(null);
  const setupTaskResolved = !hasSetupTaskContext || setupTaskResolution?.query === setupTaskQuery;
  const setupTaskHandoff = setupTaskResolved ? (setupTaskResolution?.handoff ?? null) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [initialCurrency, setInitialCurrency] = useState("EUR");
  const [form, setForm] = useState<RoomTypeCreate>({
    name: "",
    description: "",
    shortDescription: "",
    maxOccupancy: 2,
    maxAdults: null,
    maxChildren: null,
    size: 0,
    baseRate: 0,
    nonRefundableRate: null,
    currency: "EUR",
    locationAddress: "",
    latitude: null,
    longitude: null,
    bedType: "",
    totalRooms: 2,
    amenities: [],
    features: [],
    images: [],
    isActive: true,
    sortOrder: 0,
    monthlyRates: {},
    dailyRates: {},
  });

  useEffect(() => {
    if (!hasSetupTaskContext) {
      setSetupTaskResolution(null);
      return;
    }

    setSetupTaskResolution({
      query: setupTaskQuery,
      handoff: window.location.hash
        ? null
        : parsePmsSetupTaskHandoff(
            new URLSearchParams(window.location.search),
            localStorage,
            MARKETPLACE_FRONTEND_URL,
          ),
    });
  }, [hasSetupTaskContext, setupTaskQuery]);

  // Inherit currency from payment settings (authoritative source)
  useEffect(() => {
    bookingsService
      .getPaymentSettings()
      .then((res) => {
        const c = res.paymentSettings.defaultCurrency;
        if (c) {
          setInitialCurrency(c);
          setForm((prev) => ({ ...prev, currency: c }));
        }
      })
      .catch(console.error);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name) {
      setError("Name is required");
      return;
    }
    if (!form.seasons?.length || !form.seasons.some((s) => s.rate && Number(s.rate) > 0)) {
      setError("At least one season with a rate greater than 0 is required");
      return;
    }
    if (form.seasons.some((s) => s.from && s.to && (!s.rate || Number(s.rate) <= 0))) {
      setError("Every season must have a rate greater than 0");
      return;
    }
    if (
      form.seasons.some(
        (s) => s.maxStay != null && Number(s.maxStay) > 0 && Number(s.maxStay) < (s.minStay || 1),
      )
    ) {
      setError("Max stay cannot be less than min stay.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (form.currency && form.currency !== initialCurrency) {
        await bookingsService.updatePaymentSettings({ defaultCurrency: form.currency });
      }
      await roomsService.create(form);
      if (setupTaskHandoff) {
        window.location.replace(setupTaskHandoff.returnUrl);
      } else {
        router.push("/rooms");
      }
    } catch (err: any) {
      setError(err.message || "Failed to create room type");
    } finally {
      setSaving(false);
    }
  };

  if (hasSetupTaskContext && !setupTaskResolved) {
    return (
      <div className="flex min-h-[calc(100vh-5rem)] items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (hasSetupTaskContext && !setupTaskHandoff) {
    return (
      <main className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-2xl items-center p-4 md:p-6">
        <section className="w-full rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm sm:p-10">
          <h1 className="text-xl font-semibold text-gray-950">Setup task unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-gray-600">
            This PMS setup context is invalid or no longer matches the selected hotel. Return to the
            setup plan to continue with the current next step.
          </p>
          <button
            type="button"
            onClick={() => window.location.replace(SETUP_HUB_URL)}
            className="mt-6 rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
          >
            Return to setup plan
          </button>
        </section>
      </main>
    );
  }

  return (
    <div className="max-w-5xl p-4 md:p-6">
      <div className="mb-5 flex items-start gap-3 md:mb-6">
        {setupTaskHandoff ? (
          <button
            type="button"
            onClick={() => window.location.replace(setupTaskHandoff.returnUrl)}
            aria-label="Back to setup plan"
            className="mt-1 shrink-0 text-gray-400 hover:text-gray-600"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </button>
        ) : (
          <Link
            href="/rooms"
            aria-label="Back to rooms"
            className="mt-1 shrink-0 text-gray-400 hover:text-gray-600"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </Link>
        )}
        <div>
          {setupTaskHandoff && (
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-indigo-700">
              Hotel setup
            </p>
          )}
          <h2 className="text-xl font-bold text-gray-900">
            {setupTaskHandoff ? "Your first room type" : "New Room Type"}
          </h2>
          {setupTaskHandoff && (
            <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">
              Add the room inventory, pricing, and availability needed for Hotel Operations.
            </p>
          )}
        </div>
      </div>

      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        submitLabel={setupTaskHandoff ? "Save and return to setup" : "Create Room Type"}
        cancelHref={setupTaskHandoff?.returnUrl ?? "/rooms"}
        cancelLabel={setupTaskHandoff ? "Exit setup" : "Cancel"}
        onCancel={
          setupTaskHandoff ? () => window.location.replace(setupTaskHandoff.returnUrl) : undefined
        }
        mode="create"
      />
    </div>
  );
}
