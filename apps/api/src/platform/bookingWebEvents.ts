import crypto from "node:crypto";

import pg from "pg";

import type {
  BookingWebAffiliateClickEvent,
  BookingWebAttributionSink,
  BookingWebTelemetryEvent,
} from "../routes/bookingWebPublic.js";

type PgBookingWebEventSinkConfig = {
  connectionString: string;
  max?: number;
};

export function createPgBookingWebEventSink(
  config: PgBookingWebEventSinkConfig,
): BookingWebAttributionSink {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async recordAffiliateClick(event) {
      await insertDomainEventWithAudit(pool, {
        sourceSystem: "marketplace",
        eventKey: eventKey(
          "booking-web",
          "affiliate-click",
          event.slug,
          event.referralCode,
          event.sessionId ?? event.requestId,
        ),
        eventType: "marketplace.affiliate_click.recorded",
        occurredAt: event.occurredAt,
        resourceProduct: "marketplace",
        resourceType: "affiliate_referral",
        resourceId: `${event.slug}:${event.referralCode}`,
        correlationId: event.sessionId ?? event.requestId,
        idempotencyKeyHash: hashKey(
          event.slug,
          event.referralCode,
          event.sessionId ?? event.requestId,
        ),
        payload: {
          hotelSlug: event.slug,
          referralCode: event.referralCode,
          sessionId: event.sessionId ?? null,
          landingUrl: event.landingUrl ?? null,
          referrer: event.referrer ?? null,
          metadata: event.metadata,
        },
        eventMetadata: requestMetadata(event.requestId, event.userAgent, event.ipAddress),
        auditProduct: "marketplace",
        auditAction: "affiliate_click.recorded",
        auditTargetProduct: "marketplace",
        auditTargetType: "affiliate_referral",
        auditTargetId: `${event.slug}:${event.referralCode}`,
      });
    },
    async recordTelemetryEvent(event) {
      const normalizedType = event.eventType.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
      const occurrenceKey = event.eventId ?? event.requestId;
      await insertDomainEventWithAudit(pool, {
        propertyId: event.propertyId,
        sourceSystem: "distribution",
        eventKey: eventKey(
          "booking-web",
          "telemetry",
          event.propertyId,
          event.hotelSlug,
          normalizedType,
          occurrenceKey,
        ),
        eventType: `booking_web.${normalizedType}`,
        occurredAt: event.occurredAt,
        resourceProduct: "distribution",
        resourceType: "booking_web_hotel",
        resourceId: event.hotelSlug,
        correlationId: event.sessionId ?? event.requestId,
        idempotencyKeyHash: hashKey(
          event.propertyId,
          event.hotelSlug,
          normalizedType,
          occurrenceKey,
        ),
        payload: {
          hotelSlug: event.hotelSlug,
          eventType: normalizedType,
          eventId: event.eventId ?? null,
          sessionId: event.sessionId ?? null,
          metadata: event.metadata,
        },
        eventMetadata: requestMetadata(event.requestId, event.userAgent, event.ipAddress),
        auditProduct: "distribution",
        auditAction: "booking_web.telemetry.recorded",
        auditTargetProduct: "distribution",
        auditTargetType: "booking_web_hotel",
        auditTargetId: event.hotelSlug,
      });
    },
  };
}

type InsertEventInput = {
  propertyId?: string;
  sourceSystem: "marketplace" | "distribution";
  eventKey: string;
  eventType: string;
  occurredAt: Date;
  resourceProduct: "marketplace" | "distribution";
  resourceType: string;
  resourceId: string;
  correlationId: string;
  idempotencyKeyHash: string;
  payload: Record<string, unknown>;
  eventMetadata: Record<string, unknown>;
  auditProduct: "marketplace" | "distribution";
  auditAction: string;
  auditTargetProduct: "marketplace" | "distribution";
  auditTargetType: string;
  auditTargetId: string;
};

async function insertDomainEventWithAudit(pool: pg.Pool, input: InsertEventInput): Promise<void> {
  const tenantScope = input.propertyId ? "property" : "external";
  await pool.query(
    `WITH inserted_event AS (
       INSERT INTO platform.domain_events
         (
           source_system,
           event_key,
           event_type,
           occurred_at,
           tenant_scope,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           actor_type,
           correlation_id,
           idempotency_key_hash,
           payload,
           event_metadata,
           privacy_scope
         )
       VALUES
         ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, 'provider', $10, $11, $12, $13, 'internal')
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id
     ),
     selected_event AS (
       SELECT id FROM inserted_event
       UNION ALL
       SELECT id
       FROM platform.domain_events
       WHERE source_system = $1
         AND event_key = $2
       LIMIT 1
     )
     INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         property_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         domain_event_id,
         correlation_id,
         redacted_payload,
         private_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES
       (
         $14,
         $15,
         $16,
         $4,
         $5,
         $6::uuid,
         'provider',
         $17,
         $18,
         $19,
         (SELECT id FROM selected_event),
         $10,
         $12,
         '{}'::jsonb,
         $13,
         'standard',
         'internal'
       )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      input.sourceSystem,
      input.eventKey,
      input.eventType,
      input.occurredAt,
      tenantScope,
      input.propertyId ?? null,
      input.resourceProduct,
      input.resourceType,
      input.resourceId,
      input.correlationId,
      input.idempotencyKeyHash,
      JSON.stringify(input.payload),
      JSON.stringify(input.eventMetadata),
      input.eventKey,
      input.auditProduct,
      input.auditAction,
      input.auditTargetProduct,
      input.auditTargetType,
      input.auditTargetId,
    ],
  );
}

function eventKey(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

function hashKey(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

function requestMetadata(
  requestId: string,
  userAgent: string | undefined,
  ipAddress: string | undefined,
): Record<string, unknown> {
  return {
    requestId,
    source: "apps/api-booking-web-public",
    trafficClass: classifyBookingWebTraffic(userAgent),
    userAgentHash: userAgent ? hashKey(userAgent) : null,
    ipAddressHash: ipAddress ? hashKey(ipAddress) : null,
  };
}

export function classifyBookingWebTraffic(userAgent: string | undefined): "bot" | "human" {
  return userAgent &&
    /(bot(?:\b|\/)|crawler|spider|headlesschrome|lighthouse|pagespeed|pingdom|uptimerobot)/i.test(
      userAgent,
    )
    ? "bot"
    : "human";
}
