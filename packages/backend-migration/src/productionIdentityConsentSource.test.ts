import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planIdentityConsentSource } from "./productionIdentityConsentSource.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OLD_COOKIE = "33333333-3333-4333-8333-333333333333";
const NEW_COOKIE = "44444444-4444-4444-8444-444444444444";
const JAN = "2026-01-01T00:00:00.000Z";
const FEB = "2026-02-01T00:00:00.000Z";
const MAR = "2026-03-01T00:00:00.000Z";

describe("production identity consent source", () => {
  it("ignores unrelated user freshness, uses the latest cookie, and only counts retired rows", () => {
    const rows = [
      source("users", {
        id: USER,
        terms_accepted_at: FEB,
        terms_version: "v2",
        privacy_accepted_at: null,
        privacy_version: null,
        marketing_consent: false,
        marketing_consent_at: null,
        created_at: JAN,
        updated_at: MAR,
      }),
      cookie(OLD_COOKIE, JAN, false),
      cookie(NEW_COOKIE, FEB, true),
      { ...source("password_reset_tokens", {}), rowOrdinal: 0, rowCountOnly: 500 },
      source("totp_secrets", { id: OTHER }),
    ];

    const plan = planIdentityConsentSource(rows, [USER]);

    expect(plan.blockers).toEqual([]);
    expect(plan.userConsents[0]?.updatedAt).toBe(FEB);
    expect(plan.cookieConsents).toEqual([
      expect.objectContaining({ id: NEW_COOKIE, analytics: true }),
    ]);
    expect(plan.retiredAuthRows).toMatchObject({ password_reset_tokens: 500, totp_secrets: 1 });
    expect(planIdentityConsentSource([...rows].reverse(), [USER])).toEqual(plan);
  });

  it("fails closed on unknown users, illegal necessary state, and equal-time disagreement", () => {
    const rows = [
      cookie(OLD_COOKIE, FEB, false),
      cookie(NEW_COOKIE, FEB, true),
      cookie("55555555-5555-4555-8555-555555555555", MAR, false, OTHER),
      source("cookie_consent", {
        ...cookieData("66666666-6666-4666-8666-666666666666", MAR, false),
        necessary: false,
      }),
    ];

    const plan = planIdentityConsentSource(rows, [USER]);

    const codes = plan.blockers.map((row) => row.code);
    expect(codes).toContain("COOKIE_STATE_CONFLICT");
    expect(codes.filter((code) => code === "INVALID_SOURCE_ROW")).toHaveLength(2);
  });
});

function cookie(id: string, updatedAt: string, analytics: boolean, userId = USER) {
  return source("cookie_consent", cookieData(id, updatedAt, analytics, userId));
}
function cookieData(id: string, updatedAt: string, analytics: boolean, userId = USER) {
  return {
    id,
    visitor_id: "visitor-1",
    user_id: userId,
    necessary: true,
    functional: false,
    analytics,
    marketing: false,
    created_at: JAN,
    updated_at: updatedAt,
  };
}
function source(table: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "auth", sourceTable: table, rowOrdinal: 1, data };
}
