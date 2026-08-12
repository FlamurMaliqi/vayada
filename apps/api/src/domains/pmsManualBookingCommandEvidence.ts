import { createHash } from "node:crypto";

import {
  PMS_MANUAL_BOOKING_CONTRACT_VERSION,
  PmsManualBookingCreateError,
  type PmsManualBookingCreateCommand,
  type PmsManualBookingCreateResult,
} from "@vayada/domain-pms";

import type { PmsManualBookingTransaction } from "./pmsManualBookingTransactionPorts.js";

type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprint: string;
  responseBodyHash: string | null;
  responseResourceId: string | null;
  metadata: unknown;
};

export type ManualBookingReservation = Readonly<{
  id: string;
  keyHash: string;
  requestFingerprint: string;
}>;

export function manualBookingRequestFingerprint(command: PmsManualBookingCreateCommand): string {
  return sha256(
    stableJson({
      contractVersion: command.contractVersion,
      commandId: command.commandId,
      propertyId: command.propertyId,
      organizationId: command.organizationId,
      guest: command.guest,
      privateNote: command.privateNote,
      directSource: command.directSource,
      stays: command.stays,
      addOns: command.addOns,
      payment: command.payment,
    }),
  );
}

export async function findManualBookingReplay(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
  keyHash = sha256(command.idempotencyKey),
  requestFingerprint = manualBookingRequestFingerprint(command),
): Promise<PmsManualBookingCreateResult | null> {
  const found = await transaction.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
       request_fingerprint_hash AS "requestFingerprint",
       response_body_hash AS "responseBodyHash",
       response_resource_id AS "responseResourceId", idempotency_metadata AS metadata
     FROM platform.idempotency_keys
     WHERE operation_scope = 'pms' AND operation = 'pms.manual_booking.create'
       AND key_hash = $1 AND tenant_scope = 'property'
       AND property_id = $2::uuid AND organization_id IS NULL
     FOR UPDATE`,
    [keyHash, command.propertyId],
  );
  const row = found.rows[0];
  if (!row) return null;
  if (row.requestFingerprint !== requestFingerprint || row.status !== "completed") {
    throw new PmsManualBookingCreateError("idempotency_conflict");
  }
  const result = record(row.metadata)?.["result"];
  if (!isStoredResult(result, command) || row.responseBodyHash !== sha256(stableJson(result))) {
    throw new Error("Stored manual booking replay is invalid");
  }
  const booking = await transaction.query(
    `SELECT 1 FROM booking.guest_bookings
     WHERE id = $1::uuid AND property_id = $2::uuid`,
    [result.guestBookingId, command.propertyId],
  );
  if (row.responseResourceId !== result.guestBookingId || booking.rowCount !== 1)
    throw new Error("Stored manual booking replay is invalid");
  return { ...result, outcome: "replayed" };
}

export async function reserveManualBookingCommand(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
): Promise<ManualBookingReservation | null> {
  const keyHash = sha256(command.idempotencyKey);
  const requestFingerprint = manualBookingRequestFingerprint(command);
  const inserted = await transaction.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash,
       tenant_scope, property_id, correlation_id, expires_at, idempotency_metadata
     ) VALUES (
       'pms', 'pms.manual_booking.create', $1, $2, 'property', $3::uuid,
       $4, 'infinity'::timestamptz,
       jsonb_build_object('contractVersion', $5::text, 'commandId', $6::text)
     ) ON CONFLICT DO NOTHING RETURNING id::text AS id`,
    [
      keyHash,
      requestFingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.contractVersion,
      command.commandId,
    ],
  );
  return inserted.rows[0] ? { id: inserted.rows[0].id, keyHash, requestFingerprint } : null;
}

export async function assertManualBookingCommandIdUnused(
  transaction: PmsManualBookingTransaction,
  commandId: string,
): Promise<void> {
  const found = await transaction.query(
    `SELECT id FROM booking.guest_bookings
     WHERE source_system = 'pms' AND source_booking_id = $1 FOR UPDATE`,
    [commandId],
  );
  if (found.rowCount) throw new PmsManualBookingCreateError("idempotency_conflict");
}

export async function completeManualBookingCommand(
  transaction: PmsManualBookingTransaction,
  reservation: ManualBookingReservation,
  result: PmsManualBookingCreateResult,
  completedAt: string,
): Promise<void> {
  const bodyHash = sha256(stableJson(result));
  const updated = await transaction.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = 201, response_body_hash = $2,
       response_resource_product = 'booking', response_resource_type = 'guest_booking',
       response_resource_id = $3, completed_at = $4::timestamptz,
       last_seen_at = $4::timestamptz,
       idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [reservation.id, bodyHash, result.guestBookingId, completedAt, JSON.stringify(result)],
  );
  if (updated.rowCount !== 1) throw new Error("Manual booking command reservation was lost");
}

export async function writeManualBookingPlatformEvidence(
  transaction: PmsManualBookingTransaction,
  input: {
    command: PmsManualBookingCreateCommand;
    result: PmsManualBookingCreateResult;
    reservation: ManualBookingReservation;
  },
): Promise<void> {
  const { command, result, reservation } = input;
  const event = await transaction.query<{ id: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, occurred_at, tenant_scope, property_id,
       resource_product, resource_type, resource_id, actor_type, actor_user_id,
       correlation_id, idempotency_key_hash, payload, privacy_scope
     ) VALUES (
       'pms', $1, 'pms.manual_booking.created.v1', $2::timestamptz, 'property', $3::uuid,
       'booking', 'guest_booking', $4, 'user', $5::uuid, $6, $7,
       $8::jsonb, 'confidential'
     ) RETURNING id::text AS id`,
    [
      `pms.manual-booking.${result.guestBookingId}.created.v1`,
      command.audit.requestedAt,
      command.propertyId,
      result.guestBookingId,
      command.audit.actor.userId,
      command.audit.correlationId ?? command.audit.requestId,
      reservation.keyHash,
      JSON.stringify({
        contractVersion: command.contractVersion,
        guestBookingId: result.guestBookingId,
        bookingReference: result.bookingReference,
        stayCount: result.stayCount,
        paymentStatus: result.paymentStatus,
      }),
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("Manual booking event was not created");
  await insertOutbox(transaction, command, result, reservation.keyHash, eventId);
  await insertAudit(transaction, command, result, reservation.id, eventId);
}

async function insertOutbox(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
  result: PmsManualBookingCreateResult,
  keyHash: string,
  eventId: string,
): Promise<void> {
  const intents = [
    ["pms.calendar", "pms.calendar.refresh.requested.v1"],
    ["pms.ari", "pms.ari.changed.v1"],
    ["booking.guest-communication", "booking.guest_confirmation.requested.v1"],
    ["pms.read-model", "pms.manual_booking.refresh.requested.v1"],
  ].map(([destination, eventType]) => ({ destination, eventType }));
  await transaction.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope, property_id,
       resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, payload, outbox_metadata
     ) SELECT $1::uuid, 'pms.manual-booking.' || $2 || '.' || item.destination || '.v1',
       item.destination, item."eventType", 'property', $3::uuid, 'booking',
       'guest_booking', $2, $4, $5, $6::jsonb, '{}'::jsonb
     FROM jsonb_to_recordset($7::jsonb) AS item(destination text, "eventType" text)`,
    [
      eventId,
      result.guestBookingId,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify({ guestBookingId: result.guestBookingId }),
      JSON.stringify(intents),
    ],
  );
}

async function insertAudit(
  transaction: PmsManualBookingTransaction,
  command: PmsManualBookingCreateCommand,
  result: PmsManualBookingCreateResult,
  idempotencyId: string,
  eventId: string,
): Promise<void> {
  await transaction.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, domain_event_id, idempotency_key_id, correlation_id,
       redacted_payload, private_payload, privacy_scope, retention_class
     ) VALUES (
       $1, 'pms', 'pms.manual_booking.create', $2::timestamptz, 'property', $3::uuid,
       'user', $4::uuid, 'booking', 'guest_booking', $5, $6::uuid, $7::uuid, $8,
       $9::jsonb, '{}'::jsonb, 'confidential', 'guest_pii'
     )`,
    [
      `pms.manual-booking.${result.guestBookingId}.create.v1`,
      command.audit.requestedAt,
      command.propertyId,
      command.audit.actor.userId,
      result.guestBookingId,
      eventId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      JSON.stringify({ contractVersion: command.contractVersion, stayCount: result.stayCount }),
    ],
  );
}

function isStoredResult(
  value: unknown,
  command: PmsManualBookingCreateCommand,
): value is PmsManualBookingCreateResult {
  const input = record(value);
  const total = record(input?.["total"]);
  const balance = record(input?.["balance"]);
  const paid = command.payment.settlement.status === "paid";
  const checkIn = command.stays.reduce(
    (earliest, stay) => (stay.checkIn < earliest ? stay.checkIn : earliest),
    command.stays[0]!.checkIn,
  );
  const checkOut = command.stays.reduce(
    (latest, stay) => (stay.checkOut > latest ? stay.checkOut : latest),
    command.stays[0]!.checkOut,
  );
  return (
    exact(input, [
      "contractVersion",
      "outcome",
      "commandId",
      "idempotencyKey",
      "guestBookingId",
      "bookingReference",
      "bookingChannel",
      "directSource",
      "stayCount",
      "checkIn",
      "checkOut",
      "total",
      "balance",
      "paymentStatus",
      "paymentEvidenceId",
      "sideEffects",
    ]) &&
    input?.["contractVersion"] === PMS_MANUAL_BOOKING_CONTRACT_VERSION &&
    input["outcome"] === "created" &&
    input["commandId"] === command.commandId &&
    input["idempotencyKey"] === command.idempotencyKey &&
    uuid(input["guestBookingId"]) &&
    typeof input["bookingReference"] === "string" &&
    input["bookingChannel"] === "direct" &&
    input["directSource"] === command.directSource &&
    input["stayCount"] === command.stays.length &&
    input["checkIn"] === checkIn &&
    input["checkOut"] === checkOut &&
    money(total) &&
    money(balance) &&
    total["currency"] === balance["currency"] &&
    input["paymentStatus"] === (paid ? "paid" : "unpaid") &&
    (paid ? uuid(input["paymentEvidenceId"]) : input["paymentEvidenceId"] === null) &&
    (paid
      ? balance["amountDecimal"] === "0.00"
      : balance["amountDecimal"] === total["amountDecimal"]) &&
    JSON.stringify(input["sideEffects"]) ===
      '["calendar_refresh","ari_changed","guest_confirmation","audit_event"]'
  );
}

function exact(
  value: Record<string, unknown> | null,
  keys: string[],
): value is Record<string, unknown> {
  return !!value && Object.keys(value).sort().join() === [...keys].sort().join();
}

function money(value: Record<string, unknown> | null): value is Record<string, string> {
  return (
    exact(value, ["amountDecimal", "currency"]) &&
    typeof value["amountDecimal"] === "string" &&
    /^\d+\.\d{2}$/.test(value["amountDecimal"]) &&
    typeof value["currency"] === "string" &&
    /^[A-Z]{3}$/.test(value["currency"])
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = record(value);
  if (object)
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
