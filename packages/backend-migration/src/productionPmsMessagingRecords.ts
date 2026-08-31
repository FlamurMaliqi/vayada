import { targetBooking } from "./productionPmsAssignmentRecords.js";
import {
  addPmsBlocker,
  pmsMediaForSource,
  propertyForHotel,
  safePmsSourceId,
} from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import {
  integer,
  iso,
  optionalIso,
  optionalText,
  optionalUuid,
  requiredText,
  uuid,
} from "./productionBookingValues.js";
import { jsonMap, pmsRecord } from "./productionPmsValues.js";

export function buildPmsMessagingRecords(context: PmsBuildContext): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  for (const source of context.rowsByTable.get("message_threads") ?? [])
    append(context, source, records, () => thread(context, source));
  for (const source of context.rowsByTable.get("messages") ?? [])
    append(context, source, records, () => message(context, source));
  for (const source of context.rowsByTable.get("message_attachments") ?? [])
    append(context, source, records, () => attachment(context, source));
  return records;
}

function thread(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyForHotel(context, data["hotel_id"]);
  const sourceName = requiredText(data["source"], "source").toLowerCase();
  if (sourceName !== "channex") throw new Error(`message source ${sourceName} is unsupported`);
  const status = requiredText(data["status"] ?? "open", "status").toLowerCase();
  if (!["open", "closed", "no_reply_needed"].includes(status))
    throw new Error(`message thread status ${status} is unsupported`);
  const bookingId = optionalUuid(data["booking_id"], "booking_id");
  if (bookingId && targetBooking(context, bookingId).propertyId !== propertyId)
    throw new Error("message thread crosses booking property scope");
  const lastDirection = optionalText(data["last_message_direction"], "last_message_direction");
  if (lastDirection && !["inbound", "outbound"].includes(lastDirection))
    throw new Error(`last message direction ${lastDirection} is unsupported`);
  const createdAt = iso(data["created_at"], "created_at");
  const updatedAt = iso(data["updated_at"], "updated_at");
  return [
    pmsRecord(source, "message_threads", id, updatedAt, true, {
      id,
      propertyId,
      guestBookingId: bookingId,
      source: "channex",
      sourceThreadId: requiredText(data["source_thread_id"], "source_thread_id"),
      sourceBookingId: optionalText(data["source_booking_id"], "source_booking_id"),
      channel: optionalText(data["channel"], "channel"),
      guestDisplayName: optionalText(data["guest_name"], "guest_name"),
      guestEmail: optionalText(data["guest_email"], "guest_email")?.toLowerCase() ?? null,
      status,
      lastMessageAt: optionalIso(data["last_message_at"], "last_message_at"),
      lastMessagePreview: optionalText(data["last_message_preview"], "last_message_preview"),
      lastMessageDirection: lastDirection,
      unreadCount: nonNegativeInteger(data["unread_count"], "unread_count", 0),
      createdAt,
      updatedAt,
    }),
  ];
}

function message(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const threadId = uuid(data["thread_id"], "thread_id");
  const parent = find(context, "message_threads", threadId);
  const propertyId = propertyForHotel(context, parent.data["hotel_id"]);
  const direction = requiredText(data["direction"], "direction").toLowerCase();
  if (!["inbound", "outbound"].includes(direction))
    throw new Error(`message direction ${direction} is unsupported`);
  const sentAt = iso(data["sent_at"], "sent_at");
  const receivedAt = iso(data["received_at"], "received_at");
  const readAt = optionalIso(data["read_at"], "read_at");
  return [
    pmsRecord(source, "messages", id, readAt ?? receivedAt, true, {
      id,
      propertyId,
      threadId,
      sourceMessageId: requiredText(data["source_message_id"], "source_message_id"),
      direction,
      senderType: direction === "inbound" ? "guest" : "property_user",
      senderUserId: null,
      senderDisplayName: optionalText(data["sender_name"], "sender_name"),
      body: typeof data["body"] === "string" ? data["body"] : "",
      sentAt,
      receivedAt,
      readAt,
      rawPayload: jsonMap(data["raw_payload"], "raw_payload"),
      piiRetentionUntil: retentionDate(context, parent, receivedAt),
    }),
  ];
}

function attachment(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const messageId = uuid(data["message_id"], "message_id");
  const message = find(context, "messages", messageId);
  const thread = find(context, "message_threads", uuid(message.data["thread_id"], "thread_id"));
  const propertyId = propertyForHotel(context, thread.data["hotel_id"]);
  const legacyS3Key = optionalText(data["s3_key"], "s3_key");
  const legacySourceUrl = optionalText(data["source_url"], "source_url");
  if (!legacyS3Key && !legacySourceUrl)
    throw new Error("message attachment has no source reference for the VAY-1055 gate");
  const sourceField = legacyS3Key ? "s3_key" : "source_url";
  const media = pmsMediaForSource(context, {
    sourceTable: "message_attachments",
    sourceRowId: `${id}:${sourceField}`,
    purpose: "pms.messaging.attachment",
    propertyId,
    visibility: "private",
  });
  const createdAt = iso(data["created_at"], "created_at");
  return [
    pmsRecord(source, "message_attachments", id, createdAt, false, {
      id,
      propertyId,
      messageId,
      platformMediaObjectId: media.mediaObjectId,
      s3Key: media.storageKey,
      sourceUrl: null,
      filename: optionalText(data["filename"], "filename"),
      contentType: optionalText(data["content_type"], "content_type"),
      sizeBytes: nullableNonNegativeInteger(data["size_bytes"], "size_bytes"),
      sourceAttachmentId: optionalText(data["source_attachment_id"], "source_attachment_id"),
      createdAt,
    }),
  ];
}

function find(context: PmsBuildContext, table: string, id: string): IdentitySourceRow {
  const result = (context.rowsByTable.get(table) ?? []).find(
    (row) => String(row.data["id"] ?? "").toLowerCase() === id,
  );
  if (!result) throw new Error(`${table} ${id} is missing`);
  return result;
}

function retentionDate(
  context: PmsBuildContext,
  thread: IdentitySourceRow,
  receivedAt: string,
): string {
  const bookingId = optionalUuid(thread.data["booking_id"], "booking_id");
  const base = bookingId
    ? `${targetBooking(context, bookingId).target.checkOut}T00:00:00Z`
    : receivedAt;
  const value = new Date(base);
  value.setUTCFullYear(value.getUTCFullYear() + 1);
  return value.toISOString().slice(0, 10);
}

function nonNegativeInteger(value: unknown, field: string, fallback: number): number {
  const parsed = integer(value, field, fallback);
  if (parsed < 0) throw new Error(`${field} must be non-negative`);
  return parsed;
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined || value === ""
    ? null
    : nonNegativeInteger(value, field, 0);
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
      error instanceof Error ? error.message : "Invalid PMS message source",
    );
  }
}
