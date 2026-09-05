import { stripeCurrencyHasZeroDecimals } from "@vayada/domain-finance";
const UNSUPPORTED_THREE_DECIMAL_CURRENCIES = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function stripeAmountMinor(amount: string | number, currency: string): number {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new Error("Stripe currency must be a three-letter ISO code.");
  }
  if (UNSUPPORTED_THREE_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    throw new Error(`${normalizedCurrency} card payments are not supported.`);
  }
  const normalizedAmount = String(amount).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalizedAmount);
  if (!match) throw new Error("Stripe amount must be a non-negative decimal value.");
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (!Number.isSafeInteger(whole)) throw new Error("Stripe amount exceeds safe integer range.");
  if (stripeCurrencyHasZeroDecimals(normalizedCurrency)) {
    if (Number(fraction) !== 0) {
      throw new Error(`${normalizedCurrency} card amounts cannot include fractional units.`);
    }
    return whole;
  }
  const minor = whole * 100 + Number(fraction);
  if (!Number.isSafeInteger(minor)) throw new Error("Stripe amount exceeds safe integer range.");
  return minor;
}

export function stripeAmountDecimal(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("Stripe minor amount must be a non-negative safe integer.");
  }
  const normalizedCurrency = currency.trim().toUpperCase();
  if (UNSUPPORTED_THREE_DECIMAL_CURRENCIES.has(normalizedCurrency)) {
    throw new Error(`${normalizedCurrency} card payments are not supported.`);
  }
  return stripeCurrencyHasZeroDecimals(normalizedCurrency)
    ? `${amountMinor}.00`
    : `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`;
}

export function stripeApplicationFeeMinor(
  grossAmountMinor: number,
  plan: string | null | undefined,
  commissionPercent: number | null | undefined,
): number {
  if (plan !== "commission") return 0;
  const percent = Number(commissionPercent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Booking commission percentage is invalid.");
  }
  return Math.round((grossAmountMinor * percent) / 100);
}
