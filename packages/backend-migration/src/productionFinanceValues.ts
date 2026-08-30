import { CURRENCY_OPTIONS } from "@vayada/locale-constants";

import { requiredText } from "./productionBookingValues.js";

const SUPPORTED_CURRENCIES = new Set(CURRENCY_OPTIONS.map(({ code }) => code));

export function exactMoney(value: unknown, field: string, fallback?: string): string {
  if ((value === null || value === undefined || value === "") && fallback !== undefined)
    return fallback;
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`${field} must be non-negative money with at most 2 decimals`);
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const minor = BigInt(whole) * 100n + BigInt(fraction || "0");
  if (minor > 999_999_999_999_999n) throw new Error(`${field} exceeds target precision`);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
}

export function exactRate(value: unknown, field: string): string {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  const match = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(text);
  if (
    !match ||
    Number(match[1]) > 100 ||
    (Number(match[1]) === 100 && /[1-9]/.test(match[2] ?? ""))
  )
    throw new Error(`${field} must be between 0 and 100 with at most 4 decimals`);
  const whole = String(Number(match[1]));
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function subtractMoney(amount: string, fee: string, field: string): string {
  const left = toMinor(amount);
  const right = toMinor(fee);
  if (right > left) throw new Error(`${field} exceeds amount`);
  const result = left - right;
  return `${result / 100n}.${String(result % 100n).padStart(2, "0")}`;
}

export function compareMoney(left: string, right: string): number {
  return toMinor(left) < toMinor(right) ? -1 : toMinor(left) > toMinor(right) ? 1 : 0;
}

export function sumMoney(values: string[]): string {
  const total = values.reduce((sum, value) => sum + toMinor(value), 0n);
  return `${total / 100n}.${String(total % 100n).padStart(2, "0")}`;
}

export function minorUnits(value: string): bigint {
  return toMinor(value);
}

export function normalizeProvider(value: unknown): "stripe" | "xendit" | "vayada" {
  const provider = requiredText(value, "payment_provider").toLowerCase();
  if (provider !== "stripe" && provider !== "xendit" && provider !== "vayada")
    throw new Error(`payment_provider ${provider} is unsupported`);
  return provider;
}

export function supportedCurrency(value: unknown, field = "currency"): string {
  const code = requiredText(value, field).toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(code)) throw new Error(`${field} ${code} is unsupported`);
  return code;
}

function toMinor(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
