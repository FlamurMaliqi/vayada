"use client";

import { useState, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import { PlusIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/24/outline";
import { ToggleSwitch } from "@/components/ui";
import type { AddonItem, AddonSettings } from "@/services/settings";
import { getCurrencySymbol } from "@/lib/utils";

const CATEGORY_COLORS: Record<string, string> = {
  transport: "bg-blue-100 text-blue-700",
  wellness: "bg-purple-100 text-purple-700",
  dining: "bg-orange-100 text-orange-700",
  experience: "bg-green-100 text-green-700",
};

const CATEGORY_OPTIONS = ["dining", "experience", "transport", "wellness", "other"] as const;
const PARTNER_COMMISSION_RATE = /^(?:100(?:\.0{1,4})?|(?:0|[1-9]\d?)(?:\.\d{1,4})?)$/;

export type AddonItemCategory = (typeof CATEGORY_OPTIONS)[number];

export interface AddonItemFormValues {
  name: string;
  description: string;
  price: string;
  currency: string;
  category: AddonItemCategory;
  image: string;
  imageMediaObjectId: string | null;
  imageFile: File | null;
  duration: string;
  perPerson: boolean;
  perNight: boolean;
  ownershipKind: "property" | "partner";
  partnerCommissionRate: string;
}

function AddonsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

function emptyDraft(currency: string): AddonItemFormValues {
  return {
    name: "",
    description: "",
    price: "",
    currency,
    category: "experience",
    image: "",
    imageMediaObjectId: null,
    imageFile: null,
    duration: "",
    perPerson: false,
    perNight: false,
    ownershipKind: "property",
    partnerCommissionRate: "",
  };
}

function toAddonCategory(category: string): AddonItemCategory {
  return CATEGORY_OPTIONS.includes(category as AddonItemCategory)
    ? (category as AddonItemCategory)
    : "other";
}

function toDraft(addon: AddonItem, fallbackCurrency: string): AddonItemFormValues {
  return {
    name: addon.name,
    description: addon.description,
    price: addon.price.toFixed(2),
    currency: addon.currency || fallbackCurrency,
    category: toAddonCategory(addon.category),
    image: addon.image,
    imageMediaObjectId: addon.imageMediaObjectId ?? null,
    imageFile: null,
    duration: addon.duration ?? "",
    perPerson: addon.perPerson === true,
    perNight: addon.perNight === true,
    ownershipKind: addon.ownershipKind,
    partnerCommissionRate: addon.partnerCommissionRate ?? "",
  };
}

function orderAddons(addons: AddonItem[]): AddonItem[] {
  return addons
    .map((addon, index) => ({ addon, index }))
    .sort((left, right) => {
      const leftOrder = left.addon.sortOrder ?? left.index;
      const rightOrder = right.addon.sortOrder ?? right.index;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ addon }) => addon);
}

interface AddonsTabProps {
  addons: AddonItem[];
  addonSettings: AddonSettings;
  propertyCurrency: string;
  propertyPlan: {
    plan: "commission" | "fixed";
    limits: { maxAddons: number };
  };
  handleToggleAddonSetting: (key: keyof AddonSettings) => void;
  onCreateAddon: (values: AddonItemFormValues) => Promise<void>;
  onUpdateAddon: (addonId: string, values: AddonItemFormValues) => Promise<void>;
  onDeleteAddon: (addonId: string) => Promise<void>;
  onReorderAddon: (sourceAddonId: string, targetAddonId: string) => Promise<void>;
}

export default function AddonsTab({
  addons,
  addonSettings,
  propertyCurrency,
  propertyPlan,
  handleToggleAddonSetting,
  onCreateAddon,
  onUpdateAddon,
  onDeleteAddon,
  onReorderAddon,
}: AddonsTabProps) {
  const [filterCategory, setFilterCategory] = useState("all");
  const [draft, setDraft] = useState<AddonItemFormValues>(() => emptyDraft(propertyCurrency));
  const [editingAddon, setEditingAddon] = useState<AddonItem | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [deletingAddonId, setDeletingAddonId] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [draggingAddonId, setDraggingAddonId] = useState<string | null>(null);
  const orderedAddons = orderAddons(addons);
  const categories = Array.from(new Set(orderedAddons.map((a) => a.category).filter(Boolean)));
  const filteredAddons =
    filterCategory === "all"
      ? orderedAddons
      : orderedAddons.filter((a) => a.category === filterCategory);
  const canReorder = filterCategory === "all" && orderedAddons.length > 1;
  const maxAddons = propertyPlan.limits.maxAddons;
  const addonLimitReached = addons.length >= maxAddons;
  const addonLimitMessage =
    propertyPlan.plan === "commission"
      ? addons.length > maxAddons
        ? "You have more add-ons than your plan allows. Remove add-ons to add new ones, or upgrade for up to 9."
        : "You've reached the 3 add-on limit. Upgrade to the paid plan for up to 9 add-ons."
      : "You've reached the 9 add-on limit for the paid plan.";

  const openCreateEditor = () => {
    setEditingAddon(null);
    setDraft(emptyDraft(propertyCurrency));
    setItemError(null);
    setIsEditorOpen(true);
  };

  const openEditEditor = (addon: AddonItem) => {
    setEditingAddon(addon);
    setDraft(toDraft(addon, propertyCurrency));
    setItemError(null);
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    if (savingItem) return;
    setIsEditorOpen(false);
    setEditingAddon(null);
    setItemError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draft.name.trim();
    const price = Number(draft.price);
    if (!name) {
      setItemError("Name is required.");
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setItemError("Price must be a non-negative amount.");
      return;
    }
    const partnerCommissionRate = draft.partnerCommissionRate.trim();
    if (draft.ownershipKind === "partner" && !PARTNER_COMMISSION_RATE.test(partnerCommissionRate)) {
      setItemError("Partner commission must be between 0 and 100 with up to 4 decimals.");
      return;
    }

    setSavingItem(true);
    setItemError(null);
    const normalized = {
      ...draft,
      name,
      description: draft.description.trim(),
      price: price.toFixed(2),
      currency: draft.currency.trim().toUpperCase(),
      duration: draft.duration.trim(),
      partnerCommissionRate: draft.ownershipKind === "partner" ? partnerCommissionRate : "",
    };

    try {
      if (editingAddon) {
        await onUpdateAddon(editingAddon.id, normalized);
      } else {
        await onCreateAddon(normalized);
      }
      closeEditor();
    } catch (error) {
      setItemError(error instanceof Error ? error.message : "Failed to save add-on.");
    } finally {
      setSavingItem(false);
    }
  };

  const handleDelete = async (addon: AddonItem) => {
    if (!window.confirm(`Delete ${addon.name}?`)) return;
    setDeletingAddonId(addon.id);
    setItemError(null);
    try {
      await onDeleteAddon(addon.id);
    } catch {
      setItemError("Failed to delete add-on.");
    } finally {
      setDeletingAddonId(null);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, addonId: string) => {
    if (!canReorder) {
      event.preventDefault();
      return;
    }

    setDraggingAddonId(addonId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", addonId);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, targetAddonId: string) => {
    const sourceAddonId = draggingAddonId || event.dataTransfer.getData("text/plain");
    if (!canReorder || !sourceAddonId || sourceAddonId === targetAddonId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>, targetAddonId: string) => {
    event.preventDefault();
    const sourceAddonId = event.dataTransfer.getData("text/plain") || draggingAddonId;
    setDraggingAddonId(null);
    if (!canReorder || !sourceAddonId || sourceAddonId === targetAddonId) return;

    setItemError(null);
    try {
      await onReorderAddon(sourceAddonId, targetAddonId);
    } catch {
      setItemError("Failed to reorder add-ons.");
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      {/* Guest Experiences */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-semibold text-gray-900">Guest Experiences</h2>
            <p className="text-[12px] text-gray-500 mt-0.5">
              Upsells and add-ons shown during the booking flow
            </p>
          </div>
          <button
            onClick={openCreateEditor}
            disabled={addonLimitReached}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-900 text-white text-[12px] font-medium rounded-lg hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            Add Experience
          </button>
        </div>

        <div className="mb-4 flex items-center justify-between gap-3 text-[12px]">
          <span className="text-gray-500">
            {addons.length}/{maxAddons} add-ons
          </span>
        </div>

        {addonLimitReached && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            <p>{addonLimitMessage}</p>
            {propertyPlan.plan === "commission" && (
              <Link
                href="/settings?section=billing"
                className="mt-1 inline-block font-semibold underline underline-offset-2"
              >
                Upgrade to offer up to 9 add-ons and increase your upsell revenue.
              </Link>
            )}
          </div>
        )}

        {itemError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {itemError}
          </div>
        )}

        {/* Category filter pills */}
        {categories.length > 1 && (
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            <button
              onClick={() => setFilterCategory("all")}
              className={`px-3 py-1 rounded-full text-[11px] font-medium border transition-colors ${filterCategory === "all" ? "border-gray-900 text-gray-900 bg-gray-50" : "border-gray-200 text-gray-500 hover:border-gray-300"}`}
            >
              All ({addons.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`px-3 py-1 rounded-full text-[11px] font-medium border transition-colors ${filterCategory === cat ? "border-gray-900 text-gray-900 bg-gray-50" : "border-gray-200 text-gray-500 hover:border-gray-300"}`}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)} (
                {addons.filter((a) => a.category === cat).length})
              </button>
            ))}
          </div>
        )}

        {addons.length === 0 ? (
          <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-6 text-center">
            <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
              <AddonsIcon className="w-5 h-5 text-gray-400" />
            </div>
            <p className="text-[13px] font-medium text-gray-600">No add-ons yet</p>
            <p className="text-[12px] text-gray-400 mt-0.5">
              Create your first guest experience to show during booking
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredAddons.map((addon) => (
              <div
                key={addon.id}
                data-testid={`booking-addon-item-${addon.id}`}
                onDragOver={(event) => handleDragOver(event, addon.id)}
                onDrop={(event) => handleDrop(event, addon.id)}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                  draggingAddonId === addon.id
                    ? "border-gray-400 bg-gray-50"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <button
                  type="button"
                  aria-label={`Drag ${addon.name}`}
                  title={canReorder ? "Drag to reorder" : "Reordering is available in All view"}
                  draggable={canReorder}
                  disabled={!canReorder}
                  onDragStart={(event) => handleDragStart(event, addon.id)}
                  onDragEnd={() => setDraggingAddonId(null)}
                  className={`text-gray-300 shrink-0 rounded p-1 ${
                    canReorder
                      ? "cursor-grab hover:text-gray-500 active:cursor-grabbing"
                      : "cursor-not-allowed opacity-50"
                  }`}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.5" />
                    <circle cx="15" cy="6" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" />
                    <circle cx="15" cy="12" r="1.5" />
                    <circle cx="9" cy="18" r="1.5" />
                    <circle cx="15" cy="18" r="1.5" />
                  </svg>
                </button>

                {/* Image thumbnail */}
                {addon.image ? (
                  <img
                    src={addon.image}
                    alt={addon.name}
                    className="w-10 h-10 rounded-md object-cover shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-md bg-gray-100 flex items-center justify-center shrink-0">
                    <AddonsIcon className="w-4 h-4 text-gray-400" />
                  </div>
                )}

                {/* Name and category */}
                <div className="flex-1 min-w-0">
                  <p
                    data-testid="booking-addon-item-name"
                    className="text-[13px] font-medium text-gray-900 truncate"
                  >
                    {addon.name}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span
                      className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[addon.category] || "bg-gray-100 text-gray-600"}`}
                    >
                      {addon.category.charAt(0).toUpperCase() + addon.category.slice(1)}
                    </span>
                    {addon.duration && (
                      <span className="text-[11px] text-gray-400">{addon.duration}</span>
                    )}
                    <span className="text-[11px] text-gray-400">
                      {addon.ownershipKind === "partner"
                        ? `Partner · ${addon.partnerCommissionRate}%`
                        : "Own"}
                    </span>
                  </div>
                </div>

                {/* Price */}
                <div className="text-right shrink-0">
                  <p className="text-[13px] font-semibold text-gray-900">
                    {getCurrencySymbol(propertyCurrency)}
                    {addon.price.toFixed(2)}
                  </p>
                  {addon.perPerson && <p className="text-[10px] text-gray-400">per person</p>}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openEditEditor(addon)}
                    aria-label={`Edit ${addon.name}`}
                    className="p-1.5 text-gray-500 hover:text-gray-900 rounded-md hover:bg-gray-100"
                  >
                    <PencilSquareIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(addon)}
                    disabled={deletingAddonId === addon.id}
                    aria-label={`Delete ${addon.name}`}
                    className="p-1.5 text-gray-500 hover:text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Display Settings */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Display Settings</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
          Control how add-ons appear in the booking flow
        </p>

        <div className="space-y-2">
          <ToggleSwitch
            size="sm"
            enabled={addonSettings.showAddonsStep}
            onChange={() => handleToggleAddonSetting("showAddonsStep")}
            label="Show Add-ons Step"
            description="Display the add-ons step in the booking flow"
          />
          <ToggleSwitch
            size="sm"
            enabled={addonSettings.groupAddonsByCategory}
            onChange={() => handleToggleAddonSetting("groupAddonsByCategory")}
            label="Group by Category"
            description="Organize add-ons by category (Transport, Wellness, etc.)"
          />
        </div>
      </div>

      {isEditorOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <form
            onSubmit={handleSubmit}
            className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-[15px] font-semibold text-gray-900">
                  {editingAddon ? "Edit Add-on" : "Create Add-on"}
                </h3>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                className="text-[12px] font-medium text-gray-500 hover:text-gray-900"
              >
                Cancel
              </button>
            </div>

            {itemError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                {itemError}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="sm:col-span-2 text-[12px] font-medium text-gray-700">
                Name
                <input
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                  placeholder="Airport transfer"
                />
              </label>
              <label className="sm:col-span-2 text-[12px] font-medium text-gray-700">
                Description
                <textarea
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                  rows={3}
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Price
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.price}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, price: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Currency
                <input
                  value={draft.currency}
                  maxLength={3}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, currency: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] uppercase text-gray-900 outline-none focus:border-gray-900"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Category
                <select
                  value={draft.category}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      category: event.target.value as AddonItemCategory,
                    }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                >
                  {CATEGORY_OPTIONS.map((category) => (
                    <option key={category} value={category}>
                      {category.charAt(0).toUpperCase() + category.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Duration
                <input
                  value={draft.duration}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, duration: event.target.value }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                  placeholder="45 min"
                />
              </label>
              <label className="text-[12px] font-medium text-gray-700">
                Ownership
                <select
                  value={draft.ownershipKind}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      ownershipKind: event.target.value as "property" | "partner",
                      partnerCommissionRate:
                        event.target.value === "property" ? "" : current.partnerCommissionRate,
                    }))
                  }
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                >
                  <option value="property">Own</option>
                  <option value="partner">Partner</option>
                </select>
              </label>
              {draft.ownershipKind === "partner" && (
                <label className="text-[12px] font-medium text-gray-700">
                  Partner commission (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.0001"
                    required
                    value={draft.partnerCommissionRate}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        partnerCommissionRate: event.target.value,
                      }))
                    }
                    className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                  />
                </label>
              )}
              <label className="sm:col-span-2 text-[12px] font-medium text-gray-700">
                Image
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setDraft((current) => ({ ...current, imageFile: file }));
                  }}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[13px] text-gray-900 outline-none focus:border-gray-900"
                />
                {(draft.imageFile || draft.image) && (
                  <span className="mt-1 flex items-center justify-between text-[11px] font-normal text-gray-500">
                    {draft.imageFile?.name ?? "Current uploaded image"}
                    <button
                      type="button"
                      className="text-red-600 hover:text-red-700"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          image: "",
                          imageMediaObjectId: null,
                          imageFile: null,
                        }))
                      }
                    >
                      Remove
                    </button>
                  </span>
                )}
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-[12px] text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.perPerson}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, perPerson: event.target.checked }))
                  }
                />
                Per person
              </label>
              <label className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-[12px] text-gray-700">
                <input
                  type="checkbox"
                  checked={draft.perNight}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, perNight: event.target.checked }))
                  }
                />
                Per night
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeEditor}
                className="px-3 py-2 text-[12px] font-medium text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingItem}
                className="rounded-lg bg-gray-900 px-3 py-2 text-[12px] font-medium text-white hover:bg-gray-800 disabled:opacity-50"
              >
                {savingItem ? "Saving..." : editingAddon ? "Save Changes" : "Create Add-on"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
