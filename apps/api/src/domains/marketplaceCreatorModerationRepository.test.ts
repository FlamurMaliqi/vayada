import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { MarketplaceCreatorModerationCommand } from "@vayada/domain-marketplace";

import { executeMarketplaceCreatorModeration } from "./marketplaceCreatorModerationRepository.js";

const creatorProfileId = "14180000-0000-4000-8000-000000000001";

describe("marketplace creator moderation repository", () => {
  it("commits profile status, audit, and idempotency together", async () => {
    const fixture = pool({ profileStatus: "pending", profileComplete: true });

    const result = await executeMarketplaceCreatorModeration(fixture.pool, command());

    expect(result).toMatchObject({
      ok: true,
      response: { outcome: "transitioned", previousStatus: "pending", profileStatus: "active" },
    });
    expect(fixture.sql).toContain("BEGIN");
    expect(fixture.sql).toContain("COMMIT");
    expect(fixture.sql.some((sql) => sql.includes("UPDATE marketplace.creator_profiles"))).toBe(
      true,
    );
    expect(
      fixture.sql.some((sql) => sql.includes("INSERT INTO platform.product_audit_events")),
    ).toBe(true);
    expect(fixture.sql.some((sql) => sql.includes("UPDATE platform.idempotency_keys"))).toBe(true);
    const auditValues =
      fixture.values[fixture.sql.findIndex((sql) => sql.includes("product_audit_events"))];
    expect(auditValues?.map(String).join(" ")).toContain("Profile reviewed and approved.");
    expect(auditValues?.map(String).join(" ")).toContain('"previousStatus":"pending"');
  });

  it("rejects incomplete activation without mutating profile or evidence", async () => {
    const fixture = pool({ profileStatus: "pending", profileComplete: false });

    await expect(executeMarketplaceCreatorModeration(fixture.pool, command())).resolves.toEqual({
      ok: false,
      error: { code: "profile_incomplete", currentStatus: "pending" },
    });

    expect(fixture.sql.some((sql) => sql.includes("UPDATE marketplace.creator_profiles"))).toBe(
      false,
    );
    expect(fixture.sql.some((sql) => sql.includes("product_audit_events"))).toBe(false);
    expect(fixture.sql.some((sql) => sql.includes("INSERT INTO platform.idempotency_keys"))).toBe(
      false,
    );
  });

  it.each([
    ["stale expected status", "pending", "suspended", "profile_status_conflict"],
    ["forbidden transition", "active", "rejected", "invalid_profile_transition"],
  ] as const)(
    "rejects a %s without mutating profile or evidence",
    async (_case, expectedStatus, nextStatus, code) => {
      const fixture = pool({ profileStatus: "active", profileComplete: true });
      const input = command();

      await expect(
        executeMarketplaceCreatorModeration(fixture.pool, {
          ...input,
          idempotencyKey: `${expectedStatus}-${nextStatus}`,
          request: { ...input.request, expectedStatus, nextStatus },
        }),
      ).resolves.toEqual({ ok: false, error: { code, currentStatus: "active" } });

      expect(fixture.sql.some((sql) => sql.includes("UPDATE marketplace.creator_profiles"))).toBe(
        false,
      );
      expect(fixture.sql.some((sql) => sql.includes("product_audit_events"))).toBe(false);
      expect(fixture.sql.some((sql) => sql.includes("INSERT INTO platform.idempotency_keys"))).toBe(
        false,
      );
    },
  );

  it("records an already-applied status as an idempotent no-op without a transition audit", async () => {
    const fixture = pool({ profileStatus: "active", profileComplete: true });

    const result = await executeMarketplaceCreatorModeration(fixture.pool, command());

    expect(result).toMatchObject({ ok: true, response: { outcome: "unchanged" } });
    expect(fixture.sql.some((sql) => sql.includes("UPDATE marketplace.creator_profiles"))).toBe(
      false,
    );
    expect(fixture.sql.some((sql) => sql.includes("product_audit_events"))).toBe(false);
    expect(fixture.sql.some((sql) => sql.includes("INSERT INTO platform.idempotency_keys"))).toBe(
      true,
    );
  });

  it("replays the original response for the same idempotency key and request", async () => {
    const fixture = pool({ profileStatus: "pending", profileComplete: true });

    const first = await executeMarketplaceCreatorModeration(fixture.pool, command());
    const replay = await executeMarketplaceCreatorModeration(fixture.pool, command());

    expect(replay).toEqual(first);
    expect(fixture.sql.filter((sql) => sql.includes("product_audit_events"))).toHaveLength(1);
  });
});

function command(): MarketplaceCreatorModerationCommand {
  return {
    creatorProfileId,
    idempotencyKey: "moderate-pending-active",
    request: {
      expectedStatus: "pending",
      nextStatus: "active",
      reason: "Profile reviewed and approved.",
    },
    audit: {
      actorUserId: "f8011000-0000-0000-0000-000000000001",
      actorOrganizationId: "f8012000-0000-0000-0000-000000000001",
      requestId: "request-vay-1418",
      correlationId: "correlation-vay-1418",
      requestedAt: "2026-09-02T00:00:00.000Z",
    },
  };
}

function pool(profile: { profileStatus: "pending" | "active"; profileComplete: boolean }) {
  const sql: string[] = [];
  const values: Array<readonly unknown[] | undefined> = [];
  let currentProfile = { ...profile };
  let stored: { fingerprint: string; result: unknown } | undefined;
  const query = async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    queryValues?: readonly unknown[],
  ) => {
    sql.push(text);
    values.push(queryValues);
    let rows: unknown[] = [];
    if (text.includes("creator_profile_is_complete")) {
      rows = [{ organizationId: "f8012000-0000-0000-0000-000000000002", ...currentProfile }];
    } else if (text.includes("FROM platform.idempotency_keys")) {
      rows = stored
        ? [
            {
              status: "completed",
              requestFingerprintHash: stored.fingerprint,
              resultJson: stored.result,
            },
          ]
        : [];
    } else if (text.includes("INSERT INTO platform.idempotency_keys")) {
      rows = [{ id: "f8019000-0000-0000-0000-000000000001" }];
      stored = { fingerprint: String(queryValues?.[2]), result: null };
    } else if (text.includes("UPDATE marketplace.creator_profiles")) {
      currentProfile = { ...currentProfile, profileStatus: String(queryValues?.[1]) as "active" };
    } else if (text.includes("UPDATE platform.idempotency_keys") && stored) {
      stored.result = JSON.parse(String(queryValues?.[4]));
    }
    const rowCount =
      text.includes("UPDATE marketplace.creator_profiles") ||
      text.includes("UPDATE platform.idempotency_keys")
        ? 1
        : rows.length;
    return { rows: rows as T[], rowCount };
  };
  const client = { query, release() {} };
  return {
    sql,
    values,
    pool: {
      async connect() {
        return client as never;
      },
    },
  };
}
