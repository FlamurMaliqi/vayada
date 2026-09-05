"use client";

import { useEffect, useState } from "react";
import { BoltIcon, SunIcon, MoonIcon, CalendarDaysIcon } from "@heroicons/react/24/outline";
import {
  getBookingLastMinuteSettings,
  updateBookingLastMinuteSettings,
  type BookingPromotion,
  type BookingLastMinuteSettings,
} from "@/services/api/bookingLastMinuteSettingsClient";
import type { PromoRoomType } from "./PromoCodesTab";
import PromotionForm, { names, fresh } from "./PromotionForm";

const icons = {
  LAST_MINUTE: BoltIcon,
  EARLY_BIRD: SunIcon,
  EXTENDED_STAY: MoonIcon,
  MIDWEEK: CalendarDaysIcon,
};
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const types = Object.keys(names) as BookingPromotion["type"][];
const button =
  "rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium disabled:opacity-50";

function summary(p: BookingPromotion) {
  if (p.type === "LAST_MINUTE")
    return p.tiers.length
      ? p.tiers
          .map((t) => `${t.daysBeforeMin}–${t.daysBeforeMax ?? "∞"} days: ${t.discountPercent}%`)
          .join("; ")
      : `Check-in within ${p.threshold} days`;
  if (p.type === "EARLY_BIRD") return `Book ${p.threshold}+ days ahead`;
  if (p.type === "EXTENDED_STAY") return `Stay ${p.threshold}+ nights`;
  return p.weekdays.map((day) => weekdays[day]).join(", ");
}

export default function Promotions({
  hotelId,
  roomTypes,
}: {
  hotelId: string;
  roomTypes: PromoRoomType[];
}) {
  const [settings, setSettings] = useState<BookingLastMinuteSettings | null>(null);
  const [promotions, setPromotions] = useState<BookingPromotion[]>([]);
  const [draft, setDraft] = useState<BookingPromotion | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setSettings(null);
    getBookingLastMinuteSettings({ hotelId })
      .then((value) => {
        if (!current) return;
        setSettings(value);
        setPromotions(
          value.promotions ??
            (value.enabled && value.tiers.length
              ? [{ ...fresh("LAST_MINUTE"), tiers: value.tiers }]
              : []),
        );
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [hotelId]);

  async function save(next: BookingPromotion[]) {
    if (!settings || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = await updateBookingLastMinuteSettings({
        hotelId,
        body: {
          enabled: settings.enabled,
          stackWithPromo: settings.stackWithPromo,
          tiers: settings.tiers,
          promotions: next,
        },
      });
      setSettings(saved);
      setPromotions(saved.promotions ?? next);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save promotions.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-10 border-t border-gray-200 pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-950">Promotions</h2>
          <p className="mt-1 text-sm text-gray-500">
            Automatic rate rules that apply without a code. Guests see the discount as soon as their
            dates match.
          </p>
          <p className="mt-2 text-xs text-gray-500">
            The highest single discount applies. Promotions and promo codes never stack; the better
            deal wins.
          </p>
        </div>
        {promotions.length < 4 && (
          <button
            className={button}
            disabled={!settings || busy}
            onClick={() => {
              setEditing(false);
              setDraft(fresh(types.find((type) => !promotions.some((p) => p.type === type))!));
            }}
          >
            + New promotion
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
      {!settings && !error && <p className="mt-4 text-sm text-gray-500">Loading promotions…</p>}
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {promotions.map((p) => {
          const Icon = icons[p.type];
          return (
            <article
              key={p.type}
              className={`rounded-xl border border-gray-200 p-5 ${p.active ? "bg-white" : "bg-gray-50 text-gray-500"}`}
            >
              <div className="flex items-center gap-3">
                <Icon className="h-5 w-5" />
                <h3 className="font-semibold">{names[p.type]}</h3>
                <span
                  className={`ml-auto rounded-full px-2 py-1 text-xs ${p.active ? "bg-green-50 text-green-700" : "bg-gray-200"}`}
                >
                  {p.active ? "Active" : "Paused"}
                </span>
              </div>
              <p className="mt-2 text-xs tracking-wide text-gray-500">{p.type}</p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                {[
                  p.freeNights
                    ? `${p.freeNights} free night(s)`
                    : p.tiers.length
                      ? "Tiered percentage off"
                      : `${p.discountPercent}% off`,
                  summary(p),
                  p.roomTypeIds.length
                    ? p.roomTypeIds
                        .map(
                          (id) =>
                            roomTypes.find((r) => r.roomTypeId === id)?.name ?? "Unavailable room",
                        )
                        .join(", ")
                    : "All rooms",
                ].map((tag, index) => (
                  <span key={index} className="rounded-md bg-gray-100 px-2 py-1">
                    {tag}
                  </span>
                ))}
              </div>
              <div className="mt-5 flex items-center gap-2">
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    setEditing(true);
                    setDraft(structuredClone(p));
                  }}
                >
                  Edit {names[p.type]}
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete ${names[p.type]}?`))
                      void save(promotions.filter((item) => item.type !== p.type));
                  }}
                >
                  Delete
                </button>
                <button
                  role="switch"
                  aria-checked={p.active}
                  aria-label={`Activate ${names[p.type]}`}
                  disabled={busy}
                  onClick={() =>
                    void save(
                      promotions.map((item) =>
                        item.type === p.type ? { ...p, active: !p.active } : item,
                      ),
                    )
                  }
                  className={`ml-auto relative h-6 w-11 rounded-full ${p.active ? "bg-primary-600" : "bg-gray-300"}`}
                >
                  <span
                    className={`absolute top-1 h-4 w-4 rounded-full bg-white ${p.active ? "right-1" : "left-1"}`}
                  />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {draft && (
        <PromotionForm
          key={`${editing}-${draft.type}`}
          initial={draft}
          editing={editing}
          promotions={promotions}
          roomTypes={roomTypes}
          busy={busy}
          save={save}
          onCancel={() => setDraft(null)}
        />
      )}
    </section>
  );
}
