import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type {
  FinanceBuildContext,
  ProductionFinanceTargetState,
} from "./productionFinanceTypes.js";
import { requiredText, uuid } from "./productionBookingValues.js";

export function createProductionFinanceContext(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionFinanceTargetState;
}): FinanceBuildContext {
  const context: FinanceBuildContext = {
    ...input,
    blockers: [...(input.target.blockers ?? [])],
    rowsBySource: groupBy(input.rows, (row) => `${row.sourceDatabase}:${row.sourceTable}`),
    propertyBySource: new Map(),
    organizationByResource: new Map(),
    guestBookingByPmsId: new Map(),
    pmsBookingById: new Map(),
    pmsAffiliateById: new Map(),
    pmsAffiliatesByUserId: new Map(),
    pmsSettingsByProperty: new Map(),
  };
  indexPropertyLinks(context);
  indexResourceLinks(context);
  context.guestBookingByPmsId = uniqueIndex(
    context,
    input.target.guestBookings,
    (row) => row.sourceBookingId.toLowerCase(),
    "booking.guest_bookings",
  );
  context.pmsBookingById = indexRows(context, "pms", "bookings");
  context.pmsAffiliateById = indexRows(context, "pms", "affiliates");
  context.pmsAffiliatesByUserId = groupBy(
    [...context.pmsAffiliateById.values()].filter((row) => row.data["user_id"]),
    (row) => uuid(row.data["user_id"], "user_id"),
  );
  for (const row of context.rowsBySource.get("pms:hotel_payment_settings") ?? []) {
    try {
      const propertyId = propertyFor(context, "pms", "hotels", row.data["hotel_id"]);
      if (context.pmsSettingsByProperty.has(propertyId))
        block(
          context,
          "DUPLICATE_PROPERTY_PAYMENT_SETTINGS",
          "pms.hotel_payment_settings",
          propertyId,
          "More than one legacy payment setting resolves to the property",
        );
      else context.pmsSettingsByProperty.set(propertyId, row);
    } catch (error) {
      blockRow(context, row, error);
    }
  }
  return context;
}

function indexPropertyLinks(context: FinanceBuildContext): void {
  const duplicates = new Set<string>();
  for (const link of context.target.propertyLinks) {
    const key = `${link.sourceSystem}:${link.sourceTable}:${link.sourceId.toLowerCase()}`;
    if (
      link.migrationRunId !== context.sourceRunId ||
      link.status !== "active" ||
      link.relationship !== expectedPropertyRelationship(link.sourceSystem, link.sourceTable)
    ) {
      block(
        context,
        "FINANCE_PROPERTY_LINK_INVALID",
        `${link.sourceSystem}.${link.sourceTable}`,
        link.sourceId,
        "Canonical property link is not active evidence from this extraction run",
      );
      continue;
    }
    const prior = context.propertyBySource.get(key);
    if (prior && prior !== link.propertyId.toLowerCase()) duplicates.add(key);
    else context.propertyBySource.set(key, link.propertyId.toLowerCase());
  }
  for (const key of duplicates) {
    context.propertyBySource.delete(key);
    const [, table, sourceId] = key.split(":");
    block(
      context,
      "AMBIGUOUS_FINANCE_PROPERTY",
      table ?? "property_source_links",
      sourceId ?? key,
      "Legacy property resolves to multiple canonical properties",
    );
  }
}

function expectedPropertyRelationship(sourceSystem: string, sourceTable: string): string | null {
  if (sourceSystem === "booking" && sourceTable === "booking_hotels") return "canonical_input";
  if (sourceSystem === "pms" && sourceTable === "hotels") return "operational_input";
  return null;
}

function indexResourceLinks(context: FinanceBuildContext): void {
  const duplicates = new Set<string>();
  for (const link of context.target.resourceLinks) {
    if (
      !["active", "suspended", "archived"].includes(link.status) ||
      link.relationship !== expectedRelationship(link.product, link.resourceType)
    )
      continue;
    const key = `${link.product}:${link.resourceType}:${link.resourceId.toLowerCase()}`;
    const prior = context.organizationByResource.get(key);
    if (prior && prior !== link.organizationId.toLowerCase()) duplicates.add(key);
    else context.organizationByResource.set(key, link.organizationId.toLowerCase());
  }
  for (const key of duplicates) {
    context.organizationByResource.delete(key);
    block(
      context,
      "AMBIGUOUS_FINANCE_OWNER",
      "identity.organization_resource_links",
      key,
      "Legacy finance owner resolves to multiple organizations",
    );
  }
}

export function propertyFor(
  context: FinanceBuildContext,
  system: "booking" | "pms",
  table: "booking_hotels" | "hotels",
  value: unknown,
): string {
  const id = uuid(value, table === "hotels" ? "hotel_id" : "id");
  const propertyId = context.propertyBySource.get(`${system}:${table}:${id}`);
  if (!propertyId) throw new Error(`${system}.${table} ${id} has no accepted property link`);
  return propertyId;
}

export function organizationFor(
  context: FinanceBuildContext,
  product: "booking" | "pms" | "affiliate",
  resourceType: "booking_hotel" | "pms_hotel" | "affiliate",
  value: unknown,
): string {
  const id = uuid(value, `${resourceType}_id`);
  const organizationId = context.organizationByResource.get(`${product}:${resourceType}:${id}`);
  if (!organizationId)
    throw new Error(`${product}.${resourceType} ${id} has no accepted organization owner`);
  return organizationId;
}

export function resourceStatusFor(
  context: FinanceBuildContext,
  product: "booking" | "pms" | "affiliate",
  resourceType: "booking_hotel" | "pms_hotel" | "affiliate",
  value: unknown,
): string {
  const id = uuid(value, `${resourceType}_id`);
  const matches = context.target.resourceLinks.filter(
    (link) =>
      link.product === product &&
      link.resourceType === resourceType &&
      link.resourceId.toLowerCase() === id &&
      link.relationship === expectedRelationship(product, resourceType) &&
      ["active", "suspended", "archived"].includes(link.status),
  );
  if (matches.length !== 1)
    throw new Error(`${product}.${resourceType} ${id} has ${matches.length} accepted owner links`);
  return matches[0]!.status;
}

function expectedRelationship(product: string, resourceType: string): string | null {
  if (product === "booking" && resourceType === "booking_hotel") return "owner";
  if (product === "pms" && resourceType === "pms_hotel") return "operator";
  if (product === "affiliate" && resourceType === "affiliate") return "owner";
  return null;
}

export function sourceId(row: IdentitySourceRow, fallback = "id"): string {
  return requiredText(row.data[fallback], fallback).toLowerCase();
}

export function sourceRows(
  context: FinanceBuildContext,
  database: string,
  table: string,
): IdentitySourceRow[] {
  return context.rowsBySource.get(`${database}:${table}`) ?? [];
}

export function block(
  context: FinanceBuildContext,
  code: string,
  source: string,
  sourceId: string,
  message: string,
): void {
  context.blockers.push({ code, source, sourceId, message });
}

export function blockRow(
  context: FinanceBuildContext,
  row: IdentitySourceRow,
  error: unknown,
): void {
  let id: string;
  try {
    id = sourceId(
      row,
      row.sourceTable === "affiliate_payout_settings"
        ? "user_id"
        : row.sourceTable === "stripe_billing_webhook_events"
          ? "event_id"
          : "id",
    );
  } catch {
    id = String(row.rowOrdinal);
  }
  block(
    context,
    "INVALID_FINANCE_SOURCE_ROW",
    `${row.sourceDatabase}.${row.sourceTable}`,
    id,
    error instanceof Error ? error.message : "Invalid Finance source row",
  );
}

function indexRows(
  context: FinanceBuildContext,
  database: string,
  table: string,
): Map<string, IdentitySourceRow> {
  const rows = sourceRows(context, database, table);
  return uniqueIndex(context, rows, (row) => sourceId(row), `${database}.${table}`);
}

function uniqueIndex<T>(
  context: FinanceBuildContext,
  values: T[],
  key: (value: T) => string,
  source: string,
): Map<string, T> {
  const result = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const value of values) {
    try {
      const id = key(value);
      if (result.has(id)) duplicates.add(id);
      else result.set(id, value);
    } catch (error) {
      block(
        context,
        "INVALID_FINANCE_SOURCE_ROW",
        source,
        "unknown",
        error instanceof Error ? error.message : "Invalid identity",
      );
    }
  }
  for (const id of duplicates) {
    result.delete(id);
    block(
      context,
      "DUPLICATE_FINANCE_SOURCE_ID",
      source,
      id,
      "More than one source row has this identity",
    );
  }
  return result;
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const label = key(value);
    const group = result.get(label);
    if (group) group.push(value);
    else result.set(label, [value]);
  }
  return result;
}
