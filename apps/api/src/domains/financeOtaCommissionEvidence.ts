import type { QueryResult, QueryResultRow } from "pg";

import { FINANCE_OTA_CHANNELS, type FinanceOtaChannel } from "@vayada/domain-finance";
import {
  appendExternalNightlyRevenueEvidence,
  type AppendExternalRevenueEvidenceCommand,
} from "./bookingExternalNightlyRevenueEvidence.js";

// prettier-ignore
export type FinanceOtaCommissionEvidenceClient = { query<T extends QueryResultRow = QueryResultRow>(
  text: string, values?: readonly unknown[],
): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> };

// prettier-ignore
export type FinanceOtaCommissionEvidenceState = "applied" | "missing_gross" | "missing_rule"
  | "missing_rule_and_gross" | "ambiguous_rule" | "ambiguous_rule_and_gross";

// prettier-ignore
export type FinanceOtaCommissionEvidence = {
  snapshotId: string; bookingRevenueEvidenceId: string; propertyId: string; serviceNight: string;
  channel: FinanceOtaChannel; currency: string; grossRoomAmount: string | null;
  commissionRuleId: string | null; commissionRuleRevision: number | null;
  percentageRate: string | null; commissionAmount: string | null;
  evidenceState: FinanceOtaCommissionEvidenceState; correctsCommissionEvidenceId: string | null;
};

export class FinanceOtaCommissionEvidenceScopeError extends Error {
  readonly code = "ota_commission_evidence_scope_unavailable";
}
export class FinanceOtaCommissionCorrectionSourceError extends Error {
  readonly code = "ota_commission_correction_source_unavailable";
}

// prettier-ignore
type SourceRow = { bookingRevenueEvidenceId: string; propertyId: string; guestBookingId: string;
  serviceNight: string; currency: string; grossRoomAmount: string | null; sourceKind: string;
  channel: string; correctsEvidenceId: string | null };
type RuleRow = { ruleId: string; revision: number; percentageRate: string };
// prettier-ignore
export type FinancePropertyTimezoneEvidence = { source: { ownerDomain: "hotel_catalog";
  entityType: "property_profile"; entityId: string; revision: string }; timeZone: string };
// prettier-ignore
type CaptureInput = { propertyId: string; bookingRevenueEvidenceId: string;
  propertyTimezone: FinancePropertyTimezoneEvidence };
const SNAPSHOT_COLUMNS = `id::text AS "snapshotId",
  booking_revenue_evidence_id::text AS "bookingRevenueEvidenceId",
  property_id::text AS "propertyId", service_night::text AS "serviceNight", channel,
  currency::text AS currency, gross_room_amount::text AS "grossRoomAmount",
  commission_rule_id::text AS "commissionRuleId", commission_rule_revision::int AS "commissionRuleRevision",
  percentage_rate::text AS "percentageRate", commission_amount::text AS "commissionAmount",
  evidence_state AS "evidenceState", corrects_commission_evidence_id::text AS "correctsCommissionEvidenceId"`;

export async function appendExternalNightlyRevenueEconomics(
  client: FinanceOtaCommissionEvidenceClient,
  command: AppendExternalRevenueEvidenceCommand,
  propertyTimezone: FinancePropertyTimezoneEvidence,
) {
  // The caller owns the open transaction so Booking and Finance commit or roll back together.
  const result = await appendExternalNightlyRevenueEvidence(client, command);
  // prettier-ignore
  if (command.sourceKind === "ota") for (const bookingRevenueEvidenceId of result.evidenceIds)
    await captureFinanceOtaCommissionEvidence(client,
      { propertyId: command.propertyId, bookingRevenueEvidenceId, propertyTimezone });
  return result;
}

export async function captureFinanceOtaCommissionEvidence(
  client: FinanceOtaCommissionEvidenceClient,
  input: CaptureInput,
) {
  if (
    input.propertyTimezone.source.ownerDomain !== "hotel_catalog" ||
    input.propertyTimezone.source.entityId !== input.propertyId
  )
    throw new FinanceOtaCommissionEvidenceScopeError("Property timezone evidence is unavailable");
  const replay = await find(client, input);
  if (replay) return { outcome: "replayed" as const, evidence: replay };

  const source = (
    await client.query<SourceRow>(
      `SELECT revenue.evidence_id::text AS "bookingRevenueEvidenceId",
         revenue.property_id::text AS "propertyId", revenue.guest_booking_id::text AS "guestBookingId",
         revenue.stay_date::text AS "serviceNight", revenue.currency::text AS currency,
         revenue.gross_room_amount::text AS "grossRoomAmount", revenue.source_kind AS "sourceKind",
         attribution.booking_channel AS channel,
         revenue.corrects_evidence_id::text AS "correctsEvidenceId"
       FROM booking.finance_nightly_revenue_evidence revenue
       JOIN booking.finance_booking_attribution attribution
         ON attribution.guest_booking_id = revenue.guest_booking_id
        AND attribution.property_id = revenue.property_id
       WHERE revenue.evidence_id = $1::uuid AND revenue.property_id = $2::uuid`,
      [input.bookingRevenueEvidenceId, input.propertyId],
    )
  ).rows[0];
  if (!source)
    throw new FinanceOtaCommissionEvidenceScopeError("Nightly revenue evidence is unavailable");
  if (source.sourceKind !== "ota" || !isOtaChannel(source.channel))
    return { outcome: "ineligible" as const, reason: "not_ota" as const };

  let rule: RuleRow | null = null;
  let state: FinanceOtaCommissionEvidenceState;
  let corrects: string | null = null;
  if (source.correctsEvidenceId) {
    const prior = await find(client, {
      propertyId: input.propertyId,
      bookingRevenueEvidenceId: source.correctsEvidenceId,
    });
    if (!prior)
      throw new FinanceOtaCommissionCorrectionSourceError(
        "Original commission snapshot is unavailable",
      );
    corrects = prior.snapshotId;
    rule = prior.commissionRuleId
      ? {
          ruleId: prior.commissionRuleId,
          revision: prior.commissionRuleRevision!,
          percentageRate: prior.percentageRate!,
        }
      : null;
    state = stateFrom(prior.evidenceState, source.grossRoomAmount);
  } else {
    const rules = await client.query<RuleRow>(
      `SELECT id::text AS "ruleId", revision::int AS revision,
         percentage_rate::text AS "percentageRate"
       FROM finance.commission_rules
       WHERE property_id = $1::uuid AND ota_channel = $2
         AND starts_at <= ($3::date::timestamp AT TIME ZONE $4)
         AND (ends_at IS NULL OR ($3::date::timestamp AT TIME ZONE $4) < ends_at)
       ORDER BY id`,
      [input.propertyId, source.channel, source.serviceNight, input.propertyTimezone.timeZone],
    );
    rule = rules.rows.length === 1 ? rules.rows[0]! : null;
    state = baseState(rules.rows.length, source.grossRoomAmount);
  }

  const inserted = await client.query<FinanceOtaCommissionEvidence>(
    `INSERT INTO finance.ota_commission_evidence
       (booking_revenue_evidence_id, property_id, guest_booking_id, service_night, channel,
        currency, gross_room_amount, commission_rule_id, commission_rule_revision,
        percentage_rate, commission_amount, evidence_state, corrects_commission_evidence_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6::char(3), $7::numeric, $8::uuid, $9,
       $10::numeric, CASE WHEN $7::numeric IS NULL OR $10::numeric IS NULL THEN NULL ELSE
         round($7::numeric * $10::numeric / 100, CASE
           WHEN $6::text IN ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF') THEN 0
           WHEN $6::text IN ('BHD','IQD','JOD','KWD','LYD','OMR','TND') THEN 3
           WHEN $6::text IN ('CLF','UYW') THEN 4 ELSE 2 END) END,
       $11, $12::uuid)
     ON CONFLICT (booking_revenue_evidence_id) DO NOTHING RETURNING ${SNAPSHOT_COLUMNS}`,
    // prettier-ignore
    [source.bookingRevenueEvidenceId, source.propertyId, source.guestBookingId,
      source.serviceNight, source.channel, source.currency, source.grossRoomAmount,
      rule?.ruleId ?? null, rule?.revision ?? null, rule?.percentageRate ?? null, state, corrects],
  );
  const evidence = inserted.rows[0] ?? (await find(client, input));
  if (!evidence) throw new Error("OTA commission evidence capture failed");
  return { outcome: inserted.rows[0] ? ("captured" as const) : ("replayed" as const), evidence };
}

async function find(
  client: FinanceOtaCommissionEvidenceClient,
  input: { propertyId: string; bookingRevenueEvidenceId: string },
) {
  return (
    (
      await client.query<FinanceOtaCommissionEvidence>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM finance.ota_commission_evidence
       WHERE booking_revenue_evidence_id = $1::uuid AND property_id = $2::uuid`,
        [input.bookingRevenueEvidenceId, input.propertyId],
      )
    ).rows[0] ?? null
  );
}

function isOtaChannel(channel: string): channel is FinanceOtaChannel {
  return FINANCE_OTA_CHANNELS.some((value) => value === channel);
}
function baseState(ruleCount: number, gross: string | null): FinanceOtaCommissionEvidenceState {
  if (ruleCount > 1) return gross === null ? "ambiguous_rule_and_gross" : "ambiguous_rule";
  if (ruleCount === 0) return gross === null ? "missing_rule_and_gross" : "missing_rule";
  return gross === null ? "missing_gross" : "applied";
}
function stateFrom(
  prior: FinanceOtaCommissionEvidenceState,
  gross: string | null,
): FinanceOtaCommissionEvidenceState {
  if (prior.startsWith("ambiguous_rule"))
    return gross === null ? "ambiguous_rule_and_gross" : "ambiguous_rule";
  if (prior.startsWith("missing_rule"))
    return gross === null ? "missing_rule_and_gross" : "missing_rule";
  return gross === null ? "missing_gross" : "applied";
}
