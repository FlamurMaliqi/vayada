"use client";
import { useTranslation } from "@/lib/i18n";

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
const types = Object.keys(names) as BookingPromotion["type"][];
const button =
  "rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium disabled:opacity-50";

function summary(p: BookingPromotion, t: ReturnType<typeof useTranslation>["t"], locale: string) {
  if (p.type === "LAST_MINUTE")
    return p.tiers.length
      ? p.tiers
          .map((tier) =>
            t("admin.minMaxDaysDiscount", {
              min: tier.daysBeforeMin,
              max: tier.daysBeforeMax ?? "∞",
              discount: tier.discountPercent,
            }),
          )
          .join("; ")
      : t("admin.checkInWithinDaysDays", { days: p.threshold });
  if (p.type === "EARLY_BIRD") return t("admin.bookDaysDaysAhead", { days: p.threshold });
  if (p.type === "EXTENDED_STAY") return t("admin.stayNightsNights", { nights: p.threshold });
  return p.weekdays
    .map((day) =>
      new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
        new Date(Date.UTC(2026, 0, 4 + day)),
      ),
    )
    .join(", ");
}

export default function Promotions({
  hotelId,
  roomTypes,
}: {
  hotelId: string;
  roomTypes: PromoRoomType[];
}) {
  const { t, locale } = useTranslation();
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
      .catch(() => {
        if (current) setError("admin.couldNotLoadPromotions");
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
    } catch {
      setError("admin.couldNotSavePromotions");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-10 border-t border-gray-200 pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-950">{t("admin.promotions")}</h2>
          <p className="mt-1 text-sm text-gray-500">
            {t("admin.automaticRateRulesThatApplyWithoutACodeGuestsSee")}
          </p>
          <p className="mt-2 text-xs text-gray-500">
            {t("admin.theHighestSingleDiscountAppliesPromotionsAndPromoCodesNever")}
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
            {t("admin.newPromotion2")}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
      {!settings && !error && (
        <p className="mt-4 text-sm text-gray-500">{t("admin.loadingPromotions")}</p>
      )}
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
                <h3 className="font-semibold">{t(names[p.type])}</h3>
                <span
                  className={`ml-auto rounded-full px-2 py-1 text-xs ${p.active ? "bg-green-50 text-green-700" : "bg-gray-200"}`}
                >
                  {p.active ? t("promos.status.Active") : t("admin.paused")}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                {[
                  p.freeNights
                    ? t("admin.freeNightsCount", { count: p.freeNights })
                    : p.tiers.length
                      ? t("admin.tieredPercentageOff")
                      : `${p.discountPercent}${t("bookingFlow.promoCodes.percentageOff")}`,
                  summary(p, t, locale),
                  p.roomTypeIds.length
                    ? p.roomTypeIds
                        .map(
                          (id) =>
                            roomTypes.find((r) => r.roomTypeId === id)?.name ??
                            t("admin.unavailableRoom"),
                        )
                        .join(", ")
                    : t("admin.allRooms"),
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
                  {t("common.edit")} {t(names[p.type])}
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(t("admin.deleteName", { name: t(names[p.type]) })))
                      void save(promotions.filter((item) => item.type !== p.type));
                  }}
                >
                  {t("common.delete")}
                </button>
                <button
                  role="switch"
                  aria-checked={p.active}
                  aria-label={t("admin.activateName", { name: t(names[p.type]) })}
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
