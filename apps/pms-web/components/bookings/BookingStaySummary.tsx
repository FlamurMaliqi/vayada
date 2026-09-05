"use client";

import type { Booking, BookingExpectedPaymentMethod, BookingStay } from "@/services/bookings";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { paymentMethodLabel, paymentMethodLabelKey } from "@vayada/locale-constants";

type Translate = ReturnType<typeof useTranslation>["t"];

export const expectedPaymentMethodLabel = (method: BookingExpectedPaymentMethod, t?: Translate) =>
  t
    ? t(
        `bookings.detail.paymentMethod.${
          method === "unknown" ? "notSpecified" : paymentMethodLabelKey(method)
        }`,
      )
    : method === "unknown"
      ? "Not specified"
      : paymentMethodLabel(method);

export const settlementLabel = (paid: boolean, amount: number, currency: string, t?: Translate) =>
  paid
    ? t?.("bookings.detail.paymentRecorded") || "Payment recorded"
    : t?.("bookings.detail.amountOutstanding", { amount: formatCurrency(amount, currency) }) ||
      `${formatCurrency(amount, currency)} outstanding`;

export const bookingSettlementLabel = (
  booking: Pick<
    Booking,
    "balanceAmount" | "currency" | "depositRequired" | "paymentStatus" | "totalAmount"
  >,
  t?: Translate,
) =>
  settlementLabel(
    booking.depositRequired
      ? booking.balanceAmount <= 0
      : ["captured", "paid", "refunded", "partially_refunded"].includes(
          booking.paymentStatus || "",
        ),
    booking.depositRequired ? booking.balanceAmount : booking.totalAmount,
    booking.currency,
    t,
  );

function guestsLabel(stay: BookingStay, t: Translate): string {
  if (stay.adults == null || stay.children == null) {
    return t("bookings.detail.guestCountUnavailable");
  }
  const adults = `${stay.adults} ${t(stay.adults === 1 ? "common.adult" : "common.adults")}`;
  const children = stay.children
    ? `, ${stay.children} ${t(stay.children === 1 ? "common.child" : "common.children")}`
    : "";
  return `${adults}${children}`;
}

function pricingLabel(stay: BookingStay, t: Translate): string {
  if (!stay.nightly.length) return t("bookings.detail.pricingUnavailable");
  const expectedNights =
    stay.checkIn && stay.checkOut
      ? (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 864e5
      : 0;
  const priced = stay.nightly.filter((night) => night.appliedAmount != null && night.currency);
  if (
    priced.length !== expectedNights ||
    new Set(priced.map((night) => night.currency)).size !== 1
  ) {
    return t("bookings.detail.pricingIncomplete");
  }
  return t("bookings.detail.appliedAmount", {
    amount: formatCurrency(
      priced.reduce((sum, night) => sum + (night.appliedAmount ?? 0), 0),
      priced[0]!.currency!,
    ),
  });
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-xs text-gray-500">{label}</dt>
    <dd className="font-medium text-gray-900">{value}</dd>
  </div>
);

export default function BookingStaySummary({
  stays,
  expectedCount,
}: {
  stays: BookingStay[];
  expectedCount: number;
}) {
  const { t } = useTranslation();

  return (
    <div className="space-y-2" aria-label={t("bookings.detail.reservationStays")}>
      {expectedCount > stays.length && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {t("bookings.detail.stayDetailsUnavailableCount", {
            count: expectedCount - stays.length,
          })}
        </p>
      )}
      {stays.map((stay) => (
        <article key={stay.position} className="rounded-lg border border-gray-200 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <p className="text-sm font-semibold text-gray-950">
              {stay.roomName || t("bookings.detail.roomNumber", { number: stay.position + 1 })}
            </p>
            <p className="text-xs text-gray-500">
              {stay.roomNumber
                ? t("bookings.detail.roomNumber", { number: stay.roomNumber })
                : t("bookings.modal.unassigned")}
            </p>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Fact
              label={t("bookings.detail.dates")}
              value={
                stay.checkIn && stay.checkOut
                  ? `${stay.checkIn} → ${stay.checkOut}`
                  : t("bookings.detail.stayDatesUnavailable")
              }
            />
            <Fact label={t("bookings.detail.guests")} value={guestsLabel(stay, t)} />
            <Fact
              label={t("bookings.detail.ratePlan")}
              value={stay.ratePlanName || t("bookings.detail.ratePlanUnavailable")}
            />
            <Fact label={t("bookings.detail.appliedPricing")} value={pricingLabel(stay, t)} />
          </dl>
        </article>
      ))}
    </div>
  );
}
