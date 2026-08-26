import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgHotelCatalogStep1Repository } from "./hotelCatalogStep1Repository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const userId = "57575757-5757-4757-8757-575757575701";
const organizationId = "57575757-5757-4757-8757-575757575702";
const propertyId = "57575757-5757-4757-8757-575757575703";
const sessionId = "57575757-5757-4757-8757-575757575704";
const mediaId = "57575757-5757-4757-8757-575757575705";
const now = new Date("2026-08-02T12:00:00.000Z");
const summary =
  "A welcoming independent hotel with calm rooms, thoughtful service, and an easy walk to local highlights.";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Hotel Catalog Step 1 command", () => {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createPgHotelCatalogStep1Repository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    now: () => now,
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedFixture();
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("atomically saves locale, summary, reviewed-empty amenities, slug, setup fallback, audit, and outbox", async () => {
    const command = saveCommand("step1-integration-1");

    await expect(prepareAndSave(command)).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        propertyId,
        displayName: "Hôtel Alpenrose & Spa",
        profileRevision: 2,
        supportedLocales: ["de", "en"],
        profile: {
          locale: "de",
          shortDescription: summary,
          publicSlug: "hotel-alpenrose-spa",
          amenities: { reviewed: true, keys: [] },
          media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
        },
        baseRevisions: {
          "hotel_catalog.profile": "profile:2",
          "hotel_catalog.media": "profile:2",
          "hotel_catalog.amenities": "profile:2",
        },
      },
    });

    const canonical = await admin.query<{
      defaultLocale: string;
      supportedLocales: string[];
      profileRevision: string;
      shortDescription: string;
      reviewCount: string;
      amenityCount: string;
      slug: string;
      completedSteps: string[];
      sessionRevision: number;
    }>(
      `SELECT property.default_locale AS "defaultLocale",
              property.supported_locales AS "supportedLocales",
              property.profile_revision::text AS "profileRevision",
              profile.short_description AS "shortDescription",
              (SELECT count(*)::text FROM hotel_catalog.property_amenity_review_state review
               WHERE review.property_id = property.id) AS "reviewCount",
              (SELECT count(*)::text FROM hotel_catalog.property_amenities amenity
               WHERE amenity.property_id = property.id) AS "amenityCount",
              slug.slug,
              session.completed_step_ids AS "completedSteps",
              session.revision AS "sessionRevision"
       FROM hotel_catalog.properties property
       JOIN hotel_catalog.property_profiles profile
         ON profile.property_id = property.id AND profile.locale = property.default_locale
       JOIN hotel_catalog.property_slugs slug
         ON slug.property_id = property.id AND slug.purpose = 'canonical' AND slug.status = 'active'
       JOIN hotel_catalog.property_setup_sessions session
         ON session.property_id = property.id AND session.status = 'active'
       WHERE property.id = $1::uuid`,
      [propertyId],
    );
    expect(canonical.rows[0]).toEqual({
      defaultLocale: "de",
      supportedLocales: ["de", "en"],
      profileRevision: "2",
      shortDescription: summary,
      reviewCount: "1",
      amenityCount: "0",
      slug: "hotel-alpenrose-spa",
      completedSteps: ["present_hotel"],
      sessionRevision: 2,
    });
    await expect(evidenceCounts()).resolves.toEqual({
      idempotency: "1",
      audit: "1",
      domainEvents: "1",
      outbox: "1",
    });

    const payloads = await admin.query<{ eventPayload: unknown; auditPayload: unknown }>(
      `SELECT event.payload AS "eventPayload", audit.redacted_payload AS "auditPayload"
       FROM platform.domain_events event
       JOIN platform.product_audit_events audit ON audit.domain_event_id = event.id
       WHERE event.property_id = $1::uuid`,
      [propertyId],
    );
    expect(JSON.stringify(payloads.rows)).not.toContain(summary);
    expect(payloads.rows[0]).toMatchObject({
      eventPayload: { propertyId, profileRevision: 2, locale: "de", amenityKeys: [] },
      auditPayload: { outcome: "updated", locale: "de", amenityCount: 0, mediaCount: 0 },
    });
  });

  it("durably replays exact requests and rejects a changed request under the same key", async () => {
    const command = saveCommand("step1-integration-replay");
    await expect(prepareAndSave(command)).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", profileRevision: 2 },
    });
    await expect(repository.prepare(command)).resolves.toEqual({
      kind: "result",
      result: {
        ok: true,
        response: { ...successReadModel(), outcome: "idempotent_replay" },
      },
    });
    await expect(repository.prepare(command)).resolves.toMatchObject({
      kind: "result",
      result: { ok: true, response: { outcome: "idempotent_replay", profileRevision: 2 } },
    });
    await expect(
      repository.prepare({
        ...command,
        request: { ...command.request, shortDescription: `${summary} Updated.` },
      }),
    ).resolves.toEqual({
      kind: "result",
      result: { ok: false, error: { code: "idempotency_key_conflict" } },
    });

    await expect(evidenceCounts()).resolves.toEqual({
      idempotency: "1",
      audit: "1",
      domainEvents: "1",
      outbox: "1",
    });
    await expect(readRevision()).resolves.toBe(2);
  });

  it("records a stale-revision rejection without creating a domain event or outbox intent", async () => {
    await admin.query(
      `UPDATE hotel_catalog.properties SET profile_revision = 4 WHERE id = $1::uuid`,
      [propertyId],
    );

    await expect(repository.prepare(saveCommand("step1-integration-stale"))).resolves.toEqual({
      kind: "result",
      result: {
        ok: false,
        error: { code: "profile_revision_conflict", currentRevision: 4 },
      },
    });
    await expect(evidenceCounts()).resolves.toEqual({
      idempotency: "1",
      audit: "1",
      domainEvents: "0",
      outbox: "0",
    });
    const audit = await admin.query<{ action: string; payload: unknown }>(
      `SELECT action, redacted_payload AS payload
       FROM platform.product_audit_events
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    expect(audit.rows).toEqual([
      {
        action: "hotel_catalog.property.step1.rejected",
        payload: expect.objectContaining({ outcome: "profile_revision_conflict" }),
      },
    ]);
  });

  it("reauthorizes even an exact replay", async () => {
    const command = saveCommand("step1-integration-reauthorize");
    await prepareAndSave(command);
    await admin.query(
      `UPDATE identity.organization_memberships
       SET status = 'suspended'
       WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      [organizationId, userId],
    );

    await expect(repository.prepare(command)).resolves.toEqual({
      kind: "result",
      result: { ok: false, error: { code: "property_not_found" } },
    });
  });

  it("reserves the full outer fingerprint before media and fences concurrent claims", async () => {
    const command = saveCommand("step1-integration-prepared-intent");
    const prepared = await repository.prepare(command);
    expect(prepared).toMatchObject({ kind: "prepared" });

    await expect(
      repository.prepare({
        ...command,
        request: { ...command.request, shortDescription: `${summary} Changed.` },
      }),
    ).resolves.toEqual({
      kind: "result",
      result: { ok: false, error: { code: "idempotency_key_conflict" } },
    });
    await expect(repository.prepare(command)).resolves.toEqual({
      kind: "result",
      result: { ok: false, error: { code: "command_in_progress" } },
    });
    if (prepared.kind !== "prepared") throw new Error("Expected a prepared intent");
    await expect(
      repository.save({
        ...command,
        claimToken: prepared.claimToken,
        writeProfileRevision: prepared.state.readModel.profileRevision,
      }),
    ).resolves.toMatchObject({
      ok: true,
      response: { outcome: "updated", profileRevision: 2 },
    });
  });

  it("rejects unrelated revision advancement when recovering a no-media intent", async () => {
    const command = saveCommand("step1-integration-no-media-recovery");
    await expect(repository.prepare(command)).resolves.toMatchObject({
      kind: "prepared",
      mediaRequired: false,
    });
    await admin.query(
      `UPDATE platform.idempotency_keys
       SET locked_until = $2::timestamptz - interval '1 second'
       WHERE operation = 'hotel_catalog.step1.save' AND property_id = $1::uuid`,
      [propertyId, now.toISOString()],
    );
    await admin.query(
      `UPDATE hotel_catalog.properties SET profile_revision = 2 WHERE id = $1::uuid`,
      [propertyId],
    );

    await expect(repository.prepare(command)).resolves.toEqual({
      kind: "result",
      result: {
        ok: false,
        error: { code: "profile_revision_conflict", currentRevision: 2 },
      },
    });
    await expect(evidenceCounts()).resolves.toEqual({
      idempotency: "1",
      audit: "1",
      domainEvents: "0",
      outbox: "0",
    });
  });

  it("queries the same supported locale it reports for legacy unsupported defaults", async () => {
    await admin.query(
      `UPDATE hotel_catalog.properties
       SET default_locale = 'pt', supported_locales = ARRAY['pt', 'de']
       WHERE id = $1::uuid`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_profiles (
         property_id, locale, short_description, source_confidence
       ) VALUES
         ($1::uuid, 'pt', 'Resumo em português que não deve ser rotulado como alemão.', 'verified'),
         ($1::uuid, 'de', 'Deutsche Zusammenfassung für den konsistenten Lesevertrag.', 'verified')`,
      [propertyId],
    );

    await expect(
      repository.getState({ organizationId, propertyId, actorUserId: userId }),
    ).resolves.toMatchObject({
      readModel: {
        supportedLocales: ["de"],
        profile: {
          locale: "de",
          shortDescription: "Deutsche Zusammenfassung für den konsistenten Lesevertrag.",
        },
      },
    });
  });

  it("durably completes typed media failures and replays them without an outbox", async () => {
    const command = commandWithMedia("step1-integration-media-failure");
    const prepared = await repository.prepare(command);
    if (prepared.kind !== "prepared") throw new Error("Expected a prepared media intent");

    await expect(
      repository.completeFailure({
        ...command,
        claimToken: prepared.claimToken,
        error: { code: "media_not_ready", mediaObjectIds: [mediaId] },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "media_not_ready", mediaObjectIds: [mediaId] },
    });
    await expect(repository.prepare(command)).resolves.toEqual({
      kind: "result",
      result: {
        ok: false,
        error: { code: "media_not_ready", mediaObjectIds: [mediaId] },
      },
    });
    await expect(evidenceCounts()).resolves.toEqual({
      idempotency: "1",
      audit: "1",
      domainEvents: "0",
      outbox: "0",
    });
  });

  it("rejects a consistently rehashed malformed terminal payload", async () => {
    const command = commandWithMedia("step1-integration-malformed-replay");
    const prepared = await repository.prepare(command);
    if (prepared.kind !== "prepared") throw new Error("Expected a prepared media intent");
    await repository.completeFailure({
      ...command,
      claimToken: prepared.claimToken,
      error: { code: "media_not_ready", mediaObjectIds: [mediaId] },
    });
    const malformedError = { code: "media_not_ready", mediaObjectIds: ["not-a-uuid"] };
    await admin.query(
      `UPDATE platform.idempotency_keys
       SET idempotency_metadata = $2::jsonb, response_body_hash = $3
       WHERE operation = 'hotel_catalog.step1.save' AND property_id = $1::uuid`,
      [
        propertyId,
        JSON.stringify({ result: { ok: false, error: malformedError } }),
        createHash("sha256").update(JSON.stringify(malformedError)).digest("hex"),
      ],
    );

    await expect(repository.prepare(command)).resolves.toEqual({
      kind: "result",
      result: { ok: false, error: { code: "idempotency_key_conflict" } },
    });
  });

  it("releases the outer lease when the inner media command remains in progress", async () => {
    const command = commandWithMedia("step1-integration-media-in-progress");
    const prepared = await repository.prepare(command);
    if (prepared.kind !== "prepared") throw new Error("Expected a prepared media intent");
    await expect(
      repository.completeFailure({
        ...command,
        claimToken: prepared.claimToken,
        error: { code: "command_in_progress" },
      }),
    ).resolves.toEqual({ ok: false, error: { code: "command_in_progress" } });

    await expect(repository.prepare(command)).resolves.toMatchObject({
      kind: "prepared",
      mediaRequired: true,
    });
    await expect(evidenceCounts()).resolves.toEqual({
      idempotency: "1",
      audit: "0",
      domainEvents: "0",
      outbox: "0",
    });
  });

  async function prepareAndSave(command: ReturnType<typeof saveCommand>) {
    const prepared = await repository.prepare(command);
    if (prepared.kind !== "prepared") return prepared.result;
    return repository.save({
      ...command,
      claimToken: prepared.claimToken,
      writeProfileRevision: prepared.state.readModel.profileRevision,
    });
  }

  async function seedFixture(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'hotel-catalog-step1@example.test', 'Step 1 Owner', 'active')`,
      [userId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Step 1 Group', 'step1-group', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships (
         organization_id, user_id, status, role_key, access_origin, workos_role_slugs
       ) VALUES ($1::uuid, $2::uuid, 'active', 'hotel_owner', 'agency', ARRAY['hotel_owner'])`,
      [organizationId, userId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (
         id, public_id, display_name, default_locale, supported_locales
       ) VALUES ($1::uuid, 'step1-public-id', 'Hôtel Alpenrose & Spa', 'en', ARRAY['en'])`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links (
         organization_id, product, resource_type, resource_id, relationship, status
       ) VALUES ($1::uuid, 'hotel_catalog', 'property', $2, 'owner', 'active')`,
      [organizationId, propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_setup_sessions (
         id, organization_id, property_id, selected_tracks, track_revision,
         resume_step_id, retention_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, ARRAY['hotel_operations'], 1,
         'present_hotel', $4::timestamptz + interval '30 days'
       )`,
      [sessionId, organizationId, propertyId, now.toISOString()],
    );
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        "DELETE FROM hotel_catalog.property_setup_step_drafts WHERE session_id = $1::uuid",
        [sessionId],
      );
      await admin.query(
        "DELETE FROM hotel_catalog.property_setup_sessions WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM hotel_catalog.property_amenity_review_state WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM hotel_catalog.property_amenities WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM hotel_catalog.property_profiles WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM hotel_catalog.property_slugs WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        `DELETE FROM identity.organization_resource_links
         WHERE organization_id = $1::uuid AND resource_id = $2`,
        [organizationId, propertyId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query(
        `DELETE FROM identity.organization_memberships
         WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
        [organizationId, userId],
      );
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [userId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function evidenceCounts() {
    const result = await admin.query<{
      idempotency: string;
      audit: string;
      domainEvents: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM platform.idempotency_keys WHERE property_id = $1::uuid)
           AS idempotency,
         (SELECT count(*)::text FROM platform.product_audit_events WHERE property_id = $1::uuid)
           AS audit,
         (SELECT count(*)::text FROM platform.domain_events WHERE property_id = $1::uuid)
           AS "domainEvents",
         (SELECT count(*)::text FROM platform.outbox_events WHERE property_id = $1::uuid)
           AS outbox`,
      [propertyId],
    );
    return result.rows[0]!;
  }

  async function readRevision(): Promise<number> {
    const result = await admin.query<{ revision: number }>(
      `SELECT profile_revision::integer AS revision
       FROM hotel_catalog.properties WHERE id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0]!.revision;
  }
});

function saveCommand(idempotencyKey: string) {
  return {
    organizationId,
    propertyId,
    actorUserId: userId,
    idempotencyKey,
    audit: {
      requestId: `request-${idempotencyKey}`,
      correlationId: `correlation-${idempotencyKey}`,
      source: "api" as const,
      receivedAt: now.toISOString(),
    },
    request: {
      expectedProfileRevision: 1,
      locale: "de" as const,
      shortDescription: summary,
      amenities: { reviewed: true as const, keys: [] },
      media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
    },
  };
}

function commandWithMedia(idempotencyKey: string) {
  const command = saveCommand(idempotencyKey);
  return {
    ...command,
    request: {
      ...command.request,
      media: { coverMediaObjectId: mediaId, galleryMediaObjectIds: [] },
    },
  };
}

function successReadModel() {
  return {
    contractVersion: "hotel-catalog-step1.v1" as const,
    propertyId,
    displayName: "Hôtel Alpenrose & Spa",
    profileRevision: 2,
    supportedLocales: ["de", "en"] as const,
    profile: {
      locale: "de" as const,
      shortDescription: summary,
      publicSlug: "hotel-alpenrose-spa",
      amenities: { reviewed: true, keys: [] },
      media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
    },
    baseRevisions: {
      "hotel_catalog.profile": "profile:2",
      "hotel_catalog.media": "profile:2",
      "hotel_catalog.amenities": "profile:2",
    },
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
