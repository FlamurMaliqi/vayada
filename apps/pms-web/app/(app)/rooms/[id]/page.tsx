"use client";

import { useState, useEffect, use } from "react";
import { ArrowLeftIcon, TrashIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  roomsService,
  roomTypeUpdateForm,
  RoomType,
  RoomTypeUpdate,
  type PropertyPlan,
} from "@/services/rooms";
import RoomTypeForm from "@/components/rooms/RoomTypeForm";
import ConfirmDialog from "@/components/ConfirmDialog";

export default function EditRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [room, setRoom] = useState<RoomType | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [propertyPlan, setPropertyPlan] = useState<PropertyPlan | null>(null);

  const [form, setForm] = useState<RoomTypeUpdate>({});

  useEffect(() => {
    roomsService.getPropertyPlan().then(setPropertyPlan).catch(console.error);
    roomsService
      .get(id)
      .then((r) => {
        setRoom(r);
        setForm(roomTypeUpdateForm(r));
      })
      .catch((cause) => {
        console.error(cause);
        setError(cause instanceof Error ? cause.message : "Failed to load room type.");
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const updated = await roomsService.update(id, form);
      setRoom(updated);
      setForm(roomTypeUpdateForm(updated));
      setSuccess("Room type changes saved.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to save room type changes.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError("");
    try {
      await roomsService.delete(id);
      router.push("/rooms");
    } catch (error) {
      setShowDeleteConfirm(false);
      setError(error instanceof Error ? error.message : "Failed to retire room type.");
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-96 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="p-6">
        <p className={error ? "text-red-600" : "text-gray-500"}>
          {error || "Room type not found."}
        </p>
        {error && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3 mb-5 md:mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/rooms" className="text-gray-400 hover:text-gray-600 shrink-0">
            <ArrowLeftIcon className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold text-gray-900 truncate">Edit: {room.name}</h1>
        </div>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 shrink-0"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="hidden md:inline">Delete</span>
        </button>
      </div>

      <RoomTypeForm
        key={[
          form.canonicalPricingSnapshot?.expectedRoomFactsRevision,
          form.canonicalPricingSnapshot?.expectedPricingCurrencyRevision,
          form.canonicalPricingSnapshot?.expectedFlexibleRatePlanRevision,
        ].join(":")}
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        success={success}
        submitLabel="Save Changes"
        cancelHref="/rooms"
        mode="edit"
        roomTypeId={id}
        propertyPlan={propertyPlan}
      />
      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Room Type"
          message="Retire this room type? Vayada will first check reservations, physical units, inventory, and publication state. Historical records are preserved."
          confirmLabel={deleting ? "Retiring…" : "Retire"}
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
