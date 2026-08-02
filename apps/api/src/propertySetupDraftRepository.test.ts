import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  getActivePropertySetupStepIds,
} from "@vayada/domain-hotels";

import {
  createPgPropertySetupDraftRepository,
  type PropertySetupDraftRepository,
  type PropertySetupDraftScope,
} from "./domains/propertySetupDraftRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const readAt = new Date("2026-07-30T12:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("property setup draft PostgreSQL repository", () => {
  let client: pg.Client;
  let repository: PropertySetupDraftRepository;
  let scope: PropertySetupDraftScope;
  let membershipId: string;
  let sessionId: string;

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    repository = createPgPropertySetupDraftRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => readAt,
    });
  });

  beforeEach(async () => {
    scope = {
      actorUserId: randomUUID(),
      organizationId: randomUUID(),
      propertyId: randomUUID(),
      authorizedStepIds: PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId }) => stepId),
    };
    membershipId = randomUUID();
    sessionId = randomUUID();
    await client.query(
      `INSERT INTO identity.users (id, email, status)
       VALUES ($1::uuid, $2, 'active')`,
      [scope.actorUserId, `${scope.actorUserId}@example.test`],
    );
    await client.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Draft Repository Test', $2, 'active')`,
      [scope.organizationId, `draft-test-${scope.organizationId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_memberships (
         id, organization_id, user_id, status, role_key
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', 'hotel_owner')`,
      [membershipId, scope.organizationId, scope.actorUserId],
    );
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'Draft Repository Test')`,
      [scope.propertyId, `draft-test-${scope.propertyId}`],
    );
    await client.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       )
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active')`,
      [scope.organizationId, scope.propertyId],
    );
  });

  afterEach(async () => {
    await client.query(
      "DELETE FROM hotel_catalog.property_setup_sessions WHERE organization_id = $1::uuid",
      [scope.organizationId],
    );
    await client.query(
      "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
      [scope.organizationId],
    );
    await client.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [
      scope.propertyId,
    ]);
    await client.query("DELETE FROM identity.organization_memberships WHERE id = $1::uuid", [
      membershipId,
    ]);
    await client.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
      scope.organizationId,
    ]);
    await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [scope.actorUserId]);
  });

  afterAll(async () => {
    await repository.close();
    await client.end();
  });

  it("uses the current authorized route while retaining hidden-track drafts", async () => {
    await insertSession(["hotel_operations"], "2026-09-30T12:00:00.000Z");
    await insertDraft({
      stepId: "marketplace_preferences",
      payload: {
        "marketplace.preferences.content_types": ["short_form_video"],
      },
      dirtyFields: ["marketplace.preferences.content_types"],
      baseRevisions: {
        "marketplace.collaboration_preferences": "preferences:4",
      },
      revision: 2,
    });
    await insertDraft({
      stepId: "present_hotel",
      payload: {
        "profile.default_locale": "de-DE",
        "profile.short_description": "A quiet hotel beside the old town.",
      },
      dirtyFields: ["profile.default_locale", "profile.short_description"],
      baseRevisions: {
        "hotel_catalog.profile": "profile:7",
        "hotel_catalog.media": "media:2",
        "hotel_catalog.amenities": "amenities:3",
      },
      revision: 3,
    });

    await expect(
      repository.getActiveSession({
        ...scope,
        authorizedStepIds: getActivePropertySetupStepIds(["hotel_operations"]),
      }),
    ).resolves.toEqual({
      contractVersion: "property-setup-draft.v1",
      sessionId,
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      selectedTracks: ["hotel_operations"],
      trackRevision: 2,
      revision: 4,
      resumeStepId: "present_hotel",
      completedStepIds: ["present_hotel"],
      drafts: [
        expect.objectContaining({
          stepId: "present_hotel",
          payload: {
            "profile.default_locale": "de-DE",
            "profile.short_description": "A quiet hotel beside the old town.",
          },
          dirtyFields: ["profile.default_locale", "profile.short_description"],
          baseRevisions: {
            "hotel_catalog.profile": "profile:7",
            "hotel_catalog.media": "media:2",
            "hotel_catalog.amenities": "amenities:3",
          },
          piiClassification: "potential_incidental_pii",
          retentionExpiresAt: "2026-09-30T12:00:00.000Z",
          revision: 3,
          updatedAt: "2026-07-30T12:00:00.000Z",
        }),
      ],
      retentionExpiresAt: "2026-09-30T12:00:00.000Z",
    });

    await expect(
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM hotel_catalog.property_setup_step_drafts
         WHERE session_id = $1::uuid
           AND step_id = 'marketplace_preferences'`,
        [sessionId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });

    // Restoring Marketplace in the current route must reveal the retained
    // draft even though the historical session still records Operations only.
    await expect(repository.getActiveSession(scope)).resolves.toMatchObject({
      selectedTracks: ["hotel_operations"],
      trackRevision: 2,
      drafts: [
        { stepId: "present_hotel" },
        {
          stepId: "marketplace_preferences",
          payload: {
            "marketplace.preferences.content_types": ["short_form_video"],
          },
          dirtyFields: ["marketplace.preferences.content_types"],
          revision: 2,
        },
      ],
    });
  });

  it("resumes a locale-only draft without inferring Step 1 completion or readiness", async () => {
    await insertSession(["hotel_operations"], "2026-09-30T12:00:00.000Z");
    await client.query(
      `UPDATE hotel_catalog.property_setup_sessions
       SET completed_step_ids = '{}'::text[]
       WHERE id = $1::uuid`,
      [sessionId],
    );
    await insertDraft({
      stepId: "present_hotel",
      payload: { "profile.default_locale": "de-DE" },
      dirtyFields: ["profile.default_locale"],
      baseRevisions: {
        "hotel_catalog.profile": "profile:7",
        "hotel_catalog.media": "media:2",
        "hotel_catalog.amenities": "amenities:3",
      },
      revision: 1,
    });

    await expect(repository.getActiveSession(scope)).resolves.toMatchObject({
      resumeStepId: "present_hotel",
      completedStepIds: [],
      drafts: [
        {
          stepId: "present_hotel",
          payload: { "profile.default_locale": "de-DE" },
          dirtyFields: ["profile.default_locale"],
          revision: 1,
        },
      ],
    });
    await expect(
      client.query<{
        defaultLocale: string;
        profileStatus: string;
        profileCount: number;
      }>(
        `SELECT
           property.default_locale AS "defaultLocale",
           property.profile_status AS "profileStatus",
           (
             SELECT count(*)::integer
             FROM hotel_catalog.property_profiles profile
             WHERE profile.property_id = property.id
           ) AS "profileCount"
         FROM hotel_catalog.properties property
         WHERE property.id = $1::uuid`,
        [scope.propertyId],
      ),
    ).resolves.toMatchObject({
      rows: [{ defaultLocale: "en", profileStatus: "incomplete", profileCount: 0 }],
    });
  });

  it("does not disclose active-track state outside the caller's authorized steps", async () => {
    await insertSession(["hotel_operations", "creator_marketplace"], "2026-09-30T12:00:00.000Z");
    await insertDraft({
      stepId: "marketplace_preferences",
      payload: {
        "marketplace.preferences.content_types": ["short_form_video"],
      },
      dirtyFields: ["marketplace.preferences.content_types"],
      baseRevisions: {
        "marketplace.collaboration_preferences": "preferences:4",
      },
      revision: 2,
    });
    await client.query(
      `UPDATE hotel_catalog.property_setup_sessions
       SET resume_step_id = 'marketplace_preferences',
           completed_step_ids = ARRAY['marketplace_preferences']::text[]
       WHERE id = $1::uuid`,
      [sessionId],
    );

    await expect(
      repository.getActiveSession({
        ...scope,
        authorizedStepIds: ["present_hotel"],
      }),
    ).resolves.toMatchObject({
      resumeStepId: null,
      completedStepIds: [],
      drafts: [],
    });
  });

  it("never derives access from a stored session or draft", async () => {
    await insertSession(["creator_marketplace"], "2026-09-30T12:00:00.000Z");
    await insertDraft({
      stepId: "marketplace_preferences",
      payload: {},
      dirtyFields: [],
      baseRevisions: {
        "marketplace.collaboration_preferences": "preferences:1",
      },
      revision: 1,
    });

    await expect(
      repository.getActiveSession({ ...scope, actorUserId: randomUUID() }),
    ).resolves.toBeNull();

    await client.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1::uuid", [
      scope.actorUserId,
    ]);
    await expect(repository.getActiveSession(scope)).resolves.toBeNull();
    await client.query("UPDATE identity.users SET status = 'active' WHERE id = $1::uuid", [
      scope.actorUserId,
    ]);

    await client.query(
      "UPDATE identity.organizations SET status = 'suspended' WHERE id = $1::uuid",
      [scope.organizationId],
    );
    await expect(repository.getActiveSession(scope)).resolves.toBeNull();
    await client.query("UPDATE identity.organizations SET status = 'active' WHERE id = $1::uuid", [
      scope.organizationId,
    ]);

    await client.query(
      "UPDATE identity.organization_memberships SET status = 'suspended' WHERE id = $1::uuid",
      [membershipId],
    );
    await expect(repository.getActiveSession(scope)).resolves.toBeNull();
    await client.query(
      "UPDATE identity.organization_memberships SET status = 'active' WHERE id = $1::uuid",
      [membershipId],
    );
    await client.query(
      `UPDATE identity.organization_resource_links
       SET status = 'archived'
       WHERE organization_id = $1::uuid`,
      [scope.organizationId],
    );
    await expect(repository.getActiveSession(scope)).resolves.toBeNull();

    await client.query(
      `UPDATE identity.organization_resource_links
       SET status = 'active', relationship = 'front_desk'
       WHERE organization_id = $1::uuid`,
      [scope.organizationId],
    );
    await expect(repository.getActiveSession(scope)).resolves.toBeNull();
  });

  it("hides logically expired sessions and step drafts before cleanup runs", async () => {
    await insertSession(["hotel_operations"], "2026-08-30T12:00:00.000Z");
    await insertDraft({
      stepId: "rooms",
      payload: { "room.name": { room_1: "Garden Room" } },
      dirtyFields: ["room.name"],
      baseRevisions: {
        "pms.room_types": "types:1",
        "pms.room_units": "units:1",
        "pms.room_media": "media:1",
      },
      revision: 1,
      retentionExpiresAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-04-30T12:00:00.000Z",
    });
    await expect(repository.getActiveSession(scope)).resolves.toMatchObject({ drafts: [] });

    await client.query(
      `UPDATE hotel_catalog.property_setup_sessions
       SET retention_expires_at = '2026-07-29T12:00:00.000Z',
           updated_at = '2026-04-30T12:00:00.000Z'
       WHERE id = $1::uuid`,
      [sessionId],
    );
    await expect(repository.getActiveSession(scope)).resolves.toBeNull();
  });

  async function insertSession(
    selectedTracks: string[],
    retentionExpiresAt: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO hotel_catalog.property_setup_sessions (
         id, organization_id, property_id, selected_tracks, track_revision,
         revision, resume_step_id, completed_step_ids, retention_expires_at,
         created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::text[], 2,
         4, 'present_hotel', ARRAY['present_hotel']::text[], $5::timestamptz,
         '2026-04-01T12:00:00.000Z', '2026-07-30T12:00:00.000Z'
       )`,
      [sessionId, scope.organizationId, scope.propertyId, selectedTracks, retentionExpiresAt],
    );
  }

  async function insertDraft(input: {
    stepId: string;
    payload: Record<string, unknown>;
    dirtyFields: string[];
    baseRevisions: Record<string, string>;
    revision: number;
    retentionExpiresAt?: string;
    updatedAt?: string;
  }): Promise<void> {
    await client.query(
      `INSERT INTO hotel_catalog.property_setup_step_drafts (
         session_id, step_id, revision, payload, dirty_fields, base_revisions,
         retention_expires_at, created_at, updated_at
       )
       VALUES (
         $1::uuid, $2, $3, $4::jsonb, $5::text[], $6::jsonb,
         $7::timestamptz, '2026-04-01T12:00:00.000Z', $8::timestamptz
       )`,
      [
        sessionId,
        input.stepId,
        input.revision,
        JSON.stringify(input.payload),
        input.dirtyFields,
        JSON.stringify(input.baseRevisions),
        input.retentionExpiresAt ?? "2026-09-30T12:00:00.000Z",
        input.updatedAt ?? "2026-07-30T12:00:00.000Z",
      ],
    );
  }
});

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
