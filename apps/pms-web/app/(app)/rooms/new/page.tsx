"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { roomsService, RoomTypeCreate } from "@/services/rooms";
import { bookingsService } from "@/services/bookings";
import RoomTypeForm from "@/components/rooms/RoomTypeForm";

export default function NewRoomPage() {
  const router = useRouter();
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
      router.push("/rooms");
    } catch (err: any) {
      setError(err.message || "Failed to create room type");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex items-center gap-3 mb-5 md:mb-6">
        <Link href="/rooms" className="text-gray-400 hover:text-gray-600 shrink-0">
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900 truncate">New Room Type</h1>
      </div>

      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        submitLabel="Create Room Type"
        cancelHref="/rooms"
        mode="create"
      />
    </div>
  );
}
