"use client";

import { MinusIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { formatCurrency } from "@/lib/formatCurrency";
import { BookingAddon } from "@/services/bookings";
import { useTranslation } from "@/lib/i18n";

export type AddOnQuantities = Record<string, number>;

interface AddOnListPickerProps {
  addons: BookingAddon[];
  selectedIds: string[];
  quantities: AddOnQuantities;
  currency: string;
  nights: number;
  adults: number;
  onChange: (selectedIds: string[], quantities: AddOnQuantities) => void;
  onDone?: () => void;
}

interface SelectedAddOnSummaryProps {
  addons: BookingAddon[];
  selectedIds: string[];
  quantities: AddOnQuantities;
  currency: string;
  nights: number;
  adults: number;
  onRemove: (addonId: string) => void;
}

export function addOnUnitLabel(addon: BookingAddon): string {
  if (addon.perPerson && addon.perNight) return "guest/night";
  if (addon.perPerson) return "guest";
  if (addon.perNight) return "night";
  return "stay";
}

export function calculateAddOnLineTotal(
  addon: BookingAddon,
  quantity: number,
  nights: number,
  adults: number,
): number {
  const qty = Math.max(1, Number(quantity) || 1);
  if (addon.perPerson && addon.perNight) {
    return addon.price * Math.min(qty, Math.max(1, adults)) * Math.max(1, nights);
  }
  if (addon.perPerson) {
    return addon.price * Math.min(qty, Math.max(1, adults));
  }
  if (addon.perNight) {
    return addon.price * Math.min(qty, Math.max(1, nights));
  }
  return addon.price * qty;
}

export function clampAddOnQuantity(
  addon: BookingAddon,
  quantity: number,
  nights: number,
  adults: number,
): number {
  const max =
    addon.perNight && !addon.perPerson
      ? Math.max(1, nights)
      : addon.perPerson
        ? Math.max(1, adults)
        : 99;
  return Math.max(1, Math.min(max, Number(quantity) || 1));
}

export function calculateAddOnsTotal(
  addons: BookingAddon[],
  selectedIds: string[],
  quantities: AddOnQuantities,
  nights: number,
  adults: number,
): number {
  const addonMap = new Map(addons.map((addon) => [addon.id, addon]));
  return selectedIds.reduce((sum, addonId) => {
    const addon = addonMap.get(addonId);
    if (!addon) return sum;
    return sum + calculateAddOnLineTotal(addon, quantities[addonId] || 1, nights, adults);
  }, 0);
}

function nextQuantity(
  addon: BookingAddon,
  current: number,
  delta: number,
  nights: number,
  adults: number,
) {
  return clampAddOnQuantity(addon, current + delta, nights, adults);
}

export function AddOnListPicker({
  addons,
  selectedIds,
  quantities,
  currency,
  nights,
  adults,
  onChange,
  onDone,
}: AddOnListPickerProps) {
  const { t } = useTranslation();
  const selectedSet = new Set(selectedIds);

  const setQuantity = (addon: BookingAddon, quantity: number) => {
    const safeQuantity = nextQuantity(addon, 0, quantity, nights, adults);
    const nextSelected = selectedSet.has(addon.id) ? selectedIds : [...selectedIds, addon.id];
    onChange(nextSelected, { ...quantities, [addon.id]: safeQuantity });
  };

  const remove = (addonId: string) => {
    const nextQuantities = { ...quantities };
    delete nextQuantities[addonId];
    onChange(
      selectedIds.filter((id) => id !== addonId),
      nextQuantities,
    );
  };

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      <div className="max-h-72 overflow-auto divide-y divide-gray-100">
        {addons.map((addon) => {
          const selected = selectedSet.has(addon.id);
          const quantity = quantities[addon.id] || 1;
          const label = addOnUnitLabel(addon);
          const lineTotal = calculateAddOnLineTotal(addon, quantity, nights, adults);
          return (
            <div key={addon.id} className="flex items-center gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{addon.name}</p>
                <p className="text-xs text-gray-500">
                  {formatCurrency(addon.price, addon.currency || currency)}/{label}
                </p>
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
                <button
                  type="button"
                  onClick={() => (selected ? setQuantity(addon, quantity - 1) : undefined)}
                  disabled={!selected || quantity <= 1}
                  aria-label={`Decrease ${addon.name}`}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-600 hover:bg-white disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <MinusIcon className="h-4 w-4" />
                </button>
                <span className="w-7 text-center text-sm font-semibold text-gray-900 tabular-nums">
                  {selected ? quantity : 0}
                </span>
                <button
                  type="button"
                  onClick={() => setQuantity(addon, selected ? quantity + 1 : 1)}
                  aria-label={`Increase ${addon.name}`}
                  className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-600 hover:bg-white"
                >
                  <PlusIcon className="h-4 w-4" />
                </button>
              </div>
              <div className="w-20 text-right text-sm font-medium text-gray-900">
                {selected ? formatCurrency(lineTotal, currency) : "—"}
              </div>
            </div>
          );
        })}
      </div>
      {onDone && (
        <div className="flex justify-end border-t border-gray-100 bg-gray-50 px-3 py-2">
          <button
            type="button"
            onClick={onDone}
            className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg"
          >
            {t("common.done")}
          </button>
        </div>
      )}
    </div>
  );
}

export function SelectedAddOnSummary({
  addons,
  selectedIds,
  quantities,
  currency,
  nights,
  adults,
  onRemove,
}: SelectedAddOnSummaryProps) {
  const addonMap = new Map(addons.map((addon) => [addon.id, addon]));
  const selected = selectedIds
    .map((id) => addonMap.get(id))
    .filter((addon): addon is BookingAddon => Boolean(addon));

  if (selected.length === 0) return null;

  return (
    <div className="mt-3 space-y-1.5">
      {selected.map((addon) => {
        const quantity = quantities[addon.id] || 1;
        const lineTotal = calculateAddOnLineTotal(addon, quantity, nights, adults);
        return (
          <div
            key={addon.id}
            className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-900 truncate">{addon.name}</p>
              <p className="text-xs text-gray-500">
                {quantity} × {addOnUnitLabel(addon)}
              </p>
            </div>
            <span className="font-medium text-gray-900">{formatCurrency(lineTotal, currency)}</span>
            <button
              type="button"
              onClick={() => onRemove(addon.id)}
              aria-label={`Remove ${addon.name}`}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
