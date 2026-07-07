"use client";

function formatWindow(from: string, until: string) {
  if (!from || !until) return "";
  const [fh, fm] = from.split(":").map(Number);
  const [uh, um] = until.split(":").map(Number);
  let mins = uh * 60 + um - (fh * 60 + fm);
  if (mins <= 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m window`;
  if (h) return `${h}h window`;
  return `${m}m window`;
}

function TimeWindow({
  label,
  icon,
  from,
  until,
  onFromChange,
  onUntilChange,
}: {
  label: string;
  icon: React.ReactNode;
  from: string;
  until: string;
  onFromChange: (v: string) => void;
  onUntilChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-700 mb-2">
        {icon}
        {label}
      </label>
      <div className="flex items-stretch rounded-xl border border-gray-300 overflow-hidden bg-white focus-within:ring-2 focus-within:ring-primary-500 focus-within:border-transparent transition-shadow">
        <div className="flex-1 flex flex-col px-3 py-2 bg-gray-50/60 border-r border-gray-200">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            From
          </span>
          <input
            type="time"
            value={from}
            onChange={(e) => onFromChange(e.target.value)}
            className="w-full bg-transparent text-[15px] font-semibold tabular-nums text-gray-900 focus:outline-none [&::-webkit-calendar-picker-indicator]:hidden"
          />
        </div>
        <div className="flex items-center px-2 text-gray-300 select-none text-[13px]">→</div>
        <div className="flex-1 flex flex-col px-3 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
            Until
          </span>
          <input
            type="time"
            value={until}
            onChange={(e) => onUntilChange(e.target.value)}
            className="w-full bg-transparent text-[15px] font-semibold tabular-nums text-gray-900 focus:outline-none [&::-webkit-calendar-picker-indicator]:hidden"
          />
        </div>
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5">{formatWindow(from, until)}</p>
    </div>
  );
}

interface PoliciesStepProps {
  checkInFrom: string;
  setCheckInFrom: (v: string) => void;
  checkInUntil: string;
  setCheckInUntil: (v: string) => void;
  checkOutFrom: string;
  setCheckOutFrom: (v: string) => void;
  checkOutUntil: string;
  setCheckOutUntil: (v: string) => void;
  payAtHotel: boolean;
  setPayAtHotel: (v: boolean) => void;
  payAtHotelMethods: string[];
  setPayAtHotelMethods: (v: string[]) => void;
  onlineCardPayment: boolean;
  setOnlineCardPayment: (v: boolean) => void;
  bankTransfer: boolean;
  setBankTransfer: (v: boolean) => void;
  paymentProvider: "stripe" | "xendit" | "vayada";
  setPaymentProvider: (v: "stripe" | "xendit" | "vayada") => void;
  xenditChannelCode: string;
  setXenditChannelCode: (v: string) => void;
  xenditAccountNumber: string;
  setXenditAccountNumber: (v: string) => void;
  xenditAccountHolderName: string;
  setXenditAccountHolderName: (v: string) => void;
  payoutAccountHolder: string;
  setPayoutAccountHolder: (v: string) => void;
  payoutAccountType: "iban" | "account_number";
  setPayoutAccountType: (v: "iban" | "account_number") => void;
  payoutIban: string;
  setPayoutIban: (v: string) => void;
  payoutAccountNumber: string;
  setPayoutAccountNumber: (v: string) => void;
  payoutBankName: string;
  setPayoutBankName: (v: string) => void;
  payoutSwift: string;
  setPayoutSwift: (v: string) => void;
  specialRequests: boolean;
  setSpecialRequests: (v: boolean) => void;
  estimatedArrivalTime: boolean;
  setEstimatedArrivalTime: (v: boolean) => void;
  numberOfGuests: boolean;
  setNumberOfGuests: (v: boolean) => void;
  enableReferAGuest: boolean;
  setEnableReferAGuest: (v: boolean) => void;
  error: string;
  saving: boolean;
  onBack: () => void;
  onComplete: () => void;
  stepIndicators: React.ReactNode;
}

export default function PoliciesStep({
  checkInFrom,
  setCheckInFrom,
  checkInUntil,
  setCheckInUntil,
  checkOutFrom,
  setCheckOutFrom,
  checkOutUntil,
  setCheckOutUntil,
  payAtHotel,
  setPayAtHotel,
  payAtHotelMethods,
  setPayAtHotelMethods,
  onlineCardPayment,
  setOnlineCardPayment,
  bankTransfer,
  setBankTransfer,
  paymentProvider,
  setPaymentProvider,
  xenditChannelCode,
  setXenditChannelCode,
  xenditAccountNumber,
  setXenditAccountNumber,
  xenditAccountHolderName,
  setXenditAccountHolderName,
  payoutAccountHolder,
  setPayoutAccountHolder,
  payoutAccountType,
  setPayoutAccountType,
  payoutIban,
  setPayoutIban,
  payoutAccountNumber,
  setPayoutAccountNumber,
  payoutBankName,
  setPayoutBankName,
  payoutSwift,
  setPayoutSwift,
  specialRequests,
  setSpecialRequests,
  estimatedArrivalTime,
  setEstimatedArrivalTime,
  numberOfGuests,
  setNumberOfGuests,
  enableReferAGuest,
  setEnableReferAGuest,
  error,
  saving,
  onBack,
  onComplete,
  stepIndicators,
}: PoliciesStepProps) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        {stepIndicators}
        <div className="text-center mb-6">
          <h2 className="text-lg font-bold text-gray-900">Policies & Operations</h2>
          <p className="text-[13px] text-gray-500 mt-1">
            Configure payment methods and guest options
          </p>
        </div>

        {/* Check-in & Check-out */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
          <h3 className="text-[13px] font-semibold text-gray-900 mb-1">Check-in & Check-out</h3>
          <p className="text-[11px] text-gray-500 mb-4">
            Set the time windows for guest arrivals and departures.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <TimeWindow
              label="Check-in Period"
              icon={
                <svg
                  className="w-3.5 h-3.5 text-gray-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M11 16l-4-4m0 0l4-4m-4 4h14M7 8V5a2 2 0 012-2h10a2 2 0 012 2v14a2 2 0 01-2 2H9a2 2 0 01-2-2v-3"
                  />
                </svg>
              }
              from={checkInFrom}
              until={checkInUntil}
              onFromChange={setCheckInFrom}
              onUntilChange={setCheckInUntil}
            />
            <TimeWindow
              label="Check-out Period"
              icon={
                <svg
                  className="w-3.5 h-3.5 text-gray-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h6a2 2 0 012 2v1"
                  />
                </svg>
              }
              from={checkOutFrom}
              until={checkOutUntil}
              onFromChange={setCheckOutFrom}
              onUntilChange={setCheckOutUntil}
            />
          </div>
        </div>

        {/* Payment Methods — new card-based UI */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5 mb-4">
          <h3 className="text-sm font-semibold text-gray-900">Payment Methods</h3>
          <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
            Choose which payment options are available to guests. Enable multiple to give guests
            flexibility.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Online Card Payment */}
            <button
              type="button"
              onClick={() => setOnlineCardPayment(!onlineCardPayment)}
              className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                onlineCardPayment
                  ? "border-primary-500 bg-primary-50/30"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div
                className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${onlineCardPayment ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
              >
                {onlineCardPayment && (
                  <svg
                    className="w-3 h-3 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={3}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
              <svg
                className="w-6 h-6 text-gray-700 mb-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                />
              </svg>
              <span className="text-[13px] font-semibold text-gray-900">Online Card</span>
              <p className="text-[11px] text-gray-500 mt-1 mb-3">
                Guest pays online with credit or debit card
              </p>
              <div className="mt-auto space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-green-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">Instant confirmation</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-green-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">Visa, Mastercard, Amex</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-green-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">Auto payout to your bank</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-amber-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">Processing fees apply</span>
                </div>
              </div>
            </button>

            {/* Pay at Hotel */}
            <div
              className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left cursor-pointer ${
                payAtHotel
                  ? "border-primary-500 bg-primary-50/30"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div onClick={() => setPayAtHotel(!payAtHotel)}>
                <div
                  className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${payAtHotel ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                >
                  {payAtHotel && (
                    <svg
                      className="w-3 h-3 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
                <svg
                  className="w-6 h-6 text-gray-700 mb-2"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                  />
                </svg>
                <span className="text-[13px] font-semibold text-gray-900">Pay at Hotel</span>
                <p className="text-[11px] text-gray-500 mt-1 mb-3">
                  Guest pays cash or card at check-in — no online payment
                </p>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">No processing fees</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-green-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">No Stripe account needed</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg
                      className="w-3 h-3 text-amber-500 shrink-0"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="text-[10px] text-gray-500">Higher no-show risk</span>
                  </div>
                </div>
              </div>
              {payAtHotel && (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-200 flex-wrap">
                  {[
                    { key: "cash", label: "Cash" },
                    { key: "card", label: "Card" },
                  ].map((m) => {
                    const selected = payAtHotelMethods.includes(m.key);
                    return (
                      <button
                        key={m.key}
                        type="button"
                        onClick={() => {
                          if (selected && payAtHotelMethods.length > 1) {
                            setPayAtHotelMethods(payAtHotelMethods.filter((v) => v !== m.key));
                          } else if (!selected) {
                            setPayAtHotelMethods([...payAtHotelMethods, m.key]);
                          }
                        }}
                        className={`px-3 py-1.5 text-[12px] font-medium rounded-lg border transition-colors ${
                          selected
                            ? "border-primary-500 bg-primary-50 text-primary-700"
                            : "border-gray-200 text-gray-500 hover:border-gray-300"
                        }`}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                  <span className="text-[11px] text-gray-400 ml-1">
                    {payAtHotelMethods.length === 2
                      ? "Cash & Card"
                      : payAtHotelMethods.includes("cash")
                        ? "Cash only"
                        : "Card only"}
                  </span>
                </div>
              )}
            </div>

            {/* Bank Transfer */}
            <button
              type="button"
              onClick={() => setBankTransfer(!bankTransfer)}
              className={`relative flex flex-col p-4 rounded-xl border-2 transition-all text-left ${
                bankTransfer
                  ? "border-primary-500 bg-primary-50/30"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div
                className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center ${bankTransfer ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
              >
                {bankTransfer && (
                  <svg
                    className="w-3 h-3 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={3}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
              <svg
                className="w-6 h-6 text-gray-700 mb-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 14v3m4-3v3m4-3v3M3 21h18M3 10h18M3 7l9-4 9 4M4 10h16v11H4V10z"
                />
              </svg>
              <span className="text-[13px] font-semibold text-gray-900">Bank Transfer</span>
              <p className="text-[11px] text-gray-500 mt-1 mb-3">
                Guest transfers money directly to your bank account
              </p>
              <div className="mt-auto space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-green-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">No processing fees</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-green-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">Direct to your account</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-green-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">Good for large bookings</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-3 h-3 text-amber-500 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-[10px] text-gray-500">Manual verification needed</span>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Payment Provider — shown when Online Card Payment is enabled */}
        {onlineCardPayment && (
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5 mb-4">
            <h3 className="text-sm font-semibold text-gray-900">Payment Provider</h3>
            <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
              Choose how you want to accept online card payments from guests.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
              <button
                type="button"
                onClick={() => setPaymentProvider("vayada")}
                className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left ${
                  paymentProvider === "vayada"
                    ? "border-primary-500 bg-primary-50/30"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div
                  className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${paymentProvider === "vayada" ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                >
                  {paymentProvider === "vayada" && (
                    <svg
                      className="w-2.5 h-2.5 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
                <span className="text-[13px] font-semibold text-gray-900">vayada Payment</span>
                <p className="text-[11px] text-gray-500 mt-1">
                  We handle everything. No setup needed.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setPaymentProvider("stripe")}
                className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left ${
                  paymentProvider === "stripe"
                    ? "border-primary-500 bg-primary-50/30"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div
                  className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${paymentProvider === "stripe" ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                >
                  {paymentProvider === "stripe" && (
                    <svg
                      className="w-2.5 h-2.5 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
                <span className="text-[13px] font-semibold text-gray-900">Stripe Connect</span>
                <p className="text-[11px] text-gray-500 mt-1">
                  Your own Stripe account. Direct payouts.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setPaymentProvider("xendit")}
                className={`relative flex flex-col p-3 rounded-xl border-2 transition-all text-left ${
                  paymentProvider === "xendit"
                    ? "border-primary-500 bg-primary-50/30"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <div
                  className={`absolute top-2.5 right-2.5 w-4 h-4 rounded-full border-2 flex items-center justify-center ${paymentProvider === "xendit" ? "border-primary-500 bg-primary-500" : "border-gray-300"}`}
                >
                  {paymentProvider === "xendit" && (
                    <svg
                      className="w-2.5 h-2.5 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
                <span className="text-[13px] font-semibold text-gray-900">Xendit</span>
                <p className="text-[11px] text-gray-500 mt-1">
                  Indonesian bank payouts via Xendit.
                </p>
              </button>
            </div>

            {paymentProvider === "vayada" && (
              <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
                <p className="text-[13px] text-green-800 font-medium">No setup required</p>
                <p className="text-[12px] text-green-700 mt-1">
                  vayada processes card payments on your behalf. Guest payments are collected
                  securely and payouts are sent to your bank account on file.
                </p>
              </div>
            )}

            {paymentProvider === "stripe" && (
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
                <p className="text-[13px] text-gray-800 font-medium">Stripe Connect</p>
                <p className="text-[12px] text-gray-600 mt-1">
                  After launching your property, go to Settings → Billing to connect your Stripe
                  account and complete onboarding.
                </p>
              </div>
            )}

            {paymentProvider === "xendit" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                      Bank
                    </label>
                    <select
                      value={xenditChannelCode}
                      onChange={(e) => setXenditChannelCode(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
                    >
                      <option value="ID_BCA">BCA</option>
                      <option value="ID_MANDIRI">Mandiri</option>
                      <option value="ID_BNI">BNI</option>
                      <option value="ID_BRI">BRI</option>
                      <option value="ID_PERMATA">Permata</option>
                      <option value="ID_CIMB">CIMB Niaga</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                      Account Number
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={20}
                      value={xenditAccountNumber}
                      onChange={(e) => setXenditAccountNumber(e.target.value.replace(/\D/g, ""))}
                      placeholder="1234567890"
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                    Account Holder Name
                  </label>
                  <input
                    type="text"
                    value={xenditAccountHolderName}
                    onChange={(e) => setXenditAccountHolderName(e.target.value)}
                    placeholder="Full name as on bank account"
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Payout Details — shown when pay-at-hotel or bank transfer is enabled */}
        {(payAtHotel || bankTransfer) && (
          <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5 mb-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Payout Details</h3>
              <p className="text-[12px] text-gray-500 mt-0.5">
                Bank account where guests and vayada pay you.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Account Holder Name
                </label>
                <input
                  type="text"
                  value={payoutAccountHolder}
                  onChange={(e) => setPayoutAccountHolder(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g. Sunrise Beach Resort Ltd"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-medium text-gray-700 mb-1">
                  Account Format
                </label>
                <div className="inline-flex rounded-lg border border-gray-300 p-0.5 bg-gray-50">
                  <button
                    type="button"
                    onClick={() => setPayoutAccountType("iban")}
                    className={`px-3 py-1 text-[12px] font-medium rounded-md transition-colors ${
                      payoutAccountType === "iban"
                        ? "bg-white text-gray-900 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    IBAN
                  </button>
                  <button
                    type="button"
                    onClick={() => setPayoutAccountType("account_number")}
                    className={`px-3 py-1 text-[12px] font-medium rounded-md transition-colors ${
                      payoutAccountType === "account_number"
                        ? "bg-white text-gray-900 shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    Account Number
                  </button>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  {payoutAccountType === "iban"
                    ? "Use IBAN if your bank is in Europe or another IBAN country."
                    : "Use a plain account number for banks without IBAN (e.g. Indonesia, US)."}
                </p>
              </div>
              <div className="sm:col-span-2">
                {payoutAccountType === "iban" ? (
                  <>
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                      IBAN
                    </label>
                    <input
                      type="text"
                      value={payoutIban}
                      onChange={(e) => setPayoutIban(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder="e.g. GB29 NWBK 6016 1331 9268 19"
                    />
                  </>
                ) : (
                  <>
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                      Account Number
                    </label>
                    <input
                      type="text"
                      value={payoutAccountNumber}
                      onChange={(e) => setPayoutAccountNumber(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      placeholder="e.g. 1234567890"
                    />
                  </>
                )}
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  Bank Name
                </label>
                <input
                  type="text"
                  value={payoutBankName}
                  onChange={(e) => setPayoutBankName(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g. HSBC Bank"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">
                  SWIFT / BIC
                </label>
                <input
                  type="text"
                  value={payoutSwift}
                  onChange={(e) => setPayoutSwift(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g. HBUKGB4B"
                />
              </div>
            </div>
          </div>
        )}

        {/* Guest Information Form */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-3 mb-4">
          <h3 className="text-[13px] font-semibold text-gray-900">Guest Information Form</h3>
          <p className="text-[12px] text-gray-500 mb-2">
            Additional fields shown to guests during the booking process
          </p>

          {[
            {
              label: "Special Requests",
              value: specialRequests,
              setter: setSpecialRequests,
              badge: "Recommended",
            },
            {
              label: "Estimated Arrival Time",
              value: estimatedArrivalTime,
              setter: setEstimatedArrivalTime,
              badge: "",
            },
            {
              label: "Number of Guests",
              value: numberOfGuests,
              setter: setNumberOfGuests,
              badge: "",
            },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => item.setter(!item.value)}
              className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                item.value
                  ? "border-primary-500 bg-primary-50/30 ring-1 ring-primary-500"
                  : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-gray-900">{item.label}</span>
                {item.badge && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 bg-green-50 text-green-600 rounded-full">
                    {item.badge}
                  </span>
                )}
              </div>
              <div
                className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${item.value ? "bg-primary-500" : "bg-gray-300"}`}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${item.value ? "left-4" : "left-0.5"}`}
                />
              </div>
            </button>
          ))}
        </div>

        {/* Refer a Guest */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-[13px] font-semibold text-gray-900">
                &ldquo;Refer a Guest&rdquo; Feature
              </h3>
              <p className="text-[12px] text-gray-500 mt-0.5">
                Allow guests to refer friends and earn rewards through your booking page
              </p>
            </div>
            <button onClick={() => setEnableReferAGuest(!enableReferAGuest)} className="shrink-0">
              <div
                className={`w-9 h-5 rounded-full transition-colors relative ${enableReferAGuest ? "bg-primary-500" : "bg-gray-300"}`}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enableReferAGuest ? "left-4" : "left-0.5"}`}
                />
              </div>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-[12px] text-red-700 font-medium">{error}</p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={onBack}
            className="px-5 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back
          </button>
          <button
            onClick={onComplete}
            disabled={saving}
            className="px-5 py-2 bg-primary-500 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Launching...
              </>
            ) : (
              "Launch Property →"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
