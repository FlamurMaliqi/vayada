"use client";
import { useTranslation } from "@/lib/i18n";

import { useState } from "react";
import type { BookingPromotion } from "@/services/api/bookingLastMinuteSettingsClient";
import type { PromoRoomType } from "./PromoCodesTab";

export const names = {
  LAST_MINUTE: "admin.lastMinuteEscape",
  EARLY_BIRD: "admin.earlyBird",
  EXTENDED_STAY: "admin.extendedStay",
  MIDWEEK: "admin.midweekGetaway",
};
const types = Object.keys(names) as BookingPromotion["type"][];
export const fresh = (type: BookingPromotion["type"]): BookingPromotion => ({
  type,
  active: true,
  roomTypeIds: [],
  discountPercent: 10,
  threshold: type === "EARLY_BIRD" ? 90 : type === "EXTENDED_STAY" ? 7 : 5,
  freeNights: 0,
  weekdays: type === "MIDWEEK" ? [0, 1, 2, 3, 4] : [],
  tiers: [],
});
const field = "mt-1 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm";
const button =
  "rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium disabled:opacity-50";

export default function PromotionForm({
  initial,
  editing,
  promotions,
  roomTypes,
  busy,
  save,
  onCancel,
}: {
  initial: BookingPromotion;
  editing: boolean;
  promotions: BookingPromotion[];
  roomTypes: PromoRoomType[];
  busy: boolean;
  save: (next: BookingPromotion[]) => Promise<void>;
  onCancel: () => void;
}) {
  const { t, locale } = useTranslation();
  const weekdayLabels = Array.from({ length: 7 }, (_, day) =>
    new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, 0, 4 + day)),
    ),
  );
  const [draft, setDraft] = useState(initial);
  const [discountFormat, setDiscountFormat] = useState(
    initial.freeNights > 0 ? "free" : "percentage",
  );
  const patch = (value: Partial<BookingPromotion>) => setDraft((p) => ({ ...p, ...value }));
  return (
    <form
      className="mt-6 space-y-4 rounded-xl border border-gray-300 bg-gray-50 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save(
          editing
            ? promotions.map((p) => (p.type === draft.type ? draft : p))
            : [...promotions, draft],
        );
      }}
    >
      <h3 className="font-semibold">
        {editing ? t("admin.editPromotion") : t("admin.newPromotion")}
      </h3>
      <label className="block text-sm">
        {t("admin.promotionType")}
        <select
          className={field}
          disabled={editing || busy}
          value={draft.type}
          onChange={(e) => {
            setDraft(fresh(e.target.value as BookingPromotion["type"]));
            setDiscountFormat("percentage");
          }}
        >
          {types
            .filter((type) =>
              editing ? type === draft.type : !promotions.some((p) => p.type === type),
            )
            .map((type) => (
              <option key={type} value={type}>
                {t(names[type])}
              </option>
            ))}
        </select>
      </label>
      {draft.type === "EXTENDED_STAY" && (
        <label className="block text-sm">
          {t("admin.discountFormat")}
          <select
            className={field}
            value={discountFormat}
            onChange={(e) => {
              setDiscountFormat(e.target.value);
              patch(
                e.target.value === "free"
                  ? { freeNights: 1, discountPercent: 0 }
                  : { freeNights: 0, discountPercent: 10 },
              );
            }}
          >
            <option value="percentage">{t("admin.percentageOff")}</option>
            <option value="free">{t("admin.freeNightsCheapestNightsPerStay")}</option>
          </select>
        </label>
      )}
      {!draft.tiers.length && (
        <label className="block text-sm">
          {discountFormat === "free" ? t("admin.freeNights") : t("admin.discountPercentage")}
          <input
            required
            type="number"
            min={discountFormat === "free" ? 1 : 0}
            max={discountFormat === "free" ? draft.threshold - 1 : 100}
            step={discountFormat === "free" ? 1 : "any"}
            className={field}
            value={discountFormat === "free" ? draft.freeNights || "" : draft.discountPercent}
            onChange={(e) =>
              patch(
                discountFormat === "free"
                  ? { freeNights: Number(e.target.value) }
                  : { discountPercent: Number(e.target.value) },
              )
            }
          />
        </label>
      )}
      {draft.type !== "MIDWEEK" && !draft.tiers.length && (
        <label className="block text-sm">
          {draft.type === "LAST_MINUTE"
            ? t("admin.checkInWithinDays")
            : draft.type === "EARLY_BIRD"
              ? t("admin.minimumDaysAhead")
              : t("admin.minimumStayNights")}
          <input
            required
            type="number"
            min={draft.type === "EXTENDED_STAY" ? 2 : 0}
            max={3650}
            className={field}
            value={draft.threshold}
            onChange={(e) => patch({ threshold: Number(e.target.value) })}
          />
        </label>
      )}
      {draft.tiers.length > 0 && (
        <fieldset>
          <legend className="text-sm">{t("admin.existingLastMinuteTiers")}</legend>
          <p className="text-xs text-gray-500">
            {t("admin.yourExistingWindowsAndDiscountsArePreservedEmptyEndDay")}
          </p>
          {draft.tiers.map((tier, index) => (
            <div key={index} className="mt-2 grid grid-cols-3 gap-2">
              {(["daysBeforeMin", "daysBeforeMax", "discountPercent"] as const).map((key) => (
                <label key={key} className="text-xs">
                  {key === "daysBeforeMin"
                    ? t("admin.fromDay")
                    : key === "daysBeforeMax"
                      ? t("admin.throughDay")
                      : t("admin.discount2")}
                  <input
                    type="number"
                    required={key !== "daysBeforeMax"}
                    min={0}
                    step={key === "discountPercent" ? "any" : 1}
                    max={key === "discountPercent" ? 100 : Number.MAX_SAFE_INTEGER}
                    className={field}
                    value={tier[key] ?? ""}
                    onChange={(e) =>
                      patch({
                        tiers: draft.tiers.map((t, i) =>
                          i === index
                            ? {
                                ...t,
                                [key]:
                                  e.target.value === "" && key === "daysBeforeMax"
                                    ? null
                                    : Number(e.target.value),
                              }
                            : t,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          ))}
        </fieldset>
      )}
      {draft.type === "MIDWEEK" && (
        <fieldset>
          <legend className="text-sm">{t("admin.discountedWeekdays")}</legend>
          <div className="mt-2 flex flex-wrap gap-3">
            {weekdayLabels.map((day, index) => (
              <label key={day} className="text-sm">
                <input
                  type="checkbox"
                  checked={draft.weekdays.includes(index)}
                  onChange={(e) =>
                    patch({
                      weekdays: e.target.checked
                        ? [...draft.weekdays, index]
                        : draft.weekdays.filter((d) => d !== index),
                    })
                  }
                />{" "}
                {day}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend className="text-sm">{t("admin.roomTargeting")}</legend>
        <label className="mt-2 block text-sm">
          <input
            type="checkbox"
            checked={!draft.roomTypeIds.length}
            onChange={(e) =>
              patch({
                roomTypeIds: e.target.checked ? [] : roomTypes.slice(0, 1).map((r) => r.roomTypeId),
              })
            }
          />{" "}
          {t("admin.allRooms")}
        </label>
        <div className="mt-2 flex flex-wrap gap-3">
          {roomTypes.map((room) => (
            <label key={room.roomTypeId} className="text-sm">
              <input
                type="checkbox"
                checked={draft.roomTypeIds.includes(room.roomTypeId)}
                onChange={(e) =>
                  patch({
                    roomTypeIds: e.target.checked
                      ? [...draft.roomTypeIds, room.roomTypeId]
                      : draft.roomTypeIds.filter((id) => id !== room.roomTypeId),
                  })
                }
              />{" "}
              {room.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-2">
        <button
          disabled={busy || (draft.type === "MIDWEEK" && !draft.weekdays.length)}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? t("admin.saving") : t("admin.savePromotion")}
        </button>
        <button type="button" disabled={busy} className={button} onClick={() => onCancel()}>
          {t("settings.totp.cancel")}
        </button>
      </div>
    </form>
  );
}
