import { addPmsBlocker, propertyForHotel, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import { date, integer, iso, optionalIso, optionalText, uuid } from "./productionBookingValues.js";
import { dateOverlaps, dates, horizon, jsonArray, pmsRecord } from "./productionPmsValues.js";

const INVENTORY_STATUSES = new Set(["pending", "confirmed", "checked_in", "in_house"]);

export function buildPmsInventoryRecords(context: PmsBuildContext): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  const bounded = horizon(context.completedAt);
  const stayDates = dates(bounded.from, bounded.through);
  for (const source of context.rowsByTable.get("room_types") ?? []) {
    try {
      const facts = inventoryFacts(context, source);
      for (const stayDate of stayDates)
        records.push(inventoryDay(context, source, facts, stayDate));
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.room_types",
        safePmsSourceId(source),
        error instanceof Error ? error.message : "Invalid PMS inventory source",
      );
    }
  }
  return records;
}

type InventoryFacts = {
  propertyId: string;
  roomTypeId: string;
  totalCount: number;
  bookings: IdentitySourceRow[];
  drafts: IdentitySourceRow[];
  blocks: IdentitySourceRow[];
  linkedActivity: IdentitySourceRow[];
  checksumInput: unknown;
};

function inventoryFacts(context: PmsBuildContext, source: IdentitySourceRow): InventoryFacts {
  const roomTypeId = uuid(source.data["id"], "id");
  const hotelId = uuid(source.data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const totalCount = integer(source.data["total_rooms"], "total_rooms", 0);
  if (totalCount < 0 || totalCount > 500) throw new Error("total_rooms must be between 0 and 500");
  const bookings = rowsForRoomType(context, "bookings", roomTypeId);
  const drafts = rowsForRoomType(context, "booking_drafts", roomTypeId);
  const blocks = rowsForRoomType(context, "room_blocks", roomTypeId);
  const linkedGroupId = context.linkedGroupByRoomType.get(roomTypeId);
  const linkedMembers = linkedGroupId
    ? [...context.linkedGroupByRoomType.entries()]
        .filter(([, groupId]) => groupId === linkedGroupId)
        .map(([member]) => member)
    : [];
  const linkedActivity = linkedMembers.flatMap((member) => [
    ...rowsForRoomType(context, "bookings", member),
    ...rowsForRoomType(context, "booking_drafts", member),
    ...rowsForRoomType(context, "room_blocks", member),
  ]);
  for (const row of [...bookings, ...drafts, ...blocks]) {
    const rowHotelId = String(row.data["hotel_id"] ?? hotelId).toLowerCase();
    if (rowHotelId !== hotelId) throw new Error(`${row.sourceTable} crosses hotel inventory scope`);
  }
  return {
    propertyId,
    roomTypeId,
    totalCount,
    bookings,
    drafts,
    blocks,
    linkedActivity,
    checksumInput: {
      roomType: source.data,
      bookings: bookings.map((row) => row.data),
      drafts: drafts.map((row) => row.data),
      blocks: blocks.map((row) => row.data),
      linkedActivity: linkedActivity.map((row) => ({ table: row.sourceTable, row: row.data })),
    },
  };
}

function inventoryDay(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  facts: InventoryFacts,
  stayDate: string,
): PmsTargetRecord {
  const assignedCount = facts.bookings
    .filter((row) => activeBooking(context, row, stayDate))
    .reduce((sum, row) => sum + integer(row.data["number_of_rooms"], "number_of_rooms", 1), 0);
  const blockedCount = facts.blocks
    .filter((row) => activeBlock(row, stayDate))
    .reduce((sum, row) => sum + integer(row.data["blocked_count"], "blocked_count", 1), 0);
  const softHeldCount = facts.drafts
    .filter((row) => activeDraft(context, row, stayDate))
    .reduce((sum, row) => sum + integer(row.data["number_of_rooms"], "number_of_rooms", 1), 0);
  const linkedStopSell = facts.linkedActivity.some((row) => {
    if (row.sourceTable === "bookings") return activeBooking(context, row, stayDate);
    if (row.sourceTable === "booking_drafts") return activeDraft(context, row, stayDate);
    return activeBlock(row, stayDate);
  });
  const calendarOpen = operatingOn(source, stayDate) && advanceOpen(context, source, stayDate);
  if (assignedCount + blockedCount > facts.totalCount)
    throw new Error(
      `${stayDate} assigned (${assignedCount}) plus blocked (${blockedCount}) exceeds total_rooms (${facts.totalCount})`,
    );
  const availableCount =
    calendarOpen && !linkedStopSell
      ? Math.max(0, facts.totalCount - assignedCount - blockedCount - softHeldCount)
      : 0;
  const status =
    !calendarOpen || linkedStopSell
      ? "closed"
      : availableCount === facts.totalCount
        ? "open"
        : "limited";
  const targetId = `${facts.propertyId}:${facts.roomTypeId}:${stayDate}`;
  return pmsRecord(
    source,
    "inventory_days",
    targetId,
    context.completedAt,
    true,
    {
      propertyId: facts.propertyId,
      roomTypeId: facts.roomTypeId,
      stayDate,
      totalCount: facts.totalCount,
      assignedCount,
      blockedCount,
      availableCount,
      status,
      sourceFreshness: {
        migrationRunId: context.sourceRunId,
        sourceCompletedAt: context.completedAt,
        legacy: {
          assignedCount,
          blockedCount,
          softHeldCount,
          linkedStopSell,
          calendarOpen,
        },
      },
      updatedAt: context.completedAt,
      calendarRevision: null,
      inventoryRevision: null,
      generatedSellableLimitCount: null,
      channelSellableLimitCount: null,
      manualSellableLimitCount: null,
      effectiveSellableLimitCount: null,
      generatedSourceRevision: null,
      channelSourceRevision: null,
      manualSourceRevision: null,
      blockSourceRevision: null,
      bookingSourceRevision: null,
      linkedStopSell: false,
      linkedSourceRevision: 0,
    },
    { inventory: facts.checksumInput, stayDate },
  );
}

function rowsForRoomType(
  context: PmsBuildContext,
  table: string,
  roomTypeId: string,
): IdentitySourceRow[] {
  return (context.rowsByTable.get(table) ?? []).filter(
    (row) => String(row.data["room_type_id"] ?? "").toLowerCase() === roomTypeId,
  );
}

function activeBooking(
  context: PmsBuildContext,
  row: IdentitySourceRow,
  stayDate: string,
): boolean {
  const status = String(row.data["status"] ?? "").toLowerCase();
  if (!INVENTORY_STATUSES.has(status)) return false;
  if (
    status === "pending" &&
    String(row.data["payment_status"] ?? "unpaid").toLowerCase() === "unpaid" &&
    Date.parse(iso(row.data["created_at"], "created_at")) <
      Date.parse(context.completedAt) - 30 * 60_000
  )
    return false;
  return dateOverlaps(
    date(row.data["check_in"], "check_in"),
    date(row.data["check_out"], "check_out"),
    stayDate,
  );
}

function activeDraft(context: PmsBuildContext, row: IdentitySourceRow, stayDate: string): boolean {
  if (
    row.data["materialized_booking_id"] !== null &&
    row.data["materialized_booking_id"] !== undefined
  )
    return false;
  const expiresAt = optionalIso(row.data["expires_at"], "expires_at");
  if (!expiresAt || Date.parse(expiresAt) <= Date.parse(context.completedAt)) return false;
  return dateOverlaps(
    date(row.data["check_in"], "check_in"),
    date(row.data["check_out"], "check_out"),
    stayDate,
  );
}

function activeBlock(row: IdentitySourceRow, stayDate: string): boolean {
  return dateOverlaps(
    date(row.data["start_date"], "start_date"),
    date(row.data["end_date"], "end_date"),
    stayDate,
  );
}

function operatingOn(source: IdentitySourceRow, stayDate: string): boolean {
  const periods = jsonArray(source.data["operating_periods"], "operating_periods");
  if (!periods.length) return true;
  const monthDay = stayDate.slice(5);
  return periods.some((period, index) => {
    if (!period || typeof period !== "object" || Array.isArray(period))
      throw new Error(`operating_periods[${index}] must be an object`);
    const from = optionalText((period as Record<string, unknown>)["from"], "period.from");
    const to = optionalText((period as Record<string, unknown>)["to"], "period.to");
    if (!from || !to) return false;
    return from > to ? monthDay >= from || monthDay <= to : monthDay >= from && monthDay <= to;
  });
}

function advanceOpen(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  stayDate: string,
): boolean {
  const minimum = integer(source.data["minimum_advance_days"], "minimum_advance_days", 0);
  const daysAhead =
    (Date.parse(`${stayDate}T00:00:00Z`) -
      Date.parse(`${context.completedAt.slice(0, 10)}T00:00:00Z`)) /
    86_400_000;
  return daysAhead >= minimum;
}
