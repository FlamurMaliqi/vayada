import { normalizeFinanceOtaCommissionRate } from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinanceOtaCommissionRuleRepository,
  type SetFinanceOtaCommissionRuleCommand,
} from "./financeOtaCommissionRuleRepository.js";

const URL = process.env["TEST_DATABASE_URL"];
const ACTOR = "12050000-0000-4000-8000-000000000001";
const PROPERTY_A = "12050000-0000-4000-8000-000000000002";
const PROPERTY_B = "12050000-0000-4000-8000-000000000003";
const JAN = "2026-01-01T00:00:00Z";
const FEB = "2026-02-01T00:00:00Z";
const MAR = "2026-03-01T00:00:00Z";
const RAW_RATE = "UPDATE finance.commission_rules SET percentage_rate=12.5 WHERE property_id=$1";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

describe.skipIf(!URL)("PostgreSQL Finance OTA commission repository", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" });
  const repository = createPgFinanceOtaCommissionRuleRepository(URL ?? "postgresql://disabled");

  beforeAll(async () => admin.connect());
  beforeEach(async () => {
    await cleanup();
    await admin.query(
      `INSERT INTO identity.users (id,email,name,status)
         VALUES ('${ACTOR}','ota@example.test','OTA','active');
       INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES
         ('${PROPERTY_A}','ota-a','OTA A'),('${PROPERTY_B}','ota-b','OTA B')`,
    );
  });
  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("keeps list and explicit resolution inside property scope", async () => {
    await repository.setRule(command("a", PROPERTY_A, "booking_com", "10"));
    await repository.setRule(command("b", PROPERTY_B, "airbnb", "12.5"));
    await admin.query(RAW_RATE, [PROPERTY_B]);
    await expect(repository.list(PROPERTY_A)).resolves.toMatchObject([
      { propertyId: PROPERTY_A, channel: "booking_com", percentageRate: "10.0000" },
    ]);
    await expect(resolve(PROPERTY_A, "airbnb")).resolves.toMatchObject({ status: "missing" });
    await expect(resolve(PROPERTY_B, "airbnb")).resolves.toMatchObject({ status: "applied" });
  });

  it("replays the same command, conflicts changed reuse, and audits old and new rules", async () => {
    const firstCommand = command("same", PROPERTY_A, "booking_com", "10");
    const first = await repository.setRule(firstCommand);
    firstCommand.commandId = "cmd-regenerated";
    await expect(repository.setRule(firstCommand)).resolves.toMatchObject({ status: "replayed" });
    await expect(
      repository.setRule(command("same", PROPERTY_A, "booking_com", "11")),
    ).resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    const second = await repository.setRule(command("next", PROPERTY_A, "booking_com", "15", MAR));
    const audit = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM platform.product_audit_events
       WHERE action='finance.ota_commission_rule.set' AND actor_user_id=$1 AND property_id=$2
         AND correlation_id='correlation-next' AND redacted_payload->>'commandId'='cmd-next'
         AND redacted_payload->>'channel'='booking_com'
         AND redacted_payload->'oldRule'->>'ruleId'=$3
         AND redacted_payload->'newRule'->>'ruleId'=$4 AND private_payload->>'reason'='test'
         AND audit_metadata @> '{"requestId":"request-next","requestedAt":"2026-01-01T00:00:00Z","actorOrganizationId":"org"}'`,
      [
        ACTOR,
        PROPERTY_A,
        first.status === "applied" ? first.rule.ruleId : "",
        second.status === "applied" ? second.rule.ruleId : "",
      ],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it("serializes concurrent versions and rolls back when audit persistence fails", async () => {
    await repository.setRule(command("base", PROPERTY_A, "booking_com", "10"));
    const results = await Promise.all([
      repository.setRule(command("left", PROPERTY_A, "booking_com", "20", MAR)),
      repository.setRule(command("right", PROPERTY_A, "booking_com", "25", MAR)),
    ]);
    expect(results).toContainEqual({ status: "conflict", reason: "revision_conflict" });
    await expect(repository.list(PROPERTY_A)).resolves.toMatchObject([
      { percentageRate: "10.0000", effectiveTo: "2026-03-01T00:00:00.000Z", revision: 1 },
      { effectiveTo: null, revision: 2 },
    ]);
    const invalidActor = command("rollback", PROPERTY_B, "agoda", "8", JAN, PROPERTY_B);
    await expect(repository.setRule(invalidActor)).rejects.toMatchObject({ code: "23503" });
    const rollback = await admin.query<{ rules: number; keys: number }>(
      `SELECT (SELECT count(*)::int FROM finance.commission_rules WHERE property_id=$1) AS rules,
              (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id=$1) AS keys`,
      [PROPERTY_B],
    );
    expect(rollback.rows[0]).toEqual({ rules: 0, keys: 0 });
    for (const effectiveFrom of ["2026-01-01T00:00:00", "2026-02-30T00:00:00Z"])
      await expect(
        repository.setRule({ ...command(effectiveFrom, PROPERTY_B, "agoda", "8"), effectiveFrom }),
      ).rejects.toThrow("contract validation");
  });

  function resolve(propertyId: string, channel: "booking_com" | "airbnb" | "agoda") {
    return repository.resolve({ propertyId, channel, effectiveAt: FEB });
  }

  async function cleanup() {
    await admin.query(
      `BEGIN; SET LOCAL session_replication_role = replica;
       DELETE FROM platform.product_audit_events WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM platform.idempotency_keys WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM finance.commission_rules WHERE property_id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM hotel_catalog.properties WHERE id IN ('${PROPERTY_A}','${PROPERTY_B}');
       DELETE FROM identity.users WHERE id='${ACTOR}'; COMMIT`,
    );
  }
});

function command(
  key: string,
  propertyId: string,
  channel: "booking_com" | "airbnb" | "agoda",
  value: string,
  effectiveFrom = JAN,
  actorUserId = ACTOR,
): SetFinanceOtaCommissionRuleCommand {
  return {
    commandId: `cmd-${key}`,
    idempotencyKey: key,
    propertyId,
    channel,
    percentageRate: normalizeFinanceOtaCommissionRate(value)!,
    effectiveFrom,
    expectedRevision: effectiveFrom === JAN ? 0 : 1,
    audit: {
      actor: { kind: "user", userId: actorUserId, organizationId: "org" },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      reason: "test",
      requestedAt: JAN,
    },
  };
}
