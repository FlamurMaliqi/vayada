import { targetBooking } from "./productionPmsAssignmentRecords.js";
import { addPmsBlocker, propertyForHotel, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import {
  deterministicUuid,
  iso,
  optionalText,
  redactPrivate,
  requiredText,
  sha256,
  uuid,
} from "./productionBookingValues.js";
import { jsonMap, optionalActor, percentage, pmsRecord } from "./productionPmsValues.js";

export function buildPmsAuditRecords(context: PmsBuildContext): PmsTargetRecord[] {
  const records: PmsTargetRecord[] = [];
  for (const source of context.rowsByTable.get("booking_events") ?? [])
    append(context, source, records, () => bookingEvent(context, source));
  for (const source of context.rowsByTable.get("booking_notification_deliveries") ?? [])
    append(context, source, records, () => notificationDelivery(context, source));
  for (const source of context.rowsByTable.get("channex_channel_markups") ?? [])
    append(context, source, records, () => channelMarkup(context, source));
  for (const source of context.rowsByTable.get("channex_webhook_events") ?? [])
    append(context, source, records, () => webhookEvent(context, source));
  return records;
}

function bookingEvent(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const bookingId = uuid(data["booking_id"], "booking_id");
  const target = targetBooking(context, bookingId);
  if (propertyForHotel(context, data["hotel_id"]) !== target.propertyId)
    throw new Error("booking event crosses booking property scope");
  const actorUserId = optionalActor(data["actor_user_id"], "actor_user_id", context.userIds);
  const eventType = requiredText(data["event_type"], "event_type");
  const payload = jsonMap(data["payload"], "payload");
  const occurredAt = iso(data["created_at"], "created_at");
  return [
    auditRecord(context, source, id, occurredAt, {
      auditKey: `legacy-pms-booking-event:${id}`,
      action: `pms.legacy_booking.${actionSegment(eventType)}`,
      propertyId: target.propertyId,
      actorType: actorUserId ? "user" : "migration",
      actorUserId,
      targetResourceType: "guest_booking",
      targetResourceId: bookingId,
      correlationId: bookingId,
      redactedPayload: redactPrivate(payload),
      privatePayload: payload,
      auditMetadata: {
        migrationRunId: context.sourceRunId,
        sourceTable: "booking_events",
        legacyEventType: eventType,
      },
      retentionClass: "guest_pii",
    }),
  ];
}

function notificationDelivery(
  context: PmsBuildContext,
  source: IdentitySourceRow,
): PmsTargetRecord[] {
  const data = source.data;
  const bookingId = uuid(data["booking_id"], "booking_id");
  const target = targetBooking(context, bookingId);
  const notificationType = requiredText(data["notification_type"], "notification_type");
  const recipientEmail = requiredText(data["recipient_email"], "recipient_email").toLowerCase();
  const occurredAt = iso(data["delivered_at"], "delivered_at");
  const id = deterministicUuid(
    "production-pms",
    "notification-delivery",
    bookingId,
    notificationType,
    recipientEmail,
  );
  return [
    auditRecord(context, source, id, occurredAt, {
      auditKey: `legacy-pms-notification-delivery:${id}`,
      action: "pms.legacy_notification.delivered",
      propertyId: target.propertyId,
      actorType: "migration",
      actorUserId: null,
      targetResourceType: "guest_booking",
      targetResourceId: bookingId,
      correlationId: bookingId,
      redactedPayload: { notificationType },
      privatePayload: { notificationType, recipientEmail },
      auditMetadata: {
        migrationRunId: context.sourceRunId,
        sourceTable: "booking_notification_deliveries",
        historicalReceipt: true,
        replayProhibited: true,
      },
      retentionClass: "guest_pii",
    }),
  ];
}

function channelMarkup(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const sourceId = uuid(data["id"], "id");
  const hotelId = uuid(data["hotel_id"], "hotel_id");
  const propertyId = propertyForHotel(context, hotelId);
  const connection = context.connectionByHotel.get(hotelId);
  if (!connection) throw new Error("channel markup has no legacy Channex connection");
  const connectionId = uuid(connection.data["id"], "connection.id");
  const channel = requiredText(data["channel"], "channel").toLowerCase();
  const markupPercent = percentage(data["markup_pct"], "markup_pct");
  const occurredAt = iso(data["updated_at"], "updated_at");
  const id = deterministicUuid("production-pms", "channel-markup-audit", sourceId);
  return [
    auditRecord(context, source, id, occurredAt, {
      auditKey: `legacy-pms-channel-markup:${sourceId}`,
      action: "pms.legacy_channel_markup.migrated",
      propertyId,
      actorType: "migration",
      actorUserId: null,
      targetResourceType: "channel_connection",
      targetResourceId: connectionId,
      correlationId: connectionId,
      redactedPayload: { channel, markupPercent },
      privatePayload: { channel, markupPercent },
      auditMetadata: {
        migrationRunId: context.sourceRunId,
        sourceTable: "channex_channel_markups",
      },
      retentionClass: "provider_receipt",
    }),
  ];
}

function webhookEvent(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const externalPropertyId = optionalText(data["property_id"], "property_id")?.toLowerCase() ?? null;
  const connections = externalPropertyId
    ? (context.rowsByTable.get("channex_connections") ?? []).filter(
        (row) => String(row.data["channex_property_id"] ?? "").toLowerCase() === externalPropertyId,
      )
    : [];
  if (connections.length > 1)
    throw new Error(`external Channex property ${externalPropertyId} has duplicate connections`);
  if (externalPropertyId && connections.length === 0)
    throw new Error(`external Channex property ${externalPropertyId} has no target ownership`);
  const propertyId = connections[0]
    ? propertyForHotel(context, connections[0].data["hotel_id"])
    : null;
  const processedOk = optionalBoolean(data["processed_ok"], "processed_ok");
  const error = optionalText(data["error"], "error");
  if (processedOk === true && error)
    throw new Error("webhook is marked processed_ok but also contains an error");
  const rawPayload = jsonMap(data["payload"], "payload");
  const receivedAt = iso(data["received_at"], "received_at");
  return [
    pmsRecord(
      source,
      "external_webhook_events",
      id,
      receivedAt,
      false,
      {
        id,
        provider: "channex",
        providerEventId: null,
        webhookKeyHash: sha256({ source: "pms.channex_webhook_events", id }),
        eventType: requiredText(data["event_type"], "event_type"),
        deliveryStatus: processedOk === false ? "failed" : "observed",
        signatureVerified: false,
        receivedAt,
        processedAt: null,
        tenantScope: propertyId ? "property" : "migration",
        organizationId: null,
        propertyId,
        normalizedDomainEventId: null,
        correlationId: `legacy-pms-webhook:${id}`,
        payloadHash: sha256(rawPayload),
        rawHeaders: {},
        rawPayload,
        failureReason:
          processedOk === false ? error ?? "Legacy processor recorded failure" : null,
        privacyScope: "restricted",
        aiVisible: false,
      },
      data,
      "platform",
    ),
  ];
}

function auditRecord(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  id: string,
  occurredAt: string,
  value: {
    auditKey: string;
    action: string;
    propertyId: string;
    actorType: "user" | "migration";
    actorUserId: string | null;
    targetResourceType: string;
    targetResourceId: string;
    correlationId: string;
    redactedPayload: unknown;
    privatePayload: unknown;
    auditMetadata: Record<string, unknown>;
    retentionClass: "guest_pii" | "provider_receipt";
  },
): PmsTargetRecord {
  return pmsRecord(
    source,
    "product_audit_events",
    id,
    occurredAt,
    false,
    {
      id,
      auditKey: value.auditKey,
      product: "pms",
      action: value.action,
      actionVersion: 1,
      occurredAt,
      recordedAt: context.completedAt,
      tenantScope: "property",
      organizationId: null,
      propertyId: value.propertyId,
      actorType: value.actorType,
      actorUserId: value.actorUserId,
      targetResourceProduct: "pms",
      targetResourceType: value.targetResourceType,
      targetResourceId: value.targetResourceId,
      secondaryResourceProduct: null,
      secondaryResourceType: null,
      secondaryResourceId: null,
      domainEventId: null,
      externalWebhookEventId: null,
      jobId: null,
      idempotencyKeyId: null,
      correlationId: value.correlationId,
      causationId: null,
      redactedPayload: value.redactedPayload,
      privatePayload: value.privatePayload,
      auditMetadata: value.auditMetadata,
      retentionClass: value.retentionClass,
      privacyScope: "restricted",
      aiVisible: false,
    },
    source.data,
    "platform",
  );
}

function actionSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error("event_type has no stable action segment");
  return normalized;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean or null`);
  return value;
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
      safePmsSourceId(source, source.sourceTable === "booking_notification_deliveries" ? "booking_id" : "id"),
      error instanceof Error ? error.message : "Invalid PMS audit source",
    );
  }
}
