"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useCurrency } from "@/contexts/CurrencyContext";
import type { RoomType } from "@/lib/types";
import RoomSelectionSummary from "./RoomSelectionSummary";

export default function RoomCombinationCard({
  room,
  nights,
  timezone,
  onSelect,
  disabled,
  pending,
  titleId,
}: {
  room: RoomType;
  nights: number;
  timezone?: string;
  onSelect: (rooms: number) => void;
  disabled?: boolean;
  pending?: boolean;
  titleId?: string;
}) {
  const t = useTranslations("roomSelection");
  const tc = useTranslations("common");
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();
  const [now, setNow] = useState(Date.now);
  const combination = room.combination!;
  useEffect(() => {
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(combination.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [combination.expiresAt]);
  const expired = !(Date.parse(combination.expiresAt) > now);
  const quantity = combination.roomSelection.lines.reduce(
    (sum, line) => sum + line.guests.length,
    0,
  );
  return (
    <section
      className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
      data-testid={`combination-${room.id}`}
    >
      <h3 id={titleId} className="mb-1 text-xl font-heading text-gray-900">
        {t("accommodation", { count: combination.adults + combination.children })}
      </h3>
      <p className="mb-5 text-sm text-gray-500">{t("perRoomTerms")}</p>
      <RoomSelectionSummary
        lines={combination.roomLines}
        currency={room.currency}
        checkIn={combination.checkIn}
        timezone={timezone}
      />
      <div className="mt-5 flex justify-between gap-4 border-t border-gray-100 pt-4">
        <div className="text-sm text-gray-600">
          <p>{t("totalStay", { nights })}</p>
          <p className="text-xs">{tc("includesTaxes")}</p>
        </div>
        <strong className="text-xl text-gray-900">
          {formatPrice(convertAndRound(combination.totalAmount, room.currency), selectedCurrency)}
        </strong>
      </div>
      {expired && (
        <p role="status" className="mt-3 text-sm text-red-700">
          {t("unavailable")}
        </p>
      )}
      <button
        data-testid={`select-rate-${room.id}`}
        disabled={disabled || expired}
        aria-busy={pending}
        onClick={() => {
          if (!expired && !disabled) onSelect(quantity);
        }}
        className="mt-4 w-full rounded-xl bg-primary-600 py-3 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? tc("loading") : t("choose")}
      </button>
    </section>
  );
}
