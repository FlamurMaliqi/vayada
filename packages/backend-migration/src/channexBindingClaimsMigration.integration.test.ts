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
describe.skipIf(!URL)("Channex binding claims 0128 upgrade",()=>{
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
      for(const file of await readdir(MIGRATIONS))if(/^\d{4}_/.test(file)&&Number(file.slice(0,4))<=127)await cp(join(MIGRATIONS,file),join(before,file));
      expect((await run()).failed).toBeNull();
      target=new pg.Client({connectionString:targetUrl.href});await target.connect();
      await target.query(`INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES ($1,'claim-a','Claim A'),($2,'claim-b','Claim B'),($3,'claim-c','Claim C'),($4,'claim-d','Claim D'),($5,'claim-e','Claim E'),($6,'claim-f','Claim F')`,PROPERTIES);
      await target.query(`INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id,connection_metadata) VALUES ($1,'channex','connected','first','{}'),($2,'channex','connected','second','{"migrationRunId":"vay1351-0123456789abcdef01234567"}')`,PROPERTIES.slice(0,2));
      await cp(join(MIGRATIONS,"0128_channex_binding_claims.sql"),join(before,"0128_channex_binding_claims.sql"));
      expect((await run()).applied).toEqual(["0128"]);
      expect((await target.query(`SELECT connection_status status,connection.external_property_id external,claim_state state,claim_source source FROM pms.channel_connections connection JOIN pms.channel_binding_claims claim USING(property_id,provider) ORDER BY property_id`)).rows).toEqual([
        {status:"disconnected",external:null,state:"historical",source:"migration"},
        {status:"connected",external:"second",state:"active",source:"migration"},
      ]);
      await expect(target.query(`INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id) VALUES ($1,'channex','connected','unproven')`,[PROPERTIES[2]])).rejects.toMatchObject({code:"23514",constraint:"chk_pms_channel_connections_active_binding_claim"});
      expect((await target.query(`SELECT count(*)::integer count FROM pms.channel_binding_claims WHERE external_property_id='unproven'`)).rows[0]).toEqual({count:0});
      await target.query(`INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id,connection_metadata) VALUES ($1,'channex','connected','retained','{"migrationRunId":"vay1351-123456789abcdef012345678"}')`,[PROPERTIES[2]]);
      await target.query("UPDATE pms.channel_connections SET external_property_id=NULL WHERE property_id=$1",[PROPERTIES[2]]);
      await expect(target.query(`INSERT INTO pms.channel_connections(property_id,provider,external_property_id,connection_metadata) VALUES ($1,'channex','retained','{"migrationRunId":"vay1351-23456789abcdef0123456789"}')`,[PROPERTIES[3]])).rejects.toMatchObject({code:"23505",constraint:"uq_pms_channel_binding_claims_provider_external"});

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
