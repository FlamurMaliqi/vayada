import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planIdentityPrivacyRecordSource } from "./productionIdentityPrivacyRecordSource.js";

const USER = "11111111-1111-4111-8111-111111111111";
const CONSENT = "22222222-2222-4222-8222-222222222222";
const GDPR = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const TOKEN_OTHER = "55555555-5555-4555-8555-555555555555";
const BAD_LIFECYCLE = "66666666-6666-4666-8666-666666666666";
const JAN = "2026-01-01T00:00:00.000Z";
const FEB = "2026-02-01T00:00:00.000Z";
const MAR = "2026-03-01T00:00:00.000Z";
const SECRET_TOKEN = "super-secret-download-token";

describe("production identity privacy record source", () => {
  it("maps immutable consent and uses conservative GDPR lifecycle freshness", () => {
    const rows = [
      source("consent_history", {
        id: CONSENT,
        user_id: USER,
        consent_type: "privacy",
        consent_given: true,
        version: "v1",
        ip_address: "192.0.2.1",
        user_agent: "test",
        created_at: JAN,
      }),
      gdpr({ id: GDPR, status: "pending", expires_at: MAR }),
      gdpr({ id: OTHER, status: "completed", processed_at: FEB }),
    ];

    const plan = planIdentityPrivacyRecordSource(rows, [USER]);

    expect(plan.blockers).toEqual([]);
    expect(plan.consentHistory[0]).toMatchObject({ id: CONSENT, visitorId: null });
    expect(plan.gdprRequests.map((row) => [row.id, row.updatedAt])).toEqual([
      [GDPR, JAN],
      [OTHER, FEB],
    ]);
    expect(planIdentityPrivacyRecordSource([...rows].reverse(), [USER])).toEqual(plan);
  });

  it("blocks invalid lifecycle state, unknown users, conflicting IDs, and duplicate tokens", () => {
    const rows = [
      gdpr({ id: GDPR, status: "completed", processed_at: null, download_token: SECRET_TOKEN }),
      gdpr({ id: BAD_LIFECYCLE, status: "pending", processed_at: MAR }),
      gdpr({ id: OTHER, status: "pending", download_token: SECRET_TOKEN }),
      gdpr({ id: OTHER, status: "processing", download_token: SECRET_TOKEN }),
      gdpr({ id: TOKEN_OTHER, status: "pending", download_token: SECRET_TOKEN }),
      source("consent_history", {
        id: CONSENT,
        user_id: USER,
        consent_type: "unknown",
        consent_given: true,
        version: null,
        ip_address: null,
        user_agent: null,
        created_at: JAN,
      }),
      source("consent_history", {
        id: TOKEN_OTHER,
        user_id: OTHER,
        consent_type: "privacy",
        consent_given: true,
        version: null,
        ip_address: null,
        user_agent: null,
        created_at: JAN,
      }),
    ];

    const plan = planIdentityPrivacyRecordSource(rows, [USER]);
    expect(plan.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        "INVALID_SOURCE_ROW",
        "GDPR_REQUEST_CONFLICT",
        "GDPR_TOKEN_CONFLICT",
      ]),
    );
    expect(JSON.stringify(plan.blockers)).not.toContain(SECRET_TOKEN);
    expect(plan.blockers.filter((row) => row.code === "INVALID_SOURCE_ROW")).toHaveLength(4);
  });
});

function gdpr(overrides: Record<string, unknown>): IdentitySourceRow {
  return source("gdpr_requests", {
    id: GDPR,
    user_id: USER,
    request_type: "export",
    status: "pending",
    requested_at: JAN,
    processed_at: null,
    expires_at: null,
    download_token: null,
    cancellation_reason: null,
    ip_address: "192.0.2.1",
    ...overrides,
  });
}
function source(table: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "auth", sourceTable: table, rowOrdinal: 1, data };
}
