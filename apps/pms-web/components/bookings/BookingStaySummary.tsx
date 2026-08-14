import type { BookingExpectedPaymentMethod, BookingStay } from "@/services/bookings";
import { formatCurrency } from "@/lib/formatCurrency";
// prettier-ignore
export const expectedPaymentMethodLabel = (method: BookingExpectedPaymentMethod) => method === "unknown" ? "Not specified" : method.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
function guestsLabel(stay: BookingStay): string {
  if (stay.adults == null || stay.children == null) return "Guest count unavailable";
  const adults = `${stay.adults} adult${stay.adults === 1 ? "" : "s"}`;
  // prettier-ignore
  const children = stay.children ? `, ${stay.children} child${stay.children === 1 ? "" : "ren"}` : "";
  return adults + children;
}
function pricingLabel(stay: BookingStay): string {
  if (!stay.nightly.length) return "Pricing unavailable";
  // prettier-ignore
  const expectedNights = stay.checkIn && stay.checkOut ? (Date.parse(stay.checkOut) - Date.parse(stay.checkIn)) / 864e5 : 0;
  const priced = stay.nightly.filter((night) => night.appliedAmount != null && night.currency);
  const currencies = new Set(priced.map((night) => night.currency));
  if (priced.length !== expectedNights || currencies.size !== 1) return "Pricing incomplete";
  // prettier-ignore
  return `${formatCurrency(priced.reduce((sum, night) => sum + (night.appliedAmount ?? 0), 0), priced[0]!.currency!)} applied`;
}
// prettier-ignore
export default function BookingStaySummary({ stays, expectedCount }: { stays: BookingStay[]; expectedCount: number }) {
  return (
    <div className="space-y-2" aria-label="Reservation stays">
      {expectedCount > stays.length && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Stay details unavailable ({expectedCount - stays.length}).
        </p>
      )}
      {stays.map((stay) => (
          <article key={stay.position} className="rounded-lg border border-gray-200 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <p className="text-sm font-semibold text-gray-950">{stay.roomName || `Room ${stay.position + 1}`}</p>
              <p className="text-xs text-gray-500">{stay.roomNumber ? `Room ${stay.roomNumber}` : "Unassigned"}</p>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-gray-500">Dates</dt>
                {/* prettier-ignore */}
                <dd className="font-medium text-gray-900">{stay.checkIn && stay.checkOut ? `${stay.checkIn} → ${stay.checkOut}` : "Stay dates unavailable"}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Guests</dt>
                <dd className="font-medium text-gray-900">{guestsLabel(stay)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Rate plan</dt>
                <dd className="font-medium text-gray-900">{stay.ratePlanName || "Rate plan unavailable"}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Applied pricing</dt>
                <dd className="font-medium text-gray-900">{pricingLabel(stay)}</dd>
              </div>
            </dl>
          </article>
        ))}
    </div>
  );
}
