import { targetBooking } from "./productionPmsAssignmentRecords.js";
import {
  addPmsBlocker,
  ownerStatusForHotel,
  propertyForHotel,
  safePmsSourceId,
} from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type {
  PmsAssignmentBuild,
  PmsBuildContext,
  PmsRoomBuild,
  PmsTargetRecord,
} from "./productionPmsTypes.js";
import {
  bool,
  deterministicUuid,
  integer,
  iso,
  optionalIso,
  optionalText,
  optionalUuid,
  requiredText,
  uuid,
} from "./productionBookingValues.js";
import { percentage, pmsRecord } from "./productionPmsValues.js";

export function buildPmsChannelRecords(
  context: PmsBuildContext,
  rooms: PmsRoomBuild,
  assignments: PmsAssignmentBuild,
): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  for (const source of context.rowsByTable.get("channex_connections") ?? [])
    append(context, source, records, () => connection(context, source));
  for (const source of context.rowsByTable.get("channex_room_type_mappings") ?? [])
    append(context, source, records, () => roomMapping(context, source));
  for (const source of context.rowsByTable.get("channex_rate_plan_mappings") ?? [])
    append(context, source, records, () => rateMapping(context, source, rooms));
  for (const source of context.rowsByTable.get("channex_booking_mappings") ?? [])
    append(context, source, records, () => bookingMapping(context, source, assignments));
  return records;
}

function connection(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const hotelId = uuid(data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const externalPropertyId = optionalUuid(data["channex_property_id"], "channex_property_id");
  const active = bool(data["is_active"], "is_active", true);
  const ownerStatus = ownerStatusForHotel(context, hotelId);
  const ownerActive = ownerStatus === "active";
  const retainedActive = ownerActive && active && Boolean(externalPropertyId);
  const error = optionalText(data["last_ari_sync_error"], "last_ari_sync_error");
  const markups = channelMarkups(context, hotelId);
  const updatedAt = latestIso([
    iso(data["updated_at"], "updated_at"),
    ...markups.map((row) => iso(row.data["updated_at"], "markup.updated_at")),
  ]);
  const capabilities = ["booking", "ari"];
  if (bool(data["messaging_app_installed"], "messaging_app_installed", false))
    capabilities.push("message");
  const records: PmsTargetRecord[] = [];
  if (externalPropertyId && !retainedActive) {
    const claimCreatedAt = iso(data["created_at"], "created_at");
    records.push(
      pmsRecord(
        source,
        "channel_binding_claims",
        `${propertyId}:channex`,
        claimCreatedAt,
        false,
        {
          propertyId,
          provider: "channex",
          externalPropertyId,
          claimState: "historical",
          claimSource: "migration",
          createdAt: claimCreatedAt,
          updatedAt: claimCreatedAt,
        },
        { propertyId, provider: "channex", externalPropertyId, claimState: "historical" },
      ),
    );
  }
  records.push(
    pmsRecord(
      source,
      "channel_connections",
      id,
      updatedAt,
      true,
      {
        id,
        propertyId,
        provider: "channex",
        connectionStatus:
          !ownerActive || !active
            ? "disconnected"
            : !externalPropertyId
              ? "setup_incomplete"
              : error
                ? "degraded"
                : "connected",
        externalPropertyId: retainedActive ? externalPropertyId : null,
        capabilities: retainedActive ? capabilities : [],
        messagingAppInstalled: retainedActive && capabilities.includes("message"),
        lastBookingSyncAt: optionalIso(data["last_booking_sync_at"], "last_booking_sync_at"),
        lastAriSyncAt: optionalIso(data["last_ari_sync_at"], "last_ari_sync_at"),
        lastMessageSyncAt: optionalIso(data["last_message_sync_at"], "last_message_sync_at"),
        connectionMetadata: {
          migrationRunId: context.sourceRunId,
          ...(!retainedActive
            ? {
                legacyExternalPropertyId: externalPropertyId,
                ownerStatus,
                retainedClaimState: externalPropertyId ? "historical" : null,
                legacyCapabilities: capabilities,
              }
            : {}),
          legacyAriError: error,
          legacyAriFailedAt: optionalIso(
            data["last_ari_sync_failed_at"],
            "last_ari_sync_failed_at",
          ),
          channelMarkups: markups.map((row) => ({
            id: uuid(row.data["id"], "markup.id"),
            channel: requiredText(row.data["channel"], "markup.channel").toLowerCase(),
            markupPercent: percentage(row.data["markup_pct"], "markup_pct"),
            createdAt: iso(row.data["created_at"], "markup.created_at"),
            updatedAt: iso(row.data["updated_at"], "markup.updated_at"),
          })),
        },
        createdAt: iso(data["created_at"], "created_at"),
        updatedAt,
      },
      { connection: data, markups: markups.map((row) => row.data), ownerStatus },
    ),
  );
  records.push(...syncStatuses(context, source, id, propertyId));
  return records;
}

function syncStatuses(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  connectionId: string,
  propertyId: string,
): PmsTargetRecord[] {
  const data = source.data;
  const result: PmsTargetRecord[] = [];
  const add = (
    domain: "booking" | "ari" | "message",
    lastAttemptAt: string | null,
    lastSuccessAt: string | null,
    error: string | null,
  ) => {
    if (!lastAttemptAt && !lastSuccessAt && !error) return;
    const id = deterministicUuid("production-pms", "channel-sync", connectionId, domain);
    const updatedAt = lastAttemptAt ?? lastSuccessAt ?? iso(data["updated_at"], "updated_at");
    result.push(
      pmsRecord(source, "channel_sync_status", id, updatedAt, true, {
        id,
        propertyId,
        connectionId,
        syncDomain: domain,
        status: error ? "failed" : "ok",
        lastAttemptAt,
        lastSuccessAt,
        lastErrorCode: error ? "legacy_sync_error" : null,
        lastErrorMessage: error,
        retryAfter: null,
        syncPayload: { migrationRunId: context.sourceRunId, historicalReceipt: true },
        updatedAt,
      }),
    );
  };
  const bookingSync = optionalIso(data["last_booking_sync_at"], "last_booking_sync_at");
  add("booking", bookingSync, bookingSync, null);
  const ariSuccess = optionalIso(data["last_ari_sync_at"], "last_ari_sync_at");
  const ariError = optionalText(data["last_ari_sync_error"], "last_ari_sync_error");
  add(
    "ari",
    optionalIso(data["last_ari_sync_failed_at"], "last_ari_sync_failed_at") ?? ariSuccess,
    ariSuccess,
    ariError,
  );
  const messageSync = optionalIso(data["last_message_sync_at"], "last_message_sync_at");
  add("message", messageSync, messageSync, null);
  return result;
}

function roomMapping(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const hotelId = uuid(data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const connectionSource = requiredConnection(context, hotelId);
  const connectionId = uuid(connectionSource.data["id"], "connection.id");
  const roomTypeId = uuid(data["room_type_id"], "room_type_id");
  assertRoomType(context, roomTypeId, propertyId);
  const sourceActive = bool(data["is_active"], "mapping.is_active", true);
  const roomTypeActive = effectiveRoomTypeActive(context, roomTypeId);
  const updatedAt = iso(data["updated_at"], "updated_at");
  return [
    pmsRecord(
      source,
      "channel_room_type_mappings",
      id,
      updatedAt,
      true,
      {
        id,
        propertyId,
        connectionId,
        roomTypeId,
        externalRoomTypeId: uuid(data["channex_room_type_id"], "channex_room_type_id"),
        status:
          connectionIsActive(context, connectionSource) && sourceActive && roomTypeActive
            ? "active"
            : "disabled",
        mappingMetadata: { migrationRunId: context.sourceRunId, sourceActive, roomTypeActive },
        createdAt: iso(data["created_at"], "created_at"),
        updatedAt,
      },
      { mapping: data, ownerStatus: ownerStatusForHotel(context, hotelId) },
    ),
  ];
}

function rateMapping(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  rooms: PmsRoomBuild,
): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const hotelId = uuid(data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const connectionSource = requiredConnection(context, hotelId);
  const connectionId = uuid(connectionSource.data["id"], "connection.id");
  const roomTypeId = uuid(data["room_type_id"], "room_type_id");
  assertRoomType(context, roomTypeId, propertyId);
  const sourceActive = bool(data["is_active"], "mapping.is_active", true);
  const roomTypeActive = effectiveRoomTypeActive(context, roomTypeId);
  const ratePlanId = rooms.channelPlanByMapping.get(id);
  if (!ratePlanId) throw new Error("channel rate plan has not passed room/rate transformation");
  const externalRoomTypeId = uuid(data["channex_room_type_id"], "channex_room_type_id");
  const sourceRoomMapping = (context.rowsByTable.get("channex_room_type_mappings") ?? []).find(
    (row) => String(row.data["room_type_id"] ?? "").toLowerCase() === roomTypeId,
  );
  if (
    sourceRoomMapping &&
    uuid(sourceRoomMapping.data["channex_room_type_id"], "mapped channex_room_type_id") !==
      externalRoomTypeId
  )
    throw new Error("channel rate and room mappings disagree on external room type");
  const channel = requiredText(data["channel"] ?? "direct", "channel").toLowerCase();
  const sellMode = requiredText(data["sell_mode"] ?? "per_room", "sell_mode").toLowerCase();
  if (!["per_room", "per_person"].includes(sellMode))
    throw new Error(`channel sell mode ${sellMode} is unsupported`);
  const markups = channelMarkups(context, hotelId).filter(
    (row) => requiredText(row.data["channel"], "markup.channel").toLowerCase() === channel,
  );
  if (markups.length > 1) throw new Error(`channel ${channel} has duplicate markup rows`);
  const updatedAt = latestIso([
    iso(data["updated_at"], "updated_at"),
    ...markups.map((row) => iso(row.data["updated_at"], "markup.updated_at")),
  ]);
  return [
    pmsRecord(
      source,
      "channel_rate_plan_mappings",
      id,
      updatedAt,
      true,
      {
        id,
        propertyId,
        connectionId,
        roomTypeId,
        ratePlanId,
        channel,
        externalRoomTypeId,
        externalRatePlanId: uuid(data["channex_rate_plan_id"], "channex_rate_plan_id"),
        sellMode,
        markupPercent: percentage(markups[0]?.data["markup_pct"] ?? 0, "markup_pct"),
        status:
          connectionIsActive(context, connectionSource) && sourceActive && roomTypeActive
            ? "active"
            : "disabled",
        mappingMetadata: {
          migrationRunId: context.sourceRunId,
          sourceActive,
          roomTypeActive,
          planName: optionalText(data["plan_name"], "plan_name"),
          mealPlanCode: integer(data["meal_plan_code"], "meal_plan_code", 0),
          legacyMarkupId: markups[0]?.data["id"] ?? null,
        },
        createdAt: iso(data["created_at"], "created_at"),
        updatedAt,
      },
      {
        mapping: data,
        markup: markups[0]?.data ?? null,
        ownerStatus: ownerStatusForHotel(context, hotelId),
      },
    ),
  ];
}

function bookingMapping(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  assignments: PmsAssignmentBuild,
): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const hotelId = uuid(data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const connectionId = uuid(requiredConnection(context, hotelId).data["id"], "connection.id");
  const guestBookingId = uuid(data["booking_id"], "booking_id");
  const booking = targetBooking(context, guestBookingId);
  if (booking.propertyId !== propertyId)
    throw new Error("channel booking mapping crosses properties");
  const channelRoomIndex = integer(data["channex_room_index"], "channex_room_index", 0);
  if (channelRoomIndex < 0) throw new Error("channex_room_index must be non-negative");
  const assignmentId =
    assignments.assignmentByBookingPosition.get(`${guestBookingId}:${channelRoomIndex + 1}`) ??
    null;
  if (
    !assignmentId &&
    booking.target.lifecycleStatus !== "canceled" &&
    booking.target.checkOut > context.snapshotAt.slice(0, 10)
  )
    throw new Error("active channel booking slot has no exact operational booking assignment");
  const updatedAt = iso(data["updated_at"], "updated_at");
  return [
    pmsRecord(
      source,
      "channel_booking_mappings",
      id,
      updatedAt,
      true,
      {
        id,
        propertyId,
        connectionId,
        guestBookingId,
        assignmentId,
        externalBookingId: uuid(data["channex_booking_id"], "channex_booking_id"),
        externalRevisionId: optionalUuid(data["channex_revision_id"], "channex_revision_id"),
        channel: requiredText(data["channel_source"] ?? "channex", "channel_source").toLowerCase(),
        channelRoomIndex,
        syncStatus:
          assignmentId && connectionIsActive(context, requiredConnection(context, hotelId))
            ? "active"
            : "ignored",
        lastSyncedAt: optionalIso(data["last_synced_at"], "last_synced_at"),
        mappingMetadata: {
          migrationRunId: context.sourceRunId,
          historicalReceipt: true,
          ...(assignmentId ? {} : { migrationDisposition: "historical_unassigned_slot" }),
        },
        createdAt: iso(data["created_at"], "created_at"),
        updatedAt,
      },
      { mapping: data, ownerStatus: ownerStatusForHotel(context, hotelId) },
    ),
  ];
}

function connectionIsActive(context: PmsBuildContext, source: IdentitySourceRow): boolean {
  const hotelId = uuid(source.data["hotel_id"], "connection.hotel_id");
  return (
    ownerStatusForHotel(context, hotelId) === "active" &&
    bool(source.data["is_active"], "connection.is_active", true) &&
    Boolean(optionalUuid(source.data["channex_property_id"], "connection.channex_property_id"))
  );
}

function effectiveRoomTypeActive(context: PmsBuildContext, roomTypeId: string): boolean {
  const roomType = context.roomTypeById.get(roomTypeId);
  if (!roomType) return false;
  return (
    context.effectiveRoomTypeActiveById.get(roomTypeId) ??
    bool(roomType.data["is_active"], "room_type.is_active", true)
  );
}

function requiredConnection(context: PmsBuildContext, hotelId: string): IdentitySourceRow {
  const connection = context.connectionByHotel.get(hotelId);
  if (!connection) throw new Error(`hotel ${hotelId} has no legacy Channex connection`);
  return connection;
}

function assertRoomType(context: PmsBuildContext, id: string, propertyId: string): void {
  const roomType = context.roomTypeById.get(id);
  if (!roomType || propertyForHotel(context, roomType.data["hotel_id"]) !== propertyId)
    throw new Error("channel mapping references a missing or cross-property room type");
}

function channelMarkups(context: PmsBuildContext, hotelId: string): IdentitySourceRow[] {
  return (context.rowsByTable.get("channex_channel_markups") ?? [])
    .filter((row) => String(row.data["hotel_id"] ?? "").toLowerCase() === hotelId)
    .sort((left, right) =>
      String(left.data["channel"] ?? "").localeCompare(String(right.data["channel"] ?? "")),
    );
}

function latestIso(values: string[]): string {
  return [...values].sort().at(-1)!;
}

function append(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  target: PmsTargetRecord[],
  build: () => PmsTargetRecord[],
): void {
  try {
    target.push(...build());
  } catch (error) {
    addPmsBlocker(
      context,
      "INVALID_SOURCE_ROW",
      `pms.${source.sourceTable}`,
      safePmsSourceId(source),
      error instanceof Error ? error.message : "Invalid PMS channel source",
    );
  }
}
