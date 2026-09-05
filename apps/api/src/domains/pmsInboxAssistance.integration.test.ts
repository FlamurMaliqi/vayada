import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PmsInboxAssistancePort } from "./pmsInbox.js";
import {
  createPgPmsInboxAssistancePort,
  type PmsInboxAssistanceServiceInput,
  type PmsInboxAssistanceServicePort,
} from "./pmsInboxAssistance.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13737000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "13737000-0000-4000-8000-000000000002";
const THREAD = "13737000-0000-4000-8000-000000000003";
const OTHER_THREAD = "13737000-0000-4000-8000-000000000004";
const MESSAGE_1 = "13737000-0000-4000-8000-000000000005";
const MESSAGE_2 = "13737000-0000-4000-8000-000000000006";
const MESSAGE_3 = "13737000-0000-4000-8000-000000000007";
const OTHER_MESSAGE = "13737000-0000-4000-8000-000000000008";
const ORGANIZATION = "13737000-0000-4000-8000-000000000009";
const ACTOR = "13737000-0000-4000-8000-000000000010";
const MEMBERSHIP = "13737000-0000-4000-8000-000000000011";
const NOW = "2026-09-03T10:00:00.000Z";

type Input = Parameters<PmsInboxAssistancePort["assist"]>[0];
type ServiceResult = Awaited<ReturnType<PmsInboxAssistanceServicePort["assist"]>>;
type ActorInput = Pick<
  Input,
  | "propertyId"
  | "threadId"
  | "organizationId"
  | "actorUserId"
  | "actorMembershipId"
  | "idempotencyKey"
  | "audit"
>;
type TranslationInput = ActorInput & {
  kind: "translate_message";
  sourceText: string;
  targetLanguage: string;
};
type ContextInput = ActorInput & {
  kind: "summarize" | "draft_reply";
  throughMessageId: string;
};

describe.skipIf(!URL)("PostgreSQL PMS Inbox assistance", () => {
  const admin = new pg.Client({ connectionString: URL });
  const serviceInputs: PmsInboxAssistanceServiceInput[] = [];
  const serviceClose = vi.fn(async () => undefined);
  let currentNow = NOW;
  let serviceHandler: (
    input: PmsInboxAssistanceServiceInput,
  ) => Promise<ServiceResult> = async () => ({ ok: true, assistedText: "Assisted response" });
  const assistance = createPgPmsInboxAssistancePort({
    connectionString: URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date(currentNow),
    service: {
      async assist(input) {
        serviceInputs.push(input);
        return serviceHandler(input);
      },
      close: serviceClose,
    },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    serviceInputs.length = 0;
    currentNow = NOW;
    serviceHandler = async () => ({ ok: true, assistedText: "Assisted response" });
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await assistance.close();
    await cleanup();
    await admin.end();
    expect(serviceClose).toHaveBeenCalledOnce();
  });

  it("translates once with a minimal service request and sanitized evidence", async () => {
    serviceHandler = async () => ({ ok: true, assistedText: "Hello, I am Ada." });
    const input = translation("translate-once");
    const first = await assistance.assist(input);
    await expect(assistance.assist(input)).resolves.toEqual(first);
    await expect(assistance.assist({ ...input, targetLanguage: "de" })).resolves.toEqual({
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was used for a different Inbox assistance request.",
      },
    });
    expect(first).toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        kind: "translate_message",
        assistedText: "Hello, I am Ada.",
        attribution: "ai_assisted",
        reviewRequired: true,
        basedThroughMessageId: null,
      },
    });
    expect(serviceInputs).toEqual([
      {
        kind: "translate_message",
        sourceText: "Bonjour, je suis Ada.",
        targetLanguage: "en-GB",
      },
    ]);
    const persisted = await state();
    expect(persisted.counts).toEqual({
      idempotency: 1,
      assistanceResults: 1,
      events: 1,
      audits: 1,
      messages: 3,
      jobs: 0,
      outbox: 0,
    });
    const evidence = JSON.stringify([persisted.events, persisted.audits]);
    expect(evidence).not.toContain("Bonjour");
    expect(evidence).not.toContain("Hello, I am Ada");
    expect(evidence).not.toContain("translate-once");
    expect(JSON.stringify(persisted.idempotency)).not.toContain("Bonjour");
    expect(JSON.stringify(persisted.idempotency)).not.toContain("Hello, I am Ada");
  });

  it("pins summary and draft context to the requested message boundary", async () => {
    serviceHandler = async (input) => ({
      ok: true,
      assistedText:
        input.kind === "summarize" ? "Guest asks about breakfast." : "Breakfast starts at 7.",
    });
    const summary = await assistance.assist(contextual("summary", "summarize"));
    const draft = await assistance.assist(contextual("draft", "draft_reply"));
    expect(summary).toMatchObject({
      ok: true,
      value: { kind: "summarize", basedThroughMessageId: MESSAGE_2 },
    });
    expect(draft).toMatchObject({
      ok: true,
      value: { kind: "draft_reply", basedThroughMessageId: MESSAGE_2 },
    });
    expect(serviceInputs).toEqual([
      {
        kind: "summarize",
        messages: [
          { direction: "inbound", text: "Hello, I am Ada. Is breakfast included?" },
          { direction: "outbound", text: "Let me check that for you." },
        ],
      },
      {
        kind: "draft_reply",
        messages: [
          { direction: "inbound", text: "Hello, I am Ada. Is breakfast included?" },
          { direction: "outbound", text: "Let me check that for you." },
        ],
      },
    ]);
    expect((await state()).counts).toEqual({
      idempotency: 2,
      assistanceResults: 2,
      events: 2,
      audits: 2,
      messages: 3,
      jobs: 0,
      outbox: 0,
    });
  });

  it("rejects missing or cross-property context before calling the service", async () => {
    await expect(
      assistance.assist({
        ...contextual("missing-thread", "summarize"),
        threadId: "13737000-0000-4000-8000-000000000099",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });
    await expect(
      assistance.assist({
        ...contextual("foreign-boundary", "draft_reply"),
        throughMessageId: OTHER_MESSAGE,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Inbox assistance message boundary has no available text.",
      },
    });
    expect(serviceInputs).toEqual([]);
    expect((await state()).counts).toMatchObject({
      idempotency: 2,
      assistanceResults: 0,
      events: 0,
      audits: 0,
    });
  });

  it("returns and replays a safe unavailable result for provider failures", async () => {
    serviceHandler = async () => {
      throw new Error("provider detail must not escape");
    };
    const input = translation("provider-down");
    const expected = {
      ok: false as const,
      error: {
        code: "assistance_unavailable" as const,
        message: "Inbox assistance is temporarily unavailable.",
      },
    };
    await expect(assistance.assist(input)).resolves.toEqual(expected);
    await expect(assistance.assist(input)).resolves.toEqual(expected);
    expect(serviceInputs).toHaveLength(1);
    const persisted = await state();
    expect(persisted.counts).toMatchObject({
      idempotency: 1,
      assistanceResults: 0,
      events: 1,
      audits: 1,
    });
    expect(JSON.stringify([persisted.events, persisted.audits])).not.toContain("provider detail");
  });

  it("prevents concurrent duplicate service calls", async () => {
    let releaseService!: () => void;
    let reportStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    serviceHandler = async () => {
      reportStarted();
      await gate;
      return { ok: true, assistedText: "Concurrent result" };
    };
    const input = contextual("concurrent", "draft_reply");
    const first = assistance.assist(input);
    await started;
    await expect(assistance.assist(input)).resolves.toEqual({
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "This Inbox assistance request is in progress.",
      },
    });
    releaseService();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(serviceInputs).toHaveLength(1);
  });

  it("rechecks current permissions before replay and before returning provider output", async () => {
    const completedInput = translation("completed");
    await expect(assistance.assist(completedInput)).resolves.toMatchObject({ ok: true });
    await revokePermissions();
    await expect(assistance.assist(completedInput)).rejects.toThrow(
      "PMS Inbox assistance preparation failed",
    );
    await restorePermissions();

    let releaseService!: () => void;
    let reportStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    serviceHandler = async () => {
      reportStarted();
      await gate;
      return { ok: true, assistedText: "Must not be returned after revocation" };
    };
    const pending = assistance.assist(translation("revoked-before-completion"));
    await started;
    await revokePermissions();
    releaseService();
    await expect(pending).rejects.toThrow("PMS Inbox assistance completion failed");
    expect((await state()).counts).toMatchObject({
      idempotency: 2,
      assistanceResults: 1,
      events: 1,
      audits: 1,
    });
  });

  it("purges expired assisted text and returns a stable replay outcome", async () => {
    currentNow = "2026-08-01T10:00:00.000Z";
    serviceHandler = async () => ({ ok: true, assistedText: "Retained only for thirty days" });
    const input = translation("expired-result");
    await expect(assistance.assist(input)).resolves.toMatchObject({ ok: true });

    currentNow = NOW;
    expect(
      (
        await admin.query<{ count: number }>(
          "SELECT pms.purge_expired_message_assistance_results($1::timestamptz) count",
          [currentNow],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await admin.query<{ assistedText: string | null; purgedAt: Date | null }>(
          `SELECT assisted_text AS "assistedText", purged_at AS "purgedAt"
           FROM pms.message_assistance_results WHERE property_id = $1::uuid`,
          [PROPERTY],
        )
      ).rows[0],
    ).toMatchObject({ assistedText: null, purgedAt: expect.any(Date) });

    const expired = {
      ok: false as const,
      error: {
        code: "validation_failed" as const,
        message: "Inbox assistance result has expired. Retry with a new idempotency key.",
      },
    };
    await expect(assistance.assist(input)).resolves.toEqual(expired);
    await expect(assistance.assist(input)).resolves.toEqual(expired);
    expect(serviceInputs).toHaveLength(1);
    expect(JSON.stringify((await state()).idempotency)).not.toContain("assistanceResultId");
    expect(
      (
        await admin.query<{ count: number }>(
          "SELECT pms.purge_expired_message_assistance_results($1::timestamptz) count",
          [currentNow],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("starts the full replay window after a delayed provider completes", async () => {
    currentNow = "2026-08-01T10:00:00.000Z";
    serviceHandler = async () => {
      currentNow = "2026-08-02T10:00:00.000Z";
      return { ok: true, assistedText: "Delayed result" };
    };
    const input = translation("delayed-provider");
    const first = await assistance.assist(input);
    const retention = (
      await admin.query<{ retentionUntil: Date; expiresAt: Date }>(
        `SELECT result.pii_retention_until AS "retentionUntil",
                idempotency.expires_at AS "expiresAt"
         FROM pms.message_assistance_results result
         JOIN platform.idempotency_keys idempotency
           ON idempotency.id = result.idempotency_key_id
         WHERE result.property_id = $1::uuid`,
        [PROPERTY],
      )
    ).rows[0];
    expect(retention?.retentionUntil.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(retention?.expiresAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");

    currentNow = "2026-08-31T10:00:00.000Z";
    await expect(assistance.assist(input)).resolves.toEqual(first);
    currentNow = "2026-09-01T10:00:00.000Z";
    await expect(assistance.assist(input)).resolves.toEqual({
      ok: false,
      error: {
        code: "validation_failed",
        message: "Inbox assistance result has expired. Retry with a new idempotency key.",
      },
    });
    expect(serviceInputs).toHaveLength(1);
  });

  it("replays a pinned result after its source boundary message is deleted", async () => {
    serviceHandler = async () => ({ ok: true, assistedText: "Pinned summary" });
    const input = contextual("deleted-boundary", "summarize");
    const first = await assistance.assist(input);
    await admin.query("DELETE FROM pms.messages WHERE id = $1::uuid", [MESSAGE_2]);
    await expect(assistance.assist(input)).resolves.toEqual(first);
    expect(serviceInputs).toHaveLength(1);
    expect(
      (
        await admin.query<{ boundary: string }>(
          `SELECT based_through_message_id::text AS boundary
           FROM pms.message_assistance_results WHERE property_id = $1::uuid`,
          [PROPERTY],
        )
      ).rows[0]?.boundary,
    ).toBe(MESSAGE_2);
  });

  it("closes its owned database pool even when service shutdown fails", async () => {
    const rejecting = createPgPmsInboxAssistancePort({
      connectionString: URL!,
      service: {
        async assist() {
          return { ok: true, assistedText: "unused" };
        },
        async close() {
          throw new Error("service close failed");
        },
      },
    });
    await expect(rejecting.close()).rejects.toThrow("service close failed");
    await expect(rejecting.assist(translation("after-close"))).rejects.toThrow();
  });

  it("rejects invalid direct inputs and unlinked property scope", async () => {
    await expect(assistance.assist({ ...translation("invalid"), sourceText: "" })).resolves.toEqual(
      {
        ok: false,
        error: { code: "validation_failed", message: "Inbox assistance request is invalid." },
      },
    );
    await expect(
      assistance.assist({
        ...translation("foreign-property"),
        propertyId: OTHER_PROPERTY,
        threadId: OTHER_THREAD,
      }),
    ).rejects.toThrow("PMS Inbox assistance preparation failed");
    expect(serviceInputs).toEqual([]);
  });

  function actor(key: string): ActorInput {
    return {
      propertyId: PROPERTY,
      threadId: THREAD,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: MEMBERSHIP,
      idempotencyKey: key,
      audit: {
        requestId: `request-${key}`,
        correlationId: "inbox-assistance",
        requestedAt: currentNow,
      },
    };
  }

  function translation(key: string): TranslationInput {
    return {
      ...actor(key),
      kind: "translate_message",
      sourceText: "Bonjour, je suis Ada.",
      targetLanguage: "en-GB",
    };
  }

  function contextual(key: string, kind: "summarize" | "draft_reply"): ContextInput {
    return { ...actor(key), kind, throughMessageId: MESSAGE_2 };
  }

  async function revokePermissions(): Promise<void> {
    await admin.query(
      `UPDATE identity.organization_memberships
       SET permission_overrides = '{"grant":[],"deny":["pms.inbox.read","pms.inbox.reply"]}'::jsonb
       WHERE id = $1::uuid`,
      [MEMBERSHIP],
    );
  }

  async function restorePermissions(): Promise<void> {
    await admin.query(
      `UPDATE identity.organization_memberships
       SET permission_overrides = NULL
       WHERE id = $1::uuid`,
      [MEMBERSHIP],
    );
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'assistance-actor@example.test', 'Front Desk', 'active')`,
      [ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Assistance', 'inbox-assistance', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-assistance', 'Assistance Hotel'),
              ($2::uuid, 'inbox-assistance-other', 'Other Hotel')`,
      [PROPERTY, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', 'owner', 'all', 'agency')`,
      [MEMBERSHIP, ORGANIZATION, ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [ORGANIZATION, PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [ORGANIZATION, PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, attention_state, delivery_channel,
          conversation_context_state, unread_count, version)
       VALUES ($1::uuid, $2::uuid, 'channex', 'assistance-thread', 'needs_attention',
               'ota', 'unlinked', 1, 4),
              ($3::uuid, $4::uuid, 'channex', 'assistance-other', 'needs_attention',
               'ota', 'unlinked', 1, 1)`,
      [THREAD, PROPERTY, OTHER_THREAD, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.messages
         (id, property_id, thread_id, source_message_id, direction, sender_type, body, sent_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'assist-1', 'inbound', 'guest',
          'Hello, I am Ada. Is breakfast included?', '2026-09-03T09:00:00.000Z'),
         ($4::uuid, $2::uuid, $3::uuid, 'assist-2', 'outbound', 'property_user',
          'Let me check that for you.', '2026-09-03T09:05:00.000Z'),
         ($5::uuid, $2::uuid, $3::uuid, 'assist-3', 'inbound', 'guest',
          'Also, can I check in early?', '2026-09-03T09:10:00.000Z'),
         ($6::uuid, $7::uuid, $8::uuid, 'assist-other', 'inbound', 'guest',
          'Foreign property message', '2026-09-03T09:00:00.000Z')`,
      [
        MESSAGE_1,
        PROPERTY,
        THREAD,
        MESSAGE_2,
        MESSAGE_3,
        OTHER_MESSAGE,
        OTHER_PROPERTY,
        OTHER_THREAD,
      ],
    );
  }

  async function state() {
    const result = await admin.query(
      `SELECT jsonb_build_object(
         'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid),
         'assistanceResults', (SELECT count(*)::int FROM pms.message_assistance_results WHERE property_id = $1::uuid),
         'events', (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid),
         'audits', (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid),
         'messages', (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid),
         'jobs', (SELECT count(*)::int FROM platform.jobs WHERE property_id = $1::uuid),
         'outbox', (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid)
       ) AS counts,
       (SELECT jsonb_agg(jsonb_build_object('payload', payload, 'metadata', event_metadata))
        FROM platform.domain_events WHERE property_id = $1::uuid) AS events,
       (SELECT jsonb_agg(jsonb_build_object(
          'redactedPayload', redacted_payload, 'metadata', audit_metadata))
        FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audits,
       (SELECT jsonb_agg(idempotency_metadata)
        FROM platform.idempotency_keys WHERE property_id = $1::uuid) AS idempotency`,
      [PROPERTY],
    );
    return result.rows[0] as {
      counts: {
        idempotency: number;
        assistanceResults: number;
        events: number;
        audits: number;
        messages: number;
        jobs: number;
        outbox: number;
      };
      events: unknown;
      audits: unknown;
      idempotency: unknown;
    };
  }

  async function cleanup(): Promise<void> {
    if (!admin.database) return;
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      const properties = [PROPERTY, OTHER_PROPERTY];
      for (const statement of [
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_assistance_results WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.messages WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [properties]);
      for (const statement of [
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
      ])
        await admin.query(statement, [ORGANIZATION]);
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        properties,
      ]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [ORGANIZATION]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [ACTOR]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(connectionString).pathname))
    throw new Error("Refusing to run Inbox assistance tests outside a test database");
}
