import type {
  FinanceStripeConnectProvider,
  ReconcileStripePropertyAccountCommand,
  StripeConnectProviderAccountSnapshot,
} from "@vayada/domain-finance";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileStripeProviderAccount as reconcileStripeProviderAccountWebhook } from "../platform/providerWebhooks.js";
import { createTargetFinancePropertySettingsRepository } from "../routes/finance.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = randomUUID();
const organizationId = randomUUID();
const propertyId = randomUUID();
const providerAccountId = randomUUID();
const replacementProviderAccountId = randomUUID();
const publicId = `vay-1343-${randomUUID()}`;
const providerAccountRef = `stripe-account-${randomUUID()}`;
const providerAccountHash = `sha256:${createHash("sha256")
  .update(providerAccountRef)
  .digest("hex")}`;
const replacementProviderAccountRef = `stripe-account-${randomUUID()}`;
const auditTrigger = `trg_vay_1343_${randomUUID().replaceAll("-", "")}`;
const auditFunction = `fn_vay_1343_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!TEST_DATABASE_URL)("Stripe provider-account reconciliation PostgreSQL", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  let snapshot: StripeConnectProviderAccountSnapshot = activeSnapshot();
  let retrieveCount = 0;
  let retrieveAccount = async (
    requestedRef: string,
  ): Promise<StripeConnectProviderAccountSnapshot> => {
    expect(requestedRef).toBe(providerAccountRef);
    return snapshot;
  };
  const provider: FinanceStripeConnectProvider = {
    async retrieveAccount({ providerAccountRef: requestedRef }) {
      retrieveCount += 1;
      return retrieveAccount(requestedRef);
    },
    async createAccount() {
      throw new Error("unexpected createAccount call");
    },
    async createOnboardingLink() {
      throw new Error("unexpected createOnboardingLink call");
    },
    async createLoginLink() {
      throw new Error("unexpected createLoginLink call");
    },
  };
  const repository = createTargetFinancePropertySettingsRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    stripeConnectProvider: provider,
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
    await cleanup();
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'platform', 'VAY-1345 Reconciliation Review', $2, 'active')`,
      [organizationId, `vay-1345-reconciliation-${organizationId}`],
    );
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'VAY-1343 Finance Actor', 'active')`,
      [actorUserId, `${actorUserId}@example.test`],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'VAY-1343 Stripe Reconciliation Hotel')`,
      [propertyId, publicId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (
         property_id, public_id, display_name, canonical_slug,
         default_locale, supported_locales, profile_status
       ) VALUES ($1::uuid, $2, 'VAY-1343 Stripe Reconciliation Hotel', $2,
                 'en', ARRAY['en'], 'complete')`,
      [propertyId, publicId],
    );
    await admin.query(
      `INSERT INTO booking.booking_settings (
         property_id, acceptance_mode, default_currency, supported_languages
       ) VALUES ($1::uuid, 'instant', 'EUR', ARRAY['en'])`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.property_pricing_settings
         (property_id, currency, pricing_currency_revision)
       VALUES ($1::uuid, 'EUR', 1)`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO finance.payment_provider_accounts (
         id, property_id, account_scope, provider, provider_account_id,
         status, onboarding_status, charges_enabled, payouts_enabled,
         default_currency, capabilities, account_metadata
       ) VALUES (
         $1::uuid, $2::uuid, 'property', 'stripe', $3,
         'setup_incomplete', 'invited', FALSE, FALSE,
         'EUR', ARRAY['card_payments', 'transfers'], '{}'::jsonb
       )`,
      [providerAccountId, propertyId, providerAccountRef],
    );
    await admin.query(
      `INSERT INTO finance.payment_settings (
         property_id, provider_account_id, payments_enabled, accepted_methods, default_currency,
         payment_readiness_contract_version, payment_methods_revision,
         source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, TRUE, ARRAY['card'], 'EUR',
         'finance-payment-readiness.v1', 1, 1
       )`,
      [propertyId, providerAccountId],
    );
    await admin.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles (
         property_id, public_id, canonical_slug, canonical_url, booking_base_url,
         timezone, default_locale, supported_locales, default_currency,
         supported_currencies, profile_status, freshness_status, capabilities
       ) VALUES (
         $1::uuid, $2, $2, 'https://booking.example.test/' || $2,
         'https://booking.example.test', 'Europe/Berlin', 'en', ARRAY['en'],
         'EUR', ARRAY['EUR'], 'public', 'fresh',
         '{"onlinePayment":false,"paymentMethods":[]}'::jsonb
       )`,
      [propertyId, publicId],
    );
  });

  afterAll(async () => {
    await repository.close?.();
    await cleanup();
    await admin.end();
  });

  it("reconciles provider readiness without publishing card before execution evidence", async () => {
    retrieveCount = 0;
    const first = await repository.reconcileStripeProviderAccount!(command("gain"));
    expect(first).toMatchObject({
      ok: true,
      status: "reconciled",
      response: { providerAccount: { status: "active", ready: true } },
    });
    const firstProjection = await projection();
    expect(firstProjection.onlinePayment).toBe("false");

    const replay = await repository.reconcileStripeProviderAccount!(command("gain"));
    expect(replay).toMatchObject({
      ok: true,
      status: "idempotent_replay",
      response: { providerAccount: { status: "active", ready: true } },
    });
    expect((await projection()).projectedAt).toEqual(firstProjection.projectedAt);
    expect(retrieveCount).toBe(1);
    await expect(reconciliationCounts()).resolves.toEqual({
      audits: 1,
      keys: 1,
      readinessEvents: 0,
      readinessOutbox: 0,
    });

    const revision = await admin.query<{ revision: string }>(
      `SELECT card_capability_revision::text AS revision
       FROM finance.payment_provider_accounts WHERE id = $1::uuid`,
      [providerAccountId],
    );
    await admin.query(
      `INSERT INTO finance.online_card_execution_evidence (
         property_id, provider_account_id, contract_version, test_suite,
         provider_capability_revision, property_readiness_revision, evidence_fingerprint_hash,
         executed_at, accepted_at, accepted_by_organization_id, accepted_by_user_id
       ) VALUES (
         $1::uuid, $2::uuid, 'finance-online-card-execution-evidence.v1', 'onb-25a',
         $3::bigint, 1, $4, '2026-08-28T09:50:00Z', '2026-08-28T09:55:00Z',
         $5::uuid, $6::uuid
       )`,
      [
        propertyId,
        providerAccountId,
        revision.rows[0]!.revision,
        "e".repeat(64),
        organizationId,
        actorUserId,
      ],
    );
    await admin.query(
      `UPDATE distribution.public_hotel_bookability_profiles
       SET capabilities = capabilities ||
         '{"onlinePayment":true,"paymentMethods":["card"]}'::jsonb
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    const ready = await admin.query<{ ready: boolean }>(
      `SELECT online_card_ready AS ready FROM finance.online_card_readiness
       WHERE property_id = $1::uuid`,
      [propertyId],
    );
    expect(ready.rows[0]?.ready).toBe(true);

    snapshot = { ...activeSnapshot(), payoutsEnabled: false, cardPaymentsStatus: null };
    const loss = await repository.reconcileStripeProviderAccount!(command("loss"));
    expect(loss).toMatchObject({
      ok: true,
      status: "reconciled",
      response: {
        providerAccount: {
          status: "setup_incomplete",
          payoutsEnabled: false,
          cardPaymentsStatus: null,
          ready: false,
        },
        commandMeta: { outboxEvents: ["finance.online_card_readiness.changed"] },
      },
    });
    expect((await projection()).onlinePayment).toBe("false");
    expect(retrieveCount).toBe(2);
    await expect(reconciliationCounts()).resolves.toEqual({
      audits: 2,
      keys: 2,
      readinessEvents: 1,
      readinessOutbox: 1,
    });

    const revisionPayloadTypes = await admin.query<{
      domainEvent: string;
      outboxEvent: string;
    }>(
      `SELECT
         (SELECT jsonb_typeof(payload -> 'providerCapabilityRevision')
          FROM platform.domain_events
          WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed'
          ORDER BY occurred_at DESC
          LIMIT 1) AS "domainEvent",
         (SELECT jsonb_typeof(payload -> 'providerCapabilityRevision')
          FROM platform.outbox_events
          WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed'
          ORDER BY created_at DESC
          LIMIT 1) AS "outboxEvent"`,
      [propertyId],
    );
    expect(revisionPayloadTypes.rows[0]).toEqual({
      domainEvent: "number",
      outboxEvent: "number",
    });

    const durable = await admin.query<{ payloads: unknown }>(
      `SELECT jsonb_build_object(
         'audits', (SELECT jsonb_agg(jsonb_build_object(
           'redacted', redacted_payload, 'private', private_payload, 'metadata', audit_metadata
         )) FROM platform.product_audit_events
         WHERE property_id = $1::uuid AND action = 'finance.provider_account.stripe.reconciled'),
         'keys', (SELECT jsonb_agg(idempotency_metadata) FROM platform.idempotency_keys
         WHERE property_id = $1::uuid AND operation = 'stripe_provider_account_reconcile')
       ) AS payloads`,
      [propertyId],
    );
    expect(JSON.stringify(durable.rows[0]?.payloads)).not.toMatch(
      /stripe-account-|rawPayload|secret|authorization/i,
    );
  });

  it("tolerates a pre-existing deterministic audit key without duplicate effects", async () => {
    const suffix = "audit-conflict";
    const keyHash = createHash("sha256").update(`key-${suffix}`).digest("hex");
    const auditKey = `finance.provider-account.stripe.reconcile.property.${propertyId}.key.${keyHash}.v1`;
    await admin.query(
      `INSERT INTO platform.product_audit_events (
         audit_key, product, action, occurred_at, tenant_scope, property_id,
         actor_type, target_resource_product, target_resource_type, target_resource_id
       ) VALUES (
         $1, 'finance', 'finance.provider_account.stripe.reconciled', now(),
         'property', $2::uuid, 'system', 'finance', 'payment_provider_account', $3
       )`,
      [auditKey, propertyId, providerAccountId],
    );
    snapshot = activeSnapshot();
    retrieveCount = 0;

    await expect(
      repository.reconcileStripeProviderAccount!(command(suffix)),
    ).resolves.toMatchObject({
      ok: true,
      status: "reconciled",
      response: { providerAccount: { ready: true } },
    });
    const firstProjection = await projection();
    await expect(
      repository.reconcileStripeProviderAccount!(command(suffix)),
    ).resolves.toMatchObject({
      ok: true,
      status: "idempotent_replay",
    });
    expect((await projection()).projectedAt).toEqual(firstProjection.projectedAt);
    expect(retrieveCount).toBe(1);
    const evidence = await admin.query<{ audits: number; keys: number }>(
      `SELECT
         (SELECT count(*)::int FROM platform.product_audit_events
          WHERE product = 'finance' AND audit_key = $1) AS audits,
         (SELECT count(*)::int FROM platform.idempotency_keys
          WHERE operation_scope = 'finance'
            AND operation = 'stripe_provider_account_reconcile'
            AND key_hash = $2) AS keys`,
      [auditKey, keyHash],
    );
    expect(evidence.rows[0]).toEqual({ audits: 1, keys: 1 });
  });

  it("serializes same-key retries and different-key snapshots on the configured binding", async () => {
    snapshot = activeSnapshot();
    retrieveCount = 0;
    const sameKey = await Promise.all([
      repository.reconcileStripeProviderAccount!(command("concurrent-same")),
      repository.reconcileStripeProviderAccount!(command("concurrent-same")),
    ]);
    expect(sameKey.map((result) => (result.ok ? result.status : "error")).sort()).toEqual([
      "idempotent_replay",
      "reconciled",
    ]);
    expect(retrieveCount).toBe(1);

    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    retrieveCount = 0;
    retrieveAccount = async (requestedRef) => {
      expect(requestedRef).toBe(providerAccountRef);
      if (retrieveCount === 1) {
        markFirstStarted();
        await firstRelease;
        return activeSnapshot();
      }
      return { ...activeSnapshot(), payoutsEnabled: false, cardPaymentsStatus: null };
    };

    const ready = repository.reconcileStripeProviderAccount!(command("ordered-ready"));
    await firstStarted;
    const lost = repository.reconcileStripeProviderAccount!(command("ordered-loss"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(retrieveCount).toBe(1);
    releaseFirst();

    await expect(ready).resolves.toMatchObject({
      ok: true,
      response: { providerAccount: { ready: true } },
    });
    await expect(lost).resolves.toMatchObject({
      ok: true,
      response: { providerAccount: { ready: false } },
    });
    expect(retrieveCount).toBe(2);
    await expect(providerAccount()).resolves.toMatchObject({
      status: "setup_incomplete",
      payoutsEnabled: false,
      cardPaymentsStatus: null,
    });
    retrieveAccount = async (requestedRef) => {
      expect(requestedRef).toBe(providerAccountRef);
      return snapshot;
    };
  });

  it("rolls provider, audit, projection, and idempotency state back together", async () => {
    snapshot = activeSnapshot();
    await installAuditFailure();
    try {
      await expect(
        repository.reconcileStripeProviderAccount!(command("rollback")),
      ).resolves.toEqual({
        ok: false,
        statusCode: 500,
        code: "write_unavailable",
        message: "Stripe account reconciliation could not be saved.",
      });
    } finally {
      await dropAuditFailure();
    }

    const account = await admin.query<{
      status: string;
      payoutsEnabled: boolean;
      detailsSubmitted: string | null;
    }>(
      `SELECT status, payouts_enabled AS "payoutsEnabled",
              account_metadata ->> 'detailsSubmitted' AS "detailsSubmitted"
       FROM finance.payment_provider_accounts WHERE id = $1::uuid`,
      [providerAccountId],
    );
    expect(account.rows[0]).toEqual({
      status: "setup_incomplete",
      payoutsEnabled: false,
      detailsSubmitted: "true",
    });
    expect((await projection()).onlinePayment).toBe("false");
    const rollbackKey = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform.idempotency_keys
       WHERE property_id = $1::uuid AND operation = 'stripe_provider_account_reconcile'
         AND idempotency_metadata ->> 'commandId' = 'command-rollback'`,
      [propertyId],
    );
    expect(rollbackKey.rows[0]?.count).toBe(0);
  });

  it("holds the configured-account binding lock through provider reconciliation", async () => {
    await admin.query(
      `INSERT INTO finance.payment_provider_accounts (
         id, property_id, account_scope, provider, provider_account_id,
         status, onboarding_status, charges_enabled, payouts_enabled, default_currency
       ) VALUES (
         $1::uuid, $2::uuid, 'property', 'stripe', $3,
         'setup_incomplete', 'invited', FALSE, FALSE, 'EUR'
       )`,
      [replacementProviderAccountId, propertyId, replacementProviderAccountRef],
    );
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    retrieveAccount = async (requestedRef) => {
      markProviderStarted();
      expect(requestedRef).toBe(providerAccountRef);
      await providerRelease;
      return activeSnapshot();
    };

    const reconciliation = repository.reconcileStripeProviderAccount!(command("binding-lock"));
    await Promise.race([
      providerStarted,
      reconciliation.then(() => {
        throw new Error("Reconciliation completed before provider retrieval started.");
      }),
    ]);
    const publicationClient = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    const rebindClient = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    let publicationConnected = false;
    let publicationTransactionOpen = false;
    let rebindConnected = false;
    let publicationLock: Promise<void> | undefined;
    let rebind: Promise<void> | undefined;
    let publicationLockFinished = false;
    let rebindFinished = false;
    try {
      await publicationClient.connect();
      publicationConnected = true;
      await publicationClient.query("BEGIN");
      publicationTransactionOpen = true;
      const runningPublicationLock = publicationClient
        .query(
          `SELECT id FROM hotel_catalog.properties
           WHERE id = $1::uuid FOR UPDATE`,
          [propertyId],
        )
        .then(() => {
          publicationLockFinished = true;
        });
      publicationLock = runningPublicationLock;
      await rebindClient.connect();
      rebindConnected = true;
      const runningRebind = rebindClient
        .query(
          `UPDATE finance.payment_settings SET provider_account_id = $1::uuid
           WHERE property_id = $2::uuid`,
          [replacementProviderAccountId, propertyId],
        )
        .then(() => {
          rebindFinished = true;
        });
      rebind = runningRebind;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(rebindFinished).toBe(false);
      expect(publicationLockFinished).toBe(false);
      releaseProvider();

      await expect(reconciliation).resolves.toMatchObject({
        ok: true,
        response: { providerAccount: { ready: true } },
      });
      await runningPublicationLock;
      await publicationClient.query("ROLLBACK");
      publicationTransactionOpen = false;
      await runningRebind;
      expect(rebindFinished).toBe(true);
      const binding = await admin.query<{ providerAccountId: string }>(
        `SELECT provider_account_id::text AS "providerAccountId"
         FROM finance.payment_settings WHERE property_id = $1::uuid`,
        [propertyId],
      );
      expect(binding.rows[0]?.providerAccountId).toBe(replacementProviderAccountId);
      await expect(providerAccount(replacementProviderAccountId)).resolves.toMatchObject({
        status: "setup_incomplete",
        chargesEnabled: false,
        payoutsEnabled: false,
      });
    } finally {
      releaseProvider();
      await Promise.allSettled([reconciliation]);
      if (publicationLock) await Promise.allSettled([publicationLock]);
      try {
        if (publicationConnected && publicationTransactionOpen) {
          await publicationClient.query("ROLLBACK");
        }
      } finally {
        if (rebind) await Promise.allSettled([rebind]);
        const closingClients: Promise<void>[] = [];
        if (publicationConnected) closingClients.push(publicationClient.end());
        if (rebindConnected) closingClients.push(rebindClient.end());
        await Promise.allSettled(closingClients);
      }
    }
  });

  it("serializes webhook retrieval before a manual readiness-loss reconciliation", async () => {
    await admin.query(
      `UPDATE finance.payment_settings SET provider_account_id = $1::uuid
       WHERE property_id = $2::uuid`,
      [providerAccountId, propertyId],
    );
    snapshot = { ...activeSnapshot(), payoutsEnabled: false, cardPaymentsStatus: null };
    retrieveCount = 0;
    retrieveAccount = async (requestedRef) => {
      expect(requestedRef).toBe(providerAccountRef);
      return snapshot;
    };

    let releaseWebhook!: () => void;
    let markWebhookStarted!: () => void;
    const webhookStarted = new Promise<void>((resolve) => {
      markWebhookStarted = resolve;
    });
    const webhookRelease = new Promise<void>((resolve) => {
      releaseWebhook = resolve;
    });
    const webhookClient = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    let webhookConnected = false;
    let webhookTransactionOpen = false;
    let webhook: Promise<void> | undefined;
    let manual: Promise<unknown> | undefined;
    try {
      await webhookClient.connect();
      webhookConnected = true;
      await webhookClient.query("BEGIN");
      webhookTransactionOpen = true;
      const runningWebhook = reconcileStripeProviderAccountWebhook(
        webhookClient,
        {
          provider: "stripe",
          receiptId: "receipt-account-race",
          receiptKey: "webhook:stripe:evt_account_race",
          receiptKeyHash: "hash",
          payloadHash: "payload-hash",
          rawPayload: { data: { object: { id: providerAccountRef } } },
          normalizedPreview: {
            domainEventKey: `finance.provider-account.updated:stripe:${providerAccountHash}:race:v1`,
            domainEventType: "finance.provider-account.updated",
            resourceProduct: "finance",
            resourceType: "provider_account",
            resourceId: providerAccountHash,
            jobKey: `finance.reconcile-provider-account:${providerAccountHash}:race:v1`,
            queueName: "finance.webhooks",
            jobType: "finance.reconcile-provider-account",
            payload: { rawEventId: "evt_account_race" },
          },
        },
        {
          async retrieveAccount({ providerAccountRef: requestedRef }) {
            markWebhookStarted();
            expect(requestedRef).toBe(providerAccountRef);
            await webhookRelease;
            return activeSnapshot();
          },
        },
      ).then(async () => {
        await webhookClient.query("COMMIT");
        webhookTransactionOpen = false;
      });
      webhook = runningWebhook;
      await Promise.race([
        webhookStarted,
        runningWebhook.then(() => {
          throw new Error("Webhook reconciliation completed before provider retrieval started.");
        }),
      ]);
      let manualFinished = false;
      manual = repository.reconcileStripeProviderAccount!(command("webhook-race-loss")).then(
        (result) => {
          manualFinished = true;
          return result;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(manualFinished).toBe(false);
      expect(retrieveCount).toBe(0);
      releaseWebhook();

      await runningWebhook;
      await expect(manual).resolves.toMatchObject({
        ok: true,
        response: { providerAccount: { ready: false } },
      });
      expect(retrieveCount).toBe(1);
      await expect(providerAccount()).resolves.toMatchObject({
        status: "setup_incomplete",
        payoutsEnabled: false,
        cardPaymentsStatus: null,
      });
    } finally {
      releaseWebhook();
      if (webhook) await Promise.allSettled([webhook]);
      try {
        if (webhookConnected && webhookTransactionOpen) {
          await webhookClient.query("ROLLBACK");
        }
      } finally {
        if (manual) await Promise.allSettled([manual]);
        if (webhookConnected) await webhookClient.end();
      }
    }
  });

  function command(suffix: string): ReconcileStripePropertyAccountCommand {
    return {
      commandType: "finance.provider_account.stripe.reconcile",
      commandId: `command-${suffix}`,
      idempotencyKey: `key-${suffix}`,
      propertyId,
      audit: {
        actor: { kind: "user", userId: actorUserId, organizationId },
        requestId: `request-${suffix}`,
        correlationId: `correlation-${suffix}`,
        requestedAt: "2026-08-28T10:00:00.000Z",
        reason: "VAY-1343 PostgreSQL reconciliation test",
      },
      payload: {},
    };
  }

  async function projection(): Promise<{ onlinePayment: string | null; projectedAt: Date }> {
    const result = await admin.query<{ onlinePayment: string | null; projectedAt: Date }>(
      `SELECT capabilities ->> 'onlinePayment' AS "onlinePayment", projected_at AS "projectedAt"
       FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return result.rows[0]!;
  }

  async function providerAccount(id = providerAccountId): Promise<{
    status: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: string | null;
    cardPaymentsStatus: string | null;
  }> {
    const result = await admin.query<{
      status: string;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      detailsSubmitted: string | null;
      cardPaymentsStatus: string | null;
    }>(
      `SELECT status,
              charges_enabled AS "chargesEnabled",
              payouts_enabled AS "payoutsEnabled",
              account_metadata ->> 'detailsSubmitted' AS "detailsSubmitted",
              account_metadata ->> 'cardPaymentsStatus' AS "cardPaymentsStatus"
       FROM finance.payment_provider_accounts WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0]!;
  }

  async function reconciliationCounts(): Promise<{
    audits: number;
    keys: number;
    readinessEvents: number;
    readinessOutbox: number;
  }> {
    const result = await admin.query<{
      audits: number;
      keys: number;
      readinessEvents: number;
      readinessOutbox: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM platform.product_audit_events
          WHERE property_id = $1::uuid
            AND action = 'finance.provider_account.stripe.reconciled') AS audits,
         (SELECT count(*)::int FROM platform.idempotency_keys
          WHERE property_id = $1::uuid
            AND operation = 'stripe_provider_account_reconcile') AS keys,
         (SELECT count(*)::int FROM platform.domain_events
          WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed') AS "readinessEvents",
         (SELECT count(*)::int FROM platform.outbox_events
          WHERE property_id = $1::uuid
            AND event_type = 'finance.online_card_readiness.changed') AS "readinessOutbox"`,
      [propertyId],
    );
    return result.rows[0]!;
  }

  async function installAuditFailure(): Promise<void> {
    await admin.query(
      `CREATE FUNCTION platform.${auditFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.property_id = '${propertyId}'::uuid
            AND NEW.action = 'finance.provider_account.stripe.reconciled' THEN
           RAISE EXCEPTION 'VAY-1343 forced audit failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await admin.query(
      `CREATE TRIGGER ${auditTrigger} BEFORE INSERT ON platform.product_audit_events
       FOR EACH ROW EXECUTE FUNCTION platform.${auditFunction}()`,
    );
  }

  async function dropAuditFailure(): Promise<void> {
    await admin.query(`DROP TRIGGER IF EXISTS ${auditTrigger} ON platform.product_audit_events`);
    await admin.query(`DROP FUNCTION IF EXISTS platform.${auditFunction}()`);
  }

  async function cleanup(): Promise<void> {
    await dropAuditFailure();
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("DELETE FROM platform.outbox_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.product_audit_events WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        "DELETE FROM distribution.public_hotel_bookability_profiles WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM finance.payment_settings WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        "DELETE FROM finance.online_card_execution_evidence WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM finance.payment_provider_accounts WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM booking.booking_settings WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query("DELETE FROM pms.property_pricing_settings WHERE property_id = $1::uuid", [
        propertyId,
      ]);
      await admin.query(
        "DELETE FROM hotel_catalog.property_public_profile_read_model WHERE property_id = $1::uuid",
        [propertyId],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [propertyId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [actorUserId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [organizationId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function activeSnapshot(): StripeConnectProviderAccountSnapshot {
  return {
    providerAccountRef,
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    cardPaymentsStatus: "active",
    defaultCurrency: "eur",
  };
}

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(test|verify)/i.test(new URL(connectionString).pathname)) {
    throw new Error("Refusing non-test database");
  }
}
