import { createHash } from "node:crypto";
import {
  financeGeneratedExpenseJobKey,
  parseFinanceGeneratedExpenseCommand,
  type FinanceGeneratedExpenseCommand,
} from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendFinanceGeneratedExpense,
  createPgFinanceGeneratedExpenseRepository,
} from "./financeGeneratedExpenseRepository.js";

const URL = process.env["TEST_DATABASE_URL"],
  id = (n: number) => `12310000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// prettier-ignore
const I={property:id(1),otherProperty:id(2),category:id(3),otherCategory:id(4),otaCategory:id(5),otherOtaCategory:id(6),feeCategory:id(7),otherFeeCategory:id(8),rule:id(9),otherRule:id(10),booking:id(11),commissionRule:id(12),night1:id(13),night2:id(14),night3:id(15),night4:id(16),evidence1:id(17),evidence2:id(18),evidence3:id(19),evidence4:id(20),payment:id(21),otherPayment:id(22),account:id(23),otherAccount:id(24),feeEvidence:id(25),feeCorrection:id(26),feeReversal:id(27),missingPayment:id(28),missingEvidence:id(29),zeroPayment:id(31),zeroEvidence:id(32),night5:id(33),night6:id(34),night7:id(35),evidence5:id(36),evidence6:id(37),evidence7:id(38),lateFeeEvidence:id(39),feeSkippedZero:id(40),feeAfterZero:id(41),feeRestart:id(42)} as const;
const NOW = "2026-08-11T12:00:00.000Z";

// prettier-ignore
describe.skipIf(!URL)("PostgreSQL generated expense repository",()=>{
  const admin=new pg.Client({connectionString:URL??"postgresql://disabled"});
  const repository=createPgFinanceGeneratedExpenseRepository(URL??"postgresql://disabled",()=>new Date(NOW));
  beforeAll(async()=>{
    if(!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL!).pathname))throw new Error("Refusing non-test database");
    await admin.connect();await cleanup();
    await admin.query(`INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
      ('${I.property}','generated-expense','Generated expense'),('${I.otherProperty}','generated-expense-other','Other');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES ('${I.property}','EUR'),('${I.otherProperty}','USD');
      INSERT INTO finance.expense_categories(id,property_id,system_key,name,color) VALUES
      ('${I.category}','${I.property}',NULL,'Utilities','#123456'),('${I.otherCategory}','${I.otherProperty}',NULL,'Other','#654321'),
      ('${I.otaCategory}','${I.property}','ota_commission','OTA','#111111'),('${I.otherOtaCategory}','${I.otherProperty}','ota_commission','Other OTA','#111112'),
      ('${I.feeCategory}','${I.property}','platform_fees','Fees','#222222'),('${I.otherFeeCategory}','${I.otherProperty}','platform_fees','Other fees','#222223');
      INSERT INTO finance.recurring_expense_rules(id,property_id,category_id,cadence,starts_on,next_due_on,vendor,description,amount,currency,payment_status) VALUES
      ('${I.rule}','${I.property}','${I.category}','weekly','2026-08-01','2026-08-10','Utilities','Monthly utilities',10,'EUR','unpaid'),
      ('${I.otherRule}','${I.otherProperty}','${I.otherCategory}','weekly','2026-08-01','2026-08-10','Other','Other',10,'USD','unpaid');
      INSERT INTO booking.guest_bookings(id,property_id,public_reference,lifecycle_status,check_in,check_out,currency) VALUES ('${I.booking}','${I.property}','generated-booking','completed','2026-08-10','2026-08-13','EUR');
      INSERT INTO finance.commission_rules(id,property_id,rule_scope,product,commission_type,percentage_rate,starts_at,source_system,ota_channel) VALUES ('${I.commissionRule}','${I.property}','property','pms','percentage',15,'2026-01-01','finance','booking_com');
      INSERT INTO booking.nightly_revenue_room_scopes(property_id,room_type_id) VALUES ('${I.property}','${id(30)}');
      INSERT INTO booking.nightly_revenue_evidence(id,property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,line_position,corrects_evidence_id,command_key) VALUES
      ('${I.night1}','${I.property}','${I.booking}','${id(30)}','2026-08-10','2026-08-10','EUR',100,1,'room_night','completed','ota','exact',1,1,NULL,'generated-1'),
      ('${I.night2}','${I.property}','${I.booking}','${id(30)}','2026-08-10','2026-08-11','EUR',-20,0,'correction','corrected','ota','exact',2,1,'${I.night1}','generated-2'),
      ('${I.night3}','${I.property}','${I.booking}','${id(30)}','2026-08-10','2026-08-12','EUR',-80,0,'correction','corrected','ota','exact',3,1,'${I.night2}','generated-3'),
      ('${I.night4}','${I.property}','${I.booking}','${id(30)}','2026-08-10','2026-08-10','EUR',NULL,1,'room_night','completed','manual','missing',1,2,NULL,'generated-4'),
      ('${I.night5}','${I.property}','${I.booking}','${id(30)}','2026-08-11','2026-08-11','EUR',NULL,1,'room_night','completed','ota','missing',1,3,NULL,'generated-5'),('${I.night6}','${I.property}','${I.booking}','${id(30)}','2026-08-11','2026-08-12','EUR',80,0,'correction','corrected','ota','exact',2,3,'${I.night5}','generated-6'),('${I.night7}','${I.property}','${I.booking}','${id(30)}','2026-08-12','2026-08-13','EUR',100,0,'retained_charge','canceled','ota','exact',1,4,NULL,'generated-7');
      INSERT INTO finance.ota_commission_evidence(id,booking_revenue_evidence_id,property_id,guest_booking_id,service_night,channel,currency,gross_room_amount,commission_rule_id,commission_rule_revision,percentage_rate,commission_amount,evidence_state,corrects_commission_evidence_id) VALUES
      ('${I.evidence1}','${I.night1}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',100,'${I.commissionRule}',1,15,15,'applied',NULL),
      ('${I.evidence2}','${I.night2}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',-20,'${I.commissionRule}',1,15,-3,'applied','${I.evidence1}'),
      ('${I.evidence3}','${I.night3}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',-80,'${I.commissionRule}',1,15,-12,'applied','${I.evidence2}'),
      ('${I.evidence4}','${I.night4}','${I.property}','${I.booking}','2026-08-10','booking_com','EUR',NULL,'${I.commissionRule}',1,15,NULL,'missing_gross',NULL),
      ('${I.evidence5}','${I.night5}','${I.property}','${I.booking}','2026-08-11','booking_com','EUR',NULL,'${I.commissionRule}',1,15,NULL,'missing_gross',NULL),('${I.evidence6}','${I.night6}','${I.property}','${I.booking}','2026-08-11','booking_com','EUR',80,'${I.commissionRule}',1,15,12,'applied','${I.evidence5}'),('${I.evidence7}','${I.night7}','${I.property}','${I.booking}','2026-08-12','booking_com','EUR',100,'${I.commissionRule}',1,15,15,'applied',NULL);
      INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status) VALUES ('${I.account}','${I.property}','property','stripe','acct_generated','active'),('${I.otherAccount}','${I.otherProperty}','property','stripe','acct_generated_other','active');
      INSERT INTO finance.payments(id,property_id,provider_account_id,payment_kind,status,amount,fee_amount,net_amount,currency) VALUES ('${I.payment}','${I.property}','${I.account}','full','paid',100,3,97,'EUR'),('${I.missingPayment}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),('${I.zeroPayment}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),('${I.otherPayment}','${I.otherProperty}','${I.otherAccount}','full','paid',100,3,97,'USD');
      INSERT INTO finance.provider_fee_evidence(id,property_id,payment_id,provider_account_id,provider,settlement_revision,evidence_state,evidence_on,evidence_at,fee_amount,currency,source_revision,source_fingerprint_hash,property_timezone,property_timezone_revision,corrects_provider_fee_evidence_id) VALUES
      ('${I.feeEvidence}','${I.property}','${I.payment}','${I.account}','stripe',1,'applied','2026-08-10',now(),3,'EUR','fee:1',repeat('a',64),'Europe/Berlin','profile:1',NULL),('${I.feeCorrection}','${I.property}','${I.payment}','${I.account}','stripe',2,'correction','2026-08-11',now(),2.5,'EUR','fee:2',repeat('b',64),'Europe/Berlin','profile:1','${I.feeEvidence}'),('${I.feeReversal}','${I.property}','${I.payment}','${I.account}','stripe',3,'reversal','2026-08-12',now(),0,'EUR','fee:3',repeat('c',64),'Europe/Berlin','profile:1','${I.feeCorrection}'),('${I.missingEvidence}','${I.property}','${I.missingPayment}','${I.account}','stripe',1,'missing','2026-08-10',now(),NULL,'EUR','fee:missing',repeat('d',64),'Europe/Berlin','profile:1',NULL),('${I.zeroEvidence}','${I.property}','${I.zeroPayment}','${I.account}','stripe',1,'proven_zero','2026-08-10',now(),0,'EUR','fee:zero',repeat('e',64),'Europe/Berlin','profile:1',NULL),('${I.lateFeeEvidence}','${I.property}','${I.missingPayment}','${I.account}','stripe',2,'correction','2026-08-11',now(),2,'EUR','fee:late',repeat('f',64),'Europe/Berlin','profile:1','${I.missingEvidence}'),('${I.feeSkippedZero}','${I.property}','${I.missingPayment}','${I.account}','stripe',3,'correction','2026-08-12',now(),0,'EUR','fee:skip',repeat('1',64),'Europe/Berlin','profile:1','${I.lateFeeEvidence}'),('${I.feeAfterZero}','${I.property}','${I.missingPayment}','${I.account}','stripe',4,'correction','2026-08-13',now(),1.5,'EUR','fee:after',repeat('2',64),'Europe/Berlin','profile:1','${I.feeSkippedZero}'),('${I.feeRestart}','${I.property}','${I.payment}','${I.account}','stripe',4,'correction','2026-08-13',now(),1.25,'EUR','fee:restart',repeat('3',64),'Europe/Berlin','profile:1','${I.feeReversal}')`);
  });
  afterAll(async()=>{await repository.close();await cleanup();await admin.end();});

  it("creates, replays, races, corrects, reverses, and preserves immutable recurring economics",async()=>{
    const first=recurring("2026-08-10");
    await expect(repository.execute(first)).resolves.toMatchObject({ok:true,outcome:"created",expenseId:first.commandId});
    await expect(repository.execute(first)).resolves.toMatchObject({ok:true,outcome:"replayed"});
    await expect(repository.execute({...first,commandId:crypto.randomUUID()})).resolves.toMatchObject({ok:false,code:"source_conflict"});
    const concurrent=recurring("2026-08-11"),race=await Promise.all([repository.execute(concurrent),repository.execute(concurrent)]);
    expect(race.map(value=>value.ok&&value.outcome).sort()).toEqual(["created","replayed"]);
    await expect(repository.execute({...recurring("2026-08-12"),source:{kind:"recurring",recurringRuleId:I.otherRule,ruleRevision:1,occurrenceOn:"2026-08-12"}} as never)).resolves.toMatchObject({ok:false,code:"evidence_mismatch"});
    await expect(repository.execute({...recurring("2026-08-12"),amount:{amount:"10.0000",currency:"USD"}} as never)).resolves.toMatchObject({ok:false,code:"currency_mismatch"});
    const original=ota(I.evidence1,"create",null,"15.0000","2026-08-10"),correction=ota(I.evidence2,"correct",original.commandId,"12.0000","2026-08-11"),reversal=ota(I.evidence3,"reverse",correction.commandId,"12.0000","2026-08-12");
    await expect(repository.execute(ota(I.evidence4,"create",null,"1.0000","2026-08-10"))).resolves.toMatchObject({ok:false,code:"evidence_mismatch"});
    await expect(repository.execute(ota(I.evidence6,"create",null,"12.0000","2026-08-11","2026-08-11"))).resolves.toMatchObject({ok:true,outcome:"created"});await expect(repository.execute(ota(I.evidence7,"create",null,"15.0000","2026-08-12","2026-08-12"))).resolves.toMatchObject({ok:true,outcome:"created"});
    await expect(repository.execute(original)).resolves.toMatchObject({ok:true,outcome:"created"});
    await expect(repository.execute(correction)).resolves.toMatchObject({ok:true,outcome:"corrected"});
    await expect(repository.execute({...correction,commandId:crypto.randomUUID(),propertyId:I.otherProperty,categoryId:I.otherOtaCategory,amount:{amount:"12.0000",currency:"USD"}} as never)).resolves.toMatchObject({ok:false,code:"correction_conflict"});
    await expect(repository.execute(reversal)).resolves.toMatchObject({ok:true,outcome:"reversed"});
    const history=recurring("2026-08-20");await expect(repository.execute(history)).resolves.toMatchObject({ok:true,outcome:"created"});
    await admin.query("UPDATE finance.recurring_expense_rules SET amount=99,revision=2 WHERE id=$1",[I.rule]);
    await expect(repository.execute(reverseRecurring(history,2,"99.0000"))).resolves.toMatchObject({ok:false,code:"evidence_mismatch"});
    await expect(repository.execute(reverseRecurring(history,1,"10.0000"))).resolves.toMatchObject({ok:true,outcome:"reversed"});
    const fee=platformFee(I.feeEvidence,I.payment,I.property,I.feeCategory,"EUR","create",null,"3.0000","2026-08-10"),feeCorrection=platformFee(I.feeCorrection,I.payment,I.property,I.feeCategory,"EUR","correct",fee.commandId,"2.5000","2026-08-11"),feeReversal=platformFee(I.feeReversal,I.payment,I.property,I.feeCategory,"EUR","reverse",feeCorrection.commandId,"2.5000","2026-08-12");
    await expect(repository.execute(fee)).resolves.toMatchObject({ok:true,outcome:"created"});await expect(repository.execute(fee)).resolves.toMatchObject({ok:true,outcome:"replayed"});
    await expect(repository.execute({...feeCorrection,incurredOn:"2026-08-13"})).resolves.toMatchObject({ok:false,code:"evidence_mismatch"});
    await expect(repository.execute(feeCorrection)).resolves.toMatchObject({ok:true,outcome:"corrected"});await expect(repository.execute(feeReversal)).resolves.toMatchObject({ok:true,outcome:"reversed"});await expect(repository.execute(platformFee(I.feeRestart,I.payment,I.property,I.feeCategory,"EUR","create",null,"1.2500","2026-08-13"))).resolves.toMatchObject({ok:true,outcome:"created"});
    await expect(repository.execute(platformFee(I.missingEvidence,I.missingPayment,I.property,I.feeCategory,"EUR","create",null,"1.0000","2026-08-10"))).resolves.toMatchObject({ok:true,outcome:"missing_evidence",code:"provider_fee_missing"});
    await expect(repository.execute(platformFee(I.zeroEvidence,I.zeroPayment,I.property,I.feeCategory,"EUR","create",null,"1.0000","2026-08-10"))).resolves.toMatchObject({ok:true,outcome:"ineligible",reason:"known_zero"});
    const lateFee=platformFee(I.lateFeeEvidence,I.missingPayment,I.property,I.feeCategory,"EUR","create",null,"2.0000","2026-08-11");await expect(repository.execute(lateFee)).resolves.toMatchObject({ok:true,outcome:"created"});await expect(repository.execute(platformFee(I.feeAfterZero,I.missingPayment,I.property,I.feeCategory,"EUR","correct",lateFee.commandId,"1.5000","2026-08-13"))).resolves.toMatchObject({ok:true,outcome:"corrected"});
    await expect(repository.execute(platformFee(I.feeEvidence,I.otherPayment,I.otherProperty,I.otherFeeCategory,"USD","create",null,"3.0000","2026-08-10"))).resolves.toMatchObject({ok:false,code:"evidence_mismatch"});
    const evidence=await admin.query(`SELECT (SELECT count(*)::int FROM finance.expenses WHERE property_id=$1) expenses,(SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1 AND operation=$2) keys,(SELECT count(*)::int FROM platform.product_audit_events WHERE property_id=$1 AND action=$2) audits,(SELECT redacted_payload->>'jobId' FROM platform.product_audit_events WHERE target_resource_id=$3) job,(SELECT causation_id FROM platform.product_audit_events WHERE target_resource_id=$3) causation`,[I.property,"finance.generated_expense.execute",first.commandId]);
    expect(evidence.rows[0]).toMatchObject({expenses:15,keys:15,audits:15,job:first.audit.jobId,causation:first.audit.causationId});
  });

  it("restores a caller-owned transaction before returning a typed database failure",async()=>{
    const pool=new pg.Pool({connectionString:URL}),client=await pool.connect();await admin.query("BEGIN");await admin.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE",[I.property]);
    try{await client.query("BEGIN");await client.query("SET LOCAL lock_timeout='50ms'");await expect(appendFinanceGeneratedExpense(client,recurring("2026-08-25",2,"99.0000"))).resolves.toMatchObject({ok:false,code:"write_unavailable"});await expect(client.query("SELECT 1 AS ok")).resolves.toMatchObject({rows:[{ok:1}]});await client.query("ROLLBACK");}
    finally{await admin.query("ROLLBACK");client.release();await pool.end();}
  });

  it("rolls back ledger and idempotency when late audit persistence fails",async()=>{
    const input=recurring("2026-08-26",2,"99.0000"),keyHash=hash(financeGeneratedExpenseJobKey(input));
    await admin.query(`INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,retention_class,privacy_scope) VALUES($1,'finance','collision',now(),'property',$2,'system','finance','expense',$3,'financial','confidential')`,[`finance.generated_expense.execute.property.${I.property}.expense.${input.commandId}.key.${keyHash}.v1`,I.property,input.commandId]);
    await expect(repository.execute(input)).rejects.toMatchObject({code:"23505"});
    const residue=await admin.query(`SELECT (SELECT count(*)::int FROM finance.expenses WHERE id=$1) expenses,(SELECT count(*)::int FROM platform.idempotency_keys WHERE key_hash=$2) keys`,[input.commandId,keyHash]);expect(residue.rows[0]).toEqual({expenses:0,keys:0});
  });

  async function cleanup(){await admin.query(`BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM platform.product_audit_events WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM platform.idempotency_keys WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.expenses WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.provider_fee_evidence WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.ota_commission_evidence WHERE property_id='${I.property}';DELETE FROM booking.nightly_revenue_evidence WHERE property_id='${I.property}';DELETE FROM booking.nightly_revenue_room_scopes WHERE property_id='${I.property}';DELETE FROM finance.commission_rules WHERE property_id='${I.property}';DELETE FROM finance.payments WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.payment_provider_accounts WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.recurring_expense_rules WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM finance.expense_categories WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM booking.guest_bookings WHERE property_id='${I.property}';DELETE FROM pms.property_pricing_settings WHERE property_id IN ('${I.property}','${I.otherProperty}');DELETE FROM hotel_catalog.properties WHERE id IN ('${I.property}','${I.otherProperty}');COMMIT`);}
});

// prettier-ignore
function audit(action:"create"|"correct"|"reverse"){return {actor:{kind:"system" as const,service:"finance-expense-automation" as const},requestId:`request-${crypto.randomUUID()}`,correlationId:`correlation-${crypto.randomUUID()}`,causationId:crypto.randomUUID(),jobId:crypto.randomUUID(),jobAttemptId:crypto.randomUUID(),reasonCode:action==="create"?"scheduled_generation" as const:action==="correct"?"source_correction" as const:"source_reversal" as const,requestedAt:NOW};}
// prettier-ignore
function recurring(occurrenceOn:string,ruleRevision=1,amount="10.0000"):FinanceGeneratedExpenseCommand{return parseFinanceGeneratedExpenseCommand({commandId:crypto.randomUUID(),propertyId:I.property,categoryId:I.category,origin:"recurring",action:"create",incurredOn:occurrenceOn,vendor:"Utilities",description:"Monthly utilities",amount:{amount,currency:"EUR"},paymentStatus:"unpaid",paidOn:null,reversesExpenseId:null,source:{kind:"recurring",recurringRuleId:I.rule,ruleRevision,occurrenceOn},audit:audit("create")})!;}
// prettier-ignore
function reverseRecurring(prior:FinanceGeneratedExpenseCommand,ruleRevision:number,amount:string):FinanceGeneratedExpenseCommand{return parseFinanceGeneratedExpenseCommand({...prior,commandId:crypto.randomUUID(),action:"reverse",incurredOn:"2026-08-21",amount:{amount,currency:"EUR"},reversesExpenseId:prior.commandId,source:{...prior.source,ruleRevision},audit:audit("reverse")})!;}
// prettier-ignore
function ota(evidenceId:string,action:"create"|"correct"|"reverse",reversesExpenseId:string|null,amount:string,incurredOn:string,serviceNight="2026-08-10"):FinanceGeneratedExpenseCommand{return parseFinanceGeneratedExpenseCommand({commandId:crypto.randomUUID(),propertyId:I.property,categoryId:I.otaCategory,origin:"ota_commission",action,incurredOn,vendor:"Booking.com",description:null,amount:{amount,currency:"EUR"},paymentStatus:"unpaid",paidOn:null,reversesExpenseId,source:{kind:"ota_commission",commissionEvidenceId:evidenceId,guestBookingId:I.booking,serviceNight},audit:audit(action)})!;}
// prettier-ignore
function platformFee(providerFeeEvidenceId:string,paymentId:string,propertyId:string,categoryId:string,currency:string,action:"create"|"correct"|"reverse",reversesExpenseId:string|null,amount:string,evidenceOn:string):FinanceGeneratedExpenseCommand{return parseFinanceGeneratedExpenseCommand({commandId:crypto.randomUUID(),propertyId,categoryId,origin:"platform_fee",action,incurredOn:evidenceOn,vendor:"Payment provider",description:null,amount:{amount,currency},paymentStatus:"paid",paidOn:"2026-08-10",reversesExpenseId,source:{kind:"platform_fee",providerFeeEvidenceId,paymentId,evidenceOn},audit:audit(action)})!;}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
