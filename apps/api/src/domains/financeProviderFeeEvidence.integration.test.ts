import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendFinanceProviderFeeEvidence,
  FinanceProviderFeeEvidenceError,
  readFinanceProviderFeeEvidence,
  type AppendFinanceProviderFeeEvidence,
  type FinanceProviderFeeClient,
} from "./financeProviderFeeEvidence.js";

// prettier-ignore
const URL=process.env["TEST_DATABASE_URL"],id=(n:number)=>`12340000-0000-4000-8000-${String(n).padStart(12,"0")}`;
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");
// prettier-ignore
const I={property:id(1),otherProperty:id(2),account:id(3),otherAccount:id(4),payment:id(5),zero:id(6),missing:id(7),rollback:id(8),race:id(9),fork:id(10)};

// prettier-ignore
describe.skipIf(!URL)("PostgreSQL Finance provider fee evidence",()=>{
  const client=new pg.Client({connectionString:URL??"postgresql://disabled"});
  beforeAll(async()=>{await client.connect();await cleanup();await client.query(`
    INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
      ('${I.property}','fee-evidence','Fee evidence'),('${I.otherProperty}','fee-other','Other');
    INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES
      ('${I.property}','Europe/Berlin'),('${I.otherProperty}','Europe/Vienna');
    INSERT INTO finance.payment_provider_accounts(id,property_id,account_scope,provider,provider_account_id,status) VALUES
      ('${I.account}','${I.property}','property','stripe','acct_fee','active'),
      ('${I.otherAccount}','${I.otherProperty}','property','stripe','acct_other','active');
    INSERT INTO finance.payments(id,property_id,provider_account_id,payment_kind,status,amount,fee_amount,net_amount,currency) VALUES
      ('${I.payment}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),
      ('${I.zero}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),
      ('${I.missing}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),
      ('${I.rollback}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),
      ('${I.race}','${I.property}','${I.account}','full','paid',100,0,100,'EUR'),
      ('${I.fork}','${I.property}','${I.account}','full','paid',100,0,100,'EUR')`)});
  afterAll(async()=>{await cleanup();await client.end()});

  it("keeps upgraded zero defaults missing and snapshots property-local evidence",async()=>{
    await expect(readFinanceProviderFeeEvidence(client,{propertyId:I.property,paymentId:I.zero})).resolves.toEqual({outcome:"missing",code:"provider_fee_missing"});
    await expect(appendFinanceProviderFeeEvidence(client,input(I.missing,"missing",null,1,"unlocked"))).rejects.toMatchObject({code:"transaction_required"});
    const applied=await write(input(I.payment,"applied","3.2500",1,"settlement:1"));
    expect(applied).toMatchObject({outcome:"captured",evidence:{provider:"stripe",state:"applied",evidenceOn:"2026-08-12",propertyTimezone:"Europe/Berlin",propertyTimezoneRevision:"profile:1",feeAmount:"3.2500"}});
    await expect(write(input(I.payment,"applied","3.2500",1,"settlement:1"))).resolves.toMatchObject({outcome:"replayed",evidence:{evidenceId:applied.evidence.evidenceId}});
    await expect(write(input(I.payment,"applied","4.0000",1,"settlement:1"))).rejects.toMatchObject({code:"replay_conflict"});
    await client.query("UPDATE hotel_catalog.property_locations SET timezone=NULL WHERE property_id=$1",[I.property]);
    await expect(write(input(I.zero,"proven_zero","0.0000",1,"no-timezone"))).rejects.toMatchObject({code:"scope_unavailable"});
    await client.query("UPDATE hotel_catalog.properties SET profile_revision=2 WHERE id=$1",[I.property]);
    await client.query("UPDATE hotel_catalog.property_locations SET timezone='Europe/Vienna' WHERE property_id=$1",[I.property]);
    const zero=await write(input(I.zero,"proven_zero","0.0000",1,"settlement:zero"));expect(zero.evidence).toMatchObject({state:"proven_zero",propertyTimezone:"Europe/Vienna",propertyTimezoneRevision:"profile:2"});
    const missing=await write(input(I.missing,"missing",null,1,"settlement:missing"));expect(missing.evidence.state).toBe("missing");
    const pool=new pg.Pool({connectionString:URL}),race=await Promise.all([pooled(pool,input(I.race,"applied","1.0000",1,"race:1")),pooled(pool,input(I.race,"applied","1.0000",1,"race:1"))]);
    expect(race.map(result=>result.outcome).sort()).toEqual(["captured","replayed"]);
    const fork=await Promise.allSettled([pooled(pool,input(I.fork,"applied","1.0000",1,"race:one")),pooled(pool,input(I.fork,"applied","2.0000",2,"race:two"))]);await pool.end();
    expect(fork.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(fork.filter(result=>result.status==="rejected")).toHaveLength(1);
    await expect(readFinanceProviderFeeEvidence(client,{propertyId:I.property,paymentId:I.payment,evidenceId:applied.evidence.evidenceId})).resolves.toMatchObject({outcome:"found",evidence:{feeAmount:"3.2500"}});
  });

  it("appends correction and reversal lineage and rejects cross-property evidence",async()=>{
    const original=await readFinanceProviderFeeEvidence(client,{propertyId:I.property,paymentId:I.payment});if(original.outcome!=="found")throw new Error("missing fixture evidence");
    const correction=await write({...input(I.payment,"correction","2.0000",2,"settlement:2"),correctsEvidenceId:original.evidence.evidenceId});
    const reversal=await write({...input(I.payment,"reversal","0.0000",3,"settlement:3"),correctsEvidenceId:correction.evidence.evidenceId});
    expect(reversal.evidence).toMatchObject({state:"reversal",correctsEvidenceId:correction.evidence.evidenceId});
    await expect(write({...input(I.payment,"applied","1.0000",4,"cross"),propertyId:I.otherProperty})).rejects.toBeInstanceOf(FinanceProviderFeeEvidenceError);
    expect((await client.query("SELECT count(*)::int count FROM finance.provider_fee_evidence WHERE property_id=$1",[I.otherProperty])).rows[0]).toEqual({count:0});
    await expect(client.query("UPDATE finance.provider_fee_evidence SET fee_amount=99 WHERE id=$1",[original.evidence.evidenceId])).rejects.toMatchObject({code:"55000"});
    const columns=(await client.query("SELECT * FROM finance.provider_fee_reporting_evidence LIMIT 0")).fields.map(field=>field.name);expect(columns).not.toEqual(expect.arrayContaining(["source_fingerprint_hash","provider_account_id","payment_metadata","processor_fee_breakdown"]));
  });

  it("rolls back appended evidence with its caller-owned settlement transaction",async()=>{
    await client.query("BEGIN");
    try{const first=await appendFinanceProviderFeeEvidence(client,input(I.rollback,"applied","1.0000",1,"rollback:1"));
      await expect(appendFinanceProviderFeeEvidence(client,{...input(I.rollback,"correction","2.0000",2,"rollback:2"),correctsEvidenceId:first.evidence.evidenceId,propertyId:I.otherProperty})).rejects.toMatchObject({code:"scope_unavailable"});}
    finally{await client.query("ROLLBACK")}
    expect((await client.query("SELECT count(*)::int count FROM finance.provider_fee_evidence WHERE payment_id=$1",[I.rollback])).rows[0]).toEqual({count:0});
  });

  async function cleanup(){await client.query(`BEGIN;SET LOCAL session_replication_role=replica;
    DELETE FROM finance.provider_fee_evidence WHERE property_id IN ('${I.property}','${I.otherProperty}');
    DELETE FROM finance.payments WHERE property_id IN ('${I.property}','${I.otherProperty}');
    DELETE FROM finance.payment_provider_accounts WHERE id IN ('${I.account}','${I.otherAccount}');
    DELETE FROM hotel_catalog.property_locations WHERE property_id IN ('${I.property}','${I.otherProperty}');
    DELETE FROM hotel_catalog.properties WHERE id IN ('${I.property}','${I.otherProperty}');COMMIT`)}
  async function write(value:AppendFinanceProviderFeeEvidence){return transaction(client,()=>appendFinanceProviderFeeEvidence(client,value))}
});

// prettier-ignore
function input(paymentId:string,state:AppendFinanceProviderFeeEvidence["state"],feeAmount:string|null,settlementRevision:number,sourceRevision:string):AppendFinanceProviderFeeEvidence{return {propertyId:I.property,paymentId,provider:"stripe",settlementRevision,state,evidenceAt:"2026-08-11T23:30:00.000Z",feeAmount,currency:"EUR",sourceRevision,correctsEvidenceId:null};}
// prettier-ignore
async function transaction<T>(client:FinanceProviderFeeClient,run:()=>Promise<T>){await client.query("BEGIN");try{const result=await run();await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK");throw error}}
async function pooled(pool: pg.Pool, value: AppendFinanceProviderFeeEvidence) {
  const client = await pool.connect();
  try {
    return await transaction(client, () => appendFinanceProviderFeeEvidence(client, value));
  } finally {
    client.release();
  }
}
