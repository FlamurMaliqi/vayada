export { CURRENCY_OPTIONS, TIMEZONE_OPTIONS, type CurrencyOption } from "@vayada/locale-constants";

import { CURRENCY_OPTIONS as _CURRENCY_OPTIONS } from "@vayada/locale-constants";

export const CURRENCIES = _CURRENCY_OPTIONS.map((c) => ({
  value: c.code,
  label: `${c.flag} ${c.name} (${c.code})`,
}));

// Raw HTTP status reason-phrases (e.g. "Not Found", "Bad Gateway") leak
// through when the API returns FastAPI's default {"detail": "<phrase>"}.
// They tell the user nothing actionable, so swap them for the fallback.
const RAW_HTTP_PHRASES = new Set([
  "not found",
  "internal server error",
  "bad request",
  "forbidden",
  "unauthorized",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "unprocessable entity",
  "conflict",
  "method not allowed",
  "request timeout",
]);

export function humanizeApiError(err: any, fallback: string): string {
  const msg = (err?.message || "").trim();
  if (!msg) return fallback;
  if (RAW_HTTP_PHRASES.has(msg.toLowerCase())) return fallback;
  return msg;
}
