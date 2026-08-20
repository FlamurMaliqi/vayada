import { createHash, randomUUID } from "node:crypto";

import type {
  FinanceGeneratedExpenseAudit,
  FinanceGeneratedExpenseResult,
} from "@vayada/domain-finance";
import pg from "pg";

import { projectFinanceOtaCommissionExpense } from "../domains/financeOtaCommissionExpenseProjection.js";
import { projectFinanceProviderFeeExpense } from "../domains/financeProviderFeeExpenseProjection.js";
import { appendFinanceRecurringExpenseGeneration } from "../domains/financeRecurringExpenseGeneration.js";

export const FINANCE_EXPENSE_GENERATION_QUEUE = "finance.expense-generation";
export const FINANCE_EXPENSE_GENERATION_JOB_TYPE = "finance.generate-expense";
// prettier-ignore
type Context = { requestId: string; correlationId: string; causationId: string; requestedAt: string };
// prettier-ignore
export type FinanceExpenseGenerationInput = Context & { propertyId: string } & (
  | { family: "recurring"; dueThrough: string }
  | { family: "ota_commission"; commissionEvidenceId: string }
  | { family: "provider_fee"; providerFeeEvidenceId: string; paymentId: string });
// prettier-ignore
export type FinanceExpenseGenerationCounters = { succeeded: number; replayed: number; incomplete: number; retryScheduled: number; deadLettered: number };
type Counter = keyof FinanceExpenseGenerationCounters;
type RunOutcome = Counter | "continued";
// prettier-ignore
type Candidate = { family:"recurring"|"ota_commission"|"provider_fee"; propertyId:string; dueThrough:string|null; commissionEvidenceId:string|null; providerFeeEvidenceId:string|null; paymentId:string|null; sourceUpdatedAt:string|null; evidenceId:string|null; issueCode:string|null; auditKey:string|null; timezone:string|null };
// prettier-ignore
type Job = { id:string; jobKey:string; propertyId:string; resourceType:string; resourceId:string; correlationId:string; attemptsCount:number; maxAttempts:number; payload:Record<string,unknown>; jobMetadata:Record<string,unknown>; requestId:string; causationId:string; requestedAt:string };
// prettier-ignore
type Handled = { outcome: "succeeded" | "replayed" } | { outcome: "incomplete"; code: string } | { outcome: "continuation"; code: "bounded_sweep_remaining"; blockedRuleIds: string[]; incompleteCode?: string } | { outcome: "continuation"; code: "predecessor_not_projected"; predecessorEvidenceId: string; runAfter: string; waitCount: number; projectionObserved?: boolean } | { outcome: "failed"; code: string; retryable: boolean; replayEligible?: boolean };
const TRANSIENT = new Set(["40001", "40P01", "55P03", "57014"]);

// prettier-ignore
export async function enqueueFinanceExpenseGeneration(client:pg.PoolClient,input:FinanceExpenseGenerationInput){
  const jobKey=canonicalKey(input),payload=payloadFor(input),resourceType=input.family==="recurring"?"property":`${input.family}_evidence`,resourceId=input.family==="recurring"?input.propertyId:input.family==="ota_commission"?input.commissionEvidenceId:input.providerFeeEvidenceId;
  const row=(await client.query<{jobId:string;status:string}>(`INSERT INTO platform.jobs(job_key,queue_name,job_type,status,max_attempts,run_after,tenant_scope,property_id,
    resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,payload,job_metadata)
    VALUES($1,$2,$3,'pending',5,$11::timestamptz,'property',$4::uuid,'finance',$5,$6,$7,$8,$9::jsonb,$10::jsonb)
    ON CONFLICT(queue_name,job_key) DO UPDATE SET job_key=platform.jobs.job_key RETURNING id::text AS "jobId",status`,[jobKey,FINANCE_EXPENSE_GENERATION_QUEUE,FINANCE_EXPENSE_GENERATION_JOB_TYPE,input.propertyId,resourceType,resourceId,input.correlationId,hash(jobKey),JSON.stringify(payload),JSON.stringify({requestId:input.requestId,causationId:input.causationId,requestedAt:input.requestedAt}),input.requestedAt])).rows[0]!;
  return {...row,jobKey};
}

// Discovers durable work from authoritative Finance evidence. Polling also recovers evidence
// committed while this process was unavailable, without coupling evidence writers to a queue provider.
// prettier-ignore
export async function discoverFinanceExpenseGenerationJobs(pool:pg.Pool,options:{limit?:number;clock?:()=>Date}={}){
  const client=await pool.connect();
  try{const now=(options.clock??(()=>new Date()))(),limit=options.limit??25;await client.query("BEGIN");await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    const leader=(await client.query<{acquired:boolean}>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired",[`${FINANCE_EXPENSE_GENERATION_QUEUE}:discovery:v1`])).rows[0]?.acquired;
    if(!leader){await client.query("COMMIT");return 0;}
    const recurring=await client.query<Candidate>(`WITH candidate AS (
      SELECT 'recurring'::text family,rule.property_id::text AS "propertyId",
        (($1::timestamptz AT TIME ZONE zone.name)::date)::text AS "dueThrough",
        NULL::text AS "commissionEvidenceId",NULL::text AS "providerFeeEvidenceId",NULL::text AS "paymentId",max(rule.updated_at)::text AS "sourceUpdatedAt",
        NULL::text AS "evidenceId",NULL::text AS "issueCode",NULL::text AS "auditKey",zone.name AS timezone
      FROM finance.recurring_expense_rules rule JOIN hotel_catalog.property_locations location ON location.property_id=rule.property_id JOIN pg_timezone_names zone ON zone.name=location.timezone
      WHERE rule.active AND rule.next_due_on<=($1::timestamptz AT TIME ZONE zone.name)::date
      GROUP BY rule.property_id,zone.name
      UNION ALL
      SELECT 'recurring',rule.property_id::text,NULL,NULL,NULL,NULL,max(rule.updated_at)::text,NULL,
        CASE WHEN location.property_id IS NULL OR location.timezone IS NULL THEN 'property_timezone_missing' ELSE 'property_timezone_invalid' END,
        'finance.expense-generation:discovery-blocked:'||rule.property_id::text||':'||md5(coalesce(location.timezone,'<missing>')),location.timezone
      FROM finance.recurring_expense_rules rule LEFT JOIN hotel_catalog.property_locations location ON location.property_id=rule.property_id LEFT JOIN pg_timezone_names zone ON zone.name=location.timezone
      WHERE rule.active AND zone.name IS NULL GROUP BY rule.property_id,location.property_id,location.timezone
    ),keyed AS (SELECT candidate.*,CASE candidate.family
        WHEN 'recurring' THEN $3||':property:'||candidate."propertyId"||':recurrence:due-through-'||candidate."dueThrough"||':v1'
        ELSE NULL END AS "jobKey" FROM candidate)
    SELECT family,"propertyId","dueThrough","commissionEvidenceId","providerFeeEvidenceId","paymentId","sourceUpdatedAt","evidenceId","issueCode","auditKey",timezone FROM keyed
    WHERE ${financeGenerationEnabled("keyed.\"propertyId\"::uuid")}
      AND ((keyed."issueCode" IS NULL AND (NOT EXISTS(SELECT 1 FROM platform.jobs job WHERE job.queue_name=$2 AND job.job_type=$3 AND job.job_key=keyed."jobKey")
        OR EXISTS(SELECT 1 FROM platform.jobs job WHERE job.queue_name=$2 AND job.job_type=$3 AND job.job_key=keyed."jobKey" AND job.status='succeeded' AND keyed."sourceUpdatedAt"::timestamptz>job.finished_at)))
        OR (keyed."issueCode" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform.product_audit_events audit WHERE audit.product='finance' AND audit.audit_key=keyed."auditKey")))
    ORDER BY "issueCode" NULLS LAST,"propertyId","dueThrough" LIMIT $4`,[now.toISOString(),FINANCE_EXPENSE_GENERATION_QUEUE,FINANCE_EXPENSE_GENERATION_JOB_TYPE,limit]);
    for(const candidate of recurring.rows){if(candidate.issueCode){await client.query(`INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,redacted_payload,private_payload,audit_metadata,retention_class,privacy_scope)
          VALUES($1,'finance','finance.expense_generation.discovery_blocked',$2,'property',$3::uuid,'system','finance','property',$3,jsonb_build_object('outcome','blocked','outcomeCode',$4::text),jsonb_build_object('timezoneEvidence',$5::text),jsonb_build_object('queueName',$6::text,'jobType',$7::text),'financial','confidential') ON CONFLICT(product,audit_key) DO NOTHING`,[candidate.auditKey,now.toISOString(),candidate.propertyId,candidate.issueCode,candidate.timezone,FINANCE_EXPENSE_GENERATION_QUEUE,FINANCE_EXPENSE_GENERATION_JOB_TYPE]);continue;}
      const context={propertyId:candidate.propertyId,requestId:`finance-expense-discovery:${randomUUID()}`,correlationId:`finance-expense-generation:${candidate.propertyId}`,causationId:randomUUID(),requestedAt:now.toISOString()},job=await enqueueFinanceExpenseGeneration(client,{...context,family:"recurring",dueThrough:candidate.dueThrough!});if(job.status==="succeeded")await replayFinanceExpenseGenerationJob(client,job.jobId,()=>now);
    }
    const remaining=Math.max(0,limit-(recurring.rowCount??0));let evidenceRows:Candidate[]=[];
    if(remaining){evidenceRows=(await client.query<Candidate>(`SELECT dispatch.family,dispatch.property_id::text AS "propertyId",NULL::text AS "dueThrough",
        CASE dispatch.family WHEN 'ota_commission' THEN dispatch.evidence_id::text END AS "commissionEvidenceId",CASE dispatch.family WHEN 'provider_fee' THEN dispatch.evidence_id::text END AS "providerFeeEvidenceId",dispatch.payment_id::text AS "paymentId",NULL::text AS "sourceUpdatedAt",dispatch.evidence_id::text AS "evidenceId",NULL::text AS "issueCode",NULL::text AS "auditKey",NULL::text AS timezone
      FROM finance.expense_generation_dispatches dispatch JOIN hotel_catalog.properties property ON property.id=dispatch.property_id WHERE dispatch.dispatched_at IS NULL ORDER BY dispatch.created_at,dispatch.family,dispatch.evidence_id FOR UPDATE OF dispatch SKIP LOCKED LIMIT $1`,[remaining])).rows;
      for(const candidate of evidenceRows){const context={propertyId:candidate.propertyId,requestId:`finance-expense-discovery:${randomUUID()}`,correlationId:`finance-expense-generation:${candidate.propertyId}`,causationId:randomUUID(),requestedAt:now.toISOString()};
        if(candidate.family==="ota_commission")await enqueueFinanceExpenseGeneration(client,{...context,family:candidate.family,commissionEvidenceId:candidate.commissionEvidenceId!});
        else await enqueueFinanceExpenseGeneration(client,{...context,family:"provider_fee",providerFeeEvidenceId:candidate.providerFeeEvidenceId!,paymentId:candidate.paymentId!});
        await client.query("UPDATE finance.expense_generation_dispatches SET dispatched_at=$3::timestamptz WHERE family=$1 AND evidence_id=$2::uuid AND dispatched_at IS NULL",[candidate.family,candidate.evidenceId,now.toISOString()]);
      }
    }
    await client.query("COMMIT");return (recurring.rowCount??0)+evidenceRows.length;
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}

export async function runFinanceExpenseGenerationCycle(
  pool: pg.Pool,
  options: { workerId?: string; limit?: number; clock?: () => Date; random?: () => number } = {},
) {
  let discovered = 0,
    discoveryError: unknown;
  try {
    discovered = await discoverFinanceExpenseGenerationJobs(pool, options);
  } catch (error) {
    discoveryError = error;
  }
  try {
    const counters = await runFinanceExpenseGenerationJobs(pool, options);
    if (discoveryError) throw discoveryError;
    return { discovered, ...counters };
  } catch (error) {
    if (discoveryError && error !== discoveryError)
      throw new AggregateError(
        [discoveryError, error],
        "Finance expense discovery and worker failed",
      );
    throw error;
  }
}

// prettier-ignore
export async function replayFinanceExpenseGenerationJob(client:pg.PoolClient,jobId:string,clock:()=>Date=()=>new Date()){
  if(!uuid(jobId))return null;
  const row=(await client.query<{jobId:string}>(`WITH candidate AS (
      SELECT job.* FROM platform.jobs job WHERE job.id=$1::uuid AND job.queue_name=$2 AND job.job_type=$3
        AND (job.status='succeeded' OR (job.status='dead_lettered' AND EXISTS(SELECT 1 FROM platform.dead_letter_events dead WHERE dead.job_id=job.id AND dead.failure_payload->>'replayEligible'='true'))) FOR UPDATE),
    replayed AS (UPDATE platform.jobs job SET status='pending',run_after=$4::timestamptz,finished_at=NULL,locked_at=NULL,locked_by=NULL,max_attempts=GREATEST(job.max_attempts,job.attempts_count+1),updated_at=$4::timestamptz,job_metadata=job.job_metadata||'{"replayRequested":true}'::jsonb FROM candidate WHERE job.id=candidate.id RETURNING job.*),
    dead AS (UPDATE platform.dead_letter_events dead SET recovery_status='requeued',requeued_job_id=replayed.id FROM replayed WHERE dead.job_id=replayed.id RETURNING dead.id)
    INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,job_id,correlation_id,causation_id,redacted_payload,audit_metadata,retention_class,privacy_scope)
    SELECT 'finance.expense-generation:'||id||':replay:'||attempts_count,'finance','finance.expense_generation.replay_requested',$4,'property',property_id,'system','finance',resource_type,resource_id,id,correlation_id,job_metadata->>'causationId','{"outcome":"replay_requested"}'::jsonb,jsonb_build_object('queueName',queue_name,'jobType',job_type),'financial','confidential' FROM replayed RETURNING job_id::text AS "jobId"`,[jobId,FINANCE_EXPENSE_GENERATION_QUEUE,FINANCE_EXPENSE_GENERATION_JOB_TYPE,clock().toISOString()])).rows[0];
  return row??null;
}

// prettier-ignore
export async function runFinanceExpenseGenerationJobs(pool:pg.Pool,options:{workerId?:string;limit?:number;propertyId?:string;clock?:()=>Date;random?:()=>number}={}):Promise<FinanceExpenseGenerationCounters>{
  const counters:FinanceExpenseGenerationCounters={succeeded:0,replayed:0,incomplete:0,retryScheduled:0,deadLettered:0};
  for(let index=0;index<(options.limit??25);index++){const outcome=await runOne(pool,options);if(!outcome)break;if(outcome!=="continued")counters[outcome]++;}
  return counters;
}

// prettier-ignore
async function runOne(pool:pg.Pool,options:{workerId?:string;propertyId?:string;clock?:()=>Date;random?:()=>number}):Promise<RunOutcome|null>{
  const client=await pool.connect(),now=(options.clock??(()=>new Date()))(),worker=options.workerId??`finance-expense:${process.pid}`;
  try{await client.query("BEGIN");await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    const job=(await client.query<Job>(`SELECT id::text,job_key AS "jobKey",property_id::text AS "propertyId",resource_type AS "resourceType",resource_id AS "resourceId",correlation_id AS "correlationId",attempts_count::int AS "attemptsCount",max_attempts::int AS "maxAttempts",payload,job_metadata AS "jobMetadata",job_metadata->>'requestId' AS "requestId",job_metadata->>'causationId' AS "causationId",job_metadata->>'requestedAt' AS "requestedAt" FROM platform.jobs job
      WHERE queue_name=$1 AND job_type=$2 AND tenant_scope='property' AND property_id IS NOT NULL AND status='pending' AND run_after<=$3::timestamptz AND attempts_count<max_attempts AND ($4::uuid IS NULL OR property_id=$4::uuid)
        AND ${financeGenerationEnabled("job.property_id")}
      ORDER BY priority DESC,run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,[FINANCE_EXPENSE_GENERATION_QUEUE,FINANCE_EXPENSE_GENERATION_JOB_TYPE,now.toISOString(),options.propertyId??null])).rows[0];
    if(!job){await client.query("COMMIT");return null;}const attempt=job.attemptsCount+1;
    await client.query("UPDATE platform.jobs SET status='running',attempts_count=$2,locked_at=$3,locked_by=$4,updated_at=$3 WHERE id=$1::uuid",[job.id,attempt,now.toISOString(),worker]);
    const attemptId=(await client.query<{id:string}>("INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id,started_at) VALUES($1::uuid,$2,'running',$3,$4) RETURNING id::text",[job.id,attempt,worker,now.toISOString()])).rows[0]!.id;
    await client.query("SAVEPOINT finance_expense_generation_handler");let handled:Handled;
    try{handled=await invoke(client,job,attemptId,now);if(handled.outcome==="failed")await restore(client);else await client.query("RELEASE SAVEPOINT finance_expense_generation_handler");}
    catch(error){await restore(client);const code=String((error as {code?:unknown}|null)?.code??"handler_failed");handled={outcome:"failed",code,retryable:TRANSIENT.has(code)};}
    const outcome=handled.outcome==="failed"?await fail(client,job,attemptId,attempt,handled,now,options.random??Math.random):handled.outcome==="continuation"?await continueSweep(client,job,attemptId,attempt,handled,now):await succeed(client,job,attemptId,attempt,handled,now);
    await client.query("COMMIT");return outcome;
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
}

// prettier-ignore
async function invoke(client:pg.PoolClient,job:Job,attemptId:string,now:Date):Promise<Handled>{
  const audit={actor:{kind:"system" as const,service:"finance-expense-automation" as const},requestId:job.requestId,correlationId:job.correlationId,causationId:job.causationId,jobId:job.id,jobAttemptId:attemptId,requestedAt:job.requestedAt} satisfies Omit<FinanceGeneratedExpenseAudit,"reasonCode">,family=job.payload["family"];
  if(family==="recurring"){
    const pendingIds=Array.isArray(job.jobMetadata["pendingNonActionableRuleIds"])?job.jobMetadata["pendingNonActionableRuleIds"].filter(uuid):[],hidden=pendingIds.length?(await client.query<{id:string}>("WITH scope AS (SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR UPDATE) UPDATE finance.recurring_expense_rules rule SET active=false FROM scope WHERE rule.property_id=scope.id AND rule.id=ANY($2::uuid[]) AND rule.active RETURNING rule.id::text",[job.propertyId,pendingIds])).rows.map(row=>row.id):[];let result:Awaited<ReturnType<typeof appendFinanceRecurringExpenseGeneration>>;
    result=await appendFinanceRecurringExpenseGeneration(client,{propertyId:job.propertyId,propertyLocalAsOf:String(job.payload["dueThrough"]),ruleLimit:50,catchUpLimit:24,audit:{...audit,reasonCode:"scheduled_generation"}},()=>now);if(hidden.length)await client.query("UPDATE finance.recurring_expense_rules SET active=true WHERE property_id=$1::uuid AND id=ANY($2::uuid[])",[job.propertyId,hidden]);
    if(!result.ok)return failure(result.code);const transientFailure=result.occurrences.find(item=>item.outcome==="failed"&&failure(item.code).retryable);if(transientFailure&&transientFailure.outcome==="failed")return failure(transientFailure.code);
    const failed=result.occurrences.find(item=>item.outcome==="failed"),missing=result.occurrences.find(item=>item.outcome==="skipped"&&item.reason==="missing_evidence"),priorCode=typeof job.jobMetadata["pendingIncompleteCode"]==="string"?job.jobMetadata["pendingIncompleteCode"]:undefined,incompleteCode=failed?.code||(missing?"missing_evidence":undefined)||priorCode,nonActionable=result.occurrences.filter(item=>item.outcome==="failed"||item.outcome==="skipped").map(item=>item.ruleId),blockedRuleIds=[...new Set([...pendingIds,...nonActionable])];
    const progressed=result.occurrences.some(item=>item.outcome==="generated"||item.outcome==="replayed"),remaining=(progressed||nonActionable.length>0)&&(await client.query<{remaining:boolean}>("SELECT EXISTS(SELECT 1 FROM finance.recurring_expense_rules WHERE property_id=$1::uuid AND active AND next_due_on<=$2::date AND NOT(id=ANY($3::uuid[]))) remaining",[job.propertyId,String(job.payload["dueThrough"]),blockedRuleIds])).rows[0]!.remaining;if(remaining)return {outcome:"continuation",code:"bounded_sweep_remaining",blockedRuleIds,...(incompleteCode?{incompleteCode}:{})};if(incompleteCode)return {outcome:"incomplete",code:incompleteCode};
    return {outcome:result.occurrences.length>0&&result.occurrences.every(item=>item.outcome==="replayed")?"replayed":"succeeded"};
  }
  let result:FinanceGeneratedExpenseResult;
  if(family==="ota_commission")result=await projectFinanceOtaCommissionExpense(client,{commandId:stableUuid(job.jobKey),propertyId:job.propertyId,commissionEvidenceId:String(job.payload["commissionEvidenceId"]),audit},()=>now);
  else if(family==="provider_fee"){const evidenceId=String(job.payload["providerFeeEvidenceId"]),paymentId=(await client.query<{paymentId:string}>("SELECT payment_id::text AS \"paymentId\" FROM finance.provider_fee_evidence WHERE id=$1::uuid AND property_id=$2::uuid",[evidenceId,job.propertyId])).rows[0]?.paymentId??String(job.payload["paymentId"]);result=await projectFinanceProviderFeeExpense(client,{commandId:stableUuid(job.jobKey),propertyId:job.propertyId,paymentId,providerFeeEvidenceId:evidenceId,audit});}
  else return failure("invalid_command");
  if(!result.ok){if(result.code!=="predecessor_not_projected")return failure(result.code);const evidenceId=String(job.payload[family==="ota_commission"?"commissionEvidenceId":"providerFeeEvidenceId"]);return predecessorContinuation(client,job,family,evidenceId,now);}if(result.outcome==="missing_evidence")return {outcome:"incomplete",code:result.code};return {outcome:result.outcome==="replayed"?"replayed":"succeeded"};
}

// prettier-ignore
async function predecessorContinuation(client:pg.PoolClient,job:Job,family:"ota_commission"|"provider_fee",evidenceId:string,now:Date):Promise<Handled>{
  const table=family==="ota_commission"?"ota_commission_evidence":"provider_fee_evidence",column=family==="ota_commission"?"corrects_commission_evidence_id":"corrects_provider_fee_evidence_id",origin=family==="ota_commission"?"ota_commission":"platform_fee";
  const predecessor=(await client.query<{evidenceId:string;projected:boolean;dispatchPending:boolean;status:string|null;runAfter:string|null;attemptsCount:number|null;maxAttempts:number|null;replayEligible:boolean|null}>(`SELECT prior.id::text AS "evidenceId",EXISTS(SELECT 1 FROM finance.expenses expense WHERE expense.property_id=$5::uuid AND expense.origin=$6 AND (expense.source_key=$4||'_evidence:'||prior.id::text OR expense.source_key LIKE $4||'_evidence:'||prior.id::text||':%')) AS projected,dispatch.dispatched_at IS NULL AND dispatch.evidence_id IS NOT NULL AS "dispatchPending",dependency.status,dependency.run_after::text AS "runAfter",dependency.attempts_count::int AS "attemptsCount",dependency.max_attempts::int AS "maxAttempts",(SELECT (dead.failure_payload->>'replayEligible')::boolean FROM platform.dead_letter_events dead WHERE dead.job_id=dependency.id LIMIT 1) AS "replayEligible" FROM finance.${table} evidence JOIN finance.${table} prior ON prior.id=evidence.${column} LEFT JOIN finance.expense_generation_dispatches dispatch ON dispatch.family=$4 AND dispatch.evidence_id=prior.id LEFT JOIN platform.jobs dependency ON dependency.queue_name=$2 AND dependency.job_type=$3 AND dependency.job_key=$3||':property:'||$5::uuid::text||':'||$4||'_evidence:'||prior.id::text||':project:v1' AND dependency.resource_type=$4||'_evidence' AND dependency.resource_id=prior.id::text WHERE evidence.id=$1::uuid AND evidence.property_id=$5::uuid`,[evidenceId,FINANCE_EXPENSE_GENERATION_QUEUE,FINANCE_EXPENSE_GENERATION_JOB_TYPE,family,job.propertyId,origin])).rows[0];
  if(!predecessor||predecessor.evidenceId===evidenceId)return {outcome:"failed",code:"predecessor_job_missing",retryable:false,replayEligible:false};
  const viable=predecessor.status===null?predecessor.dispatchPending:predecessor.status==="running"||(predecessor.status==="pending"&&(predecessor.attemptsCount??0)<(predecessor.maxAttempts??0)),waitCount=Number(job.jobMetadata["predecessorWaitCount"]??0)+1;
  const continuation=(projectionObserved=false)=>{const runAfter=new Date(Math.max(now.getTime()+5_000,predecessor.runAfter?new Date(predecessor.runAfter).getTime():0));return {outcome:"continuation" as const,code:"predecessor_not_projected" as const,predecessorEvidenceId:predecessor.evidenceId,runAfter:runAfter.toISOString(),waitCount:Math.min(waitCount,25),...(projectionObserved?{projectionObserved:true}:{})};};
  if(predecessor.projected)return job.jobMetadata["predecessorProjectionObserved"]===predecessor.evidenceId?{outcome:"failed",code:"predecessor_projection_inconsistent",retryable:false,replayEligible:false}:continuation(true);
  if(viable&&waitCount<=25)return continuation();
  if(viable)return {outcome:"failed",code:"predecessor_wait_exhausted",retryable:false,replayEligible:true};
  if(predecessor.status==="succeeded")return {outcome:"failed",code:"predecessor_projection_missing",retryable:false,replayEligible:false};
  return {outcome:"failed",code:predecessor.status?"predecessor_failed":"predecessor_job_missing",retryable:false,replayEligible:predecessor.replayEligible??false};
}

// prettier-ignore
async function succeed(client:pg.PoolClient,job:Job,attemptId:string,attempt:number,handled:Exclude<Handled,{outcome:"failed"|"continuation"}>,now:Date):Promise<Counter>{
  const code=handled.outcome==="incomplete"?handled.code:null;
  await client.query("UPDATE platform.job_attempts SET status='succeeded',finished_at=$4,error_metadata=jsonb_build_object('outcome',$5::text,'outcomeCode',$6::text) WHERE id=$1::uuid AND job_id=$2::uuid AND attempt_number=$3",[attemptId,job.id,attempt,now.toISOString(),handled.outcome,code]);
  await client.query("UPDATE platform.jobs SET status='succeeded',finished_at=$3,locked_at=NULL,locked_by=NULL,updated_at=$3,job_metadata=(job_metadata-'pendingIncompleteCode'-'pendingNonActionableRuleIds'-'predecessorWaitCount'-'predecessorEvidenceId'-'predecessorProjectionObserved'-'lastErrorCode')||jsonb_build_object('outcome',$4::text,'outcomeCode',$5::text) WHERE id=$1::uuid AND attempts_count=$2 AND status='running'",[job.id,attempt,now.toISOString(),handled.outcome,code]);
  await audit(client,job,attempt,handled.outcome,now,code??undefined);return handled.outcome;
}

// prettier-ignore
async function continueSweep(client:pg.PoolClient,job:Job,attemptId:string,attempt:number,handled:Extract<Handled,{outcome:"continuation"}>,now:Date):Promise<RunOutcome>{
  const recurring=handled.code==="bounded_sweep_remaining",runAfter=recurring?now:new Date(handled.runAfter);
  await client.query("UPDATE platform.job_attempts SET status='succeeded',finished_at=$4,error_metadata=jsonb_build_object('outcome','continuation','outcomeCode',$5::text) WHERE id=$1::uuid AND job_id=$2::uuid AND attempt_number=$3",[attemptId,job.id,attempt,now.toISOString(),handled.code]);
  await client.query("UPDATE platform.jobs SET status='pending',run_after=$3,finished_at=NULL,locked_at=NULL,locked_by=NULL,max_attempts=CASE WHEN $8::boolean THEN max_attempts+1 ELSE GREATEST(max_attempts,attempts_count+5) END,updated_at=$4,job_metadata=(job_metadata-'lastErrorCode')||jsonb_strip_nulls(jsonb_build_object('outcome','continuation','outcomeCode',$5::text,'pendingIncompleteCode',$6::text,'pendingNonActionableRuleIds',$7::jsonb,'predecessorWaitCount',$9::int,'predecessorEvidenceId',$10::text,'predecessorProjectionObserved',$11::text)) WHERE id=$1::uuid AND attempts_count=$2 AND status='running'",[job.id,attempt,runAfter.toISOString(),now.toISOString(),handled.code,recurring?handled.incompleteCode??null:null,recurring?JSON.stringify(handled.blockedRuleIds):null,recurring,recurring?null:handled.waitCount,recurring?null:handled.predecessorEvidenceId,recurring||!handled.projectionObserved?null:handled.predecessorEvidenceId]);
  await audit(client,job,attempt,"continuation_scheduled",now,handled.code);return "continued";
}

// prettier-ignore
async function fail(client:pg.PoolClient,job:Job,attemptId:string,attempt:number,failureResult:Extract<Handled,{outcome:"failed"}>,now:Date,random:()=>number):Promise<Counter>{
  const retry=failureResult.retryable&&attempt<job.maxAttempts,retryAt=retry?new Date(now.getTime()+Math.min(1_800_000,30_000*2**(attempt-1)*(0.5+random()))):null,summary=`Finance expense generation failed (${failureResult.code}).`;
  await client.query("UPDATE platform.job_attempts SET status='failed',finished_at=$4,error_type=$5,error_message=$6,retry_after=$7,error_metadata=jsonb_build_object('retryable',$8::boolean) WHERE id=$1::uuid AND job_id=$2::uuid AND attempt_number=$3",[attemptId,job.id,attempt,now.toISOString(),failureResult.code,summary,retryAt?.toISOString()??null,failureResult.retryable]);
  await client.query("UPDATE platform.jobs SET status=$3,run_after=COALESCE($4,run_after),finished_at=CASE WHEN $3='dead_lettered' THEN $5::timestamptz ELSE NULL END,locked_at=NULL,locked_by=NULL,updated_at=$5,job_metadata=job_metadata||jsonb_build_object('outcome',$6::text,'lastErrorCode',$7::text) WHERE id=$1::uuid AND attempts_count=$2 AND status='running'",[job.id,attempt,retry?"pending":"dead_lettered",retryAt?.toISOString()??null,now.toISOString(),retry?"retry_scheduled":"dead_lettered",failureResult.code]);
  if(!retry)await deadLetter(client,job,attemptId,attempt,failureResult.code,summary,failureResult.replayEligible??failureResult.retryable,now);
  const outcome=retry?"retryScheduled":"deadLettered";await audit(client,job,attempt,retry?"retry_scheduled":"dead_lettered",now,failureResult.code);return outcome;
}

// prettier-ignore
async function deadLetter(client:pg.PoolClient,job:Job,attemptId:string,attempt:number,code:string,summary:string,replayEligible:boolean,now:Date){
  await client.query(`WITH updated AS (UPDATE platform.dead_letter_events SET job_attempt_id=$2::uuid,reason_code=$5,failure_summary=$6,failure_payload=jsonb_build_object('family',$7::text,'attemptNumber',$4::int,'replayEligible',$8::boolean),recovery_status='open',requeued_job_id=NULL,acknowledged_at=NULL,resolved_at=NULL,created_at=$9 WHERE job_id=$1::uuid RETURNING id)
    INSERT INTO platform.dead_letter_events(source_kind,job_id,job_attempt_id,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,reason_code,failure_summary,failure_payload,created_at)
    SELECT 'job',$1::uuid,$2::uuid,'property',$3::uuid,'finance',$10,$11,$12,$13,$5,$6,jsonb_build_object('family',$7::text,'attemptNumber',$4::int,'replayEligible',$8::boolean),$9 WHERE NOT EXISTS(SELECT 1 FROM updated)`,[job.id,attemptId,job.propertyId,attempt,code,summary,String(job.payload["family"]),replayEligible,now.toISOString(),job.resourceType,job.resourceId,job.correlationId,hash(job.jobKey)]);
}

// prettier-ignore
async function audit(client:pg.PoolClient,job:Job,attempt:number,outcome:string,now:Date,code?:string){
  await client.query(`INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,job_id,correlation_id,causation_id,redacted_payload,audit_metadata,retention_class,privacy_scope)
    VALUES($1,'finance',$2,$3,'property',$4::uuid,'system','finance',$5,$6,$7::uuid,$8,$9,jsonb_build_object('outcome',$10::text,'attemptNumber',$11::int,'outcomeCode',$12::text,'failureCode',$12::text),jsonb_build_object('queueName',$13::text,'jobType',$14::text,'requestId',$15::text),'financial','confidential')`,[`finance.expense-generation:${job.id}:attempt:${attempt}:${outcome}`,`finance.expense_generation.${outcome}`,now.toISOString(),job.propertyId,job.resourceType,job.resourceId,job.id,job.correlationId,job.causationId,outcome,attempt,code??null,FINANCE_EXPENSE_GENERATION_QUEUE,FINANCE_EXPENSE_GENERATION_JOB_TYPE,job.requestId]);
}

// prettier-ignore
function failure(code:string):Extract<Handled,{outcome:"failed"}>{return {outcome:"failed",code,retryable:code==="write_unavailable"||code==="revision_conflict"||TRANSIENT.has(code)};}
// prettier-ignore
function canonicalKey(input:FinanceExpenseGenerationInput){if(!uuid(input.propertyId)||!uuid(input.causationId)||!text(input.requestId)||!text(input.correlationId)||!utc(input.requestedAt))throw new Error("invalid finance expense generation job");if(input.family==="recurring"){if(!date(input.dueThrough))throw new Error("invalid finance expense generation job");return `${FINANCE_EXPENSE_GENERATION_JOB_TYPE}:property:${input.propertyId.toLowerCase()}:recurrence:due-through-${input.dueThrough}:v1`;}const evidence=input.family==="ota_commission"?input.commissionEvidenceId:input.providerFeeEvidenceId;if(!uuid(evidence)||(input.family==="provider_fee"&&!uuid(input.paymentId)))throw new Error("invalid finance expense generation job");return `${FINANCE_EXPENSE_GENERATION_JOB_TYPE}:property:${input.propertyId.toLowerCase()}:${input.family}_evidence:${evidence.toLowerCase()}:project:v1`;}
// prettier-ignore
function payloadFor(input:FinanceExpenseGenerationInput):Record<string,string>{return input.family==="recurring"?{family:input.family,dueThrough:input.dueThrough}:input.family==="ota_commission"?{family:input.family,commissionEvidenceId:input.commissionEvidenceId}:{family:input.family,providerFeeEvidenceId:input.providerFeeEvidenceId,paymentId:input.paymentId};}
// prettier-ignore
function stableUuid(value:string){const bytes=createHash("sha256").update(value).digest().subarray(0,16);bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;const hex=bytes.toString("hex");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
// prettier-ignore
function hash(value:string){return createHash("sha256").update(value).digest("hex");}
// prettier-ignore
function financeGenerationEnabled(propertyId:string){return `EXISTS(SELECT 1 FROM identity.product_entitlements financials
  JOIN identity.organizations organization ON organization.id=financials.organization_id AND organization.kind='hotel_group' AND organization.status='active'
  JOIN identity.organization_resource_links resource ON resource.organization_id=financials.organization_id AND resource.product='pms' AND resource.resource_type='pms_property' AND resource.resource_id=(${propertyId})::text AND resource.relationship IN ('owner','finance_manager') AND resource.status='active'
  WHERE financials.product='pms' AND financials.entitlement_key='module:financials' AND financials.status='active' AND (financials.resource_product IS NULL OR (financials.resource_product='pms' AND financials.resource_type='pms_property' AND financials.resource_id=(${propertyId})::text))
    AND (financials.starts_at IS NULL OR financials.starts_at<=now()) AND (financials.expires_at IS NULL OR financials.expires_at>now())
    AND NOT EXISTS(SELECT 1 FROM identity.product_entitlements suspension WHERE suspension.organization_id=financials.organization_id AND suspension.product='pms' AND suspension.entitlement_key='module:financials' AND suspension.status='suspended' AND (suspension.starts_at IS NULL OR suspension.starts_at<=now()) AND (suspension.expires_at IS NULL OR suspension.expires_at>now()) AND (suspension.resource_product IS NULL OR (suspension.resource_product='pms' AND suspension.resource_type='pms_property' AND suspension.resource_id=(${propertyId})::text)))
    AND EXISTS(SELECT 1 FROM identity.product_entitlements base WHERE base.organization_id=financials.organization_id AND base.product='pms' AND base.entitlement_key='property-management' AND base.status='active' AND (base.starts_at IS NULL OR base.starts_at<=now()) AND (base.expires_at IS NULL OR base.expires_at>now()) AND (base.resource_product IS NULL OR (base.resource_product='pms' AND base.resource_type='pms_property' AND base.resource_id=(${propertyId})::text)))
    AND NOT EXISTS(SELECT 1 FROM identity.product_entitlements suspension WHERE suspension.organization_id=financials.organization_id AND suspension.product='pms' AND suspension.entitlement_key='property-management' AND suspension.status='suspended' AND (suspension.starts_at IS NULL OR suspension.starts_at<=now()) AND (suspension.expires_at IS NULL OR suspension.expires_at>now()) AND (suspension.resource_product IS NULL OR (suspension.resource_product='pms' AND suspension.resource_type='pms_property' AND suspension.resource_id=(${propertyId})::text))))`;}
// prettier-ignore
function uuid(value:unknown):value is string{return typeof value==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);}
// prettier-ignore
function text(value:unknown):value is string{return typeof value==="string"&&value===value.trim()&&value.length>0&&value.length<=200;}
// prettier-ignore
function date(value:unknown):value is string{return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10)===value;}
// prettier-ignore
function utc(value:unknown):value is string{return typeof value==="string"&&new Date(value).toISOString()===value;}
// prettier-ignore
async function restore(client:pg.PoolClient){await client.query("ROLLBACK TO SAVEPOINT finance_expense_generation_handler; RELEASE SAVEPOINT finance_expense_generation_handler");}
