import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";

export function parseAuthRows<T>(
  rows: IdentitySourceRow[],
  table: string,
  blockers: IdentityMigrationBlocker[],
  build: (row: IdentitySourceRow) => T,
): T[] {
  return rows
    .filter((row) => row.sourceDatabase === "auth" && row.sourceTable === table)
    .flatMap((row) => {
      try {
        return [build(row)];
      } catch (error) {
        addBlocker(
          blockers,
          "INVALID_SOURCE_ROW",
          `auth.${table}`,
          typeof row.data["id"] === "string" ? row.data["id"] : `row:${row.rowOrdinal}`,
          error instanceof Error ? error.message : "Invalid row",
        );
        return [];
      }
    });
}

export function uniqueRows<T>(
  rows: T[],
  key: (row: T) => string,
  source: string,
  code: string,
  blockers: IdentityMigrationBlocker[],
): T[] {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    const current = result.get(id);
    if (current && stableJson(current) !== stableJson(row)) {
      addBlocker(blockers, code, source, id, "Rows with the same identity disagree");
      if (stableJson(row) < stableJson(current)) result.set(id, row);
    } else result.set(id, row);
  }
  return sortedBy([...result.values()], key);
}

export function addDuplicateValueBlockers<T>(
  rows: T[],
  value: (row: T) => string,
  owner: (row: T) => string,
  source: string,
  code: string,
  blockers: IdentityMigrationBlocker[],
): void {
  const groups = new Map<string, Set<string>>();
  for (const row of rows)
    groups.set(value(row), new Set([...(groups.get(value(row)) ?? []), owner(row)]));
  for (const [item, owners] of groups)
    if (owners.size > 1) addBlocker(blockers, code, source, item, "Value belongs to multiple rows");
}

export const addBlocker = (
  blockers: IdentityMigrationBlocker[],
  code: string,
  source: string,
  sourceId: string,
  message: string,
) => blockers.push({ code, source, sourceId, message });

export function assertKnownUser(id: string | null, users: Set<string>): void {
  if (id && !users.has(id)) throw new Error(`user_id ${id} is outside the accepted user cohort`);
}
export function stableJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}
export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}
export function optionalText(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value;
}
export function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
export const optionalBool = (value: unknown, field: string) =>
  value == null ? null : bool(value, field);
export function uuid(value: unknown, field: string): string {
  const result = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result))
    throw new Error(`${field} must be a UUID`);
  return result;
}
export const optionalUuid = (value: unknown, field: string) =>
  value == null || value === "" ? null : uuid(value, field);
export function date(value: unknown, field: string): string {
  if (typeof value !== "string" && !(value instanceof Date))
    throw new Error(`${field} must be a timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return parsed.toISOString();
}
export const optionalDate = (value: unknown, field: string) =>
  value == null || value === "" ? null : date(value, field);
export function newestDate(...values: Array<string | null>): string {
  const present = values.filter((value): value is string => value !== null);
  if (!present.length) throw new Error("At least one timestamp is required");
  return new Date(Math.max(...present.map((value) => Date.parse(value)))).toISOString();
}
