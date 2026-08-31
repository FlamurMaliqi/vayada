import type {
  AcceptFinanceOnlineCardExecutionEvidenceCommand,
  FinanceStripeConnectProvider,
  IssueStripeOnboardingLinkCommand,
  RevokeFinanceOnlineCardExecutionEvidenceCommand,
} from "@vayada/domain-finance";
import { parseReplaceFinancePaymentMethodsCommand } from "@vayada/domain-finance";
import { createHash, createHmac, randomUUID } from "node:crypto";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFinanceOnlineCardExecutionEvidenceRepository } from "../routes/financeOnlineCardExecutionEvidenceRepository.js";
import { createTargetFinancePropertySettingsRepository } from "../routes/finance.js";
import { createPgFinancePaymentReadinessCommandRepository } from "../domains/financePaymentReadinessCommandRepository.js";
import { runFinanceStripeAccountCompensationJobs } from "../jobs/financeStripeAccountCompensation.js";
import { buildApp } from "../app.js";
import { createPgProviderWebhookStore } from "./providerWebhooks.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = randomUUID();
const platformOrganizationId = randomUUID();
const hotelGroupOrganizationId = randomUUID();
const propertyId = randomUUID();
const otherPropertyId = randomUUID();
const providerAccountId = randomUUID();
const providerAccountRef = `acct-vay-1345-${providerAccountId}`;
const acceptCommandId = randomUUID();
const acceptIdempotencyKey = randomUUID();
const revokeCommandId = randomUUID();
const revokeIdempotencyKey = randomUUID();
const legacyWriterEvidenceId = randomUUID();
const evidenceHash = "a".repeat(64);
const publicId = `vay-1345-${randomUUID()}`;
const stripeAccountUpdatedEventId = `evt_vay_1345_${randomUUID()}`;

describe.skipIf(!TEST_DATABASE_URL)("Online-card execution evidence PostgreSQL", () => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
  });
  const repository = createFinanceOnlineCardExecutionEvidenceRepository(pool);
  let evidenceId = "";

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await cleanup();
    await pool.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-1345 Finance Actor', 'active')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await pool.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'platform', 'VAY-1345 Platform', $2, 'active'),
              ($3::uuid, 'hotel_group', 'VAY-1345 Hotel Group', $4, 'active')`,
      [
        platformOrganizationId,
        `vay-1345-${platformOrganizationId}`,
        hotelGroupOrganizationId,
        `vay-1345-${hotelGroupOrganizationId}`,
      ],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'VAY-1345 Hotel'),
              ($3::uuid, $4, 'VAY-1345 Other Hotel')`,
      [propertyId, publicId, otherPropertyId, `vay-1345-${otherPropertyId}`],
    );
    await pool.query(
      `INSERT INTO pms.property_pricing_settings
         (property_id, currency, pricing_currency_revision)
       VALUES ($1::uuid, 'EUR', 1)`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO finance.payment_provider_accounts (
         id, property_id, account_scope, provider, provider_account_id,
         status, onboarding_status, charges_enabled, payouts_enabled,
         default_currency, capabilities, account_metadata, card_capability_revision
       ) VALUES (
         $1::uuid, $2::uuid, 'property', 'stripe', $3,
         'active', 'completed', TRUE, TRUE, 'EUR', ARRAY['card_payments'],
         '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}'::jsonb, 7
       )`,
      [providerAccountId, propertyId, providerAccountRef],
    );
    await pool.query(
      `INSERT INTO finance.payment_settings (
         property_id, provider_account_id, payments_enabled, accepted_methods,
         default_currency, payment_readiness_contract_version,
         payment_methods_revision, source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, TRUE, ARRAY['card','pay_at_property','cash'], 'EUR',
         'finance-payment-readiness.v1', 1, 1
       )`,
      [propertyId, providerAccountId],
    );
    await pool.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin)
       VALUES ($1::uuid, $2::uuid, 'active', 'owner', 'agency')`,
      [hotelGroupOrganizationId, actorUserId],
    );
    await pool.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [hotelGroupOrganizationId, propertyId],
    );
    await pool.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [hotelGroupOrganizationId, propertyId],
    );
    await pool.query(
      `INSERT INTO booking.booking_settings (
         property_id, default_currency, default_language, supported_languages,
         acceptance_mode
       ) VALUES ($1::uuid, 'EUR', 'en', ARRAY['en'], 'instant')`,
      [propertyId],
    );
    await pool.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (
         property_id, public_id, display_name, canonical_slug,
         default_locale, supported_locales, profile_status
       ) VALUES ($1::uuid, $2, 'VAY-1345 Hotel', $2, 'en', ARRAY['en'], 'complete')`,
      [propertyId, publicId],
    );
    await pool.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles (
         property_id, finance_payment_settings_property_id, public_id, canonical_slug,
         canonical_url, booking_base_url, timezone, default_locale, supported_locales,
         default_currency, supported_currencies, profile_status, freshness_status,
         capabilities
       ) VALUES (
         $1::uuid, $1::uuid, $2, $2, $3, 'https://booking.example.test',
         'Europe/Berlin', 'en', ARRAY['en'], 'EUR', ARRAY['EUR'], 'public', 'fresh',
         '{"onlinePayment":false,"payAtProperty":true,"paymentMethods":["pay_at_property"]}'::jsonb
       )`,
      [propertyId, publicId, `https://booking.example.test/${publicId}`],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("accepts exact-revision evidence, replays once, and never silently publishes card", async () => {
    const accepted = await repository.acceptOnlineCardExecutionEvidence(acceptCommand());
    expect(accepted).toMatchObject({
      ok: true,
      status: "accepted",
      response: {
        propertyId,
        providerCapabilityRevision: 7,
        propertyReadinessRevision: 1,
        status: "accepted",
        cardReady: true,
        commandMeta: {
          commandId: acceptCommandId,
          idempotencyKey: createHash("sha256").update(acceptIdempotencyKey).digest("hex"),
        },
      },
    });
    if (!accepted.ok) throw new Error("Expected accepted evidence");
    evidenceId = accepted.response.evidenceId;

    const replay = await repository.acceptOnlineCardExecutionEvidence(acceptCommand());
    expect(replay).toEqual({ ...accepted, status: "idempotent_replay" });

    await expect(publicPaymentMethods()).resolves.toEqual(["pay_at_property"]);
    const durable = await pool.query<{
      evidenceHash: string;
      audits: unknown;
      events: unknown;
      outbox: unknown;
      idempotency: unknown;
    }>(
      `SELECT
         evidence.evidence_fingerprint_hash AS "evidenceHash",
         (SELECT jsonb_agg(jsonb_build_object(
           'redacted', redacted_payload, 'private', private_payload, 'metadata', audit_metadata
         )) FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audits,
         (SELECT jsonb_agg(jsonb_build_object('payload', payload, 'metadata', event_metadata))
          FROM platform.domain_events WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed') AS events,
         (SELECT jsonb_agg(jsonb_build_object('payload', payload, 'metadata', outbox_metadata))
          FROM platform.outbox_events WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed') AS outbox,
         (SELECT jsonb_agg(idempotency_metadata) FROM platform.idempotency_keys
          WHERE property_id = $1::uuid
            AND operation = 'finance.online_card_execution_evidence.accept') AS idempotency
       FROM finance.online_card_execution_evidence evidence
       WHERE evidence.id = $2::uuid`,
      [propertyId, evidenceId],
    );
    expect(durable.rows[0]?.evidenceHash).toBe(evidenceHash);
    expect(JSON.stringify(durable.rows[0])).not.toMatch(
      /provider_account_id|providerAccountRef|client_secret|authorization/i,
    );
    expect(JSON.stringify(durable.rows[0]?.audits)).not.toContain(evidenceHash);
    expect(JSON.stringify(durable.rows[0]?.events)).not.toContain(evidenceHash);
    expect(JSON.stringify(durable.rows[0]?.outbox)).not.toContain(evidenceHash);
    expect(JSON.stringify(durable.rows[0]?.idempotency)).not.toContain(evidenceHash);
  });

  it("rejects stale capability revisions without durable side effects", async () => {
    const staleCommandId = randomUUID();
    const result = await repository.acceptOnlineCardExecutionEvidence(
      acceptCommand({
        commandId: staleCommandId,
        idempotencyKey: randomUUID(),
        expectedCardCapabilityRevision: 6,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "provider_capability_revision_conflict",
    });
    const key = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.idempotency_keys
       WHERE property_id = $1::uuid
         AND operation = 'finance.online_card_execution_evidence.accept'
         AND idempotency_metadata ->> 'commandId' = $2`,
      [propertyId, staleCommandId],
    );
    expect(key.rows[0]?.count).toBe(0);
  });

  it("rejects stale property readiness revisions without durable side effects", async () => {
    const result = await repository.acceptOnlineCardExecutionEvidence(
      acceptCommand({
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        expectedPropertyReadinessRevision: 2,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      code: "property_readiness_revision_conflict",
    });
  });

  it("denies cross-property revocation, then revokes once and suppresses only card", async () => {
    const wrongProperty = await repository.revokeOnlineCardExecutionEvidence(
      revokeCommand({
        propertyId: otherPropertyId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    expect(wrongProperty).toMatchObject({
      ok: false,
      statusCode: 404,
      code: "evidence_not_found",
    });

    await pool.query(
      `UPDATE distribution.public_hotel_bookability_profiles
       SET capabilities = '{"onlinePayment":true,"payAtProperty":true,"paymentMethods":["card","pay_at_property"]}'::jsonb
       WHERE property_id = $1::uuid`,
      [propertyId],
    );

    let releaseEvidenceUpdate!: () => void;
    let markEvidenceUpdateReached!: () => void;
    const evidenceUpdateReached = new Promise<void>((resolve) => {
      markEvidenceUpdateReached = resolve;
    });
    const evidenceUpdateRelease = new Promise<void>((resolve) => {
      releaseEvidenceUpdate = resolve;
    });
    const pausedRepository = createFinanceOnlineCardExecutionEvidenceRepository({
      async connect() {
        const client = await pool.connect();
        return {
          async query<T extends QueryResultRow = QueryResultRow>(
            text: string,
            values?: readonly unknown[],
          ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
            if (text.includes("UPDATE finance.online_card_execution_evidence")) {
              markEvidenceUpdateReached();
              await evidenceUpdateRelease;
            }
            const result = await client.query<T>(text, values ? [...values] : undefined);
            return { rows: result.rows, rowCount: result.rowCount };
          },
          release() {
            client.release();
          },
        };
      },
    });
    const sameCrossOperationKey = { idempotencyKey: acceptIdempotencyKey };
    const revocation = pausedRepository.revokeOnlineCardExecutionEvidence(
      revokeCommand(sameCrossOperationKey),
    );
    await evidenceUpdateReached;
    const concurrent = await pool.connect();
    let settingsUpdateFinished = false;
    const settingsUpdate = concurrent
      .query(
        `UPDATE finance.payment_settings SET updated_at = updated_at
         WHERE property_id = $1::uuid`,
        [propertyId],
      )
      .then(() => {
        settingsUpdateFinished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const settingsUpdatedBeforeRevocation = settingsUpdateFinished;
    releaseEvidenceUpdate();

    const revoked = await revocation;
    await settingsUpdate;
    concurrent.release();
    expect(settingsUpdatedBeforeRevocation).toBe(false);
    expect(revoked).toMatchObject({
      ok: true,
      status: "revoked",
      response: { propertyId, status: "revoked", cardReady: false },
    });
    const replay = await repository.revokeOnlineCardExecutionEvidence(
      revokeCommand(sameCrossOperationKey),
    );
    expect(replay).toEqual({ ...revoked, status: "idempotent_replay" });

    await expect(publicPaymentMethods()).resolves.toEqual(["pay_at_property"]);
    const state = await pool.query<{
      ready: boolean;
      outcomes: string[];
      outboxCount: number;
      otherPropertyEvents: number;
    }>(
      `SELECT
         (SELECT online_card_ready FROM finance.online_card_readiness
          WHERE property_id = $1::uuid) AS ready,
         ARRAY(SELECT payload ->> 'outcome' FROM platform.domain_events
               WHERE property_id = $1::uuid
                 AND event_type = 'finance.online_card_readiness.changed'
               ORDER BY occurred_at, id) AS outcomes,
         (SELECT count(*)::int FROM platform.outbox_events
          WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed') AS "outboxCount",
         (SELECT count(*)::int FROM platform.domain_events
          WHERE property_id = $2::uuid) AS "otherPropertyEvents"`,
      [propertyId, otherPropertyId],
    );
    expect(state.rows[0]).toEqual({
      ready: false,
      outcomes: ["readiness_gained", "readiness_lost"],
      outboxCount: 2,
      otherPropertyEvents: 0,
    });
  });

  it("serializes evidence acceptance after a concurrent card selection and emits the gain", async () => {
    await pool.query(
      `UPDATE finance.payment_settings
       SET accepted_methods = ARRAY['pay_at_property'], payment_methods_revision = 2
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    const beforeSelection = await pool.query<{ revision: number }>(
      `SELECT online_card_readiness_revision::int AS revision
       FROM finance.payment_settings WHERE property_id = $1::uuid`,
      [propertyId],
    );

    let releaseSelection!: () => void;
    let markPropertyLocked!: () => void;
    const propertyLocked = new Promise<void>((resolve) => {
      markPropertyLocked = resolve;
    });
    const selectionRelease = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const paymentRepository = createPgFinancePaymentReadinessCommandRepository({
      connectionString: TEST_DATABASE_URL!,
      now: () => new Date("2026-08-28T10:20:00.000Z"),
      pool: {
        async connect() {
          const client = await pool.connect();
          return {
            async query<T extends QueryResultRow = QueryResultRow>(
              text: string,
              values?: readonly unknown[],
            ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
              const result = await client.query<T>(text, values ? [...values] : undefined);
              if (text.includes("FOR UPDATE OF property")) {
                markPropertyLocked();
                await selectionRelease;
              }
              return { rows: result.rows, rowCount: result.rowCount };
            },
            release() {
              client.release();
            },
          };
        },
        async end() {},
      },
    });
    const paymentCommand = parseReplaceFinancePaymentMethodsCommand({
      organizationId: hotelGroupOrganizationId,
      propertyId,
      idempotencyKey: "key-concurrent-card-selection",
      expectedPaymentMethodsRevision: 2,
      expectedPricingCurrencyRevision: 1,
      selectedMethods: ["card", "pay_at_property"],
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-concurrent-card-selection",
        correlationId: "correlation-concurrent-card-selection",
        requestedAt: "2026-08-28T10:20:00.000Z",
      },
    });
    if (!paymentCommand) throw new Error("Concurrent payment command is invalid");

    const selection = paymentRepository.replacePaymentMethods({
      command: paymentCommand,
      currentPricing: {
        contractVersion: "pms-pricing.v1",
        currency: "EUR",
        pricingCurrencyRevision: 1,
      },
    });
    await propertyLocked;
    let acceptanceFinished = false;
    const acceptance = repository
      .acceptOnlineCardExecutionEvidence(
        acceptCommand({
          commandId: randomUUID(),
          idempotencyKey: randomUUID(),
          evidenceFingerprintHash: "b".repeat(64),
          expectedPropertyReadinessRevision: beforeSelection.rows[0]!.revision + 1,
          executedAt: "2026-08-28T10:20:30.000Z",
          requestedAt: "2026-08-28T10:21:00.000Z",
        }),
      )
      .then((result) => {
        acceptanceFinished = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(acceptanceFinished).toBe(false);
    releaseSelection();

    await expect(selection).resolves.toMatchObject({ ok: true });
    await expect(acceptance).resolves.toMatchObject({
      ok: true,
      status: "accepted",
      response: { cardReady: true },
    });
    const changes = await pool.query<{ outcome: string }>(
      `SELECT payload ->> 'outcome' AS outcome
       FROM platform.domain_events
       WHERE property_id = $1::uuid
         AND event_type IN (
           'finance.payment_readiness.changed',
           'finance.online_card_readiness.changed'
         )
         AND occurred_at >= '2026-08-28T10:20:00Z'
       ORDER BY occurred_at, id`,
      [propertyId],
    );
    expect(changes.rows.map(({ outcome }) => outcome)).toEqual([
      "selection_changed",
      "readiness_gained",
    ]);
    await expect(publicPaymentMethods()).resolves.toEqual(["pay_at_property"]);
  });

  it("invalidates evidence and suppresses card when another onboarding link is issued", async () => {
    await publishCard();
    const targetRepository = createTargetFinancePropertySettingsRepository({
      connectionString: TEST_DATABASE_URL!,
      pool,
      stripeConnectProvider: stripeProvider(),
    });
    const result = await targetRepository.issueStripeOnboardingLink!(onboardingLinkCommand());

    expect(result).toMatchObject({
      ok: true,
      response: {
        onboardingStatus: "invited",
        commandMeta: { outboxEvents: ["finance.online_card_readiness.changed"] },
      },
    });
    await expect(publicPaymentMethods()).resolves.toEqual(["pay_at_property"]);
    const state = await pool.query<{ revision: number; ready: boolean; losses: number }>(
      `SELECT
         account.card_capability_revision::int AS revision,
         readiness.online_card_ready AS ready,
         (SELECT count(*)::int FROM platform.domain_events
          WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed'
            AND payload ->> 'outcome' = 'readiness_lost') AS losses
       FROM finance.payment_provider_accounts account
       JOIN finance.online_card_readiness readiness
         ON readiness.provider_account_id = account.id
       WHERE account.id = $2::uuid`,
      [propertyId, providerAccountId],
    );
    expect(state.rows[0]).toMatchObject({ revision: 8, ready: false, losses: 2 });
  });

  it("emits and suppresses loss from the legacy payment-settings writer", async () => {
    await pool.query(
      `UPDATE finance.online_card_execution_evidence
       SET revoked_at = '2026-08-28T10:29:00Z', updated_at = '2026-08-28T10:29:00Z'
       WHERE provider_account_id = $1::uuid AND revoked_at IS NULL`,
      [providerAccountId],
    );
    await pool.query(
      `UPDATE finance.payment_provider_accounts
       SET status = 'active', onboarding_status = 'completed'
       WHERE id = $1::uuid`,
      [providerAccountId],
    );
    const revision = await pool.query<{ account: number; property: number }>(
      `SELECT account.card_capability_revision::int AS account,
              settings.online_card_readiness_revision::int AS property
       FROM finance.payment_provider_accounts account
       JOIN finance.payment_settings settings ON settings.provider_account_id = account.id
       WHERE account.id = $1::uuid`,
      [providerAccountId],
    );
    await pool.query(
      `INSERT INTO finance.online_card_execution_evidence (
         id, property_id, provider_account_id, contract_version, test_suite,
         provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
         executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'finance-online-card-execution-evidence.v1', 'onb-25a',
         $4, $5, $6, '2026-08-28T10:29:10Z', '2026-08-28T10:29:20Z', $7::uuid, $8::uuid
       )`,
      [
        legacyWriterEvidenceId,
        propertyId,
        providerAccountId,
        revision.rows[0]!.account,
        revision.rows[0]!.property,
        "c".repeat(64),
        platformOrganizationId,
        actorUserId,
      ],
    );
    await publishCard();
    const targetRepository = createTargetFinancePropertySettingsRepository({
      connectionString: TEST_DATABASE_URL!,
      pool,
    });
    const result = await targetRepository.updatePaymentSettings!({
      commandType: "finance.payment_settings.update",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId,
      audit: {
        actor: {
          kind: "user",
          userId: actorUserId,
          organizationId: hotelGroupOrganizationId,
        },
        requestId: randomUUID(),
        correlationId: randomUUID(),
        reason: "Remove online card through the legacy Finance writer",
        requestedAt: "2026-08-28T10:30:00.000Z",
      },
      payload: { acceptedMethods: ["pay_at_property", "cash"] },
    });

    expect(result).toMatchObject({
      ok: true,
      commandMeta: { outboxEvents: ["finance.online_card_readiness.changed"] },
    });
    await expect(publicPaymentMethods()).resolves.toEqual(["pay_at_property"]);
  });

  it("repairs a stale public card projection when already-unready evidence is revoked", async () => {
    await publishCard();
    const before = await lossCount();

    const revoked = await repository.revokeOnlineCardExecutionEvidence(
      revokeCommand({
        evidenceId: legacyWriterEvidenceId,
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        requestedAt: "2026-08-28T10:31:00.000Z",
      }),
    );

    expect(revoked).toMatchObject({
      ok: true,
      status: "revoked",
      response: { cardReady: false, commandMeta: { outboxEvents: [] } },
    });
    await expect(publicPaymentMethods()).resolves.toEqual(["pay_at_property"]);
    await expect(lossCount()).resolves.toBe(before);
  });

  it("durably retries Stripe compensation after a provider-account write failure", async () => {
    await pool.query(
      `CREATE FUNCTION finance.vay1345_reject_provider_account() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.provider_account_id = 'acct-compensation-retry-1345' THEN
           RAISE EXCEPTION 'injected provider-account write failure';
         END IF;
         RETURN NEW;
       END;
       $$;
       CREATE TRIGGER vay1345_reject_provider_account
       BEFORE INSERT ON finance.payment_provider_accounts
       FOR EACH ROW EXECUTE FUNCTION finance.vay1345_reject_provider_account()`,
    );
    let compensationCount = 0;
    const provider: FinanceStripeConnectProvider = {
      async createAccount() {
        return {
          providerAccountRef: "acct-compensation-retry-1345",
          onboardingUrl: "https://connect.stripe.test/compensation-retry",
        };
      },
      async createOnboardingLink() {
        throw new Error("unexpected onboarding-link call");
      },
      async createLoginLink() {
        throw new Error("unexpected login-link call");
      },
      async retrieveAccount() {
        throw new Error("unexpected account retrieval");
      },
      async compensateAccountCreation() {
        compensationCount += 1;
        if (compensationCount === 1) throw new Error("temporary compensation failure");
      },
    };
    const targetRepository = createTargetFinancePropertySettingsRepository({
      connectionString: TEST_DATABASE_URL!,
      pool,
      stripeConnectProvider: provider,
    });
    try {
      const result = await targetRepository.createStripeProviderAccount!({
        commandType: "finance.provider_account.stripe.create",
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        propertyId: otherPropertyId,
        audit: {
          actor: {
            kind: "user",
            userId: actorUserId,
            organizationId: hotelGroupOrganizationId,
          },
          requestId: randomUUID(),
          correlationId: randomUUID(),
          reason: "Prove durable Stripe account compensation retry",
          requestedAt: "2026-08-28T10:34:00.000Z",
        },
        payload: {
          email: "compensation-retry@example.test",
          country: "DE",
          returnSurface: "marketplace",
        },
      });

      expect(result).toMatchObject({ ok: false, code: "write_unavailable" });
      const queued = await pool.query<{ status: string; providerAccountRef: string }>(
        `SELECT status, payload ->> 'providerAccountRef' AS "providerAccountRef"
         FROM platform.jobs
         WHERE queue_name = 'finance-provider-compensation'
           AND property_id = $1::uuid`,
        [otherPropertyId],
      );
      expect(queued.rows).toEqual([
        { status: "pending", providerAccountRef: "acct-compensation-retry-1345" },
      ]);
      await expect(
        runFinanceStripeAccountCompensationJobs(TEST_DATABASE_URL!, provider, { limit: 1 }),
      ).resolves.toEqual({ succeeded: 1, retryScheduled: 0, failed: 0 });
      expect(compensationCount).toBe(2);
      const finished = await pool.query<{ status: string }>(
        `SELECT status FROM platform.jobs
         WHERE queue_name = 'finance-provider-compensation'
           AND property_id = $1::uuid`,
        [otherPropertyId],
      );
      expect(finished.rows).toEqual([{ status: "succeeded" }]);
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS vay1345_reject_provider_account
         ON finance.payment_provider_accounts;
         DROP FUNCTION IF EXISTS finance.vay1345_reject_provider_account()`,
      );
    }
  });

  it("rejects a Stripe ref already owned by another property without compensating it", async () => {
    let compensationCount = 0;
    const provider: FinanceStripeConnectProvider = {
      async createAccount() {
        return {
          providerAccountRef,
          onboardingUrl: "https://connect.stripe.test/foreign-owner",
        };
      },
      async createOnboardingLink() {
        throw new Error("unexpected onboarding-link call");
      },
      async createLoginLink() {
        throw new Error("unexpected login-link call");
      },
      async retrieveAccount() {
        throw new Error("unexpected account retrieval");
      },
      async compensateAccountCreation() {
        compensationCount += 1;
      },
    };
    const targetRepository = createTargetFinancePropertySettingsRepository({
      connectionString: TEST_DATABASE_URL!,
      pool,
      stripeConnectProvider: provider,
    });

    const result = await targetRepository.createStripeProviderAccount!({
      commandType: "finance.provider_account.stripe.create",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId: otherPropertyId,
      audit: {
        actor: {
          kind: "user",
          userId: actorUserId,
          organizationId: hotelGroupOrganizationId,
        },
        requestId: randomUUID(),
        correlationId: randomUUID(),
        reason: "Reject a foreign Stripe account reference",
        requestedAt: "2026-08-28T10:35:00.000Z",
      },
      payload: {
        email: "foreign-ref@example.test",
        country: "DE",
        returnSurface: "marketplace",
      },
    });

    expect(result).toMatchObject({ ok: false, code: "provider_rejected" });
    expect(compensationCount).toBe(0);
    const owner = await pool.query<{ propertyId: string }>(
      `SELECT property_id::text AS "propertyId"
       FROM finance.payment_provider_accounts
       WHERE provider = 'stripe' AND provider_account_id = $1`,
      [providerAccountRef],
    );
    expect(owner.rows).toEqual([{ propertyId }]);
  });

  it("keeps one property Stripe account and compensates the concurrent loser", async () => {
    let createCount = 0;
    const compensated: string[] = [];
    let releaseFirst!: () => void;
    const secondCreateStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const provider: FinanceStripeConnectProvider = {
      async createAccount() {
        createCount += 1;
        const call = createCount;
        if (call === 1) await secondCreateStarted;
        else releaseFirst();
        return {
          providerAccountRef: `acct-concurrent-${call}`,
          onboardingUrl: `https://connect.stripe.test/concurrent/${call}`,
        };
      },
      async createOnboardingLink() {
        throw new Error("unexpected onboarding-link call");
      },
      async createLoginLink() {
        throw new Error("unexpected login-link call");
      },
      async retrieveAccount() {
        throw new Error("unexpected account retrieval");
      },
      async compensateAccountCreation(input) {
        compensated.push(input.providerAccountRef);
      },
    };
    const targetRepository = createTargetFinancePropertySettingsRepository({
      connectionString: TEST_DATABASE_URL!,
      pool,
      stripeConnectProvider: provider,
    });
    const createCommand = (suffix: string) => ({
      commandType: "finance.provider_account.stripe.create" as const,
      commandId: randomUUID(),
      idempotencyKey: `vay-1345-concurrent-${suffix}-${randomUUID()}`,
      propertyId: otherPropertyId,
      audit: {
        actor: {
          kind: "user" as const,
          userId: actorUserId,
          organizationId: hotelGroupOrganizationId,
        },
        requestId: randomUUID(),
        correlationId: randomUUID(),
        reason: "Prove property Stripe account creation serialization",
        requestedAt: "2026-08-28T10:40:00.000Z",
      },
      payload: {
        email: `concurrent-${suffix}@example.test`,
        country: "DE",
        returnSurface: "marketplace" as const,
      },
    });

    const commands = [createCommand("a"), createCommand("b")] as const;
    const results = await Promise.all(
      commands.map((command) => targetRepository.createStripeProviderAccount!(command)),
    );

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, status: "created" }),
        expect.objectContaining({ ok: true, status: "existing_owner_account" }),
      ]),
    );
    expect(createCount).toBe(2);
    expect(compensated).toHaveLength(1);
    const replays = await Promise.all(
      commands.map((command) => targetRepository.createStripeProviderAccount!(command)),
    );
    expect(replays).toEqual(
      results.map((result) =>
        result.ok ? { ok: true, status: "idempotent_replay", response: result.response } : result,
      ),
    );
    expect(createCount).toBe(2);
    const accounts = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM finance.payment_provider_accounts
       WHERE property_id = $1::uuid
         AND provider = 'stripe'
         AND provider_account_id NOT LIKE 'settings-choice:%'`,
      [otherPropertyId],
    );
    expect(accounts.rows[0]?.count).toBe(1);
  });

  it("promotes routed account.updated identity with one hash and an internal resource ID", async () => {
    await pool.query(
      `UPDATE finance.payment_provider_accounts
       SET status = 'active', onboarding_status = 'completed', charges_enabled = TRUE,
           payouts_enabled = TRUE, default_currency = 'EUR', capabilities = ARRAY['card_payments'],
           account_metadata = '{"detailsSubmitted":true,"cardPaymentsStatus":"active"}'::jsonb
       WHERE id = $1::uuid`,
      [providerAccountId],
    );
    const webhookSecret = "whsec_vay_1345_integration";
    const now = new Date("2026-08-28T11:00:00.000Z");
    const payload = {
      id: stripeAccountUpdatedEventId,
      type: "account.updated",
      data: {
        object: {
          id: providerAccountRef,
          charges_enabled: true,
          payouts_enabled: false,
          details_submitted: true,
          capabilities: { card_payments: "active" },
          default_currency: "eur",
        },
      },
    };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(now.getTime() / 1_000);
    const signature = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    let retrieveCount = 0;
    let releaseRetrieve!: () => void;
    const retrieveRelease = new Promise<void>((resolve) => {
      releaseRetrieve = resolve;
    });
    let announceRetrieveStarted!: () => void;
    const retrieveStarted = new Promise<void>((resolve) => {
      announceRetrieveStarted = resolve;
    });
    const store = createPgProviderWebhookStore({
      connectionString: TEST_DATABASE_URL!,
      stripeConnectProvider: {
        async retrieveAccount({ providerAccountRef: requestedRef }) {
          retrieveCount += 1;
          announceRetrieveStarted();
          await retrieveRelease;
          return {
            providerAccountRef: requestedRef,
            chargesEnabled: true,
            payoutsEnabled: false,
            detailsSubmitted: true,
            cardPaymentsStatus: "active",
            defaultCurrency: "eur",
          };
        },
      },
    });
    const promoteReceipt = store.promoteReceipt.bind(store);
    let promotionCount = 0;
    let announceSecondPromotion!: () => void;
    const secondPromotionStarted = new Promise<void>((resolve) => {
      announceSecondPromotion = resolve;
    });
    store.promoteReceipt = async (input) => {
      promotionCount += 1;
      if (promotionCount === 2) announceSecondPromotion();
      return promoteReceipt(input);
    };
    const app = buildApp({
      providerWebhooks: {
        secrets: { stripe: webhookSecret },
        modes: { stripe: "mutating" },
        store,
        now: () => now,
      },
    });
    try {
      const request = () =>
        app.inject({
          method: "POST",
          url: "/webhooks/stripe",
          headers: {
            "content-type": "application/json",
            "stripe-signature": `t=${timestamp},v1=${signature}`,
          },
          payload: body,
        });
      const firstResponse = request();
      await retrieveStarted;
      const secondResponse = request();
      await secondPromotionStarted;
      releaseRetrieve();
      const responses = await Promise.all([firstResponse, secondResponse]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(responses.map((response) => response.json().status).sort()).toEqual([
        "already_promoted",
        "promoted",
      ]);
      const replay = await request();
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ status: "duplicate", lifecycleStatus: "promoted" });
      expect(retrieveCount).toBe(1);
      expect(promotionCount).toBe(2);

      const durable = await pool.query<{
        resourceId: string;
        eventKey: string;
        jobResourceId: string;
        jobKey: string;
      }>(
        `SELECT event.resource_id AS "resourceId", event.event_key AS "eventKey",
                job.resource_id AS "jobResourceId", job.job_key AS "jobKey"
         FROM platform.domain_events event
         JOIN platform.jobs job ON job.source_domain_event_id = event.id
         WHERE event.event_type = 'finance.provider-account.updated'
           AND event.event_key LIKE $1
         LIMIT 1`,
        [`%:${stripeAccountUpdatedEventId}:v1`],
      );
      const providerAccountHash = `sha256:${createHash("sha256")
        .update(providerAccountRef)
        .digest("hex")}`;
      expect(durable.rows[0]).toEqual({
        resourceId: providerAccountId,
        eventKey: `finance.provider-account.updated:stripe:${providerAccountHash}:${stripeAccountUpdatedEventId}:v1`,
        jobResourceId: providerAccountId,
        jobKey: `finance.reconcile-provider-account:provider_account:${providerAccountHash}:${stripeAccountUpdatedEventId}:v1`,
      });
      expect(JSON.stringify(durable.rows[0])).not.toContain(providerAccountRef);
      const receipt = await pool.query<{
        rawHeaders: Record<string, unknown>;
        payloadRetentionUntil: Date;
      }>(
        `SELECT raw_headers AS "rawHeaders",
                payload_retention_until AS "payloadRetentionUntil"
         FROM platform.external_webhook_events
         WHERE provider = 'stripe' AND provider_event_id = $1`,
        [`webhook:stripe:${stripeAccountUpdatedEventId}`],
      );
      expect(receipt.rows[0]?.rawHeaders).toEqual({});
      expect(receipt.rows[0]?.payloadRetentionUntil).toBeInstanceOf(Date);
    } finally {
      await app.close();
      await store.close?.();
    }
  });

  function stripeProvider(): FinanceStripeConnectProvider {
    return {
      async createAccount() {
        throw new Error("unexpected createAccount call");
      },
      async createOnboardingLink() {
        return "https://connect.stripe.test/onboarding/vay-1345";
      },
      async createLoginLink() {
        throw new Error("unexpected createLoginLink call");
      },
      async retrieveAccount() {
        throw new Error("unexpected retrieveAccount call");
      },
    };
  }

  function onboardingLinkCommand(): IssueStripeOnboardingLinkCommand {
    return {
      commandType: "finance.provider_account.stripe.onboarding_link.issue",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      propertyId,
      audit: {
        actor: {
          kind: "user",
          userId: actorUserId,
          organizationId: hotelGroupOrganizationId,
        },
        requestId: randomUUID(),
        correlationId: randomUUID(),
        reason: "Issue a new Stripe onboarding link",
        requestedAt: "2026-08-28T10:25:00.000Z",
      },
      payload: { providerAccountId },
    };
  }

  async function publishCard(): Promise<void> {
    await pool.query(
      `UPDATE distribution.public_hotel_bookability_profiles
       SET capabilities = '{"onlinePayment":true,"payAtProperty":true,"paymentMethods":["card","pay_at_property"]}'::jsonb
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
  }

  function acceptCommand(
    overrides: Partial<{
      commandId: string;
      idempotencyKey: string;
      expectedCardCapabilityRevision: number;
      expectedPropertyReadinessRevision: number;
      evidenceFingerprintHash: string;
      executedAt: string;
      requestedAt: string;
    }> = {},
  ): AcceptFinanceOnlineCardExecutionEvidenceCommand {
    return {
      commandType: "finance.online_card_execution_evidence.accept",
      commandId: overrides.commandId ?? acceptCommandId,
      idempotencyKey: overrides.idempotencyKey ?? acceptIdempotencyKey,
      propertyId,
      audit: {
        actor: {
          kind: "user",
          userId: actorUserId,
          organizationId: platformOrganizationId,
        },
        requestId: "request-accept",
        correlationId: "correlation-accept",
        reason: "Accept VAY-1345 ONB-25A evidence",
        requestedAt: overrides.requestedAt ?? "2026-08-28T10:05:00.000Z",
      },
      payload: {
        expectedCardCapabilityRevision: overrides.expectedCardCapabilityRevision ?? 7,
        expectedPropertyReadinessRevision: overrides.expectedPropertyReadinessRevision ?? 1,
        evidenceFingerprintHash: overrides.evidenceFingerprintHash ?? evidenceHash,
        executedAt: overrides.executedAt ?? "2026-08-28T10:00:00.000Z",
      },
    };
  }

  function revokeCommand(
    overrides: Partial<{
      propertyId: string;
      commandId: string;
      idempotencyKey: string;
      evidenceId: string;
      requestedAt: string;
    }> = {},
  ): RevokeFinanceOnlineCardExecutionEvidenceCommand {
    return {
      commandType: "finance.online_card_execution_evidence.revoke",
      commandId: overrides.commandId ?? revokeCommandId,
      idempotencyKey: overrides.idempotencyKey ?? revokeIdempotencyKey,
      propertyId: overrides.propertyId ?? propertyId,
      audit: {
        actor: {
          kind: "user",
          userId: actorUserId,
          organizationId: platformOrganizationId,
        },
        requestId: "request-revoke",
        correlationId: "correlation-revoke",
        reason: "Revoke VAY-1345 ONB-25A evidence",
        requestedAt: overrides.requestedAt ?? "2026-08-28T10:10:00.000Z",
      },
      payload: { evidenceId: overrides.evidenceId ?? evidenceId },
    };
  }

  async function publicPaymentMethods(): Promise<string[]> {
    const result = await pool.query<{ methods: string[] }>(
      `SELECT ARRAY(
         SELECT jsonb_array_elements_text(capabilities -> 'paymentMethods') ORDER BY 1
       ) AS methods
       FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0]?.methods ?? [];
  }

  async function lossCount(): Promise<number> {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.domain_events
       WHERE property_id = $1::uuid
         AND event_type = 'finance.online_card_readiness.changed'
         AND payload ->> 'outcome' = 'readiness_lost'`,
      [propertyId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function cleanup(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `DELETE FROM platform.idempotency_keys
         WHERE idempotency_metadata ->> 'receiptKey' = $1`,
        [`webhook:stripe:${stripeAccountUpdatedEventId}`],
      );
      await client.query("DELETE FROM platform.jobs WHERE job_key LIKE $1", [
        `%:${stripeAccountUpdatedEventId}:v1`,
      ]);
      await client.query("DELETE FROM platform.product_audit_events WHERE audit_key LIKE $1", [
        `%:${stripeAccountUpdatedEventId}:v1`,
      ]);
      await client.query("DELETE FROM platform.domain_events WHERE event_key LIKE $1", [
        `%:${stripeAccountUpdatedEventId}:v1`,
      ]);
      await client.query(
        `DELETE FROM platform.external_webhook_events
         WHERE provider = 'stripe' AND provider_event_id = $1`,
        [stripeAccountUpdatedEventId],
      );
      for (const table of [
        "platform.outbox_events",
        "platform.domain_events",
        "platform.product_audit_events",
        "platform.idempotency_keys",
        "platform.jobs",
        "finance.online_card_execution_evidence",
        "distribution.public_hotel_bookability_profiles",
        "finance.payment_settings",
        "finance.payment_provider_accounts",
        "pms.property_pricing_settings",
        "booking.booking_settings",
        "hotel_catalog.property_public_profile_read_model",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE property_id = ANY($1::uuid[])`, [
          [propertyId, otherPropertyId],
        ]);
      }
      await client.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        [propertyId, otherPropertyId],
      ]);
      for (const table of [
        "identity.product_entitlements",
        "identity.organization_resource_links",
        "identity.organization_memberships",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, [
          hotelGroupOrganizationId,
        ]);
      }
      await client.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        [platformOrganizationId, hotelGroupOrganizationId],
      ]);
      await client.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(test|verify)/i.test(new URL(connectionString).pathname)) {
    throw new Error("Refusing non-test database");
  }
}
