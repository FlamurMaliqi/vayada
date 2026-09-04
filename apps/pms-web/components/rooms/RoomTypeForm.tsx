"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { XMarkIcon, PlusIcon, CheckIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { paymentMethodLabel } from "@vayada/locale-constants";
import {
  RoomTypeCreate,
  RoomTypeUpdate,
  MealPlan,
  MealPlanCode,
  PartialRefundTier,
  RateDepositSetting,
  RoomSeason,
  type PropertyPlan,
} from "@/services/rooms";
import ImageUpload from "@/components/ImageUpload";
import { pmsRoomMediaResource } from "@/services/upload";
import {
  getCurrencySymbol,
  CURRENCY_SYMBOLS,
  formatCurrency,
  formatCompactPrice,
} from "@/lib/utils";
import { parseBookingAmenities } from "@/lib/parseBookingAmenities";
import { SELECTED_PMS_PROPERTY_ID_KEY } from "@/lib/utils/pmsPropertySelectionKeys";

const BED_TYPES = [
  "King Bed",
  "Queen Bed",
  "Double Bed",
  "Twin Bed",
  "Single Bed",
  "Bunk Bed",
  "Sofa Bed",
];

const ROOM_CATEGORIES = [
  "Standard",
  "Deluxe",
  "Superior",
  "Suite",
  "Villa",
  "Bungalow",
  "Studio",
  "Penthouse",
];

const FEATURE_CATEGORIES = [
  {
    name: "VIEWS & LOCATION",
    items: [
      { label: "Sea view", emoji: "\uD83C\uDF0A" },
      { label: "Ocean view", emoji: "\uD83C\uDF05" },
      { label: "Mountain view", emoji: "\u26F0\uFE0F" },
      { label: "Garden view", emoji: "\uD83C\uDF3F" },
      { label: "Pool view", emoji: "\uD83C\uDFCA" },
      { label: "Beachfront", emoji: "\uD83C\uDFD6\uFE0F" },
      { label: "Forest view", emoji: "\uD83C\uDF32" },
      { label: "City view", emoji: "\uD83C\uDFD9\uFE0F" },
      { label: "Lake view", emoji: "\uD83C\uDFDE\uFE0F" },
      { label: "River view", emoji: "\uD83C\uDFDE\uFE0F" },
    ],
  },
  {
    name: "OUTDOOR & RECREATION",
    items: [
      { label: "Private Pool", emoji: "\uD83C\uDFCA" },
      { label: "Shared Pool", emoji: "\uD83C\uDFCA" },
      { label: "Hot tub", emoji: "\uD83D\uDEC1" },
      { label: "BBQ", emoji: "\uD83D\uDD25" },
      { label: "Outdoor dining area", emoji: "\uD83C\uDF7D\uFE0F" },
      { label: "Private terrace", emoji: "\uD83C\uDF05" },
      { label: "Balcony", emoji: "\uD83C\uDFE0" },
      { label: "Garden", emoji: "\uD83C\uDF3F" },
      { label: "Rooftop access", emoji: "\uD83C\uDFD9\uFE0F" },
    ],
  },
  {
    name: "SPACE & TYPE",
    items: [
      { label: "Entire villa", emoji: "\uD83C\uDFE1" },
      { label: "Entire apartment", emoji: "\uD83C\uDFE2" },
      { label: "Private entrance", emoji: "\uD83D\uDEAA" },
      { label: "Penthouse", emoji: "\uD83C\uDFD9\uFE0F" },
      { label: "Duplex", emoji: "\uD83C\uDFE0" },
      { label: "Studio", emoji: "\uD83D\uDECB\uFE0F" },
    ],
  },
];

const AMENITY_CATEGORIES = [
  {
    name: "Internet & Tech",
    items: [
      "Free WiFi",
      "Flat-screen TV",
      "Smart TV",
      "Netflix / Streaming",
      "Work desk",
      "Laptop-friendly workspace",
    ],
  },
  {
    name: "Kitchen",
    items: [
      "Minibar",
      "Refrigerator",
      "Microwave",
      "Kitchenware",
      "Electric kettle",
      "Stovetop",
      "Dining table",
    ],
  },
  {
    name: "Bathroom",
    items: [
      "Private Bathroom",
      "Bathtub",
      "Shower",
      "Free toiletries",
      "Hairdryer",
      "Toilet",
      "Toilet paper",
      "Hot Tub",
      "Towels",
      "Slippers",
      "Bathrobe",
    ],
  },
  {
    name: "Climate & Comfort",
    items: ["Air conditioning", "Heating", "Fan", "Fireplace"],
  },
  {
    name: "Bedroom",
    items: ["Extra pillows", "Blackout curtains", "Wardrobe", "Bed linen"],
  },
  {
    name: "Laundry",
    items: ["Washing machine", "Dryer", "Iron/Ironing board", "Clothes rack"],
  },
  {
    name: "Safety & Access",
    items: ["Safe", "24hr Security", "Smoke detector", "First aid kit", "Fire extinguisher"],
  },
  {
    name: "Services",
    items: [
      "Room service",
      "Daily housekeeping",
      "Concierge",
      "Parking",
      "Non-smoking",
      "Adults-Only",
    ],
  },
];

// Clamp a raw string from a number input to [min, max], treating empty/NaN as min.
// Used by inputs that allow a transient empty display string while typing.
const clampNumberInput = (raw: string, min: number, max?: number): number => {
  let n = Number(raw);
  if (!Number.isFinite(n) || raw === "") n = min;
  if (n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
};

type RoomTab = "details" | "pricing" | "media";
const ROOM_TABS: { key: RoomTab; label: string }[] = [
  { key: "details", label: "Room Details" },
  { key: "pricing", label: "Pricing & Rates" },
  { key: "media", label: "Images & Amenities" },
];

const SELECT_ARROW_STYLE = {
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat" as const,
  backgroundPosition: "right 12px center",
};

interface RoomTypeFormProps {
  form: RoomTypeCreate | RoomTypeUpdate;
  onChange: (form: any) => void;
  onSubmit: (e: React.FormEvent) => void;
  saving: boolean;
  error?: string;
  success?: string;
  submitLabel?: string;
  cancelHref?: string;
  cancelLabel?: string;
  onCancel?: () => void;
  // 'create' seeds how many physical rooms get auto-created. 'edit' lets
  // the user nudge the count up or down: the backend reconciles the
  // generated room units to match (VAY-406). The DB trigger keeps
  // total_rooms truthful so the VAY-402 oversell invariant still holds.
  mode?: "create" | "edit";
  roomTypeId?: string;
  propertyPlan: PropertyPlan | null;
}

function bedsToSummary(beds: { type: string; count: number }[]): string {
  return beds.map((b) => `${b.count} ${b.type}`).join(", ");
}

function parseBedType(bedType: string): { type: string; count: number }[] {
  if (!bedType || !bedType.trim()) return [{ type: "King Bed", count: 1 }];
  const parts = bedType
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((part) => {
    const match = part.match(/^(\d+)\s+(.+)$/);
    if (match) return { type: match[2], count: parseInt(match[1]) };
    return { type: part, count: 1 };
  });
}

// Sort seasons by start date (MM-DD). Empty `from` values keep their relative order at the end
// so a newly added (blank) season stays at the bottom until the user picks a date.
function sortSeasonsChronologically<T extends { from: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    if (!a.from && !b.from) return 0;
    if (!a.from) return 1;
    if (!b.from) return -1;
    return a.from.localeCompare(b.from);
  });
}

const LOW_PRICE_WARNING_RATIO = 0.5;
const HIGH_PRICE_WARNING_RATIO = 3;

type PriceWarningKind = "low" | "high";
type PriceWarningField = "season" | "daily";
type PriceWarning = {
  id: string;
  field: PriceWarningField;
  kind: PriceWarningKind;
  label: string;
  value: number;
  baseline: number;
  suggestedValue?: number;
  signature: string;
};

const parsePositivePrice = (value: string | number | undefined | null): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
};

const getPriceWarning = ({
  id,
  field,
  label,
  value,
  baseline,
}: {
  id: string;
  field: PriceWarningField;
  label: string;
  value: number;
  baseline: number;
}): PriceWarning | null => {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || value <= 0 || baseline <= 0)
    return null;
  const ratio = value / baseline;
  const roundedBaseline = Math.round(baseline);
  if (ratio < LOW_PRICE_WARNING_RATIO) {
    const timesTen = value * 10;
    const suggestedValue =
      timesTen >= baseline * LOW_PRICE_WARNING_RATIO &&
      timesTen <= baseline * HIGH_PRICE_WARNING_RATIO
        ? timesTen
        : roundedBaseline;
    return {
      id,
      field,
      kind: "low",
      label,
      value,
      baseline: roundedBaseline,
      suggestedValue: Math.round(suggestedValue),
      signature: `${id}:low:${Math.round(value)}:${roundedBaseline}`,
    };
  }
  if (ratio > HIGH_PRICE_WARNING_RATIO) {
    return {
      id,
      field,
      kind: "high",
      label,
      value,
      baseline: roundedBaseline,
      signature: `${id}:high:${Math.round(value)}:${roundedBaseline}`,
    };
  }
  return null;
};

function PriceWarningMessage({
  warning,
  currency,
  onDismiss,
}: {
  warning: PriceWarning;
  currency: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] leading-snug text-amber-800">
      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-200 text-[10px] font-bold text-amber-800">
        !
      </span>
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{warning.label}: </span>
        {warning.kind === "low" ? (
          <>
            This price is much lower than your other rates (
            {formatCurrency(warning.baseline, currency)} usual rate). Did you mean to enter{" "}
            {formatCurrency(warning.suggestedValue ?? warning.baseline, currency)}?
          </>
        ) : (
          <>
            This price is much higher than your other rates (
            {formatCurrency(warning.baseline, currency)} usual rate). Are you sure?
          </>
        )}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-amber-700 hover:bg-amber-100 hover:text-amber-900"
        aria-label={`Dismiss ${warning.label} price warning`}
      >
        <XMarkIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function PartialRefundTiersEditor({
  tiers,
  onChange,
}: {
  tiers: PartialRefundTier[];
  onChange: (next: PartialRefundTier[]) => void;
}) {
  const sorted = [...tiers].sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn);
  const usedDays = new Set(sorted.map((t) => t.minDaysBeforeCheckIn));

  const updateTier = (idx: number, patch: Partial<PartialRefundTier>) => {
    const next = sorted.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    next.sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn);
    onChange(next);
  };

  const removeTier = (idx: number) => {
    onChange(sorted.filter((_, i) => i !== idx));
  };

  const addTier = () => {
    if (sorted.length >= 10) return;
    const lowest = sorted.length > 0 ? sorted[sorted.length - 1].minDaysBeforeCheckIn : 30;
    let candidate = Math.max(0, lowest - 7);
    while (usedDays.has(candidate) && candidate > 0) candidate -= 1;
    if (usedDays.has(candidate)) {
      candidate = 0;
      while (usedDays.has(candidate) && candidate < 365) candidate += 1;
    }
    onChange(
      [...sorted, { minDaysBeforeCheckIn: candidate, refundPercent: 0 }].sort(
        (a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn,
      ),
    );
  };

  const hasDuplicateDays =
    sorted.length !== new Set(sorted.map((t) => t.minDaysBeforeCheckIn)).size;

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
        Refund schedule
      </div>
      <div className="text-[11px] text-gray-500 leading-relaxed">
        Set how much guests get refunded based on how many days before check-in they cancel. The
        highest matching threshold is applied; cancellations below the lowest threshold are
        non-refundable.
      </div>
      <div className="space-y-1.5">
        {sorted.map((tier, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 rounded-lg bg-white border border-gray-200 px-2.5 py-1.5"
          >
            <span className="text-[11px] text-gray-500 shrink-0">Cancel ≥</span>
            <div className="inline-flex items-center gap-0 border border-gray-200 rounded-md overflow-hidden">
              <button
                type="button"
                onClick={() =>
                  updateTier(idx, {
                    minDaysBeforeCheckIn: Math.max(0, tier.minDaysBeforeCheckIn - 1),
                  })
                }
                className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
              >
                &minus;
              </button>
              <input
                type="number"
                min={0}
                max={365}
                value={tier.minDaysBeforeCheckIn}
                onChange={(e) =>
                  updateTier(idx, {
                    minDaysBeforeCheckIn: Math.max(0, Math.min(365, parseInt(e.target.value) || 0)),
                  })
                }
                className="w-[44px] px-1 py-1 text-[12px] font-semibold text-gray-900 text-center bg-white outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() =>
                  updateTier(idx, {
                    minDaysBeforeCheckIn: Math.min(365, tier.minDaysBeforeCheckIn + 1),
                  })
                }
                className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
              >
                +
              </button>
            </div>
            <span className="text-[11px] text-gray-500 shrink-0">days before → refund</span>
            <div className="inline-flex items-center gap-0 border border-gray-200 rounded-md overflow-hidden">
              <button
                type="button"
                onClick={() =>
                  updateTier(idx, { refundPercent: Math.max(0, tier.refundPercent - 5) })
                }
                className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
              >
                &minus;
              </button>
              <input
                type="number"
                min={0}
                max={100}
                value={tier.refundPercent}
                onChange={(e) =>
                  updateTier(idx, {
                    refundPercent: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)),
                  })
                }
                className="w-[44px] px-1 py-1 text-[12px] font-semibold text-gray-900 text-center bg-white outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <button
                type="button"
                onClick={() =>
                  updateTier(idx, { refundPercent: Math.min(100, tier.refundPercent + 5) })
                }
                className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
              >
                +
              </button>
            </div>
            <span className="text-[11px] text-gray-500 shrink-0">%</span>
            <button
              type="button"
              onClick={() => removeTier(idx)}
              className="ml-auto p-1 text-gray-400 hover:text-red-500 transition-colors"
              aria-label="Remove tier"
            >
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {sorted.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            Partial refund requires at least one tier. Add a tier before saving.
          </div>
        )}
      </div>
      {hasDuplicateDays && (
        <div className="text-[11px] text-amber-600">
          Two tiers share the same days-before threshold; please change one of them.
        </div>
      )}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={addTier}
          disabled={sorted.length >= 10}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary-600 hover:text-primary-700 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          <PlusIcon className="w-3.5 h-3.5" />
          Add tier
        </button>
        {sorted.length >= 10 && <span className="text-[10px] text-gray-400">Max 10 tiers</span>}
      </div>
      {sorted.length > 0 && (
        <div className="rounded-lg bg-primary-50/60 border border-primary-100 px-3 py-2 text-[11px] text-primary-700 leading-relaxed space-y-0.5">
          <div className="font-semibold">Policy preview</div>
          {sorted.map((t, i) => (
            <div key={i}>
              {i === 0
                ? `≥ ${t.minDaysBeforeCheckIn} days before check-in: ${t.refundPercent}% refund`
                : `${sorted[i - 1].minDaysBeforeCheckIn - 1}–${t.minDaysBeforeCheckIn} days: ${t.refundPercent}% refund`}
            </div>
          ))}
          {sorted[sorted.length - 1].minDaysBeforeCheckIn > 0 && (
            <div>{`< ${sorted[sorted.length - 1].minDaysBeforeCheckIn} days: non-refundable`}</div>
          )}
        </div>
      )}
    </div>
  );
}

const PAYMENT_METHODS: { key: string; label: string; hint: string }[] = [
  {
    key: "card",
    label: "Card (online)",
    hint: "Stripe — authorized at booking, captured on host approval",
  },
  {
    key: "pay_at_property",
    label: paymentMethodLabel("pay_at_property"),
    hint: "Guest pays on arrival — cash or terminal",
  },
  {
    key: "bank_transfer",
    label: paymentMethodLabel("bank_transfer"),
    hint: "Guest wires to your account before arrival",
  },
  { key: "xendit", label: "QRIS / e-wallet (Xendit)", hint: "Indonesian local payment rails" },
];

function RatePaymentMethodsSection({
  value,
  flexibleRateEnabled,
  nonRefundableEnabled,
  onChange,
}: {
  value: Record<string, string[]> | null;
  flexibleRateEnabled: boolean;
  nonRefundableEnabled: boolean;
  onChange: (next: Record<string, string[]> | null) => void;
}) {
  const rates: { key: string; label: string; shown: boolean }[] = [
    { key: "flexible", label: "Flexible rate", shown: flexibleRateEnabled },
    { key: "nonrefundable", label: "Non-refundable rate", shown: nonRefundableEnabled },
  ];

  const toggle = (rateKey: string, methodKey: string) => {
    const current = value ?? {};
    const currentList = current[rateKey] ?? [];
    const nextList = currentList.includes(methodKey)
      ? currentList.filter((m) => m !== methodKey)
      : [...currentList, methodKey];
    const next = { ...current, [rateKey]: nextList };
    onChange(next);
  };

  const clearAll = () => onChange(null);

  return (
    <div>
      <div className="flex items-start gap-3 mb-2">
        <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
          8
        </span>
        <div className="flex-1">
          <h3 className="text-[13px] font-semibold text-gray-900">
            Allowed payment methods per rate
          </h3>
          <p className="text-[11px] text-gray-400">
            Leave empty to accept every method the hotel has enabled. Ticking any method turns this
            rate into an explicit allow-list.
          </p>
        </div>
        {value !== null && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] text-gray-500 hover:text-gray-700 underline"
          >
            Reset to hotel defaults
          </button>
        )}
      </div>
      <div className="ml-4 md:ml-9 space-y-3">
        {rates
          .filter((r) => r.shown)
          .map((rate) => {
            const selected = (value ?? {})[rate.key] ?? [];
            return (
              <div key={rate.key} className="rounded-xl border border-gray-200 bg-white p-3">
                <div className="text-[12px] font-semibold text-gray-900 mb-2">{rate.label}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PAYMENT_METHODS.map((m) => {
                    const checked = selected.includes(m.key);
                    return (
                      <label
                        key={m.key}
                        className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-[11px] cursor-pointer transition-colors ${
                          checked
                            ? "border-primary-300 bg-primary-50/50"
                            : "border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(rate.key, m.key)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium text-gray-900 block">{m.label}</span>
                          <span className="text-gray-500">{m.hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        {!flexibleRateEnabled && !nonRefundableEnabled && (
          <p className="text-[11px] text-gray-400">
            Enable at least one rate type above to configure payment methods.
          </p>
        )}
      </div>
    </div>
  );
}

function RateDepositSection({
  value,
  flexibleRateEnabled,
  nonRefundableEnabled,
  baseRate,
  currency,
  onChange,
}: {
  value: Record<string, RateDepositSetting> | null;
  flexibleRateEnabled: boolean;
  nonRefundableEnabled: boolean;
  baseRate: number;
  currency: string;
  onChange: (next: Record<string, RateDepositSetting> | null) => void;
}) {
  const rates: { key: string; label: string; shown: boolean }[] = [
    { key: "flexible", label: "Flexible rate", shown: flexibleRateEnabled },
    { key: "nonrefundable", label: "Non-refundable rate", shown: nonRefundableEnabled },
  ];

  const updateRate = (rateKey: string, patch: Partial<RateDepositSetting>) => {
    const current = value ?? {};
    const previous = current[rateKey] ?? { enabled: false, percentage: null };
    const nextRate = { ...previous, ...patch };
    if (nextRate.enabled && !nextRate.percentage) nextRate.percentage = 50;
    const next = { ...current, [rateKey]: nextRate };
    onChange(next);
  };

  return (
    <div>
      <div className="flex items-start gap-3 mb-2">
        <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
          7
        </span>
        <div className="flex-1">
          <h3 className="text-[13px] font-semibold text-gray-900">Deposit at booking</h3>
          <p className="text-[11px] text-gray-400">
            Collect a percentage now; the remaining balance is due at the property on arrival.
          </p>
        </div>
      </div>
      <div className="ml-4 md:ml-9 space-y-3">
        {rates
          .filter((r) => r.shown)
          .map((rate) => {
            const setting = value?.[rate.key] ?? { enabled: false, percentage: null };
            const percentage = setting.percentage ?? 50;
            const deposit = Math.round((baseRate || 0) * percentage) / 100;
            const balance = Math.max((baseRate || 0) - deposit, 0);
            return (
              <div
                key={rate.key}
                className={`rounded-xl border p-4 ${setting.enabled ? "border-primary-200 bg-primary-50/30" : "border-gray-200 bg-white"}`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => updateRate(rate.key, { enabled: !setting.enabled })}
                    className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${setting.enabled ? "bg-primary-500" : "bg-gray-300"}`}
                    aria-label={`Toggle deposit for ${rate.label}`}
                  >
                    <span
                      className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${setting.enabled ? "left-[20px]" : "left-[2px]"}`}
                    />
                  </button>
                  <div className="min-w-[150px] flex-1">
                    <div className="text-[12px] font-semibold text-gray-900">{rate.label}</div>
                    <div className="text-[11px] text-gray-500">
                      {setting.enabled && percentage === 100
                        ? "Full payment at booking"
                        : setting.enabled
                          ? "Deposit required"
                          : "No deposit"}
                    </div>
                  </div>
                  {setting.enabled && (
                    <div className="inline-flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={percentage}
                        onChange={(e) =>
                          updateRate(rate.key, {
                            percentage: clampNumberInput(e.target.value, 1, 100),
                          })
                        }
                        className="w-14 px-1 text-[12px] font-semibold text-gray-900 bg-transparent outline-none text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="text-[12px] font-semibold text-gray-900">%</span>
                    </div>
                  )}
                </div>
                {setting.enabled && (
                  <p className="mt-3 text-[11px] text-gray-500">
                    Guest pays {percentage}% ({formatCurrency(deposit, currency)}) at booking,{" "}
                    {formatCurrency(balance, currency)} due at arrival.
                  </p>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

export default function RoomTypeForm({
  form,
  onChange,
  onSubmit,
  saving,
  error,
  success,
  submitLabel = "Save",
  cancelHref = "/rooms",
  cancelLabel = "Cancel",
  onCancel,
  mode = "create",
  roomTypeId,
  propertyPlan,
}: RoomTypeFormProps) {
  type EditableRoomSeason = Omit<RoomSeason, "maxStay"> & { maxStay?: number | null };
  const formRef = useRef<HTMLFormElement | null>(null);
  const skipPriceWarningConfirmRef = useRef(false);
  const previousCurrencyRef = useRef(form.currency || "EUR");
  const [activeTab, setActiveTab] = useState<RoomTab>("details");
  const [sortOrderInput, setSortOrderInput] = useState<string>(String(form.sortOrder ?? 0));
  const [latitudeInput, setLatitudeInput] = useState<string>(
    form.latitude != null ? String(form.latitude) : "",
  );
  const [longitudeInput, setLongitudeInput] = useState<string>(
    form.longitude != null ? String(form.longitude) : "",
  );
  const [amenityInput, setAmenityInput] = useState("");
  const [featureInput, setFeatureInput] = useState("");
  const [expandedAmenityCategories, setExpandedAmenityCategories] = useState<string[]>([
    "Internet & Tech",
  ]);
  const [customAmenityInputs, setCustomAmenityInputs] = useState<Record<string, string>>({});
  const [customAmenitiesByCategory, setCustomAmenitiesByCategory] = useState<
    Record<string, string[]>
  >({});
  const [bookingImportOpen, setBookingImportOpen] = useState(false);
  const [bookingImportText, setBookingImportText] = useState("");
  const [bookingImportResult, setBookingImportResult] = useState<{
    matchedCount: number;
    addedCount: number;
    fuzzy: { original: string; amenity: string }[];
    unmatched: string[];
  } | null>(null);
  const [beds, setBeds] = useState<{ type: string; count: number }[]>(() =>
    parseBedType(form.bedType || ""),
  );
  const [operatingPeriods, setOperatingPeriods] = useState<{ from: string; to: string }[]>(
    form.operatingPeriods?.length
      ? form.operatingPeriods.map((p: { from: string; to: string }) => ({
          from: p.from && p.from.length > 5 ? p.from.slice(5) : p.from,
          to: p.to && p.to.length > 5 ? p.to.slice(5) : p.to,
        }))
      : [{ from: "01-01", to: "12-31" }],
  );
  const [seasons, setSeasons] = useState<EditableRoomSeason[]>(
    sortSeasonsChronologically(
      (form.seasons || []).map((s) => {
        const rawMaxStay = s.maxStay ?? (s as { max_stay?: number | string | null }).max_stay;
        const numericMaxStay = Number(rawMaxStay);
        const maxStay =
          rawMaxStay === undefined ||
          rawMaxStay === null ||
          rawMaxStay === "" ||
          !Number.isFinite(numericMaxStay) ||
          numericMaxStay <= 0
            ? null
            : Math.floor(numericMaxStay);
        return {
          ...s,
          from: s.from && s.from.length > 5 ? s.from.slice(5) : s.from,
          to: s.to && s.to.length > 5 ? s.to.slice(5) : s.to,
          maxStay,
          occupancyRates: s.occupancyRates || {},
        };
      }),
    ),
  );
  const [previewMonth, setPreviewMonth] = useState(() => new Date());
  const [weekendSurcharge, setWeekendSurcharge] = useState(form.weekendSurcharge || "+0%");
  const [cancellationPolicy, setCancellationPolicy] = useState(
    form.cancellationPolicy || "Free until 7 days before",
  );
  const [flexibleRateEnabled, setFlexibleRateEnabled] = useState(form.flexibleRateEnabled ?? true);
  const [flexibleCancellationType, setFlexibleCancellationType] = useState<
    "free" | "partial_refund"
  >(form.flexibleCancellationType ?? "free");
  const [partialRefundCancelWindowDays, setPartialRefundCancelWindowDays] = useState(
    form.partialRefundCancelWindowDays ?? 30,
  );
  const [partialRefundAmountPercent, setPartialRefundAmountPercent] = useState(
    form.partialRefundAmountPercent ?? 50,
  );
  // Tiered partial-refund schedule (VAY-324). When non-empty this overrides
  // the legacy single-tier (window/percent) pair on the server. We seed from
  // the legacy values for rooms saved before the migration so the editor
  // shows their current behavior as a one-tier list rather than empty state.
  const [partialRefundTiers, setPartialRefundTiers] = useState<PartialRefundTier[]>(() => {
    const initial = form.partialRefundTiers;
    if (initial && initial.length > 0)
      return [...initial].sort((a, b) => b.minDaysBeforeCheckIn - a.minDaysBeforeCheckIn);
    return [
      {
        minDaysBeforeCheckIn: form.partialRefundCancelWindowDays ?? 30,
        refundPercent: form.partialRefundAmountPercent ?? 50,
      },
    ];
  });
  const [nonRefundableEnabled, setNonRefundableEnabled] = useState(
    form.nonRefundableEnabled ?? false,
  );
  const [nonRefundableDiscount, setNonRefundableDiscount] = useState(
    form.nonRefundableDiscount ?? 5,
  );
  const [nonRefundableCancellationPolicy, setNonRefundableCancellationPolicy] = useState(
    form.nonRefundableCancellationPolicy || "Non-refundable from booking",
  );
  const [mealPlans, setMealPlans] = useState<MealPlan[]>(
    (form.mealPlans || []).map((m) => ({ ...m, chargePer: m.chargePer ?? "room" })),
  );
  const [expandedOccupancy, setExpandedOccupancy] = useState<Record<number, boolean>>({});
  const [dailyRates, setDailyRates] = useState<Record<string, number>>(form.dailyRates || {});
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [editingDayValue, setEditingDayValue] = useState("");
  const [touchedPriceWarnings, setTouchedPriceWarnings] = useState<Record<string, boolean>>({});
  const [dismissedPriceWarnings, setDismissedPriceWarnings] = useState<Record<string, string>>({});
  const [confirmUnusualPricesOpen, setConfirmUnusualPricesOpen] = useState(false);
  const benefits: string[] = form.benefits || [];
  const [category, setCategory] = useState(form.category || "");
  const [bedrooms, setBedrooms] = useState(form.bedrooms ?? 1);
  const [bathrooms, setBathrooms] = useState(form.bathrooms ?? 1);
  // Display strings for the number inputs in the room-details grid. Held separately from
  // the committed numeric values so the user can fully clear a field before typing a new
  // number — onChange writes the raw string, onBlur clamps to [min, max] and rewrites it.
  const [maxOccupancyInput, setMaxOccupancyInput] = useState(String(form.maxOccupancy ?? 2));
  const [maxAdultsInput, setMaxAdultsInput] = useState(
    form.maxAdults == null ? "" : String(form.maxAdults),
  );
  const [maxChildrenInput, setMaxChildrenInput] = useState(
    form.maxChildren == null ? "" : String(form.maxChildren),
  );
  const [bedroomsInput, setBedroomsInput] = useState(String(form.bedrooms ?? 1));
  const [bathroomsInput, setBathroomsInput] = useState(String(form.bathrooms ?? 1));
  const [sizeInput, setSizeInput] = useState(String(form.size ?? 1));
  const [totalRoomsInput, setTotalRoomsInput] = useState(String(form.totalRooms ?? 2));

  // Sync beds -> form.bedType
  useEffect(() => {
    const summary = bedsToSummary(beds);
    onChange((prev: any) => (prev.bedType === summary ? prev : { ...prev, bedType: summary }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beds]);

  // Resync sortOrder input when form.sortOrder changes externally (e.g., room loaded from API),
  // but not while the user is mid-edit (input parses to the same value).
  useEffect(() => {
    const parsed = parseInt(sortOrderInput, 10);
    const current = Number.isNaN(parsed) ? 0 : parsed;
    if (current !== (form.sortOrder ?? 0)) {
      setSortOrderInput(String(form.sortOrder ?? 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.sortOrder]);

  // Sync bedrooms/bathrooms -> form
  useEffect(() => {
    onChange((prev: any) =>
      prev.bedrooms === bedrooms && prev.bathrooms === bathrooms
        ? prev
        : { ...prev, bedrooms, bathrooms },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bedrooms, bathrooms]);

  // Keep seasons in chronological order by start date
  useEffect(() => {
    const sorted = sortSeasonsChronologically(seasons);
    if (sorted.some((s, i) => s !== seasons[i])) setSeasons(sorted);
  }, [seasons]);

  // Sync pricing fields -> form
  useEffect(() => {
    onChange((prev: any) => ({
      ...prev,
      operatingPeriods,
      seasons,
      weekendSurcharge,
      cancellationPolicy,
      flexibleRateEnabled,
      flexibleCancellationType,
      partialRefundCancelWindowDays,
      partialRefundAmountPercent,
      partialRefundTiers,
      nonRefundableEnabled,
      nonRefundableDiscount,
      nonRefundableCancellationPolicy,
      mealPlans,
      dailyRates,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    operatingPeriods,
    seasons,
    weekendSurcharge,
    cancellationPolicy,
    flexibleRateEnabled,
    flexibleCancellationType,
    partialRefundCancelWindowDays,
    partialRefundAmountPercent,
    partialRefundTiers,
    nonRefundableEnabled,
    nonRefundableDiscount,
    nonRefundableCancellationPolicy,
    mealPlans,
    dailyRates,
  ]);

  const updateForm = (updates: Partial<RoomTypeCreate>) => {
    const updated = { ...form, ...updates };
    onChange(updated);
  };

  const markPriceWarningTouched = (id: string) => {
    setTouchedPriceWarnings((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
  };

  const dismissPriceWarning = (warning: PriceWarning) => {
    setDismissedPriceWarnings((prev) => ({ ...prev, [warning.id]: warning.signature }));
  };

  useEffect(() => {
    const currency = form.currency || "EUR";
    if (previousCurrencyRef.current === currency) return;
    previousCurrencyRef.current = currency;
    setTouchedPriceWarnings({});
    setDismissedPriceWarnings({});
    setConfirmUnusualPricesOpen(false);
  }, [form.currency]);

  const MEAL_PLAN_OPTIONS: { code: MealPlanCode; label: string }[] = [
    { code: 1, label: "Breakfast included" },
    { code: 3, label: "Half board" },
    { code: 4, label: "Full board" },
    { code: 9, label: "All inclusive" },
  ];
  const MEAL_PLAN_LABEL: Record<MealPlanCode, string> = {
    1: "Breakfast included",
    3: "Half board",
    4: "Full board",
    9: "All inclusive",
  };
  // Standard occupancy used when projecting per-person surcharges in the
  // pricing preview. Keeps the preview footnote ("Calculated for 2 guests")
  // honest; the server multiplies by max_occupancy when actually pushing rates.
  const PREVIEW_GUESTS = 2;
  const addMealPlan = () => {
    const used = new Set(mealPlans.map((m) => m.code));
    const next = MEAL_PLAN_OPTIONS.find((o) => !used.has(o.code))?.code;
    if (next === undefined) return;
    setMealPlans((prev) => [...prev, { code: next, surcharge: 0, chargePer: "room" }]);
  };
  const removeMealPlan = (idx: number) => {
    setMealPlans((prev) => prev.filter((_, i) => i !== idx));
  };
  const updateMealPlan = (idx: number, patch: Partial<MealPlan>) => {
    setMealPlans((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  };
  const projectedSurcharge = (mp: MealPlan): number =>
    mp.chargePer === "person" ? mp.surcharge * PREVIEW_GUESTS : mp.surcharge;

  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const currency = form.currency || "EUR";
  const weekendSurchargePercent = parseInt(weekendSurcharge.replace(/[^0-9]/g, "")) || 0;

  const mmddInRange = (mmdd: string, from: string, to: string): boolean => {
    if (!from || !to) return false;
    if (from > to) return mmdd >= from || mmdd <= to;
    return mmdd >= from && mmdd <= to;
  };

  const getSeasonForMmdd = (mmdd: string) => {
    for (const season of seasons) {
      if (season.from && season.to && mmddInRange(mmdd, season.from, season.to)) return season;
    }
    return null;
  };

  const getUnderlyingRateForDate = (dateStr: string): number | null => {
    const season = getSeasonForMmdd(dateStr.slice(5));
    const baseRate = parsePositivePrice(season?.rate);
    if (baseRate === null) return null;
    const date = new Date(`${dateStr}T00:00:00`);
    const dow = date.getDay();
    const isWeekend = dow === 5 || dow === 6;
    return isWeekend && weekendSurchargePercent > 0
      ? Math.round(baseRate * (1 + weekendSurchargePercent / 100))
      : baseRate;
  };

  const priceWarnings = (() => {
    const warnings: PriceWarning[] = [];
    const configuredSeasonRates = seasons
      .map((season, idx) => ({ idx, season, rate: parsePositivePrice(season.rate) }))
      .filter(({ season, rate }) => {
        const closed = [season.name, season.tier].some(
          (value) => value?.trim().toLowerCase() === "closed",
        );
        return !closed && rate !== null;
      }) as { idx: number; season: (typeof seasons)[number]; rate: number }[];

    for (const { idx, season, rate } of configuredSeasonRates) {
      const comparisonRates = configuredSeasonRates
        .filter((other) => other.idx !== idx)
        .map((other) => other.rate);
      const baseline = median(comparisonRates);
      if (baseline === null) continue;
      const warning = getPriceWarning({
        id: `season:${idx}`,
        field: "season",
        label: season.name || `Season ${idx + 1}`,
        value: rate,
        baseline,
      });
      if (warning) warnings.push(warning);
    }

    for (const [dateStr, value] of Object.entries(dailyRates)) {
      const overrideRate = parsePositivePrice(value);
      const baseline = getUnderlyingRateForDate(dateStr);
      if (overrideRate === null || baseline === null) continue;
      const warning = getPriceWarning({
        id: `daily:${dateStr}`,
        field: "daily",
        label: dateStr,
        value: overrideRate,
        baseline,
      });
      if (warning) warnings.push(warning);
    }

    return warnings;
  })();

  const activePriceWarnings = priceWarnings.filter(
    (warning) => dismissedPriceWarnings[warning.id] !== warning.signature,
  );
  const visiblePriceWarnings = activePriceWarnings.filter(
    (warning) => touchedPriceWarnings[warning.id],
  );
  const visiblePriceWarningById = new Map(
    visiblePriceWarnings.map((warning) => [warning.id, warning]),
  );
  const visibleDailyPriceWarnings = visiblePriceWarnings.filter(
    (warning) => warning.field === "daily",
  );

  const getYearPercent = (mmdd: string): number => {
    if (!mmdd) return 0;
    const [mm, dd] = mmdd.split("-").map(Number);
    if (!mm || !dd) return 0;
    // Day of year out of 366 (leap year for max days)
    let dayOfYear = 0;
    for (let i = 0; i < mm - 1; i++) dayOfYear += DAYS_IN_MONTH[i];
    dayOfYear += dd;
    return (dayOfYear / 366) * 100;
  };

  const overlappingSeasonIndices = (() => {
    const indices = new Set<number>();
    for (let i = 0; i < seasons.length; i++) {
      for (let j = i + 1; j < seasons.length; j++) {
        const a = seasons[i],
          b = seasons[j];
        if (a.from && a.to && b.from && b.to && a.from <= b.to && b.from <= a.to) {
          indices.add(i);
          indices.add(j);
        }
      }
    }
    return indices;
  })();

  // Detect gaps in season coverage — only within configured operating periods.
  // Days outside all operating periods are intentionally closed (per the page
  // copy "Operating periods repeat every year — dates outside are automatically
  // closed.") and must not be flagged as gaps.
  const seasonGaps = (() => {
    const validPeriods = operatingPeriods.filter((p) => p.from && p.to);
    const validSeasons = seasons.filter((s) => s.from && s.to);
    if (validPeriods.length === 0) return [];
    const TOTAL_DAYS = DAYS_IN_MONTH.reduce((a, b) => a + b, 0);
    const mmddToDoy = (mmdd: string) => {
      const [m, d] = mmdd.split("-").map(Number);
      return DAYS_IN_MONTH.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
    };
    const doyToMmdd = (doy: number) => {
      let m = 0;
      let rem = doy;
      while (m < 12 && rem > DAYS_IN_MONTH[m]) {
        rem -= DAYS_IN_MONTH[m];
        m++;
      }
      return `${String(m + 1).padStart(2, "0")}-${String(rem).padStart(2, "0")}`;
    };
    const fillRange = (target: boolean[], from: string, to: string) => {
      const f = mmddToDoy(from);
      const t = mmddToDoy(to);
      if (f <= t) {
        for (let d = f; d <= t; d++) target[d] = true;
      } else {
        // cross-year wrap (e.g. Nov 1 – Feb 28)
        for (let d = f; d <= TOTAL_DAYS; d++) target[d] = true;
        for (let d = 1; d <= t; d++) target[d] = true;
      }
    };
    const open = new Array<boolean>(TOTAL_DAYS + 1).fill(false);
    for (const p of validPeriods) fillRange(open, p.from, p.to);
    const covered = new Array<boolean>(TOTAL_DAYS + 1).fill(false);
    for (const s of validSeasons) fillRange(covered, s.from, s.to);
    const gaps: { from: string; to: string }[] = [];
    let runStart: number | null = null;
    for (let d = 1; d <= TOTAL_DAYS; d++) {
      const isGap = open[d] && !covered[d];
      if (isGap && runStart === null) runStart = d;
      if (!isGap && runStart !== null) {
        gaps.push({ from: doyToMmdd(runStart), to: doyToMmdd(d - 1) });
        runStart = null;
      }
    }
    if (runStart !== null) gaps.push({ from: doyToMmdd(runStart), to: doyToMmdd(TOTAL_DAYS) });
    return gaps;
  })();

  const isInSeasonGap = (dateStr: string) => {
    const mmdd = dateStr.slice(5); // extract MM-DD from YYYY-MM-DD
    return seasonGaps.some((g) => mmdd >= g.from && mmdd <= g.to);
  };

  const getSeasonForDate = (day: number) => {
    const month = previewMonth.getMonth();
    const mmdd = `${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    for (const s of seasons) {
      if (s.from && s.to && mmdd >= s.from && mmdd <= s.to) return s;
    }
    return null;
  };

  const isInOperatingPeriod = (day: number) => {
    const month = previewMonth.getMonth();
    const mmdd = `${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return operatingPeriods.some((p) => {
      if (!p.from || !p.to) return false;
      // Handle cross-year periods (e.g. 11-01 to 02-28)
      if (p.from > p.to) return mmdd >= p.from || mmdd <= p.to;
      return mmdd >= p.from && mmdd <= p.to;
    });
  };

  const tierColors: Record<string, string> = {
    Low: "text-green-700 bg-green-50 border-green-200",
    Mid: "text-yellow-700 bg-yellow-50 border-yellow-200",
    High: "text-red-700 bg-red-50 border-red-200",
    Peak: "text-red-900 bg-red-100 border-red-300",
  };

  const tierDotColors: Record<string, string> = {
    Low: "bg-green-500",
    Mid: "bg-yellow-400",
    High: "bg-red-500",
    Peak: "bg-red-800",
  };

  const handleSubmit = (e: React.FormEvent) => {
    if (skipPriceWarningConfirmRef.current) {
      skipPriceWarningConfirmRef.current = false;
      setConfirmUnusualPricesOpen(false);
      onSubmit(e);
      return;
    }

    if (activePriceWarnings.length > 0) {
      e.preventDefault();
      setTouchedPriceWarnings((prev) =>
        activePriceWarnings.reduce<Record<string, boolean>>(
          (next, warning) => {
            next[warning.id] = true;
            return next;
          },
          { ...prev },
        ),
      );
      setConfirmUnusualPricesOpen(true);
      return;
    }

    onSubmit(e);
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit}>
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-[11px] text-red-700 font-medium">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-[11px] text-green-700 font-medium">
          {success}
        </div>
      )}

      {/* Tabs */}
      <div className="relative border-b border-gray-200 mb-5 md:mb-6">
        <div className="flex gap-5 md:gap-6 overflow-x-auto scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
          {ROOM_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`shrink-0 whitespace-nowrap pb-2.5 text-[12px] font-medium transition-colors relative ${
                activeTab === tab.key ? "text-gray-900" : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gray-900 rounded-full" />
              )}
            </button>
          ))}
        </div>
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-50 to-transparent pointer-events-none lg:hidden" />
      </div>

      {/* Tab 1: Room Details */}
      {activeTab === "details" && (
        <div className="bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
              Room Type Basics
            </h3>
            <span className="text-[11px] font-medium text-red-500">Required</span>
          </div>

          {/* Room Type Name */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">
                Room Type Name <span className="text-red-500">*</span>
              </label>
            </div>
            <input
              type="text"
              value={form.name || ""}
              onChange={(e) => updateForm({ name: e.target.value })}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              placeholder="e.g. Two-Bedroom Villa"
            />
            <p className="text-[10px] text-gray-400 mt-1">
              Shown as the bold heading on the room card and in the booking summary
            </p>
          </div>

          {/* Beds */}
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <label className="text-[12px] font-semibold text-gray-900">Beds</label>
            </div>
            <p className="text-[10px] text-gray-400 mb-2">
              Add all bed types available in this room
            </p>
            <div className="space-y-2">
              {beds.map((bed, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <select
                    value={bed.type}
                    onChange={(e) => {
                      const updated = [...beds];
                      updated[idx] = { ...updated[idx], type: e.target.value };
                      setBeds(updated);
                    }}
                    className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                    style={SELECT_ARROW_STYLE}
                  >
                    {BED_TYPES.map((bt) => (
                      <option key={bt} value={bt}>
                        {bt}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={bed.count}
                    onChange={(e) => {
                      const updated = [...beds];
                      updated[idx] = {
                        ...updated[idx],
                        count: Math.max(1, Number(e.target.value)),
                      };
                      setBeds(updated);
                    }}
                    className="w-16 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                  />
                  {beds.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setBeds(beds.filter((_, i) => i !== idx))}
                      className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setBeds([...beds, { type: "King Bed", count: 1 }])}
              className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-gray-700 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" /> Add Bed
            </button>
          </div>

          {/* Occupancy */}
          <div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">
                    Total Max Occupancy <span className="text-red-500">*</span>
                  </label>
                </div>
                <input
                  type="number"
                  min={1}
                  value={maxOccupancyInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxOccupancyInput(v);
                    if (v !== "") {
                      const n = Number(v);
                      if (Number.isFinite(n) && n >= 1) updateForm({ maxOccupancy: n });
                    }
                  }}
                  onBlur={() => {
                    const n = clampNumberInput(maxOccupancyInput, 1);
                    setMaxOccupancyInput(String(n));
                    updateForm({ maxOccupancy: n });
                  }}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">Max Adults</label>
                </div>
                <input
                  type="number"
                  min={1}
                  placeholder="Any"
                  value={maxAdultsInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxAdultsInput(v);
                    if (v === "") {
                      updateForm({ maxAdults: null });
                      return;
                    }
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 1) updateForm({ maxAdults: n });
                  }}
                  onBlur={() => {
                    if (maxAdultsInput === "") {
                      updateForm({ maxAdults: null });
                      return;
                    }
                    const n = clampNumberInput(maxAdultsInput, 1);
                    setMaxAdultsInput(String(n));
                    updateForm({ maxAdults: n });
                  }}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="text-[12px] font-semibold text-gray-900">Max Children</label>
                </div>
                <input
                  type="number"
                  min={0}
                  placeholder="Any"
                  value={maxChildrenInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMaxChildrenInput(v);
                    if (v === "") {
                      updateForm({ maxChildren: null });
                      return;
                    }
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0) updateForm({ maxChildren: n });
                  }}
                  onBlur={() => {
                    if (maxChildrenInput === "") {
                      updateForm({ maxChildren: null });
                      return;
                    }
                    const n = clampNumberInput(maxChildrenInput, 0);
                    setMaxChildrenInput(String(n));
                    updateForm({ maxChildren: n });
                  }}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                />
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              Total occupancy still controls the room card. Adult and child limits refine booking
              availability when set.
            </p>
          </div>

          {/* Bedrooms, Bathrooms, Room Size, Total Rooms */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 items-start">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Bedrooms</label>
              </div>
              <input
                type="number"
                min={0}
                value={bedroomsInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setBedroomsInput(v);
                  if (v !== "") {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0) setBedrooms(n);
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(bedroomsInput, 0);
                  setBedroomsInput(String(n));
                  setBedrooms(n);
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Private bathrooms</label>
              </div>
              <input
                type="number"
                min={0}
                value={bathroomsInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setBathroomsInput(v);
                  if (v !== "") {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 0) setBathrooms(n);
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(bathroomsInput, 0);
                  setBathroomsInput(String(n));
                  setBathrooms(n);
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">
                  Room Size (m&sup2;) <span className="text-red-500">*</span>
                </label>
              </div>
              <input
                type="number"
                min={1}
                max={15000}
                value={sizeInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setSizeInput(v);
                  if (v !== "") {
                    const n = parseInt(v, 10);
                    if (Number.isFinite(n) && n >= 1 && n <= 15000) updateForm({ size: n });
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(sizeInput, 1, 15000);
                  setSizeInput(String(n));
                  updateForm({ size: n });
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                placeholder="50"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">
                  Total Rooms <span className="text-red-500">*</span>
                </label>
              </div>
              <input
                type="number"
                min={1}
                value={totalRoomsInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setTotalRoomsInput(v);
                  if (v !== "") {
                    const n = Number(v);
                    if (Number.isFinite(n) && n >= 1) updateForm({ totalRooms: n });
                  }
                }}
                onBlur={() => {
                  const n = clampNumberInput(totalRoomsInput, 1);
                  setTotalRoomsInput(String(n));
                  updateForm({ totalRooms: n });
                }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
              <p className="text-[10px] text-gray-400 mt-1 pl-3">
                {mode === "edit"
                  ? "Changing this adds or removes generated rooms to match. Rooms with active reservations are not removed — reassign or cancel those bookings first."
                  : "Number of rooms to create now. You can change it later — generated rooms adjust to match."}
              </p>
            </div>
          </div>

          {/* Room Description */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">Room Description</label>
            </div>
            <textarea
              value={form.description || ""}
              onChange={(e) => updateForm({ description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 resize-vertical"
              placeholder="The private pool is the standout feature of this villa. The air-conditioned villa has 2 bedrooms and 2 bathrooms..."
            />
            <p className="text-[10px] text-gray-400 mt-1">
              Shown in the &quot;View Details&quot; modal when a guest clicks to see more
            </p>
          </div>

          {/* Room Category Tag */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="text-[12px] font-semibold text-gray-900">Room Category Tag</label>
              <span className="text-[10px] text-gray-400">(shown to guests in Booking Engine)</span>
            </div>
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                updateForm({ category: e.target.value });
              }}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
              style={SELECT_ARROW_STYLE}
            >
              <option value="">Select category</option>
              {ROOM_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          {/* Location */}
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/60 p-4">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-2 mb-3">
              <div>
                <h3 className="text-[12px] font-bold text-gray-900 uppercase tracking-widest">
                  Location
                </h3>
                <p className="text-[11px] text-gray-500 mt-1">
                  Saved per room type. Guests see this address and pin when map view is enabled.
                </p>
              </div>
              {!(form.latitude != null && form.longitude != null) && (
                <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                  No location set - this room type won't appear on the map.
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3 space-y-3">
                <div>
                  <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
                    Search address
                  </label>
                  <input
                    type="text"
                    value={form.locationAddress || ""}
                    onChange={(e) => updateForm({ locationAddress: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                    placeholder="Street, area, city, country"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">
                    Provider autocomplete/geocoding plugs in here; coordinates are stored so the
                    Booking Engine never geocodes on page load.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
                      Latitude
                    </label>
                    <input
                      type="number"
                      step="0.000001"
                      min={-90}
                      max={90}
                      value={latitudeInput}
                      onChange={(e) => setLatitudeInput(e.target.value)}
                      onBlur={() => {
                        if (latitudeInput === "") {
                          updateForm({ latitude: null });
                        } else {
                          const v = Math.max(-90, Math.min(90, Number(latitudeInput)));
                          setLatitudeInput(String(v));
                          updateForm({ latitude: v });
                        }
                      }}
                      className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                      placeholder="-8.670458"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-semibold text-gray-900 mb-1.5">
                      Longitude
                    </label>
                    <input
                      type="number"
                      step="0.000001"
                      min={-180}
                      max={180}
                      value={longitudeInput}
                      onChange={(e) => setLongitudeInput(e.target.value)}
                      onBlur={() => {
                        if (longitudeInput === "") {
                          updateForm({ longitude: null });
                        } else {
                          const v = Math.max(-180, Math.min(180, Number(longitudeInput)));
                          setLongitudeInput(String(v));
                          updateForm({ longitude: v });
                        }
                      }}
                      className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900"
                      placeholder="115.212629"
                    />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-2 min-h-[180px] rounded-xl border border-gray-200 bg-white relative overflow-hidden">
                <div className="absolute inset-0 opacity-70 bg-[linear-gradient(90deg,#e5e7eb_1px,transparent_1px),linear-gradient(0deg,#e5e7eb_1px,transparent_1px)] bg-[size:28px_28px]" />
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-50 via-white to-sky-50" />
                {form.latitude != null && form.longitude != null ? (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="relative">
                      <div className="absolute -inset-5 rounded-full bg-primary-500/10 animate-pulse" />
                      <div className="relative rounded-full bg-primary-600 text-white text-[11px] font-bold px-3 py-1.5 shadow-lg">
                        Pin preview
                      </div>
                    </div>
                    <div className="absolute bottom-3 left-3 right-3 rounded-lg bg-white/90 border border-gray-200 px-3 py-2 text-[11px] text-gray-600 shadow-sm">
                      {Number(form.latitude).toFixed(5)}, {Number(form.longitude).toFixed(5)}
                    </div>
                  </div>
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
                    <p className="text-[12px] font-medium text-gray-500">
                      Enter coordinates to verify the guest-facing pin.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Sort Order & Active */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-[12px] font-semibold text-gray-900">Sort Order</label>
              </div>
              <input
                type="number"
                value={sortOrderInput}
                onChange={(e) => {
                  const raw = e.target.value;
                  setSortOrderInput(raw);
                  const parsed = parseInt(raw, 10);
                  updateForm({ sortOrder: Number.isNaN(parsed) ? 0 : Math.max(0, parsed) });
                }}
                onBlur={() => {
                  if (sortOrderInput.trim() === "") setSortOrderInput("0");
                }}
                min={0}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Lower numbers appear first in your room list
              </p>
            </div>
            <div className="flex items-end md:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <button
                  type="button"
                  onClick={() => updateForm({ isActive: !(form.isActive ?? true) })}
                  className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${(form.isActive ?? true) ? "bg-primary-500" : "bg-gray-300"}`}
                >
                  <div
                    className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${(form.isActive ?? true) ? "left-[20px]" : "left-[2px]"}`}
                  />
                </button>
                <span className="text-[12px] font-semibold text-gray-900">Active</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Pricing & Rates */}
      {activeTab === "pricing" && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left column: 4 sections */}
          <div className="lg:col-span-3 space-y-8">
            {/* Section 1: When are you open? */}
            <div>
              <div className="flex items-start gap-3 mb-1">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  1
                </span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">When are you open?</h3>
                  <p className="text-[11px] text-gray-400">
                    Operating periods repeat every year — dates outside are automatically closed
                  </p>
                </div>
              </div>
              <div className="ml-4 md:ml-9">
                {/* Timeline Bar */}
                <div className="mb-4">
                  <div className="flex text-[9px] text-gray-400 mb-1">
                    {[
                      "Jan",
                      "Feb",
                      "Mar",
                      "Apr",
                      "May",
                      "Jun",
                      "Jul",
                      "Aug",
                      "Sep",
                      "Oct",
                      "Nov",
                      "Dec",
                    ].map((m) => (
                      <span key={m} className="flex-1 text-center">
                        {m}
                      </span>
                    ))}
                  </div>
                  <div className="relative h-7 bg-gray-100 rounded-full overflow-hidden">
                    {operatingPeriods.map((period, idx) => {
                      const start = period.from ? getYearPercent(period.from) : 0;
                      const end = period.to ? getYearPercent(period.to) : 100;
                      const colors = [
                        "bg-primary-200",
                        "bg-amber-200",
                        "bg-emerald-200",
                        "bg-rose-200",
                      ];
                      const color = colors[idx % colors.length];
                      // Handle cross-year periods (e.g. Nov to Feb)
                      if (period.from && period.to && period.from > period.to) {
                        return (
                          <React.Fragment key={idx}>
                            <div
                              className={`absolute top-0 h-full ${color}`}
                              style={{ left: `${start}%`, width: `${100 - start}%` }}
                            />
                            <div
                              className={`absolute top-0 h-full ${color} flex items-center justify-center`}
                              style={{ left: "0%", width: `${end}%` }}
                            >
                              <span className="text-[9px] font-semibold text-gray-700 truncate px-1">
                                Period {idx + 1}
                              </span>
                            </div>
                          </React.Fragment>
                        );
                      }
                      const width = Math.max(end - start, 1);
                      return (
                        <div
                          key={idx}
                          className={`absolute top-0 h-full ${color} flex items-center justify-center`}
                          style={{ left: `${start}%`, width: `${width}%` }}
                        >
                          <span className="text-[9px] font-semibold text-gray-700 truncate px-1">
                            {idx === 0 && width > 90 ? "Year Round" : `Period ${idx + 1}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-3 md:px-5 py-4 space-y-3">
                  {operatingPeriods.map((period, idx) => {
                    const fromMonth = period.from ? parseInt(period.from.split("-")[0]) : 0;
                    const fromDay = period.from ? parseInt(period.from.split("-")[1]) : 0;
                    const toMonth = period.to ? parseInt(period.to.split("-")[0]) : 0;
                    const toDay = period.to ? parseInt(period.to.split("-")[1]) : 0;
                    const isInvalid = period.from && period.to && period.to < period.from;
                    const updatePeriod = (field: "from" | "to", month: number, day: number) => {
                      const updated = [...operatingPeriods];
                      const m = month || (day ? 1 : 0);
                      const maxDay = m ? DAYS_IN_MONTH[m - 1] : 31;
                      const d = day || (month ? 1 : 0);
                      const clampedDay = Math.min(d, maxDay);
                      updated[idx] = {
                        ...updated[idx],
                        [field]:
                          m || d
                            ? `${String(m || 1).padStart(2, "0")}-${String(clampedDay || 1).padStart(2, "0")}`
                            : "",
                      };
                      setOperatingPeriods(updated);
                    };
                    return (
                      <div key={idx}>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="flex items-center gap-1 flex-1 min-w-[160px]">
                            <select
                              value={fromDay}
                              onChange={(e) =>
                                updatePeriod("from", fromMonth, parseInt(e.target.value) || 0)
                              }
                              className="w-[52px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            >
                              <option value={0}>—</option>
                              {Array.from(
                                { length: fromMonth ? DAYS_IN_MONTH[fromMonth - 1] : 31 },
                                (_, i) => (
                                  <option key={i + 1} value={i + 1}>
                                    {String(i + 1).padStart(2, "0")}
                                  </option>
                                ),
                              )}
                            </select>
                            <select
                              value={fromMonth}
                              onChange={(e) =>
                                updatePeriod("from", parseInt(e.target.value) || 0, fromDay)
                              }
                              className="w-[68px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            >
                              <option value={0}>—</option>
                              {MONTHS.map((m, i) => (
                                <option key={m} value={i + 1}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          </div>
                          <span className="text-[11px] text-gray-400">to</span>
                          <div className="flex items-center gap-1 flex-1 min-w-[160px]">
                            <select
                              value={toDay}
                              onChange={(e) =>
                                updatePeriod("to", toMonth, parseInt(e.target.value) || 0)
                              }
                              className={`w-[52px] px-1.5 py-2 bg-white border rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent ${isInvalid ? "border-red-400" : "border-gray-200"}`}
                            >
                              <option value={0}>—</option>
                              {Array.from(
                                { length: toMonth ? DAYS_IN_MONTH[toMonth - 1] : 31 },
                                (_, i) => (
                                  <option key={i + 1} value={i + 1}>
                                    {String(i + 1).padStart(2, "0")}
                                  </option>
                                ),
                              )}
                            </select>
                            <select
                              value={toMonth}
                              onChange={(e) =>
                                updatePeriod("to", parseInt(e.target.value) || 0, toDay)
                              }
                              className={`w-[68px] px-1.5 py-2 bg-white border rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent ${isInvalid ? "border-red-400" : "border-gray-200"}`}
                            >
                              <option value={0}>—</option>
                              {MONTHS.map((m, i) => (
                                <option key={m} value={i + 1}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          </div>
                          {operatingPeriods.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setOperatingPeriods(operatingPeriods.filter((_, i) => i !== idx))
                              }
                              className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                            >
                              <XMarkIcon className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        {isInvalid && (
                          <p className="ml-0 mt-1 text-[10px] text-red-500">
                            End date must be after start date
                          </p>
                        )}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setOperatingPeriods([...operatingPeriods, { from: "", to: "" }])}
                    className="inline-flex items-center gap-1.5 text-[11px] text-gray-600 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <PlusIcon className="w-3.5 h-3.5" /> Add period
                  </button>
                </div>
              </div>
            </div>

            {/* Section 2: Seasonal pricing */}
            <div>
              <div className="flex items-start gap-3 mb-1">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  2
                </span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">
                    How does your pricing change across the year?
                  </h3>
                  <p className="text-[11px] text-gray-400">
                    Draw seasons on your operating period, then set a base rate per season
                  </p>
                </div>
              </div>
              <div className="ml-4 md:ml-9">
                {seasons.length === 0 ? (
                  <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-3 md:px-5 py-6 text-center">
                    <p className="text-[11px] text-gray-400">No seasons yet. Add one below.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {seasons.map((season, idx) => {
                      const dayCount =
                        season.from && season.to
                          ? (() => {
                              const [fm, fd] = season.from.split("-").map(Number);
                              const [tm, td] = season.to.split("-").map(Number);
                              const fromDoy =
                                DAYS_IN_MONTH.slice(0, fm - 1).reduce((a, b) => a + b, 0) + fd;
                              const toDoy =
                                DAYS_IN_MONTH.slice(0, tm - 1).reduce((a, b) => a + b, 0) + td;
                              return Math.max(0, toDoy - fromDoy);
                            })()
                          : 0;
                      return (
                        <div
                          key={idx}
                          className={`rounded-xl border px-4 py-3 ${overlappingSeasonIndices.has(idx) ? "border-red-300 bg-red-50/50" : "border-gray-200 bg-gray-50/50"}`}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <input
                              type="text"
                              value={season.name}
                              onChange={(e) => {
                                const u = [...seasons];
                                u[idx] = { ...u[idx], name: e.target.value };
                                setSeasons(u);
                              }}
                              placeholder="Season name"
                              className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 placeholder-gray-400"
                            />
                            <div className="flex items-center gap-2 shrink-0">
                              <select
                                value={season.tier}
                                onChange={(e) => {
                                  const u = [...seasons];
                                  u[idx] = { ...u[idx], tier: e.target.value };
                                  setSeasons(u);
                                }}
                                className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border appearance-none cursor-pointer ${tierColors[season.tier] || "text-gray-600 bg-gray-100 border-gray-200"}`}
                                style={{
                                  ...SELECT_ARROW_STYLE,
                                  backgroundPosition: "right 8px center",
                                  paddingRight: "20px",
                                }}
                              >
                                <option value="">—</option>
                                <option value="Low">Low</option>
                                <option value="Mid">Mid</option>
                                <option value="High">High</option>
                                <option value="Peak">Peak</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => setSeasons(seasons.filter((_, i) => i !== idx))}
                                className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                              >
                                <svg
                                  className="w-4 h-4"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {(() => {
                              const sFromMonth = season.from
                                ? parseInt(season.from.split("-")[0])
                                : 0;
                              const sFromDay = season.from
                                ? parseInt(season.from.split("-")[1])
                                : 0;
                              const sToMonth = season.to ? parseInt(season.to.split("-")[0]) : 0;
                              const sToDay = season.to ? parseInt(season.to.split("-")[1]) : 0;
                              const updateSeasonDate = (
                                field: "from" | "to",
                                month: number,
                                day: number,
                              ) => {
                                const u = [...seasons];
                                const m = month || (day ? 1 : 0);
                                const maxDay = m ? DAYS_IN_MONTH[m - 1] : 31;
                                const d = day || (month ? 1 : 0);
                                const clampedDay = Math.min(d, maxDay);
                                u[idx] = {
                                  ...u[idx],
                                  [field]:
                                    m || d
                                      ? `${String(m || 1).padStart(2, "0")}-${String(clampedDay || 1).padStart(2, "0")}`
                                      : "",
                                };
                                setSeasons(u);
                              };
                              return (
                                <>
                                  <div className="flex items-center gap-1">
                                    <select
                                      value={sFromDay}
                                      onChange={(e) =>
                                        updateSeasonDate(
                                          "from",
                                          sFromMonth,
                                          parseInt(e.target.value) || 0,
                                        )
                                      }
                                      className="w-[52px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                    >
                                      <option value={0}>—</option>
                                      {Array.from(
                                        { length: sFromMonth ? DAYS_IN_MONTH[sFromMonth - 1] : 31 },
                                        (_, i) => (
                                          <option key={i + 1} value={i + 1}>
                                            {String(i + 1).padStart(2, "0")}
                                          </option>
                                        ),
                                      )}
                                    </select>
                                    <select
                                      value={sFromMonth}
                                      onChange={(e) =>
                                        updateSeasonDate(
                                          "from",
                                          parseInt(e.target.value) || 0,
                                          sFromDay,
                                        )
                                      }
                                      className="w-[68px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                    >
                                      <option value={0}>—</option>
                                      {MONTHS.map((m, i) => (
                                        <option key={m} value={i + 1}>
                                          {m}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <span className="text-[11px] text-gray-400">to</span>
                                  <div className="flex items-center gap-1">
                                    <select
                                      value={sToDay}
                                      onChange={(e) =>
                                        updateSeasonDate(
                                          "to",
                                          sToMonth,
                                          parseInt(e.target.value) || 0,
                                        )
                                      }
                                      className="w-[52px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                    >
                                      <option value={0}>—</option>
                                      {Array.from(
                                        { length: sToMonth ? DAYS_IN_MONTH[sToMonth - 1] : 31 },
                                        (_, i) => (
                                          <option key={i + 1} value={i + 1}>
                                            {String(i + 1).padStart(2, "0")}
                                          </option>
                                        ),
                                      )}
                                    </select>
                                    <select
                                      value={sToMonth}
                                      onChange={(e) =>
                                        updateSeasonDate(
                                          "to",
                                          parseInt(e.target.value) || 0,
                                          sToDay,
                                        )
                                      }
                                      className="w-[68px] px-1.5 py-2 bg-white border border-gray-200 rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                    >
                                      <option value={0}>—</option>
                                      {MONTHS.map((m, i) => (
                                        <option key={m} value={i + 1}>
                                          {m}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  {dayCount > 0 && (
                                    <span className="text-[10px] text-gray-400 shrink-0">
                                      {dayCount}d
                                    </span>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {overlappingSeasonIndices.size > 0 && (
                  <p className="mt-2 text-[11px] text-red-600 font-medium">
                    Season date ranges must not overlap. Please adjust the highlighted seasons.
                  </p>
                )}
                {seasonGaps.length > 0 && (
                  <div className="mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-[11px] text-amber-700 font-medium mb-1">
                      Gaps detected — the following dates have no season and therefore no price:
                    </p>
                    <ul className="list-disc list-inside text-[11px] text-amber-600">
                      {seasonGaps.map((gap, i) => {
                        const fmt = (mmdd: string) => {
                          const [m, d] = mmdd.split("-").map(Number);
                          return `${d} ${MONTHS[m - 1]}`;
                        };
                        const fromDoy = (() => {
                          const [m, d] = gap.from.split("-").map(Number);
                          return DAYS_IN_MONTH.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
                        })();
                        const toDoy = (() => {
                          const [m, d] = gap.to.split("-").map(Number);
                          return DAYS_IN_MONTH.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
                        })();
                        const days = toDoy - fromDoy + 1;
                        return (
                          <li key={i}>
                            {fmt(gap.from)}
                            {gap.from !== gap.to ? ` – ${fmt(gap.to)}` : ""} ({days} day
                            {days > 1 ? "s" : ""} uncovered)
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setSeasons([
                      ...seasons,
                      {
                        name: "",
                        tier: "",
                        from: "",
                        to: "",
                        rate: "",
                        minStay: 1,
                        maxStay: null,
                        occupancyRates: {},
                      },
                    ])
                  }
                  className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-600 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <PlusIcon className="w-3.5 h-3.5" /> Add season
                </button>

                {/* Set rates per season table */}
                {seasons.length > 0 && (
                  <div className="mt-4 rounded-xl border border-gray-200 bg-white overflow-hidden">
                    <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-gray-700">
                        Set rates per season
                      </span>
                      <div className="text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="text-[10px] text-gray-500">Currency</span>
                          <select
                            value={form.currency || "EUR"}
                            disabled={mode === "edit"}
                            title={
                              mode === "edit"
                                ? "Change currency from property pricing settings."
                                : undefined
                            }
                            onChange={(e) =>
                              onChange((prev: any) => ({ ...prev, currency: e.target.value }))
                            }
                            className="text-[11px] px-2 py-1 border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 cursor-pointer disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
                          >
                            {Object.entries(CURRENCY_SYMBOLS).map(([code, symbol]) => (
                              <option key={code} value={code}>
                                {code} ({symbol})
                              </option>
                            ))}
                          </select>
                        </div>
                        {mode === "edit" && (
                          <p className="mt-1 text-[10px] text-gray-500">
                            Currency is managed in property pricing settings.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[620px] table-fixed text-[11px]">
                        <colgroup>
                          <col className="w-[27%]" />
                          <col className="w-[22%]" />
                          <col className="w-[13%]" />
                          <col className="w-[17%]" />
                          <col className="w-[21%]" />
                        </colgroup>
                        <thead>
                          <tr className="border-b border-gray-100">
                            <th className="text-left px-3 py-2 text-gray-500 font-medium">
                              Season
                            </th>
                            <th className="text-left px-3 py-2 text-gray-500 font-medium">
                              Flex Rate
                            </th>
                            <th
                              className="text-left px-2 py-2 text-gray-500 font-medium"
                              title="Minimum number of nights per booking."
                            >
                              Min
                            </th>
                            <th
                              className="text-left px-2 py-2 text-gray-500 font-medium"
                              title="Maximum number of nights per booking. Leave empty for no limit."
                            >
                              Max
                            </th>
                            <th className="text-left px-2 py-2 text-gray-500 font-medium whitespace-nowrap">
                              Per guest
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {seasons.map((season, idx) => {
                            const maxOcc = form.maxOccupancy ?? 2;
                            const hasOccRates = Object.values(season.occupancyRates || {}).some(
                              (v) => v !== "" && v !== undefined,
                            );
                            const isOccExpanded = expandedOccupancy[idx] || false;
                            const seasonPriceWarning = visiblePriceWarningById.get(`season:${idx}`);
                            const maxStayValue = season.maxStay ?? null;
                            const maxStayInvalid =
                              maxStayValue !== null &&
                              maxStayValue > 0 &&
                              maxStayValue < (season.minStay || 1);
                            return (
                              <React.Fragment key={idx}>
                                <tr className="border-b border-gray-50">
                                  <td className="px-3 py-2.5">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span
                                        className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded ${tierColors[season.tier] || "text-gray-600 bg-gray-100"}`}
                                      >
                                        {season.tier || "—"}
                                      </span>
                                      {season.name ? (
                                        <span className="truncate text-[12px] text-gray-700">
                                          {season.name}
                                        </span>
                                      ) : (
                                        <span className="text-gray-300">&mdash;</span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2.5">
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-1">
                                        <span className="text-gray-400">
                                          {getCurrencySymbol(currency)}
                                        </span>
                                        <input
                                          type="number"
                                          value={season.rate}
                                          onChange={(e) => {
                                            const u = [...seasons];
                                            u[idx] = { ...u[idx], rate: e.target.value };
                                            setSeasons(u);
                                          }}
                                          onBlur={() => markPriceWarningTouched(`season:${idx}`)}
                                          className={`w-[72px] px-2 py-1 bg-gray-50 border rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 ${!season.rate || Number(season.rate) <= 0 ? "border-red-400" : seasonPriceWarning ? "border-amber-400 bg-amber-50/50" : "border-gray-200"}`}
                                          placeholder="0"
                                          min="1"
                                          required
                                        />
                                        {(!season.rate || Number(season.rate) <= 0) && (
                                          <span className="text-[10px] text-red-500">Required</span>
                                        )}
                                      </div>
                                      {seasonPriceWarning && (
                                        <div className="max-w-xs">
                                          <PriceWarningMessage
                                            warning={seasonPriceWarning}
                                            currency={currency}
                                            onDismiss={() =>
                                              dismissPriceWarning(seasonPriceWarning)
                                            }
                                          />
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-2 py-2.5">
                                    <div className="inline-flex items-center gap-0 border border-gray-200 rounded-lg overflow-hidden">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const u = [...seasons];
                                          u[idx] = {
                                            ...u[idx],
                                            minStay: Math.max(1, (u[idx].minStay || 1) - 1),
                                          };
                                          setSeasons(u);
                                        }}
                                        className="h-7 w-6 text-gray-500 hover:bg-gray-100 transition-colors text-[11px] font-medium"
                                      >
                                        &minus;
                                      </button>
                                      <span className="inline-flex h-7 min-w-7 items-center justify-center px-1 text-[11px] font-semibold text-gray-900 bg-white">
                                        {season.minStay || 1}
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const u = [...seasons];
                                          u[idx] = {
                                            ...u[idx],
                                            minStay: (u[idx].minStay || 1) + 1,
                                          };
                                          setSeasons(u);
                                        }}
                                        className="h-7 w-6 text-gray-500 hover:bg-gray-100 transition-colors text-[11px] font-medium"
                                      >
                                        +
                                      </button>
                                    </div>
                                  </td>
                                  <td className="px-2 py-2.5">
                                    <div className="space-y-1">
                                      <div
                                        className={`inline-flex items-center gap-0 border rounded-lg overflow-hidden ${maxStayInvalid ? "border-red-300" : "border-gray-200"}`}
                                      >
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const u = [...seasons];
                                            const current = Number(u[idx].maxStay || 0);
                                            const minStay = u[idx].minStay || 1;
                                            u[idx] = {
                                              ...u[idx],
                                              maxStay: current <= minStay ? null : current - 1,
                                            };
                                            setSeasons(u);
                                          }}
                                          className="h-7 w-6 text-gray-500 hover:bg-gray-100 transition-colors text-[11px] font-medium"
                                        >
                                          &minus;
                                        </button>
                                        <input
                                          type="number"
                                          min={0}
                                          value={season.maxStay ?? ""}
                                          onChange={(e) => {
                                            const u = [...seasons];
                                            const raw = e.target.value;
                                            const parsedMaxStay = parseInt(raw, 10);
                                            u[idx] = {
                                              ...u[idx],
                                              maxStay:
                                                raw === "" ||
                                                Number.isNaN(parsedMaxStay) ||
                                                parsedMaxStay <= 0
                                                  ? null
                                                  : parsedMaxStay,
                                            };
                                            setSeasons(u);
                                          }}
                                          placeholder="—"
                                          title="Maximum number of nights per booking. Leave empty for no limit."
                                          className="h-7 w-8 px-1 text-[11px] font-semibold text-gray-900 bg-white text-center outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const u = [...seasons];
                                            const current = Number(u[idx].maxStay || 0);
                                            const minStay = u[idx].minStay || 1;
                                            u[idx] = {
                                              ...u[idx],
                                              maxStay: current > 0 ? current + 1 : minStay,
                                            };
                                            setSeasons(u);
                                          }}
                                          className="h-7 w-6 text-gray-500 hover:bg-gray-100 transition-colors text-[11px] font-medium"
                                        >
                                          +
                                        </button>
                                      </div>
                                      {maxStayInvalid && (
                                        <p className="text-[10px] font-medium text-red-600">
                                          Max stay cannot be less than min stay.
                                        </p>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-2 py-2.5">
                                    {maxOcc > 1 ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setExpandedOccupancy((prev) => ({
                                            ...prev,
                                            [idx]: !prev[idx],
                                          }))
                                        }
                                        className={`inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-[10px] font-medium transition-colors ${hasOccRates ? "text-primary-600 bg-primary-50 hover:bg-primary-100" : "text-gray-500 hover:bg-gray-100"}`}
                                      >
                                        <ChevronDownIcon
                                          className={`h-3 w-3 shrink-0 transition-transform ${isOccExpanded ? "" : "-rotate-90"}`}
                                        />
                                        Per guest
                                      </button>
                                    ) : (
                                      <span className="text-gray-300">&mdash;</span>
                                    )}
                                  </td>
                                </tr>
                                {isOccExpanded && maxOcc > 1 && (
                                  <tr className="border-b border-gray-50 bg-gray-50/50">
                                    <td colSpan={5} className="px-4 py-2.5 pl-10">
                                      <div className="space-y-1.5">
                                        <span className="text-[10px] text-gray-400 font-medium">
                                          Rate per number of guests
                                        </span>
                                        {Array.from({ length: maxOcc }, (_, i) => i + 1).map(
                                          (guestCount) => {
                                            const isAnchor = guestCount === 1;
                                            const occRate =
                                              (season.occupancyRates || {})[String(guestCount)] ||
                                              "";
                                            return (
                                              <div
                                                key={guestCount}
                                                className="flex items-center gap-2"
                                              >
                                                <span className="text-[11px] text-gray-500 w-16">
                                                  {guestCount}{" "}
                                                  {guestCount === 1 ? "guest" : "guests"}
                                                </span>
                                                <span className="text-gray-400 text-[11px]">
                                                  {getCurrencySymbol(form.currency || "EUR")}
                                                </span>
                                                {isAnchor ? (
                                                  <span className="text-[11px] text-gray-400 px-2 py-1">
                                                    {season.rate || "—"} (season rate)
                                                  </span>
                                                ) : (
                                                  <input
                                                    type="number"
                                                    value={occRate}
                                                    onChange={(e) => {
                                                      const u = [...seasons];
                                                      const occ = {
                                                        ...(u[idx].occupancyRates || {}),
                                                      };
                                                      if (e.target.value === "") {
                                                        delete occ[String(guestCount)];
                                                      } else {
                                                        occ[String(guestCount)] = e.target.value;
                                                      }
                                                      u[idx] = { ...u[idx], occupancyRates: occ };
                                                      setSeasons(u);
                                                    }}
                                                    className="w-20 px-2 py-1 bg-white border border-gray-200 rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                                    placeholder={season.rate || "same as rate"}
                                                    min="0"
                                                  />
                                                )}
                                              </div>
                                            );
                                          },
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Section 3: Rate plans */}
            <div>
              <div className="flex items-start gap-3 mb-1">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  3
                </span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">What can guests book?</h3>
                  <p className="text-[11px] text-gray-400">Select at least one rate plan</p>
                </div>
              </div>
              <div className="ml-4 md:ml-9 space-y-2.5">
                {/* Flexible Rate */}
                <div
                  className={`rounded-xl border px-4 py-3.5 transition-colors ${flexibleRateEnabled ? "border-primary-200 bg-primary-50/30" : "border-gray-200 bg-gray-50"}`}
                >
                  <div className="flex items-center gap-3">
                    {mode === "edit" ? (
                      <span className="flex h-[22px] w-10 shrink-0 items-center justify-center rounded-full bg-primary-500 text-white">
                        <CheckIcon className="h-4 w-4" aria-hidden="true" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setFlexibleRateEnabled(!flexibleRateEnabled)}
                        className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${flexibleRateEnabled ? "bg-primary-500" : "bg-gray-300"}`}
                      >
                        <div
                          className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${flexibleRateEnabled ? "left-[20px]" : "left-[2px]"}`}
                        />
                      </button>
                    )}
                    <svg
                      className="w-4 h-4 text-primary-500 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                    <span className="text-[12px] font-semibold text-gray-900">Flexible rate</span>
                    <span className="text-[11px] text-gray-400">
                      {mode === "edit"
                        ? "(standard plan)"
                        : flexibleCancellationType === "partial_refund"
                          ? "(partial refund)"
                          : "(free cancellation)"}
                    </span>
                  </div>
                  {flexibleRateEnabled && (
                    <div className="mt-3 ml-[52px] space-y-3">
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                          Cancellation type
                        </div>
                        <div className="inline-flex gap-2">
                          <button
                            type="button"
                            onClick={() => setFlexibleCancellationType("free")}
                            className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors border ${flexibleCancellationType === "free" ? "bg-primary-50 border-primary-500 text-primary-600" : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"}`}
                          >
                            Free cancellation
                          </button>
                          <button
                            type="button"
                            onClick={() => setFlexibleCancellationType("partial_refund")}
                            className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors border ${flexibleCancellationType === "partial_refund" ? "bg-primary-50 border-primary-500 text-primary-600" : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"}`}
                          >
                            Partial refund
                          </button>
                        </div>
                      </div>
                      {flexibleCancellationType === "free" && (
                        <div className="flex items-center gap-3">
                          <span className="text-[11px] text-gray-500">Cancellation policy:</span>
                          <select
                            value={cancellationPolicy}
                            onChange={(e) => setCancellationPolicy(e.target.value)}
                            className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                            style={{
                              ...SELECT_ARROW_STYLE,
                              backgroundPosition: "right 10px center",
                            }}
                          >
                            <option>Free until 1 day before</option>
                            <option>Free until 2 days before</option>
                            <option>Free until 3 days before</option>
                            <option>Free until 5 days before</option>
                            <option>Free until 7 days before</option>
                            <option>Free until 14 days before</option>
                            <option>Free until 30 days before</option>
                          </select>
                        </div>
                      )}
                      {flexibleCancellationType === "partial_refund" && (
                        <PartialRefundTiersEditor
                          tiers={partialRefundTiers}
                          onChange={setPartialRefundTiers}
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* Non-refundable */}
                <div
                  className={`rounded-xl border px-4 py-3.5 transition-colors ${nonRefundableEnabled ? "border-amber-200 bg-amber-50/30" : "border-gray-200 bg-gray-50"}`}
                >
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        const next = !nonRefundableEnabled;
                        setNonRefundableEnabled(next);
                        if (next) {
                          updateForm({
                            nonRefundableRate:
                              Math.round(
                                (form.baseRate || 0) * (1 - nonRefundableDiscount / 100) * 100,
                              ) / 100,
                          });
                        } else {
                          updateForm({ nonRefundableRate: null });
                        }
                      }}
                      className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${nonRefundableEnabled ? "bg-primary-500" : "bg-gray-300"}`}
                    >
                      <div
                        className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${nonRefundableEnabled ? "left-[20px]" : "left-[2px]"}`}
                      />
                    </button>
                    <svg
                      className="w-4 h-4 text-gray-400 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span className="text-[12px] font-semibold text-gray-900">Non-refundable</span>
                    <span className="text-[11px] text-gray-400">
                      (discount for no cancellation)
                    </span>
                  </div>
                  {nonRefundableEnabled && (
                    <div className="mt-3 ml-[52px]">
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] text-gray-500">Cancellation policy:</span>
                        <select
                          value={nonRefundableCancellationPolicy}
                          onChange={(e) => setNonRefundableCancellationPolicy(e.target.value)}
                          className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                          style={{ ...SELECT_ARROW_STYLE, backgroundPosition: "right 10px center" }}
                        >
                          <option>Non-refundable from booking</option>
                          <option>Cancel within 24 hours of booking</option>
                          <option>Cancel within 48 hours of booking</option>
                          <option>Cancel within 7 days of booking</option>
                        </select>
                      </div>
                    </div>
                  )}
                  {nonRefundableEnabled && flexibleRateEnabled && (
                    <div className="mt-3 ml-[52px] flex items-center gap-3">
                      <span className="text-[11px] text-gray-500">Discount:</span>
                      <div className="inline-flex items-center gap-0 border border-gray-200 rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.max(1, nonRefundableDiscount - 1);
                            setNonRefundableDiscount(next);
                            updateForm({
                              nonRefundableRate:
                                Math.round((form.baseRate || 0) * (1 - next / 100) * 100) / 100,
                            });
                          }}
                          className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                        >
                          &minus;
                        </button>
                        <div className="relative flex items-center bg-white min-w-[48px]">
                          <input
                            type="number"
                            min={1}
                            max={50}
                            value={nonRefundableDiscount}
                            onChange={(e) => {
                              const val = Math.max(1, Math.min(50, parseInt(e.target.value) || 1));
                              setNonRefundableDiscount(val);
                              updateForm({
                                nonRefundableRate:
                                  Math.round((form.baseRate || 0) * (1 - val / 100) * 100) / 100,
                              });
                            }}
                            className="w-[40px] px-1 py-1.5 text-[12px] font-semibold text-gray-900 text-center bg-transparent outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <span className="text-[12px] font-semibold text-gray-900 pr-1">%</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.min(50, nonRefundableDiscount + 1);
                            setNonRefundableDiscount(next);
                            updateForm({
                              nonRefundableRate:
                                Math.round((form.baseRate || 0) * (1 - next / 100) * 100) / 100,
                            });
                          }}
                          className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                        >
                          +
                        </button>
                      </div>
                      <span className="text-[11px] text-gray-500">off flexible rate</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Section 4: Meal plans */}
            <div>
              <div className="flex items-start gap-3 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  4
                </span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">
                    Do you offer meal plans?
                  </h3>
                  <p className="text-[11px] text-gray-400">
                    Each meal plan creates an additional bookable rate on your booking engine and
                    OTA channels
                  </p>
                </div>
              </div>
              <div className="ml-4 md:ml-9 space-y-2.5">
                {mealPlans.map((mp, idx) => {
                  const symbol = getCurrencySymbol(form.currency || "EUR");
                  const usedCodes = new Set(
                    mealPlans.map((m, i) => (i === idx ? null : m.code)).filter((c) => c !== null),
                  );
                  const availableOptions = MEAL_PLAN_OPTIONS.filter(
                    (o) => o.code === mp.code || !usedCodes.has(o.code),
                  );
                  const label = MEAL_PLAN_LABEL[mp.code];
                  const projected = projectedSurcharge(mp);
                  const baseSeasonRate = parseFloat(seasons[0]?.rate || "") || form.baseRate || 0;
                  return (
                    <div
                      key={idx}
                      className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3"
                    >
                      {/* Header row: toggle, type dropdown, delete */}
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => removeMealPlan(idx)}
                          aria-label="Deactivate meal plan"
                          className="relative w-10 h-[22px] rounded-full bg-primary-500 shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1"
                        >
                          <span className="absolute top-[2px] left-[20px] w-[18px] h-[18px] rounded-full bg-white shadow" />
                        </button>
                        <select
                          value={mp.code}
                          onChange={(e) =>
                            updateMealPlan(idx, {
                              code: parseInt(e.target.value, 10) as MealPlanCode,
                            })
                          }
                          className="flex-1 max-w-[260px] px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] font-medium focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                          style={{ ...SELECT_ARROW_STYLE, backgroundPosition: "right 10px center" }}
                        >
                          {availableOptions.map((o) => (
                            <option key={o.code} value={o.code}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => removeMealPlan(idx)}
                          className="ml-auto p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-white transition-colors"
                          aria-label="Remove meal plan"
                        >
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6" />
                            <path d="M14 11v6" />
                          </svg>
                        </button>
                      </div>

                      {/* Surcharge + Charge per */}
                      <div className="flex flex-wrap items-end gap-4">
                        <div className="flex-1 min-w-[200px]">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
                            Surcharge
                          </div>
                          <div className="inline-flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
                            <span className="text-[11px] text-gray-500">{symbol}</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={mp.surcharge}
                              onChange={(e) =>
                                updateMealPlan(idx, {
                                  surcharge: Math.max(0, parseFloat(e.target.value) || 0),
                                })
                              }
                              className="w-[100px] px-1 text-[12px] font-semibold text-gray-900 bg-transparent outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            />
                            <span className="text-[10px] text-gray-400">
                              / {mp.chargePer} / night
                            </span>
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
                            Charge per
                          </div>
                          <div className="inline-flex bg-white border border-gray-200 rounded-lg overflow-hidden">
                            {(["person", "room"] as const).map((unit) => (
                              <button
                                key={unit}
                                type="button"
                                onClick={() => updateMealPlan(idx, { chargePer: unit })}
                                className={`px-4 py-1.5 text-[11px] font-medium capitalize transition-colors ${mp.chargePer === unit ? "bg-primary-500 text-white" : "text-gray-600 hover:bg-gray-50"}`}
                              >
                                {unit}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Pricing preview table */}
                      {seasons.length > 0 && baseSeasonRate > 0 && mp.surcharge > 0 && (
                        <div className="rounded-lg bg-white border border-gray-100 overflow-hidden">
                          <div className="px-3 py-2 bg-gray-50 border-b border-gray-100">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                              How pricing changes with this meal plan
                            </div>
                          </div>
                          <table className="w-full text-[11px]">
                            <thead>
                              <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                <th className="px-3 py-2">Season</th>
                                <th className="px-3 py-2 text-right">Room only</th>
                                <th className="px-3 py-2 text-right">{label}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {seasons.map((s, sIdx) => {
                                const base = parseFloat(s.rate || "") || form.baseRate || 0;
                                const withMeal = base + projected;
                                return (
                                  <tr key={sIdx} className="border-t border-gray-100">
                                    <td className="px-3 py-2 text-gray-700">
                                      {s.name || `Season ${sIdx + 1}`}
                                    </td>
                                    <td className="px-3 py-2 text-right text-gray-500">
                                      {symbol}
                                      {base.toLocaleString()}
                                    </td>
                                    <td className="px-3 py-2 text-right font-semibold text-gray-900">
                                      {symbol}
                                      {withMeal.toLocaleString()}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <div className="px-3 py-2 text-[10px] text-gray-400 border-t border-gray-100">
                            * Calculated for {PREVIEW_GUESTS} guests · {label} surcharge: {symbol}
                            {mp.surcharge.toLocaleString()} per {mp.chargePer}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {mealPlans.length < MEAL_PLAN_OPTIONS.length && (
                  <button
                    type="button"
                    onClick={addMealPlan}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-primary-600 hover:bg-primary-50 transition-colors"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add meal plan
                  </button>
                )}
              </div>
            </div>

            {/* Section 5: Weekend surcharge */}
            <div>
              <div className="flex items-start gap-3 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  5
                </span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">
                    Do weekends cost more?
                  </h3>
                  <p className="text-[11px] text-gray-400">
                    Weekend pricing applies to Friday & Saturday nights across all seasons
                  </p>
                </div>
              </div>
              <div className="ml-4 md:ml-9 flex flex-wrap items-center gap-2">
                {["+0%", "+10%", "+15%", "+20%"].map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setWeekendSurcharge(opt)}
                    className={`px-4 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
                      weekendSurcharge === opt
                        ? "bg-primary-500 text-white border-primary-500"
                        : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
                {!["+0%", "+10%", "+15%", "+20%"].includes(weekendSurcharge) ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-gray-500">+</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={weekendSurcharge.replace(/[^0-9]/g, "")}
                      onChange={(e) => setWeekendSurcharge(`+${e.target.value}%`)}
                      className="w-14 px-2 py-1.5 bg-white border border-primary-500 rounded-full text-[11px] text-center font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      autoFocus
                    />
                    <span className="text-[11px] text-gray-500">%</span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setWeekendSurcharge("+%")}
                    className="px-4 py-1.5 rounded-full text-[11px] font-medium border transition-colors bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                  >
                    Custom
                  </button>
                )}
              </div>
            </div>

            {/* Section 6: Minimum advance booking */}
            <div>
              <div className="flex items-start gap-3 mb-2">
                <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  6
                </span>
                <div>
                  <h3 className="text-[13px] font-semibold text-gray-900">
                    Minimum advance booking
                  </h3>
                  <p className="text-[11px] text-gray-400">
                    Require guests to book a minimum number of days before check-in
                  </p>
                </div>
              </div>
              <div className="ml-4 md:ml-9 flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="365"
                  value={form.minimumAdvanceDays ?? 0}
                  onChange={(e) =>
                    updateForm({ minimumAdvanceDays: Math.max(0, parseInt(e.target.value) || 0) })
                  }
                  className="w-20 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] text-center font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                />
                <span className="text-[11px] text-gray-500">days before check-in</span>
                <span className="text-[10px] text-gray-400 ml-2">(0 = no restriction)</span>
              </div>
            </div>

            {/* Section 7: Deposit settings per rate */}
            <RateDepositSection
              value={form.rateDepositSettings ?? null}
              flexibleRateEnabled={flexibleRateEnabled}
              nonRefundableEnabled={nonRefundableEnabled}
              baseRate={form.baseRate || 0}
              currency={form.currency || "EUR"}
              onChange={(next) => updateForm({ rateDepositSettings: next })}
            />

            {/* Section 8: Allowed payment methods per rate */}
            <RatePaymentMethodsSection
              value={form.ratePaymentMethods ?? null}
              flexibleRateEnabled={flexibleRateEnabled}
              nonRefundableEnabled={nonRefundableEnabled}
              onChange={(next) => updateForm({ ratePaymentMethods: next })}
            />
          </div>

          {/* Right column: LIVE RATE PREVIEW */}
          <div className="lg:col-span-2">
            <div className="sticky top-4 rounded-xl border border-gray-200 bg-white overflow-hidden">
              {/* Header */}
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[13px]">&#x1F4C5;</span>
                  <span className="text-[11px] font-bold text-gray-700 uppercase tracking-wider">
                    Live Rate Preview
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewMonth(
                        new Date(previewMonth.getFullYear(), previewMonth.getMonth() - 1, 1),
                      )
                    }
                    className="p-1 rounded hover:bg-gray-200 transition-colors"
                  >
                    <svg
                      className="w-3.5 h-3.5 text-gray-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                  <span className="text-[11px] font-semibold text-gray-700 min-w-[80px] text-center">
                    {previewMonth.toLocaleString("default", { month: "long", year: "numeric" })}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPreviewMonth(
                        new Date(previewMonth.getFullYear(), previewMonth.getMonth() + 1, 1),
                      )
                    }
                    className="p-1 rounded hover:bg-gray-200 transition-colors"
                  >
                    <svg
                      className="w-3.5 h-3.5 text-gray-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Season legend */}
              {seasons.length > 0 && (
                <div className="px-4 py-2.5 border-b border-gray-100 space-y-1">
                  {seasons.map((s, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-[10px]">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{
                          backgroundColor:
                            { Low: "#22c55e", Mid: "#eab308", High: "#ef4444", Peak: "#991b1b" }[
                              s.tier
                            ] || "#9ca3af",
                        }}
                      />
                      <span className="font-medium text-gray-700">
                        {s.name || `Season ${idx + 1}`}
                      </span>
                      {s.from && s.to && (
                        <span className="text-gray-400">
                          {s.from} - {s.to}
                        </span>
                      )}
                      {s.rate && (
                        <span className="text-gray-500 ml-auto text-right">
                          {formatCurrency(parseFloat(s.rate) || 0, form.currency || "EUR")}/night
                          {" · "}Min {s.minStay || 1}
                          {s.maxStay && s.maxStay > 0 ? ` · Max ${s.maxStay}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Calendar grid */}
              <div className="px-3 py-3">
                <div className="grid grid-cols-7 gap-0.5 mb-1">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                    <div
                      key={d}
                      className={`text-center text-[9px] font-semibold py-1 ${d === "Fri" || d === "Sat" ? "text-orange-500" : "text-gray-400"}`}
                    >
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                  {(() => {
                    const year = previewMonth.getFullYear();
                    const month = previewMonth.getMonth();
                    const firstDay = new Date(year, month, 1);
                    const lastDay = new Date(year, month + 1, 0);
                    const daysInMonth = lastDay.getDate();
                    // Monday = 0, Sunday = 6
                    let startDow = firstDay.getDay() - 1;
                    if (startDow < 0) startDow = 6;

                    const cells: React.ReactNode[] = [];
                    // Empty cells for days before the 1st
                    for (let i = 0; i < startDow; i++) {
                      cells.push(<div key={`empty-${i}`} className="h-10" />);
                    }
                    for (let day = 1; day <= daysInMonth; day++) {
                      const date = new Date(year, month, day);
                      const dow = date.getDay(); // 0=Sun, 5=Fri, 6=Sat
                      const isWeekend = dow === 5 || dow === 6;
                      const inOp = isInOperatingPeriod(day);
                      const season = getSeasonForDate(day);
                      let rate = season ? parseFloat(season.rate) || 0 : 0;
                      if (isWeekend && rate > 0) {
                        rate = Math.round(rate * (1 + weekendSurchargePercent / 100));
                      }

                      // Use local-date components, not toISOString — for users east of
                      // UTC the latter shifts the key one day back, so the override the
                      // user sees on May 7 ends up persisted under "2026-05-06" and the
                      // Booking Engine / Channex never find it for May 7. (VAY-380)
                      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                      const hasDailyOverride = dailyRates[dateStr] !== undefined;
                      const displayRate = hasDailyOverride ? dailyRates[dateStr] : rate;
                      const inGap = inOp && !season && !hasDailyOverride && isInSeasonGap(dateStr);
                      const seasonBgHex: Record<string, string> = {
                        Low: "#dcfce7",
                        Mid: "#fef9c3",
                        High: "#fee2e2",
                        Peak: "#fca5a5",
                      };
                      const cellBg = !inOp
                        ? "#f9fafb"
                        : hasDailyOverride
                          ? "#fefce8"
                          : inGap
                            ? "#fef2f2"
                            : isWeekend && season
                              ? "#fffbeb"
                              : season
                                ? seasonBgHex[season.tier] || "#f9fafb"
                                : "#ffffff";
                      const isEditing = editingDay === dateStr;
                      const dailyPriceWarning = visiblePriceWarningById.get(`daily:${dateStr}`);

                      cells.push(
                        <div
                          key={day}
                          className={`relative h-10 rounded-md flex flex-col items-center justify-center text-center transition-colors border cursor-pointer ${!inOp ? "opacity-40 border-gray-100" : dailyPriceWarning ? "border-amber-500 ring-1 ring-amber-300" : hasDailyOverride ? "border-amber-300 ring-1 ring-amber-200" : inGap ? "border-red-200" : "border-gray-100 hover:border-primary-300"}`}
                          style={{ backgroundColor: cellBg }}
                          title={
                            hasDailyOverride
                              ? `Daily override: ${formatCurrency(dailyRates[dateStr], form.currency || "EUR")} (click to edit, right-click to remove)`
                              : inGap
                                ? "No season — click to set a daily rate"
                                : "Click to set a daily rate override"
                          }
                          onClick={() => {
                            if (!inOp) return;
                            setEditingDay(dateStr);
                            setEditingDayValue(
                              hasDailyOverride
                                ? String(dailyRates[dateStr])
                                : displayRate > 0
                                  ? String(displayRate)
                                  : "",
                            );
                          }}
                          onContextMenu={(e) => {
                            if (!hasDailyOverride) return;
                            e.preventDefault();
                            const next = { ...dailyRates };
                            delete next[dateStr];
                            setDailyRates(next);
                          }}
                        >
                          {isEditing ? (
                            <input
                              type="number"
                              min={0}
                              autoFocus
                              value={editingDayValue}
                              onChange={(e) => setEditingDayValue(e.target.value)}
                              onBlur={() => {
                                const val = parseFloat(editingDayValue);
                                if (val > 0) {
                                  setDailyRates({ ...dailyRates, [dateStr]: val });
                                  markPriceWarningTouched(`daily:${dateStr}`);
                                } else {
                                  const next = { ...dailyRates };
                                  delete next[dateStr];
                                  setDailyRates(next);
                                }
                                setEditingDay(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") {
                                  setEditingDay(null);
                                }
                              }}
                              className="w-full h-full text-[9px] text-center bg-white border-0 outline-none focus:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <>
                              <span
                                className={`text-[10px] font-medium ${inGap ? "text-red-600" : isWeekend ? "text-orange-600" : "text-gray-700"}`}
                              >
                                {day}
                              </span>
                              {dailyPriceWarning && (
                                <span className="absolute right-1 top-0.5 text-[9px] font-bold text-amber-600">
                                  !
                                </span>
                              )}
                              {inOp && displayRate > 0 && (
                                <span
                                  className={`text-[8px] font-semibold ${hasDailyOverride ? "text-amber-600" : isWeekend ? "text-orange-600" : "text-emerald-600"}`}
                                >
                                  {formatCompactPrice(displayRate, form.currency || "EUR")}
                                </span>
                              )}
                              {inGap && (
                                <span className="text-[7px] font-semibold text-red-400">
                                  no price
                                </span>
                              )}
                            </>
                          )}
                        </div>,
                      );
                    }
                    return cells;
                  })()}
                </div>
              </div>

              {/* Daily overrides hint */}
              <div className="px-4 py-2 border-t border-gray-100 bg-gray-50/50">
                <p className="text-[9px] text-gray-400">
                  Click a date to set a daily price override. Right-click an override to remove it.
                </p>
                {Object.keys(dailyRates).length > 0 && (
                  <p className="text-[9px] text-amber-600 font-medium mt-0.5">
                    {Object.keys(dailyRates).length} daily override
                    {Object.keys(dailyRates).length !== 1 ? "s" : ""} set
                  </p>
                )}
                {visibleDailyPriceWarnings.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {visibleDailyPriceWarnings.map((warning) => (
                      <PriceWarningMessage
                        key={warning.id}
                        warning={warning}
                        currency={currency}
                        onDismiss={() => dismissPriceWarning(warning)}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Bottom legend */}
              <div className="px-4 py-2.5 border-t border-gray-100 flex items-center gap-3 flex-wrap">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#22c55e" }} />
                  <span className="text-[9px] text-gray-500">Low</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#eab308" }} />
                  <span className="text-[9px] text-gray-500">Mid</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
                  <span className="text-[9px] text-gray-500">High</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#991b1b" }} />
                  <span className="text-[9px] text-gray-500">Peak</span>
                </span>
                {parseInt(weekendSurcharge.replace(/[^0-9]/g, "")) > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#fbbf24" }} />
                    <span className="text-[9px] text-gray-500">Weekend +</span>
                  </span>
                )}
                {Object.keys(dailyRates).length > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#f59e0b" }} />
                    <span className="text-[9px] text-gray-500">Override</span>
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: "#d1d5db" }} />
                  <span className="text-[9px] text-gray-500">Closed</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Images & Amenities */}
      {activeTab === "media" && (
        <div className="space-y-4">
          {/* Room Images Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6">
            <ImageUpload
              images={form.images || []}
              onChange={(images) => updateForm({ images })}
              mediaResource={pmsRoomMediaResource(
                typeof window !== "undefined"
                  ? localStorage.getItem(SELECTED_PMS_PROPERTY_ID_KEY) || "pms_property_current"
                  : "pms_property_current",
                roomTypeId,
              )}
              maxImages={propertyPlan?.limits.maxRoomPhotosPerType ?? null}
              plan={propertyPlan?.plan ?? null}
              label="Room Images"
            />
          </div>

          {/* Features Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 md:gap-3 flex-wrap min-w-0">
                <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
                  Features
                </h3>
                <span className="hidden md:inline-block text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">
                  &rarr; Room card tags
                </span>
                <span className="hidden md:inline-block text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">
                  &rarr; Modal highlights
                </span>
              </div>
              <span className="shrink-0 text-[11px] font-medium text-primary-600">
                {(form.features || []).length} selected
              </span>
            </div>
            <p className="text-[10px] text-gray-400">
              What makes this room special — guests see these tags directly on the room listing.
              Choose the 3–6 most compelling highlights.
            </p>

            {/* Live Preview */}
            <div className="bg-gray-50 rounded-lg border border-gray-200 px-4 py-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                Live Preview — Room Card
              </p>
              <p className="text-[12px] font-semibold text-gray-900">
                {form.name || "Room name"}{" "}
                <span className="text-[11px] font-normal text-gray-400">
                  &middot; Up to {form.maxOccupancy} guests
                </span>
              </p>
              {(form.features || []).length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(form.features || []).slice(0, 5).map((f) => (
                    <span
                      key={f}
                      className="text-[10px] text-gray-600 border border-gray-200 bg-white rounded-full px-2 py-0.5"
                    >
                      {f}
                    </span>
                  ))}
                  {(form.features || []).length > 5 && (
                    <span className="text-[10px] text-gray-400 border border-gray-200 bg-white rounded-full px-2 py-0.5">
                      +{(form.features || []).length - 5} more
                    </span>
                  )}
                </div>
              ) : (
                <p className="text-[10px] text-gray-400 mt-1 italic">
                  Select features below to preview card tags...
                </p>
              )}
            </div>

            {/* Feature Categories */}
            {FEATURE_CATEGORIES.map((cat) => (
              <div key={cat.name}>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                  {cat.name}
                </p>
                <div className="flex flex-wrap gap-2">
                  {cat.items.map((item) => {
                    const isSelected = (form.features || []).includes(item.label);
                    return (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => {
                          const features = form.features || [];
                          if (isSelected) {
                            updateForm({ features: features.filter((f) => f !== item.label) });
                          } else {
                            updateForm({ features: [...features, item.label] });
                          }
                        }}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                          isSelected
                            ? "border-primary-300 bg-primary-50 text-primary-700"
                            : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        <span className="text-[13px]">{item.emoji}</span>
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            <p className="text-[10px] text-gray-400">
              {(form.features || []).length} features selected &middot; First 5 shown on card
            </p>
          </div>

          {/* Amenities Section */}
          <div className="bg-white rounded-xl border border-gray-200 px-4 py-5 md:px-6 md:py-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 md:gap-3 flex-wrap min-w-0">
                <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
                  Amenities
                </h3>
                <span className="hidden md:inline-block text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">
                  &rarr; Modal full list
                </span>
              </div>
              <span className="shrink-0 text-[11px] font-medium text-primary-600">
                {(form.amenities || []).length} selected
              </span>
            </div>
            <p className="text-[10px] text-gray-400">
              What&apos;s included — guests see these after clicking &quot;View Details&quot;. Group
              by category for easy scanning.
            </p>

            {/* Booking.com paste-import helper */}
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50/60 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setBookingImportOpen((o) => !o)}
                className="w-full flex items-center justify-between text-left"
              >
                <span className="text-[11px] font-semibold text-gray-700">
                  Paste amenities from Booking.com
                </span>
                <ChevronDownIcon
                  className={`w-3.5 h-3.5 text-gray-400 transition-transform ${bookingImportOpen ? "" : "-rotate-90"}`}
                />
              </button>
              {bookingImportOpen && (
                <div className="mt-2 space-y-2">
                  <p className="text-[10px] text-gray-500">
                    Copy the amenities list from a Booking.com listing and paste it here. We&apos;ll
                    match each item to the right category. Unmatched items can be kept as custom
                    amenities.
                  </p>
                  <textarea
                    value={bookingImportText}
                    onChange={(e) => setBookingImportText(e.target.value)}
                    rows={5}
                    placeholder="Free WiFi&#10;Flat-screen TV&#10;Air conditioning&#10;Safety deposit box&#10;..."
                    className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 font-mono"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={!bookingImportText.trim()}
                      onClick={() => {
                        const result = parseBookingAmenities(bookingImportText, AMENITY_CATEGORIES);
                        const current = form.amenities || [];
                        const before = current.length;
                        const merged = Array.from(
                          new Set([...current, ...result.matched.map((m) => m.amenity)]),
                        );
                        updateForm({ amenities: merged });
                        // Expand every category that received a new amenity, so users can see what was applied.
                        const touched = Array.from(new Set(result.matched.map((m) => m.category)));
                        setExpandedAmenityCategories((prev) =>
                          Array.from(new Set([...prev, ...touched])),
                        );
                        setBookingImportResult({
                          matchedCount: result.matched.length,
                          addedCount: merged.length - before,
                          fuzzy: result.matched
                            .filter((m) => m.source === "fuzzy")
                            .map((m) => ({ original: m.original, amenity: m.amenity })),
                          unmatched: result.unmatched,
                        });
                      }}
                      className="px-3 py-1.5 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-[11px] font-medium rounded-lg transition-colors"
                    >
                      Parse &amp; add
                    </button>
                    {(bookingImportText || bookingImportResult) && (
                      <button
                        type="button"
                        onClick={() => {
                          setBookingImportText("");
                          setBookingImportResult(null);
                        }}
                        className="px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-700"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {bookingImportResult && (
                    <div className="space-y-2 text-[11px]">
                      {bookingImportResult.matchedCount === 0 ? (
                        <p className="text-amber-700 font-medium">
                          No amenities matched — map the items below to an existing amenity, add
                          them as custom, or ignore them.
                        </p>
                      ) : (
                        <p className="text-gray-700">
                          Matched{" "}
                          <span className="font-semibold text-primary-700">
                            {bookingImportResult.matchedCount}
                          </span>{" "}
                          amenit{bookingImportResult.matchedCount === 1 ? "y" : "ies"}
                          {bookingImportResult.addedCount !== bookingImportResult.matchedCount && (
                            <>
                              {" "}
                              &middot;{" "}
                              <span className="font-semibold">
                                {bookingImportResult.addedCount}
                              </span>{" "}
                              newly added
                            </>
                          )}
                          {bookingImportResult.fuzzy.length > 0 && (
                            <>
                              {" "}
                              &middot;{" "}
                              <span className="font-semibold text-blue-700">
                                {bookingImportResult.fuzzy.length}
                              </span>{" "}
                              fuzzy
                            </>
                          )}
                          {bookingImportResult.unmatched.length > 0 && (
                            <>
                              {" "}
                              &middot;{" "}
                              <span className="font-semibold text-amber-700">
                                {bookingImportResult.unmatched.length}
                              </span>{" "}
                              unmatched
                            </>
                          )}
                        </p>
                      )}

                      {bookingImportResult.fuzzy.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-500 mb-1">
                            Fuzzy matches — review and remove any wrong guesses.
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {bookingImportResult.fuzzy.map((f) => {
                              const stillSelected = (form.amenities || []).includes(f.amenity);
                              return (
                                <span
                                  key={f.original + f.amenity}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border ${stillSelected ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-gray-50 text-gray-400 border-gray-200 line-through"}`}
                                >
                                  <span className="opacity-70">{f.original}</span>
                                  <span aria-hidden>&asymp;</span>
                                  {f.amenity}
                                  {stillSelected && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateForm({
                                          amenities: (form.amenities || []).filter(
                                            (a) => a !== f.amenity,
                                          ),
                                        })
                                      }
                                      className="text-blue-400 hover:text-blue-600"
                                    >
                                      <XMarkIcon className="w-3 h-3" />
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {bookingImportResult.unmatched.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-500 mb-1">
                            Add as a custom amenity, map to an existing one, or ignore.
                          </p>
                          <div className="space-y-1.5">
                            {bookingImportResult.unmatched.map((label) => {
                              const amenities = form.amenities || [];
                              const dropLabel = () =>
                                setBookingImportResult((r) =>
                                  r
                                    ? { ...r, unmatched: r.unmatched.filter((u) => u !== label) }
                                    : r,
                                );
                              return (
                                <div key={label} className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[11px] text-gray-700 font-medium">
                                    {label}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const fallbackCategory =
                                        AMENITY_CATEGORIES[AMENITY_CATEGORIES.length - 1].name;
                                      if (
                                        !amenities.some(
                                          (a) => a.toLowerCase() === label.toLowerCase(),
                                        )
                                      ) {
                                        updateForm({ amenities: [...amenities, label] });
                                        setCustomAmenitiesByCategory((prev) => ({
                                          ...prev,
                                          [fallbackCategory]: [
                                            ...(prev[fallbackCategory] || []),
                                            label,
                                          ],
                                        }));
                                        setExpandedAmenityCategories((prev) =>
                                          Array.from(new Set([...prev, fallbackCategory])),
                                        );
                                      }
                                      dropLabel();
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border bg-white text-amber-800 border-amber-300 hover:bg-amber-50"
                                  >
                                    <PlusIcon className="w-3 h-3" /> Custom
                                  </button>
                                  <select
                                    defaultValue=""
                                    onChange={(e) => {
                                      const amenity = e.target.value;
                                      if (!amenity) return;
                                      const cat = AMENITY_CATEGORIES.find((c) =>
                                        c.items.includes(amenity),
                                      );
                                      updateForm({
                                        amenities: Array.from(new Set([...amenities, amenity])),
                                      });
                                      if (cat)
                                        setExpandedAmenityCategories((prev) =>
                                          Array.from(new Set([...prev, cat.name])),
                                        );
                                      dropLabel();
                                    }}
                                    className="px-2 py-0.5 text-[11px] bg-white border border-gray-200 rounded-full text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                  >
                                    <option value="">Map to&hellip;</option>
                                    {AMENITY_CATEGORIES.map((c) => (
                                      <optgroup key={c.name} label={c.name}>
                                        {c.items.map((it) => (
                                          <option key={it} value={it}>
                                            {it}
                                          </option>
                                        ))}
                                      </optgroup>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={dropLabel}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-gray-500 hover:text-gray-700"
                                  >
                                    Ignore
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-1">
              {AMENITY_CATEGORIES.map((cat) => {
                const amenities = form.amenities || [];
                const customInCat = (customAmenitiesByCategory[cat.name] || []).filter((a) =>
                  amenities.includes(a),
                );
                const selectedCount =
                  cat.items.filter((item) => amenities.includes(item)).length + customInCat.length;
                const isExpanded = expandedAmenityCategories.includes(cat.name);
                const allSelected = selectedCount === cat.items.length;

                return (
                  <div key={cat.name} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        if (isExpanded) {
                          setExpandedAmenityCategories((prev) =>
                            prev.filter((c) => c !== cat.name),
                          );
                        } else {
                          setExpandedAmenityCategories((prev) => [...prev, cat.name]);
                        }
                      }}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ChevronDownIcon
                          className={`w-3.5 h-3.5 text-gray-400 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                        />
                        <span className="text-[12px] font-semibold text-gray-900">{cat.name}</span>
                      </div>
                      <span className="text-[11px] text-gray-400">{selectedCount} selected</span>
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (allSelected) {
                              updateForm({
                                amenities: amenities.filter((a) => !cat.items.includes(a)),
                              });
                            } else {
                              updateForm({
                                amenities: Array.from(new Set([...amenities, ...cat.items])),
                              });
                            }
                          }}
                          className="text-[11px] text-primary-600 font-medium hover:text-primary-700"
                        >
                          {allSelected ? "Deselect all" : "Select all"}
                        </button>

                        <div className="space-y-1.5">
                          {cat.items.map((item) => {
                            const isSelected = amenities.includes(item);
                            return (
                              <button
                                key={item}
                                type="button"
                                onClick={() => {
                                  if (isSelected) {
                                    updateForm({ amenities: amenities.filter((a) => a !== item) });
                                  } else {
                                    updateForm({ amenities: [...amenities, item] });
                                  }
                                }}
                                className="flex items-center gap-3 w-full text-left"
                              >
                                <div
                                  className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors ${
                                    isSelected
                                      ? "border-primary-500 bg-primary-500"
                                      : "border-gray-300"
                                  }`}
                                >
                                  {isSelected && <CheckIcon className="w-2.5 h-2.5 text-white" />}
                                </div>
                                <span className="text-[12px] text-gray-700">{item}</span>
                              </button>
                            );
                          })}
                        </div>

                        {/* Custom amenities in this category */}
                        {(customAmenitiesByCategory[cat.name] || []).filter((a) =>
                          amenities.includes(a),
                        ).length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            {(customAmenitiesByCategory[cat.name] || [])
                              .filter((a) => amenities.includes(a))
                              .map((a) => (
                                <span
                                  key={a}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200"
                                >
                                  {a}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      updateForm({ amenities: amenities.filter((x) => x !== a) });
                                      setCustomAmenitiesByCategory((prev) => ({
                                        ...prev,
                                        [cat.name]: (prev[cat.name] || []).filter((x) => x !== a),
                                      }));
                                    }}
                                    className="text-primary-400 hover:text-primary-600"
                                  >
                                    <XMarkIcon className="w-3 h-3" />
                                  </button>
                                </span>
                              ))}
                          </div>
                        )}

                        {/* Custom amenity input */}
                        <div className="flex gap-2 mt-2">
                          <input
                            type="text"
                            value={customAmenityInputs[cat.name] || ""}
                            onChange={(e) =>
                              setCustomAmenityInputs((prev) => ({
                                ...prev,
                                [cat.name]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                const trimmed = (customAmenityInputs[cat.name] || "").trim();
                                if (
                                  trimmed &&
                                  !amenities.some((a) => a.toLowerCase() === trimmed.toLowerCase())
                                ) {
                                  updateForm({ amenities: [...amenities, trimmed] });
                                  setCustomAmenitiesByCategory((prev) => ({
                                    ...prev,
                                    [cat.name]: [...(prev[cat.name] || []), trimmed],
                                  }));
                                  setCustomAmenityInputs((prev) => ({ ...prev, [cat.name]: "" }));
                                }
                              }
                            }}
                            className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                            placeholder="+ Add custom amenity..."
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const trimmed = (customAmenityInputs[cat.name] || "").trim();
                              if (
                                trimmed &&
                                !amenities.some((a) => a.toLowerCase() === trimmed.toLowerCase())
                              ) {
                                updateForm({ amenities: [...amenities, trimmed] });
                                setCustomAmenitiesByCategory((prev) => ({
                                  ...prev,
                                  [cat.name]: [...(prev[cat.name] || []), trimmed],
                                }));
                                setCustomAmenityInputs((prev) => ({ ...prev, [cat.name]: "" }));
                              }
                            }}
                            className="px-2 py-1.5 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                          >
                            <PlusIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Custom amenities not assigned to any category */}
            {(() => {
              const allPredefined = AMENITY_CATEGORIES.flatMap((c) => c.items);
              const allCustomTracked = Object.values(customAmenitiesByCategory).flat();
              const untracked = (form.amenities || []).filter(
                (a) => !allPredefined.includes(a) && !allCustomTracked.includes(a),
              );
              if (untracked.length === 0) return null;
              return (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {untracked.map((a) => (
                    <span
                      key={a}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200"
                    >
                      {a}
                      <button
                        type="button"
                        onClick={() =>
                          updateForm({ amenities: (form.amenities || []).filter((x) => x !== a) })
                        }
                        className="text-primary-400 hover:text-primary-600"
                      >
                        <XMarkIcon className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              );
            })()}

            <p className="text-[10px] text-gray-400">
              {(form.amenities || []).length} amenities selected &middot; Shown as &quot;View Full
              Amenities ({(form.amenities || []).length})&quot; in the room detail modal
            </p>
          </div>
        </div>
      )}

      {/* Submit / Cancel — sticky on mobile, inline on desktop */}
      <div className="mt-6 flex items-center justify-end gap-3 sticky bottom-0 -mx-4 md:mx-0 px-4 md:px-0 py-3 md:py-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-0 bg-gray-50/95 md:bg-transparent backdrop-blur md:backdrop-blur-none border-t border-gray-200 md:border-t-0 z-10">
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 md:flex-initial text-center px-4 py-2.5 md:py-2 text-[13px] md:text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 bg-white transition-colors"
          >
            {cancelLabel}
          </button>
        ) : (
          <Link
            href={cancelHref}
            className="flex-1 md:flex-initial text-center px-4 py-2.5 md:py-2 text-[13px] md:text-[12px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 bg-white transition-colors"
          >
            {cancelLabel}
          </Link>
        )}
        <button
          type="submit"
          disabled={
            saving ||
            overlappingSeasonIndices.size > 0 ||
            seasonGaps.length > 0 ||
            operatingPeriods.some((p) => p.from && p.to && p.to < p.from)
          }
          className="flex-1 md:flex-initial px-6 py-2.5 md:py-2 bg-primary-600 text-white text-[13px] md:text-[12px] font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : submitLabel}
        </button>
      </div>

      {confirmUnusualPricesOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/30 px-4">
          <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-4 shadow-xl">
            <h3 className="text-[13px] font-semibold text-gray-900">Some prices look unusual</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
              Some prices are unusually high or low. Save anyway?
            </p>
            <div className="mt-3 max-h-40 space-y-1.5 overflow-y-auto">
              {activePriceWarnings.slice(0, 4).map((warning) => (
                <p key={warning.id} className="text-[10px] text-amber-700">
                  <span className="font-semibold">{warning.label}</span>:{" "}
                  {formatCurrency(warning.value, currency)} vs{" "}
                  {formatCurrency(warning.baseline, currency)} usual rate
                </p>
              ))}
              {activePriceWarnings.length > 4 && (
                <p className="text-[10px] text-gray-400">
                  +{activePriceWarnings.length - 4} more warning
                  {activePriceWarnings.length - 4 === 1 ? "" : "s"}
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmUnusualPricesOpen(false)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  skipPriceWarningConfirmRef.current = true;
                  formRef.current?.requestSubmit();
                }}
                className="rounded-lg bg-primary-600 px-3 py-2 text-[11px] font-medium text-white hover:bg-primary-700"
              >
                Save anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
