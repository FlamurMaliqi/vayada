import { createHash } from "node:crypto";

import {
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  type BookingGuestPolicyBundle,
  type BookingGuestPolicyHash,
  type BookingGuestPolicyScopeAuthorizationPort,
  type PersistBookingGuestPolicyCommand,
} from "@vayada/domain-booking";
import type { BookingPricingSourceFingerprint } from "@vayada/domain-booking";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBookingGuestPolicyCurrentOwnerEvidenceAdapter } from "./bookingGuestPolicyCurrentOwnerEvidence.js";
import {
  createPgBookingGuestPolicyRepository,
  type BookingGuestPolicyRepositoryPool,
} from "./bookingGuestPolicyRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "b1000000-0000-4000-8000-000000000001";
const organizationId = "b1000000-0000-4000-8000-000000000002";
const propertyId = "b1000000-0000-4000-8000-000000000003";
const roomTypeId = "b1000000-0000-4000-8000-000000000004";
const acceptedAt = "2026-08-04T20:00:00.000Z";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Booking guest-policy repository", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  let authorized = true;
  const scopeAuthorization: BookingGuestPolicyScopeAuthorizationPort = {
    async authorizeGuestPolicyScope(input) {
      expect(input).toMatchObject({
        organizationId,
        propertyId,
        actorUserId,
        permission: "booking.settings.manage",
        entitlement: { product: "booking", key: "booking-engine" },
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          allowedRelationships: ["owner", "operator"],
        },
      });
      expect(input.checkedAt).toBe(acceptedAt);
      return authorized;
    },
  };
  const repository = createPgBookingGuestPolicyRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 6,
    now: () => new Date(acceptedAt),
    scopeAuthorization,
  });
  const currentOwnerEvidence = createBookingGuestPolicyCurrentOwnerEvidenceAdapter({
    booking: repository,
    pms: {
      bookingGuestPolicyCurrentOwnerEvidencePort: "pms",
      async getCurrentGuestPolicyBaseRevisions(scope) {
        return {
          outcome: "available",
          evidence: {
            ...scope,
            revisions: {
              "pms.pricing_settings": "pricing-settings:2",
              "pms.rate_plans": "rate-plans:4",
              "pms.room_types": "room-types:6",
            },
          },
        };
      },
    },
    catalog: {
      bookingGuestPolicyCurrentOwnerEvidencePort: "hotel_catalog",
      async getCurrentGuestPolicyBaseRevisions(scope) {
        return {
          outcome: "available",
          evidence: {
            ...scope,
            revisions: {
              "hotel_catalog.location": "location:3",
              "hotel_catalog.policy": "policy:9",
            },
          },
        };
      },
    },
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    authorized = true;
    await cleanup();
    await seedPlatformScope();
  });

  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("atomically persists exact confirmation, secret-safe events, audit, outbox, and current evidence", async () => {
    await expect(
      currentOwnerEvidence.getCurrentGuestPolicyOwnerEvidence({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      outcome: "available",
      currentBaseRevisions: { "booking.guest_experience": "guest-policy:absent" },
    });
    const result = await repository.persistGuestPolicy(command("create", 0));
    expect(result).toMatchObject({
      ok: true,
      outcome: "created",
      revision: {
        contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
        organizationId,
        propertyId,
        revision: 1,
        confirmation: { confirmationRevision: 1, basis: "explicit" },
        projectionReceipt: null,
      },
    });
    await expect(repository.getCurrentGuestPolicy({ organizationId, propertyId })).resolves.toEqual(
      result.ok ? result.revision : null,
    );
    if (!result.ok) throw new Error("Expected created guest policy");
    await expect(
      currentOwnerEvidence.getCurrentGuestPolicyOwnerEvidence({ organizationId, propertyId }),
    ).resolves.toEqual({
      outcome: "available",
      organizationId,
      propertyId,
      currentBaseRevisions: {
        "booking.guest_experience": "guest-policy:1",
        "pms.pricing_settings": "pricing-settings:2",
        "pms.rate_plans": "rate-plans:4",
        "pms.room_types": "room-types:6",
        "hotel_catalog.location": "location:3",
        "hotel_catalog.policy": "policy:9",
      },
    });
    await expect(repository.persistGuestPolicy(command("create", 0))).resolves.toMatchObject({
      ok: true,
      outcome: "idempotent_replay",
      revision: { revision: 1 },
    });
    await expect(
      currentOwnerEvidence.getCurrentGuestPolicyOwnerEvidence({ organizationId, propertyId }),
    ).resolves.toMatchObject({
      outcome: "available",
      currentBaseRevisions: { "booking.guest_experience": "guest-policy:1" },
    });
    await expect(
      repository.getGuestPolicyPublicProjection({
        propertyId,
        revisionId: result.revision.revisionId,
        guestPolicyRevision: 1,
      }),
    ).resolves.toMatchObject({
      propertyId,
      guestPolicyRevision: 1,
      policy: {
        childrenEnabled: true,
        checkInTime: "15:00",
        checkOutTime: "11:00",
        pricingCurrency: "EUR",
        propertyTimeZone: "Europe/Berlin",
      },
    });

    const durable = await admin.query<{
      eventPayload: unknown;
      outboxPayload: unknown;
      outboxMetadata: unknown;
      auditPayload: unknown;
      destination: string;
      confirmationBasis: string;
    }>(
      `SELECT event.payload AS "eventPayload", outbox.payload AS "outboxPayload",
              outbox.outbox_metadata AS "outboxMetadata",
              audit.redacted_payload AS "auditPayload", outbox.destination,
              confirmation.confirmation_basis AS "confirmationBasis"
       FROM booking.guest_policy_revisions revision
       JOIN booking.booking_policy_confirmations confirmation
         ON confirmation.guest_policy_revision_id = revision.revision_id
       JOIN platform.domain_events event ON event.id = revision.domain_event_id
       JOIN platform.outbox_events outbox ON outbox.id = revision.outbox_event_id
       JOIN platform.product_audit_events audit ON audit.id = revision.audit_event_id
       WHERE revision.property_id = $1::uuid`,
      [propertyId],
    );
    expect(durable.rows[0]).toMatchObject({
      eventPayload: {
        contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
        eventType: "booking.guest_policy.changed",
        propertyId,
        guestPolicyRevision: 1,
        confirmationRevision: 1,
        outcome: "created",
      },
      outboxMetadata: {
        contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
        sourceReadRequired: true,
      },
      destination: "hotel-catalog.public-policy",
      confirmationBasis: "explicit",
    });
    expect(durable.rows[0]?.outboxPayload).toEqual(durable.rows[0]?.eventPayload);
    const durableText = JSON.stringify(durable.rows[0]);
    for (const privateValue of ["phoneRequired", "specialRequestsEnabled", "15.00"])
      expect(durableText).not.toContain(privateValue);
  });

  it("carries confirmation and an applied compatible receipt across optional-only changes", async () => {
    const created = await repository.persistGuestPolicy(command("optional-create", 0));
    if (!created.ok) throw new Error("Expected created guest policy");
    await repository.recordProjectionReceipt({
      organizationId,
      propertyId,
      revisionId: created.revision.revisionId,
      guestPolicyRevision: 1,
      sourceOutboxEventId: created.revision.outboxEventId,
      bundleHash: created.revision.bundle.bundleHash,
      sourceFingerprint: created.revision.bundle.sourceFingerprint,
      catalogProfileSourceRevision: created.revision.catalogProfileSourceRevision,
      result: { outcome: "applied", catalogPolicyProjectionRevision: 9 },
      recordedAt: acceptedAt,
    });

    const updated = await repository.persistGuestPolicy(
      command("optional-update", 1, { phoneRequired: false, confirmPolicyBundle: false }),
    );
    expect(updated).toMatchObject({
      ok: true,
      outcome: "updated",
      revision: {
        revision: 2,
        bundle: { choices: { phoneRequired: false } },
        confirmation: {
          confirmationRevision: 2,
          basis: "unchanged_policy_bundle",
          basedOnConfirmationId: created.revision.confirmation.confirmationId,
        },
        projectionReceipt: {
          outcome: "applied",
          projectedGuestPolicyRevision: 1,
          catalogPolicyProjectionRevision: 9,
        },
      },
    });
    if (!updated.ok) throw new Error("Expected optional update");
    expect(updated.revision.bundle.bundleHash).toBe(created.revision.bundle.bundleHash);
    expect(updated.revision.bundle.sourceFingerprint).toBe(
      created.revision.bundle.sourceFingerprint,
    );
  });

  it("never carries a future receipt into an earlier revision replay", async () => {
    const initialCommand = command("future-receipt-initial", 0);
    const created = await repository.persistGuestPolicy(initialCommand);
    if (!created.ok) throw new Error("Expected created guest policy");
    const updated = await repository.persistGuestPolicy(
      command("future-receipt-update", 1, {
        phoneRequired: false,
        confirmPolicyBundle: false,
      }),
    );
    if (!updated.ok) throw new Error("Expected updated guest policy");
    await repository.recordProjectionReceipt({
      organizationId,
      propertyId,
      revisionId: updated.revision.revisionId,
      guestPolicyRevision: 2,
      sourceOutboxEventId: updated.revision.outboxEventId,
      bundleHash: updated.revision.bundle.bundleHash,
      sourceFingerprint: updated.revision.bundle.sourceFingerprint,
      catalogProfileSourceRevision: updated.revision.catalogProfileSourceRevision,
      result: { outcome: "applied", catalogPolicyProjectionRevision: 10 },
      recordedAt: acceptedAt,
    });

    await expect(repository.persistGuestPolicy(initialCommand)).resolves.toMatchObject({
      ok: true,
      outcome: "idempotent_replay",
      revision: { revision: 1, projectionReceipt: null },
    });
  });

  it("fails closed for changed policy without confirmation and exactly replays the rejection", async () => {
    await repository.persistGuestPolicy(command("base", 0));
    const changed = command("confirmation-required", 1, {
      checkInTime: "16:00",
      confirmPolicyBundle: false,
    });
    const rejection = {
      ok: false as const,
      error: { code: "policy_confirmation_required" as const },
    };
    await expect(repository.persistGuestPolicy(changed)).resolves.toEqual(rejection);
    await expect(repository.persistGuestPolicy(changed)).resolves.toEqual(rejection);
    await expect(repository.findAuthorizedReplay(changed)).resolves.toEqual({
      outcome: "rejected",
      error: rejection.error,
    });
    await expect(counts()).resolves.toMatchObject({
      revisions: "1",
      confirmations: "1",
      audits: "2",
    });
  });

  it("checks changed-key conflicts before revision state and reauthorizes before every replay", async () => {
    const request = command("shared-key", 0);
    await repository.persistGuestPolicy(request);
    await expect(
      repository.persistGuestPolicy(command("shared-key", 99, { phoneRequired: false })),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(repository.findAuthorizedReplay(request)).resolves.toMatchObject({
      outcome: "replay",
      revision: { revision: 1 },
    });
    authorized = false;
    await expect(repository.findAuthorizedReplay(request)).resolves.toEqual({
      outcome: "rejected",
      error: { code: "setup_scope_unavailable" },
    });
    await expect(repository.persistGuestPolicy(request)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(counts()).resolves.toMatchObject({ revisions: "1", audits: "1" });
  });

  it("serializes concurrent same-key and different-key writers without duplicate emissions", async () => {
    const same = command("concurrent-same", 0);
    const sameResults = await Promise.all([
      repository.persistGuestPolicy(same),
      repository.persistGuestPolicy({
        ...same,
        audit: { ...same.audit, requestId: "concurrent-retry" },
      }),
    ]);
    expect(
      sameResults.map((result) => (result.ok ? result.outcome : result.error.code)).sort(),
    ).toEqual(["created", "idempotent_replay"]);

    const [first, second] = await Promise.all([
      repository.persistGuestPolicy(command("concurrent-a", 1, { phoneRequired: false })),
      repository.persistGuestPolicy(command("concurrent-b", 1, { phoneRequired: false })),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "guest_policy_revision_conflict", currentRevision: 2 } },
    ]);
    await expect(counts()).resolves.toMatchObject({
      revisions: "2",
      confirmations: "2",
      audits: "3",
      domainEvents: "2",
      outboxEvents: "2",
      idempotencyKeys: "3",
    });
  });

  it("rolls back idempotency, event, audit, revision, confirmation, and pointer on outbox failure", async () => {
    const rawPool = new pg.Pool({ connectionString: TEST_DATABASE_URL!, max: 1 });
    const failingPool: BookingGuestPolicyRepositoryPool = {
      async connect() {
        const client = await rawPool.connect();
        return {
          async query(text, values) {
            if (text.includes("INSERT INTO platform.outbox_events"))
              throw new Error("injected guest-policy outbox failure");
            return client.query(text, values as unknown[]);
          },
          release() {
            client.release();
          },
        };
      },
      async end() {
        await rawPool.end();
      },
    };
    const failing = createPgBookingGuestPolicyRepository({
      connectionString: TEST_DATABASE_URL!,
      pool: failingPool,
      now: () => new Date(acceptedAt),
      scopeAuthorization,
    });
    await expect(failing.persistGuestPolicy(command("outbox-failure", 0))).rejects.toThrow(
      "injected guest-policy outbox failure",
    );
    await expect(counts()).resolves.toEqual({
      revisions: "0",
      confirmations: "0",
      receipts: "0",
      audits: "0",
      domainEvents: "0",
      outboxEvents: "0",
      idempotencyKeys: "0",
    });
    await expect(
      repository.getCurrentGuestPolicy({ organizationId, propertyId }),
    ).resolves.toBeNull();
    await failing.close();
  });

  it("bounds a peer property lock as command_in_progress without durable work", async () => {
    const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL! });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT pg_advisory_xact_lock(hashtext('booking.guest_policy'), hashtext($1::uuid::text))`,
        [propertyId],
      );
      await expect(repository.persistGuestPolicy(command("locked", 0))).resolves.toEqual({
        ok: false,
        error: { code: "command_in_progress" },
      });
      await expect(counts()).resolves.toEqual({
        revisions: "0",
        confirmations: "0",
        receipts: "0",
        audits: "0",
        domainEvents: "0",
        outboxEvents: "0",
        idempotencyKeys: "0",
      });
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });

  it("idempotently records projection receipts and rejects a conflicting outbox replay", async () => {
    const created = await repository.persistGuestPolicy(command("projection", 0));
    if (!created.ok) throw new Error("Expected created guest policy");
    const receipt = {
      organizationId,
      propertyId,
      revisionId: created.revision.revisionId,
      guestPolicyRevision: 1,
      sourceOutboxEventId: created.revision.outboxEventId,
      bundleHash: created.revision.bundle.bundleHash,
      sourceFingerprint: created.revision.bundle.sourceFingerprint,
      catalogProfileSourceRevision: created.revision.catalogProfileSourceRevision,
      result: { outcome: "applied" as const, catalogPolicyProjectionRevision: 4 },
      recordedAt: acceptedAt,
    };
    await expect(repository.recordProjectionReceipt(receipt)).resolves.toMatchObject({
      outcome: "applied",
      projectedGuestPolicyRevision: 1,
      catalogPolicyProjectionRevision: 4,
    });
    await expect(repository.persistGuestPolicy(command("projection", 0))).resolves.toMatchObject({
      ok: true,
      outcome: "idempotent_replay",
      revision: {
        revision: 1,
        projectionReceipt: { outcome: "applied", catalogPolicyProjectionRevision: 4 },
      },
    });
    await expect(
      repository.recordProjectionReceipt({ ...receipt, recordedAt: "2026-08-04T20:01:00.000Z" }),
    ).resolves.toMatchObject({ outcome: "applied", recordedAt: acceptedAt });
    await expect(
      repository.recordProjectionReceipt({
        ...receipt,
        result: { outcome: "applied", catalogPolicyProjectionRevision: 5 },
      }),
    ).rejects.toThrow("conflicts with stored result");
    for (const identityChange of [
      { organizationId: "b1000000-0000-4000-8000-000000000012" },
      { propertyId: "b1000000-0000-4000-8000-000000000013" },
      { revisionId: "b1000000-0000-4000-8000-000000000014" },
    ]) {
      await expect(
        repository.recordProjectionReceipt({ ...receipt, ...identityChange }),
      ).rejects.toThrow("conflicts with stored result");
    }
    await expect(counts()).resolves.toMatchObject({ receipts: "1" });
  });

  async function counts() {
    const result = await admin.query<{
      revisions: string;
      confirmations: string;
      receipts: string;
      audits: string;
      domainEvents: string;
      outboxEvents: string;
      idempotencyKeys: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM booking.guest_policy_revisions
          WHERE property_id = $1::uuid) AS revisions,
         (SELECT count(*)::text FROM booking.booking_policy_confirmations
          WHERE property_id = $1::uuid) AS confirmations,
         (SELECT count(*)::text FROM booking.guest_policy_projection_receipts
          WHERE property_id = $1::uuid) AS receipts,
         (SELECT count(*)::text FROM platform.product_audit_events
          WHERE property_id = $1::uuid AND action LIKE 'booking.guest_policy.%') AS audits,
         (SELECT count(*)::text FROM platform.domain_events
          WHERE property_id = $1::uuid AND event_type = 'booking.guest_policy.changed') AS "domainEvents",
         (SELECT count(*)::text FROM platform.outbox_events
          WHERE property_id = $1::uuid AND event_type = 'booking.guest_policy.changed') AS "outboxEvents",
         (SELECT count(*)::text FROM platform.idempotency_keys
          WHERE property_id = $1::uuid AND operation = 'booking.guest_policy.upsert') AS "idempotencyKeys"`,
      [propertyId],
    );
    return result.rows[0]!;
  }

  async function cleanup(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        "DELETE FROM booking.current_working_guest_policy_revisions WHERE property_id = $1",
        [propertyId],
      );
      await admin.query(
        "DELETE FROM booking.guest_policy_projection_receipts WHERE property_id = $1",
        [propertyId],
      );
      await admin.query("DELETE FROM booking.booking_policy_confirmations WHERE property_id = $1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM booking.guest_policy_revisions WHERE property_id = $1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.product_audit_events WHERE property_id = $1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM platform.outbox_events WHERE property_id = $1", [propertyId]);
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = $1", [propertyId]);
      await admin.query("DELETE FROM platform.idempotency_keys WHERE property_id = $1", [
        propertyId,
      ]);
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1", [propertyId]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1", [organizationId]);
      await admin.query("DELETE FROM identity.users WHERE id = $1", [actorUserId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function seedPlatformScope(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'guest-policy@example.test', 'Guest Policy Owner', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Guest Policy Hotel', 'guest-policy-hotel', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'guest-policy-hotel', 'Guest Policy Hotel')`,
      [propertyId],
    );
  }
});

function command(
  idempotencyKey: string,
  expectedRevision: number,
  overrides: Partial<{
    phoneRequired: boolean;
    checkInTime: string;
    confirmPolicyBundle: boolean;
  }> = {},
): PersistBookingGuestPolicyCommand {
  const policy = bundle({
    phoneRequired: overrides.phoneRequired ?? true,
    checkInTime: overrides.checkInTime ?? "15:00",
  });
  return {
    organizationId,
    propertyId,
    idempotencyKey,
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: `request-${idempotencyKey}`,
      correlationId: null,
      requestedAt: acceptedAt,
    },
    expectedRevision,
    expectedSourceFingerprint: policy.sourceFingerprint,
    choices: policy.choices,
    bundle: policy,
    confirmPolicyBundle: overrides.confirmPolicyBundle ?? true,
  };
}

function bundle(input: { phoneRequired: boolean; checkInTime: string }): BookingGuestPolicyBundle {
  const flexibleSource = source(
    "pms_flexible_rate_plan.v1",
    "b1000000-0000-4000-8000-000000000005",
    "4",
  );
  const nonRefundableSource = source(
    "pms_recurring_pricing_rule.v1",
    "b1000000-0000-4000-8000-000000000006",
    "5",
  );
  const additionalGuestSource = source(
    "pms_recurring_pricing_rule.v1",
    "b1000000-0000-4000-8000-000000000007",
    "6",
  );
  const sourceBindings = [
    {
      ownerDomain: "hotel_catalog" as const,
      entityType: "property_profile",
      entityId: propertyId,
      revision: "profile:7",
    },
    source("pms_property_pricing_currency.v1", propertyId, "2"),
    source("pms_optional_pricing_aggregate.v1", propertyId, "3"),
    source("pms_room_facts.v1", roomTypeId, "3"),
    flexibleSource,
    nonRefundableSource,
    additionalGuestSource,
    source("pms_mandatory_charge_confirmation.v1", propertyId, "4"),
  ].sort(compareSources);
  const choices = {
    defaultGuestLanguage: "en" as const,
    childrenEnabled: true,
    adultAgeThreshold: 18,
    phoneRequired: input.phoneRequired,
    arrivalTimeEnabled: false,
    specialRequestsEnabled: true,
    checkInTime: input.checkInTime,
    checkOutTime: "11:00",
  };
  const rates = [
    {
      roomTypeId,
      roomFactsRevision: 3,
      flexible: {
        source: flexibleSource,
        freeCancellationDeadlineDays: 2,
        cutoff: { localTime: "18:00", timeZone: "Europe/Berlin" },
        afterDeadlinePenalty: "full_booking_amount" as const,
        noShowPenalty: "full_booking_amount" as const,
      },
      nonRefundable: {
        source: { source: nonRefundableSource, validationRevision: 2, materializationRevision: 2 },
        refundPolicy: "no_refund" as const,
        noShowPenalty: "full_booking_amount" as const,
        paymentTiming: "prepay_full" as const,
      },
      additionalGuest: {
        source: {
          source: additionalGuestSource,
          validationRevision: 3,
          materializationRevision: 3,
        },
        includedGuestsPerRoom: 2,
        amountDecimal: "15.00",
        currency: "EUR",
        countedGuestTypes: ["adult", "child"] as const,
      },
    },
  ];
  const pricingSourceFingerprint = "3".repeat(64) as BookingPricingSourceFingerprint;
  const sourceFingerprint = hash([
    BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    pricingSourceFingerprint,
    4,
    sourceBindings,
    rates.map(({ roomTypeId: id, roomFactsRevision, flexible, nonRefundable, additionalGuest }) => [
      id,
      roomFactsRevision,
      flexible.source,
      nonRefundable.source,
      additionalGuest.source,
    ]),
  ]);
  const bundleHash = hash([
    BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    sourceFingerprint,
    {
      childrenEnabled: choices.childrenEnabled,
      adultAgeThreshold: choices.adultAgeThreshold,
      checkInTime: choices.checkInTime,
      checkOutTime: choices.checkOutTime,
    },
    "EUR",
    "Europe/Berlin",
    rates,
  ]);
  return {
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    organizationId,
    propertyId,
    choices,
    pricingCurrency: "EUR",
    propertyTimeZone: "Europe/Berlin",
    pricingSourceFingerprint,
    mandatoryChargeConfirmationRevision: 4,
    sourceBindings,
    sourceFingerprint,
    rates,
    bundleHash,
  } as BookingGuestPolicyBundle;
}

function source(entityType: string, entityId: string, revision: string) {
  return { ownerDomain: "pms" as const, entityType, entityId, revision };
}

function compareSources(
  left: ReturnType<typeof source> | Record<string, unknown>,
  right: ReturnType<typeof source> | Record<string, unknown>,
) {
  const leftTuple = JSON.stringify(Object.values(left));
  const rightTuple = JSON.stringify(Object.values(right));
  return leftTuple < rightTuple ? -1 : leftTuple > rightTuple ? 1 : 0;
}

function hash(value: unknown): BookingGuestPolicyHash {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    throw new Error("Booking guest-policy integration tests require a local PostgreSQL database");
  if (!/(?:test|vayada)/i.test(url.pathname))
    throw new Error("Booking guest-policy integration database name must identify a test database");
}
