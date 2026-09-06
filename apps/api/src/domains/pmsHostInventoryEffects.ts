import type { PoolClient } from "pg";

export async function enqueueHostInventoryChanges(
  client: PoolClient,
  input: { propertyId: string; previewId: string; fingerprint: string; occurredAt: Date },
  spans: readonly { roomTypeId: string; checkIn: string; checkOut: string }[],
) {
  for (const span of spans) {
    const key = `pms.host-action:${input.previewId}:${span.roomTypeId}:${span.checkIn}:${span.checkOut}`;
    const payload = JSON.stringify({
      propertyId: input.propertyId,
      roomTypeId: span.roomTypeId,
      dateRange: {
        from: span.checkIn,
        to: new Date(Date.parse(span.checkOut) - 86_400_000).toISOString().slice(0, 10),
      },
      triggerRefId: input.previewId,
      inventoryVersion: input.fingerprint,
    });
    await client.query(
      `WITH event AS (
         INSERT INTO platform.domain_events
           (source_system,event_key,event_type,occurred_at,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,payload)
         VALUES ('pms',$1,'pms.inventory.changed',$2::timestamptz,'property',$3::uuid,'pms','room_type',$4,$5,$6::jsonb)
         ON CONFLICT (source_system,event_key) DO NOTHING RETURNING id
       ), persisted AS (
         SELECT id FROM event UNION ALL SELECT id FROM platform.domain_events WHERE source_system='pms' AND event_key=$1 LIMIT 1
       ) INSERT INTO platform.outbox_events
         (domain_event_id,outbox_key,destination,event_type,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,payload)
       SELECT persisted.id,$1 || ':' || output.destination,output.destination,output.event_type,'property',$3::uuid,'pms','room_type',$4,$5,$6::jsonb
       FROM persisted CROSS JOIN (VALUES
         ('pms.channel-manager','pms.inventory.ari_changed'),
         ('distribution.public-bookability','pms.inventory.changed'),
         ('pms.calendar-projection','pms.calendar.refresh_requested')
       ) output(destination,event_type) ON CONFLICT (destination,outbox_key) DO NOTHING`,
      [
        key,
        input.occurredAt.toISOString(),
        input.propertyId,
        span.roomTypeId,
        input.previewId,
        payload,
      ],
    );
  }
}
