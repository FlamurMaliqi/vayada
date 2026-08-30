import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsTargetRecord } from "./productionPmsTypes.js";
import {
  date,
  iso,
  optionalArray,
  optionalObject,
  optionalText,
  requiredText,
  sha256,
} from "./productionBookingValues.js";

export function pmsRecord(
  source: IdentitySourceRow,
  targetTable: string,
  targetId: string,
  sourceUpdatedAt: string | null,
  mutable: boolean,
  row: Record<string, unknown>,
  checksumInput: unknown = source.data,
  targetProduct: "pms" | "platform" = "pms",
): PmsTargetRecord {
  return {
    targetProduct,
    targetTable,
    targetId,
    sourceDatabase: "pms",
    sourceTable: source.sourceTable,
    sourceId: sourceIdentity(source),
    sourceChecksum: sha256(checksumInput),
    sourceUpdatedAt,
    mutable,
    row,
  };
}

export function sourceIdentity(source: IdentitySourceRow): string {
  if (source.sourceTable === "booking_notification_deliveries")
    return [
      requiredText(source.data["booking_id"], "booking_id"),
      requiredText(source.data["notification_type"], "notification_type"),
      requiredText(source.data["recipient_email"], "recipient_email").toLowerCase(),
    ].join(":");
  if (source.sourceTable === "linked_inventory_group_members")
    return [
      requiredText(source.data["group_id"], "group_id"),
      requiredText(source.data["room_type_id"], "room_type_id"),
    ].join(":");
  if (
    source.sourceTable === "checkin_checklist_templates" ||
    source.sourceTable === "checkout_inspection_templates"
  )
    return requiredText(source.data["hotel_id"], "hotel_id");
  return requiredText(source.data["id"], "id");
}

export function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return value;
      }
    }
  }
  return value;
}

export function jsonArray(value: unknown, field: string): unknown[] {
  const parsed = jsonValue(value);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array`);
  return optionalArray(parsed);
}

export function jsonMap(value: unknown, field: string): Record<string, unknown> {
  const parsed = jsonValue(value);
  if (parsed === null) return {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${field} must be a JSON object`);
  return optionalObject(parsed);
}

export function optionalActor(value: unknown, field: string, userIds: Set<string>): string | null {
  const id = optionalText(value, field)?.toLowerCase() ?? null;
  if (id && !userIds.has(id)) throw new Error(`${field} references a missing target user`);
  return id;
}

export function signedDecimal(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric`);
  return parsed.toFixed(2);
}

export function percentage(value: unknown, field: string): string {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < -100 || parsed > 1000)
    throw new Error(`${field} must be a valid percentage`);
  return parsed.toFixed(4);
}

export function horizon(completedAt: string): { from: string; through: string } {
  const from = iso(completedAt, "completedAt").slice(0, 10);
  const throughDate = new Date(`${from}T00:00:00Z`);
  throughDate.setUTCDate(throughDate.getUTCDate() + 365);
  return { from, through: throughDate.toISOString().slice(0, 10) };
}

export function dates(from: string, through: string): string[] {
  const start = Date.parse(`${date(from, "from")}T00:00:00Z`);
  const end = Date.parse(`${date(through, "through")}T00:00:00Z`);
  const result: string[] = [];
  for (let value = start; value <= end; value += 86_400_000)
    result.push(new Date(value).toISOString().slice(0, 10));
  return result;
}

export function dateOverlaps(startsOn: string, endsOn: string, stayDate: string): boolean {
  return startsOn <= stayDate && endsOn > stayDate;
}

export function recurringDateRanges(
  from: unknown,
  to: unknown,
  bounded: { from: string; through: string },
): { startsOn: string; endsOn: string }[] {
  const start = requiredText(from, "from");
  const end = requiredText(to, "to");
  const startMonthDay = monthDay(start);
  const endMonthDay = monthDay(end);
  const firstYear = Number(bounded.from.slice(0, 4)) - 1;
  const lastYear = Number(bounded.through.slice(0, 4)) + 1;
  const ranges: { startsOn: string; endsOn: string }[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    const startsOn = validDate(`${year}-${startMonthDay}`);
    const endYear = startMonthDay > endMonthDay ? year + 1 : year;
    const endsOn = validDate(`${endYear}-${endMonthDay}`);
    if (!startsOn || !endsOn || endsOn < bounded.from || startsOn > bounded.through) continue;
    ranges.push({
      startsOn: startsOn < bounded.from ? bounded.from : startsOn,
      endsOn: endsOn > bounded.through ? bounded.through : endsOn,
    });
  }
  return ranges;
}

function monthDay(value: string): string {
  const match = /^(?:\d{4}-)?(\d{2}-\d{2})$/.exec(value);
  if (!match) throw new Error(`recurring date ${value} is unsupported`);
  return match[1]!;
}

function validDate(value: string): string | null {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}
