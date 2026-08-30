import { describe, expect, it } from "vitest";

import {
  type PrivacyAuditIdentityWritePlan,
  writeProductionIdentityPrivacyAudit,
} from "./productionIdentityPrivacyAuditWriter.js";

const USER = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-01-01T00:00:00.000Z";

describe("production identity privacy/audit writer", () => {
  it("refuses blockers before issuing writes", async () => {
    const client = new RecordingClient();
    const plan = emptyPlan();
    plan.blockers.push({ code: "STALE", source: "identity", sourceId: USER, message: "x" });

    await expect(writeProductionIdentityPrivacyAudit(client as never, plan)).rejects.toThrow(
      "Refusing to write a blocked identity plan",
    );
    expect(client.calls).toEqual([]);
  });

  it("guards mutable privacy and inserts immutable records without updates", async () => {
    const client = new RecordingClient();
    const plan = populatedPlan();

    await writeProductionIdentityPrivacyAudit(client as never, plan);

    const inserts = client.calls.filter((call) => call.sql.startsWith("INSERT"));
    expect(inserts.map((call) => table(call.sql))).toEqual([
      "identity.user_consent_status",
      "identity.cookie_consents",
      "identity.consent_history",
      "identity.gdpr_requests",
      "platform.product_audit_events",
    ]);
    for (const index of [0, 1, 3]) {
      expect(inserts[index]!.sql).toContain("updated_at < EXCLUDED.updated_at");
      expect(inserts[index]!.sql).not.toContain("updated_at <=");
    }
    expect(inserts[2]!.sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(inserts[4]!.sql).toContain("ON CONFLICT (product, audit_key) DO NOTHING");
    expect(inserts[4]!.sql).toContain("correlation_id");
    expect(inserts[4]!.sql).toContain("secondary_resource_product");
    expect(inserts[4]!.sql).not.toContain("DO UPDATE");
    expect(client.calls.filter((call) => call.sql.includes('AS "matchingCount"'))).toHaveLength(2);
  });

  it("fails closed when an immutable conflict does not match", async () => {
    const client = new RecordingClient();
    client.immutableMismatch = true;
    const plan = emptyPlan();
    plan.consentHistory = populatedPlan().consentHistory;

    await expect(writeProductionIdentityPrivacyAudit(client as never, plan)).rejects.toThrow(
      "Immutable identity rows do not match the migration plan",
    );
  });

  it("batches large audit writes and verifies every batch", async () => {
    const client = new RecordingClient();
    const plan = emptyPlan();
    const event = populatedPlan().auditEvents[0]!;
    plan.auditEvents = Array.from({ length: 1_001 }, (_, index) => ({
      ...event,
      auditKey: `${event.auditKey}:${index}`,
    }));

    await writeProductionIdentityPrivacyAudit(client as never, plan);

    const auditInserts = client.calls.filter((call) =>
      call.sql.startsWith("INSERT INTO platform.product_audit_events"),
    );
    const auditVerifications = client.calls.filter((call) =>
      call.sql.includes("JOIN platform.product_audit_events"),
    );
    expect(auditInserts.map(batchLength)).toEqual([500, 500, 1]);
    expect(auditVerifications.map(batchLength)).toEqual([500, 500, 1]);
  });

  it("skips empty table batches", async () => {
    const client = new RecordingClient();
    await writeProductionIdentityPrivacyAudit(client as never, emptyPlan());
    expect(client.calls).toEqual([]);
  });
});

class RecordingClient {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  immutableMismatch = false;
  async query(sql: string, values: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, values });
    if (sql.includes('AS "matchingCount"')) {
      const count = this.immutableMismatch
        ? 0
        : (JSON.parse(values[0] as string) as unknown[]).length;
      return { rows: [{ matchingCount: count }] };
    }
    return { rows: [] };
  }
}

function emptyPlan(): PrivacyAuditIdentityWritePlan {
  return {
    userConsents: [],
    cookieConsents: [],
    consentHistory: [],
    gdprRequests: [],
    auditEvents: [],
    blockers: [],
  };
}

function populatedPlan(): PrivacyAuditIdentityWritePlan {
  return {
    ...emptyPlan(),
    userConsents: [
      {
        userId: USER,
        termsAcceptedAt: CREATED,
        termsVersion: "1",
        privacyAcceptedAt: CREATED,
        privacyVersion: "1",
        marketingConsent: false,
        marketingConsentAt: null,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    cookieConsents: [
      {
        id: EVENT,
        visitorId: "visitor",
        userId: USER,
        necessary: true,
        functional: false,
        analytics: false,
        marketing: false,
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    consentHistory: [
      {
        id: EVENT,
        userId: USER,
        visitorId: null,
        consentType: "terms",
        consentGiven: true,
        version: "1",
        metadata: {},
        createdAt: CREATED,
      },
    ],
    gdprRequests: [
      {
        id: EVENT,
        userId: USER,
        requestType: "export",
        status: "pending",
        downloadToken: null,
        requestedAt: CREATED,
        processedAt: null,
        expiresAt: null,
        ipAddress: null,
        metadata: {},
        createdAt: CREATED,
        updatedAt: CREATED,
      },
    ],
    auditEvents: [
      {
        id: EVENT,
        auditKey: `legacy-auth-login:${EVENT}`,
        product: "identity",
        action: "auth.login.succeeded",
        actionVersion: 1,
        occurredAt: CREATED,
        recordedAt: CREATED,
        tenantScope: "migration",
        organizationId: null,
        propertyId: null,
        actorType: "user",
        actorUserId: USER,
        targetResourceProduct: "identity",
        targetResourceType: "user",
        targetResourceId: USER,
        secondaryResourceProduct: null,
        secondaryResourceType: null,
        secondaryResourceId: null,
        domainEventId: null,
        externalWebhookEventId: null,
        jobId: null,
        idempotencyKeyId: null,
        correlationId: null,
        causationId: null,
        redactedPayload: { success: true },
        privatePayload: { email: "owner@example.com" },
        auditMetadata: { source: "auth.login_audit_log" },
        retentionClass: "security",
        privacyScope: "restricted",
        aiVisible: false,
      },
    ],
  };
}

function table(sql: string): string {
  return /INSERT INTO ([a-z_.]+)/.exec(sql)?.[1] ?? "";
}

function batchLength(call: { values: unknown[] }): number {
  return (JSON.parse(call.values[0] as string) as unknown[]).length;
}
