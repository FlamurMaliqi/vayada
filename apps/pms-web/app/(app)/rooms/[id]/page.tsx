"use client";

import { useState, useEffect, use } from "react";
import { ArrowLeftIcon, TrashIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import {
  roomsService,
  roomTypeUpdateForm,
  RoomType,
  RoomTypeUpdate,
  type PropertyPlan,
} from "@/services/rooms";
import RoomTypeForm from "@/components/rooms/RoomTypeForm";
import ConfirmDialog from "@/components/ConfirmDialog";

const ROOM_TYPE_MUTATIONS_UNSUPPORTED_MESSAGE =
  "Room type deletion is not available on PMS next-stack yet.";

export default function EditRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [room, setRoom] = useState<RoomType | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
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
      .catch(console.error)
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

  const handleDelete = () => {
    setShowDeleteConfirm(false);
    setError(ROOM_TYPE_MUTATIONS_UNSUPPORTED_MESSAGE);
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
        <p className="text-gray-500">Room type not found.</p>
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
          disabled
          title={ROOM_TYPE_MUTATIONS_UNSUPPORTED_MESSAGE}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 shrink-0"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="hidden md:inline">Delete</span>
        </button>
      </div>

      <RoomTypeForm
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
          message="Are you sure you want to delete this room type? This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
