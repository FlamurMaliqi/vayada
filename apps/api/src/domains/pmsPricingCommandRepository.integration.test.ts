import {
  parsePmsPricingCurrency,
  parseUpsertFlexibleRatePlanCommand,
  parseUpsertPropertyPricingCurrencyCommand,
  type PmsPricingCurrencyChangeBlocker,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsPricingCommandRepository } from "./pmsPricingCommandRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "16900000-0000-4000-8000-000000000001";
const organizationId = "16900000-0000-4000-8000-000000000002";
const propertyId = "16900000-0000-4000-8000-000000000003";
const roomTypeId = "16900000-0000-4000-8000-000000000004";
const planId = "16900000-0000-4000-8000-000000000006";
const legacyPlanId = "16900000-0000-4000-8000-000000000007";
const secondLegacyPlanId = "16900000-0000-4000-8000-000000000008";
const acceptedAt = "2026-08-03T13:00:00.000Z";
const roleKey = "vay1069_pricing_integration";
const auditFailureFunction = "platform.vay1069_fail_pricing_audit";
const auditFailureTrigger = "trg_vay1069_fail_pricing_audit";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS pricing command repository", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  let supportedCurrencies = new Set(["EUR", "USD", "CHF"]);
  let guardBlockers: readonly PmsPricingCurrencyChangeBlocker[] = [];
  let guardThrows = false;
  const guardCalls: Array<{ currentCurrency: string; requestedCurrency: string }> = [];
  const repository = createPgPmsPricingCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 6,
    now: () => new Date(acceptedAt),
    randomId: () => planId,
    currencyValidator: {
      async isSupportedPricingCurrency(currency) {
        return supportedCurrencies.has(currency);
      },
    },
    currencyChangeGuard: {
      async runWithCurrencyChangeGuard(input, guarded) {
        guardCalls.push(input);
        if (guardThrows) throw new Error("dependency guard unavailable");
        return guarded(guardBlockers);
      },
    },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedAuthorizedProperty();
    supportedCurrencies = new Set(["EUR", "USD", "CHF"]);
    guardBlockers = [];
    guardThrows = false;
    guardCalls.length = 0;
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("creates exact currency/plan sources, replays once, and updates the stable plan by CAS", async () => {
    const createCurrency = currencyCommand("currency-create", 0, "EUR");
    const createdCurrency = await repository.upsertPropertyPricingCurrency(createCurrency);
    expect(createdCurrency).toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        pricingCurrency: { currency: "EUR", pricingCurrencyRevision: 1 },
      },
    });
    await expect(repository.upsertPropertyPricingCurrency(createCurrency)).resolves.toEqual(
      createdCurrency,
    );

    await seedRoomType(roomTypeId, "Decimal Suite");
    const createPlan = planCommand("plan-create", roomTypeId, 0, "9999999999999.99");
    const createdPlan = await repository.upsertFlexibleRatePlan(createPlan);
    expect(createdPlan).toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        flexibleRatePlan: {
          flexibleRatePlanId: planId,
          flexibleRatePlanRevision: 1,
          sourceRoomFactsRevision: 1,
          baseAmount: { amountDecimal: "9999999999999.99", currency: "EUR" },
        },
      },
    });
    await expect(repository.upsertFlexibleRatePlan(createPlan)).resolves.toEqual(createdPlan);

    const updatedPlan = await repository.upsertFlexibleRatePlan(
      planCommand("plan-update", roomTypeId, 1, "0.10"),
    );
    expect(updatedPlan).toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        flexibleRatePlan: {
          flexibleRatePlanId: planId,
          flexibleRatePlanRevision: 2,
          baseAmount: { amountDecimal: "0.10", currency: "EUR" },
        },
      },
    });
    await expect(
      repository.upsertFlexibleRatePlan(planCommand("plan-stale", roomTypeId, 1, "20.00")),
    ).resolves.toEqual({
      ok: false,
      error: { code: "flexible_rate_plan_revision_conflict", currentRevision: 2 },
    });

    await expect(readPlan(planId)).resolves.toMatchObject({
      amountDecimal: "0.10",
      currency: "EUR",
      flexibleRatePlanRevision: "2",
      sourceRoomFactsRevision: "1",
      sourcePricingCurrencyRevision: "1",
    });
    await expect(auditCount("pms.pricing_currency.upsert")).resolves.toBe(1);
    await expect(auditCount("pms.flexible_rate_plan.upsert")).resolves.toBe(3);
    await expect(eventCount()).resolves.toBe(3);
    await expect(outboxCount()).resolves.toBe(6);
    const payloads = await secretSafeEventPayloads();
    expect(
      payloads.every((payload) => {
        const text = JSON.stringify(payload);
        return (
          !text.includes("EUR") &&
          !text.includes("9999999999999.99") &&
          !text.includes("freeCancellationDeadlineDays")
        );
      }),
    ).toBe(true);
  });

  it("rechecks authorization before replay and excludes front-desk scope", async () => {
    const command = currencyCommand("scope-replay", 0, "EUR");
    await expect(repository.upsertPropertyPricingCurrency(command)).resolves.toMatchObject({
      ok: true,
    });
    await admin.query(
      `UPDATE identity.organization_resource_links SET relationship = 'front_desk'
       WHERE organization_id = $1::uuid AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );

    await expect(repository.upsertPropertyPricingCurrency(command)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(auditCount("pms.pricing_currency.upsert")).resolves.toBe(1);
    await expect(eventCount()).resolves.toBe(1);
  });

  it("changes currency only inside the dependency guard and fails closed when blocked or unavailable", async () => {
    await repository.upsertPropertyPricingCurrency(currencyCommand("currency-eur", 0, "EUR"));
    await expect(
      repository.upsertPropertyPricingCurrency(currencyCommand("currency-usd", 1, "USD")),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        pricingCurrency: { currency: "USD", pricingCurrencyRevision: 2 },
      },
    });
    expect(guardCalls).toEqual([{ propertyId, currentCurrency: "EUR", requestedCurrency: "USD" }]);

    guardBlockers = [{ code: "payment_configuration", affectedCount: 1 }];
    await expect(
      repository.upsertPropertyPricingCurrency(currencyCommand("currency-chf-blocked", 2, "CHF")),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 2,
        blockers: [{ code: "payment_configuration", affectedCount: 1 }],
      },
    });

    guardBlockers = [];
    guardThrows = true;
    await expect(
      repository.upsertPropertyPricingCurrency(
        currencyCommand("currency-chf-unavailable", 2, "CHF"),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "pricing_currency_change_blocked",
        currentRevision: 2,
        blockers: [{ code: "dependency_check_unavailable" }],
      },
    });
    await expect(readCurrency()).resolves.toEqual({ currency: "USD", revision: "2" });
    await expect(eventCount()).resolves.toBe(2);
  });

  it("creates a distinct canonical plan without mutating arbitrary legacy flexible rows", async () => {
    await repository.upsertPropertyPricingCurrency(currencyCommand("currency-create", 0, "EUR"));
    await seedRoomType(roomTypeId, "Legacy Suite");
    await seedLegacyPlan(legacyPlanId, roomTypeId, "LEGACY-INACTIVE", false);
    await seedLegacyPlan(secondLegacyPlanId, roomTypeId, "LEGACY-ACTIVE", true);

    await expect(
      repository.upsertFlexibleRatePlan(planCommand("create-plan", roomTypeId, 0, "150.25")),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        flexibleRatePlan: { flexibleRatePlanId: planId, flexibleRatePlanRevision: 1 },
      },
    });
    await expect(readPlan(legacyPlanId)).resolves.toMatchObject({
      amountDecimal: "99.00",
      mealPlan: "breakfast",
      paymentPolicy: { mode: "legacy" },
      depositPolicy: { amount: "10.00" },
      contractVersion: null,
      active: false,
    });
    await expect(readPlan(secondLegacyPlanId)).resolves.toMatchObject({
      amountDecimal: "99.00",
      mealPlan: "breakfast",
      paymentPolicy: { mode: "legacy" },
      depositPolicy: { amount: "10.00" },
      contractVersion: null,
      active: true,
    });
    await expect(readPlan(planId)).resolves.toMatchObject({
      amountDecimal: "150.25",
      mealPlan: null,
      paymentPolicy: {},
      depositPolicy: {},
      contractVersion: "pms-pricing.v1",
      active: true,
    });
  });

  it("serializes concurrent plan CAS and durably audits the stale conflict", async () => {
    await repository.upsertPropertyPricingCurrency(currencyCommand("currency-create", 0, "EUR"));
    await seedRoomType(roomTypeId, "Concurrent Suite");
    await repository.upsertFlexibleRatePlan(planCommand("plan-create", roomTypeId, 0, "100.00"));

    await admin.query("BEGIN");
    await admin.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended(concat('pms-pricing-currency:', $1::uuid::text), 0)
       )`,
      [propertyId],
    );
    const first = repository.upsertFlexibleRatePlan(
      planCommand("plan-concurrent-a", roomTypeId, 1, "110.00"),
    );
    const second = repository.upsertFlexibleRatePlan(
      planCommand("plan-concurrent-b", roomTypeId, 1, "120.00"),
    );
    try {
      await waitForAdvisoryWaiters(2);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      await Promise.allSettled([first, second]);
      throw error;
    }

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: { code: "flexible_rate_plan_revision_conflict", currentRevision: 2 },
      },
    ]);
    await expect(auditCount("pms.flexible_rate_plan.upsert")).resolves.toBe(3);
    await expect(idempotencyCount("pms.flexible_rate_plan.upsert")).resolves.toBe(3);
  });

  it("stores unsupported currency as a typed conflict without authoritative mutation", async () => {
    supportedCurrencies = new Set(["EUR"]);
    await expect(
      repository.upsertPropertyPricingCurrency(currencyCommand("currency-unsupported", 0, "ZZZ")),
    ).resolves.toEqual({ ok: false, error: { code: "unsupported_pricing_currency" } });
    await expect(readCurrency()).resolves.toBeNull();
    await expect(auditCount("pms.pricing_currency.upsert")).resolves.toBe(1);
    await expect(idempotencyCount("pms.pricing_currency.upsert")).resolves.toBe(1);
    await expect(eventCount()).resolves.toBe(0);
    await expect(outboxCount()).resolves.toBe(0);
  });

  it("rolls back pricing, event, outbox, audit, and idempotency when audit fails", async () => {
    await installAuditFailureTrigger();
    try {
      await expect(
        repository.upsertPropertyPricingCurrency(currencyCommand("currency-audit-fail", 0, "EUR")),
      ).rejects.toThrow("injected VAY-1069 audit failure");
      await expect(readCurrency()).resolves.toBeNull();
      await expect(auditCount("pms.pricing_currency.upsert")).resolves.toBe(0);
      await expect(idempotencyCount("pms.pricing_currency.upsert")).resolves.toBe(0);
      await expect(eventCount()).resolves.toBe(0);
      await expect(outboxCount()).resolves.toBe(0);
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1069-pricing@example.test', 'VAY-1069 Pricing', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1069 Pricing', 'vay1069-pricing', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1069-pricing', 'VAY-1069 Pricing')`,
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
  }

  async function seedRoomType(id: string, name: string): Promise<void> {
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, base_rate_amount, currency,
         active, room_facts_revision
       ) VALUES ($1::uuid, $2::uuid, $3, '', NULL, NULL, TRUE, 1)`,
      [id, propertyId, name],
    );
  }

  async function seedLegacyPlan(
    id: string,
    requestedRoomTypeId: string,
    code: string,
    active: boolean,
  ) {
    await admin.query(
      `INSERT INTO pms.rate_plans (
         id, property_id, room_type_id, code, name, rate_type, meal_plan,
         payment_policy, deposit_policy, cancellation_policy_snapshot,
         base_rate_amount, currency, active
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, 'Legacy flexible', 'flexible', 'breakfast',
         '{"mode":"legacy"}'::jsonb, '{"amount":"10.00"}'::jsonb, '{}'::jsonb,
         99.00, 'EUR', $5
       )`,
      [id, propertyId, requestedRoomTypeId, code, active],
    );
  }

  async function installAuditFailureTrigger(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query(
      `CREATE FUNCTION ${auditFailureFunction}()
       RETURNS trigger LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.property_id = '${propertyId}'::uuid
            AND NEW.action = 'pms.pricing_currency.upsert' THEN
           RAISE EXCEPTION 'injected VAY-1069 audit failure';
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
        "DELETE FROM pms.rate_rules WHERE property_id = $1::uuid",
        "DELETE FROM pms.rate_plans WHERE property_id = $1::uuid",
        "DELETE FROM pms.room_types WHERE property_id = $1::uuid",
        "DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid",
        "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
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
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
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

  async function readCurrency() {
    const result = await admin.query(
      `SELECT currency::text AS currency, pricing_currency_revision::text AS revision
       FROM pms.property_pricing_settings WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0] ?? null;
  }

  async function readPlan(id: string) {
    const result = await admin.query(
      `SELECT base_rate_amount::text AS "amountDecimal", currency::text AS currency,
              meal_plan AS "mealPlan", payment_policy AS "paymentPolicy",
              deposit_policy AS "depositPolicy", pricing_contract_version AS "contractVersion",
              active,
              flexible_rate_plan_revision::text AS "flexibleRatePlanRevision",
              source_room_facts_revision::text AS "sourceRoomFactsRevision",
              source_pricing_currency_revision::text AS "sourcePricingCurrencyRevision"
       FROM pms.rate_plans WHERE property_id = $1::uuid AND id = $2::uuid`,
      [propertyId, id],
    );
    return result.rows[0] ?? null;
  }

  async function auditCount(action: string): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.product_audit_events
       WHERE property_id = $1::uuid AND action = $2`,
      [propertyId, action],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function idempotencyCount(operation: string): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.idempotency_keys
       WHERE property_id = $1::uuid AND operation = $2 AND status = 'completed'`,
      [propertyId, operation],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function eventCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.domain_events
       WHERE property_id = $1::uuid AND event_type = 'pms.pricing_source.changed'`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function outboxCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM platform.outbox_events
       WHERE property_id = $1::uuid AND event_type = 'pms.pricing_source.changed'`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function secretSafeEventPayloads(): Promise<unknown[]> {
    const result = await admin.query<{ payload: unknown }>(
      `SELECT payload FROM platform.domain_events
       WHERE property_id = $1::uuid AND event_type = 'pms.pricing_source.changed'
       UNION ALL
       SELECT payload FROM platform.outbox_events
       WHERE property_id = $1::uuid AND event_type = 'pms.pricing_source.changed'`,
      [propertyId],
    );
    return result.rows.map(({ payload }) => payload);
  }

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND granted = FALSE
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Concurrent PMS pricing commands did not reach the advisory lock");
  }
});

function currencyCommand(key: string, expectedRevision: number, currencyCode: string) {
  const command = parseUpsertPropertyPricingCurrencyCommand({
    organizationId,
    propertyId,
    idempotencyKey: key,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      requestedAt: acceptedAt,
    },
    expectedPricingCurrencyRevision: expectedRevision,
    currency: parsePmsPricingCurrency(currencyCode),
  });
  if (!command) throw new Error("Invalid pricing currency command fixture");
  return command;
}

function planCommand(
  key: string,
  requestedRoomTypeId: string,
  expectedRevision: number,
  amount: string,
) {
  const command = parseUpsertFlexibleRatePlanCommand({
    organizationId,
    propertyId,
    idempotencyKey: key,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `request-${key}`,
      correlationId: `correlation-${key}`,
      requestedAt: acceptedAt,
    },
    roomTypeId: requestedRoomTypeId,
    expectedRoomFactsRevision: 1,
    expectedPricingCurrencyRevision: 1,
    expectedFlexibleRatePlanRevision: expectedRevision,
    baseAmountDecimal: amount,
    cancellationTerms: {
      type: "free_until_days_before_arrival",
      freeCancellationDeadlineDays: 7,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    },
  });
  if (!command) throw new Error("Invalid flexible plan command fixture");
  return command;
}

function assertSafeTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!database.includes("test")) {
    throw new Error("Refusing to run PMS pricing integration against a non-test database");
  }
}
