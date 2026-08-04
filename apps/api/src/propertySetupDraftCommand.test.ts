import { createHash, randomUUID } from "node:crypto";

import {
  PROPERTY_SETUP_ACTIVE_RETENTION_DAYS,
  type ResetPropertySetupDraftRequest,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createPgPropertySetupDraftCommandRepository,
  type PropertySetupDraftCommandPool,
  type PropertySetupDraftCommandRepository,
  type PropertySetupDraftResetCommand,
  type PropertySetupDraftSaveCommand,
} from "./domains/propertySetupDraftCommandRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const occurredAt = "2026-07-30T14:00:00.000Z";
const retentionExpiresAt = new Date(
  Date.parse(occurredAt) + PROPERTY_SETUP_ACTIVE_RETENTION_DAYS * 86_400_000,
).toISOString();
const PRESENT_BASE = {
  "hotel_catalog.profile": "profile:7",
  "hotel_catalog.media": "media:4",
  "hotel_catalog.amenities": "amenities:2",
};
const ROOM_BASE = {
  "pms.room_types": "room-types:9",
  "pms.room_units": "room-units:6",
  "pms.room_media": "room-media:4",
};

describe.skipIf(!TEST_DATABASE_URL)("property setup draft save repository", () => {
  const organizationIds: string[] = [];
  const propertyIds: string[] = [];
  const roleKeys: string[] = [];
  const userIds: string[] = [];
  let client: pg.Client;
  let repository: PropertySetupDraftCommandRepository;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    repository = createPgPropertySetupDraftCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => new Date(occurredAt),
    });
  });

  afterEach(async () => {
    if (propertyIds.length === 0) return;
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        [propertyIds],
      );
      await client.query(
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
        [propertyIds],
      );
      await client.query(
        `DELETE FROM hotel_catalog.property_setup_step_drafts
         WHERE session_id IN (
           SELECT id
           FROM hotel_catalog.property_setup_sessions
           WHERE property_id = ANY($1::uuid[])
         )`,
        [propertyIds],
      );
      await client.query(
        "DELETE FROM hotel_catalog.property_setup_sessions WHERE property_id = ANY($1::uuid[])",
        [propertyIds],
      );
      await client.query(
        "DELETE FROM hotel_catalog.organization_setup_track_intents WHERE organization_id = ANY($1::uuid[])",
        [organizationIds],
      );
      await client.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = ANY($1::uuid[])",
        [organizationIds],
      );
      await client.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = ANY($1::uuid[])",
        [organizationIds],
      );
      if (roleKeys.length > 0) {
        await client.query(
          "DELETE FROM identity.role_permission_grants WHERE role_key = ANY($1::text[])",
          [roleKeys],
        );
      }
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        propertyIds,
      ]);
      await client.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        organizationIds,
      ]);
      await client.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [userIds]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      organizationIds.length = 0;
      propertyIds.length = 0;
      roleKeys.length = 0;
      userIds.length = 0;
    }
  });

  afterAll(async () => {
    await repository.close();
    await client.end();
  });

  it("creates, updates, and exactly replays a secret-safe draft save", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const initial = command(fixture, {
      idempotencyKey: "present-hotel-create",
      payload: {
        "profile.short_description": "A quiet hotel beside the old town.",
      },
      dirtyFields: ["profile.short_description"],
    });

    const created = await repository.saveStepDraft(initial);
    expect(created).toEqual({
      ok: true,
      receipt: {
        contractVersion: "property-setup-draft.v1",
        sessionId: expect.any(String),
        stepId: "present_hotel",
        selectedTracks: ["hotel_operations"],
        trackRevision: 1,
        sessionRevision: 1,
        draftRevision: 1,
        retentionExpiresAt,
        updatedAt: occurredAt,
        replayed: false,
      },
    });

    await expect(repository.saveStepDraft(initial)).resolves.toEqual({
      ...created,
      receipt: {
        ...(created.ok ? created.receipt : {}),
        replayed: true,
      },
    });
    const auditCount = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    expect(Number(auditCount.rows[0]?.count ?? 0)).toBe(1);

    const sessionId = created.ok ? created.receipt.sessionId : "";
    await expect(
      client.query<{
        revision: number;
        payload: Record<string, unknown>;
        dirtyFields: string[];
        baseRevisions: Record<string, string>;
      }>(
        `SELECT
           revision,
           payload,
           dirty_fields AS "dirtyFields",
           base_revisions AS "baseRevisions"
         FROM hotel_catalog.property_setup_step_drafts
         WHERE session_id = $1::uuid
           AND step_id = 'present_hotel'`,
        [sessionId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          revision: 1,
          payload: {
            "profile.short_description": "A quiet hotel beside the old town.",
          },
          dirtyFields: ["profile.short_description"],
          baseRevisions: PRESENT_BASE,
        },
      ],
    });

    const metadata = await client.query<{
      metadata: Record<string, unknown>;
      responseBodyHash: string;
    }>(
      `SELECT
         idempotency_metadata AS metadata,
         response_body_hash AS "responseBodyHash"
       FROM platform.idempotency_keys
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    const audit = await client.query<{
      redactedPayload: Record<string, unknown>;
      privatePayload: Record<string, unknown>;
      auditMetadata: Record<string, unknown>;
      organizationId: string | null;
    }>(
      `SELECT
         redacted_payload AS "redactedPayload",
         private_payload AS "privatePayload",
         audit_metadata AS "auditMetadata",
         organization_id::text AS "organizationId"
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    const recorded = JSON.stringify({ metadata: metadata.rows, audit: audit.rows });
    expect(recorded).not.toContain("A quiet hotel beside the old town.");
    expect(recorded).not.toContain("profile:7");
    expect(metadata.rows[0]?.responseBodyHash).toBe(
      sha256(stableJson(created.ok ? created.receipt : created.error)),
    );
    expect(audit.rows).toMatchObject([
      {
        organizationId: null,
        privatePayload: {},
      },
    ]);

    await expect(
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "present-hotel-create",
          payload: { "profile.short_description": "A different hotel." },
          dirtyFields: ["profile.short_description"],
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });

    const updated = await repository.saveStepDraft(
      command(fixture, {
        idempotencyKey: "present-hotel-update",
        payload: { "profile.hero_image": "media_12345678" },
        dirtyFields: ["profile.hero_image"],
        expectedSessionRevision: 1,
        expectedDraftRevision: 1,
      }),
    );
    expect(updated).toMatchObject({
      ok: true,
      receipt: {
        sessionId,
        sessionRevision: 2,
        draftRevision: 2,
        retentionExpiresAt,
      },
    });
  });

  it("round-trips locale-only and locale-plus-summary drafts without canonical readiness writes", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const localeOnly = command(fixture, {
      idempotencyKey: "present-hotel-locale-only",
      payload: { "profile.default_locale": "de-DE" },
      dirtyFields: ["profile.default_locale"],
    });

    const created = await repository.saveStepDraft(localeOnly);
    expect(created).toMatchObject({
      ok: true,
      receipt: {
        stepId: "present_hotel",
        sessionRevision: 1,
        draftRevision: 1,
        replayed: false,
      },
    });
    await expect(repository.saveStepDraft(localeOnly)).resolves.toMatchObject({
      ok: true,
      receipt: { replayed: true },
    });

    const canonicalBefore = await canonicalStep1State(fixture.propertyId);
    expect(canonicalBefore).toEqual({
      defaultLocale: "en",
      profileStatus: "incomplete",
      profileRevision: 7,
      profileCount: 0,
    });

    const updated = await repository.saveStepDraft(
      command(fixture, {
        idempotencyKey: "present-hotel-locale-plus-summary",
        payload: {
          "profile.default_locale": "de-DE",
          "profile.short_description": "A quiet hotel beside the old town.",
        },
        dirtyFields: ["profile.default_locale", "profile.short_description"],
        expectedSessionRevision: 1,
        expectedDraftRevision: 1,
      }),
    );
    expect(updated).toMatchObject({
      ok: true,
      receipt: { sessionRevision: 2, draftRevision: 2, replayed: false },
    });

    const persisted = await client.query<{
      payload: Record<string, unknown>;
      dirtyFields: string[];
      completedStepIds: string[];
      resumeStepId: string | null;
    }>(
      `SELECT
         draft.payload,
         draft.dirty_fields AS "dirtyFields",
         setup.completed_step_ids AS "completedStepIds",
         setup.resume_step_id AS "resumeStepId"
       FROM hotel_catalog.property_setup_step_drafts draft
       JOIN hotel_catalog.property_setup_sessions setup ON setup.id = draft.session_id
       WHERE setup.organization_id = $1::uuid
         AND setup.property_id = $2::uuid
         AND draft.step_id = 'present_hotel'`,
      [fixture.organizationId, fixture.propertyId],
    );
    expect(persisted.rows).toEqual([
      {
        payload: {
          "profile.default_locale": "de-DE",
          "profile.short_description": "A quiet hotel beside the old town.",
        },
        dirtyFields: ["profile.default_locale", "profile.short_description"],
        completedStepIds: [],
        resumeStepId: "present_hotel",
      },
    ]);
    await expect(canonicalStep1State(fixture.propertyId)).resolves.toEqual(canonicalBefore);
  });

  it("reclaims an expired idempotency key as a new audited attempt", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const initial = command(fixture, {
      idempotencyKey: "reusable-after-expiry",
      payload: { "profile.short_description": "First idempotent attempt." },
      dirtyFields: ["profile.short_description"],
    });
    expect((await repository.saveStepDraft(initial)).ok).toBe(true);

    await client.query(
      `UPDATE platform.idempotency_keys
       SET expires_at = $2::timestamptz
       WHERE property_id = $1::uuid`,
      [fixture.propertyId, "2026-07-30T13:59:59.000Z"],
    );
    await expect(repository.saveStepDraft(initial)).resolves.toEqual({
      ok: false,
      error: { code: "session_revision_conflict", currentSessionRevision: 1 },
    });

    await client.query(
      `UPDATE platform.idempotency_keys
       SET expires_at = $2::timestamptz
       WHERE property_id = $1::uuid`,
      [fixture.propertyId, "2026-07-30T13:59:59.000Z"],
    );
    await expect(
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "reusable-after-expiry",
          payload: { "profile.short_description": "Third idempotent attempt." },
          dirtyFields: ["profile.short_description"],
          expectedSessionRevision: 1,
          expectedDraftRevision: 1,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      receipt: { sessionRevision: 2, draftRevision: 2, replayed: false },
    });

    const idempotency = await client.query<{
      attempt: number;
      result: Record<string, unknown>;
    }>(
      `SELECT
         (idempotency_metadata ->> 'attempt')::integer AS attempt,
         idempotency_metadata -> 'result' AS result
       FROM platform.idempotency_keys
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    expect(idempotency.rows).toMatchObject([{ attempt: 3, result: { ok: true } }]);
    const audit = await client.query<{ auditKey: string }>(
      `SELECT audit_key AS "auditKey"
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid
       ORDER BY occurred_at, audit_key`,
      [fixture.propertyId],
    );
    expect(audit.rows.map(({ auditKey }) => auditKey)).toEqual([
      expect.stringContaining(".attempt.1.v1"),
      expect.stringContaining(".attempt.2.v1"),
      expect.stringContaining(".attempt.3.v1"),
    ]);
  });

  it("rejects replay metadata whose stored response integrity no longer verifies", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const save = command(fixture, {
      idempotencyKey: "tampered-replay",
      payload: { "profile.short_description": "Integrity-protected draft." },
      dirtyFields: ["profile.short_description"],
    });
    expect((await repository.saveStepDraft(save)).ok).toBe(true);

    const original = await client.query<{ responseBodyHash: string }>(
      `SELECT response_body_hash AS "responseBodyHash"
       FROM platform.idempotency_keys
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    await client.query(
      `UPDATE platform.idempotency_keys
       SET response_body_hash = repeat('0', 64)
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    await expect(repository.saveStepDraft(save)).resolves.toEqual({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });

    await client.query(
      `UPDATE platform.idempotency_keys
       SET response_body_hash = $2,
           idempotency_metadata = 'null'::jsonb
       WHERE property_id = $1::uuid`,
      [fixture.propertyId, original.rows[0]!.responseBodyHash],
    );
    await expect(repository.saveStepDraft(save)).resolves.toEqual({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
  });

  it("isolates the same idempotency key across authorized organizations", async () => {
    const owner = await createFixture(["hotel_operations"]);
    const operator = await createFixture(["hotel_operations"]);
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'operator', 'active')`,
      [operator.organizationId, owner.propertyId],
    );
    const operatorScope = { ...operator, propertyId: owner.propertyId };
    const idempotencyKey = "shared-raw-key";

    const [ownerResult, operatorResult] = await Promise.all([
      repository.saveStepDraft(command(owner, { idempotencyKey })),
      repository.saveStepDraft(command(operatorScope, { idempotencyKey })),
    ]);
    expect(ownerResult.ok).toBe(true);
    expect(operatorResult.ok).toBe(true);

    const persisted = await client.query<{ sessions: number; idempotencyKeys: number }>(
      `SELECT
         (SELECT count(*)::integer
          FROM hotel_catalog.property_setup_sessions
          WHERE property_id = $1::uuid) AS sessions,
         (SELECT count(*)::integer
          FROM platform.idempotency_keys
          WHERE property_id = $1::uuid) AS "idempotencyKeys"`,
      [owner.propertyId],
    );
    expect(persisted.rows).toEqual([{ sessions: 2, idempotencyKeys: 2 }]);
  });

  it("rolls back session, draft, idempotency, and audit when finalization fails", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const failingPool = createInterceptingPool((text) => {
      if (text.includes("INSERT INTO platform.product_audit_events")) {
        throw new Error("forced audit failure");
      }
    });
    const failingRepository = createPgPropertySetupDraftCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: failingPool,
      now: () => new Date(occurredAt),
    });

    try {
      await expect(
        failingRepository.saveStepDraft(
          command(fixture, {
            idempotencyKey: "rollback-after-draft-write",
            payload: { "profile.short_description": "This transaction must roll back." },
            dirtyFields: ["profile.short_description"],
          }),
        ),
      ).rejects.toThrow("forced audit failure");
    } finally {
      await failingRepository.close();
      await failingPool.end();
    }

    const persisted = await client.query<{
      sessions: number;
      drafts: number;
      idempotencyKeys: number;
      audits: number;
    }>(
      `SELECT
         (SELECT count(*)::integer
          FROM hotel_catalog.property_setup_sessions
          WHERE property_id = $1::uuid) AS sessions,
         (SELECT count(*)::integer
          FROM hotel_catalog.property_setup_step_drafts draft
          JOIN hotel_catalog.property_setup_sessions setup ON setup.id = draft.session_id
          WHERE setup.property_id = $1::uuid) AS drafts,
         (SELECT count(*)::integer
          FROM platform.idempotency_keys
          WHERE property_id = $1::uuid) AS "idempotencyKeys",
         (SELECT count(*)::integer
          FROM platform.product_audit_events
          WHERE property_id = $1::uuid) AS audits`,
      [fixture.propertyId],
    );
    expect(persisted.rows).toEqual([{ sessions: 0, drafts: 0, idempotencyKeys: 0, audits: 0 }]);
  });

  it("returns explicit optimistic conflicts without overwriting", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const created = await repository.saveStepDraft(
      command(fixture, {
        idempotencyKey: "conflict-seed",
        payload: { "profile.short_description": "Original draft value." },
        dirtyFields: ["profile.short_description"],
      }),
    );
    expect(created.ok).toBe(true);

    const conflicts = [
      {
        overrides: {
          idempotencyKey: "track-conflict",
          expectedTrackRevision: 0,
          expectedSessionRevision: 1,
          expectedDraftRevision: 1,
        },
        expected: {
          ok: false,
          error: { code: "track_revision_conflict", currentTrackRevision: 1 },
        },
      },
      {
        overrides: {
          idempotencyKey: "session-conflict",
          expectedSessionRevision: 0,
          expectedDraftRevision: 1,
        },
        expected: {
          ok: false,
          error: { code: "session_revision_conflict", currentSessionRevision: 1 },
        },
      },
      {
        overrides: {
          idempotencyKey: "draft-conflict",
          expectedSessionRevision: 1,
          expectedDraftRevision: 0,
        },
        expected: {
          ok: false,
          error: { code: "draft_revision_conflict", currentDraftRevision: 1 },
        },
      },
    ] satisfies Array<{ overrides: CommandOverrides; expected: unknown }>;

    for (const { overrides, expected } of conflicts) {
      await expect(repository.saveStepDraft(command(fixture, overrides))).resolves.toEqual(
        expected,
      );
    }
    const cachedConflict = conflicts[2]!;
    await expect(
      repository.saveStepDraft(command(fixture, cachedConflict.overrides)),
    ).resolves.toEqual(cachedConflict.expected);
    const conflictAuditCount = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid`,
      [fixture.propertyId],
    );
    expect(conflictAuditCount.rows).toEqual([{ count: 4 }]);

    const stored = await client.query<{ payload: Record<string, unknown>; revision: number }>(
      `SELECT draft.payload, draft.revision
       FROM hotel_catalog.property_setup_step_drafts draft
       JOIN hotel_catalog.property_setup_sessions setup ON setup.id = draft.session_id
       WHERE setup.organization_id = $1::uuid
         AND setup.property_id = $2::uuid
         AND draft.step_id = 'present_hotel'`,
      [fixture.organizationId, fixture.propertyId],
    );
    expect(stored.rows).toEqual([
      {
        payload: { "profile.short_description": "Original draft value." },
        revision: 1,
      },
    ]);
  });

  it("stores a stale source manifest without reading canonical revision fields", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    await client.query(
      `UPDATE hotel_catalog.properties
       SET profile_revision = 8
       WHERE id = $1::uuid`,
      [fixture.propertyId],
    );
    const observedQueries: string[] = [];
    const observedPool = createInterceptingPool((text) => {
      observedQueries.push(text);
    });
    const manifestRepository = createPgPropertySetupDraftCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: observedPool,
      now: () => new Date(occurredAt),
    });

    try {
      await expect(
        manifestRepository.saveStepDraft(
          command(fixture, {
            idempotencyKey: "canonical-drift-does-not-block-draft",
            payload: { "profile.short_description": "Keep this work in progress." },
            dirtyFields: ["profile.short_description"],
          }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        receipt: { sessionRevision: 1, draftRevision: 1, replayed: false },
      });
    } finally {
      await manifestRepository.close();
      await observedPool.end();
    }
    expect(observedQueries.some((text) => text.includes("profile_revision"))).toBe(false);

    const stored = await client.query<{ baseRevisions: Record<string, string> }>(
      `SELECT draft.base_revisions AS "baseRevisions"
       FROM hotel_catalog.property_setup_step_drafts draft
       JOIN hotel_catalog.property_setup_sessions setup ON setup.id = draft.session_id
       WHERE setup.organization_id = $1::uuid
         AND setup.property_id = $2::uuid
         AND draft.step_id = 'present_hotel'`,
      [fixture.organizationId, fixture.propertyId],
    );
    expect(stored.rows).toEqual([{ baseRevisions: PRESENT_BASE }]);
  });

  it("rejects inactive steps and revoked access before replay", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const marketplace = command(fixture, {
      idempotencyKey: "inactive-marketplace",
      stepId: "marketplace_preferences",
      payload: {},
      dirtyFields: [],
      expectedBaseRevisions: {
        "marketplace.collaboration_preferences": "preferences:1",
      },
    });
    await expect(repository.saveStepDraft(marketplace)).resolves.toEqual({
      ok: false,
      error: { code: "inactive_setup_step", currentTrackRevision: 1 },
    });

    const initial = command(fixture, {
      idempotencyKey: "revoked-replay",
      payload: { "profile.short_description": "Do not disclose this draft." },
      dirtyFields: ["profile.short_description"],
    });
    expect((await repository.saveStepDraft(initial)).ok).toBe(true);
    await client.query(
      `UPDATE identity.organization_resource_links
       SET status = 'archived'
       WHERE organization_id = $1::uuid
         AND product = 'hotel_catalog'
         AND resource_id = $2::uuid::text`,
      [fixture.organizationId, fixture.propertyId],
    );

    await expect(repository.saveStepDraft(initial)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await client.query(
      `UPDATE identity.organization_resource_links
       SET status = 'active'
       WHERE organization_id = $1::uuid
         AND product = 'hotel_catalog'
         AND resource_id = $2::uuid::text`,
      [fixture.organizationId, fixture.propertyId],
    );
    await expect(repository.saveStepDraft(initial)).resolves.toMatchObject({
      ok: true,
      receipt: { replayed: true },
    });
  });

  it("fails closed across tenant and authorization lifecycle boundaries", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const other = await createFixture(["hotel_operations"]);
    await expect(
      repository.saveStepDraft({
        ...command(fixture, { idempotencyKey: "wrong-property-tenant" }),
        propertyId: other.propertyId,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });

    let denial = 0;
    const expectDeniedAfter = async (
      apply: () => Promise<unknown>,
      restore: () => Promise<unknown>,
    ) => {
      await apply();
      try {
        await expect(
          repository.saveStepDraft(
            command(fixture, { idempotencyKey: `authorization-denial-${denial++}` }),
          ),
        ).resolves.toEqual({
          ok: false,
          error: { code: "setup_scope_unavailable" },
        });
      } finally {
        await restore();
      }
    };

    await expectDeniedAfter(
      () =>
        client.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1::uuid", [
          fixture.actorUserId,
        ]),
      () =>
        client.query("UPDATE identity.users SET status = 'active' WHERE id = $1::uuid", [
          fixture.actorUserId,
        ]),
    );
    await expectDeniedAfter(
      () =>
        client.query("UPDATE identity.organizations SET status = 'suspended' WHERE id = $1::uuid", [
          fixture.organizationId,
        ]),
      () =>
        client.query("UPDATE identity.organizations SET status = 'active' WHERE id = $1::uuid", [
          fixture.organizationId,
        ]),
    );
    await expectDeniedAfter(
      () =>
        client.query(
          `UPDATE identity.organization_memberships
           SET status = 'suspended'
           WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
          [fixture.organizationId, fixture.actorUserId],
        ),
      () =>
        client.query(
          `UPDATE identity.organization_memberships
           SET status = 'active'
           WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
          [fixture.organizationId, fixture.actorUserId],
        ),
    );
    await expectDeniedAfter(
      () =>
        client.query(
          `UPDATE identity.organization_resource_links
           SET relationship = 'front_desk'
           WHERE organization_id = $1::uuid
             AND product = 'hotel_catalog'
             AND resource_id = $2::uuid::text`,
          [fixture.organizationId, fixture.propertyId],
        ),
      () =>
        client.query(
          `UPDATE identity.organization_resource_links
           SET relationship = 'owner'
           WHERE organization_id = $1::uuid
             AND product = 'hotel_catalog'
             AND resource_id = $2::uuid::text`,
          [fixture.organizationId, fixture.propertyId],
        ),
    );
    await expectDeniedAfter(
      () =>
        client.query(
          `UPDATE identity.organization_memberships
           SET role_key = 'front_desk'
           WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
          [fixture.organizationId, fixture.actorUserId],
        ),
      () =>
        client.query(
          `UPDATE identity.organization_memberships
           SET role_key = 'hotel_owner'
           WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
          [fixture.organizationId, fixture.actorUserId],
        ),
    );

    const roleKey = `draft_command_${randomUUID().replaceAll("-", "")}`;
    roleKeys.push(roleKey);
    await client.query(
      `INSERT INTO identity.role_permission_grants (
         organization_kind, role_key, permission_key
       )
       VALUES ('hotel_group', $1, 'hotel_catalog.setup.manage')`,
      [roleKey],
    );
    await client.query(
      `UPDATE identity.organization_memberships
       SET role_key = $3
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [fixture.organizationId, fixture.actorUserId, roleKey],
    );
    await expectDeniedAfter(
      () =>
        client.query(
          `DELETE FROM identity.role_permission_grants
           WHERE organization_kind = 'hotel_group'
             AND role_key = $1
             AND permission_key = 'hotel_catalog.setup.manage'`,
          [roleKey],
        ),
      () =>
        client.query(
          `INSERT INTO identity.role_permission_grants (
             organization_kind, role_key, permission_key
           )
           VALUES ('hotel_group', $1, 'hotel_catalog.setup.manage')
           ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING`,
          [roleKey],
        ),
    );

    const lockTimeoutUrl = new URL(TEST_DATABASE_URL!);
    lockTimeoutUrl.searchParams.set("options", "-c lock_timeout=200ms");
    const revoker = new pg.Client({ connectionString: TEST_DATABASE_URL });
    const lockingPool = createInterceptingPool(() => undefined, lockTimeoutUrl.toString());
    const lockingRepository = createPgPropertySetupDraftCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: lockingPool,
      now: () => new Date(occurredAt),
    });
    await revoker.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(
        `DELETE FROM identity.role_permission_grants
         WHERE organization_kind = 'hotel_group'
           AND role_key = $1
           AND permission_key = 'hotel_catalog.setup.manage'`,
        [roleKey],
      );
      await expect(
        lockingRepository.saveStepDraft(
          command(fixture, { idempotencyKey: "authorization-concurrent-revocation" }),
        ),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await revoker.query("ROLLBACK");
      await revoker.end();
      await lockingRepository.close();
      await lockingPool.end();
    }

    const persisted = await client.query<{ sessions: number; idempotencyKeys: number }>(
      `SELECT
         (SELECT count(*)::integer
          FROM hotel_catalog.property_setup_sessions
          WHERE property_id = $1::uuid) AS sessions,
         (SELECT count(*)::integer
          FROM platform.idempotency_keys
          WHERE property_id IN ($1::uuid, $2::uuid)) AS "idempotencyKeys"`,
      [fixture.propertyId, other.propertyId],
    );
    expect(persisted.rows).toEqual([{ sessions: 0, idempotencyKeys: 0 }]);
  });

  it("does not resurrect expired state unless the client starts from revision zero", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const initial = command(fixture, {
      idempotencyKey: "expiry-seed",
      payload: { "profile.short_description": "An expiring draft." },
      dirtyFields: ["profile.short_description"],
    });
    const created = await repository.saveStepDraft(initial);
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? created.receipt.sessionId : "";

    await client.query(
      `UPDATE hotel_catalog.property_setup_sessions
       SET created_at = '2026-04-01T14:00:00.000Z',
           updated_at = '2026-04-29T14:00:00.000Z',
           retention_expires_at = '2026-07-28T14:00:00.000Z'
       WHERE id = $1::uuid`,
      [sessionId],
    );
    await expect(
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "expired-stale",
          expectedSessionRevision: 1,
          expectedDraftRevision: 1,
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "setup_session_expired", currentSessionRevision: 1 },
    });

    const restarted = await repository.saveStepDraft(
      command(fixture, {
        idempotencyKey: "expired-restart",
        payload: { "profile.short_description": "A restarted draft." },
        dirtyFields: ["profile.short_description"],
      }),
    );
    expect(restarted).toMatchObject({
      ok: true,
      receipt: {
        sessionId: expect.not.stringMatching(sessionId),
        sessionRevision: 1,
        draftRevision: 1,
      },
    });
  });

  it("requires revision zero to replace an independently expired step draft", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const created = await repository.saveStepDraft(
      command(fixture, {
        idempotencyKey: "draft-expiry-seed",
        payload: { "profile.short_description": "An independently expiring draft." },
        dirtyFields: ["profile.short_description"],
      }),
    );
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? created.receipt.sessionId : "";
    await client.query(
      `UPDATE hotel_catalog.property_setup_step_drafts
       SET created_at = '2026-04-01T14:00:00.000Z',
           updated_at = '2026-04-29T14:00:00.000Z',
           retention_expires_at = '2026-07-28T14:00:00.000Z'
       WHERE session_id = $1::uuid
         AND step_id = 'present_hotel'`,
      [sessionId],
    );

    await expect(
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "draft-expiry-stale",
          expectedSessionRevision: 1,
          expectedDraftRevision: 1,
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "setup_draft_expired", currentDraftRevision: 1 },
    });
    await expect(
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "draft-expiry-restart",
          payload: { "profile.short_description": "Replacement draft." },
          dirtyFields: ["profile.short_description"],
          expectedSessionRevision: 1,
          expectedDraftRevision: 0,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      receipt: { sessionId, sessionRevision: 2, draftRevision: 1 },
    });
  });

  it("allows only one concurrent revision-zero save to create the session", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const [left, right] = await Promise.all([
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "concurrent-left",
          payload: { "profile.short_description": "Left draft." },
          dirtyFields: ["profile.short_description"],
        }),
      ),
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "concurrent-right",
          payload: { "profile.short_description": "Right draft." },
          dirtyFields: ["profile.short_description"],
        }),
      ),
    ]);

    expect([left, right].filter(({ ok }) => ok)).toHaveLength(1);
    expect([left, right].filter(({ ok }) => !ok)).toEqual([
      {
        ok: false,
        error: { code: "session_revision_conflict", currentSessionRevision: 1 },
      },
    ]);
  });

  it("resets only the CAS-matched draft and exactly replays without rebasing history", async () => {
    const fixture = await createFixture(["hotel_operations", "creator_marketplace"]);
    const canonicalBefore = await canonicalStep1State(fixture.propertyId);
    const present = await repository.saveStepDraft(
      command(fixture, {
        idempotencyKey: "reset-preserve-present",
        payload: { "profile.short_description": "Preserve this draft." },
        dirtyFields: ["profile.short_description"],
      }),
    );
    expect(present.ok).toBe(true);
    const sessionId = present.ok ? present.receipt.sessionId : "";
    expect(
      (
        await repository.saveStepDraft(
          command(fixture, {
            idempotencyKey: "reset-preserve-marketplace",
            stepId: "marketplace_preferences",
            expectedBaseRevisions: {
              "marketplace.collaboration_preferences": "preferences:3",
            },
            expectedSessionRevision: 1,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await repository.saveStepDraft(
          command(fixture, {
            idempotencyKey: "reset-target-rooms",
            stepId: "rooms",
            expectedBaseRevisions: ROOM_BASE,
            expectedSessionRevision: 2,
          }),
        )
      ).ok,
    ).toBe(true);
    await client.query(
      `UPDATE hotel_catalog.organization_setup_track_intents
       SET selected_tracks = ARRAY['hotel_operations']::text[], revision = 2
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId],
    );

    const reset = resetCommand(fixture, {
      idempotencyKey: "rooms-reload-latest",
      sessionId,
      stepId: "rooms",
      expectedTrackRevision: 2,
      expectedSessionRevision: 3,
      expectedDraftRevision: 1,
      expectedBaseRevisions: ROOM_BASE,
    });
    await expect(
      repository.resetStepDraft({
        ...reset,
        idempotencyKey: "rooms-stale-history",
        request: {
          ...reset.request,
          expectedBaseRevisions: { ...ROOM_BASE, "pms.room_media": "room-media:5" },
        } as ResetPropertySetupDraftRequest,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "draft_base_revision_conflict" } });
    const discarded = await repository.resetStepDraft(reset);
    expect(discarded).toEqual({
      ok: true,
      receipt: {
        contractVersion: "property-setup-draft-reset.v1",
        operation: "reset_step_draft",
        sessionId,
        stepId: "rooms",
        trackRevision: 2,
        sessionRevision: 4,
        discardedDraftRevision: 1,
        resetAt: occurredAt,
        nextRead: {
          method: "GET",
          href: `/api/hotel-setup/properties/${fixture.propertyId}/route`,
        },
      },
    });
    await client.query(
      `UPDATE hotel_catalog.organization_setup_track_intents
       SET selected_tracks = ARRAY['creator_marketplace']::text[], revision = 3
       WHERE organization_id = $1::uuid`,
      [fixture.organizationId],
    );
    await expect(repository.resetStepDraft(reset)).resolves.toEqual(discarded);
    await client.query(
      `UPDATE identity.organization_memberships
       SET status = 'suspended'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [fixture.organizationId, fixture.actorUserId],
    );
    await expect(repository.resetStepDraft(reset)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await client.query(
      `UPDATE identity.organization_memberships
       SET status = 'active'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [fixture.organizationId, fixture.actorUserId],
    );
    await expect(repository.resetStepDraft(reset)).resolves.toEqual(discarded);
    await expect(
      repository.resetStepDraft({
        ...reset,
        request: {
          ...reset.request,
          expectedBaseRevisions: { ...ROOM_BASE, "pms.room_media": "room-media:5" },
        } as ResetPropertySetupDraftRequest,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });

    const state = await client.query<{
      revision: number;
      selectedTracks: string[];
      trackRevision: number;
      resumeStepId: string | null;
      completedStepIds: string[];
      stepIds: string[];
    }>(
      `SELECT
         setup.revision,
         setup.selected_tracks AS "selectedTracks",
         setup.track_revision AS "trackRevision",
         setup.resume_step_id AS "resumeStepId",
         setup.completed_step_ids AS "completedStepIds",
         COALESCE(array_agg(draft.step_id ORDER BY draft.step_id)
           FILTER (WHERE draft.step_id IS NOT NULL), '{}'::text[]) AS "stepIds"
       FROM hotel_catalog.property_setup_sessions setup
       LEFT JOIN hotel_catalog.property_setup_step_drafts draft ON draft.session_id = setup.id
       WHERE setup.id = $1::uuid
       GROUP BY setup.id`,
      [sessionId],
    );
    expect(state.rows).toEqual([
      {
        revision: 4,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        trackRevision: 1,
        resumeStepId: "rooms",
        completedStepIds: [],
        stepIds: ["marketplace_preferences", "present_hotel"],
      },
    ]);
    await expect(
      client.query(
        `SELECT selected_tracks AS "selectedTracks", revision
         FROM hotel_catalog.organization_setup_track_intents
         WHERE organization_id = $1::uuid`,
        [fixture.organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ selectedTracks: ["creator_marketplace"], revision: 3 }],
    });
    await expect(canonicalStep1State(fixture.propertyId)).resolves.toEqual(canonicalBefore);

    const audits = await client.query<{
      redactedPayload: Record<string, unknown>;
      privatePayload: Record<string, unknown>;
      auditMetadata: Record<string, unknown>;
    }>(
      `SELECT
         redacted_payload AS "redactedPayload",
         private_payload AS "privatePayload",
         audit_metadata AS "auditMetadata"
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid
         AND action = 'hotel_setup.property_draft.reset'`,
      [fixture.propertyId],
    );
    expect(audits.rows).toHaveLength(2);
    const recorded = JSON.stringify(audits.rows);
    expect(recorded).not.toContain("room-types:9");
    expect(recorded).not.toContain("pms.room_types");
    expect(
      audits.rows.every(({ privatePayload }) => Object.keys(privatePayload).length === 0),
    ).toBe(true);
  });

  it("serializes a reset race with a newer edit so exactly one CAS command wins", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const created = await repository.saveStepDraft(
      command(fixture, {
        idempotencyKey: "reset-race-seed",
        payload: { "profile.short_description": "Original draft." },
        dirtyFields: ["profile.short_description"],
      }),
    );
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? created.receipt.sessionId : "";

    const [resetResult, saveResult] = await Promise.all([
      repository.resetStepDraft(
        resetCommand(fixture, {
          idempotencyKey: "reset-race-discard",
          sessionId,
          expectedSessionRevision: 1,
          expectedDraftRevision: 1,
          expectedBaseRevisions: PRESENT_BASE,
        }),
      ),
      repository.saveStepDraft(
        command(fixture, {
          idempotencyKey: "reset-race-newer-edit",
          payload: { "profile.short_description": "Newer draft edit." },
          dirtyFields: ["profile.short_description"],
          expectedSessionRevision: 1,
          expectedDraftRevision: 1,
        }),
      ),
    ]);

    expect([resetResult, saveResult].filter(({ ok }) => ok)).toHaveLength(1);
    expect([resetResult, saveResult].filter(({ ok }) => !ok)).toEqual([
      { ok: false, error: { code: "session_revision_conflict", currentSessionRevision: 2 } },
    ]);
    const stored = await client.query<{ revision: number; payload: Record<string, unknown> }>(
      `SELECT draft.revision, draft.payload
       FROM hotel_catalog.property_setup_step_drafts draft
       WHERE draft.session_id = $1::uuid AND draft.step_id = 'present_hotel'`,
      [sessionId],
    );
    expect(stored.rows).toEqual(
      resetResult.ok
        ? []
        : [{ revision: 2, payload: { "profile.short_description": "Newer draft edit." } }],
    );
  });

  it("rolls back the draft deletion, session revision, idempotency, and audit together", async () => {
    const fixture = await createFixture(["hotel_operations"]);
    const created = await repository.saveStepDraft(
      command(fixture, { idempotencyKey: "reset-rollback-seed" }),
    );
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? created.receipt.sessionId : "";
    const failingPool = createInterceptingPool((text) => {
      if (text.includes("INSERT INTO platform.product_audit_events")) {
        throw new Error("forced reset audit failure");
      }
    });
    const failingRepository = createPgPropertySetupDraftCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: failingPool,
      now: () => new Date(occurredAt),
    });

    try {
      await expect(
        failingRepository.resetStepDraft(
          resetCommand(fixture, {
            idempotencyKey: "reset-rollback",
            sessionId,
            expectedSessionRevision: 1,
            expectedDraftRevision: 1,
            expectedBaseRevisions: PRESENT_BASE,
          }),
        ),
      ).rejects.toThrow("forced reset audit failure");
    } finally {
      await failingRepository.close();
      await failingPool.end();
    }

    const persisted = await client.query<{
      revision: number;
      drafts: number;
      resetKeys: number;
      resetAudits: number;
    }>(
      `SELECT
         setup.revision,
         (SELECT count(*)::integer
          FROM hotel_catalog.property_setup_step_drafts draft
          WHERE draft.session_id = setup.id) AS drafts,
         (SELECT count(*)::integer
          FROM platform.idempotency_keys key
          WHERE key.property_id = setup.property_id
            AND key.operation = 'hotel_setup.property_draft.reset') AS "resetKeys",
         (SELECT count(*)::integer
          FROM platform.product_audit_events audit
          WHERE audit.property_id = setup.property_id
            AND audit.action = 'hotel_setup.property_draft.reset') AS "resetAudits"
       FROM hotel_catalog.property_setup_sessions setup
       WHERE setup.id = $1::uuid`,
      [sessionId],
    );
    expect(persisted.rows).toEqual([{ revision: 1, drafts: 1, resetKeys: 0, resetAudits: 0 }]);
  });

  async function createFixture(selectedTracks: string[]) {
    const fixture = {
      actorUserId: randomUUID(),
      organizationId: randomUUID(),
      propertyId: randomUUID(),
    };
    userIds.push(fixture.actorUserId);
    organizationIds.push(fixture.organizationId);
    propertyIds.push(fixture.propertyId);
    await client.query(
      `INSERT INTO identity.users (id, email, status)
       VALUES ($1::uuid, $2, 'active')`,
      [fixture.actorUserId, `${fixture.actorUserId}@example.test`],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Draft Command Test', $2, 'active')`,
      [fixture.organizationId, `draft-command-${fixture.organizationId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key
       )
       VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner')`,
      [fixture.organizationId, fixture.actorUserId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name, profile_revision)
       VALUES ($1::uuid, $2, 'Draft Command Test', 7)`,
      [fixture.propertyId, `draft-command-${fixture.propertyId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active')`,
      [fixture.organizationId, fixture.propertyId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.organization_setup_track_intents (
         organization_id, selected_tracks, revision
       )
       VALUES ($1::uuid, $2::text[], 1)`,
      [fixture.organizationId, selectedTracks],
    );
    return fixture;
  }

  async function canonicalStep1State(propertyId: string) {
    const result = await client.query<{
      defaultLocale: string;
      profileStatus: string;
      profileRevision: number;
      profileCount: number;
    }>(
      `SELECT
         property.default_locale AS "defaultLocale",
         property.profile_status AS "profileStatus",
         property.profile_revision::integer AS "profileRevision",
         (
           SELECT count(*)::integer
           FROM hotel_catalog.property_profiles profile
           WHERE profile.property_id = property.id
         ) AS "profileCount"
       FROM hotel_catalog.properties property
       WHERE property.id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0];
  }
});

type Fixture = {
  actorUserId: string;
  organizationId: string;
  propertyId: string;
};

type CommandOverrides = Partial<Omit<SavePropertySetupDraftRequest, "stepId">> & {
  idempotencyKey: string;
  stepId?: SavePropertySetupDraftRequest["stepId"];
};

type ResetCommandOverrides = Partial<Omit<ResetPropertySetupDraftRequest, "stepId">> & {
  idempotencyKey: string;
  sessionId: string;
  stepId?: ResetPropertySetupDraftRequest["stepId"];
};

function command(fixture: Fixture, overrides: CommandOverrides): PropertySetupDraftSaveCommand {
  const expectedBaseRevisions = overrides.expectedBaseRevisions ?? PRESENT_BASE;
  return {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    actorUserId: fixture.actorUserId,
    idempotencyKey: overrides.idempotencyKey,
    audit: {
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: "web",
      receivedAt: occurredAt,
    },
    request: {
      stepId: overrides.stepId ?? "present_hotel",
      payload: overrides.payload ?? {},
      dirtyFields: overrides.dirtyFields ?? [],
      expectedBaseRevisions,
      expectedTrackRevision: overrides.expectedTrackRevision ?? 1,
      expectedSessionRevision: overrides.expectedSessionRevision ?? 0,
      expectedDraftRevision: overrides.expectedDraftRevision ?? 0,
    } as SavePropertySetupDraftRequest,
  };
}

function resetCommand(
  fixture: Fixture,
  overrides: ResetCommandOverrides,
): PropertySetupDraftResetCommand {
  return {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    actorUserId: fixture.actorUserId,
    idempotencyKey: overrides.idempotencyKey,
    audit: {
      requestId: randomUUID(),
      correlationId: randomUUID(),
      source: "web",
      receivedAt: occurredAt,
    },
    request: {
      sessionId: overrides.sessionId,
      stepId: overrides.stepId ?? "present_hotel",
      expectedTrackRevision: overrides.expectedTrackRevision ?? 1,
      expectedSessionRevision: overrides.expectedSessionRevision ?? 1,
      expectedDraftRevision: overrides.expectedDraftRevision ?? 1,
      expectedBaseRevisions: overrides.expectedBaseRevisions ?? PRESENT_BASE,
    } as ResetPropertySetupDraftRequest,
  };
}

function createInterceptingPool(
  onQuery: (text: string) => void,
  connectionString: string = TEST_DATABASE_URL!,
): PropertySetupDraftCommandPool {
  const pool = new pg.Pool({ connectionString });
  return {
    async connect() {
      const connection = await pool.connect();
      return {
        query: async <TRow extends pg.QueryResultRow = pg.QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) => {
          onQuery(text);
          return connection.query<TRow>(text, values as unknown[] | undefined);
        },
        release: () => connection.release(),
      };
    },
    end: () => pool.end(),
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
