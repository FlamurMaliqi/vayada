import { createHash } from "node:crypto";
import {
  financeGeneratedExpenseJobKey,
  parseFinanceGeneratedExpenseCommand,
} from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPgFinanceOtaCommissionExpenseProjection,
  projectFinanceOtaCommissionExpense,
  type FinanceOtaCommissionExpenseProjectionCommand,
} from "./financeOtaCommissionExpenseProjection.js";
const URL = process.env["TEST_DATABASE_URL"],
  id = (n: number) => `12330000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// prettier-ignore
const I={property:id(1),otherProperty:id(2),category:id(3),booking:id(4),usdBooking:id(5),room:id(6),rule:id(7),zeroRule:id(8),n1:id(11),n2:id(12),n3:id(13),n4:id(14),n5:id(15),n6:id(16),n7:id(17),n8:id(18),n9:id(19),n10:id(20),n11:id(21),n12:id(22),e1:id(31),e2:id(32),e3:id(33),e4:id(34),e5:id(35),e6:id(36),e7:id(37),e8:id(38),e9:id(39),e10:id(40),e11:id(41),e12:id(42),c1:id(51),c2:id(52),c3:id(53),c4:id(54),c5:id(55),c6:id(56),c7:id(57),c8:id(58),c9:id(59),c10:id(60)} as const;
const NOW = "2026-08-20T12:00:00.000Z";
// prettier-ignore
describe.skipIf(!URL)("OTA commission expense projection (PostgreSQL)",()=>{
  const admin=new pg.Client({connectionString:URL??"postgresql://disabled"});
  const projection=createPgFinanceOtaCommissionExpenseProjection(URL??"postgresql://disabled",()=>new Date(NOW));
  beforeAll(async()=>{
    if(!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL!).pathname))throw new Error("Refusing non-test database");
    await admin.connect();await cleanup();
    await admin.query(`INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ('${I.property}','ota-expense','OTA expense'),('${I.otherProperty}','ota-expense-other','Other');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES ('${I.property}','EUR'),('${I.otherProperty}','USD');
      INSERT INTO finance.expense_categories(id,property_id,system_key,name,color) VALUES ('${I.category}','${I.property}','ota_commission','OTA','#111111');
      INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,check_in,check_out,currency) VALUES ('${I.booking}','${I.property}','ota-booking','completed','2026-08-10','2026-08-11','EUR'),('${I.usdBooking}','${I.property}','ota-booking-usd','completed','2026-08-10','2026-08-11','USD');
      INSERT INTO booking.nightly_revenue_room_scopes VALUES ('${I.property}','${I.room}');
      INSERT INTO finance.commission_rules(id,property_id,rule_scope,product,commission_type,percentage_rate,starts_at,source_system,ota_channel) VALUES ('${I.rule}','${I.property}','property','pms','percentage',15,'2026-01-01','finance','booking_com'),('${I.zeroRule}','${I.property}','property','pms','percentage',0,'2026-01-01','finance','airbnb');
      INSERT INTO booking.nightly_revenue_evidence(id,property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,line_position,corrects_evidence_id,command_key) VALUES
      ('${I.n1}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-10','EUR',100,1,'room_night','completed','ota','exact',1,1,NULL,'ota-project-1'),
      ('${I.n2}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-11','EUR',-20,0,'correction','corrected','ota','exact',2,1,'${I.n1}','ota-project-2'),
      ('${I.n3}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-12','EUR',-80,-1,'occupancy_adjustment','canceled','ota','exact',3,1,'${I.n2}','ota-project-3'),
      ('${I.n4}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-10','EUR',NULL,1,'room_night','completed','ota','missing',1,2,NULL,'ota-project-4'),
      ('${I.n5}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-11','EUR',40,0,'correction','corrected','ota','exact',2,2,'${I.n4}','ota-project-5'),
      ('${I.n6}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-10','EUR',50,1,'room_night','completed','ota','exact',1,3,NULL,'ota-project-6'),
      ('${I.n7}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-10','EUR',100,1,'room_night','completed','ota','exact',1,4,NULL,'ota-project-7'),
      ('${I.n8}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-10','EUR',40,1,'room_night','completed','ota','exact',1,5,NULL,'ota-project-8'),
      ('${I.n9}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-11','EUR',-10,0,'correction','corrected','ota','exact',2,5,'${I.n8}','ota-project-9'),
      ('${I.n10}','${I.property}','${I.usdBooking}','${I.room}','2026-08-10','2026-08-10','USD',100,1,'room_night','completed','ota','exact',1,1,NULL,'ota-project-10'),
      ('${I.n11}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-10','EUR',20,1,'room_night','completed','ota','exact',1,6,NULL,'ota-project-11'),
      ('${I.n12}','${I.property}','${I.booking}','${I.room}','2026-08-10','2026-08-13','EUR',80,1,'occupancy_adjustment','corrected','ota','exact',4,1,'${I.n3}','ota-project-12');
      INSERT INTO finance.ota_commission_evidence(id,booking_revenue_evidence_id,property_id,guest_booking_id,service_night,channel,currency,gross_room_amount,commission_rule_id,commission_rule_revision,percentage_rate,commission_amount,evidence_state,corrects_commission_evidence_id) VALUES
      ('${I.e1}','${I.n1}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',100,'${I.rule}',1,15,15,'applied',NULL),
      ('${I.e2}','${I.n2}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',-20,NULL,NULL,NULL,NULL,'missing_rule','${I.e1}'),
      ('${I.e3}','${I.n3}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',-80,'${I.rule}',1,15,-15,'applied','${I.e2}'),
      ('${I.e4}','${I.n4}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',NULL,'${I.rule}',1,15,NULL,'missing_gross',NULL),
      ('${I.e5}','${I.n5}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',40,'${I.rule}',1,15,6,'applied','${I.e4}'),
      ('${I.e6}','${I.n6}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',50,NULL,NULL,NULL,NULL,'ambiguous_rule',NULL),
      ('${I.e7}','${I.n7}','${I.property}','${I.booking}','2026-08-10','airbnb','EUR',100,'${I.zeroRule}',1,0,0,'applied',NULL),
      ('${I.e8}','${I.n8}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',40,'${I.rule}',1,15,6,'applied',NULL),
      ('${I.e9}','${I.n9}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',-10,'${I.rule}',1,15,-1.5,'applied','${I.e8}'),
      ('${I.e10}','${I.n10}','${I.property}','${I.usdBooking}','2026-08-10','booking_com','USD',100,'${I.rule}',1,15,15,'applied',NULL),
      ('${I.e11}','${I.n11}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',20,'${I.rule}',1,15,3,'applied',NULL),
      ('${I.e12}','${I.n12}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',80,'${I.rule}',1,15,12,'applied','${I.e3}')`);
  });
  afterAll(async()=>{await projection.close();await cleanup();await admin.end();});
  it("projects immutable economics and preserves missing, zero, correction, reversal, and lineage outcomes",async()=>{
    await admin.query("DELETE FROM finance.expense_categories WHERE id=$1",[I.category]);
    await expect(projection.project(command(I.e4,I.c4))).resolves.toMatchObject({ok:true,outcome:"missing_evidence",code:"ota_commission_missing_gross"});
    await admin.query("INSERT INTO finance.expense_categories(id,property_id,system_key,name,color,archived_at) VALUES($1,$2,'ota_commission','OTA','#111111',now())",[I.category,I.property]);
    await expect(projection.project(command(I.e6,I.c6))).resolves.toMatchObject({ok:true,outcome:"missing_evidence",code:"ota_commission_ambiguous_rule"});
    await expect(projection.project(command(I.e7,I.c7))).resolves.toMatchObject({ok:true,outcome:"ineligible",reason:"non_positive"});
    await admin.query("UPDATE finance.expense_categories SET archived_at=NULL WHERE id=$1",[I.category]);
    await admin.query("UPDATE finance.commission_rules SET percentage_rate=99 WHERE id=$1",[I.rule]);
    await expect(projection.project(command(I.e3,I.c3))).resolves.toMatchObject({ok:false,code:"predecessor_not_projected"});
    expect((await admin.query("SELECT count(*)::int AS count FROM finance.expenses WHERE id=$1",[I.c3])).rows[0]).toEqual({count:0});
    const original=command(I.e1,I.c1);await expect(projection.project(original)).resolves.toMatchObject({ok:true,outcome:"created",expenseId:I.c1});await expect(projection.project(original)).resolves.toMatchObject({ok:true,outcome:"replayed"});
    await expect(projection.project(command(I.e2,I.c2))).resolves.toMatchObject({ok:true,outcome:"missing_evidence"});
    await expect(projection.project(command(I.e3,I.c3))).resolves.toMatchObject({ok:true,outcome:"reversed",expenseId:I.c3});
    await expect(projection.project(command(I.e12,I.c10))).resolves.toMatchObject({ok:true,outcome:"created",expenseId:I.c10});
    await expect(projection.project(command(I.e5,I.c5))).resolves.toMatchObject({ok:true,outcome:"created",expenseId:I.c5});
    await expect(projection.project(command(I.e10,I.c8))).resolves.toMatchObject({ok:false,code:"currency_mismatch"});
    await expect(projection.project({...command(I.e1,I.c8),propertyId:I.otherProperty})).resolves.toMatchObject({ok:false,code:"evidence_mismatch"});
    const rows=await admin.query(`SELECT id::text,entry_kind AS kind,incurred_on::text AS incurred,amount::text,source_key AS source,reverses_expense_id::text AS reverses,guest_booking_id::text AS booking FROM finance.expenses WHERE property_id=$1 ORDER BY created_at,id`,[I.property]);
    expect(rows.rows).toEqual([
      {id:I.c1,kind:"expense",incurred:"2026-08-10",amount:"15.0000",source:`ota_commission_evidence:${I.e1}`,reverses:null,booking:I.booking},
      {id:I.c3,kind:"reversal",incurred:"2026-08-12",amount:"15.0000",source:`ota_commission_evidence:${I.e3}:reverse:${I.c1}`,reverses:I.c1,booking:null},
      {id:I.c10,kind:"expense",incurred:"2026-08-10",amount:"12.0000",source:`ota_commission_evidence:${I.e12}`,reverses:null,booking:I.booking},
      {id:I.c5,kind:"expense",incurred:"2026-08-10",amount:"6.0000",source:`ota_commission_evidence:${I.e5}`,reverses:null,booking:I.booking},
    ]);
  });
  it("rejects an out-of-order correction, then serializes base replay and applies the correction",async()=>{
    await expect(projection.project(command(I.e9,I.c9))).resolves.toMatchObject({ok:false,code:"predecessor_not_projected"});
    const input=command(I.e8,I.c8),results=await Promise.all([projection.project(input),projection.project(input)]);
    expect(results.map((value)=>value.ok&&value.outcome).sort()).toEqual(["created","replayed"]);
    await expect(projection.project(command(I.e9,I.c9))).resolves.toMatchObject({ok:true,outcome:"corrected",expenseId:I.c9});
  });
  it("rolls back the ledger and idempotency key when late audit persistence fails",async()=>{
    const input=command(I.e11,I.c7),generated=parseFinanceGeneratedExpenseCommand({commandId:I.c7,propertyId:I.property,categoryId:I.category,origin:"ota_commission",action:"create",incurredOn:"2026-08-10",vendor:"Booking.com",description:null,amount:{amount:"3",currency:"EUR"},paymentStatus:"unpaid",paidOn:null,reversesExpenseId:null,source:{kind:"ota_commission",commissionEvidenceId:I.e11,guestBookingId:I.booking,serviceNight:"2026-08-10"},audit:{...input.audit,reasonCode:"scheduled_generation"}})!;
    const keyHash=createHash("sha256").update(financeGeneratedExpenseJobKey(generated)).digest("hex");
    await admin.query(`INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,retention_class,privacy_scope) VALUES($1,'finance','collision',now(),'property',$2,'system','finance','expense',$3,'financial','confidential')`,[`finance.generated_expense.execute.property.${I.property}.expense.${I.c7}.key.${keyHash}.v1`,I.property,I.c7]);
    await expect(projection.project(input)).rejects.toMatchObject({code:"23505"});
    const residue=await admin.query(`SELECT (SELECT count(*)::int FROM finance.expenses WHERE id=$1) expenses,(SELECT count(*)::int FROM platform.idempotency_keys WHERE key_hash=$2) keys`,[I.c7,keyHash]);expect(residue.rows[0]).toEqual({expenses:0,keys:0});
  });
  it("composes inside and rolls back with a caller-owned transaction",async()=>{
    const pool=new pg.Pool({connectionString:URL}),client=await pool.connect();
    try{await client.query("BEGIN");await expect(projectFinanceOtaCommissionExpense(client,command(I.e11,I.c6),()=>new Date(NOW))).resolves.toMatchObject({ok:true,outcome:"created"});await client.query("ROLLBACK");const residue=await admin.query(`SELECT (SELECT count(*)::int FROM finance.expenses WHERE id=$1::uuid) expenses,(SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$2::uuid AND idempotency_metadata->>'expenseId'=$1::text) keys,(SELECT count(*)::int FROM platform.product_audit_events WHERE target_resource_id=$1::text) audits`,[I.c6,I.property]);expect(residue.rows[0]).toEqual({expenses:0,keys:0,audits:0});}
    finally{client.release();await pool.end();}
  });
  async function cleanup(){await admin.query(`BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM platform.product_audit_events WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM platform.idempotency_keys WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.expenses WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.ota_commission_evidence WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM booking.nightly_revenue_evidence WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.commission_rules WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.expense_categories WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM booking.guest_bookings WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM hotel_catalog.properties WHERE id IN ('${I.property}','${I.otherProperty}');COMMIT`);}
});
// prettier-ignore
function command(evidenceId:string,commandId:string):FinanceOtaCommissionExpenseProjectionCommand{return {commandId,propertyId:I.property,commissionEvidenceId:evidenceId,audit:{actor:{kind:"system",service:"finance-expense-automation"},requestId:`request-${commandId}`,correlationId:`correlation-${commandId}`,causationId:crypto.randomUUID(),jobId:crypto.randomUUID(),jobAttemptId:crypto.randomUUID(),requestedAt:NOW}};}
