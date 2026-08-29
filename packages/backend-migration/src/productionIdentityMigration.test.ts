import { describe, expect, it } from "vitest";

import {
  runProductionIdentityTransaction,
  type ProductionIdentityMigrationServices,
} from "./productionIdentityMigration.js";
import {
  emptyProductionIdentityState,
  type ProductionIdentityPlan,
} from "./productionIdentityPlan.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production identity migration transaction", () => {
  it("rejects an invalid runtime mode before opening a transaction", async () => {
    const log: string[] = [];
    await expect(
      runProductionIdentityTransaction(
        new TransactionClient(log) as never,
        { sourceRunId: RUN, mode: "dryrun" } as never,
        services(log, plan()),
      ),
    ).rejects.toThrow("mode must be dry-run or apply");
    expect(log).toEqual([]);
  });

  it("always rolls a dry run back without invoking writers", async () => {
    const log: string[] = [];
    const client = new TransactionClient(log);

    const result = await runProductionIdentityTransaction(
      client as never,
      { sourceRunId: RUN, mode: "dry-run" },
      services(log, plan()),
    );

    expect(result.applied).toBe(false);
    expect(log).toEqual(["BEGIN", "snapshot", "target", "plan", "ROLLBACK"]);
  });

  it("rolls a blocked apply back before invoking writers", async () => {
    const log: string[] = [];
    const blocked = plan();
    blocked.blockers.push({ code: "STALE", source: "identity", sourceId: "x", message: "x" });

    const result = await runProductionIdentityTransaction(
      new TransactionClient(log) as never,
      { sourceRunId: RUN, mode: "apply" },
      services(log, blocked),
    );

    expect(result).toMatchObject({ applied: false, blockers: blocked.blockers });
    expect(log).toEqual(["BEGIN", "snapshot", "target", "plan", "ROLLBACK"]);
  });

  it("commits only after both writers and a matching post-write replan", async () => {
    const log: string[] = [];
    const expected = plan();

    const result = await runProductionIdentityTransaction(
      new TransactionClient(log) as never,
      { sourceRunId: RUN, mode: "apply" },
      services(log, expected),
    );

    expect(result).toMatchObject({ applied: true, checksum: expected.checksum });
    expect(log).toEqual([
      "BEGIN",
      "snapshot",
      "target",
      "plan",
      "core",
      "privacy-audit",
      "target",
      "plan",
      "COMMIT",
    ]);
  });

  it("rolls back when the stored target does not reproduce the plan", async () => {
    const log: string[] = [];
    const expected = plan();
    const mismatched = { ...expected, checksum: "b".repeat(64) };

    await expect(
      runProductionIdentityTransaction(
        new TransactionClient(log) as never,
        { sourceRunId: RUN, mode: "apply" },
        services(log, expected, mismatched),
      ),
    ).rejects.toThrow("Post-write identity verification does not match");
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(log).not.toContain("COMMIT");
  });
});

class TransactionClient {
  constructor(private readonly log: string[]) {}
  async query(sql: string): Promise<{ rows: never[] }> {
    this.log.push(sql.split(" ")[0]!);
    return { rows: [] };
  }
}

function services(
  log: string[],
  firstPlan: ProductionIdentityPlan,
  verifiedPlan = firstPlan,
): ProductionIdentityMigrationServices {
  let builds = 0;
  return {
    readSnapshot: async () => {
      log.push("snapshot");
      return [];
    },
    readTarget: async () => {
      log.push("target");
      return emptyProductionIdentityState();
    },
    buildPlan: () => {
      log.push("plan");
      return builds++ === 0 ? firstPlan : verifiedPlan;
    },
    writeCore: async () => {
      log.push("core");
    },
    writePrivacyAudit: async () => {
      log.push("privacy-audit");
    },
  };
}

function plan(): ProductionIdentityPlan {
  return {
    users: [],
    workosIdentities: [],
    organizations: [],
    memberships: [],
    resourceLinks: [],
    entitlements: [],
    userConsents: [],
    cookieConsents: [],
    consentHistory: [],
    gdprRequests: [],
    auditEvents: [],
    retiredAuthRows: {},
    blockers: [],
    counts: {
      users: 0,
      preservedNewerUsers: 0,
      organizations: 0,
      memberships: 0,
      resourceLinks: 0,
      entitlements: 0,
      workosIdentities: 0,
      userConsents: 0,
      cookieConsents: 0,
      consentHistory: 0,
      gdprRequests: 0,
      loginAuditEvents: 0,
      retiredAuthRows: 0,
    },
    checksum: "a".repeat(64),
  };
}
