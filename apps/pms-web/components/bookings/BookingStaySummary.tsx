import type { Booking, BookingExpectedPaymentMethod, BookingStay } from "@/services/bookings";
import { formatCurrency } from "@/lib/formatCurrency";
// prettier-ignore
export const expectedPaymentMethodLabel = (method: BookingExpectedPaymentMethod) => method === "unknown" ? "Not specified" : method.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
// prettier-ignore
export const settlementLabel = (paid: boolean, amount: number, currency: string) => paid ? "Payment recorded" : `${formatCurrency(amount, currency)} outstanding`;
// prettier-ignore
export const bookingSettlementLabel = (booking: Pick<Booking, "balanceAmount" | "currency" | "depositRequired" | "paymentStatus" | "totalAmount">) => settlementLabel(booking.depositRequired ? booking.balanceAmount <= 0 : ["captured", "paid", "refunded", "partially_refunded"].includes(booking.paymentStatus || ""), booking.depositRequired ? booking.balanceAmount : booking.totalAmount, booking.currency);
// prettier-ignore
function guestsLabel(stay: BookingStay): string { return stay.adults == null || stay.children == null ? "Guest count unavailable" : `${stay.adults} adult${stay.adults === 1 ? "" : "s"}${stay.children ? `, ${stay.children} child${stay.children === 1 ? "" : "ren"}` : ""}`; }
// prettier-ignore
function pricingLabel(stay: BookingStay): string {
  if (!stay.nightly.length) return "Pricing unavailable";
  const expectedNights = stay.checkIn && stay.checkOut ? (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 864e5 : 0;
  const priced = stay.nightly.filter((night) => night.appliedAmount != null && night.currency);
  if (priced.length !== expectedNights || new Set(priced.map((night) => night.currency)).size !== 1) return "Pricing incomplete";
  return `${formatCurrency(priced.reduce((sum, night) => sum + (night.appliedAmount ?? 0), 0), priced[0]!.currency!)} applied`;
}
// prettier-ignore
const Fact = ({ label, value }: { label: string; value: string }) => <div><dt className="text-xs text-gray-500">{label}</dt><dd className="font-medium text-gray-900">{value}</dd></div>;
// prettier-ignore
export default function BookingStaySummary({ stays, expectedCount }: { stays: BookingStay[]; expectedCount: number }) {
  return (
    <div className="space-y-2" aria-label="Reservation stays">
      {expectedCount > stays.length && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Stay details unavailable ({expectedCount - stays.length}).</p>
      )}
      {stays.map((stay) => (
          <article key={stay.position} className="rounded-lg border border-gray-200 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <p className="text-sm font-semibold text-gray-950">{stay.roomName || `Room ${stay.position + 1}`}</p>
              <p className="text-xs text-gray-500">{stay.roomNumber ? `Room ${stay.roomNumber}` : "Unassigned"}</p>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              <Fact label="Dates" value={stay.checkIn && stay.checkOut ? `${stay.checkIn} → ${stay.checkOut}` : "Stay dates unavailable"} />
              <Fact label="Guests" value={guestsLabel(stay)} />
              <Fact label="Rate plan" value={stay.ratePlanName || "Rate plan unavailable"} />
              <Fact label="Applied pricing" value={pricingLabel(stay)} />
            </dl>
          </article>
        ))}
    </div>
  );
}
