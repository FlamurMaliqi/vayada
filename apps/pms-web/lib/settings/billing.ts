const STRIPE_ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export function formatBillingAmount(amountMinor: number, currency: string): string {
  const normalized = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(normalized)) return String(amountMinor);
  const amount = amountMinor / (STRIPE_ZERO_DECIMAL.has(normalized) ? 1 : 100);
  const zeroDisplayDecimals = normalized === "IDR" || STRIPE_ZERO_DECIMAL.has(normalized);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalized,
      minimumFractionDigits: zeroDisplayDecimals ? 0 : 2,
      maximumFractionDigits: zeroDisplayDecimals ? 0 : 2,
    }).format(amount);
  } catch {
    return String(amountMinor);
  }
}

export function formatInvoiceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return [date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear()]
    .map((part, index) => (index < 2 ? String(part).padStart(2, "0") : String(part)))
    .join(".");
}
