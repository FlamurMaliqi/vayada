import { createHash } from "node:crypto";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function deterministicUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function sourceId(row: IdentitySourceRow, fallbackField = "id"): string {
  return requiredText(row.data[fallbackField], fallbackField);
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty text`);
  return value.trim();
}

export function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, field);
}

export function uuid(value: unknown, field: string): string {
  const parsed = requiredText(value, field).toLowerCase();
  if (!UUID.test(parsed)) throw new Error(`${field} must be a UUID`);
  return parsed;
}

export function optionalUuid(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === "" ? null : uuid(value, field);
}

export function iso(value: unknown, field: string): string {
  const parsed = new Date(requiredText(value, field));
  if (!Number.isFinite(parsed.valueOf())) throw new Error(`${field} must be a timestamp`);
  return parsed.toISOString();
}

export function optionalIso(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === "" ? null : iso(value, field);
}

export function date(value: unknown, field: string): string {
  const parsed = requiredText(value, field).slice(0, 10);
  if (!DATE.test(parsed) || !Number.isFinite(Date.parse(`${parsed}T00:00:00Z`)))
    throw new Error(`${field} must be a date`);
  return parsed;
}

export function optionalDate(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === "" ? null : date(value, field);
}

export function bool(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${field} must be boolean`);
  }
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

export function integer(value: unknown, field: string, fallback?: number): number {
  if ((value === null || value === undefined) && fallback !== undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

export function money(value: unknown, field: string, fallback?: string): string {
  if ((value === null || value === undefined || value === "") && fallback !== undefined)
    return fallback;
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be non-negative money`);
  return parsed.toFixed(2);
}

export function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

export function optionalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function optionalArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function currency(value: unknown, field = "currency"): string {
  const parsed = requiredText(value, field).toUpperCase();
  if (!/^[A-Z]{3}$/.test(parsed)) throw new Error(`${field} must be a currency code`);
  return parsed;
}

export function bookingLifecycle(value: unknown): string {
  const status = requiredText(value, "status").toLowerCase();
  const mapped: Record<string, string> = {
    pending: "pending_payment",
    confirmed: "confirmed",
    checked_in: "confirmed",
    in_house: "confirmed",
    checked_out: "completed",
    cancelled: "canceled",
    canceled: "canceled",
    declined: "declined",
    no_show: "no_show",
    expired: "expired",
  };
  if (!mapped[status]) throw new Error(`status ${status} is unsupported`);
  return mapped[status];
}

export function bookingPayment(value: unknown): string {
  const status = requiredText(value ?? "unpaid", "payment_status").toLowerCase();
  const mapped: Record<string, string> = {
    unpaid: "unpaid",
    awaiting_transfer: "unpaid",
    pay_at_property: "unpaid",
    authorized: "authorized",
    captured: "paid",
    paid: "paid",
    partially_refunded: "refunded",
    refunded: "refunded",
    failed: "failed",
    cancelled: "failed",
    canceled: "failed",
  };
  if (!mapped[status]) throw new Error(`payment_status ${status} is unsupported`);
  return mapped[status];
}

export function redactPrivate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPrivate);
  if (!value || typeof value !== "object") return value;
  const blocked = /email|phone|name|address|passport|birth|request|guest|token|secret/i;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !blocked.test(key))
      .map(([key, entry]) => [key, redactPrivate(entry)]),
  );
}
