import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChannexBookingJobs } from "./channexBookings.js";

const URL = process.env["TEST_DATABASE_URL"],
  P = "11890000-0000-4000-8000-000000000001",
  C = "11890000-0000-4000-8000-000000000002",
  EXTERNAL = "chx-vay-1189";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Refusing non-test database");

// prettier-ignore
describe.skipIf(!URL)("Channex booking worker (PostgreSQL)",()=>{
  const db=new pg.Pool({connectionString:URL??"postgresql://disabled",max:4});let sequence=0,feed:Record<string,unknown>[]=[],owns=true;const calls:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{const url=String(input),method=init?.method??"GET";calls.push(`${method} ${url}`);if(method==="GET")return Response.json({data:feed});const revisionId=url.split("/").at(-2);const durable=await db.query("SELECT 1 FROM pms.channel_booking_mappings WHERE external_revision_id=$1 LIMIT 1",[revisionId]);expect(durable.rowCount).toBe(1);return new Response(null,{status:204});};
  beforeAll(async()=>{await cleanup();await db.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'vay-1189','Channex worker')",[P]);await db.query("INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id) VALUES($2,$1,'channex','connected',$3)",[P,C,EXTERNAL]);});
  afterAll(async()=>{await cleanup();await db.end();});

  it("pulls, attributes, replays, retries atomically, dead-letters, and acknowledges only durable revisions",async()=>{
    feed=[revision("rev-booking","booking-1","BookingCom",2),revision(8,"booking-1","BookingCom")];const first=await job("booking-1","unknown",true,feed[0]!);expect(await run()).toEqual({succeeded:1,retryScheduled:0,deadLettered:0});
    const saved=await db.query(`SELECT booking_channel,(SELECT count(*)::int FROM pms.channel_booking_mappings WHERE guest_booking_id=booking.id) mappings,
      (SELECT mapping_metadata->>'providerSource' FROM pms.channel_booking_mappings WHERE guest_booking_id=booking.id LIMIT 1) source
      FROM booking.guest_bookings booking WHERE source_booking_id=$1`,[`channex:${P}:booking-1`]);expect(saved.rows[0]).toEqual({booking_channel:"booking_com",mappings:2,source:"BookingCom"});
    feed=[];await db.query("UPDATE platform.jobs SET status='pending',finished_at=NULL,run_after=now() WHERE id=$1",[first]);expect((await run()).succeeded).toBe(1);expect((await db.query("SELECT count(*)::int count FROM booking.guest_bookings WHERE source_booking_id=$1",[`channex:${P}:booking-1`])).rows[0].count).toBe(1);
    const changed=revision(9,"booking-1","Expedia",1);changed.attributes.status="cancelled";await job("booking-1","9",false,changed);expect((await run()).succeeded).toBe(1);expect((await db.query("SELECT lifecycle_status,booking_channel,(SELECT count(*)::int FROM pms.channel_booking_mappings WHERE guest_booking_id=booking.id AND sync_status='active') active FROM booking.guest_bookings booking WHERE source_booking_id=$1",[`channex:${P}:booking-1`])).rows[0]).toEqual({lifecycle_status:"canceled",booking_channel:"booking_com",active:1});
    await job("booking-2","rev-other",false,revision("rev-other","booking-2","Hostelworld"));expect((await run()).succeeded).toBe(1);
    await job("booking-3","rev-unknown",false,revision("rev-unknown","booking-3",null));expect((await run()).succeeded).toBe(1);
    for(const [id,source] of [["4","Airbnb"],["5","Expedia.com"],["6","Agoda"]] as const){await job(`booking-${id}`,`rev-${id}`,false,revision(`rev-${id}`,`booking-${id}`,source));expect((await run()).succeeded).toBe(1)}expect((await db.query("SELECT source_booking_id,booking_channel FROM booking.guest_bookings WHERE property_id=$1 ORDER BY source_booking_id",[P])).rows.map(row=>row.booking_channel)).toEqual(["booking_com","other_ota","unknown","airbnb","expedia","agoda"]);

    owns=false;const frozen=await job("booking-frozen","rev-frozen",false,revision("rev-frozen","booking-frozen","Agoda"),1);expect((await run()).deadLettered).toBe(1);owns=true;expect((await db.query("SELECT status,(SELECT count(*)::int FROM platform.dead_letter_events WHERE job_id=job.id) dead FROM platform.jobs job WHERE id=$1",[frozen])).rows[0]).toEqual({status:"dead_lettered",dead:1});
    await db.query("INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,payload) VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking','malformed','{}')",[`vay-1189:${++sequence}`]);expect((await run()).deadLettered).toBe(1);
    await db.query("CREATE FUNCTION pms.vay1189_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'forced rollback guest@example.test';END$$;CREATE TRIGGER vay1189_fail BEFORE INSERT ON pms.channel_booking_mappings FOR EACH ROW EXECUTE FUNCTION pms.vay1189_fail()");
    const rollback=await job("booking-rollback","rev-rollback",false,revision("rev-rollback","booking-rollback","Expedia"));expect((await run()).retryScheduled).toBe(1);expect((await db.query("SELECT count(*)::int count FROM booking.guest_bookings WHERE source_booking_id=$1",[`channex:${P}:booking-rollback`])).rows[0].count).toBe(0);
    await db.query("DROP TRIGGER vay1189_fail ON pms.channel_booking_mappings;DROP FUNCTION pms.vay1189_fail()");await db.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1",[rollback]);expect((await run()).succeeded).toBe(1);
    expect(calls.filter(value=>value.startsWith("GET "))).toHaveLength(2);expect(calls.filter(value=>value.includes("/ack"))).toHaveLength(9);
    const evidence=await db.query("SELECT count(*)::int audits,bool_or(redacted_payload::text LIKE '%BookingCom%' OR redacted_payload::text LIKE '%example.test%') leaked FROM platform.product_audit_events WHERE redacted_payload->>'propertyId'=$1",[P]);expect(evidence.rows[0]).toEqual({audits:11,leaked:false});expect((await db.query("SELECT status FROM platform.jobs WHERE resource_id='malformed'")).rows[0].status).toBe("dead_lettered");
  },20_000);

  function run(){return runChannexBookingJobs(URL!,{apiBaseUrl:"https://app.channex.io",apiKey:"secret",ownsMutation:()=>owns,fetch:fetcher,workerId:"vay-1189",limit:1});}
  async function job(bookingId:string,revisionId:string,pullRequired:boolean,value:Record<string,unknown>,maxAttempts=5){const row=await db.query<{id:string}>(`INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,resource_product,resource_type,resource_id,correlation_id,max_attempts,payload)
    VALUES($1,'pms.channex.webhooks','channex.ingest-booking','external','pms','channel_booking',$2,'vay-1189',$3,$4) RETURNING id::text`,[`vay-1189:${++sequence}`,bookingId,maxAttempts,{propertyId:P,providerPropertyId:EXTERNAL,channelBookingId:bookingId,revision:revisionId,revisionSource:pullRequired?"webhook_hint":"revision_feed",pullRequired,rawPayload:pullRequired?{event:"booking"}:{event:"booking",payload:value}}]);return row.rows[0]!.id;}
  function revision(id:string|number,bookingId:string,source:string|null,rooms=1){return {id,type:"booking_revision",attributes:{property_id:EXTERNAL,booking_id:bookingId,status:"new",arrival_date:"2026-09-01",departure_date:"2026-09-03",amount:"240.00",currency:"EUR",inserted_at:`2026-08-20T12:00:0${sequence}.000Z`,...(source?{ota_name:source}:{}),customer:{name:"Ada",surname:"Guest",mail:"guest@example.test"},rooms:Array.from({length:rooms},()=>({occupancy:{adults:1,children:0}}))}};}
  async function cleanup(){await db.query(`DROP TRIGGER IF EXISTS vay1189_fail ON pms.channel_booking_mappings;DROP FUNCTION IF EXISTS pms.vay1189_fail();BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM platform.product_audit_events WHERE redacted_payload->>'propertyId'='${P}' OR target_resource_id='malformed';DELETE FROM platform.dead_letter_events WHERE job_id IN(SELECT id FROM platform.jobs WHERE payload->>'propertyId'='${P}' OR job_key LIKE 'vay-1189:%');DELETE FROM platform.job_attempts WHERE job_id IN(SELECT id FROM platform.jobs WHERE payload->>'propertyId'='${P}' OR job_key LIKE 'vay-1189:%');DELETE FROM platform.jobs WHERE payload->>'propertyId'='${P}' OR job_key LIKE 'vay-1189:%';DELETE FROM pms.channel_booking_mappings WHERE property_id='${P}';DELETE FROM booking.guest_bookings WHERE property_id='${P}';DELETE FROM pms.channel_connections WHERE property_id='${P}';DELETE FROM hotel_catalog.properties WHERE id='${P}';COMMIT`);}
});
