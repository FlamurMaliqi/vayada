import type { QueryResult, QueryResultRow } from "pg";

import type { PmsLinkedInventoryChange } from "./pmsLinkedInventoryReconciler.js";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type Context = {
  propertyId: string;
  operation: string;
  commandId: string;
  keyHash: string;
  acceptedAt: string;
  audit: { requestId: string; correlationId?: string | null };
};

type ChangeRange = { roomTypeId: string; from: string; to: string };

export async function enqueuePmsLinkedInventorySideEffects(
  client: Client,
  context: Context,
  changes: readonly PmsLinkedInventoryChange[],
): Promise<void> {
  for (const range of collapseChanges(changes)) {
    const payload = JSON.stringify({
      propertyId: context.propertyId,
      roomTypeId: range.roomTypeId,
      dateRange: { from: range.from, to: range.to },
      inventoryVersion: context.keyHash,
      triggerRefId: context.commandId,
    });
    const eventKey = `pms.linked_inventory.changed.property.${context.propertyId}.room_type.${range.roomTypeId}.${range.from}.${range.to}.operation.${context.operation}.command.${context.commandId}.key.${context.keyHash}.v1`;
    const event = await client.query<{ eventId: string }>(
      `WITH inserted AS (
         INSERT INTO platform.domain_events (
           source_system, event_key, event_type, event_version, occurred_at,
           tenant_scope, property_id, resource_product, resource_type, resource_id,
           correlation_id, causation_id, idempotency_key_hash, payload, event_metadata
         ) VALUES (
           'pms', $1, 'pms.inventory.changed', 1, $2::timestamptz,
           'property', $3::uuid, 'pms', 'linked_inventory', $4::uuid,
           $5, $6, $7, $8::jsonb, $9::jsonb
         ) ON CONFLICT (source_system, event_key) DO NOTHING
         RETURNING id::text AS "eventId"
       )
       SELECT "eventId" FROM inserted
       UNION ALL
       SELECT id::text FROM platform.domain_events
       WHERE source_system='pms' AND event_key=$1
       LIMIT 1`,
      [
        eventKey,
        context.acceptedAt,
        context.propertyId,
        range.roomTypeId,
        context.audit.correlationId ?? context.audit.requestId,
        context.commandId,
        context.keyHash,
        payload,
        JSON.stringify({ contractVersion: "pms-linked-inventory.v1" }),
      ],
    );
    const eventId = event.rows[0]?.eventId;
    if (!eventId) throw new Error("Linked inventory domain event could not be persisted");
    await client.query(
      `INSERT INTO platform.outbox_events (
         domain_event_id, outbox_key, destination, event_type, tenant_scope,
         property_id, resource_product, resource_type, resource_id, correlation_id,
         idempotency_key_hash, payload, outbox_metadata
       )
       SELECT $1::uuid, output.outbox_key, output.destination, output.event_type,
              'property', $2::uuid, 'pms', 'linked_inventory', $3::uuid, $4, $5,
              $6::jsonb, $7::jsonb
       FROM (VALUES
         ($8::text, 'pms.channel-manager'::text, 'pms.inventory.ari_changed'::text),
         ($9::text, 'distribution.public-bookability'::text, 'pms.inventory.changed'::text),
         ($10::text, 'pms.calendar-projection'::text, 'pms.calendar.refresh_requested'::text)
       ) AS output(outbox_key, destination, event_type)
       ON CONFLICT (destination, outbox_key) DO NOTHING`,
      [
        eventId,
        context.propertyId,
        range.roomTypeId,
        context.audit.correlationId ?? context.audit.requestId,
        context.keyHash,
        payload,
        JSON.stringify({ contractVersion: "pms-linked-inventory.v1" }),
        `${eventKey}.ari`,
        `${eventKey}.distribution`,
        `${eventKey}.calendar`,
      ],
    );
  }
}

function collapseChanges(changes: readonly PmsLinkedInventoryChange[]): ChangeRange[] {
  const sorted = [
    ...new Map(
      changes.map((change) => [`${change.roomTypeId}:${change.stayDate}`, change]),
    ).values(),
  ].sort(
    (left, right) =>
      left.roomTypeId.localeCompare(right.roomTypeId) ||
      left.stayDate.localeCompare(right.stayDate),
  );
  const ranges: ChangeRange[] = [];
  for (const change of sorted) {
    const previous = ranges.at(-1);
    if (previous?.roomTypeId === change.roomTypeId && nextDate(previous.to) === change.stayDate) {
      previous.to = change.stayDate;
    } else {
      ranges.push({ roomTypeId: change.roomTypeId, from: change.stayDate, to: change.stayDate });
    }
  }
  return ranges;
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
