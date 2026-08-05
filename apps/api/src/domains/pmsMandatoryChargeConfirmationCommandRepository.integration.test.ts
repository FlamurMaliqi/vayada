import { createHash } from "node:crypto";

import {
  PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION,
  PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
  PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_DESTINATION,
  PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_METADATA,
  PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
  PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
  parseConfirmMandatoryChargesIncludedCommand,
  parsePmsMandatoryChargePricingSourceFingerprint,
  type ConfirmMandatoryChargesIncludedCommand,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgPmsMandatoryChargeConfirmationCommandRepository,
  type PmsMandatoryChargeConfirmationCommandPool,
} from "./pmsMandatoryChargeConfirmationCommandRepository.js";
import { loadPmsMandatoryChargePricingSourceSnapshot } from "./pmsMandatoryChargePricingSourceSnapshot.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "10810000-0000-4000-8000-000000000001";
const organizationId = "10810000-0000-4000-8000-000000000002";
const propertyId = "10810000-0000-4000-8000-000000000003";
const roomTypeId = "10810000-0000-4000-8000-000000000004";
const planId = "10810000-0000-4000-8000-000000000005";
const acceptedAt = "2026-08-04T12:00:00.000Z";
const roleKey = "vay1081_mandatory_charge_integration";
const auditFailureFunction = "platform.vay1081_fail_mandatory_charge_audit";
const auditFailureTrigger = "trg_vay1081_fail_mandatory_charge_audit";

describe.skipIf(!TEST_DATABASE_URL)(
  "PostgreSQL PMS mandatory-charge confirmation command repository",
  () => {
    const admin = new pg.Client({
      connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    });
    const repository = createPgPmsMandatoryChargeConfirmationCommandRepository({
      connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
      max: 4,
      now: () => new Date(acceptedAt),
    });

    beforeAll(async () => {
      assertSafeTestDatabase(TEST_DATABASE_URL!);
      await admin.connect();
    });

    beforeEach(async () => {
      await cleanup();
      await seedAuthorizedPricingSource();
    });

    afterAll(async () => {
      await repository.close();
      await cleanup();
      await admin.end();
    });

    it("persists immutable evidence and exact secret-safe event, outbox, and audit once", async () => {
      const command = await commandFor("confirm-once", 0);
      const confirmed = await repository.confirmMandatoryChargesIncluded(command);
      expect(confirmed).toEqual({
        ok: true,
        response: {
          contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
          outcome: "confirmed",
          evidence: {
            organizationId,
            propertyId,
            pricingSourceFingerprint: command.claimedPricingSourceFingerprint,
            confirmationRevision: 1,
            confirmedAt: acceptedAt,
          },
          acceptedAt,
        },
      });
      await expect(repository.confirmMandatoryChargesIncluded(command)).resolves.toEqual(confirmed);

      const state = await persistedState();
      expect(state.counts).toEqual({
        confirmations: 1,
        idempotency: 1,
        events: 1,
        outbox: 1,
        audits: 1,
      });
      const expectedPayload = {
        contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
        eventType: PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
        organizationId,
        propertyId,
        confirmationRevision: 1,
        pricingCurrencyRevision: 1,
        optionalPricingAggregateRevision: 0,
        outcome: "confirmed",
      };
      expect(state.event).toEqual({
        eventType: PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
        resourceType: PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
        resourceId: propertyId,
        correlationId: null,
        idempotencyKeyHash: null,
        payload: expectedPayload,
        metadata: {},
      });
      expect(state.outbox).toEqual({
        destination: PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_DESTINATION,
        eventType: PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
        resourceType: PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
        resourceId: propertyId,
        correlationId: null,
        idempotencyKeyHash: null,
        payload: expectedPayload,
        metadata: PMS_MANDATORY_CHARGE_CONFIRMATION_OUTBOX_METADATA,
      });
      expect(state.audit).toEqual({
        action: PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION,
        targetResourceType: PMS_MANDATORY_CHARGE_CONFIRMATION_RESOURCE_TYPE,
        targetResourceId: propertyId,
        correlationId: null,
        causationId: null,
        redactedPayload: {
          contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
          organizationId,
          propertyId,
          confirmationRevision: 1,
          pricingCurrencyRevision: 1,
          optionalPricingAggregateRevision: 0,
          outcome: "confirmed",
        },
        privatePayload: {},
        metadata: {},
      });
      const externalRecords = JSON.stringify([state.event, state.outbox, state.audit]);
      expect(externalRecords).not.toContain(command.claimedPricingSourceFingerprint);
      expect(externalRecords).not.toContain("160.00");
      expect(externalRecords).not.toContain("must-not-leak");
      expect(externalRecords).not.toContain(command.idempotencyKey);
    });

    it("authorizes before replay and excludes a former owner", async () => {
      const command = await commandFor("authorize-replay", 0);
      await expect(repository.confirmMandatoryChargesIncluded(command)).resolves.toMatchObject({
        ok: true,
      });
      await admin.query(
        `UPDATE identity.organization_resource_links SET relationship = 'front_desk'
         WHERE organization_id = $1::uuid AND resource_id = $2::uuid::text`,
        [organizationId, propertyId],
      );
      await expect(repository.confirmMandatoryChargesIncluded(command)).resolves.toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });

      await admin.query(
        `UPDATE identity.organization_resource_links SET relationship = 'owner'
         WHERE organization_id = $1::uuid AND resource_id = $2::uuid::text`,
        [organizationId, propertyId],
      );
      await admin.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status)
         VALUES ($1::uuid, 'pms', 'property-management', 'suspended')`,
        [organizationId],
      );
      await expect(repository.confirmMandatoryChargesIncluded(command)).resolves.toEqual({
        ok: false,
        error: { code: "setup_scope_unavailable" },
      });
      expect((await persistedState()).counts).toEqual({
        confirmations: 1,
        idempotency: 1,
        events: 1,
        outbox: 1,
        audits: 1,
      });
    });

    it("rejects any source drift and binds a key to the exact failed request", async () => {
      const stale = await commandFor("source-drift", 0);
      await admin.query(
        `UPDATE pms.rate_plans
         SET base_rate_amount = 175.00, flexible_rate_plan_revision = 2,
             updated_at = $3::timestamptz
         WHERE property_id = $1::uuid AND id = $2::uuid`,
        [propertyId, planId, acceptedAt],
      );
      const conflict = { ok: false as const, error: { code: "pricing_source_conflict" as const } };
      await expect(repository.confirmMandatoryChargesIncluded(stale)).resolves.toEqual(conflict);
      await expect(repository.confirmMandatoryChargesIncluded(stale)).resolves.toEqual(conflict);

      const currentClaim = await commandFor("source-drift", 0);
      await expect(repository.confirmMandatoryChargesIncluded(currentClaim)).resolves.toEqual({
        ok: false,
        error: { code: "idempotency_key_conflict" },
      });
      expect((await persistedState()).counts).toEqual({
        confirmations: 0,
        idempotency: 1,
        events: 0,
        outbox: 0,
        audits: 0,
      });
    });

    it("distinguishes an unconfigured owner source without emitting side effects", async () => {
      const command = await commandFor("source-unconfigured", 0);
      await admin.query("DELETE FROM pms.rate_plans WHERE property_id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid", [
        propertyId,
      ]);

      await expect(repository.confirmMandatoryChargesIncluded(command)).resolves.toEqual({
        ok: false,
        error: { code: "pricing_source_not_configured" },
      });
      expect((await persistedState()).counts).toEqual({
        confirmations: 0,
        idempotency: 1,
        events: 0,
        outbox: 0,
        audits: 0,
      });
    });

    it("serializes concurrent confirmation CAS under the shared pricing and room-facts guards", async () => {
      const first = await commandFor("concurrent-a", 0);
      const second = await commandFor("concurrent-b", 0);
      const results = await Promise.all([
        repository.confirmMandatoryChargesIncluded(first),
        repository.confirmMandatoryChargesIncluded(second),
      ]);
      expect(results.filter((entry) => entry.ok)).toHaveLength(1);
      expect(results.filter((entry) => !entry.ok)).toEqual([
        {
          ok: false,
          error: { code: "confirmation_revision_conflict", currentRevision: 1 },
        },
      ]);
      expect((await persistedState()).counts).toEqual({
        confirmations: 1,
        idempotency: 2,
        events: 1,
        outbox: 1,
        audits: 1,
      });
    });

    it("collapses concurrent use of the same exact idempotency key to one response", async () => {
      const command = await commandFor("concurrent-same-key", 0);
      const [first, second] = await Promise.all([
        repository.confirmMandatoryChargesIncluded(command),
        repository.confirmMandatoryChargesIncluded(command),
      ]);
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        ok: true,
        response: { evidence: { confirmationRevision: 1 } },
      });
      expect((await persistedState()).counts).toEqual({
        confirmations: 1,
        idempotency: 1,
        events: 1,
        outbox: 1,
        audits: 1,
      });
    });

    it("rejects corrupted completed replay metadata without another side effect", async () => {
      const command = await commandFor("corrupt-replay", 0);
      await expect(repository.confirmMandatoryChargesIncluded(command)).resolves.toMatchObject({
        ok: true,
      });
      await admin.query(
        `UPDATE platform.idempotency_keys SET idempotency_metadata = '{"result":{"ok":true}}'::jsonb
         WHERE property_id = $1::uuid AND operation = $2`,
        [propertyId, PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION],
      );
      await expect(repository.confirmMandatoryChargesIncluded(command)).resolves.toEqual({
        ok: false,
        error: { code: "idempotency_key_conflict" },
      });
      expect((await persistedState()).counts).toEqual({
        confirmations: 1,
        idempotency: 1,
        events: 1,
        outbox: 1,
        audits: 1,
      });
    });

    it("rolls back evidence, idempotency, event, outbox, and audit with a generic error", async () => {
      const command = await commandFor("atomic-failure", 0);
      await installAuditFailureTrigger();
      try {
        await expect(repository.confirmMandatoryChargesIncluded(command)).rejects.toThrow(
          "PMS mandatory-charge confirmation repository failed",
        );
        expect((await persistedState()).counts).toEqual({
          confirmations: 0,
          idempotency: 0,
          events: 0,
          outbox: 0,
          audits: 0,
        });
      } finally {
        await removeAuditFailureTrigger();
      }
    });

    async function commandFor(
      idempotencyKey: string,
      expectedConfirmationRevision: number,
    ): Promise<ConfirmMandatoryChargesIncludedCommand> {
      const source = await loadPmsMandatoryChargePricingSourceSnapshot(
        admin,
        propertyId,
        new Date(acceptedAt),
      );
      if (!source) throw new Error("integration pricing source was not seeded");
      const claimedPricingSourceFingerprint = parsePmsMandatoryChargePricingSourceFingerprint(
        createHash("sha256").update(source.serializedPayload).digest("hex"),
      );
      const parsed = parseConfirmMandatoryChargesIncludedCommand({
        organizationId,
        propertyId,
        expectedConfirmationRevision,
        claimedPricingSourceFingerprint,
        expectedPricingSourceRevisions: source.sourceRevisions,
        idempotencyKey,
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: "request-secret-must-not-leak",
          correlationId: "correlation-secret-must-not-leak",
          requestedAt: acceptedAt,
        },
      });
      if (!parsed) throw new Error("integration confirmation command is invalid");
      return parsed;
    }

    async function seedAuthorizedPricingSource(): Promise<void> {
      await admin.query(
        `INSERT INTO identity.users (id, email, name, status)
         VALUES ($1::uuid, 'vay1081@example.test', 'VAY-1081', 'active')`,
        [actorUserId],
      );
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, status)
         VALUES ($1::uuid, 'hotel_group', 'VAY-1081', 'vay1081', 'active')`,
        [organizationId],
      );
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, 'vay1081', 'VAY-1081')`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO identity.organization_memberships
           (organization_id, user_id, status, role_key)
         VALUES ($1::uuid, $2::uuid, 'active', $3)`,
        [organizationId, actorUserId, roleKey],
      );
      await admin.query(
        `INSERT INTO identity.role_permission_grants
           (organization_kind, role_key, permission_key)
         VALUES ('hotel_group', $1, 'pms.operations.manage')
         ON CONFLICT DO NOTHING`,
        [roleKey],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
        [organizationId, propertyId],
      );
      await admin.query(
        `INSERT INTO identity.product_entitlements
           (organization_id, product, entitlement_key, status,
            resource_product, resource_type, resource_id)
         VALUES ($1::uuid, 'pms', 'property-management', 'active',
                 'pms', 'pms_property', $2::uuid::text)`,
        [organizationId, propertyId],
      );
      await admin.query(
        `INSERT INTO pms.property_pricing_settings
           (property_id, currency, pricing_currency_revision)
         VALUES ($1::uuid, 'EUR', 1)`,
        [propertyId],
      );
      await admin.query(
        `INSERT INTO pms.room_types (
           id, property_id, name, description, occupancy_limits,
           active, room_facts_revision
         ) VALUES (
           $1::uuid, $2::uuid, 'Suite', '',
           '{"total":4,"adults":2,"children":2}'::jsonb, TRUE, 1
         )`,
        [roomTypeId, propertyId],
      );
      await admin.query(
        `INSERT INTO pms.rate_plans (
           id, property_id, room_type_id, code, name, rate_type,
           cancellation_policy_snapshot, base_rate_amount, currency, active,
           pricing_contract_version, flexible_rate_plan_revision,
           source_room_facts_revision, source_pricing_currency_revision
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'FLEXIBLE', 'Flexible', 'flexible',
           '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,"afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
           160.00, 'EUR', TRUE, 'pms-pricing.v1', 1, 1, 1
         )`,
        [planId, propertyId, roomTypeId],
      );
    }

    async function persistedState() {
      const countsResult = await admin.query<{
        confirmations: string;
        idempotency: string;
        events: string;
        outbox: string;
        audits: string;
      }>(
        `SELECT
           (SELECT count(*) FROM pms.mandatory_charge_confirmation_revisions
            WHERE property_id = $1::uuid)::text AS confirmations,
           (SELECT count(*) FROM platform.idempotency_keys
            WHERE property_id = $1::uuid AND operation = $2)::text AS idempotency,
           (SELECT count(*) FROM platform.domain_events
            WHERE property_id = $1::uuid AND event_type = $3)::text AS events,
           (SELECT count(*) FROM platform.outbox_events
            WHERE property_id = $1::uuid AND event_type = $3)::text AS outbox,
           (SELECT count(*) FROM platform.product_audit_events
            WHERE property_id = $1::uuid AND action = $2)::text AS audits`,
        [
          propertyId,
          PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION,
          PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE,
        ],
      );
      const event = await admin.query(
        `SELECT event_type AS "eventType", resource_type AS "resourceType",
                resource_id AS "resourceId", correlation_id AS "correlationId",
                idempotency_key_hash AS "idempotencyKeyHash", payload,
                event_metadata AS metadata
         FROM platform.domain_events
         WHERE property_id = $1::uuid AND event_type = $2`,
        [propertyId, PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE],
      );
      const outbox = await admin.query(
        `SELECT destination, event_type AS "eventType", resource_type AS "resourceType",
                resource_id AS "resourceId", correlation_id AS "correlationId",
                idempotency_key_hash AS "idempotencyKeyHash", payload,
                outbox_metadata AS metadata
         FROM platform.outbox_events
         WHERE property_id = $1::uuid AND event_type = $2`,
        [propertyId, PMS_MANDATORY_CHARGES_CONFIRMED_EVENT_TYPE],
      );
      const audit = await admin.query(
        `SELECT action, target_resource_type AS "targetResourceType",
                target_resource_id AS "targetResourceId", correlation_id AS "correlationId",
                causation_id AS "causationId", redacted_payload AS "redactedPayload",
                private_payload AS "privatePayload", audit_metadata AS metadata
         FROM platform.product_audit_events
         WHERE property_id = $1::uuid AND action = $2`,
        [propertyId, PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION],
      );
      const raw = countsResult.rows[0]!;
      return {
        counts: {
          confirmations: Number(raw.confirmations),
          idempotency: Number(raw.idempotency),
          events: Number(raw.events),
          outbox: Number(raw.outbox),
          audits: Number(raw.audits),
        },
        event: event.rows[0],
        outbox: outbox.rows[0],
        audit: audit.rows[0],
      };
    }

    async function installAuditFailureTrigger(): Promise<void> {
      await removeAuditFailureTrigger();
      await admin.query(
        `CREATE FUNCTION ${auditFailureFunction}()
         RETURNS trigger LANGUAGE plpgsql AS $function$
         BEGIN
           IF NEW.property_id = '${propertyId}'::uuid
              AND NEW.action = '${PMS_CONFIRM_MANDATORY_CHARGES_INCLUDED_OPERATION}' THEN
             RAISE EXCEPTION 'injected password=must-not-leak';
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

    async function cleanup(): Promise<void> {
      await removeAuditFailureTrigger();
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL session_replication_role = replica");
        for (const statement of [
          "DELETE FROM pms.mandatory_charge_confirmation_revisions WHERE property_id = $1::uuid",
          "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
          "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
          "DELETE FROM pms.rate_plans WHERE property_id = $1::uuid",
          "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
          "DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid",
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

describe("PMS mandatory-charge confirmation dependency errors", () => {
  it("masks connection details before a transaction client exists", async () => {
    const pool = {
      async connect() {
        throw new Error("password=request-secret-must-not-leak");
      },
    } satisfies PmsMandatoryChargeConfirmationCommandPool;
    const repository = createPgPmsMandatoryChargeConfirmationCommandRepository({
      connectionString: "postgresql://unused",
      pool,
      now: () => new Date(acceptedAt),
    });
    const command = parseConfirmMandatoryChargesIncludedCommand({
      organizationId,
      propertyId,
      expectedConfirmationRevision: 0,
      claimedPricingSourceFingerprint: "a".repeat(64),
      expectedPricingSourceRevisions: {
        pricingCurrencyRevision: 1,
        rooms: [],
        flexibleRatePlans: [],
        optionalPricingAggregateRevision: 0,
        recurringSources: [],
      },
      idempotencyKey: "dependency-error",
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-secret-must-not-leak",
        correlationId: null,
        requestedAt: acceptedAt,
      },
    });
    if (!command) throw new Error("dependency error command is invalid");

    const failure = repository.confirmMandatoryChargesIncluded(command);
    await expect(failure).rejects.toThrow(
      "PMS mandatory-charge confirmation repository is unavailable",
    );
    await expect(failure).rejects.not.toThrow("request-secret");
  });
});

function assertSafeTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1);
  if (!/(?:test|vay1081)/i.test(database)) {
    throw new Error("Refusing to run VAY-1081 integration tests outside a test database");
  }
}
