import { describe, expect, it } from "vitest";

import {
  planIdentityUserDisposition,
  type IdentitySourceRow,
} from "./productionIdentityDisposition.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-01-01T00:00:00.000Z";
const UPDATED = "2026-02-01T00:00:00.000Z";

describe("production identity user disposition", () => {
  it("keeps stable IDs, normalizes email, and preserves verified WorkOS IDs", () => {
    const plan = planIdentityUserDisposition(
      [userRow()],
      [],
      [{ userId: USER_ID, providerUserId: "user_workos_verified" }],
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.users).toEqual([
      expect.objectContaining({
        id: USER_ID,
        email: "owner@example.com",
        status: "active",
        disposition: "migrate",
      }),
    ]);
    expect(plan.workosIdentities).toEqual([
      { userId: USER_ID, providerUserId: "user_workos_verified" },
    ]);
  });

  it("preserves newer target state instead of replaying stale source state", () => {
    const plan = planIdentityUserDisposition(
      [userRow()],
      [
        {
          id: USER_ID,
          email: "current@example.com",
          name: null,
          status: "suspended",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.users[0]).toMatchObject({
      email: "current@example.com",
      name: null,
      status: "suspended",
      disposition: "preserve_newer_target",
    });
  });

  it("blocks differing user state at equal freshness", () => {
    const plan = planIdentityUserDisposition(
      [userRow()],
      [
        {
          id: USER_ID,
          email: "current@example.com",
          name: "Current",
          status: "suspended",
          updatedAt: "2026-02-01T00:00:00+00:00",
        },
      ],
    );

    expect(plan.blockers).toEqual([
      expect.objectContaining({ code: "USER_EQUAL_TIME_CONFLICT", sourceId: USER_ID }),
    ]);
  });

  it("fails closed on unknown states, duplicate emails, and ambiguous provider IDs", () => {
    const duplicate = userRow({ id: OTHER_USER_ID, email: "other@example.com" });
    const unknown = userRow({ id: "33333333-3333-4333-8333-333333333333", status: "mystery" });
    const plan = planIdentityUserDisposition(
      [userRow(), duplicate, unknown],
      [
        {
          id: USER_ID,
          email: "other@example.com",
          name: "Current",
          status: "active",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      [
        { userId: USER_ID, providerUserId: "user_workos_same" },
        { userId: OTHER_USER_ID, providerUserId: "user_workos_same" },
      ],
    );

    expect(plan.blockers.map((item) => item.code)).toEqual(
      expect.arrayContaining(["DUPLICATE_EMAIL", "INVALID_PROVIDER_LINK", "INVALID_SOURCE_ROW"]),
    );
    expect(JSON.stringify(plan.blockers)).not.toContain("mystery");
  });
});

function userRow(overrides: Record<string, unknown> = {}): IdentitySourceRow {
  return {
    sourceDatabase: "auth",
    sourceTable: "users",
    rowOrdinal: 1,
    data: {
      id: USER_ID,
      email: "Owner@Example.com",
      name: "Owner",
      type: "hotel",
      status: "verified",
      email_verified: true,
      is_superadmin: false,
      terms_accepted_at: CREATED,
      terms_version: "v1",
      privacy_accepted_at: CREATED,
      privacy_version: "v1",
      marketing_consent: false,
      marketing_consent_at: null,
      created_at: CREATED,
      updated_at: UPDATED,
      ...overrides,
    },
  };
}
