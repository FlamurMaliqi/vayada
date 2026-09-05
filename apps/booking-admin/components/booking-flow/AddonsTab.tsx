"use client";

import { useState, type DragEvent } from "react";
import {
  AddonEditor,
  emptyAddonValues,
  type AddonEditorValues,
} from "@vayada/product-onboarding/AddonEditor";
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

export type AddonItemFormValues = AddonEditorValues;

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

function toDraft(addon: AddonItem, currency: string): AddonItemFormValues {
  return {
    ...emptyAddonValues(currency),
    ...addon,
    currency,
    price: addon.price.toFixed(2),
    category: addon.category as AddonEditorValues["category"],
    duration: addon.duration ?? "",
    location: addon.location ?? "",
    maxGuests: addon.maxGuests ?? "",
    leadTime: addon.leadTime ?? "",
    maxQuantity: String(addon.maxQuantity ?? 1),
    perPerson: addon.perPerson === true,
    perNight: addon.perNight === true,
    partnerCommissionRate: addon.partnerCommissionRate ?? "",
    photos:
      addon.photos ??
      (addon.image
        ? [
            {
              imageUrl: addon.image,
              mediaObjectId: addon.imageMediaObjectId ?? null,
              isCover: true,
            },
          ]
        : []),
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
  const [draft, setDraft] = useState<AddonItemFormValues>(() => emptyAddonValues(propertyCurrency));
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
    setDraft(emptyAddonValues(propertyCurrency));
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

  const handleSave = async (values: AddonItemFormValues) => {
    setSavingItem(true);
    try {
      if (editingAddon) await onUpdateAddon(editingAddon.id, values);
      else await onCreateAddon(values);
      setIsEditorOpen(false);
      setEditingAddon(null);
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
        <AddonEditor
          initialValues={draft}
          currency={propertyCurrency}
          editing={Boolean(editingAddon)}
          onSave={handleSave}
          onCancel={closeEditor}
        />
      )}
    </div>
  );
}
