import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

// prettier-ignore
const URL = process.env["TEST_DATABASE_URL"], MIGRATIONS = join(import.meta.dirname, "../migrations"), DATABASE = "vayada_channex_claims_upgrade_test";
// prettier-ignore
const PROPERTIES = [1, 2, 3, 4, 5, 6].map(value => `13660000-0000-4000-8000-${value.toString().padStart(12, "0")}`);

// prettier-ignore
describe.skipIf(!URL)("Channex binding claims 0127 upgrade",()=>{
  it("backfills, retains, and serializes cross-target claims",async()=>{
    assertSafeTestDatabase(URL!);
    const admin=new pg.Client({connectionString:URL}),targetUrl=new globalThis.URL(URL!),before=await mkdtemp(join(tmpdir(),"vayada-1366-"));
    targetUrl.pathname=`/${DATABASE}`;
    const run=()=>runMigrations({connectionString:targetUrl.href,migrationsDir:before,environment:"local"});
    let target:pg.Client|undefined;
    await admin.connect();
    try{
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for(const file of await readdir(MIGRATIONS))if(/^\d{4}_/.test(file)&&Number(file.slice(0,4))<=126)await cp(join(MIGRATIONS,file),join(before,file));
      expect((await run()).failed).toBeNull();
      target=new pg.Client({connectionString:targetUrl.href});await target.connect();
      await target.query(`INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1,'claim-a','Claim A'),($2,'claim-b','Claim B'),($3,'claim-c','Claim C'),($4,'claim-d','Claim D'),($5,'claim-e','Claim E'),($6,'claim-f','Claim F')`,PROPERTIES);
      await target.query(`INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id,connection_metadata) VALUES ($1,'channex','connected','first','{}'),($2,'channex','connected','second','{"migrationRunId":"vay1351-0123456789abcdef01234567"}')`,PROPERTIES.slice(0,2));
      await cp(join(MIGRATIONS,"0127_channex_binding_claims.sql"),join(before,"0127_channex_binding_claims.sql"));
      expect((await run()).applied).toEqual(["0127"]);
      expect((await target.query(`SELECT connection_status status,claim_state state,claim_source source FROM pms.channel_connections JOIN pms.channel_binding_claims USING(property_id,provider) ORDER BY property_id`)).rows).toEqual([
        {status:"disconnected",state:"historical",source:"migration"},
        {status:"connected",state:"active",source:"migration"},
      ]);
      await target.query(`INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id) VALUES ($1,'channex','connected','retained')`,[PROPERTIES[2]]);
      expect((await target.query(`SELECT connection_status status,claim_state state FROM pms.channel_connections JOIN pms.channel_binding_claims USING(property_id,provider) WHERE property_id=$1`,[PROPERTIES[2]])).rows[0]).toEqual({status:"disconnected",state:"historical"});
      await target.query("UPDATE pms.channel_connections SET external_property_id=NULL WHERE property_id=$1",[PROPERTIES[2]]);
      await expect(target.query(`INSERT INTO pms.channel_connections(property_id,provider,external_property_id) VALUES ($1,'channex','retained')`,[PROPERTIES[3]])).rejects.toMatchObject({code:"23505",constraint:"uq_pms_channel_binding_claims_provider_external"});

      const contender=new pg.Client({connectionString:targetUrl.href});await contender.connect();
      try{
        await target.query("BEGIN");await contender.query("BEGIN");
        await target.query(`INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES ($1,'channex','concurrent','active','enable')`,[PROPERTIES[4]]);
        const rejected=contender.query(`INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES ($1,'channex','concurrent','active','enable')`,[PROPERTIES[5]]).catch((error:unknown)=>error);
        await target.query("COMMIT");
        await expect(rejected).resolves.toMatchObject({code:"23505",constraint:"uq_pms_channel_binding_claims_provider_external"});
        await contender.query("ROLLBACK");
      }finally{await contender.end()}
    }finally{
      if(target)await target.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);await admin.end();
      await rm(before,{recursive:true,force:true});
    }
  },30_000);
});
