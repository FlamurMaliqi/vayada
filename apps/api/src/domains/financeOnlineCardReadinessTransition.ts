import {
  FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
  FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION,
} from "@vayada/domain-finance";
import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";

import { PROJECT_PUBLIC_BOOKABILITY_PROFILE } from "../platform/publicBookabilityPublication.js";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export type FinanceOnlineCardReadinessState = {
  providerAccountId: string;
  providerCapabilityRevision: number;
  ready: boolean;
};

export type FinanceOnlineCardReadinessChangeContext = {
  occurredAt: string;
  actorType: "user" | "system" | "provider" | "migration";
  actorUserId: string | null;
  correlationId: string;
  causationId: string;
};

export async function lockFinanceOnlineCardReadinessProperty(
  client: Client,
  propertyId: string,
): Promise<void> {
  await client.query(`SELECT id FROM hotel_catalog.properties WHERE id = $1::uuid FOR UPDATE`, [
    propertyId,
  ]);
}

export async function loadFinanceOnlineCardReadinessState(
  client: Client,
  propertyId: string,
): Promise<FinanceOnlineCardReadinessState | null> {
  const result = await client.query<FinanceOnlineCardReadinessState>(
    `SELECT provider_account_id::text AS "providerAccountId",
            card_capability_revision::int AS "providerCapabilityRevision",
            online_card_ready AS ready
     FROM finance.online_card_readiness
     WHERE property_id = $1::uuid
       AND provider_account_id IS NOT NULL`,
    [propertyId],
  );
  return result.rows[0] ?? null;
}

export async function applyFinanceOnlineCardReadinessLoss(
  client: Client,
  input: {
    propertyId: string;
    previous: FinanceOnlineCardReadinessState | null;
    context: FinanceOnlineCardReadinessChangeContext;
  },
): Promise<boolean> {
  const current = await loadFinanceOnlineCardReadinessState(client, input.propertyId);
  if (current?.ready) return false;

  // Projection repair is required even when the source was already unready.
  // Only the source transition itself should emit a new loss event.
  if (!input.previous?.ready) {
    await suppressPublishedCard(client, input.propertyId);
    return false;
  }

  const causeHash = createHash("sha256").update(input.context.causationId).digest("hex");
  const eventKey = `finance.online-card-readiness.property.${input.propertyId}.account.${input.previous.providerAccountId}.cause.${causeHash}.readiness_lost.v1`;
  const payload = {
    contractVersion: FINANCE_ONLINE_CARD_EXECUTION_EVIDENCE_CONTRACT_VERSION,
    eventType: "finance.online_card_readiness.changed",
    propertyId: input.propertyId,
    providerCapabilityRevision: input.previous.providerCapabilityRevision,
    outcome: "readiness_lost",
    sourceReadRequired: true,
  };
  const event = await client.query<{ eventId: string }>(
    `INSERT INTO platform.domain_events (
       source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, property_id, resource_product, resource_type, resource_id,
       actor_type, actor_user_id, correlation_id, causation_id, payload,
       event_metadata, privacy_scope
     ) VALUES (
       'finance', $1, 'finance.online_card_readiness.changed', 1, $2::timestamptz,
       'property', $3::uuid, 'finance', 'payment_provider_account', $4,
       $5, $6::uuid, $7, $8, $9::jsonb,
       '{"sourceReadRequired":true}'::jsonb, 'confidential'
     )
     RETURNING id::text AS "eventId"`,
    [
      eventKey,
      input.context.occurredAt,
      input.propertyId,
      input.previous.providerAccountId,
      input.context.actorType,
      input.context.actorUserId,
      input.context.correlationId,
      input.context.causationId,
      JSON.stringify(payload),
    ],
  );
  const eventId = event.rows[0]?.eventId;
  if (!eventId) throw new Error("Online-card readiness loss event insert failed");
  await client.query(
    `INSERT INTO platform.outbox_events (
       domain_event_id, outbox_key, destination, event_type, tenant_scope,
       property_id, resource_product, resource_type, resource_id,
       correlation_id, payload, outbox_metadata
     ) VALUES (
       $1::uuid, $2, $3, 'finance.online_card_readiness.changed', 'property',
       $4::uuid, 'finance', 'payment_provider_account', $5, $6,
       $7::jsonb, '{"sourceReadRequired":true}'::jsonb
     )`,
    [
      eventId,
      `${FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION}.online-card-readiness.property.${input.propertyId}.account.${input.previous.providerAccountId}.cause.${causeHash}.readiness_lost.v1`,
      FINANCE_PAYMENT_READINESS_OUTBOX_DESTINATION,
      input.propertyId,
      input.previous.providerAccountId,
      input.context.correlationId,
      JSON.stringify(payload),
    ],
  );
  await suppressPublishedCard(client, input.propertyId);
  return true;
}

async function suppressPublishedCard(client: Client, propertyId: string): Promise<void> {
  const profile = await client.query<{ canonicalUrl: string; bookingBaseUrl: string }>(
    `SELECT canonical_url AS "canonicalUrl", booking_base_url AS "bookingBaseUrl"
     FROM distribution.public_hotel_bookability_profiles
     WHERE property_id = $1::uuid
       AND capabilities -> 'paymentMethods' ? 'card'`,
    [propertyId],
  );
  const urls = profile.rows[0];
  if (urls) {
    await client.query(PROJECT_PUBLIC_BOOKABILITY_PROFILE, [
      propertyId,
      urls.canonicalUrl,
      urls.bookingBaseUrl,
    ]);
  }
}
