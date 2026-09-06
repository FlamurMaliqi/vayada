"use client";

import { useState } from "react";
import { PlusIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import { AddonEditor, emptyAddonValues, type AddonEditorValues } from "./AddonEditor";

const CATEGORY_COLORS: Record<string, string> = {
  transport: "bg-blue-100 text-blue-700",
  wellness: "bg-purple-100 text-purple-700",
  dining: "bg-orange-100 text-orange-700",
  experience: "bg-green-100 text-green-700",
};

export type SetupAddon = AddonEditorValues & { _localId: string; image: string };

export function createEmptyAddon(currency: string): SetupAddon {
  return { ...emptyAddonValues(currency), _localId: crypto.randomUUID(), image: "" };
}

interface AddonsStepProps {
  addons: SetupAddon[];
  setAddons: (addons: SetupAddon[]) => void;
  currency: string;
  error: string;
  canProceed: boolean;
  onBack: () => void;
  onContinue: () => void;
  stepIndicators: React.ReactNode;
  uploadImage: (file: File) => Promise<{ mediaObjectId: string; publicUrl: string }>;
  formatPrice?: (amount: number, currency: string) => string;
}

const defaultFormatPrice = (amount: number, currency: string) => `${currency} ${amount.toFixed(2)}`;

export default function AddonsStep({
  addons,
  setAddons,
  currency,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
  uploadImage,
  formatPrice = defaultFormatPrice,
}: AddonsStepProps) {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(() => createEmptyAddon(currency));

  const openCreateModal = () => {
    setEditingId(null);
    setFormData(createEmptyAddon(currency));
    setShowModal(true);
  };

  const openEditModal = (addon: SetupAddon) => {
    setEditingId(addon._localId);
    setFormData({ ...addon });
    setShowModal(true);
  };

  const handleDelete = (localId: string) => {
    setAddons(addons.filter((a) => a._localId !== localId));
  };

  const handleSave = async (values: AddonEditorValues) => {
    const photos = [];
    for (const photo of values.photos) {
      const uploaded = photo.file ? await uploadImage(photo.file) : null;
      photos.push({
        ...photo,
        file: undefined,
        mediaObjectId: uploaded?.mediaObjectId ?? photo.mediaObjectId,
        imageUrl: uploaded?.publicUrl ?? photo.imageUrl,
      });
    }
    const cleaned: SetupAddon = {
      ...values,
      _localId: formData._localId,
      photos,
      image: photos.find((p) => p.isCover)?.imageUrl ?? "",
    };
    setAddons(
      editingId
        ? addons.map((a) => (a._localId === editingId ? cleaned : a))
        : [...addons, cleaned],
    );
    setShowModal(false);
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-5">
        {stepIndicators}
        <div className="text-center mb-5">
          <h2 className="text-2xl font-semibold text-gray-900">Guest Add-ons</h2>
          <p className="text-sm text-gray-500 mt-1">
            Offer extras like airport transfers, spa treatments, or breakfast packages during
            booking
          </p>
        </div>

        {/* Add-ons List */}
        <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5 mb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
            <div>
              <h3 className="text-[14px] font-semibold text-gray-900">Guest Experiences</h3>
              <p className="text-[12px] text-gray-500 mt-0.5">
                Upsells and add-ons shown during the booking flow
              </p>
            </div>
            <button
              onClick={openCreateModal}
              className="inline-flex w-full sm:w-auto items-center justify-center gap-1 px-4 py-2 bg-primary-500 text-white text-[12px] font-medium rounded-full hover:bg-primary-600 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" />
              Add Experience
            </button>
          </div>

          {addons.length === 0 ? (
            <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-6 text-center">
              <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
                <svg
                  className="w-5 h-5 text-gray-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              </div>
              <p className="text-[13px] font-medium text-gray-600">No add-ons yet</p>
              <p className="text-[12px] text-gray-400 mt-0.5">
                Add guest experiences to show during booking — you can also do this later
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {addons.map((addon) => (
                <div
                  key={addon._localId}
                  className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
                >
                  {addon.image ? (
                    <img
                      src={addon.image}
                      alt={addon.name}
                      className="w-10 h-10 rounded-md object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-md bg-gray-100 flex items-center justify-center shrink-0">
                      <svg
                        className="w-4 h-4 text-gray-400"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-gray-900 truncate">{addon.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[addon.category] || "bg-gray-100 text-gray-600"}`}
                      >
                        {addon.category.charAt(0).toUpperCase() + addon.category.slice(1)}
                      </span>
                      {addon.duration && (
                        <span className="text-[11px] text-gray-400">{addon.duration}</span>
                      )}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <p className="text-[13px] font-semibold text-gray-900">
                      {formatPrice(Number(addon.price), currency)}
                    </p>
                    {addon.perPerson && <p className="text-[10px] text-gray-400">per person</p>}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => openEditModal(addon)}
                      className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                    >
                      <PencilSquareIcon className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(addon._localId)}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 mb-4">
          <p className="text-[12px] text-blue-700">
            This step is optional — you can skip it and configure add-ons later from Booking Flow
            settings.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
            <p className="text-[12px] text-red-700 font-medium">{error}</p>
          </div>
        )}

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            onClick={onBack}
            className="w-full sm:w-auto px-6 py-2.5 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-full hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
          <button
            onClick={onContinue}
            disabled={!canProceed}
            className="w-full sm:w-auto px-6 py-2.5 bg-primary-500 text-white text-[13px] font-semibold rounded-full hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {addons.length === 0 ? "Skip for Now" : "Continue"} &rarr;
          </button>
        </div>
      </div>

      {showModal && (
        <AddonEditor
          editing={Boolean(editingId)}
          currency={currency}
          onCancel={() => setShowModal(false)}
          onSave={handleSave}
          initialValues={{
            ...emptyAddonValues(currency),
            ...formData,
            price: editingId ? String(formData.price) : "",
            category: formData.category as AddonEditorValues["category"],
            photos:
              formData.photos ??
              (formData.image
                ? [{ imageUrl: formData.image, mediaObjectId: null, isCover: true }]
                : []),
          }}
        />
      )}
    </div>
  );
}
