import { addPmsBlocker, propertyForHotel, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import {
  bool,
  date,
  integer,
  iso,
  optionalDate,
  optionalIso,
  optionalText,
  uuid,
} from "./productionBookingValues.js";
import { dateOverlaps, dates, jsonArray, jsonMap, pmsRecord } from "./productionPmsValues.js";

const INVENTORY_STATUSES = new Set(["pending", "confirmed", "checked_in", "in_house"]);

export function buildPmsInventoryRecords(context: PmsBuildContext): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  blockActiveDrafts(context);
  const existingInventory = new Map(
    context.target.records
      .filter((record) => record.targetTable === "inventory_days")
      .map((record) => [record.targetId, record]),
  );
  for (const source of context.rowsByTable.get("room_types") ?? []) {
    try {
      const facts = inventoryFacts(context, source);
      const bounded = propertyHorizon(context.snapshotAt, facts.hotel);
      const stayDates = dates(bounded.from, bounded.through);
      for (const stayDate of stayDates)
        records.push(inventoryDay(context, source, facts, stayDate, existingInventory));
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
  hotel: IdentitySourceRow;
  checksumInput: unknown;
};

function inventoryFacts(context: PmsBuildContext, source: IdentitySourceRow): InventoryFacts {
  const roomTypeId = uuid(source.data["id"], "id");
  const hotelId = uuid(source.data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const hotel = context.hotelById.get(hotelId);
  if (!hotel) throw new Error(`hotels ${hotelId} source is missing`);
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
    hotel,
    checksumInput: {
      hotel: hotel.data,
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
  existingInventory: Map<string, PmsBuildContext["target"]["records"][number]>,
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
  const calendarOpen = sellableAtSnapshot(context, source, facts.hotel, stayDate);
  if (assignedCount + blockedCount > facts.totalCount)
    throw new Error(
      `${stayDate} assigned (${assignedCount}) plus blocked (${blockedCount}) exceeds total_rooms (${facts.totalCount})`,
    );
  const availableCount =
    calendarOpen && !linkedStopSell
      ? Math.max(0, facts.totalCount - assignedCount - blockedCount - softHeldCount)
      : 0;
  const status = calendarOpen ? "open" : "closed";
  const targetId = `${facts.propertyId}:${facts.roomTypeId}:${stayDate}`;
  const linkedSourceRevision = nextLinkedSourceRevision(
    existingInventory.get(targetId),
    linkedStopSell,
  );
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
        sourceSnapshotAt: context.snapshotAt,
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
      linkedStopSell,
      linkedSourceRevision,
    },
    { inventory: facts.checksumInput, stayDate },
  );
}

function nextLinkedSourceRevision(
  current: PmsBuildContext["target"]["records"][number] | undefined,
  linkedStopSell: boolean,
): number {
  if (!current) return linkedStopSell ? 1 : 0;
  const previous = current.row["linkedStopSell"] === true;
  const revision = integer(current.row["linkedSourceRevision"], "linked_source_revision", 0);
  if (previous === linkedStopSell) return revision;
  if (revision >= 2_147_483_647) throw new Error("linked_source_revision is exhausted");
  return revision + 1;
}

function blockActiveDrafts(context: PmsBuildContext): void {
  for (const draft of context.rowsByTable.get("booking_drafts") ?? []) {
    try {
      if (
        draft.data["materialized_booking_id"] !== null &&
        draft.data["materialized_booking_id"] !== undefined
      )
        continue;
      const expiresAt = optionalIso(draft.data["expires_at"], "expires_at");
      if (!expiresAt || Date.parse(expiresAt) <= Date.parse(context.snapshotAt)) continue;
      const hotelId = uuid(draft.data["hotel_id"], "hotel_id");
      const hotel = context.hotelById.get(hotelId);
      if (!hotel) throw new Error(`hotels ${hotelId} source is missing`);
      const bounded = propertyHorizon(context.snapshotAt, hotel);
      const checkIn = date(draft.data["check_in"], "check_in");
      const checkOut = date(draft.data["check_out"], "check_out");
      if (checkOut <= bounded.from || checkIn > bounded.through) continue;
      addPmsBlocker(
        context,
        "ACTIVE_BOOKING_DRAFT",
        "pms.booking_drafts",
        safePmsSourceId(draft),
        "Active legacy inventory hold must expire or materialize before cutover extraction",
      );
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.booking_drafts",
        safePmsSourceId(draft),
        error instanceof Error ? error.message : "Invalid booking draft hold",
      );
    }
  }
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
      Date.parse(context.snapshotAt) - 30 * 60_000
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

function sellableAtSnapshot(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  hotel: IdentitySourceRow,
  stayDate: string,
): boolean {
  if (!bool(source.data["is_active"], "is_active", true)) return false;
  const clock = propertyClock(context.snapshotAt, hotel.data["timezone"]);
  if (sameDayClosed(hotel, stayDate, clock)) return false;
  const minimum = integer(source.data["minimum_advance_days"], "minimum_advance_days", 0);
  const daysAhead =
    (Date.parse(`${stayDate}T00:00:00Z`) - Date.parse(`${clock.today}T00:00:00Z`)) / 86_400_000;
  if (daysAhead < minimum) return false;
  if (!operatingOn(source, stayDate)) return false;
  if (bool(hotel.data["calendar_auto_open_enabled"], "calendar_auto_open_enabled", false)) {
    const openThrough = optionalDate(
      hotel.data["calendar_auto_open_through"],
      "calendar_auto_open_through",
    );
    if (openThrough && stayDate > openThrough) return false;
  }
  return resolvedRate(source, stayDate) > 0;
}

function propertyHorizon(
  snapshotAt: string,
  hotel: IdentitySourceRow,
): { from: string; through: string } {
  const from = propertyClock(snapshotAt, hotel.data["timezone"]).today;
  const through = new Date(`${from}T00:00:00Z`);
  through.setUTCDate(through.getUTCDate() + 365);
  return { from, through: through.toISOString().slice(0, 10) };
}

function propertyClock(
  snapshotAt: string,
  timezoneValue: unknown,
): { today: string; time: string } {
  const instant = new Date(iso(snapshotAt, "snapshotAt"));
  const configured = optionalText(timezoneValue, "timezone") ?? "UTC";
  const parts = clockParts(instant, configured) ?? clockParts(instant, "UTC")!;
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function clockParts(
  instant: Date,
  timeZone: string,
): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    return Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
    ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function sameDayClosed(
  hotel: IdentitySourceRow,
  stayDate: string,
  clock: { today: string; time: string },
): boolean {
  if (stayDate !== clock.today) return false;
  if (!bool(hotel.data["same_day_bookings_enabled"], "same_day_bookings_enabled", true))
    return true;
  const cutoff = optionalText(
    hotel.data["same_day_booking_cutoff_time"],
    "same_day_booking_cutoff_time",
  );
  if (!cutoff) return false;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cutoff))
    throw new Error("same_day_booking_cutoff_time must be HH:MM");
  return clock.time > `${cutoff}:00`;
}

function resolvedRate(source: IdentitySourceRow, stayDate: string): number {
  const daily = jsonMap(source.data["daily_rates"], "daily_rates");
  if (daily[stayDate] !== null && daily[stayDate] !== undefined)
    return numeric(daily[stayDate], `daily_rates.${stayDate}`);
  const seasons = jsonArray(source.data["seasons"], "seasons").map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`seasons[${index}] must be an object`);
    return value as Record<string, unknown>;
  });
  for (const season of seasons) {
    if (!season["rate"] || !seasonCovers(season, stayDate)) continue;
    const rate = Number(season["rate"]);
    if (Number.isFinite(rate)) return rate;
  }
  let baseRate = numeric(source.data["base_rate"], "base_rate");
  if (baseRate === 0 && seasons.length > 0) {
    const positive = seasons
      .map((season) => Number(season["rate"]))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (positive.length > 0) baseRate = Math.min(...positive);
  }
  return baseRate;
}

function seasonCovers(season: Record<string, unknown>, stayDate: string): boolean {
  const from = optionalText(season["from"], "season.from");
  const to = optionalText(season["to"], "season.to");
  if (!from || !to) return false;
  const year = stayDate.slice(0, 4);
  const startsOn = seasonDate(from, year);
  const endsOn = seasonDate(to, year);
  if (!startsOn || !endsOn) return false;
  return startsOn > endsOn
    ? stayDate >= startsOn || stayDate <= endsOn
    : stayDate >= startsOn && stayDate <= endsOn;
}

function seasonDate(value: string, year: string): string | null {
  const monthDay = value.length <= 5 ? value : value.slice(5, 10);
  if (!/^\d{2}-\d{2}$/.test(monthDay)) return null;
  const candidate = `${year}-${monthDay}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function numeric(value: unknown, field: string): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric`);
  return parsed;
}
