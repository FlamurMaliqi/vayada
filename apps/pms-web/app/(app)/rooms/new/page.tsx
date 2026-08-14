"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon, CheckIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { roomsService, RoomTypeCreate, type PropertyPlan } from "@/services/rooms";
import { bookingsService } from "@/services/bookings";
import RoomTypeForm from "@/components/rooms/RoomTypeForm";

export default function NewRoomPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const onboarding = searchParams.get("onboarding");
  const isOnboarding = onboarding === "pms-activation" || onboarding === "booking-readiness";
  const [saving, setSaving] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [error, setError] = useState("");
  const [initialCurrency, setInitialCurrency] = useState("EUR");
  const [propertyPlan, setPropertyPlan] = useState<PropertyPlan | null>(null);
  const [form, setForm] = useState<RoomTypeCreate>({
    name: "",
    description: "",
    shortDescription: "",
    maxOccupancy: 2,
    maxAdults: null,
    maxChildren: null,
    bathroomType: "private",
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

  // Inherit currency from payment settings (authoritative source)
  useEffect(() => {
    roomsService.getPropertyPlan().then(setPropertyPlan).catch(console.error);
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
      if (isOnboarding) {
        setSetupComplete(true);
      } else {
        router.push("/rooms");
      }
    } catch (err: any) {
      setError(err.message || "Failed to create room type");
    } finally {
      setSaving(false);
    }
  };

  if (setupComplete) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-2xl items-center p-4 md:p-6">
        <section className="w-full rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
            <CheckIcon className="h-7 w-7 text-emerald-700" aria-hidden="true" />
          </div>
          <p className="mb-2 text-sm font-semibold text-emerald-700">PMS setup complete</p>
          <h1 className="text-2xl font-bold text-gray-950 sm:text-3xl">
            Your first room type is ready
          </h1>
          <p className="mt-3 leading-7 text-gray-600">
            Room inventory, availability, and the first rate plan are now configured. You can add
            more room types now or continue managing the property.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => router.push("/rooms")}
              className="rounded-xl bg-primary-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
            >
              Continue to PMS
            </button>
            <button
              type="button"
              onClick={() => {
                setForm((current) => ({
                  ...current,
                  name: "",
                  description: "",
                  shortDescription: "",
                  baseRate: 0,
                  totalRooms: 2,
                  images: [],
                  seasons: [],
                }));
                setSetupComplete(false);
              }}
              className="rounded-xl border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              Add another room type
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="max-w-5xl p-4 md:p-6">
      {isOnboarding && (
        <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5 sm:p-6">
          <p className="text-sm font-semibold text-indigo-700">PMS setup</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-950">Set up your rooms and rates</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
            This is the last PMS step needed to start selling rooms. Complete each section below,
            then finish setup.
          </p>
          <ol className="mt-5 grid gap-3 sm:grid-cols-3">
            {[
              ["1", "Room details & inventory"],
              ["2", "Pricing & availability"],
              ["3", "Images & amenities"],
            ].map(([number, label]) => (
              <li
                key={number}
                className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-white px-4 py-3 text-sm font-medium text-gray-800"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
                  {number}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="flex items-center gap-3 mb-5 md:mb-6">
        <Link
          href="/rooms"
          aria-label="Back to rooms"
          className="text-gray-400 hover:text-gray-600 shrink-0"
        >
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h2 className="truncate text-xl font-bold text-gray-900">
          {isOnboarding ? "Your first room type" : "New Room Type"}
        </h2>
      </div>

      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        submitLabel={isOnboarding ? "Finish PMS Setup" : "Create Room Type"}
        cancelHref="/rooms"
        mode="create"
        propertyPlan={propertyPlan}
      />
    </div>
  );
}
