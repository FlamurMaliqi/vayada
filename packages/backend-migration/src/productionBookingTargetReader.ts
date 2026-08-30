import type pg from "pg";

import type {
  BookingPropertyLink,
  BookingPropertySlug,
  BookingTargetRecord,
  ExistingBookingTargetRecord,
  ProductionBookingTargetState,
  ProductionMigrationSourceLink,
} from "./productionBookingTypes.js";

type QueryClient = Pick<pg.ClientBase, "query">;

const TABLES: Record<string, { product: "booking" | "platform"; table: string; freshness: string; id?: string }> = {
  booking_settings: { product: "booking", table: "booking.booking_settings", freshness: "updated_at", id: "property_id" },
  addon_definitions: { product: "booking", table: "booking.addon_definitions", freshness: "updated_at" },
  promo_definitions: { product: "booking", table: "booking.promo_definitions", freshness: "updated_at" },
  quote_sessions: { product: "booking", table: "booking.quote_sessions", freshness: "updated_at" },
  checkout_contexts: { product: "booking", table: "booking.checkout_contexts", freshness: "updated_at" },
  guest_bookings: { product: "booking", table: "booking.guest_bookings", freshness: "updated_at" },
  booking_guests: { product: "booking", table: "booking.booking_guests", freshness: "updated_at" },
  booking_addon_selections: { product: "booking", table: "booking.booking_addon_selections", freshness: "created_at" },
  promo_applications: { product: "booking", table: "booking.promo_applications", freshness: "created_at" },
  booking_status_events: { product: "booking", table: "booking.booking_status_events", freshness: "occurred_at" },
  booking_change_requests: { product: "booking", table: "booking.booking_change_requests", freshness: "updated_at" },
  direct_booking_summary_read_model: {
    product: "booking",
    table: "booking.direct_booking_summary_read_model",
    freshness: "projected_at",
    id: "guest_booking_id",
  },
  product_audit_events: { product: "platform", table: "platform.product_audit_events", freshness: "occurred_at" },
};

export async function readProductionBookingOwnership(client: QueryClient): Promise<{
  propertyLinks: BookingPropertyLink[];
  propertySlugs: BookingPropertySlug[];
}> {
  const links = await client.query<BookingPropertyLink>(
    `SELECT source_system AS "sourceSystem", source_table AS "sourceTable",
            source_id AS "sourceId", property_id::text AS "propertyId", relationship, status
     FROM hotel_catalog.property_source_links
     WHERE (source_system = 'booking' AND source_table = 'booking_hotels')
        OR (source_system = 'pms' AND source_table = 'hotels')
     ORDER BY source_system, source_table, source_id, property_id`,
  );
  const slugs = await client.query<BookingPropertySlug>(
    `SELECT slug, property_id::text AS "propertyId", purpose, status
     FROM hotel_catalog.property_slugs
     WHERE status = 'active'
     ORDER BY slug, property_id`,
  );
  return { propertyLinks: links.rows, propertySlugs: slugs.rows };
}

export async function readProductionBookingTargetState(
  client: QueryClient,
  candidates: BookingTargetRecord[],
  ownership: Awaited<ReturnType<typeof readProductionBookingOwnership>>,
): Promise<ProductionBookingTargetState> {
  const records: ExistingBookingTargetRecord[] = [];
  const grouped = new Map<string, string[]>();
  for (const candidate of candidates)
    grouped.set(candidate.targetTable, [
      ...(grouped.get(candidate.targetTable) ?? []),
      candidate.targetId,
    ]);
  for (const [targetTable, ids] of grouped) {
    const definition = TABLES[targetTable];
    if (!definition) throw new Error(`Unsupported Booking target table ${targetTable}`);
    const result = await client.query<{ targetId: string; updatedAt: string | null; rowData: string }>(
      `SELECT ${definition.id ?? "id"}::text AS "targetId", ${definition.freshness}::text AS "updatedAt",
              to_jsonb(target_row)::text AS "rowData"
       FROM ${definition.table} AS target_row
       WHERE ${definition.id ?? "id"} = ANY($1::uuid[])
       ORDER BY ${definition.id ?? "id"}`,
      [[...new Set(ids)]],
    );
    records.push(
      ...result.rows.map((row) => ({
        targetProduct: definition.product,
        targetTable,
        targetId: row.targetId,
        updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        row: camelize(JSON.parse(row.rowData) as Record<string, unknown>),
      })),
    );
  }
  const requestedLinks = candidates.map((row) => ({
    sourceDatabase: row.sourceDatabase,
    sourceTable: row.sourceTable,
    sourceId: row.sourceId,
    targetProduct: row.targetProduct,
    targetTable: row.targetTable,
    targetId: row.targetId,
  }));
  const provenance = requestedLinks.length
    ? await client.query<ProductionMigrationSourceLink>(
        `SELECT link.source_database AS "sourceDatabase", link.source_table AS "sourceTable",
                link.source_id AS "sourceId", link.target_product AS "targetProduct",
                link.target_table AS "targetTable", link.target_id AS "targetId",
                link.source_checksum AS "sourceChecksum",
                link.source_updated_at::text AS "sourceUpdatedAt",
                link.last_migrated_at::text AS "lastMigratedAt"
         FROM platform.production_migration_source_links link
         JOIN jsonb_to_recordset($1::jsonb) requested(
           "sourceDatabase" text, "sourceTable" text, "sourceId" text,
           "targetProduct" text, "targetTable" text, "targetId" text
         ) ON link.source_database = requested."sourceDatabase"
            AND link.source_table = requested."sourceTable"
            AND link.source_id = requested."sourceId"
            AND link.target_product = requested."targetProduct"
            AND link.target_table = requested."targetTable"
            AND link.target_id = requested."targetId"
         ORDER BY link.source_database, link.source_table, link.source_id,
                  link.target_product, link.target_table, link.target_id`,
        [JSON.stringify(requestedLinks)],
      )
    : { rows: [] as ProductionMigrationSourceLink[] };
  return {
    ...ownership,
    records,
    provenance: provenance.rows.map((row) => ({
      ...row,
      sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt).toISOString() : null,
      lastMigratedAt: new Date(row.lastMigratedAt).toISOString(),
    })),
  };
}

function camelize(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()),
      Array.isArray(entry)
        ? entry.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? camelize(item) : item))
        : entry && typeof entry === "object"
          ? camelize(entry)
          : entry,
    ]),
  );
}
