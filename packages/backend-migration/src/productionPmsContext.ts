import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import type {
  PmsBuildContext,
  PmsMediaReference,
  PmsPropertyLink,
  ProductionPmsTargetState,
} from "./productionPmsTypes.js";
import { requiredText, sourceId } from "./productionBookingValues.js";

const ID_TABLES = [
  "booking_checkin_records",
  "booking_checkout_charges",
  "booking_checkout_records",
  "booking_events",
  "booking_notes",
  "booking_rooms",
  "bookings",
  "cancellation_policies",
  "channex_booking_mappings",
  "channex_channel_markups",
  "channex_connections",
  "channex_rate_plan_mappings",
  "channex_room_type_mappings",
  "channex_webhook_events",
  "hotels",
  "linked_inventory_groups",
  "message_attachments",
  "message_threads",
  "messages",
  "room_blocks",
  "room_types",
  "rooms",
] as const;

export function createProductionPmsContext(input: {
  sourceRunId: string;
  snapshotAt?: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionPmsTargetState;
}): PmsBuildContext {
  const blockers = [...(input.target.blockers ?? [])];
  const rowsByTable = new Map<string, IdentitySourceRow[]>();
  for (const row of input.rows)
    rowsByTable.set(row.sourceTable, [...(rowsByTable.get(row.sourceTable) ?? []), row]);
  const maps = new Map<string, Map<string, IdentitySourceRow>>();
  for (const table of ID_TABLES)
    maps.set(table, uniqueRows(rowsByTable.get(table) ?? [], table, blockers));
  const propertyByHotel = propertyMap(input.target.propertyLinks, blockers);
  const targetBookingById = uniqueTargetBookings(input.target, blockers);
  const connectionByHotel = uniqueConnectionByHotel(
    rowsByTable.get("channex_connections") ?? [],
    blockers,
  );
  validateExternalConnectionOwnership(rowsByTable.get("channex_connections") ?? [], blockers);
  const linkedGroupByRoomType = linkedMemberships(
    rowsByTable.get("linked_inventory_group_members") ?? [],
    maps.get("linked_inventory_groups")!,
    maps.get("room_types")!,
    blockers,
  );
  const mediaBySource = uniqueMedia(input.target.media ?? [], blockers);
  return {
    ...input,
    snapshotAt: input.snapshotAt ?? input.completedAt,
    blockers,
    rowsByTable,
    propertyByHotel,
    hotelById: maps.get("hotels")!,
    bookingById: maps.get("bookings")!,
    targetBookingById,
    roomTypeById: maps.get("room_types")!,
    roomById: maps.get("rooms")!,
    connectionByHotel,
    linkedGroupByRoomType,
    userIds: new Set(input.target.userIds.map((id) => id.toLowerCase())),
    mediaIds: new Set(input.target.mediaIds.map((id) => id.toLowerCase())),
    mediaBySource,
  };
}

export function pmsMediaForSource(
  context: PmsBuildContext,
  input: {
    sourceTable: string;
    sourceRowId: string;
    purpose: PmsMediaReference["purpose"];
    propertyId: string;
    visibility: PmsMediaReference["visibility"];
  },
): PmsMediaReference {
  const media = context.mediaBySource.get(mediaSourceKey(input));
  if (!media)
    throw new Error(
      `media ${input.sourceTable}:${input.sourceRowId} has not passed the VAY-1055 gate`,
    );
  if (
    media.propertyId !== input.propertyId ||
    media.purpose !== input.purpose ||
    media.visibility !== input.visibility ||
    media.lifecycleStatus !== "active"
  )
    throw new Error(
      `media ${media.mediaObjectId} does not match the active property-scoped VAY-1055 contract`,
    );
  if (input.visibility === "public") {
    if (!media.publicApproved || !media.publicUrl || rawS3Url(media.publicUrl))
      throw new Error(`public media ${media.mediaObjectId} has no approved CDN variant`);
  } else if (
    media.publicApproved ||
    media.publicUrl ||
    !media.storageKey.startsWith("private/media/")
  ) {
    throw new Error(`private media ${media.mediaObjectId} is not private Vayada-managed storage`);
  }
  return media;
}

function uniqueMedia(
  rows: PmsMediaReference[],
  blockers: IdentityMigrationBlocker[],
): Map<string, PmsMediaReference> {
  const result = new Map<string, PmsMediaReference>();
  for (const row of rows) {
    const key = mediaSourceKey(row);
    if (result.has(key)) {
      blockers.push({
        code: "AMBIGUOUS_MEDIA_REFERENCE",
        source: `pms.${row.sourceTable}`,
        sourceId: row.sourceRowId,
        message: "More than one target media object owns this source reference",
      });
      result.delete(key);
    } else result.set(key, row);
  }
  return result;
}

function mediaSourceKey(value: {
  sourceTable: string;
  sourceRowId: string;
  purpose: string;
}): string {
  return `${value.sourceTable}:${value.sourceRowId}:${value.purpose}`;
}

function rawS3Url(value: string): boolean {
  try {
    return /(^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(new URL(value).hostname);
  } catch {
    return true;
  }
}

export function propertyForHotel(context: PmsBuildContext, value: unknown): string {
  const hotelId = requiredText(value, "hotel_id").toLowerCase();
  const propertyId = context.propertyByHotel.get(hotelId);
  if (!propertyId) throw new Error(`no active canonical property link for pms.hotels ${hotelId}`);
  return propertyId;
}

export function addPmsBlocker(
  context: Pick<PmsBuildContext, "blockers">,
  code: string,
  source: string,
  sourceRowId: string,
  message: string,
): void {
  context.blockers.push({ code, source, sourceId: sourceRowId, message });
}

export function safePmsSourceId(row: IdentitySourceRow, fallbackField = "id"): string {
  try {
    return sourceId(row, fallbackField);
  } catch {
    return String(row.rowOrdinal);
  }
}

function propertyMap(
  links: PmsPropertyLink[],
  blockers: PmsBuildContext["blockers"],
): Map<string, string> {
  const grouped = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.status !== "active" || link.relationship !== "operational_input") continue;
    const key = link.sourceId.toLowerCase();
    grouped.set(key, new Set([...(grouped.get(key) ?? []), link.propertyId]));
  }
  const result = new Map<string, string>();
  for (const [source, properties] of grouped) {
    if (properties.size === 1) result.set(source, [...properties][0]!);
    else
      blockers.push({
        code: "AMBIGUOUS_PROPERTY_SOURCE_LINK",
        source: "hotel_catalog.property_source_links",
        sourceId: source,
        message: "PMS hotel resolves to more than one target property",
      });
  }
  return result;
}

function uniqueRows(
  rows: IdentitySourceRow[],
  table: string,
  blockers: PmsBuildContext["blockers"],
): Map<string, IdentitySourceRow> {
  const result = new Map<string, IdentitySourceRow>();
  for (const row of rows) {
    try {
      const id = requiredText(row.data["id"], "id").toLowerCase();
      if (result.has(id))
        blockers.push({
          code: "DUPLICATE_SOURCE_ID",
          source: `pms.${table}`,
          sourceId: id,
          message: "Source ID is duplicated",
        });
      else result.set(id, row);
    } catch (error) {
      blockers.push({
        code: "INVALID_SOURCE_ROW",
        source: `pms.${table}`,
        sourceId: String(row.rowOrdinal),
        message: error instanceof Error ? error.message : "Invalid source ID",
      });
    }
  }
  return result;
}

function uniqueTargetBookings(
  target: ProductionPmsTargetState,
  blockers: PmsBuildContext["blockers"],
): PmsBuildContext["targetBookingById"] {
  const result = new Map<string, (typeof target.bookings)[number]>();
  for (const booking of target.bookings) {
    const id = booking.id.toLowerCase();
    if (result.has(id))
      blockers.push({
        code: "DUPLICATE_TARGET_BOOKING",
        source: "booking.guest_bookings",
        sourceId: id,
        message: "Target Booking identity is duplicated",
      });
    else result.set(id, booking);
  }
  return result;
}

function uniqueConnectionByHotel(
  rows: IdentitySourceRow[],
  blockers: PmsBuildContext["blockers"],
): Map<string, IdentitySourceRow> {
  const result = new Map<string, IdentitySourceRow>();
  for (const row of rows) {
    const hotelId = String(row.data["hotel_id"] ?? "").toLowerCase();
    if (!hotelId) continue;
    if (result.has(hotelId))
      blockers.push({
        code: "DUPLICATE_CHANNEL_CONNECTION",
        source: "pms.channex_connections",
        sourceId: hotelId,
        message: "More than one legacy Channex connection exists for a hotel",
      });
    else result.set(hotelId, row);
  }
  return result;
}

function validateExternalConnectionOwnership(
  rows: IdentitySourceRow[],
  blockers: PmsBuildContext["blockers"],
): void {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    const externalId = String(row.data["channex_property_id"] ?? "").toLowerCase();
    const hotelId = String(row.data["hotel_id"] ?? "").toLowerCase();
    if (!externalId || !hotelId) continue;
    owners.set(externalId, new Set([...(owners.get(externalId) ?? []), hotelId]));
  }
  for (const [externalId, hotels] of owners)
    if (hotels.size > 1)
      blockers.push({
        code: "DUPLICATE_EXTERNAL_PROPERTY_ID",
        source: "pms.channex_connections",
        sourceId: externalId,
        message: "External Channex property ID is owned by more than one legacy hotel",
      });
}

function linkedMemberships(
  rows: IdentitySourceRow[],
  groups: Map<string, IdentitySourceRow>,
  roomTypes: Map<string, IdentitySourceRow>,
  blockers: PmsBuildContext["blockers"],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    const groupId = String(row.data["group_id"] ?? "").toLowerCase();
    const roomTypeId = String(row.data["room_type_id"] ?? "").toLowerCase();
    if (!groups.has(groupId) || !roomTypes.has(roomTypeId)) {
      blockers.push({
        code: "ORPHAN_LINKED_INVENTORY_MEMBER",
        source: "pms.linked_inventory_group_members",
        sourceId: `${groupId}:${roomTypeId}`,
        message: "Linked inventory member references a missing group or room type",
      });
    } else if (result.has(roomTypeId)) {
      blockers.push({
        code: "DUPLICATE_LINKED_INVENTORY_MEMBERSHIP",
        source: "pms.linked_inventory_group_members",
        sourceId: roomTypeId,
        message: "Room type belongs to more than one linked inventory group",
      });
    } else result.set(roomTypeId, groupId);
  }
  return result;
}
