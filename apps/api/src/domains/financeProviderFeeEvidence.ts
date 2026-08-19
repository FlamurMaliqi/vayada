import { createHash } from "node:crypto";

import { getTimezone } from "countries-and-timezones";
import type { QueryResult, QueryResultRow } from "pg";

// prettier-ignore
export type FinanceProviderFeeClient = { query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> };
export type FinanceProviderFeeState =
  | "applied"
  | "proven_zero"
  | "missing"
  | "correction"
  | "reversal";
export type FinanceProviderFeeProvider =
  | "stripe"
  | "paypal"
  | "xendit"
  | "vayada"
  | "manual"
  | "bank_transfer"
  | "migration";
// prettier-ignore
export type FinanceProviderFeeEvidence = { evidenceId: string; propertyId: string; paymentId: string; provider: FinanceProviderFeeProvider; settlementRevision: number; state: FinanceProviderFeeState; evidenceOn: string; evidenceAt: string; feeAmount: string | null; currency: string; sourceRevision: string; propertyTimezone: string; propertyTimezoneRevision: string; correctsEvidenceId: string | null };
// prettier-ignore
export type AppendFinanceProviderFeeEvidence = { propertyId: string; paymentId: string; provider: FinanceProviderFeeProvider; settlementRevision: number; state: FinanceProviderFeeState; evidenceAt: string; feeAmount: string | null; currency: string; sourceRevision: string; correctsEvidenceId: string | null };

export class FinanceProviderFeeEvidenceError extends Error {
  constructor(
    readonly code:
      | "invalid_evidence"
      | "transaction_required"
      | "scope_unavailable"
      | "replay_conflict"
      | "correction_conflict",
  ) {
    super(code);
  }
}

// prettier-ignore
type Row = Omit<FinanceProviderFeeEvidence, "evidenceAt" | "state"> & { evidenceAt: Date | string; state: FinanceProviderFeeState };
const COLUMNS = `id::text AS "evidenceId",property_id::text AS "propertyId",payment_id::text AS "paymentId",
  provider,settlement_revision::int AS "settlementRevision",evidence_state AS state,evidence_on::text AS "evidenceOn",
  evidence_at AS "evidenceAt",fee_amount::text AS "feeAmount",currency::text,source_revision AS "sourceRevision",
  property_timezone AS "propertyTimezone",property_timezone_revision AS "propertyTimezoneRevision",
  corrects_provider_fee_evidence_id::text AS "correctsEvidenceId"`;

// prettier-ignore
export async function readFinanceProviderFeeEvidence(client: FinanceProviderFeeClient, input: { propertyId: string; paymentId: string; evidenceId?: string }): Promise<{ outcome: "found"; evidence: FinanceProviderFeeEvidence } | { outcome: "missing"; code: "provider_fee_missing" }> {
  if(!uuid(input.propertyId)||!uuid(input.paymentId)||(input.evidenceId!==undefined&&!uuid(input.evidenceId))) fail("invalid_evidence");
  const result=await client.query<Row>(`SELECT ${COLUMNS} FROM finance.provider_fee_evidence
    WHERE property_id=$1::uuid AND payment_id=$2::uuid AND ($3::uuid IS NULL OR id=$3::uuid)
    ORDER BY settlement_revision DESC,id DESC LIMIT 1 FOR SHARE`,[input.propertyId,input.paymentId,input.evidenceId??null]);
  return result.rows[0]?{outcome:"found",evidence:map(result.rows[0])}:{outcome:"missing",code:"provider_fee_missing"};
}

// prettier-ignore
export async function appendFinanceProviderFeeEvidence(client:FinanceProviderFeeClient,input:AppendFinanceProviderFeeEvidence) {
  validate(input);
  const transaction=(await client.query<{backend:string;transaction:string}>(`SELECT pg_backend_pid()::text backend,txid_current()::text transaction`)).rows[0]!;
  const payment=(await client.query<{providerAccountId:string;provider:string;currency:string;timeZone:string|null;profileRevision:string}>(
    `SELECT payment.provider_account_id::text AS "providerAccountId",account.provider,payment.currency::text,
       location.timezone AS "timeZone",property.profile_revision::text AS "profileRevision"
     FROM finance.payments payment JOIN finance.payment_provider_accounts account
       ON account.id=payment.provider_account_id AND account.property_id=payment.property_id
     JOIN hotel_catalog.properties property ON property.id=payment.property_id
     JOIN hotel_catalog.property_locations location ON location.property_id=property.id
     WHERE payment.id=$1::uuid AND payment.property_id=$2::uuid
     FOR UPDATE OF payment FOR SHARE OF account,property,location`,[input.paymentId,input.propertyId])).rows[0];
  const current=(await client.query<{backend:string;transaction:string}>(`SELECT pg_backend_pid()::text backend,txid_current()::text transaction`)).rows[0]!;
  if(transaction.backend!==current.backend||transaction.transaction!==current.transaction)fail("transaction_required");
  if(!payment||payment.provider!==input.provider||payment.currency!==input.currency)fail("scope_unavailable");
  const zone=payment.timeZone&&getTimezone(payment.timeZone);
  if(!zone||zone.name!==payment.timeZone||zone.aliasOf!==null)fail("scope_unavailable");
  const timezoneRevision=`profile:${payment.profileRevision}`;
  const fingerprint=hash(JSON.stringify([input.propertyId,input.paymentId,input.provider,input.settlementRevision,input.state,input.evidenceAt,input.feeAmount,input.currency,input.sourceRevision,input.correctsEvidenceId,payment.timeZone,timezoneRevision]));
  const replay=await bySource(client,input);
  if(replay)return replay.sourceFingerprint===fingerprint?{outcome:"replayed" as const,evidence:map(replay)}:fail("replay_conflict");
  if(input.correctsEvidenceId){
    const prior=(await client.query<{settlementRevision:number}>(`SELECT settlement_revision::int AS "settlementRevision"
      FROM finance.provider_fee_evidence WHERE id=$1::uuid AND property_id=$2::uuid AND payment_id=$3::uuid
        AND provider=$4 AND currency=$5 FOR SHARE`,[input.correctsEvidenceId,input.propertyId,input.paymentId,input.provider,input.currency])).rows[0];
    if(!prior||prior.settlementRevision>=input.settlementRevision)fail("correction_conflict");
  }else if((await client.query(`SELECT 1 FROM finance.provider_fee_evidence WHERE property_id=$1::uuid AND payment_id=$2::uuid LIMIT 1 FOR SHARE`,[input.propertyId,input.paymentId])).rowCount)fail("correction_conflict");
  const inserted=await client.query<Row>(`WITH zone AS (SELECT name FROM pg_timezone_names WHERE name=$12)
    INSERT INTO finance.provider_fee_evidence(property_id,payment_id,provider_account_id,provider,
      settlement_revision,evidence_state,evidence_on,evidence_at,fee_amount,currency,source_revision,
      source_fingerprint_hash,property_timezone,property_timezone_revision,corrects_provider_fee_evidence_id)
    SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,($7::timestamptz AT TIME ZONE zone.name)::date,
      $7::timestamptz,$8::numeric,$9,$10,$11,$12,$13,$14::uuid FROM zone
    ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,[input.propertyId,input.paymentId,payment.providerAccountId,
      input.provider,input.settlementRevision,input.state,input.evidenceAt,input.feeAmount,input.currency,
      input.sourceRevision,fingerprint,payment.timeZone,timezoneRevision,input.correctsEvidenceId]);
  if(inserted.rows[0])return {outcome:"captured" as const,evidence:map(inserted.rows[0])};
  const raced=await bySource(client,input);
  if(!raced||raced.sourceFingerprint!==fingerprint)fail("replay_conflict");
  return {outcome:"replayed" as const,evidence:map(raced)};
}

// prettier-ignore
type SourceRow=Row&{sourceFingerprint:string};
// prettier-ignore
async function bySource(client:FinanceProviderFeeClient,input:AppendFinanceProviderFeeEvidence){return (await client.query<SourceRow>(`SELECT ${COLUMNS},source_fingerprint_hash AS "sourceFingerprint" FROM finance.provider_fee_evidence WHERE property_id=$1::uuid AND payment_id=$2::uuid AND provider=$3 AND source_revision=$4 FOR SHARE`,[input.propertyId,input.paymentId,input.provider,input.sourceRevision])).rows[0]??null;}
// prettier-ignore
function validate(input:AppendFinanceProviderFeeEvidence){
  const correction=["correction","reversal"].includes(input.state),timestamp=Date.parse(input.evidenceAt);
  const amount=input.feeAmount,amountOk=amount===null||/^(0|[1-9]\d{0,14})\.\d{4}$/.test(amount);
  const shape=(input.state==="applied"&&amount!==null&&amount!=="0.0000"&&!input.correctsEvidenceId)||(input.state==="proven_zero"&&amount==="0.0000"&&!input.correctsEvidenceId)||(input.state==="missing"&&amount===null&&!input.correctsEvidenceId)||(input.state==="correction"&&amount!==null&&!!input.correctsEvidenceId)||(input.state==="reversal"&&amount==="0.0000"&&!!input.correctsEvidenceId);
  if(!uuid(input.propertyId)||!uuid(input.paymentId)||!Number.isSafeInteger(input.settlementRevision)||input.settlementRevision<1
    ||!["stripe","paypal","xendit","vayada","manual","bank_transfer","migration"].includes(input.provider)
    ||!/^[A-Z]{3}$/.test(input.currency)||!amountOk||!shape||correction!==!!input.correctsEvidenceId
    ||(input.correctsEvidenceId!==null&&!uuid(input.correctsEvidenceId))||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.sourceRevision)
    ||!Number.isFinite(timestamp)||new Date(timestamp).toISOString()!==input.evidenceAt)fail("invalid_evidence");
}
// prettier-ignore
function map(row:Row):FinanceProviderFeeEvidence{return {...row,evidenceAt:new Date(row.evidenceAt).toISOString()};}
// prettier-ignore
function uuid(value:string|undefined):boolean{return !!value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
// prettier-ignore
function fail(code:ConstructorParameters<typeof FinanceProviderFeeEvidenceError>[0]):never{throw new FinanceProviderFeeEvidenceError(code);}
