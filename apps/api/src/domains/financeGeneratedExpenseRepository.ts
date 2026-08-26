import { createHash } from "node:crypto";

import {
  financeGeneratedExpenseFingerprint,
  financeGeneratedExpenseJobKey,
  financeGeneratedExpenseRedactedAuditEvidence,
  financeGeneratedExpenseSourceKey,
  parseFinanceGeneratedExpenseCommand,
  type FinanceGeneratedExpenseCommand,
  type FinanceGeneratedExpenseResult,
} from "@vayada/domain-finance";
import pg from "pg";
import { readFinanceProviderFeeEvidence } from "./financeProviderFeeEvidence.js";

type Failure = Extract<FinanceGeneratedExpenseResult, { ok: false }>["code"];
// prettier-ignore
type KeyRow = { status: string; fingerprint: string; responseHash: string | null; metadata: unknown };
// prettier-ignore
type PriorRow = { entryKind: string; origin: string; categoryId: string; amount: string; currency: string; vendor: string; description: string | null; paymentStatus: string; paidOn: string | null; sourceKey: string; sourceRevision: number | null; reversed: boolean };
// prettier-ignore
type RuleRow = { categoryId: string; revision: number; startsOn: string; endsOn: string | null; active: boolean; vendor: string; description: string | null; amount: string; currency: string; paymentStatus: string };
// prettier-ignore
type OtaRow = { guestBookingId: string; serviceNight: string; recognizedOn: string; economicEvent: string; sourceKind: string; currency: string; amount: string | null; effectiveAmount: string | null; positive: boolean | null; negative: boolean | null; state: string; correctsId: string | null };
const OPERATION = "finance.generated_expense.execute";
const SAVEPOINT = "finance_generated_expense";
// prettier-ignore
const OTA_MISSING = { missing_gross: "ota_commission_missing_gross", missing_rule: "ota_commission_missing_rule", missing_rule_and_gross: "ota_commission_missing_rule_and_gross", ambiguous_rule: "ota_commission_ambiguous_rule", ambiguous_rule_and_gross: "ota_commission_ambiguous_rule_and_gross" } as const;

// prettier-ignore
export function createPgFinanceGeneratedExpenseRepository(connectionString:string,clock:()=>Date=()=>new Date()) {
  const pool = new pg.Pool({ connectionString });
  return {
    async execute(raw: FinanceGeneratedExpenseCommand): Promise<FinanceGeneratedExpenseResult> {
      const command = parseFinanceGeneratedExpenseCommand(raw);
      if (!command) return rejected("invalid_command");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        const result = await saved(client, command, clock().toISOString());
        await client.query(result.ok ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        await rollback(client);
        if (transient(error)) return rejected("write_unavailable");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// prettier-ignore
export async function appendFinanceGeneratedExpense(client:pg.PoolClient,raw:FinanceGeneratedExpenseCommand,clock:()=>Date=()=>new Date()):Promise<FinanceGeneratedExpenseResult> {
  const command = parseFinanceGeneratedExpenseCommand(raw);
  return command ? saved(client, command, clock().toISOString()) : rejected("invalid_command");
}

// prettier-ignore
async function saved(client:pg.PoolClient,command:FinanceGeneratedExpenseCommand,acceptedAt:string) {
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const result = await append(client, command, acceptedAt);
    await client.query(
      result.ok
        ? `RELEASE SAVEPOINT ${SAVEPOINT}`
        : `ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`,
    );
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`);
    if (transient(error)) return rejected("write_unavailable");
    throw error;
  }
}

// prettier-ignore
async function append(client:pg.PoolClient,command:FinanceGeneratedExpenseCommand,acceptedAt:string):Promise<FinanceGeneratedExpenseResult> {
  const sourceKey = financeGeneratedExpenseSourceKey(command);
  const keyHash = hash(financeGeneratedExpenseJobKey(command));
  const fingerprint = financeGeneratedExpenseFingerprint(command)!;
  // prettier-ignore
  const property=await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE",[command.propertyId]);
  if (property.rowCount !== 1) return rejected("evidence_mismatch");
  const existing = await client.query<KeyRow>(
    `SELECT status,request_fingerprint_hash AS fingerprint,response_body_hash AS "responseHash",idempotency_metadata AS metadata
     FROM platform.idempotency_keys WHERE operation_scope='finance' AND operation=$1 AND key_hash=$2
       AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
    [OPERATION, keyHash, command.propertyId],
  );
  if (existing.rows[0]) return replay(client, existing.rows[0], command, sourceKey, fingerprint);
  const scope = (
    await client.query<{ currencyOk: boolean; categoryOk: boolean; systemKey: string | null }>(
      `SELECT EXISTS(SELECT 1 FROM pms.property_pricing_settings WHERE property_id=$1::uuid AND currency=$2 FOR SHARE) AS "currencyOk",
       EXISTS(SELECT 1 FROM finance.expense_categories WHERE id=$3::uuid AND property_id=$1::uuid AND ($4 OR archived_at IS NULL) FOR SHARE) AS "categoryOk",
       (SELECT system_key FROM finance.expense_categories WHERE id=$3::uuid AND property_id=$1::uuid) AS "systemKey"`,
      // prettier-ignore
      [command.propertyId,command.amount.currency,command.categoryId,command.action!=="create"],
    )
  ).rows[0]!;
  if (!scope.currencyOk) return rejected("currency_mismatch");
  if (!scope.categoryOk) return rejected("evidence_mismatch");
  if (command.origin === "ota_commission" && scope.systemKey !== "ota_commission")
    return rejected("evidence_mismatch");
  if (command.origin === "platform_fee" && scope.systemKey !== "platform_fees")
    return rejected("evidence_mismatch");
  const prior = await priorExpense(client, command);
  if (command.action !== "create" && !prior) return rejected("correction_conflict");
  const sourceResult = await validateSource(client, command, prior);
  if (sourceResult) return sourceResult;
  const reserved = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys(operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,correlation_id,expires_at)
     VALUES ('finance',$1,$2,$3,'in_progress','property',$4::uuid,$5,'infinity') ON CONFLICT DO NOTHING RETURNING id::text`,
    [OPERATION, keyHash, fingerprint, command.propertyId, command.audit.correlationId],
  );
  const reservationId = reserved.rows[0]?.id;
  if (!reservationId) return rejected("source_conflict");
  // prettier-ignore
  const entryKind = command.action === "create" ? "expense" : command.action === "correct" ? "correction" : "reversal";
  // prettier-ignore
  const links = command.action === "create" ? command.source.kind === "recurring" ? [command.source.recurringRuleId, null, null] : command.source.kind === "ota_commission" ? [null, command.source.guestBookingId, null] : [null, null, command.source.paymentId] : [null, null, null];
  try {
    await client.query(
      `INSERT INTO finance.expenses(id,property_id,category_id,origin,entry_kind,incurred_on,paid_on,vendor,description,amount,currency,payment_status,recurring_rule_id,source_key,reverses_expense_id,guest_booking_id,payment_id)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::date,$7::date,$8,$9,$10::numeric,$11,$12,$13::uuid,$14,$15::uuid,$16::uuid,$17::uuid)`,
      // prettier-ignore
      [command.commandId,command.propertyId,command.categoryId,command.origin,entryKind,command.incurredOn,command.paidOn,command.vendor,command.description,command.amount.amount,command.amount.currency,command.paymentStatus,links[0],sourceKey,command.reversesExpenseId,links[1],links[2]],
    );
  } catch (error) {
    const name = String(constraint(error));
    if (["expenses_pkey", "uq_finance_expenses_generated_source"].includes(name))
      return rejected("source_conflict");
    if (name === "uq_finance_expenses_reverses") return rejected("correction_conflict");
    if (name === "fk_finance_expenses_pricing_currency") return rejected("currency_mismatch");
    if (name.startsWith("fk_finance_expenses_")) return rejected("evidence_mismatch");
    throw error;
  }
  // prettier-ignore
  const outcome: "created" | "corrected" | "reversed" = command.action === "create" ? "created" : command.action === "correct" ? "corrected" : "reversed";
  const result = { ok: true as const, outcome, expenseId: command.commandId };
  const sourceRevision = command.source.kind === "recurring" ? command.source.ruleRevision : null;
  // prettier-ignore
  const redacted={...financeGeneratedExpenseRedactedAuditEvidence(command)!,outcome,sourceRevision};
  await client.query(
    `INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,idempotency_key_id,correlation_id,causation_id,redacted_payload,audit_metadata,retention_class,privacy_scope)
     VALUES ($1,'finance',$2,$3::timestamptz,'property',$4::uuid,'system','finance','expense',$5,$6::uuid,$7,$8,$9::jsonb,jsonb_build_object('requestId',$10::text,'requestedAt',$11::text),'financial','confidential')`,
    // prettier-ignore
    [`${OPERATION}.property.${command.propertyId}.expense.${command.commandId}.key.${keyHash}.v1`,OPERATION,acceptedAt,command.propertyId,command.commandId,reservationId,command.audit.correlationId,command.audit.causationId,JSON.stringify(redacted),command.audit.requestId,command.audit.requestedAt],
  );
  const completed = await client.query(
    `UPDATE platform.idempotency_keys SET status='completed',response_status_code=200,response_body_hash=$2,completed_at=$3::timestamptz,response_resource_product='finance',response_resource_type='expense',response_resource_id=$4,
       idempotency_metadata=jsonb_build_object('propertyId',$5::text,'action',$6::text,'sourceKey',$7::text,'expenseId',$4::text,'sourceRevision',$8::int)
     WHERE id=$1::uuid AND status='in_progress'`,
    // prettier-ignore
    [reservationId,resultHash(command.propertyId,sourceKey,command.action,command.commandId),acceptedAt,command.commandId,command.propertyId,command.action,sourceKey,sourceRevision],
  );
  if (completed.rowCount !== 1) throw new Error("generated expense idempotency completion failed");
  return result;
}

// prettier-ignore
async function priorExpense(client:pg.PoolClient,command:FinanceGeneratedExpenseCommand):Promise<PriorRow|null> {
  if(command.action==="create")return null;
  const row=(await client.query<PriorRow>(`SELECT e.entry_kind AS "entryKind",e.origin,e.category_id::text AS "categoryId",e.amount::text,e.currency::text AS currency,e.vendor,e.description,e.payment_status AS "paymentStatus",e.paid_on::text AS "paidOn",e.source_key AS "sourceKey",NULLIF(a.redacted_payload->>'sourceRevision','')::int AS "sourceRevision",EXISTS(SELECT 1 FROM finance.expenses child WHERE child.reverses_expense_id=e.id) AS reversed
    FROM finance.expenses e LEFT JOIN platform.product_audit_events a ON a.product='finance' AND a.action=$3 AND a.property_id=e.property_id AND a.target_resource_product='finance' AND a.target_resource_type='expense' AND a.target_resource_id=e.id::text AND a.audit_key LIKE $3||'.property.'||e.property_id||'.expense.'||e.id||'.key.%.v1'
    WHERE e.id=$1::uuid AND e.property_id=$2::uuid FOR UPDATE OF e`,[command.reversesExpenseId,command.propertyId,OPERATION])).rows[0];
  return row&&row.origin===command.origin&&row.categoryId===command.categoryId&&row.currency===command.amount.currency&&row.entryKind!=="reversal"&&!row.reversed?row:null;
}

// prettier-ignore
async function validateSource(client:pg.PoolClient,command:FinanceGeneratedExpenseCommand,prior:PriorRow|null):Promise<FinanceGeneratedExpenseResult|null> {
  const source = command.source;
  if (source.kind === "recurring") {
    if (prior && !sameBase(prior.sourceKey, sourceBase(command)))
      return rejected("correction_conflict");
    if (command.action === "reverse")
      return prior && prior.sourceRevision === source.ruleRevision && sameEconomics(prior, command)
        ? null
        : rejected("evidence_mismatch");
    const row = (
      await client.query<RuleRow>(
        `SELECT category_id::text AS "categoryId",revision::int,starts_on::text AS "startsOn",ends_on::text AS "endsOn",active,vendor,description,amount::text,currency::text,payment_status AS "paymentStatus" FROM finance.recurring_expense_rules WHERE id=$1::uuid AND property_id=$2::uuid FOR SHARE`,
        [source.recurringRuleId, command.propertyId],
      )
    ).rows[0];
    // prettier-ignore
    return !row||!row.active||row.revision!==source.ruleRevision||row.categoryId!==command.categoryId||source.occurrenceOn<row.startsOn||(row.endsOn!==null&&source.occurrenceOn>row.endsOn)||row.vendor!==command.vendor||row.description!==command.description||row.amount!==command.amount.amount||row.currency!==command.amount.currency||row.paymentStatus!==command.paymentStatus?rejected("evidence_mismatch"):null;
  }
  if (source.kind === "platform_fee") return providerSource(client, command, source, prior);
  const row = (
    await client.query<OtaRow>(
      `SELECT ota.guest_booking_id::text AS "guestBookingId",ota.service_night::text AS "serviceNight",night.recognized_on::text AS "recognizedOn",night.economic_event AS "economicEvent",night.source_kind AS "sourceKind",ota.currency::text,abs(ota.commission_amount)::text AS amount,(ota.commission_amount+$3::numeric)::text AS "effectiveAmount",ota.commission_amount>0 AS positive,ota.commission_amount<0 AS negative,ota.evidence_state AS state,ota.corrects_commission_evidence_id::text AS "correctsId" FROM finance.ota_commission_evidence ota JOIN booking.nightly_revenue_evidence night ON night.id=ota.booking_revenue_evidence_id WHERE ota.id=$1::uuid AND ota.property_id=$2::uuid FOR SHARE OF ota,night`,
      [source.commissionEvidenceId, command.propertyId, prior?.amount ?? "0"],
    )
  ).rows[0];
  if (!row) return rejected("evidence_mismatch");
  if (
    row.sourceKind !== "ota" ||
    row.guestBookingId !== source.guestBookingId ||
    row.serviceNight !== source.serviceNight ||
    (command.action === "create" ? row.serviceNight : row.recognizedOn) !== command.incurredOn ||
    row.currency !== command.amount.currency
  )
    return rejected("evidence_mismatch");
  if (
    row.correctsId === null
      ? command.action !== "create"
      : command.action === "create" &&
        (await evidenceProjected(client, command.propertyId, "ota_commission", row.correctsId))
  )
    return rejected("correction_conflict");
  if (
    prior &&
    (!row.correctsId || !(await evidenceProjected(client, command.propertyId, "ota_commission", row.correctsId, prior.sourceKey)))
  )
    return rejected("correction_conflict");
  // prettier-ignore
  const eventOk=command.action==="create"?["room_night","retained_charge","correction","occupancy_adjustment"].includes(row.economicEvent):command.action==="correct"?["correction","refund","occupancy_adjustment"].includes(row.economicEvent):["room_night_reversal","refund","correction","occupancy_adjustment"].includes(row.economicEvent);
  if (!eventOk) return rejected("evidence_mismatch");
  const missing = OTA_MISSING[row.state as keyof typeof OTA_MISSING];
  if (missing) return { ok: true, outcome: "missing_evidence", code: missing };
  // prettier-ignore
  if(row.state!=="applied"||(command.action==="create"?row.amount!==command.amount.amount||!row.positive:command.action==="correct"?!row.effectiveAmount||row.effectiveAmount!==command.amount.amount:!row.negative||row.amount!==prior?.amount||command.amount.amount!==prior.amount))return rejected("evidence_mismatch");
  return null;
}

// prettier-ignore
async function providerSource(client:pg.PoolClient,command:FinanceGeneratedExpenseCommand,source:Extract<FinanceGeneratedExpenseCommand["source"],{kind:"platform_fee"}>,prior:PriorRow|null):Promise<FinanceGeneratedExpenseResult|null>{
  const result=await readFinanceProviderFeeEvidence(client,{propertyId:command.propertyId,paymentId:source.paymentId,evidenceId:source.providerFeeEvidenceId});
  if(result.outcome==="missing")return rejected("evidence_mismatch");
  const evidence=result.evidence;
  if(evidence.evidenceOn!==source.evidenceOn||evidence.evidenceOn!==command.incurredOn||evidence.currency!==command.amount.currency)return rejected("evidence_mismatch");
  if(command.action==="create"&&evidence.correctsEvidenceId&&await evidenceProjected(client,command.propertyId,"platform_fee",evidence.correctsEvidenceId))return rejected("correction_conflict");
  if(evidence.state==="missing")return command.action==="create"?{ok:true,outcome:"missing_evidence",code:"provider_fee_missing"}:rejected("correction_conflict");
  if(evidence.state==="proven_zero"||(command.action==="create"&&evidence.state==="correction"&&evidence.feeAmount==="0.0000"))return command.action==="create"?{ok:true,outcome:"ineligible",reason:"known_zero"}:rejected("correction_conflict");
  if(command.action==="create")return ["applied","correction"].includes(evidence.state)&&evidence.feeAmount===command.amount.amount?null:rejected("evidence_mismatch");
  if(!evidence.correctsEvidenceId||!prior||!await evidenceProjected(client,command.propertyId,"platform_fee",evidence.correctsEvidenceId,prior.sourceKey))return rejected("correction_conflict");
  if(command.action==="correct")return evidence.state==="correction"&&evidence.feeAmount!=="0.0000"&&evidence.feeAmount===command.amount.amount?null:rejected("evidence_mismatch");
  return ["correction","reversal"].includes(evidence.state)&&evidence.feeAmount==="0.0000"&&sameEconomics(prior,command)?null:rejected("evidence_mismatch");
}

// prettier-ignore
async function evidenceProjected(client:pg.PoolClient,propertyId:string,origin:"ota_commission"|"platform_fee",evidenceId:string,sourceKey:string|null=null):Promise<boolean>{
  const [table,corrects,prefix]=origin==="ota_commission"?["ota_commission_evidence","corrects_commission_evidence_id","ota_commission_evidence:"]:["provider_fee_evidence","corrects_provider_fee_evidence_id","provider_fee_evidence:"];
  return (await client.query(`WITH RECURSIVE chain AS (SELECT id,${corrects} AS prior FROM finance.${table} WHERE id=$1::uuid AND property_id=$2::uuid UNION ALL SELECT evidence.id,evidence.${corrects} FROM finance.${table} evidence JOIN chain ON evidence.id=chain.prior WHERE evidence.property_id=$2::uuid) SELECT 1 FROM chain LEFT JOIN finance.expenses expense ON expense.property_id=$2::uuid AND expense.origin=$3 AND (expense.source_key=$4||chain.id::text OR expense.source_key LIKE $4||chain.id::text||':%') WHERE ($5::text IS NOT NULL AND ($5=$4||chain.id::text OR $5 LIKE $4||chain.id::text||':%')) OR ($5 IS NULL AND expense.entry_kind<>'reversal' AND NOT EXISTS(SELECT 1 FROM finance.expenses child WHERE child.reverses_expense_id=expense.id)) LIMIT 1`,[evidenceId,propertyId,origin,prefix,sourceKey])).rowCount===1;
}

// prettier-ignore
async function replay(client:pg.PoolClient,row:KeyRow,command:FinanceGeneratedExpenseCommand,sourceKey:string,fingerprint:string):Promise<FinanceGeneratedExpenseResult> {
  if(row.fingerprint!==fingerprint||row.status!=="completed")return rejected("source_conflict");
  const metadata=row.metadata,revision=command.source.kind==="recurring"?command.source.ruleRevision:null;
  if(!exact(metadata,["propertyId","action","sourceKey","expenseId","sourceRevision"])||metadata["propertyId"]!==command.propertyId||metadata["action"]!==command.action||metadata["sourceKey"]!==sourceKey||metadata["expenseId"]!==command.commandId||metadata["sourceRevision"]!==revision||row.responseHash!==resultHash(command.propertyId,sourceKey,command.action,command.commandId))throw new Error("generated expense replay evidence is invalid");
  const entryKind=command.action==="create"?"expense":command.action==="correct"?"correction":"reversal";
  const live=await client.query(`SELECT 1 FROM finance.expenses e WHERE id=$1::uuid AND property_id=$2::uuid AND origin=$3 AND entry_kind=$4 AND source_key=$5 AND reverses_expense_id IS NOT DISTINCT FROM $6::uuid AND EXISTS(SELECT 1 FROM platform.product_audit_events a WHERE a.product='finance' AND a.action=$7 AND a.property_id=e.property_id AND a.target_resource_id=e.id::text)`,[command.commandId,command.propertyId,command.origin,entryKind,sourceKey,command.reversesExpenseId,OPERATION]);
  if(live.rowCount!==1)throw new Error("generated expense replay evidence is invalid");
  return {ok:true,outcome:"replayed",expenseId:command.commandId};
}

// prettier-ignore
function sameEconomics(prior:PriorRow,command:FinanceGeneratedExpenseCommand):boolean{return prior.amount===command.amount.amount&&prior.vendor===command.vendor&&prior.description===command.description&&prior.paymentStatus===command.paymentStatus&&prior.paidOn===command.paidOn;}
// prettier-ignore
function sourceBase(command:FinanceGeneratedExpenseCommand):string{const key=financeGeneratedExpenseSourceKey(command);return command.action==="create"?key:key.slice(0,-(`:${command.action}:${command.reversesExpenseId}`).length);}
// prettier-ignore
function sameBase(sourceKey:string,base:string):boolean{return sourceKey===base||sourceKey.startsWith(`${base}:`);}
// prettier-ignore
function resultHash(propertyId:string,sourceKey:string,action:string,expenseId:string):string{return hash(JSON.stringify([propertyId,sourceKey,action,expenseId]));}
// prettier-ignore
function rejected(code:Failure):Extract<FinanceGeneratedExpenseResult,{ok:false}>{return {ok:false,outcome:"rejected",code};}
// prettier-ignore
function exact(value:unknown,keys:readonly string[]):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
// prettier-ignore
function hash(value:string):string{return createHash("sha256").update(value).digest("hex");}
// prettier-ignore
function constraint(value:unknown):unknown{return (value as {constraint?:unknown}|null)?.constraint;}
// prettier-ignore
function transient(value:unknown):boolean{return ["55P03","57014"].includes(String((value as {code?:unknown}|null)?.code));}
// prettier-ignore
async function rollback(client:pg.PoolClient):Promise<void>{try{await client.query("ROLLBACK");}catch{}}
