"use client";

import { Fragment, RefObject, useState } from "react";
import {
  XMarkIcon,
  PlusIcon,
  CheckIcon,
  ChevronDownIcon,
  DocumentDuplicateIcon,
} from "@heroicons/react/24/outline";
import { getCurrencySymbol } from "./internal/currency";
import { parseBookingAmenities } from "./internal/parseBookingAmenities";

export type MealPlanCode = 1 | 3 | 4 | 9;
export interface MealPlan {
  code: MealPlanCode;
  surcharge: number;
  chargePer: "room" | "person";
}

export interface PartialRefundTier {
  minDaysBeforeCheckIn: number;
  refundPercent: number;
}

export interface RoomType {
  name: string;
  beds: { type: string; count: number }[];
  maxOccupancy: number;
  maxAdults: number | null;
  maxChildren: number | null;
  bedrooms: number;
  bathrooms: number;
  roomSize: string;
  totalRooms: number;
  description: string;
  category: string;
  baseRate: string;
  nonRefundableRate: string;
  nonRefundableDiscount: number;
  flexibleRateEnabled: boolean;
  flexibleCancellationType: "free" | "partial_refund";
  partialRefundCancelWindowDays: number;
  partialRefundAmountPercent: number;
  partialRefundTiers: PartialRefundTier[];
  nonRefundableEnabled: boolean;
  cancellationPolicy: string;
  nonRefundableCancellationPolicy: string;
  operatingPeriods: { from: string; to: string }[];
  seasons: {
    name: string;
    tier: string;
    from: string;
    to: string;
    rate: string;
    minStay: number;
    occupancyRates?: Record<string, string>;
  }[];
  weekendSurcharge: string;
  minimumAdvanceDays: number;
  mealPlans: MealPlan[];
  ratePaymentMethods: Record<string, string[]> | null;
  currency: string;
  images: string[];
  amenities: string[];
  features: string[];
}

export const MEAL_PLAN_OPTIONS: { code: MealPlanCode; label: string }[] = [
  { code: 1, label: "Breakfast included" },
  { code: 3, label: "Half board" },
  { code: 4, label: "Full board" },
  { code: 9, label: "All inclusive" },
];
export const MEAL_PLAN_LABEL: Record<MealPlanCode, string> = {
  1: "Breakfast included",
  3: "Half board",
  4: "Full board",
  9: "All inclusive",
};
const MEAL_PLAN_PREVIEW_GUESTS = 2;

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
            No tiers — every cancellation will be non-refundable. Add a tier to grant a refund.
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
    label: "Pay at property",
    hint: "Guest pays on arrival — cash or terminal",
  },
  {
    key: "bank_transfer",
    label: "Bank transfer",
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
          7
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
      <div className="ml-9 space-y-3">
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

export const createEmptyRoom = (): RoomType => ({
  name: "",
  beds: [{ type: "King Bed", count: 1 }],
  maxOccupancy: 2,
  maxAdults: null,
  maxChildren: null,
  bedrooms: 1,
  bathrooms: 1,
  roomSize: "",
  totalRooms: 2,
  description: "",
  category: "",
  baseRate: "",
  nonRefundableRate: "",
  nonRefundableDiscount: 5,
  flexibleRateEnabled: true,
  flexibleCancellationType: "free",
  partialRefundCancelWindowDays: 30,
  partialRefundAmountPercent: 50,
  partialRefundTiers: [{ minDaysBeforeCheckIn: 30, refundPercent: 50 }],
  nonRefundableEnabled: false,
  cancellationPolicy: "Free until 7 days before",
  nonRefundableCancellationPolicy: "Non-refundable from booking",
  operatingPeriods: [{ from: "01-01", to: "12-31" }],
  seasons: [],
  weekendSurcharge: "+0%",
  minimumAdvanceDays: 0,
  mealPlans: [],
  ratePaymentMethods: null,
  currency: "",
  images: [],
  amenities: [],
  features: [],
});

export const getRoomCompleteness = (room: RoomType): { done: number; total: number } => {
  let done = 0;
  const total = 3;
  if (room.name.trim() && room.maxOccupancy >= 1 && room.totalRooms >= 1) done++;
  if (room.seasons.some((s) => s.rate && Number(s.rate) > 0)) done++;
  if (room.images.length > 0) done++;
  return { done, total };
};

const MONTHS_STATIC = [
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
const DAYS_IN_MONTH_STATIC = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const hasSeasonCoverageGaps = (room: RoomType): boolean => {
  const toDoy = (dateStr: string) => {
    const [m, d] = dateStr.split("-").map(Number);
    return DAYS_IN_MONTH_STATIC.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
  };
  const periods = room.operatingPeriods.filter((p) => p.from && p.to && p.to >= p.from);
  const seasons = room.seasons.filter((s) => s.from && s.to && s.to >= s.from);
  if (periods.length === 0) return false;
  const open = new Set<number>();
  for (const p of periods) {
    const f = toDoy(p.from),
      t = toDoy(p.to);
    for (let d = f; d <= t; d++) open.add(d);
  }
  for (const s of seasons) {
    const f = toDoy(s.from),
      t = toDoy(s.to);
    for (let d = f; d <= t; d++) open.delete(d);
  }
  return open.size > 0;
};

export const BED_TYPES = [
  "King Bed",
  "Queen Bed",
  "Double Bed",
  "Twin Bed",
  "Single Bed",
  "Bunk Bed",
  "Sofa Bed",
];

export const ROOM_CATEGORIES = [
  "Standard",
  "Deluxe",
  "Superior",
  "Suite",
  "Villa",
  "Bungalow",
  "Studio",
  "Penthouse",
];

export const FEATURE_CATEGORIES = [
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

export const AMENITY_CATEGORIES = [
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

type RoomTab = "details" | "pricing" | "media" | "benefits";
export const ROOM_TABS: { key: RoomTab; label: string }[] = [
  { key: "details", label: "Room Details" },
  { key: "pricing", label: "Pricing & Rates" },
  { key: "media", label: "Images, Features & Amenities" },
];

interface RoomsStepProps {
  rooms: RoomType[];
  setRooms: (v: RoomType[] | ((prev: RoomType[]) => RoomType[])) => void;
  activeRoomIndex: number;
  setActiveRoomIndex: (v: number) => void;
  activeRoomTab: RoomTab;
  setActiveRoomTab: (v: RoomTab) => void;
  amenityInput: string;
  setAmenityInput: (v: string) => void;
  featureInput: string;
  setFeatureInput: (v: string) => void;
  roomFileInputRef: RefObject<HTMLInputElement>;
  uploadingRoomImages: boolean;
  roomImageUploadError?: string;
  handleRoomImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleRoomImageFiles?: (files: File[]) => void;
  currency: string;
  error: string;
  canProceed: boolean;
  onBack: () => void;
  onContinue: () => void;
  stepIndicators: React.ReactNode;
}

export default function RoomsStep({
  rooms,
  setRooms,
  activeRoomIndex,
  setActiveRoomIndex,
  activeRoomTab,
  setActiveRoomTab,
  roomFileInputRef,
  uploadingRoomImages,
  roomImageUploadError,
  handleRoomImageUpload,
  handleRoomImageFiles,
  currency,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
}: RoomsStepProps) {
  const room = rooms[activeRoomIndex];
  const updateRoom = (updates: Partial<RoomType>) => {
    const normalized = updates.seasons
      ? { ...updates, seasons: sortSeasonsChronologically(updates.seasons) }
      : updates;
    setRooms((prev: RoomType[]) =>
      prev.map((r: RoomType, i: number) => (i === activeRoomIndex ? { ...r, ...normalized } : r)),
    );
  };
  const mealPlans = room?.mealPlans ?? [];
  const addMealPlan = () => {
    const used = new Set(mealPlans.map((m) => m.code));
    const next = MEAL_PLAN_OPTIONS.find((o) => !used.has(o.code))?.code;
    if (next === undefined) return;
    updateRoom({ mealPlans: [...mealPlans, { code: next, surcharge: 0, chargePer: "room" }] });
  };
  const removeMealPlan = (idx: number) => {
    updateRoom({ mealPlans: mealPlans.filter((_, i) => i !== idx) });
  };
  const updateMealPlan = (idx: number, patch: Partial<MealPlan>) => {
    updateRoom({ mealPlans: mealPlans.map((m, i) => (i === idx ? { ...m, ...patch } : m)) });
  };
  const projectedMealPlanSurcharge = (mp: MealPlan): number =>
    mp.chargePer === "person" ? mp.surcharge * MEAL_PLAN_PREVIEW_GUESTS : mp.surcharge;
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
  const [previewMonth, setPreviewMonth] = useState(() => new Date());
  const [expandedOccupancy, setExpandedOccupancy] = useState<Record<number, boolean>>({});

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
  const getYearPercent = (dateStr: string): number => {
    if (!dateStr) return 0;
    const parts = dateStr.includes("-") ? dateStr.split("-") : [];
    let month: number, day: number;
    if (parts.length === 3) {
      month = parseInt(parts[1]);
      day = parseInt(parts[2]);
    } else if (parts.length === 2) {
      month = parseInt(parts[0]);
      day = parseInt(parts[1]);
    } else return 0;
    const dayOfYear = DAYS_IN_MONTH.slice(0, month - 1).reduce((a, b) => a + b, 0) + day;
    return (dayOfYear / 366) * 100;
  };
  const isEndBeforeStart = (from: string, to: string): boolean => {
    if (!from || !to) return false;
    return to < from;
  };
  const getUncoveredDays = (): string | null => {
    const periods = room.operatingPeriods.filter(
      (p) => p.from && p.to && !isEndBeforeStart(p.from, p.to),
    );
    const seasons = room.seasons.filter((s) => s.from && s.to && !isEndBeforeStart(s.from, s.to));
    if (periods.length === 0) return null;
    const toDoy = (dateStr: string) => {
      const [m, d] = dateStr.split("-").map(Number);
      return DAYS_IN_MONTH.slice(0, m - 1).reduce((a, b) => a + b, 0) + d;
    };
    const toDateLabel = (doy: number) => {
      let d = doy;
      for (let m = 0; m < 12; m++) {
        if (d <= DAYS_IN_MONTH[m]) return `${MONTHS[m]} ${d}`;
        d -= DAYS_IN_MONTH[m];
      }
      return `Dec 31`;
    };
    const open = new Set<number>();
    for (const p of periods) {
      const f = toDoy(p.from),
        t = toDoy(p.to);
      for (let d = f; d <= t; d++) open.add(d);
    }
    for (const s of seasons) {
      const f = toDoy(s.from),
        t = toDoy(s.to);
      for (let d = f; d <= t; d++) open.delete(d);
    }
    if (open.size === 0) return null;
    const sorted = Array.from(open).sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0],
      prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === prev + 1) {
        prev = sorted[i];
        continue;
      }
      ranges.push(
        start === prev ? toDateLabel(start) : `${toDateLabel(start)} – ${toDateLabel(prev)}`,
      );
      if (i < sorted.length) {
        start = sorted[i];
        prev = sorted[i];
      }
    }
    return ranges.join(", ");
  };
  const uncoveredDays = getUncoveredDays();

  return (
    <div className="flex-1 overflow-auto">
      <div
        className={`mx-auto px-4 sm:px-6 py-6 ${activeRoomTab === "pricing" ? "max-w-6xl" : "max-w-4xl"}`}
      >
        {stepIndicators}
        <div className="mb-5">
          <h2 className="text-[18px] font-bold text-gray-900">Rooms & Rates</h2>
          <p className="text-[12px] text-gray-500 mt-1">
            Configure your room types. Each room maps directly to a card guests see on the booking
            page.
          </p>
        </div>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Room Sidebar */}
          <div className="w-full md:w-48 md:shrink-0">
            <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest mb-3">
              Your Rooms
            </h3>
            <div className="space-y-2 mb-3">
              {rooms.map((r, idx) => {
                const { done, total } = getRoomCompleteness(r);
                return (
                  <div
                    key={idx}
                    onClick={() => {
                      setActiveRoomIndex(idx);
                      setActiveRoomTab("details");
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer group ${
                      activeRoomIndex === idx
                        ? "border-primary-500 bg-primary-50/30"
                        : "border-gray-200 bg-white hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[14px]">{"\uD83C\uDFE8"}</span>
                      <span className="text-[12px] font-medium text-gray-900 truncate flex-1">
                        {r.name || `Room ${idx + 1}`}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const clone = {
                            ...r,
                            name: r.name + " (Copy)",
                            images: [...r.images],
                            amenities: [...r.amenities],
                            features: [...r.features],
                            beds: r.beds.map((b) => ({ ...b })),
                            seasons: r.seasons.map((s) => ({
                              ...s,
                              occupancyRates: { ...(s.occupancyRates || {}) },
                            })),
                            operatingPeriods: r.operatingPeriods.map((p) => ({ ...p })),
                          };
                          setRooms((prev: RoomType[]) => [...prev, clone]);
                          setActiveRoomIndex(rooms.length);
                          setActiveRoomTab("details");
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-primary-600 transition-all"
                        title="Duplicate"
                      >
                        <DocumentDuplicateIcon className="w-3.5 h-3.5" />
                      </button>
                      {rooms.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const newRooms = rooms.filter((_, i) => i !== idx);
                            setRooms(newRooms);
                            if (activeRoomIndex >= newRooms.length)
                              setActiveRoomIndex(newRooms.length - 1);
                            else if (activeRoomIndex > idx) setActiveRoomIndex(activeRoomIndex - 1);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-all"
                        >
                          <XMarkIcon className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-1 mt-1.5 ml-6">
                      {Array.from({ length: total }).map((_, di) => (
                        <div
                          key={di}
                          className={`w-1.5 h-1.5 rounded-full ${di < done ? "bg-primary-500" : "bg-gray-300"}`}
                        />
                      ))}
                      <span className="text-[10px] text-gray-400 ml-1">
                        {done}/{total}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => {
                const newRoom = createEmptyRoom();
                newRoom.currency = currency;
                setRooms((prev: RoomType[]) => [...prev, newRoom]);
                setActiveRoomIndex(rooms.length);
                setActiveRoomTab("details");
              }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-dashed border-gray-300 rounded-lg text-[12px] text-gray-500 font-medium hover:border-gray-400 hover:bg-gray-50 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" /> Add Room Type
            </button>
          </div>

          {/* Room Content */}
          <div className="flex-1 min-w-0">
            {/* Room Tabs */}
            <div className="flex gap-6 mb-6 border-b border-gray-200">
              {ROOM_TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveRoomTab(tab.key)}
                  className={`pb-2.5 text-[12px] font-medium transition-colors relative ${
                    activeRoomTab === tab.key
                      ? "text-gray-900"
                      : "text-gray-400 hover:text-gray-600"
                  }`}
                >
                  {tab.label}
                  {activeRoomTab === tab.key && (
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gray-900 rounded-full" />
                  )}
                </button>
              ))}
            </div>

            {/* Room Details Tab */}
            {activeRoomTab === "details" && (
              <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-5">
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
                    value={room.name}
                    onChange={(e) => updateRoom({ name: e.target.value })}
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
                    {room.beds.map((bed, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <select
                          value={bed.type}
                          onChange={(e) => {
                            const updated = [...room.beds];
                            updated[idx] = { ...updated[idx], type: e.target.value };
                            updateRoom({ beds: updated });
                          }}
                          className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                          style={{
                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                            backgroundRepeat: "no-repeat",
                            backgroundPosition: "right 12px center",
                          }}
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
                            const updated = [...room.beds];
                            updated[idx] = {
                              ...updated[idx],
                              count: Math.max(1, Number(e.target.value)),
                            };
                            updateRoom({ beds: updated });
                          }}
                          className="w-16 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                        />
                        {room.beds.length > 1 && (
                          <button
                            onClick={() =>
                              updateRoom({ beds: room.beds.filter((_, i) => i !== idx) })
                            }
                            className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <XMarkIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() =>
                      updateRoom({ beds: [...room.beds, { type: "King Bed", count: 1 }] })
                    }
                    className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-gray-700 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <PlusIcon className="w-3.5 h-3.5" /> Add Bed
                  </button>
                </div>

                {/* Occupancy */}
                <div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-[12px] font-semibold text-gray-900">
                          Total max occupancy <span className="text-red-500">*</span>
                        </label>
                      </div>
                      <input
                        type="number"
                        min={1}
                        value={room.maxOccupancy}
                        onChange={(e) =>
                          updateRoom({ maxOccupancy: Math.max(1, Number(e.target.value)) })
                        }
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-[12px] font-semibold text-gray-900">
                          Max adults
                        </label>
                      </div>
                      <input
                        type="number"
                        min={1}
                        placeholder="Any"
                        value={room.maxAdults ?? ""}
                        onChange={(e) =>
                          updateRoom({
                            maxAdults:
                              e.target.value === "" ? null : Math.max(1, Number(e.target.value)),
                          })
                        }
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                      />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="text-[12px] font-semibold text-gray-900">
                          Max children
                        </label>
                      </div>
                      <input
                        type="number"
                        min={0}
                        placeholder="Any"
                        value={room.maxChildren ?? ""}
                        onChange={(e) =>
                          updateRoom({
                            maxChildren:
                              e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                          })
                        }
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                      />
                    </div>
                  </div>
                </div>

                {/* Bedrooms, Bathrooms, Room Size, Total Rooms */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <label className="text-[12px] font-semibold text-gray-900">Bedrooms</label>
                    </div>
                    <input
                      type="number"
                      min={0}
                      value={room.bedrooms}
                      onChange={(e) =>
                        updateRoom({ bedrooms: Math.max(0, Number(e.target.value)) })
                      }
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                    />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <label className="text-[12px] font-semibold text-gray-900">Bathrooms</label>
                    </div>
                    <input
                      type="number"
                      min={0}
                      value={room.bathrooms}
                      onChange={(e) =>
                        updateRoom({ bathrooms: Math.max(0, Number(e.target.value)) })
                      }
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
                      value={room.roomSize}
                      onChange={(e) =>
                        updateRoom({
                          roomSize: String(
                            Math.max(1, Math.min(parseInt(e.target.value) || 1, 15000)),
                          ),
                        })
                      }
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
                      value={room.totalRooms}
                      onChange={(e) =>
                        updateRoom({ totalRooms: Math.max(1, Number(e.target.value)) })
                      }
                      className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                    />
                    <p className="text-[10px] text-gray-400 mt-1 pl-3">
                      Number of units available for this room type
                    </p>
                  </div>
                </div>

                {/* Room Description */}
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <label className="text-[12px] font-semibold text-gray-900">
                      Room Description
                    </label>
                  </div>
                  <textarea
                    value={room.description}
                    onChange={(e) => updateRoom({ description: e.target.value })}
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
                    <label className="text-[12px] font-semibold text-gray-900">
                      Room Category Tag
                    </label>
                  </div>
                  <select
                    value={room.category}
                    onChange={(e) => updateRoom({ category: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 appearance-none"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                      backgroundRepeat: "no-repeat",
                      backgroundPosition: "right 12px center",
                    }}
                  >
                    <option value="">Select category</option>
                    {ROOM_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Pricing & Rates Tab */}
            {activeRoomTab === "pricing" && (
              <div className="flex gap-6">
                {/* Left Column: Sections */}
                <div className="flex-1 space-y-8 min-w-0">
                  {/* Section 1: When are you open? */}
                  <div>
                    <div className="flex items-start gap-3 mb-1">
                      <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                        1
                      </span>
                      <div>
                        <h3 className="text-[13px] font-semibold text-gray-900">
                          When are you open?
                        </h3>
                        <p className="text-[11px] text-gray-400">
                          Operating periods repeat every year — dates outside are automatically
                          closed
                        </p>
                      </div>
                    </div>
                    <div className="ml-9">
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
                          {room.operatingPeriods.map((period, idx) => {
                            const start = period.from ? getYearPercent(period.from) : 0;
                            const end = period.to ? getYearPercent(period.to) : 100;
                            const colors = [
                              "bg-primary-200",
                              "bg-amber-200",
                              "bg-emerald-200",
                              "bg-rose-200",
                            ];
                            return (
                              <div
                                key={idx}
                                className={`absolute top-0 h-full ${colors[idx % colors.length]} flex items-center justify-center`}
                                style={{ left: `${start}%`, width: `${Math.max(end - start, 1)}%` }}
                              >
                                <span className="text-[9px] font-semibold text-gray-700 truncate px-1">
                                  {idx === 0 && end - start > 90
                                    ? "Year Round"
                                    : `Period ${idx + 1}`}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <div className="space-y-2">
                        {room.operatingPeriods.map((period, idx) => {
                          const fromMonth = period.from ? parseInt(period.from.split("-")[0]) : 0;
                          const fromDay = period.from ? parseInt(period.from.split("-")[1]) : 0;
                          const toMonth = period.to ? parseInt(period.to.split("-")[0]) : 0;
                          const toDay = period.to ? parseInt(period.to.split("-")[1]) : 0;
                          const updatePeriod = (
                            field: "from" | "to",
                            month: number,
                            day: number,
                          ) => {
                            const updated = [...room.operatingPeriods];
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
                            updateRoom({ operatingPeriods: updated });
                          };
                          const periodInvalid = isEndBeforeStart(period.from, period.to);
                          return (
                            <div key={idx}>
                              <div className="flex items-center gap-2">
                                <div className="flex items-center gap-1">
                                  <select
                                    value={fromDay}
                                    onChange={(e) =>
                                      updatePeriod("from", fromMonth, parseInt(e.target.value) || 0)
                                    }
                                    className={`w-[52px] px-1.5 py-1.5 bg-white border ${periodInvalid ? "border-red-300" : "border-gray-200"} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
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
                                    className={`w-[68px] px-1.5 py-1.5 bg-white border ${periodInvalid ? "border-red-300" : "border-gray-200"} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
                                  >
                                    <option value={0}>—</option>
                                    {MONTHS.map((m, i) => (
                                      <option key={m} value={i + 1}>
                                        {m}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <span className="text-[10px] text-gray-400">to</span>
                                <div className="flex items-center gap-1">
                                  <select
                                    value={toDay}
                                    onChange={(e) =>
                                      updatePeriod("to", toMonth, parseInt(e.target.value) || 0)
                                    }
                                    className={`w-[52px] px-1.5 py-1.5 bg-white border ${periodInvalid ? "border-red-300" : "border-gray-200"} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
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
                                    className={`w-[68px] px-1.5 py-1.5 bg-white border ${periodInvalid ? "border-red-300" : "border-gray-200"} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
                                  >
                                    <option value={0}>—</option>
                                    {MONTHS.map((m, i) => (
                                      <option key={m} value={i + 1}>
                                        {m}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                {room.operatingPeriods.length > 1 && (
                                  <button
                                    onClick={() =>
                                      updateRoom({
                                        operatingPeriods: room.operatingPeriods.filter(
                                          (_, i) => i !== idx,
                                        ),
                                      })
                                    }
                                    className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                                  >
                                    <XMarkIcon className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                              {periodInvalid && (
                                <p className="text-[11px] text-red-600 font-medium mt-1">
                                  End date must be after start date.
                                </p>
                              )}
                            </div>
                          );
                        })}
                        <button
                          onClick={() =>
                            updateRoom({
                              operatingPeriods: [...room.operatingPeriods, { from: "", to: "" }],
                            })
                          }
                          className="inline-flex items-center gap-1 text-[10px] text-gray-500 font-medium px-2.5 py-1 rounded-md hover:bg-gray-100 transition-colors"
                        >
                          <PlusIcon className="w-3 h-3" /> Add period
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
                          Set seasons with rates — they repeat automatically every year
                        </p>
                      </div>
                    </div>
                    <div className="ml-9">
                      {room.seasons.length === 0 ? (
                        <div className="rounded-xl border border-gray-200 bg-gray-50/50 px-5 py-6 text-center">
                          <p className="text-[11px] text-gray-400">
                            No seasons yet. Add one below.
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {(() => {
                            const overlapIdx = new Set<number>();
                            for (let i = 0; i < room.seasons.length; i++) {
                              for (let j = i + 1; j < room.seasons.length; j++) {
                                const a = room.seasons[i],
                                  b = room.seasons[j];
                                if (
                                  a.from &&
                                  a.to &&
                                  b.from &&
                                  b.to &&
                                  a.from <= b.to &&
                                  b.from <= a.to
                                ) {
                                  overlapIdx.add(i);
                                  overlapIdx.add(j);
                                }
                              }
                            }
                            return room.seasons.map((season, idx) => {
                              const tierColors: Record<string, string> = {
                                Low: "text-emerald-600 bg-emerald-50 border-emerald-200",
                                Mid: "text-yellow-700 bg-yellow-50 border-yellow-200",
                                High: "text-red-600 bg-red-50 border-red-200",
                                Peak: "text-red-900 bg-red-100 border-red-300",
                              };
                              const dayCount =
                                season.from && season.to
                                  ? (() => {
                                      const [fm, fd] = season.from.split("-").map(Number);
                                      const [tm, td] = season.to.split("-").map(Number);
                                      const fromDoy =
                                        DAYS_IN_MONTH.slice(0, fm - 1).reduce((a, b) => a + b, 0) +
                                        fd;
                                      const toDoy =
                                        DAYS_IN_MONTH.slice(0, tm - 1).reduce((a, b) => a + b, 0) +
                                        td;
                                      return Math.max(0, toDoy - fromDoy);
                                    })()
                                  : 0;
                              return (
                                <div
                                  key={idx}
                                  className={`rounded-xl border px-4 py-3 ${overlapIdx.has(idx) ? "border-red-300 bg-red-50/50" : "border-gray-200 bg-gray-50/50"}`}
                                >
                                  <div className="flex items-center gap-2 mb-2">
                                    <input
                                      type="text"
                                      value={season.name}
                                      onChange={(e) => {
                                        const u = [...room.seasons];
                                        u[idx] = { ...u[idx], name: e.target.value };
                                        updateRoom({ seasons: u });
                                      }}
                                      placeholder="Season name"
                                      className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 placeholder-gray-400"
                                    />
                                    <div className="flex items-center gap-2 shrink-0">
                                      <select
                                        value={season.tier}
                                        onChange={(e) => {
                                          const u = [...room.seasons];
                                          u[idx] = { ...u[idx], tier: e.target.value as any };
                                          updateRoom({ seasons: u });
                                        }}
                                        className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border appearance-none cursor-pointer ${tierColors[season.tier] || "text-gray-600 bg-gray-100 border-gray-200"}`}
                                        style={{
                                          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                                          backgroundRepeat: "no-repeat",
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
                                        onClick={() =>
                                          updateRoom({
                                            seasons: room.seasons.filter((_, i) => i !== idx),
                                          })
                                        }
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
                                  <div className="flex items-center gap-2">
                                    {(() => {
                                      const sFromMonth = season.from
                                        ? parseInt(season.from.split("-")[0])
                                        : 0;
                                      const sFromDay = season.from
                                        ? parseInt(season.from.split("-")[1])
                                        : 0;
                                      const sToMonth = season.to
                                        ? parseInt(season.to.split("-")[0])
                                        : 0;
                                      const sToDay = season.to
                                        ? parseInt(season.to.split("-")[1])
                                        : 0;
                                      const updateSeason = (
                                        field: "from" | "to",
                                        month: number,
                                        day: number,
                                      ) => {
                                        const u = [...room.seasons];
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
                                        updateRoom({ seasons: u });
                                      };
                                      const seasonInvalid = isEndBeforeStart(
                                        season.from,
                                        season.to,
                                      );
                                      const borderCls = seasonInvalid
                                        ? "border-red-300"
                                        : "border-gray-200";
                                      return (
                                        <>
                                          <div className="flex items-center gap-1">
                                            <select
                                              value={sFromDay}
                                              onChange={(e) =>
                                                updateSeason(
                                                  "from",
                                                  sFromMonth,
                                                  parseInt(e.target.value) || 0,
                                                )
                                              }
                                              className={`w-[52px] px-1.5 py-2 bg-white border ${borderCls} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
                                            >
                                              <option value={0}>—</option>
                                              {Array.from(
                                                {
                                                  length: sFromMonth
                                                    ? DAYS_IN_MONTH[sFromMonth - 1]
                                                    : 31,
                                                },
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
                                                updateSeason(
                                                  "from",
                                                  parseInt(e.target.value) || 0,
                                                  sFromDay,
                                                )
                                              }
                                              className={`w-[68px] px-1.5 py-2 bg-white border ${borderCls} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
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
                                                updateSeason(
                                                  "to",
                                                  sToMonth,
                                                  parseInt(e.target.value) || 0,
                                                )
                                              }
                                              className={`w-[52px] px-1.5 py-2 bg-white border ${borderCls} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
                                            >
                                              <option value={0}>—</option>
                                              {Array.from(
                                                {
                                                  length: sToMonth
                                                    ? DAYS_IN_MONTH[sToMonth - 1]
                                                    : 31,
                                                },
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
                                                updateSeason(
                                                  "to",
                                                  parseInt(e.target.value) || 0,
                                                  sToDay,
                                                )
                                              }
                                              className={`w-[68px] px-1.5 py-2 bg-white border ${borderCls} rounded-lg text-[11px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent`}
                                            >
                                              <option value={0}>—</option>
                                              {MONTHS.map((m, i) => (
                                                <option key={m} value={i + 1}>
                                                  {m}
                                                </option>
                                              ))}
                                            </select>
                                          </div>
                                          {seasonInvalid ? (
                                            <span className="text-[10px] text-red-600 font-medium shrink-0">
                                              End date must be after start date
                                            </span>
                                          ) : (
                                            dayCount > 0 && (
                                              <span className="text-[10px] text-gray-400 shrink-0">
                                                {dayCount}d
                                              </span>
                                            )
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}
                      {(() => {
                        const hasOverlap = room.seasons.some((a, i) =>
                          room.seasons.some(
                            (b, j) =>
                              i < j &&
                              a.from &&
                              a.to &&
                              b.from &&
                              b.to &&
                              a.from <= b.to &&
                              b.from <= a.to,
                          ),
                        );
                        return hasOverlap ? (
                          <p className="mt-2 text-[11px] text-red-600 font-medium">
                            Season date ranges must not overlap. Please adjust the highlighted
                            seasons.
                          </p>
                        ) : null;
                      })()}
                      {uncoveredDays && (
                        <p className="mt-2 text-[11px] text-amber-600 font-medium">
                          Some operating days have no season pricing: {uncoveredDays}. All open days
                          must be covered by a season.
                        </p>
                      )}
                      <button
                        onClick={() =>
                          updateRoom({
                            seasons: [
                              ...room.seasons,
                              {
                                name: "",
                                tier: "",
                                from: "",
                                to: "",
                                rate: "",
                                minStay: 1,
                                occupancyRates: {},
                              },
                            ],
                          })
                        }
                        className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gray-600 font-medium px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
                      >
                        <PlusIcon className="w-3.5 h-3.5" /> Add season
                      </button>

                      {/* Set rates per season table */}
                      {room.seasons.length > 0 && (
                        <div className="mt-4">
                          <p className="text-[11px] font-semibold text-gray-700 mb-2">
                            Set rates per season
                          </p>
                          <table className="w-full">
                            <thead>
                              <tr className="text-[10px] text-gray-400">
                                <th className="text-left pb-2 font-medium">Season</th>
                                <th className="text-left pb-2 font-medium">Flex Rate</th>
                                <th className="text-left pb-2 font-medium">Min Stay</th>
                              </tr>
                            </thead>
                            <tbody>
                              {room.seasons.map((season, idx) => {
                                const tierColors: Record<string, string> = {
                                  Low: "text-emerald-600 bg-emerald-50",
                                  Mid: "text-yellow-700 bg-yellow-50",
                                  High: "text-red-600 bg-red-50",
                                  Peak: "text-red-900 bg-red-100",
                                };
                                const maxOcc = room.maxOccupancy ?? 2;
                                const hasOccRates = Object.values(season.occupancyRates || {}).some(
                                  (v) => v !== "" && v !== undefined,
                                );
                                const isOccExpanded = expandedOccupancy[idx] || false;
                                return (
                                  <Fragment key={idx}>
                                    <tr className="border-t border-gray-100">
                                      <td className="py-2.5">
                                        <div className="flex items-center gap-2">
                                          <span
                                            className={`text-[10px] font-semibold px-2 py-0.5 rounded ${tierColors[season.tier] || "text-gray-600 bg-gray-100"}`}
                                          >
                                            {season.tier || "—"}
                                          </span>
                                          {season.name ? (
                                            <span className="text-[12px] text-gray-700">
                                              {season.name}
                                            </span>
                                          ) : (
                                            <span className="text-gray-300">&mdash;</span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="py-2.5">
                                        <div className="flex items-center gap-1">
                                          <span className="text-[11px] text-gray-400">
                                            {getCurrencySymbol(currency || "USD")}
                                          </span>
                                          <input
                                            type="number"
                                            value={season.rate}
                                            onChange={(e) => {
                                              const u = [...room.seasons];
                                              u[idx] = { ...u[idx], rate: e.target.value };
                                              updateRoom({ seasons: u });
                                            }}
                                            className="w-20 px-2 py-1 bg-white border border-gray-200 rounded text-[12px] font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                                          />
                                        </div>
                                      </td>
                                      <td className="py-2.5">
                                        <div className="flex items-center gap-3">
                                          <div className="inline-flex items-center gap-0 border border-gray-200 rounded overflow-hidden">
                                            <button
                                              onClick={() => {
                                                const u = [...room.seasons];
                                                u[idx] = {
                                                  ...u[idx],
                                                  minStay: Math.max(1, (season.minStay || 1) - 1),
                                                };
                                                updateRoom({ seasons: u });
                                              }}
                                              className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 text-[11px]"
                                            >
                                              &minus;
                                            </button>
                                            <span className="px-2 py-1 text-[11px] font-semibold text-gray-900 bg-white min-w-[28px] text-center">
                                              {season.minStay || 1}
                                            </span>
                                            <button
                                              onClick={() => {
                                                const u = [...room.seasons];
                                                u[idx] = {
                                                  ...u[idx],
                                                  minStay: (season.minStay || 1) + 1,
                                                };
                                                updateRoom({ seasons: u });
                                              }}
                                              className="px-1.5 py-1 text-gray-500 hover:bg-gray-100 text-[11px]"
                                            >
                                              +
                                            </button>
                                          </div>
                                          {maxOcc > 1 && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                setExpandedOccupancy((prev) => ({
                                                  ...prev,
                                                  [idx]: !prev[idx],
                                                }))
                                              }
                                              className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded transition-colors ${hasOccRates ? "text-primary-600 bg-primary-50 hover:bg-primary-100" : "text-gray-500 hover:bg-gray-100"}`}
                                            >
                                              <ChevronDownIcon
                                                className={`w-3 h-3 transition-transform ${isOccExpanded ? "" : "-rotate-90"}`}
                                              />
                                              Per person
                                            </button>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                    {isOccExpanded && maxOcc > 1 && (
                                      <tr className="border-t border-gray-50 bg-gray-50/50">
                                        <td colSpan={3} className="py-2.5 pl-6">
                                          <div className="space-y-1.5">
                                            <span className="text-[10px] text-gray-400 font-medium">
                                              Rate per number of persons
                                            </span>
                                            {Array.from({ length: maxOcc }, (_, i) => i + 1).map(
                                              (guestCount) => {
                                                const isAnchor = guestCount === 1;
                                                const occRate =
                                                  (season.occupancyRates || {})[
                                                    String(guestCount)
                                                  ] || "";
                                                const prevRaw =
                                                  guestCount === 2
                                                    ? season.rate
                                                    : (season.occupancyRates || {})[
                                                        String(guestCount - 1)
                                                      ] || season.rate;
                                                const prevNum = Number(prevRaw);
                                                const currNum = Number(occRate);
                                                const decreasing =
                                                  !isAnchor &&
                                                  occRate !== "" &&
                                                  prevRaw !== "" &&
                                                  Number.isFinite(prevNum) &&
                                                  Number.isFinite(currNum) &&
                                                  currNum < prevNum;
                                                return (
                                                  <div
                                                    key={guestCount}
                                                    className="flex flex-col gap-0.5"
                                                  >
                                                    <div className="flex items-center gap-2">
                                                      <span className="text-[11px] text-gray-500 w-16">
                                                        {guestCount}{" "}
                                                        {guestCount === 1 ? "person" : "people"}
                                                      </span>
                                                      <span className="text-gray-400 text-[11px]">
                                                        {getCurrencySymbol(currency || "USD")}
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
                                                            const u = [...room.seasons];
                                                            const occ = {
                                                              ...(u[idx].occupancyRates || {}),
                                                            };
                                                            if (e.target.value === "") {
                                                              delete occ[String(guestCount)];
                                                            } else {
                                                              occ[String(guestCount)] =
                                                                e.target.value;
                                                            }
                                                            u[idx] = {
                                                              ...u[idx],
                                                              occupancyRates: occ,
                                                            };
                                                            updateRoom({ seasons: u });
                                                          }}
                                                          className={`w-20 px-2 py-1 bg-white border rounded text-[11px] text-gray-900 focus:outline-none focus:ring-2 ${decreasing ? "border-amber-300 focus:ring-amber-400" : "border-gray-200 focus:ring-primary-500"}`}
                                                          placeholder={
                                                            season.rate || "same as rate"
                                                          }
                                                          min="0"
                                                        />
                                                      )}
                                                    </div>
                                                    {decreasing && (
                                                      <span className="text-[10px] text-amber-600 font-medium pl-[4.5rem]">
                                                        Lower than {guestCount - 1}-person rate (
                                                        {getCurrencySymbol(currency || "USD")}
                                                        {prevRaw})
                                                      </span>
                                                    )}
                                                  </div>
                                                );
                                              },
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Section 3: What can guests book? (Rate Plans) */}
                  <div>
                    <div className="flex items-start gap-3 mb-1">
                      <span className="w-6 h-6 rounded-full bg-primary-500 text-white text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                        3
                      </span>
                      <div>
                        <h3 className="text-[13px] font-semibold text-gray-900">
                          What can guests book?
                        </h3>
                        <p className="text-[11px] text-gray-400">Select at least one rate plan</p>
                      </div>
                    </div>
                    <div className="ml-9 space-y-2.5">
                      {/* Flexible Rate */}
                      <div
                        className={`rounded-xl border px-4 py-3.5 transition-colors ${room.flexibleRateEnabled ? "border-primary-200 bg-primary-50/30" : "border-gray-200 bg-gray-50"}`}
                      >
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() =>
                              updateRoom({ flexibleRateEnabled: !room.flexibleRateEnabled })
                            }
                            className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${room.flexibleRateEnabled ? "bg-primary-500" : "bg-gray-300"}`}
                          >
                            <div
                              className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${room.flexibleRateEnabled ? "left-[20px]" : "left-[2px]"}`}
                            />
                          </button>
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
                          <span className="text-[12px] font-semibold text-gray-900">
                            Flexible rate
                          </span>
                          <span className="text-[11px] text-gray-400">
                            {room.flexibleCancellationType === "partial_refund"
                              ? "(partial refund)"
                              : "(free cancellation)"}
                          </span>
                        </div>
                        {room.flexibleRateEnabled && (
                          <div className="mt-3 ml-[52px] space-y-3">
                            <div>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                                Cancellation type
                              </div>
                              <div className="inline-flex gap-2">
                                <button
                                  onClick={() => updateRoom({ flexibleCancellationType: "free" })}
                                  className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors border ${room.flexibleCancellationType === "free" ? "bg-primary-50 border-primary-500 text-primary-600" : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"}`}
                                >
                                  Free cancellation
                                </button>
                                <button
                                  onClick={() =>
                                    updateRoom({ flexibleCancellationType: "partial_refund" })
                                  }
                                  className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition-colors border ${room.flexibleCancellationType === "partial_refund" ? "bg-primary-50 border-primary-500 text-primary-600" : "bg-white border-gray-200 text-gray-500 hover:border-gray-300"}`}
                                >
                                  Partial refund
                                </button>
                              </div>
                            </div>
                            {room.flexibleCancellationType === "free" && (
                              <div className="flex items-center gap-3">
                                <span className="text-[11px] text-gray-500">
                                  Cancellation policy:
                                </span>
                                <select
                                  value={room.cancellationPolicy}
                                  onChange={(e) =>
                                    updateRoom({ cancellationPolicy: e.target.value })
                                  }
                                  className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                                  style={{
                                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                                    backgroundRepeat: "no-repeat",
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
                            {room.flexibleCancellationType === "partial_refund" && (
                              <PartialRefundTiersEditor
                                tiers={room.partialRefundTiers}
                                onChange={(next) => updateRoom({ partialRefundTiers: next })}
                              />
                            )}
                          </div>
                        )}
                      </div>

                      {/* Non-refundable */}
                      <div
                        className={`rounded-xl border px-4 py-3.5 transition-colors ${room.nonRefundableEnabled ? "border-amber-200 bg-amber-50/30" : "border-gray-200 bg-gray-50"}`}
                      >
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() =>
                              updateRoom({ nonRefundableEnabled: !room.nonRefundableEnabled })
                            }
                            className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${room.nonRefundableEnabled ? "bg-primary-500" : "bg-gray-300"}`}
                          >
                            <div
                              className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform ${room.nonRefundableEnabled ? "left-[20px]" : "left-[2px]"}`}
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
                          <span className="text-[12px] font-semibold text-gray-900">
                            Non-refundable
                          </span>
                          <span className="text-[11px] text-gray-400">
                            (discount for no cancellation)
                          </span>
                        </div>
                        {room.nonRefundableEnabled && (
                          <div className="mt-3 ml-[52px] flex items-center gap-3">
                            <span className="text-[11px] text-gray-500">Cancellation policy:</span>
                            <select
                              value={room.nonRefundableCancellationPolicy}
                              onChange={(e) =>
                                updateRoom({ nonRefundableCancellationPolicy: e.target.value })
                              }
                              className="flex-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                              style={{
                                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                                backgroundRepeat: "no-repeat",
                                backgroundPosition: "right 10px center",
                              }}
                            >
                              <option>Non-refundable from booking</option>
                              <option>Cancel within 24 hours of booking</option>
                              <option>Cancel within 48 hours of booking</option>
                              <option>Cancel within 7 days of booking</option>
                            </select>
                          </div>
                        )}
                        {room.nonRefundableEnabled && room.flexibleRateEnabled && (
                          <div className="mt-3 ml-[52px] flex items-center gap-3">
                            <span className="text-[11px] text-gray-500">Discount:</span>
                            <div className="inline-flex items-center gap-0 border border-gray-200 rounded-lg overflow-hidden">
                              <button
                                onClick={() =>
                                  updateRoom({
                                    nonRefundableDiscount: Math.max(
                                      1,
                                      room.nonRefundableDiscount - 1,
                                    ),
                                  })
                                }
                                className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                              >
                                &minus;
                              </button>
                              <input
                                type="number"
                                min="1"
                                max="50"
                                value={room.nonRefundableDiscount}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  if (!isNaN(val))
                                    updateRoom({
                                      nonRefundableDiscount: Math.max(1, Math.min(50, val)),
                                    });
                                }}
                                className="w-12 py-1.5 text-[12px] font-semibold text-gray-900 bg-white text-center focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              />
                              <span className="text-[12px] font-semibold text-gray-500 pr-1">
                                %
                              </span>
                              <button
                                onClick={() =>
                                  updateRoom({
                                    nonRefundableDiscount: Math.min(
                                      50,
                                      room.nonRefundableDiscount + 1,
                                    ),
                                  })
                                }
                                className="px-2 py-1.5 text-gray-500 hover:bg-gray-100 transition-colors text-[12px] font-medium"
                              >
                                +
                              </button>
                            </div>
                            <span className="text-[11px] text-gray-500">off flexible rate</span>
                          </div>
                        )}
                        {room.nonRefundableEnabled && !room.flexibleRateEnabled && (
                          <p className="mt-3 ml-[52px] text-[11px] text-gray-500">
                            Set your base rate in the seasons table below &mdash; this will be used
                            as the non-refundable price.
                          </p>
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
                          Each meal plan creates an additional bookable rate on your booking engine
                          and OTA channels
                        </p>
                      </div>
                    </div>
                    <div className="ml-9 space-y-2.5">
                      {mealPlans.map((mp, idx) => {
                        const symbol = getCurrencySymbol(room.currency || currency || "EUR");
                        const usedCodes = new Set(
                          mealPlans
                            .map((m, i) => (i === idx ? null : m.code))
                            .filter((c) => c !== null) as MealPlanCode[],
                        );
                        const availableOptions = MEAL_PLAN_OPTIONS.filter(
                          (o) => o.code === mp.code || !usedCodes.has(o.code),
                        );
                        const label = MEAL_PLAN_LABEL[mp.code];
                        const projected = projectedMealPlanSurcharge(mp);
                        const baseSeasonRate =
                          parseFloat(room.seasons[0]?.rate || "") ||
                          parseFloat(room.baseRate || "") ||
                          0;
                        return (
                          <div
                            key={idx}
                            className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3"
                          >
                            <div className="flex items-center gap-3">
                              <div className="relative w-10 h-[22px] rounded-full bg-primary-500 shrink-0">
                                <div className="absolute top-[2px] left-[20px] w-[18px] h-[18px] rounded-full bg-white shadow" />
                              </div>
                              <select
                                value={mp.code}
                                onChange={(e) =>
                                  updateMealPlan(idx, {
                                    code: parseInt(e.target.value, 10) as MealPlanCode,
                                  })
                                }
                                className="flex-1 max-w-[260px] px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] font-medium focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent text-gray-900 appearance-none"
                                style={{
                                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239CA3AF' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                                  backgroundRepeat: "no-repeat",
                                  backgroundPosition: "right 10px center",
                                }}
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

                            {room.seasons.length > 0 && baseSeasonRate > 0 && mp.surcharge > 0 && (
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
                                    {room.seasons.map((s, sIdx) => {
                                      const base =
                                        parseFloat(s.rate || "") ||
                                        parseFloat(room.baseRate || "") ||
                                        0;
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
                                  * Calculated for {MEAL_PLAN_PREVIEW_GUESTS} guests &middot;{" "}
                                  {label} surcharge: {symbol}
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
                    <div className="ml-9 flex flex-wrap items-center gap-2">
                      {["+0%", "+10%", "+15%", "+20%"].map((opt) => (
                        <button
                          key={opt}
                          onClick={() => updateRoom({ weekendSurcharge: opt })}
                          className={`px-4 py-1.5 rounded-full text-[11px] font-medium border transition-colors ${
                            room.weekendSurcharge === opt
                              ? "bg-primary-500 text-white border-primary-500"
                              : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                      {!["+0%", "+10%", "+15%", "+20%"].includes(room.weekendSurcharge) ? (
                        <div className="flex items-center gap-1">
                          <span className="text-[11px] text-gray-500">+</span>
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={room.weekendSurcharge.replace(/[^0-9]/g, "")}
                            onChange={(e) =>
                              updateRoom({ weekendSurcharge: `+${e.target.value}%` })
                            }
                            className="w-14 px-2 py-1.5 bg-white border border-primary-500 rounded-full text-[11px] text-center font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                            autoFocus
                          />
                          <span className="text-[11px] text-gray-500">%</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => updateRoom({ weekendSurcharge: "+%" })}
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
                    <div className="ml-9 flex items-center gap-2">
                      <input
                        type="number"
                        min="0"
                        max="365"
                        value={room.minimumAdvanceDays ?? 0}
                        onChange={(e) =>
                          updateRoom({
                            minimumAdvanceDays: Math.max(0, parseInt(e.target.value) || 0),
                          })
                        }
                        className="w-20 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-[12px] text-center font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      />
                      <span className="text-[11px] text-gray-500">days before check-in</span>
                      <span className="text-[10px] text-gray-400 ml-2">(0 = no restriction)</span>
                    </div>
                  </div>

                  {/* Section 7: Allowed payment methods per rate */}
                  <RatePaymentMethodsSection
                    value={room.ratePaymentMethods ?? null}
                    flexibleRateEnabled={room.flexibleRateEnabled}
                    nonRefundableEnabled={room.nonRefundableEnabled}
                    onChange={(next) => updateRoom({ ratePaymentMethods: next })}
                  />
                </div>

                {/* Right Column: LIVE RATE PREVIEW */}
                <div className="hidden lg:block w-[340px] shrink-0">
                  <div className="bg-white rounded-xl border border-gray-200 p-5 sticky top-4">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px]">&#x1F4C5;</span>
                        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                          LIVE RATE PREVIEW
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() =>
                            setPreviewMonth((prev) => {
                              const d = new Date(prev);
                              d.setMonth(d.getMonth() - 1);
                              return d;
                            })
                          }
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <polyline points="15 18 9 12 15 6" />
                          </svg>
                        </button>
                        <span className="text-[12px] font-semibold text-gray-900 min-w-[100px] text-center">
                          {previewMonth.toLocaleString("en", { month: "long", year: "numeric" })}
                        </span>
                        <button
                          onClick={() =>
                            setPreviewMonth((prev) => {
                              const d = new Date(prev);
                              d.setMonth(d.getMonth() + 1);
                              return d;
                            })
                          }
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Season legend */}
                    {room.seasons.length > 0 && (
                      <div className="mb-4 p-3 bg-gray-50 rounded-lg space-y-1">
                        {room.seasons.map((s, i) => {
                          const flexRate = parseFloat(s.rate) || 0;
                          const nrRate = Math.round(
                            flexRate * (1 - room.nonRefundableDiscount / 100),
                          );
                          const dotColorHex: Record<string, string> = {
                            Low: "#10b981",
                            Mid: "#eab308",
                            High: "#ef4444",
                            Peak: "#7f1d1d",
                          };
                          const fromDate = s.from ? new Date(s.from) : null;
                          const toDate = s.to ? new Date(s.to) : null;
                          return (
                            <div key={i} className="flex items-center gap-2 text-[11px]">
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: dotColorHex[s.tier] || "#9ca3af" }}
                              />
                              <span className="font-medium text-gray-700">{s.tier}</span>
                              <span className="text-gray-400">&middot;</span>
                              <span className="text-gray-500">
                                {fromDate
                                  ? fromDate.toLocaleDateString("en", {
                                      month: "short",
                                      day: "numeric",
                                    })
                                  : "?"}{" "}
                                &ndash;{" "}
                                {toDate
                                  ? toDate.toLocaleDateString("en", {
                                      month: "short",
                                      day: "numeric",
                                    })
                                  : "?"}
                              </span>
                              <span className="text-gray-400">&middot;</span>
                              <span className="font-bold text-gray-900">
                                {getCurrencySymbol(currency || "USD")}
                                {flexRate}/night
                              </span>
                              {room.nonRefundableEnabled && room.flexibleRateEnabled && (
                                <span className="text-gray-400">
                                  NR: {getCurrencySymbol(currency || "USD")}
                                  {nrRate}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Calendar Grid */}
                    {(() => {
                      const year = previewMonth.getFullYear();
                      const month = previewMonth.getMonth();
                      const firstDay = new Date(year, month, 1);
                      const lastDay = new Date(year, month + 1, 0);
                      const startDow = (firstDay.getDay() + 6) % 7;
                      const daysInMonth = lastDay.getDate();
                      const weeks: (number | null)[][] = [];
                      let week: (number | null)[] = Array(startDow).fill(null);
                      for (let d = 1; d <= daysInMonth; d++) {
                        week.push(d);
                        if (week.length === 7) {
                          weeks.push(week);
                          week = [];
                        }
                      }
                      if (week.length > 0) {
                        while (week.length < 7) week.push(null);
                        weeks.push(week);
                      }

                      const getSeasonForDate = (day: number) => {
                        const date = new Date(year, month, day);
                        const dateStr = date.toISOString().split("T")[0];
                        for (const s of room.seasons) {
                          if (s.from && s.to && dateStr >= s.from && dateStr <= s.to) return s;
                        }
                        return null;
                      };

                      const isInOperatingPeriod = (day: number) => {
                        const date = new Date(year, month, day);
                        const dateStr = date.toISOString().split("T")[0];
                        return room.operatingPeriods.some(
                          (p) => p.from && p.to && dateStr >= p.from && dateStr <= p.to,
                        );
                      };

                      const isWeekend = (day: number) => {
                        const date = new Date(year, month, day);
                        const dow = date.getDay();
                        return dow === 5 || dow === 6;
                      };

                      const surchargePercent =
                        parseFloat(room.weekendSurcharge.replace(/[^0-9.]/g, "")) || 0;

                      const seasonBgColors: Record<string, string> = {
                        Low: "#ecfdf5",
                        Mid: "#fefce8",
                        High: "#fef2f2",
                        Peak: "#fee2e2",
                      };
                      const weekendBgColor = "#fffbeb";
                      const closedBgColor = "#f3f4f6";

                      return (
                        <div>
                          <div className="grid grid-cols-7 mb-1">
                            {["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((d, i) => (
                              <div
                                key={d}
                                className={`text-[9px] font-semibold text-center py-1 ${i >= 4 ? "text-orange-500" : "text-gray-400"}`}
                              >
                                {d}
                              </div>
                            ))}
                          </div>
                          {weeks.map((week, wi) => (
                            <div key={wi} className="grid grid-cols-7">
                              {week.map((day, di) => {
                                if (day === null) return <div key={di} className="p-1" />;
                                const season = getSeasonForDate(day);
                                const open = isInOperatingPeriod(day);
                                const wknd = isWeekend(day);
                                const flexRate = season ? parseFloat(season.rate) || 0 : 0;
                                const effectiveRate = wknd
                                  ? Math.round(flexRate * (1 + surchargePercent / 100))
                                  : flexRate;
                                const nrRate = Math.round(
                                  effectiveRate * (1 - room.nonRefundableDiscount / 100),
                                );
                                const cellBg = !open
                                  ? closedBgColor
                                  : wknd && season
                                    ? weekendBgColor
                                    : season
                                      ? seasonBgColors[season.tier] || "#f9fafb"
                                      : "#ffffff";

                                return (
                                  <div
                                    key={di}
                                    className="p-1 border border-gray-50 min-h-[52px] rounded"
                                    style={{ backgroundColor: cellBg }}
                                  >
                                    <div
                                      className={`text-[10px] font-semibold ${wknd && open ? "text-orange-600" : "text-gray-700"}`}
                                    >
                                      {day}
                                    </div>
                                    {open && season && (
                                      <>
                                        <div
                                          className={`text-[9px] font-bold ${wknd ? "text-orange-600" : "text-emerald-600"}`}
                                        >
                                          {getCurrencySymbol(currency || "USD")}
                                          {effectiveRate}
                                        </div>
                                        {room.nonRefundableEnabled && room.flexibleRateEnabled && (
                                          <div className="text-[9px] font-bold text-amber-600">
                                            {getCurrencySymbol(currency || "USD")}
                                            {nrRate}{" "}
                                            <span className="text-[7px] font-normal text-amber-500">
                                              NR
                                            </span>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                          {/* Legend */}
                          <div className="flex flex-wrap gap-3 mt-3 text-[9px] text-gray-500">
                            <span className="flex items-center gap-1">
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: "#10b981" }}
                              />{" "}
                              Low
                            </span>
                            <span className="flex items-center gap-1">
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: "#eab308" }}
                              />{" "}
                              Mid
                            </span>
                            <span className="flex items-center gap-1">
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: "#ef4444" }}
                              />{" "}
                              High
                            </span>
                            <span className="flex items-center gap-1">
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: "#7f1d1d" }}
                              />{" "}
                              Peak
                            </span>
                            {surchargePercent > 0 && (
                              <span className="flex items-center gap-1">
                                <span
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: "#fbbf24" }}
                                />{" "}
                                Weekend+
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <span
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: "#d1d5db" }}
                              />{" "}
                              Closed
                            </span>
                            {room.nonRefundableEnabled && room.flexibleRateEnabled && (
                              <span className="flex items-center gap-1">
                                <span
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: "#f59e0b" }}
                                />{" "}
                                NR rate
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}

            {/* Images & Amenities Tab */}
            {activeRoomTab === "media" && (
              <div className="space-y-4">
                {/* Room Images Section */}
                <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
                      Room Images
                    </h3>
                    <span className="text-[11px] font-medium text-amber-600">
                      Strongly recommended
                    </span>
                  </div>

                  {room.images.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {room.images.map((url, idx) => (
                        <div
                          key={idx}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", String(idx));
                            (e.currentTarget as HTMLElement).style.opacity = "0.5";
                          }}
                          onDragEnd={(e) => {
                            (e.currentTarget as HTMLElement).style.opacity = "1";
                          }}
                          onDragOver={(e) => {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).style.borderColor = "#6366f1";
                          }}
                          onDragLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.borderColor = "";
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).style.borderColor = "";
                            const fromIdx = parseInt(e.dataTransfer.getData("text/plain"));
                            if (fromIdx === idx || isNaN(fromIdx)) return;
                            const reordered = [...room.images];
                            const [moved] = reordered.splice(fromIdx, 1);
                            reordered.splice(idx, 0, moved);
                            updateRoom({ images: reordered });
                          }}
                          className="relative w-24 h-24 rounded-lg overflow-hidden border-2 border-gray-200 cursor-grab active:cursor-grabbing"
                        >
                          <img
                            src={url}
                            alt={`Room ${idx + 1}`}
                            className="w-full h-full object-cover pointer-events-none"
                          />
                          {idx === 0 && (
                            <span className="absolute bottom-1 left-1 text-[8px] font-bold text-white bg-black/50 px-1.5 py-0.5 rounded">
                              Cover
                            </span>
                          )}
                          <button
                            onClick={() =>
                              updateRoom({ images: room.images.filter((_, i) => i !== idx) })
                            }
                            className="absolute top-1 right-1 w-5 h-5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center"
                          >
                            <XMarkIcon className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => roomFileInputRef.current?.click()}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "copy";
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (uploadingRoomImages) return;
                      const files = Array.from(e.dataTransfer.files).filter((file) =>
                        file.type.startsWith("image/"),
                      );
                      if (files.length > 0) {
                        handleRoomImageFiles?.(files);
                      }
                    }}
                    disabled={uploadingRoomImages}
                    className="w-full border-2 border-dashed border-gray-300 rounded-xl py-8 flex flex-col items-center justify-center gap-2 text-gray-400 hover:border-gray-400 hover:bg-gray-50/50 transition-colors"
                  >
                    {uploadingRoomImages ? (
                      <div className="w-8 h-8 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <svg
                          className="w-10 h-10 text-gray-300"
                          viewBox="0 0 48 48"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        >
                          <rect x="6" y="6" width="36" height="36" rx="4" />
                          <path d="M6 34l10-10 8 8 6-6 12 12" />
                          <circle cx="18" cy="18" r="3" />
                          <path d="M34 6v8h8" strokeLinecap="round" />
                        </svg>
                        <span className="text-[12px] font-semibold text-gray-700">
                          Upload room photos — drag to reorder
                        </span>
                        <span className="text-[11px] text-gray-400 italic">
                          First image = card cover photo · All images appear in modal gallery
                        </span>
                      </>
                    )}
                  </button>
                  <input
                    ref={roomFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleRoomImageUpload}
                    className="hidden"
                  />

                  {roomImageUploadError && (
                    <p className="text-[11px] font-medium text-red-600">{roomImageUploadError}</p>
                  )}

                  <p className="text-[10px] text-gray-400">
                    Shown in: room listing card (left side) · &quot;View Details&quot; modal with
                    prev/next navigation · thumbnail strip at bottom of modal
                  </p>
                </div>

                {/* Features Section */}
                <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
                        Features
                      </h3>
                      <span className="text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">
                        &rarr; Room card tags
                      </span>
                      <span className="text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">
                        &rarr; Modal highlights
                      </span>
                    </div>
                    <span className="text-[11px] font-medium text-primary-600">
                      {room.features.length} selected
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-400">
                    What makes this room special — guests see these tags directly on the room
                    listing. Choose the 3–6 most compelling highlights.
                  </p>

                  {/* Live Preview */}
                  <div className="bg-gray-50 rounded-lg border border-gray-200 px-4 py-3">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">
                      Live Preview — Room Card
                    </p>
                    <p className="text-[12px] font-semibold text-gray-900">
                      {room.name || "Room name"}{" "}
                      <span className="text-[11px] font-normal text-gray-400">
                        &middot; Up to {room.maxOccupancy} guests
                      </span>
                    </p>
                    {room.features.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {room.features.slice(0, 5).map((f) => (
                          <span
                            key={f}
                            className="text-[10px] text-gray-600 border border-gray-200 bg-white rounded-full px-2 py-0.5"
                          >
                            {f}
                          </span>
                        ))}
                        {room.features.length > 5 && (
                          <span className="text-[10px] text-gray-400 border border-gray-200 bg-white rounded-full px-2 py-0.5">
                            +{room.features.length - 5} more
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
                          const isSelected = room.features.includes(item.label);
                          return (
                            <button
                              key={item.label}
                              onClick={() => {
                                if (isSelected) {
                                  updateRoom({
                                    features: room.features.filter((f) => f !== item.label),
                                  });
                                } else {
                                  updateRoom({ features: [...room.features, item.label] });
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
                    {room.features.length} features selected &middot; First 5 shown on card
                  </p>
                </div>

                {/* Amenities Section */}
                <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest">
                        Amenities
                      </h3>
                      <span className="text-[10px] text-gray-400 px-2 py-0.5 bg-gray-100 rounded-full">
                        &rarr; Modal full list
                      </span>
                    </div>
                    <span className="text-[11px] font-medium text-primary-600">
                      {room.amenities.length} selected
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-400">
                    What&apos;s included — guests see these after clicking &quot;View Details&quot;.
                    Group by category for easy scanning.
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
                          Copy the amenities list from a Booking.com listing and paste it here.
                          We&apos;ll match each item to the right category — close-but-different
                          names are fuzzy-matched and flagged for review. Unmatched items can be
                          added as custom amenities, mapped to an existing one, or ignored.
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
                              const result = parseBookingAmenities(
                                bookingImportText,
                                AMENITY_CATEGORIES,
                              );
                              const before = room.amenities.length;
                              const merged = Array.from(
                                new Set([
                                  ...room.amenities,
                                  ...result.matched.map((m) => m.amenity),
                                ]),
                              );
                              updateRoom({ amenities: merged });
                              const touched = Array.from(
                                new Set(result.matched.map((m) => m.category)),
                              );
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
                                No amenities matched — map the items below to an existing amenity,
                                add them as custom, or ignore them.
                              </p>
                            ) : (
                              <p className="text-gray-700">
                                Matched{" "}
                                <span className="font-semibold text-primary-700">
                                  {bookingImportResult.matchedCount}
                                </span>{" "}
                                amenit{bookingImportResult.matchedCount === 1 ? "y" : "ies"}
                                {bookingImportResult.addedCount !==
                                  bookingImportResult.matchedCount && (
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
                                    const stillSelected = room.amenities.includes(f.amenity);
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
                                              updateRoom({
                                                amenities: room.amenities.filter(
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
                                    const dropLabel = () =>
                                      setBookingImportResult((r) =>
                                        r
                                          ? {
                                              ...r,
                                              unmatched: r.unmatched.filter((u) => u !== label),
                                            }
                                          : r,
                                      );
                                    return (
                                      <div
                                        key={label}
                                        className="flex items-center gap-2 flex-wrap"
                                      >
                                        <span className="text-[11px] text-gray-700 font-medium">
                                          {label}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => {
                                            const fallbackCategory =
                                              AMENITY_CATEGORIES[AMENITY_CATEGORIES.length - 1]
                                                .name;
                                            if (
                                              !room.amenities.some(
                                                (a) => a.toLowerCase() === label.toLowerCase(),
                                              )
                                            ) {
                                              updateRoom({ amenities: [...room.amenities, label] });
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
                                            updateRoom({
                                              amenities: Array.from(
                                                new Set([...room.amenities, amenity]),
                                              ),
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
                      const selectedCount = cat.items.filter((item) =>
                        room.amenities.includes(item),
                      ).length;
                      const isExpanded = expandedAmenityCategories.includes(cat.name);
                      const allSelected = selectedCount === cat.items.length;

                      return (
                        <div
                          key={cat.name}
                          className="border border-gray-200 rounded-lg overflow-hidden"
                        >
                          <button
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
                              <span className="text-[12px] font-semibold text-gray-900">
                                {cat.name}
                              </span>
                            </div>
                            <span className="text-[11px] text-gray-400">
                              {selectedCount} selected
                            </span>
                          </button>

                          {isExpanded && (
                            <div className="px-4 pb-4 space-y-2">
                              <button
                                type="button"
                                onClick={() => {
                                  if (allSelected) {
                                    updateRoom({
                                      amenities: room.amenities.filter(
                                        (a) => !cat.items.includes(a),
                                      ),
                                    });
                                  } else {
                                    updateRoom({
                                      amenities: Array.from(
                                        new Set([...room.amenities, ...cat.items]),
                                      ),
                                    });
                                  }
                                }}
                                className="text-[11px] text-primary-600 font-medium hover:text-primary-700"
                              >
                                {allSelected ? "Deselect all" : "Select all"}
                              </button>

                              <div className="space-y-1.5">
                                {cat.items.map((item) => {
                                  const isSelected = room.amenities.includes(item);
                                  return (
                                    <button
                                      type="button"
                                      key={item}
                                      onClick={() => {
                                        if (isSelected) {
                                          updateRoom({
                                            amenities: room.amenities.filter((a) => a !== item),
                                          });
                                        } else {
                                          updateRoom({ amenities: [...room.amenities, item] });
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
                                        {isSelected && (
                                          <CheckIcon className="w-2.5 h-2.5 text-white" />
                                        )}
                                      </div>
                                      <span className="text-[12px] text-gray-700">{item}</span>
                                    </button>
                                  );
                                })}
                              </div>

                              {/* Custom amenity input */}
                              {/* Custom amenities in this category */}
                              {(customAmenitiesByCategory[cat.name] || []).filter((a) =>
                                room.amenities.includes(a),
                              ).length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-1">
                                  {(customAmenitiesByCategory[cat.name] || [])
                                    .filter((a) => room.amenities.includes(a))
                                    .map((a) => (
                                      <span
                                        key={a}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200"
                                      >
                                        {a}
                                        <button
                                          type="button"
                                          onClick={() => {
                                            updateRoom({
                                              amenities: room.amenities.filter((x) => x !== a),
                                            });
                                            setCustomAmenitiesByCategory((prev) => ({
                                              ...prev,
                                              [cat.name]: (prev[cat.name] || []).filter(
                                                (x) => x !== a,
                                              ),
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
                                      if (trimmed && !room.amenities.includes(trimmed)) {
                                        updateRoom({ amenities: [...room.amenities, trimmed] });
                                        setCustomAmenitiesByCategory((prev) => ({
                                          ...prev,
                                          [cat.name]: [...(prev[cat.name] || []), trimmed],
                                        }));
                                      }
                                      setCustomAmenityInputs((prev) => ({
                                        ...prev,
                                        [cat.name]: "",
                                      }));
                                    }
                                  }}
                                  className="flex-1 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-[11px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
                                  placeholder="+ Add custom amenity..."
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    const trimmed = (customAmenityInputs[cat.name] || "").trim();
                                    if (trimmed && !room.amenities.includes(trimmed)) {
                                      updateRoom({ amenities: [...room.amenities, trimmed] });
                                      setCustomAmenitiesByCategory((prev) => ({
                                        ...prev,
                                        [cat.name]: [...(prev[cat.name] || []), trimmed],
                                      }));
                                    }
                                    setCustomAmenityInputs((prev) => ({ ...prev, [cat.name]: "" }));
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

                  {/* Custom / mapped amenities not assigned to any category */}
                  {(() => {
                    const allPredefined = AMENITY_CATEGORIES.flatMap((c) => c.items);
                    const allCustomTracked = Object.values(customAmenitiesByCategory).flat();
                    const untracked = room.amenities.filter(
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
                                updateRoom({ amenities: room.amenities.filter((x) => x !== a) })
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
                    {room.amenities.length} amenities selected &middot; Shown as &quot;View Full
                    Amenities ({room.amenities.length})&quot; in the room detail modal
                  </p>
                </div>
              </div>
            )}

            {error && (
              <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-[11px] text-red-700 font-medium">{error}</p>
              </div>
            )}
          </div>
          {/* close Room Content */}
        </div>
        {/* close flex sidebar+content */}

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => {
              const tabIndex = ROOM_TABS.findIndex((t) => t.key === activeRoomTab);
              if (tabIndex > 0) {
                setActiveRoomTab(ROOM_TABS[tabIndex - 1].key);
              } else {
                onBack();
              }
            }}
            className="px-5 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
          <div className="flex items-center gap-3">
            {(() => {
              const incomplete = rooms.filter(
                (r) => !(r.name.trim() && r.maxOccupancy >= 1 && r.totalRooms >= 1),
              ).length;
              return incomplete > 0 ? (
                <span className="text-[11px] text-amber-600 font-medium">
                  {incomplete} room{incomplete > 1 ? "s" : ""} incomplete
                </span>
              ) : null;
            })()}
            <button
              onClick={() => {
                const tabIndex = ROOM_TABS.findIndex((t) => t.key === activeRoomTab);
                if (tabIndex < ROOM_TABS.length - 1) {
                  setActiveRoomTab(ROOM_TABS[tabIndex + 1].key);
                } else {
                  onContinue();
                }
              }}
              disabled={!canProceed}
              className="px-5 py-2 bg-primary-500 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
