import {
  parseReplaceFinancePaymentMethodsCommand,
  type ReplaceFinancePaymentMethodsCommand,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPgFinancePaymentReadinessCommandRepository,
  type FinancePaymentReadinessCommandPool,
} from "./financePaymentReadinessCommandRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "10640000-0000-4000-8000-000000000001";
const organizationId = "10640000-0000-4000-8000-000000000002";
const propertyId = "10640000-0000-4000-8000-000000000003";
const providerAccountId = "10640000-0000-4000-8000-000000000004";
const acceptedAt = "2026-08-04T10:00:00.000Z";
const pricing = {
  contractVersion: PMS_PRICING_CONTRACT_VERSION,
  currency: "EUR",
  pricingCurrencyRevision: 7,
} as const;

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Finance payment-readiness commands", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createPgFinancePaymentReadinessCommandRepository({
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
    await seedAuthorizedScope();
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("creates one versioned aggregate and exactly replays without duplicate side effects", async () => {
    const request = command("accept-once", { selectedMethods: ["pay_at_property", "card"] });
    const accepted = await repository.replacePaymentMethods({
      command: request,
      currentPricing: pricing,
    });

    expect(accepted).toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        paymentReadiness: {
          propertyId,
          paymentMethodsRevision: 1,
          bookingPaymentReady: true,
          pricingCurrency: { matchesCurrent: true },
          methods: [
            { method: "pay_at_property", readiness: "ready" },
            { method: "card", readiness: "unready" },
            { method: "bank_transfer", availability: "unavailable" },
          ],
        },
        acceptedAt,
      },
    });
    await expect(
      repository.replacePaymentMethods({
        command: {
          ...request,
          audit: { ...request.audit, requestId: "retry-request", correlationId: "retry" },
        },
        currentPricing: pricing,
      }),
    ).resolves.toEqual(accepted);
    await expect(counts()).resolves.toEqual({ audits: 1, events: 1, idempotency: 1, outbox: 1 });

    const event = await admin.query<{
      payload: unknown;
      eventMetadata: unknown;
      outboxPayload: unknown;
      outboxMetadata: unknown;
      destination: string;
    }>(
      `SELECT event.payload, event.event_metadata AS "eventMetadata",
              outbox.payload AS "outboxPayload", outbox.outbox_metadata AS "outboxMetadata",
              outbox.destination
       FROM platform.domain_events event
       JOIN platform.outbox_events outbox ON outbox.domain_event_id = event.id
       WHERE event.event_type = 'finance.payment_readiness.changed'`,
    );
    expect(event.rows).toEqual([
      {
        payload: {
          contractVersion: "finance-payment-readiness.v1",
          eventType: "finance.payment_readiness.changed",
          organizationId,
          propertyId,
          paymentMethodsRevision: 1,
          sourcePricingCurrencyRevision: 7,
          outcome: "readiness_gained",
          sourceReadRequired: true,
        },
        eventMetadata: {
          contractVersion: "finance-payment-readiness.v1",
          sourceReadRequired: true,
        },
        outboxPayload: expect.any(Object),
        outboxMetadata: {
          contractVersion: "finance-payment-readiness.v1",
          sourceReadRequired: true,
        },
        destination: "booking.payment-source",
      },
    ]);
    expect(event.rows[0]?.outboxPayload).toEqual(event.rows[0]?.payload);
    expect(JSON.stringify(await durablePayloads())).not.toContain(request.idempotencyKey);
  });

  it("updates readiness while preserving unrelated legacy Finance settings", async () => {
    await admin.query(
      `INSERT INTO finance.payment_settings (
         property_id, accepted_methods, default_currency, deposit_policy,
         statement_descriptor, requires_manual_review
       ) VALUES ($1::uuid, ARRAY['cash'], 'EUR', '{"mode":"keep"}'::jsonb, 'KEEP', TRUE)`,
      [propertyId],
    );
    const created = await repository.replacePaymentMethods({
      command: command("legacy-create", { selectedMethods: ["pay_at_property"] }),
      currentPricing: pricing,
    });
    expect(created).toMatchObject({ ok: true, response: { outcome: "created" } });
    const updated = await repository.replacePaymentMethods({
      command: command("card-update", {
        expectedPaymentMethodsRevision: 1,
        selectedMethods: ["card"],
      }),
      currentPricing: pricing,
    });
    expect(updated).toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        paymentReadiness: { paymentMethodsRevision: 2, bookingPaymentReady: false },
      },
    });
    await expect(settings()).resolves.toMatchObject({
      acceptedMethods: ["card"],
      contractVersion: "finance-payment-readiness.v1",
      paymentMethodsRevision: "2",
      pricingRevision: "7",
      currency: "EUR",
      depositPolicy: { mode: "keep" },
      statementDescriptor: "KEEP",
      requiresManualReview: true,
    });
    await expect(eventOutcomes()).resolves.toEqual(["readiness_gained", "readiness_lost"]);
  });

  it("recomputes card readiness after moving from a supported to unsupported currency", async () => {
    await seedOnlineCardState({ financeCurrency: "EUR", pmsCurrency: "KWD", pmsRevision: 8 });
    const result = await repository.replacePaymentMethods({
      command: command("currency-becomes-unsupported", {
        expectedPaymentMethodsRevision: 1,
        expectedPricingCurrencyRevision: 8,
        selectedMethods: ["card"],
      }),
      currentPricing: { ...pricing, currency: "KWD", pricingCurrencyRevision: 8 },
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        paymentReadiness: {
          bookingPaymentReady: false,
          methods: expect.arrayContaining([
            expect.any(Object),
            expect.objectContaining({
              method: "card",
              readiness: "unready",
              blockers: ["online_card_currency_unsupported"],
            }),
          ]),
        },
      },
    });
    await expect(eventOutcomes()).resolves.toEqual(["selection_changed"]);
  });

  it("requires new execution evidence after moving to a supported currency", async () => {
    await seedOnlineCardState({ financeCurrency: "KWD", pmsCurrency: "EUR", pmsRevision: 7 });
    const result = await repository.replacePaymentMethods({
      command: command("currency-becomes-supported", {
        expectedPaymentMethodsRevision: 1,
        selectedMethods: ["card"],
      }),
      currentPricing: pricing,
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        paymentReadiness: {
          bookingPaymentReady: false,
          methods: expect.arrayContaining([
            expect.any(Object),
            expect.objectContaining({
              method: "card",
              readiness: "unready",
              blockers: ["online_card_execution_unavailable"],
            }),
          ]),
        },
      },
    });
    await expect(eventOutcomes()).resolves.toEqual(["selection_changed"]);
  });

  it("suppresses a published card in the same transaction when canonical selection removes it", async () => {
    await seedOnlineCardState({ financeCurrency: "EUR", pmsCurrency: "EUR", pmsRevision: 7 });
    await seedPublishedCard();

    const result = await repository.replacePaymentMethods({
      command: command("remove-card", {
        expectedPaymentMethodsRevision: 1,
        selectedMethods: ["pay_at_property"],
      }),
      currentPricing: pricing,
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        paymentReadiness: {
          bookingPaymentReady: true,
          methods: expect.arrayContaining([
            expect.objectContaining({ method: "pay_at_property", readiness: "ready" }),
          ]),
        },
      },
    });
    const projection = await admin.query<{ capabilities: unknown }>(
      `SELECT capabilities FROM distribution.public_hotel_bookability_profiles
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    expect(projection.rows[0]?.capabilities).toMatchObject({
      onlinePayment: false,
      payAtProperty: true,
      paymentMethods: ["pay_at_property"],
    });
    const loss = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.domain_events
       WHERE property_id = $1::uuid
         AND event_type = 'finance.online_card_readiness.changed'
         AND payload ->> 'outcome' = 'readiness_lost'`,
      [propertyId],
    );
    expect(loss.rows[0]?.count).toBe(1);
  });

  it("records unavailable methods once and rejects changed-key reuse without events", async () => {
    const request = command("bank-unavailable", { selectedMethods: ["bank_transfer"] });
    const unavailable = await repository.replacePaymentMethods({
      command: request,
      currentPricing: pricing,
    });
    expect(unavailable).toEqual({
      ok: false,
      error: { code: "payment_method_unavailable", method: "bank_transfer" },
    });
    await expect(
      repository.replacePaymentMethods({ command: request, currentPricing: pricing }),
    ).resolves.toEqual(unavailable);
    await expect(
      repository.replacePaymentMethods({
        command: command("bank-unavailable", { selectedMethods: ["card"] }),
        currentPricing: pricing,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(counts()).resolves.toEqual({ audits: 1, events: 0, idempotency: 1, outbox: 0 });
  });

  it("returns explicit missing and stale pricing evidence without a Finance write", async () => {
    await expect(
      repository.replacePaymentMethods({
        command: command("pricing-missing"),
        currentPricing: null,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "pricing_currency_unavailable" } });
    await expect(
      repository.replacePaymentMethods({
        command: command("pricing-stale"),
        currentPricing: { ...pricing, pricingCurrencyRevision: 8 },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "pricing_currency_revision_conflict", currentRevision: 8 },
    });
    await expect(settings()).resolves.toBeNull();
    await expect(counts()).resolves.toEqual({ audits: 2, events: 0, idempotency: 2, outbox: 0 });
  });

  it("serializes concurrent aggregate creation and rejects the stale writer", async () => {
    const results = await Promise.all([
      repository.replacePaymentMethods({
        command: command("concurrent-a"),
        currentPricing: pricing,
      }),
      repository.replacePaymentMethods({
        command: command("concurrent-b"),
        currentPricing: pricing,
      }),
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([
      { ok: false, error: { code: "payment_methods_revision_conflict", currentRevision: 1 } },
    ]);
    await expect(counts()).resolves.toEqual({ audits: 2, events: 1, idempotency: 2, outbox: 1 });
  });

  it("reports a persisted matching command that is still in progress", async () => {
    const request = command("still-running");
    await repository.replacePaymentMethods({ command: request, currentPricing: pricing });
    await admin.query(
      `UPDATE platform.idempotency_keys SET status = 'in_progress'
       WHERE operation = 'finance.payment_methods.replace' AND property_id = $1::uuid`,
      [propertyId],
    );
    await expect(
      repository.replacePaymentMethods({ command: request, currentPricing: pricing }),
    ).resolves.toEqual({ ok: false, error: { code: "command_in_progress" } });
    await expect(counts()).resolves.toEqual({ audits: 1, events: 1, idempotency: 1, outbox: 1 });
  });

  it("fails closed and rolls back malformed typed PMS evidence", async () => {
    await expect(
      repository.replacePaymentMethods({
        command: command("malformed-pricing"),
        currentPricing: {
          ...pricing,
          pricingCurrencyRevision: "7",
          providerSecret: "hidden",
        } as never,
      }),
    ).rejects.toThrow("Finance payment readiness pricing evidence failed contract validation");
    await expect(settings()).resolves.toBeNull();
    await expect(counts()).resolves.toEqual({ audits: 0, events: 0, idempotency: 0, outbox: 0 });
  });

  it.each([
    ["owner", "owner", true],
    ["finance_manager", "finance_manager", true],
    ["owner", "operator", false],
    ["owner", "front_desk", false],
  ])("enforces role %s with relationship %s", async (roleKey, relationship, allowed) => {
    await admin.query(
      `UPDATE identity.organization_memberships SET role_key = $2
       WHERE organization_id = $1::uuid`,
      [organizationId, roleKey],
    );
    await admin.query(
      `UPDATE identity.organization_resource_links SET relationship = $2
       WHERE organization_id = $1::uuid`,
      [organizationId, relationship],
    );
    const result = await repository.replacePaymentMethods({
      command: command(`scope-${roleKey}-${relationship}`),
      currentPricing: pricing,
    });
    expect(result).toMatchObject(
      allowed ? { ok: true } : { ok: false, error: { code: "setup_scope_unavailable" } },
    );
    if (!allowed) {
      await expect(counts()).resolves.toEqual({ audits: 0, events: 0, idempotency: 0, outbox: 0 });
    }
  });

  it("accepts a scope with both allowed resource relationships", async () => {
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'finance_manager', 'active')`,
      [organizationId, propertyId],
    );

    await expect(
      repository.replacePaymentMethods({
        command: command("dual-allowed-relationships"),
        currentPricing: pricing,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["organization", "UPDATE identity.organizations SET status = 'suspended' WHERE id = $1::uuid"],
    ["actor", "UPDATE identity.users SET status = 'suspended' WHERE id = $1::uuid"],
    [
      "membership",
      "UPDATE identity.organization_memberships SET status = 'suspended' WHERE organization_id = $1::uuid",
    ],
    [
      "permission",
      "UPDATE identity.organization_memberships SET role_key = 'role_without_permission' WHERE organization_id = $1::uuid",
    ],
    [
      "resource",
      "UPDATE identity.organization_resource_links SET status = 'suspended' WHERE organization_id = $1::uuid",
    ],
    [
      "entitlement",
      "UPDATE identity.product_entitlements SET status = 'suspended' WHERE organization_id = $1::uuid",
    ],
    [
      "expired entitlement",
      "UPDATE identity.product_entitlements SET expires_at = '2026-08-04T09:59:59Z' WHERE organization_id = $1::uuid",
    ],
  ])("denies revoked %s before idempotency", async (_name, sql) => {
    await admin.query(sql, [_name === "actor" ? actorUserId : organizationId]);
    await expect(
      repository.replacePaymentMethods({
        command: command(`revoked-${_name}`),
        currentPricing: pricing,
      }),
    ).resolves.toEqual({ ok: false, error: { code: "setup_scope_unavailable" } });
    await expect(counts()).resolves.toEqual({ audits: 0, events: 0, idempotency: 0, outbox: 0 });
  });

  it("re-authorizes exact replay before returning the stored result", async () => {
    const request = command("replay-reauthorize");
    await expect(
      repository.replacePaymentMethods({ command: request, currentPricing: pricing }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await admin.query(
      `UPDATE identity.organization_resource_links SET status = 'suspended'
       WHERE organization_id = $1::uuid`,
      [organizationId],
    );
    await expect(
      repository.replacePaymentMethods({ command: request, currentPricing: pricing }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(counts()).resolves.toEqual({ audits: 1, events: 1, idempotency: 1, outbox: 1 });
  });

  it("rolls back aggregate, audit, event, outbox, and idempotency when outbox fails", async () => {
    const inner = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const failing = createPgFinancePaymentReadinessCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: failOutboxPool(inner),
      now: () => new Date(acceptedAt),
    });
    try {
      await expect(
        failing.replacePaymentMethods({
          command: command("outbox-failure"),
          currentPricing: pricing,
        }),
      ).rejects.toThrow("injected outbox failure");
      await expect(settings()).resolves.toBeNull();
      await expect(counts()).resolves.toEqual({ audits: 0, events: 0, idempotency: 0, outbox: 0 });
    } finally {
      await inner.end();
    }
  });

  function command(
    idempotencyKey: string,
    overrides: Partial<ReplaceFinancePaymentMethodsCommand> = {},
  ): ReplaceFinancePaymentMethodsCommand {
    const parsed = parseReplaceFinancePaymentMethodsCommand({
      organizationId,
      propertyId,
      idempotencyKey,
      expectedPaymentMethodsRevision: 0,
      expectedPricingCurrencyRevision: 7,
      selectedMethods: ["pay_at_property"],
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-vay1064",
        correlationId: "correlation-vay1064",
        requestedAt: acceptedAt,
      },
      ...overrides,
    });
    if (!parsed) throw new Error("Invalid Finance payment-readiness integration command");
    return parsed;
  }

  async function seedAuthorizedScope(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1064@example.test', 'VAY-1064', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1064', 'vay1064', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1064', 'VAY-1064')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', 'owner', 'agency')`,
      [organizationId, actorUserId],
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
       VALUES ($1::uuid, 'EUR', 7)`,
      [propertyId],
    );
  }

  async function seedOnlineCardState(input: {
    financeCurrency: string;
    pmsCurrency: string;
    pmsRevision: number;
  }): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        `UPDATE pms.property_pricing_settings
         SET currency = $2, pricing_currency_revision = $3
         WHERE property_id = $1::uuid`,
        [propertyId, input.pmsCurrency, input.pmsRevision],
      );
      await admin.query(
        `INSERT INTO finance.payment_provider_accounts (
           id, property_id, account_scope, provider, provider_account_id,
           status, onboarding_status, charges_enabled, payouts_enabled,
           default_currency, capabilities, account_metadata, card_capability_revision
         ) VALUES (
           $1::uuid, $2::uuid, 'property', 'stripe', $3,
           'active', 'completed', TRUE, TRUE, $4, ARRAY['card_payments'],
           '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}'::jsonb, 7
         )`,
        [
          providerAccountId,
          propertyId,
          `acct-vay-1345-${providerAccountId}`,
          input.financeCurrency,
        ],
      );
      await admin.query(
        `INSERT INTO finance.payment_settings (
           property_id, provider_account_id, payments_enabled, accepted_methods,
           default_currency, payment_readiness_contract_version,
           payment_methods_revision, source_pricing_currency_revision
         ) VALUES (
           $1::uuid, $2::uuid, TRUE, ARRAY['card'], $3,
           'finance-payment-readiness.v1', 1, 7
         )`,
        [propertyId, providerAccountId, input.financeCurrency],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    await admin.query(
      `INSERT INTO finance.online_card_execution_evidence (
         property_id, provider_account_id, contract_version, test_suite,
         provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
         executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, 'finance-online-card-execution-evidence.v1', 'onb-25a',
         7, 1, $3, '2026-08-04T09:00:00Z', '2026-08-04T09:05:00Z', $4::uuid, $5::uuid
       )`,
      [propertyId, providerAccountId, "9".repeat(64), organizationId, actorUserId],
    );
  }

  async function seedPublishedCard(): Promise<void> {
    await admin.query(
      `INSERT INTO booking.booking_settings (
         property_id, default_currency, default_language, supported_languages,
         acceptance_mode
       ) VALUES ($1::uuid, 'EUR', 'en', ARRAY['en'], 'instant')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (
         property_id, public_id, display_name, canonical_slug,
         default_locale, supported_locales, profile_status
       ) VALUES ($1::uuid, 'vay1064', 'VAY-1064', 'vay1064', 'en', ARRAY['en'], 'complete')`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles (
         property_id, finance_payment_settings_property_id, public_id, canonical_slug,
         canonical_url, booking_base_url, timezone, default_locale, supported_locales,
         default_currency, supported_currencies, profile_status, freshness_status,
         capabilities
       ) VALUES (
         $1::uuid, $1::uuid, 'vay1064', 'vay1064',
         'https://booking.example.test/vay1064', 'https://booking.example.test',
         'Europe/Berlin', 'en', ARRAY['en'], 'EUR', ARRAY['EUR'], 'public', 'fresh',
         '{"onlinePayment":true,"payAtProperty":true,"paymentMethods":["card","pay_at_property"]}'::jsonb
       )`,
      [propertyId],
    );
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const statement of [
        "DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.outbox_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.domain_events WHERE property_id = $1::uuid",
        "DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid",
        "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid",
        "DELETE FROM finance.online_card_execution_evidence WHERE property_id = $1::uuid",
        "DELETE FROM finance.payment_settings WHERE property_id = $1::uuid",
        "DELETE FROM finance.payment_provider_accounts WHERE property_id = $1::uuid",
        "DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid",
        "DELETE FROM booking.booking_settings WHERE property_id = $1::uuid",
        "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
      ]) {
        await admin.query(statement, [propertyId]);
      }
      for (const statement of [
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organizations WHERE id = $1::uuid",
      ]) {
        await admin.query(statement, [organizationId]);
      }
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function counts() {
    const result = await admin.query<{
      audits: number;
      events: number;
      idempotency: number;
      outbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM platform.product_audit_events
          WHERE action = 'finance.payment_methods.replace') AS audits,
         (SELECT count(*)::int FROM platform.domain_events
          WHERE event_type = 'finance.payment_readiness.changed') AS events,
         (SELECT count(*)::int FROM platform.idempotency_keys
          WHERE operation = 'finance.payment_methods.replace') AS idempotency,
         (SELECT count(*)::int FROM platform.outbox_events
          WHERE destination = 'booking.payment-source') AS outbox`,
    );
    return result.rows[0]!;
  }

  async function settings() {
    const result = await admin.query<{
      acceptedMethods: string[];
      contractVersion: string | null;
      paymentMethodsRevision: string | null;
      pricingRevision: string | null;
      currency: string;
      depositPolicy: unknown;
      statementDescriptor: string | null;
      requiresManualReview: boolean;
    }>(
      `SELECT accepted_methods AS "acceptedMethods",
              payment_readiness_contract_version AS "contractVersion",
              payment_methods_revision AS "paymentMethodsRevision",
              source_pricing_currency_revision AS "pricingRevision",
              default_currency::text AS currency, deposit_policy AS "depositPolicy",
              statement_descriptor AS "statementDescriptor",
              requires_manual_review AS "requiresManualReview"
       FROM finance.payment_settings WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0] ?? null;
  }

  async function eventOutcomes(): Promise<string[]> {
    const result = await admin.query<{ outcome: string }>(
      `SELECT payload ->> 'outcome' AS outcome FROM platform.domain_events
       WHERE event_type = 'finance.payment_readiness.changed'
       ORDER BY (payload ->> 'paymentMethodsRevision')::int`,
    );
    return result.rows.map(({ outcome }) => outcome);
  }

  async function durablePayloads(): Promise<unknown> {
    const events = await admin.query(
      "SELECT payload, event_metadata FROM platform.domain_events WHERE property_id = $1::uuid",
      [propertyId],
    );
    const outbox = await admin.query(
      "SELECT payload, outbox_metadata FROM platform.outbox_events WHERE property_id = $1::uuid",
      [propertyId],
    );
    const audits = await admin.query(
      "SELECT redacted_payload, private_payload, audit_metadata FROM platform.product_audit_events WHERE property_id = $1::uuid",
      [propertyId],
    );
    return [...events.rows, ...outbox.rows, ...audits.rows];
  }
});

function failOutboxPool(pool: pg.Pool): FinancePaymentReadinessCommandPool {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query<T extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
          if (text.includes("INSERT INTO platform.outbox_events")) {
            throw new Error("injected outbox failure");
          }
          return client.query<T>(text, values as unknown[]);
        },
        release: () => client.release(),
      };
    },
    end: () => pool.end(),
  };
}

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    !url.pathname.toLowerCase().includes("test")
  ) {
    throw new Error("Refusing to run Finance payment-readiness integration tests on a non-test DB");
  }
}
