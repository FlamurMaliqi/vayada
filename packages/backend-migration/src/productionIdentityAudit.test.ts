import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { planIdentityAudit, type PlannedIdentityAuditEvent } from "./productionIdentityAudit.js";

const USER = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const OTHER_EVENT = "33333333-3333-4333-8333-333333333333";
const ORPHAN_EVENT = "44444444-4444-4444-8444-444444444444";
const BAD_METHOD_EVENT = "55555555-5555-4555-8555-555555555555";
const CREATED = "2026-01-01T00:00:00.000Z";

describe("production identity audit", () => {
  it("keeps sensitive login evidence private and allows anonymous failures", () => {
    const plan = planIdentityAudit(
      [login(EVENT, { user_id: USER, success: true }), login(OTHER_EVENT, { user_id: null })],
      [USER],
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.auditEvents[0]).toMatchObject({
      actorType: "user",
      targetResourceType: "user",
      redactedPayload: { success: true, authMethod: "password" },
      privatePayload: expect.objectContaining({ email: "owner@example.com" }),
    });
    expect(plan.auditEvents[1]).toMatchObject({
      actorType: "system",
      targetResourceType: "login_attempt",
    });
    expect(JSON.stringify(plan.auditEvents[0]?.redactedPayload)).not.toMatch(
      /owner@example|192\.0\.2\.1|invalid password/i,
    );
  });

  it("fails closed on orphan users, conflicting source rows, target mutation, and ID reuse", () => {
    const accepted = planIdentityAudit([login(EVENT)], [USER]).auditEvents[0]!;
    const exactTarget: PlannedIdentityAuditEvent = {
      ...accepted,
      occurredAt: "2026-01-01T00:00:00+00:00",
      recordedAt: "2026-01-01T00:00:00+00:00",
      privatePayload: {
        userAgent: "test",
        email: "owner@example.com",
        ipAddress: "192.0.2.1",
        failureReason: "invalid password",
      },
    };
    expect(planIdentityAudit([login(EVENT)], [USER], [exactTarget]).blockers).toEqual([]);

    const conflictingTarget = { ...accepted, action: "auth.login.failed" as const };
    const reusedId = { id: OTHER_EVENT, product: "booking", auditKey: "another-event" };
    const plan = planIdentityAudit(
      [
        login(EVENT),
        login(EVENT, { success: false }),
        login(OTHER_EVENT),
        login(ORPHAN_EVENT, { user_id: "55555555-5555-4555-8555-555555555555" }),
        login(BAD_METHOD_EVENT, { auth_method: "owner@example.com" }),
      ],
      [USER],
      [conflictingTarget, reusedId],
    );

    expect(plan.blockers.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        "INVALID_SOURCE_ROW",
        "LOGIN_AUDIT_SOURCE_CONFLICT",
        "LOGIN_AUDIT_TARGET_CONFLICT",
        "LOGIN_AUDIT_ID_CONFLICT",
      ]),
    );
    expect(plan.blockers.filter((row) => row.code === "INVALID_SOURCE_ROW")).toHaveLength(2);
  });
});

function login(id: string, overrides: Record<string, unknown> = {}): IdentitySourceRow {
  return {
    sourceDatabase: "auth",
    sourceTable: "login_audit_log",
    rowOrdinal: 1,
    data: {
      id,
      user_id: USER,
      email: "Owner@Example.com",
      success: true,
      auth_method: "password",
      failure_reason: "invalid password",
      ip_address: "192.0.2.1",
      user_agent: "test",
      created_at: CREATED,
      ...overrides,
    },
  };
}
