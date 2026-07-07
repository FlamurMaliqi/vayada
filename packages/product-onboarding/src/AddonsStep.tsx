"use client";

import { useRef, useState } from "react";
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
  PhotoIcon,
} from "@heroicons/react/24/outline";
import { ToggleSwitch } from "./internal/ToggleSwitch";

const CATEGORIES = [
  { value: "dining", label: "Dining" },
  { value: "experience", label: "Experience" },
  { value: "transport", label: "Transport" },
  { value: "wellness", label: "Wellness" },
  { value: "other", label: "Other" },
];

const CATEGORY_COLORS: Record<string, string> = {
  transport: "bg-blue-100 text-blue-700",
  wellness: "bg-purple-100 text-purple-700",
  dining: "bg-orange-100 text-orange-700",
  experience: "bg-green-100 text-green-700",
};

export interface SetupAddon {
  _localId: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  image: string;
  duration: string;
  perPerson: boolean;
  perNight: boolean;
}

export function createEmptyAddon(currency: string): SetupAddon {
  return {
    _localId: crypto.randomUUID(),
    name: "",
    description: "",
    price: 0,
    currency,
    category: "experience",
    image: "",
    duration: "",
    perPerson: false,
    perNight: false,
  };
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
  uploadImage: (file: File) => Promise<string>;
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
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleImageUpload = async (file: File) => {
    const previousImage = formData.image;
    const previewUrl = URL.createObjectURL(file);
    setFormData((prev) => ({ ...prev, image: previewUrl }));

    try {
      setUploadingImage(true);
      const s3Url = await uploadImage(file);
      URL.revokeObjectURL(previewUrl);
      setFormData((prev) => ({ ...prev, image: s3Url }));
    } catch (err) {
      console.error("Image upload failed:", err);
      URL.revokeObjectURL(previewUrl);
      setFormData((prev) => ({ ...prev, image: previousImage }));
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSave = () => {
    if (!formData.name.trim()) return;
    const cleaned: SetupAddon = {
      ...formData,
      image: formData.image.startsWith("blob:") ? "" : formData.image,
    };
    if (editingId) {
      setAddons(addons.map((a) => (a._localId === editingId ? cleaned : a)));
    } else {
      setAddons([...addons, cleaned]);
    }
    setShowModal(false);
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        {stepIndicators}
        <div className="text-center mb-6">
          <h2 className="text-lg font-bold text-gray-900">Guest Add-ons</h2>
          <p className="text-[13px] text-gray-500 mt-1">
            Offer extras like airport transfers, spa treatments, or breakfast packages during
            booking
          </p>
        </div>

        {/* Add-ons List */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-[14px] font-semibold text-gray-900">Guest Experiences</h3>
              <p className="text-[12px] text-gray-500 mt-0.5">
                Upsells and add-ons shown during the booking flow
              </p>
            </div>
            <button
              onClick={openCreateModal}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-500 text-white text-[12px] font-medium rounded-lg hover:bg-primary-600 transition-colors"
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
                      {formatPrice(addon.price, addon.currency || currency || "USD")}
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

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
          <p className="text-[12px] text-blue-700">
            This step is optional — you can skip it and configure add-ons later from Booking Flow
            settings.
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
            <p className="text-[12px] text-red-700 font-medium">{error}</p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={onBack}
            className="px-5 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
          <button
            onClick={onContinue}
            disabled={!canProceed}
            className="px-5 py-2 bg-primary-500 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {addons.length === 0 ? "Skip for Now" : "Continue"} &rarr;
          </button>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">
                {editingId ? "Edit Add-on" : "Create Add-on"}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded-md"
              >
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g., Airport Transfer"
                />
              </div>

              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={2}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                  placeholder="Brief description of this add-on"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    Price *
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={formData.price || ""}
                      onChange={(e) =>
                        setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })
                      }
                      className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="px-2.5 py-1.5 bg-gray-100 border border-gray-200 rounded-lg text-[13px] font-medium text-gray-600 shrink-0">
                      {currency}
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Category
                </label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Image</label>
                {formData.image ? (
                  <div className="relative rounded-lg overflow-hidden bg-gray-200">
                    <img
                      src={formData.image}
                      alt="Add-on"
                      className="w-full h-36 object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, image: "" })}
                      className="absolute top-1.5 right-1.5 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                    {uploadingImage && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const file = e.dataTransfer.files?.[0];
                      if (file && file.type.startsWith("image/")) handleImageUpload(file);
                    }}
                    className="w-full h-36 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
                  >
                    {uploadingImage ? (
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <PhotoIcon className="w-6 h-6" />
                        <span className="text-[12px]">Click or drag to upload</span>
                      </>
                    )}
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleImageUpload(file);
                    e.target.value = "";
                  }}
                  className="hidden"
                />
                {formData.image && !uploadingImage && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-2 w-full py-1.5 text-[12px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Replace Image
                  </button>
                )}
              </div>

              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Duration
                </label>
                <input
                  type="text"
                  value={formData.duration}
                  onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g., 60 min, 2 hours, Full day"
                />
              </div>

              <ToggleSwitch
                size="sm"
                enabled={formData.perPerson}
                onChange={() => setFormData({ ...formData, perPerson: !formData.perPerson })}
                label="Per Person Pricing"
                description="Price is multiplied by number of guests"
              />

              <ToggleSwitch
                size="sm"
                enabled={formData.perNight}
                onChange={() => setFormData({ ...formData, perNight: !formData.perNight })}
                label="Per Night Pricing"
                description="Price is charged for each night of the stay (e.g. daily breakfast)"
              />
            </div>

            <div className="p-4 border-t border-gray-200 flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!formData.name.trim()}
                className="flex-1 py-2 text-[13px] font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
              >
                {editingId ? "Save Changes" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
