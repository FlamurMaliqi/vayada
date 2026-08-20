import type { BookingChannel } from "@vayada/domain-booking";
import pg from "pg";

const QUEUE = "pms.channex.webhooks",
  TYPE = "channex.ingest-booking",
  LEASE_MS = 5 * 60_000;
// prettier-ignore
type Payload={propertyId:string;providerPropertyId:string;channelBookingId:string;revision:string;revisionSource:"webhook_hint"|"revision_feed";pullRequired:boolean;rawPayload:Record<string,unknown>};
// prettier-ignore
type Job=Payload&{id:string;correlationId:string|null;attempt:number;maxAttempts:number;appliedRevision:string|null;invalidPayload?:true};
// prettier-ignore
type Revision={id:string;providerPropertyId:string;bookingId:string;status:"confirmed"|"canceled";checkIn:string;checkOut:string;adults:number;children:number;roomCount:number;currency:string;amount:string;providerSource:string|null;channel:BookingChannel;firstName:string;lastName:string;email:string|null;phone:string|null;insertedAt:string|null};
type Counters = { succeeded: number; retryScheduled: number; deadLettered: number };
// prettier-ignore
class Failure extends Error{constructor(readonly code:string,readonly retryable:boolean){super(code)}}

// prettier-ignore
export async function runChannexBookingJobs(
  connectionString: string,
  options:{apiBaseUrl:string;apiKey:string;ownsMutation:()=>boolean;fetch?:typeof fetch;workerId?:string;limit?:number},
): Promise<Counters> {
  const pool = new pg.Pool({ connectionString, max: 2 }),
    counters: Counters = { succeeded: 0, retryScheduled: 0, deadLettered: 0 };
  try {
    for (let index = 0; index < (options.limit ?? 25); index += 1) {
      const claimed = await claim(pool, options.workerId ?? `channex-bookings:${process.pid}`);
      if (!claimed) break;
      if ("expired" in claimed) {
        counters.deadLettered += 1;
        continue;
      }
      const outcome = await processJob(pool, claimed, options);
      counters[outcome] += 1;
    }
    return counters;
  } finally {
    await pool.end();
  }
}

// prettier-ignore
async function processJob(pool:pg.Pool,job:Job,options:Parameters<typeof runChannexBookingJobs>[1]):Promise<keyof Counters>{
  try {
    if(job.invalidPayload)throw new Failure("invalid_job_payload",false);
    own(options);
    const loaded = await loadRevisions(pool, job, options);
    for(const item of loaded){own(options);const revision=parseRevision(item,job),replayed=await persist(pool,job,revision);own(options);await providerRequest(options,`/api/v1/booking_revisions/${revision.id}/ack`,"POST",replayed)}
    await finish(pool, job, "succeeded");
    return "succeeded";
  } catch (error) {
    const failure=error instanceof Failure?error:new Failure(pgCode(error)?"write_unavailable":"handler_failed",true);
    return finish(pool, job, failure);
  }
}

// prettier-ignore
async function claim(pool:pg.Pool,workerId:string):Promise<Job|{expired:true}|null>{
  return transaction(pool, async (client) => {
    const row = (
      await client.query<{id:string;propertyId:string|null;resourceId:string;correlationId:string|null;status:"pending"|"running";attemptsCount:number;maxAttempts:number;appliedRevision:string|null;payload:unknown}>(
        `SELECT id::text,payload->>'propertyId' AS "propertyId",resource_id AS "resourceId",correlation_id AS "correlationId",job_metadata->>'appliedRevisionId' AS "appliedRevision",
          status,attempts_count::int AS "attemptsCount",max_attempts::int AS "maxAttempts",payload
         FROM platform.jobs WHERE queue_name=$1 AND job_type=$2 AND
          ((status='pending' AND run_after<=now() AND attempts_count<max_attempts) OR
           (status='running' AND locked_at<=now()-($3::bigint*interval '1 millisecond')))
         ORDER BY priority DESC,run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [QUEUE, TYPE, LEASE_MS],
      )
    ).rows[0];
    if (!row) return null;
    if (row.status === "running") {
      await client.query("UPDATE platform.job_attempts SET status='timed_out',finished_at=now(),error_type='worker_lease_expired',error_message='Channex booking worker lease expired' WHERE job_id=$1::uuid AND attempt_number=$2 AND status='running'",[row.id,row.attemptsCount]);
      if (row.attemptsCount >= row.maxAttempts) {
        await expire(client, row);
        return { expired: true };
      }
    }
    let payload:Payload,invalidPayload:false|true=false;
    try{payload=parsePayload(row.payload,row.propertyId??"",row.resourceId)}catch{invalidPayload=true;payload={propertyId:row.propertyId??"",providerPropertyId:"",channelBookingId:row.resourceId,revision:"invalid",revisionSource:"revision_feed",pullRequired:false,rawPayload:{}}}
    const attempt = row.attemptsCount + 1;
    await client.query("UPDATE platform.jobs SET status='running',attempts_count=$2,locked_at=now(),locked_by=$3,updated_at=now() WHERE id=$1::uuid",[row.id,attempt,workerId]);
    await client.query("INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id) VALUES($1::uuid,$2,'running',$3)",[row.id,attempt,workerId]);
    return {...payload,id:row.id,correlationId:row.correlationId,attempt,maxAttempts:row.maxAttempts,appliedRevision:row.appliedRevision,...(invalidPayload?{invalidPayload:true as const}:{})};
  });
}

// prettier-ignore
async function loadRevisions(pool:pg.Pool,job:Job,options:Parameters<typeof runChannexBookingJobs>[1]):Promise<Record<string,unknown>[]>{
  if (!job.pullRequired) return [record(record(job.rawPayload).payload)];
  const response=await providerRequest(options,`/api/v1/booking_revisions/feed?filter[property_id]=${encodeURIComponent(job.providerPropertyId)}&order[inserted_at]=asc`,"GET");
  const revisions=Array.isArray(record(response).data)?record(response).data as unknown[]:[];
  const found = revisions.map(record).filter((item) => {
    const attributes = record(item.attributes);
    return text(item.id)===job.revision||(job.revision==="unknown"&&text(attributes.booking_id)===job.channelBookingId);
  });
  if (found.length) return found;
  const appliedRevision=job.appliedRevision??(job.revision==="unknown"?null:job.revision);
  if(!appliedRevision)throw new Failure("revision_not_available",true);
  const applied = await pool.query(
    `SELECT 1 FROM pms.channel_booking_mappings mapping JOIN pms.channel_connections connection
       ON connection.id=mapping.connection_id AND connection.property_id=mapping.property_id
     WHERE mapping.property_id=$1::uuid AND connection.provider='channex'
       AND mapping.external_booking_id=$2 AND mapping.external_revision_id=$3 LIMIT 1`,
    [job.propertyId, job.channelBookingId, appliedRevision],
  );
  if (applied.rowCount) return [];
  throw new Failure("revision_not_available", true);
}

// prettier-ignore
async function persist(pool:pg.Pool,job:Job,revision:Revision):Promise<boolean>{
  return transaction(pool, async (client) => {
    const connection = (
      await client.query<{id:string}>(
        `SELECT id::text FROM pms.channel_connections WHERE property_id=$1::uuid
           AND provider='channex' AND external_property_id=$2 AND connection_status='connected' FOR SHARE`,
        [job.propertyId, job.providerPropertyId],
      )
    ).rows;
    if (connection.length !== 1) throw new Failure("connection_not_owned", true);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`channex-booking:${job.propertyId}:${job.channelBookingId}`]);
    const mappings = (
      await client.query<{guestBookingId:string;revisionId:string|null;insertedAt:string|null}>(
        `SELECT guest_booking_id::text AS "guestBookingId",external_revision_id AS "revisionId",
           mapping_metadata->>'providerInsertedAt' AS "insertedAt" FROM pms.channel_booking_mappings
         WHERE connection_id=$1::uuid AND external_booking_id=$2 ORDER BY channel_room_index FOR UPDATE`,
        [connection[0]!.id, job.channelBookingId],
      )
    ).rows;
    const bookingIds = new Set(mappings.map((row) => row.guestBookingId));
    if (bookingIds.size > 1) throw new Failure("ambiguous_booking_mapping", false);
    const replayed = mappings.some((row) => row.revisionId === revision.id);
    await client.query("UPDATE platform.jobs SET job_metadata=job_metadata||jsonb_build_object('appliedRevisionId',$2::text),updated_at=now() WHERE id=$1::uuid",[job.id,revision.id]);
    if(replayed)return true;
    const newest = mappings[0]?.insertedAt;
    if (newest && revision.insertedAt && newest > revision.insertedAt) return true;
    let guestBookingId = mappings[0]?.guestBookingId;
    if (!guestBookingId) {
      guestBookingId = (
        await client.query<{id:string}>(
          `INSERT INTO booking.guest_bookings(property_id,public_reference,source_system,source_booking_id,
             lifecycle_status,payment_status,check_in,check_out,adults,children,room_count,currency,
             total_amount,balance_amount,booking_channel,booking_metadata)
           VALUES($1::uuid,'CHX-'||upper(substr(md5($2),1,20)),'pms',$2,$3,'unpaid',$4::date,$5::date,
             $6,$7,$8,$9,$10::numeric,$10::numeric,$11,jsonb_build_object('provider','channex')) RETURNING id::text`,
          [job.propertyId,`channex:${job.propertyId}:${job.channelBookingId}`,revision.status,revision.checkIn,revision.checkOut,revision.adults,revision.children,revision.roomCount,revision.currency,revision.amount,revision.channel],
        )
      ).rows[0]!.id;
      await client.query(
        `INSERT INTO booking.booking_guests(guest_booking_id,guest_role,first_name,last_name,email,phone)
         VALUES($1::uuid,'booker',$2,$3,$4,$5)`,
        [guestBookingId, revision.firstName, revision.lastName, revision.email, revision.phone],
      );
    } else {
      await client.query(
        `UPDATE booking.guest_bookings SET lifecycle_status=$3,check_in=$4::date,check_out=$5::date,
           adults=$6,children=$7,room_count=$8,currency=$9,total_amount=$10::numeric,
           balance_amount=CASE WHEN payment_status='unpaid' THEN $10::numeric ELSE balance_amount END,updated_at=now()
         WHERE id=$1::uuid AND property_id=$2::uuid`,
        [guestBookingId,job.propertyId,revision.status,revision.checkIn,revision.checkOut,revision.adults,revision.children,revision.roomCount,revision.currency,revision.amount],
      );
    }
    const metadata=JSON.stringify({providerSource:revision.providerSource,providerPropertyId:job.providerPropertyId,providerInsertedAt:revision.insertedAt});
    await client.query(
      `INSERT INTO pms.channel_booking_mappings(property_id,connection_id,guest_booking_id,
         external_booking_id,external_revision_id,channel,channel_room_index,sync_status,last_synced_at,mapping_metadata)
       SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,'channex',slot,'active',now(),$7::jsonb
       FROM generate_series(0,$6::int-1) slot ON CONFLICT(connection_id,external_booking_id,channel_room_index)
       DO UPDATE SET external_revision_id=EXCLUDED.external_revision_id,sync_status='active',
         last_synced_at=now(),mapping_metadata=EXCLUDED.mapping_metadata,updated_at=now()`,
      [job.propertyId,connection[0]!.id,guestBookingId,job.channelBookingId,revision.id,revision.roomCount,metadata],
    );
    await client.query(
      "UPDATE pms.channel_booking_mappings SET sync_status='superseded',updated_at=now() WHERE connection_id=$1::uuid AND external_booking_id=$2 AND channel_room_index>=$3",
      [connection[0]!.id, job.channelBookingId, revision.roomCount],
    );
    await client.query("UPDATE pms.channel_connections SET last_booking_sync_at=now(),updated_at=now() WHERE id=$1::uuid",[connection[0]!.id]);
    return replayed;
  });
}

// prettier-ignore
async function finish(pool:pg.Pool,job:Job,result:"succeeded"|Failure):Promise<keyof Counters>{
  return transaction(pool, async (client) => {
    const now = new Date(),
      succeeded = result === "succeeded",
      failure = succeeded ? null : result,
      retry = failure !== null && failure.retryable && job.attempt < job.maxAttempts,
      outcome: keyof Counters = succeeded ? "succeeded" : retry ? "retryScheduled" : "deadLettered",
      status = succeeded ? "succeeded" : retry ? "pending" : "dead_lettered",
      retryAt=retry?new Date(now.getTime()+Math.min(60_000,1_000*2**(job.attempt-1))):null,
      code = failure?.code ?? null;
    await client.query(
      `UPDATE platform.job_attempts SET status=$3,finished_at=$4,error_type=$5,
         error_message=CASE WHEN $5::text IS NULL THEN NULL ELSE 'Channex booking ingestion failed ('||$5||').' END,
         retry_after=$6,error_metadata=jsonb_build_object('retryable',$7::boolean)
       WHERE job_id=$1::uuid AND attempt_number=$2 AND status='running'`,
      [job.id,job.attempt,succeeded?"succeeded":"failed",now,code,retryAt,failure?.retryable??false],
    );
    await client.query(
      `UPDATE platform.jobs SET status=$3,run_after=COALESCE($4::timestamptz,run_after),finished_at=CASE WHEN $3::text='pending' THEN NULL ELSE $5::timestamptz END,
         locked_at=NULL,locked_by=NULL,updated_at=$5::timestamptz,job_metadata=(job_metadata-'lastErrorCode')||jsonb_strip_nulls(jsonb_build_object('lastErrorCode',$6::text))
       WHERE id=$1::uuid AND attempts_count=$2 AND status='running'`,
      [job.id, job.attempt, status, retryAt, now, code],
    );
    if (!succeeded && !retry)
      await client.query(
        `INSERT INTO platform.dead_letter_events(source_kind,job_id,job_attempt_id,tenant_scope,
           resource_product,resource_type,resource_id,correlation_id,reason_code,failure_summary,failure_payload)
         SELECT 'job',$1::uuid,id,'external','pms','channel_booking',$2,$3,$4,
           'Channex booking ingestion failed ('||$4||').',jsonb_build_object('replayEligible',$5::boolean)
         FROM platform.job_attempts WHERE job_id=$1::uuid AND attempt_number=$6`,
        [job.id,job.channelBookingId,job.correlationId,code,failure!.retryable,job.attempt],
      );
    await client.query(
      `INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,
         actor_type,target_resource_product,target_resource_type,target_resource_id,job_id,correlation_id,redacted_payload,retention_class,privacy_scope)
       VALUES($1,'pms',$2,$3,'external','system','pms','channel_booking',$4,$5::uuid,$6,
         jsonb_strip_nulls(jsonb_build_object('propertyId',$7::text,'outcome',$8::text,'failureCode',$9::text)),'provider_receipt','restricted')`,
      [`channex.booking:${job.id}:attempt:${job.attempt}:${outcome}`,`channex.booking_ingestion.${outcome}`,now,job.channelBookingId,job.id,job.correlationId,job.propertyId,outcome,code],
    );
    return outcome;
  });
}

// prettier-ignore
async function expire(client:pg.PoolClient,row:{id:string;resourceId:string;correlationId:string|null;attemptsCount:number}){
  await client.query("UPDATE platform.jobs SET status='dead_lettered',finished_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=$1::uuid",[row.id]);
  await client.query(
    `INSERT INTO platform.dead_letter_events(source_kind,job_id,job_attempt_id,tenant_scope,resource_product,resource_type,resource_id,correlation_id,reason_code,failure_summary,failure_payload)
     SELECT 'job',$1::uuid,id,'external','pms','channel_booking',$2,$3,'worker_lease_expired','Channex booking worker lease expired.',jsonb_build_object('replayEligible',true)
     FROM platform.job_attempts WHERE job_id=$1::uuid AND attempt_number=$4`,
    [row.id,row.resourceId,row.correlationId,row.attemptsCount],
  );
}

// prettier-ignore
function parsePayload(value:unknown,propertyId:string,resourceId:string):Payload{
  const payload=record(value),rawPayload=record(payload.rawPayload),parsed={propertyId:text(payload.propertyId),providerPropertyId:text(payload.providerPropertyId),channelBookingId:text(payload.channelBookingId),revision:text(payload.revision),revisionSource:text(payload.revisionSource),pullRequired:payload.pullRequired===true,rawPayload};
  if(!parsed.propertyId||parsed.propertyId!==propertyId||!parsed.providerPropertyId||!parsed.channelBookingId||parsed.channelBookingId!==resourceId||!parsed.revision||parsed.revisionSource!==(parsed.pullRequired?"webhook_hint":"revision_feed")||typeof payload.pullRequired!=="boolean"||!Object.keys(rawPayload).length)throw new Failure("invalid_job_payload",false);
  return parsed as Payload;
}

// prettier-ignore
function parseRevision(value:Record<string,unknown>,job:Job):Revision{
  const attributes=Object.keys(record(value.attributes)).length?record(value.attributes):value,id=text(value.id)??text(attributes.id),bookingId=text(attributes.booking_id),providerPropertyId=text(attributes.property_id),rooms=Array.isArray(attributes.rooms)?attributes.rooms.map(record):[],topOccupancy=record(attributes.occupancy),roomCount=Math.max(rooms.length,1),date=(key:string)=>isoDate(attributes[key]),occupancy=(key:string,fallback:number)=>rooms.length?rooms.reduce((sum,room)=>sum+integer(record(room.occupancy)[key],fallback),0):integer(topOccupancy[key],fallback),providerSource=text(attributes.ota_name),status=(text(attributes.status)??"").toLowerCase(),customer=record(attributes.customer),revision:Revision={id:id??"",providerPropertyId:providerPropertyId??"",bookingId:bookingId??"",status:status==="cancelled"||status==="canceled"?"canceled":"confirmed",checkIn:date("arrival_date"),checkOut:date("departure_date"),adults:occupancy("adults",1),children:occupancy("children",0),roomCount,currency:currency(attributes.currency),amount:amount(attributes.amount),providerSource,channel:canonicalChannel(providerSource),firstName:text(customer.name)??"Guest",lastName:text(customer.surname)??"",email:text(customer.mail),phone:text(customer.phone),insertedAt:timestamp(attributes.inserted_at??value.inserted_at)};
  if(rooms.length>100||revision.adults<1||!revision.id||!revision.insertedAt||!["new","modified","confirmed","cancelled","canceled"].includes(status)||revision.bookingId!==job.channelBookingId||revision.providerPropertyId!==job.providerPropertyId||(job.revision!=="unknown"&&revision.id!==job.revision)||revision.checkIn>=revision.checkOut)throw new Failure("invalid_revision",false);
  return revision;
}

// prettier-ignore
async function providerRequest(options:Parameters<typeof runChannexBookingJobs>[1],path:string,method:"GET"|"POST",allowMissing=false):Promise<unknown>{
  let response: Response;
  try {
    response=await(options.fetch??fetch)(new URL(path,`${options.apiBaseUrl}/`),{method,headers:{"user-api-key":options.apiKey},signal:AbortSignal.timeout(30_000)});
  } catch {
    throw new Failure("provider_unavailable", true);
  }
  if (allowMissing && response.status === 404) return {};
  if (!response.ok)
    throw new Failure(response.status===429?"rate_limited":response.status>=500?"provider_unavailable":"provider_rejected",response.status===429||response.status>=500);
  return response.status === 204 ? {} : response.json();
}

// prettier-ignore
function own(options:Parameters<typeof runChannexBookingJobs>[1]){if(!options.ownsMutation())throw new Failure("ownership_frozen",true)}
// prettier-ignore
function canonicalChannel(value:string|null):BookingChannel{if(!value)return "unknown";const key=value.replace(/[^a-z0-9]/gi,"").toLowerCase();if(key==="booking"||key==="bookingcom")return "booking_com";if(key==="airbnb")return "airbnb";if(key==="expedia"||key==="expediacom")return "expedia";if(key==="agoda")return "agoda";return "other_ota"}
// prettier-ignore
function record(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
// prettier-ignore
function text(value:unknown):string|null{const parsed=typeof value==="number"&&Number.isFinite(value)?String(value):typeof value==="string"?value.trim():"";return parsed&&parsed.length<=200?parsed:null}
// prettier-ignore
function integer(value:unknown,fallback:number):number{return typeof value==="number"&&Number.isInteger(value)&&value>=0&&value<=100?value:fallback}
// prettier-ignore
function isoDate(value:unknown):string{const parsed=text(value);if(!parsed||!/^\d{4}-\d{2}-\d{2}$/.test(parsed)||new Date(`${parsed}T00:00:00Z`).toISOString().slice(0,10)!==parsed)throw new Failure("invalid_revision",false);return parsed}
// prettier-ignore
function currency(value:unknown):string{const parsed=text(value)?.toUpperCase();if(!parsed||!/^[A-Z]{3}$/.test(parsed))throw new Failure("invalid_revision",false);return parsed}
// prettier-ignore
function amount(value:unknown):string{const parsed=typeof value==="number"&&Number.isFinite(value)?value.toFixed(2):text(value);if(!parsed||!/^\d{1,13}(\.\d{1,2})?$/.test(parsed))throw new Failure("invalid_revision",false);return parsed}
// prettier-ignore
function timestamp(value:unknown):string|null{const parsed=text(value);return parsed&&!Number.isNaN(Date.parse(parsed))?new Date(parsed).toISOString():null}
// prettier-ignore
function pgCode(value:unknown):string|null{return value&&typeof value==="object"&&"code" in value&&typeof value.code==="string"?value.code:null}
// prettier-ignore
async function transaction<T>(pool:pg.Pool,run:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
