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
    await expect(repository.list(PROPERTY_A)).resolves.toMatchObject([
      { propertyId: PROPERTY_A, channel: "booking_com", percentageRate: "10.0000" },
    ]);
    await expect(
      repository.resolve({ propertyId: PROPERTY_A, channel: "airbnb", effectiveAt: "2026-02-01" }),
    ).resolves.toMatchObject({ status: "missing", reason: "not_configured" });
    await expect(
      repository.resolve({ propertyId: PROPERTY_B, channel: "airbnb", effectiveAt: "2026-02-01" }),
    ).resolves.toMatchObject({ status: "applied", rule: { propertyId: PROPERTY_B } });
  });

  it("replays the same command, conflicts changed reuse, and audits old and new rules", async () => {
    const firstCommand = command("same", PROPERTY_A, "booking_com", "10");
    const first = await repository.setRule(firstCommand);
    firstCommand.commandId = "cmd-regenerated";
    await expect(repository.setRule(firstCommand)).resolves.toMatchObject({ status: "replayed" });
    await expect(
      repository.setRule(command("same", PROPERTY_A, "booking_com", "11")),
    ).resolves.toEqual({ status: "conflict", reason: "idempotency_key_reused" });
    const second = await repository.setRule(
      command("next", PROPERTY_A, "booking_com", "15", "2026-03-01"),
    );
    const audit = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM platform.product_audit_events
       WHERE action='finance.ota_commission_rule.set' AND actor_user_id=$1 AND property_id=$2
         AND correlation_id='correlation-next' AND redacted_payload->>'commandId'='cmd-next'
         AND redacted_payload->>'channel'='booking_com'
         AND redacted_payload->'oldRule'->>'ruleId'=$3
         AND redacted_payload->'newRule'->>'ruleId'=$4`,
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
      repository.setRule(command("left", PROPERTY_A, "booking_com", "20", "2026-03-01")),
      repository.setRule(command("right", PROPERTY_A, "booking_com", "25", "2026-03-01")),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["applied", "conflict"]);
    await expect(repository.list(PROPERTY_A)).resolves.toMatchObject([
      { percentageRate: "10.0000", effectiveTo: "2026-03-01T00:00:00.000Z", revision: 1 },
      { effectiveTo: null, revision: 2 },
    ]);
    const invalidActor = command("rollback", PROPERTY_B, "agoda", "8", "2026-01-01", PROPERTY_B);
    await expect(repository.setRule(invalidActor)).rejects.toMatchObject({ code: "23503" });
    await expect(repository.list(PROPERTY_B)).resolves.toEqual([]);
  });

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
  effectiveFrom = "2026-01-01",
  actorUserId = ACTOR,
): SetFinanceOtaCommissionRuleCommand {
  return {
    commandId: `cmd-${key}`,
    idempotencyKey: key,
    propertyId,
    channel,
    percentageRate: normalizeFinanceOtaCommissionRate(value)!,
    effectiveFrom,
    audit: {
      actor: { kind: "user", userId: actorUserId, organizationId: "org" },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      reason: "test",
      requestedAt: "2026-01-01T00:00:00Z",
    },
  };
}
