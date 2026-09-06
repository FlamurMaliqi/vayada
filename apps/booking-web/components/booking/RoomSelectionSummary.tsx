"use client";
import { useLocale, useTranslations } from "next-intl";
import { useCurrency } from "@/contexts/CurrencyContext";
import type { SelectedRoomLine } from "@/lib/types";

export default function RoomSelectionSummary({
  lines,
  currency,
  checkIn,
  timezone,
  beforeDiscounts = false,
}: {
  lines: SelectedRoomLine[];
  currency: string;
  checkIn: string;
  timezone?: string;
  beforeDiscounts?: boolean;
}) {
  const t = useTranslations("roomSelection");
  const tc = useTranslations("common");
  const th = useTranslations("home");
  const locale = useLocale();
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();
  return (
    <ul className="space-y-4" data-testid="room-selection-lines">
      {lines.map((line) => {
        const policy = line.policy;
        const days = policy.freeCancellationDeadlineDays;
        const nonRefundable =
          line.rateSummary.refundable === false ||
          ["non_refundable", "nonrefundable", "nrf"].includes(String(line.rateSummary.rateType));
        let cancellation = nonRefundable
          ? th("nonRefundableDesc")
          : typeof policy.cancellation === "string"
            ? policy.cancellation
            : t("termsUnavailable");
        if (
          !nonRefundable &&
          policy.flexibleCancellationType !== "partial_refund" &&
          Number.isInteger(days) &&
          Number(days) >= 0 &&
          Number(days) <= 365 &&
          Number.isFinite(Date.parse(checkIn))
        ) {
          const date = new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeZone: "UTC",
          }).format(new Date(Date.parse(`${checkIn}T00:00:00Z`) - Number(days) * 86_400_000));
          cancellation = t("freeUntil", { date, timezone: timezone ?? "UTC" });
        }
        const tiers =
          policy.flexibleCancellationType === "partial_refund"
            ? (Array.isArray(policy.partialRefundTiers)
                ? policy.partialRefundTiers
                : [
                    {
                      minDaysBeforeCheckIn: policy.partialRefundCancelWindowDays,
                      refundPercent: policy.partialRefundAmountPercent,
                    },
                  ]
              ).filter(
                (tier) =>
                  Number.isInteger(tier?.minDaysBeforeCheckIn) &&
                  Number.isFinite(tier?.refundPercent),
              )
            : [];
        const amount = beforeDiscounts
          ? Number(line.totals.roomTotal) +
            Number(line.totals.taxesAndFees) -
            Number(line.totals.discounts)
          : Number(line.totals.totalAmount);
        return (
          <li
            key={`${line.roomTypeId}:${line.publicOfferKey}`}
            className="border-b border-gray-100 pb-4 last:border-0 last:pb-0"
          >
            <div className="flex justify-between gap-4 text-sm font-semibold text-gray-900">
              <span>
                {line.roomCount} × {line.roomName}
              </span>
              {Number.isFinite(amount) && (
                <span className="whitespace-nowrap">
                  {formatPrice(convertAndRound(amount, currency), selectedCurrency)}
                </span>
              )}
            </div>
            {typeof line.rateSummary.name === "string" && (
              <p className="text-sm text-gray-600">{line.rateSummary.name}</p>
            )}
            <ul className="mt-1 text-sm text-gray-600">
              {line.guests.map((guest, index) => (
                <li key={index}>
                  {t("roomNumber", { number: index + 1 })}: {tc("adults", { count: guest.adults })}
                  {guest.children > 0 && `, ${tc("children", { count: guest.children })}`}
                </li>
              ))}
            </ul>
            <div className="mt-2 text-xs text-gray-600">
              {tiers.length ? (
                tiers.map((tier, index) => (
                  <p key={index}>
                    {th("partialRefundDesc", {
                      percent: tier.refundPercent,
                      days: tier.minDaysBeforeCheckIn,
                    })}
                  </p>
                ))
              ) : (
                <p>{cancellation}</p>
              )}
              {!nonRefundable && policy.afterDeadlinePenalty === "full_booking_amount" && (
                <p>{t("afterDeadline")}</p>
              )}
              {typeof policy.deposit === "string" && <p>{policy.deposit}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
