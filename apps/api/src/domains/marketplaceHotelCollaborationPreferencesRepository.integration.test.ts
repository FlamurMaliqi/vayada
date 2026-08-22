import {
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
  type ReplaceMarketplaceHotelCollaborationPreferencesCommand,
} from "@vayada/domain-marketplace";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgMarketplaceHotelCollaborationPreferencesRepository } from "./marketplaceHotelCollaborationPreferencesRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "a1077000-0000-4000-8000-000000000001";
const organizationId = "a1077000-0000-4000-8000-000000000002";
const propertyId = "a1077000-0000-4000-8000-000000000003";
const otherOrganizationId = "a1077000-0000-4000-8000-000000000004";
const otherPropertyId = "a1077000-0000-4000-8000-000000000005";
const acceptedAt = "2026-08-03T16:00:00.000Z";
const roleKey = "vay1077_marketplace_preferences_integration";
const operation = "marketplace.hotel_collaboration_preferences.replace";
const eventType = "marketplace.hotel_collaboration_preferences.changed";
const auditFailureFunction = "platform.vay1077_fail_preferences_audit";
const auditFailureTrigger = "trg_vay1077_fail_preferences_audit";
const outboxFailureFunction = "platform.vay1077_fail_preferences_outbox";
const outboxFailureTrigger = "trg_vay1077_fail_preferences_outbox";

describe.skipIf(!TEST_DATABASE_URL)(
  "PostgreSQL Marketplace hotel collaboration preference repository",
  () => {
    const admin = new pg.Client({
      connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    });
    let idSequence = 100;
    const repository = createPgMarketplaceHotelCollaborationPreferencesRepository({
      connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
      max: 6,
      now: () => new Date(acceptedAt),
      randomId: () => `a1077000-0000-4000-8000-${String(idSequence++).padStart(12, "0")}`,
    });

    beforeAll(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      await admin.connect();
    });

    beforeEach(async () => {
      await cleanup();
      await seedAuthorizedProfile();
      idSequence = 100;
    });

    afterAll(async () => {
      await repository.close();
      await cleanup();
      await admin.end();
    });

    it("creates revision one, reads exact evidence, and replays without another side effect", async () => {
      await expect(repository.getHotelCollaborationPreferences(scope())).resolves.toMatchObject({
        outcome: "available",
        readModel: { propertyId, revision: 0, sourceRevision: "preferences:0", preferences: null },
      });

      const firstCommand = command("first-write", 0);
      const { expectedRevision: _expectedRevision, ...firstPreferences } = firstCommand.request;
      const first = await repository.replaceHotelCollaborationPreferences(firstCommand);
      expect(first).toMatchObject({
        ok: true,
        response: {
          propertyId,
          revision: 1,
          sourceRevision: "preferences:1",
          preferences: firstPreferences,
          readiness: { status: "ready", source: { revision: "preferences:1" } },
          outcome: "updated",
          acceptedAt,
        },
      });
      await expect(repository.replaceHotelCollaborationPreferences(firstCommand)).resolves.toEqual(
        first,
      );
      await expect(
        repository.replaceHotelCollaborationPreferences(
          command("first-write", 0, { compensationTypes: ["affiliate"] }),
        ),
      ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });

      await expect(sideEffectCounts()).resolves.toEqual({
        aggregate: 1,
        audit: 1,
        event: 1,
        idempotency: 1,
        outbox: 1,
      });
      await expect(repository.getHotelCollaborationPreferences(scope())).resolves.toMatchObject({
        outcome: "available",
        readModel: {
          revision: 1,
          sourceRevision: "preferences:1",
          preferences: {
            compensationTypes: ["free_stay", "paid"],
            contentPlatforms: ["instagram", "youtube"],
            contentTypes: ["post", "photography"],
            availability: { mode: "selected_months", selectedMonths: [1, 12] },
          },
          readiness: { status: "ready", source: { revision: "preferences:1" } },
        },
      });

      const event = await admin.query(
        `SELECT payload, event_metadata AS metadata
         FROM platform.domain_events
         WHERE property_id = $1::uuid AND event_type = $2`,
        [propertyId, eventType],
      );
      const outbox = await admin.query(
        `SELECT destination, payload, outbox_metadata AS metadata
         FROM platform.outbox_events
         WHERE property_id = $1::uuid AND event_type = $2`,
        [propertyId, eventType],
      );
      expect(event.rows[0]).toEqual({
        payload: {
          contractVersion: "marketplace-hotel-collaboration-preferences.v1",
          eventType,
          eventId: "a1077000-0000-4000-8000-000000000100",
          organizationId,
          propertyId,
          preferenceRevision: 1,
          outcome: "updated",
        },
        metadata: { sourceReadRequired: true },
      });
      expect(outbox.rows[0]).toEqual({
        destination: "marketplace.submission-source",
        payload: event.rows[0]?.payload,
        metadata: { sourceReadRequired: true },
      });
      expect(JSON.stringify([event.rows[0], outbox.rows[0]])).not.toContain("compensationTypes");
    });

    it("stores and exactly replays a revision conflict without changing the aggregate", async () => {
      await repository.replaceHotelCollaborationPreferences(command("create", 0));
      const stale = command("stale", 0, { compensationTypes: ["affiliate"] });
      const conflict = await repository.replaceHotelCollaborationPreferences(stale);
      expect(conflict).toEqual({
        ok: false,
        error: { code: "preferences_revision_conflict", currentRevision: 1 },
      });
      await expect(repository.replaceHotelCollaborationPreferences(stale)).resolves.toEqual(
        conflict,
      );
      await expect(sideEffectCounts()).resolves.toEqual({
        aggregate: 1,
        audit: 2,
        event: 1,
        idempotency: 2,
        outbox: 1,
      });
    });

    it("updates by expected revision and persists explicit year-round availability", async () => {
      await repository.replaceHotelCollaborationPreferences(command("create-before-update", 0));
      const update = command("update", 1, {
        compensationTypes: ["affiliate"],
        availability: { mode: "year_round", selectedMonths: [] },
      });
      const updated = await repository.replaceHotelCollaborationPreferences(update);
      expect(updated).toMatchObject({
        ok: true,
        response: {
          revision: 2,
          sourceRevision: "preferences:2",
          preferences: {
            compensationTypes: ["affiliate"],
            availability: { mode: "year_round", selectedMonths: [] },
          },
          readiness: { status: "ready", source: { revision: "preferences:2" } },
          outcome: "updated",
        },
      });
      await expect(repository.replaceHotelCollaborationPreferences(update)).resolves.toEqual(
        updated,
      );
      await expect(sideEffectCounts()).resolves.toEqual({
        aggregate: 1,
        audit: 2,
        event: 2,
        idempotency: 2,
        outbox: 2,
      });
    });

    it("reauthorizes before replay and never exposes missing or wrong-organization scope as revision zero", async () => {
      const replay = command("reauthorize", 0);
      await expect(repository.replaceHotelCollaborationPreferences(replay)).resolves.toMatchObject({
        ok: true,
      });
      await admin.query(
        `UPDATE identity.organization_resource_links SET status = 'suspended'
         WHERE organization_id = $1::uuid AND product = 'marketplace'
           AND resource_type = 'hotel_profile' AND resource_id = $2::uuid::text`,
        [organizationId, propertyId],
      );
      await expect(repository.replaceHotelCollaborationPreferences(replay)).resolves.toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await admin.query(
        `UPDATE identity.organization_resource_links SET status = 'active'
         WHERE organization_id = $1::uuid AND product = 'marketplace'
           AND resource_type = 'hotel_profile' AND resource_id = $2::uuid::text`,
        [organizationId, propertyId],
      );
      await admin.query(
        `UPDATE identity.product_entitlements
         SET resource_product = NULL, resource_type = NULL, resource_id = NULL
         WHERE organization_id = $1::uuid AND product = 'marketplace'
           AND entitlement_key = 'marketplace-hotel-profile'`,
        [organizationId],
      );
      await expect(repository.replaceHotelCollaborationPreferences(replay)).resolves.toMatchObject({
        ok: true,
        response: { revision: 1, outcome: "updated" },
      });
      await expect(repository.getHotelCollaborationPreferences(scope())).resolves.toMatchObject({
        outcome: "available",
        readModel: { revision: 1 },
      });
      await admin.query(
        `UPDATE identity.product_entitlements SET status = 'suspended'
         WHERE organization_id = $1::uuid AND product = 'marketplace'
           AND entitlement_key = 'marketplace-hotel-profile' AND resource_product IS NULL`,
        [organizationId],
      );
      await admin.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status,
            resource_product, resource_type, resource_id)
         VALUES ($1::uuid, 'marketplace', 'marketplace-hotel-profile', 'active',
                 'marketplace', 'hotel_profile', $2::uuid::text)`,
        [organizationId, propertyId],
      );
      await expect(repository.replaceHotelCollaborationPreferences(replay)).resolves.toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      await expect(repository.getHotelCollaborationPreferences(scope())).resolves.toEqual(
        unavailable(),
      );
      await expect(sideEffectCounts()).resolves.toEqual({
        aggregate: 1,
        audit: 1,
        event: 1,
        idempotency: 1,
        outbox: 1,
      });
      await expect(
        repository.getHotelCollaborationPreferences({
          organizationId: otherOrganizationId,
          propertyId,
        }),
      ).resolves.toEqual(unavailable());
      await expect(
        repository.getHotelCollaborationPreferences({
          organizationId,
          propertyId: otherPropertyId,
        }),
      ).resolves.toEqual(unavailable());
    });

    it("serializes concurrent expected-revision writes with one accepted revision", async () => {
      const results = await Promise.all([
        repository.replaceHotelCollaborationPreferences(command("concurrent-a", 0)),
        repository.replaceHotelCollaborationPreferences(
          command("concurrent-b", 0, { compensationTypes: ["affiliate"] }),
        ),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, error: { code: "preferences_revision_conflict", currentRevision: 1 } },
      ]);
      await expect(sideEffectCounts()).resolves.toEqual({
        aggregate: 1,
        audit: 2,
        event: 1,
        idempotency: 2,
        outbox: 1,
      });
    });

    it("rolls back aggregate, event, outbox, audit, and idempotency when audit fails", async () => {
      await installAuditFailureTrigger();
      try {
        await expect(
          repository.replaceHotelCollaborationPreferences(command("audit-failure", 0)),
        ).rejects.toThrow("injected VAY-1077 audit failure");
        await expect(sideEffectCounts()).resolves.toEqual({
          aggregate: 0,
          audit: 0,
          event: 0,
          idempotency: 0,
          outbox: 0,
        });
      } finally {
        await removeAuditFailureTrigger();
      }
    });

    it("rolls back every authoritative write when the required outbox insert fails", async () => {
      await installOutboxFailureTrigger();
      try {
        await expect(
          repository.replaceHotelCollaborationPreferences(command("outbox-failure", 0)),
        ).rejects.toThrow("injected VAY-1077 outbox failure");
        await expect(sideEffectCounts()).resolves.toEqual({
          aggregate: 0,
          audit: 0,
          event: 0,
          idempotency: 0,
          outbox: 0,
        });
      } finally {
        await removeOutboxFailureTrigger();
      }
    });

    function command(
      idempotencyKey: string,
      expectedRevision: number,
      overrides: {
        compensationTypes?: string[];
        availability?: { mode: string; selectedMonths: number[] };
      } = {},
    ): ReplaceMarketplaceHotelCollaborationPreferencesCommand {
      const request = parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
        expectedRevision,
        compensationTypes: overrides.compensationTypes ?? ["paid", "free_stay"],
        contentPlatforms: ["youtube", "instagram"],
        contentTypes: ["photography", "post"],
        availability: overrides.availability ?? {
          mode: "selected_months",
          selectedMonths: [12, 1],
        },
      });
      if (!request) throw new Error("Invalid Marketplace preference command fixture");
      return {
        organizationId,
        propertyId,
        idempotencyKey,
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: `request-${idempotencyKey}`,
          correlationId: "correlation-vay1077",
          requestedAt: acceptedAt,
        },
        request,
      };
    }

    async function seedAuthorizedProfile(): Promise<void> {
      await admin.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1::uuid, 'vay1077-preferences@example.test', 'VAY-1077 Preferences', 'active')`,
        [actorUserId],
      );
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, status)
         VALUES ($1::uuid, 'hotel_group', 'VAY-1077 Preferences', 'vay1077-preferences', 'active')`,
        [organizationId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, 'vay1077-preferences', 'VAY-1077 Preferences')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO marketplace.marketplace_hotel_profiles (property_id, organization_id)
         VALUES ($1::uuid, $2::uuid)`,
        [propertyId, organizationId],
      );
      await admin.query(
        `INSERT INTO identity.organization_memberships
           (organization_id, user_id, status, role_key, access_origin)
         VALUES ($1::uuid, $2::uuid, 'active', $3, 'agency')`,
        [organizationId, actorUserId, roleKey],
      );
      await admin.query(
        `INSERT INTO identity.role_permission_grants
           (organization_kind, role_key, permission_key)
         VALUES ('hotel_group', $1, 'marketplace.profile.manage') ON CONFLICT DO NOTHING`,
        [roleKey],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'marketplace', 'hotel_profile', $2::uuid::text, 'owner', 'active')`,
        [organizationId, propertyId],
      );
      await admin.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status,
            resource_product, resource_type, resource_id)
         VALUES ($1::uuid, 'marketplace', 'marketplace-hotel-profile', 'active',
                 'marketplace', 'hotel_profile', $2::uuid::text)`,
        [organizationId, propertyId],
      );
    }

    async function sideEffectCounts() {
      const result = await admin.query<{
        aggregate: string;
        audit: string;
        event: string;
        idempotency: string;
        outbox: string;
      }>(
        `SELECT
           (SELECT count(*) FROM marketplace.hotel_collaboration_preferences
             WHERE property_id = $1::uuid)::text AS aggregate,
           (SELECT count(*) FROM platform.product_audit_events
             WHERE property_id = $1::uuid AND action LIKE 'marketplace.hotel_collaboration_preferences.%')::text AS audit,
           (SELECT count(*) FROM platform.domain_events
             WHERE property_id = $1::uuid AND event_type = $2)::text AS event,
           (SELECT count(*) FROM platform.idempotency_keys
             WHERE property_id = $1::uuid AND operation = $3)::text AS idempotency,
           (SELECT count(*) FROM platform.outbox_events
             WHERE property_id = $1::uuid AND event_type = $2)::text AS outbox`,
        [propertyId, eventType, operation],
      );
      const row = result.rows[0]!;
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
    }

    async function installAuditFailureTrigger(): Promise<void> {
      await removeAuditFailureTrigger();
      await admin.query(
        `CREATE FUNCTION ${auditFailureFunction}()
         RETURNS trigger LANGUAGE plpgsql AS $function$
         BEGIN
           IF NEW.property_id = '${propertyId}'::uuid
              AND NEW.action = 'marketplace.hotel_collaboration_preferences.updated' THEN
             RAISE EXCEPTION 'injected VAY-1077 audit failure';
           END IF;
           RETURN NEW;
         END;
         $function$`,
      );
      await admin.query(
        `CREATE TRIGGER ${auditFailureTrigger}
         BEFORE INSERT ON platform.product_audit_events
         FOR EACH ROW EXECUTE FUNCTION ${auditFailureFunction}()`,
      );
    }

    async function removeAuditFailureTrigger(): Promise<void> {
      await admin.query(
        `DROP TRIGGER IF EXISTS ${auditFailureTrigger} ON platform.product_audit_events`,
      );
      await admin.query(`DROP FUNCTION IF EXISTS ${auditFailureFunction}()`);
    }

    async function installOutboxFailureTrigger(): Promise<void> {
      await removeOutboxFailureTrigger();
      await admin.query(
        `CREATE FUNCTION ${outboxFailureFunction}()
         RETURNS trigger LANGUAGE plpgsql AS $function$
         BEGIN
           IF NEW.property_id = '${propertyId}'::uuid
              AND NEW.destination = 'marketplace.submission-source' THEN
             RAISE EXCEPTION 'injected VAY-1077 outbox failure';
           END IF;
           RETURN NEW;
         END;
         $function$`,
      );
      await admin.query(
        `CREATE TRIGGER ${outboxFailureTrigger}
         BEFORE INSERT ON platform.outbox_events
         FOR EACH ROW EXECUTE FUNCTION ${outboxFailureFunction}()`,
      );
    }

    async function removeOutboxFailureTrigger(): Promise<void> {
      await admin.query(`DROP TRIGGER IF EXISTS ${outboxFailureTrigger} ON platform.outbox_events`);
      await admin.query(`DROP FUNCTION IF EXISTS ${outboxFailureFunction}()`);
    }

    async function cleanup(): Promise<void> {
      await removeAuditFailureTrigger();
      await removeOutboxFailureTrigger();
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        for (const statement of [
          "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
          "DELETE FROM marketplace.hotel_collaboration_preferences WHERE property_id = $1::uuid",
          "DELETE FROM marketplace.marketplace_hotel_profiles WHERE property_id = $1::uuid",
        ]) {
          await admin.query(statement, [propertyId]);
        }
        await admin.query(
          "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
          [organizationId],
        );
        await admin.query(
          "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
          [organizationId],
        );
        await admin.query(
          "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
          [organizationId],
        );
        await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
        await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
          organizationId,
        ]);
        await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
        await admin.query(
          `DELETE FROM identity.role_permission_grants
           WHERE organization_kind = 'hotel_group' AND role_key = $1`,
          [roleKey],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
  },
);

function scope() {
  return { organizationId, propertyId };
}

function unavailable() {
  return {
    outcome: "unavailable",
    error: { code: "preference_source_unavailable", errorSource: "system", retryable: true },
  };
}

function assertSafeTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!/(^|[_-])test([_-]|$)/i.test(database)) {
    throw new Error(
      "Refusing to run Marketplace preference integration against a non-test database",
    );
  }
}

describe("Marketplace preference integration database guard", () => {
  it.each(["vay1077_test", "vay1077-chain-test", "test"])(
    "accepts explicit test boundary %s",
    (database) => {
      expect(() => assertSafeTestDatabase(`postgresql://localhost/${database}`)).not.toThrow();
    },
  );

  it.each(["latest", "contest_prod", "production"])(
    "rejects unsafe database name %s",
    (database) => {
      expect(() => assertSafeTestDatabase(`postgresql://localhost/${database}`)).toThrow(
        "Refusing to run Marketplace preference integration against a non-test database",
      );
    },
  );
});
