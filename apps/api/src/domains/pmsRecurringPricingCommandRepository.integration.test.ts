import {
  parseDisableRecurringPricingSourceCommand,
  parseMaterializeRecurringPricingCommand,
  parsePmsPricingCurrency,
  parseUpsertAdditionalGuestPricingCommand,
  parseUpsertNonRefundablePricingCommand,
  parseUpsertPropertyPricingCurrencyCommand,
  parseUpsertRecurringSeasonCommand,
  parseUpsertWeekendSurchargeCommand,
  serializePmsPricingCurrencyDependencyLockKey,
} from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsPricingCommandRepository } from "./pmsPricingCommandRepository.js";
import { createPgPmsRecurringPricingCommandRepository } from "./pmsRecurringPricingCommandRepository.js";
import { createPgPmsRecurringPricingReadModel } from "./pmsRecurringPricingReadModel.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const actorUserId = "73000000-0000-4000-8000-000000000001";
const organizationId = "73000000-0000-4000-8000-000000000002";
const propertyId = "73000000-0000-4000-8000-000000000003";
const roomTypeId = "73000000-0000-4000-8000-000000000004";
const planId = "73000000-0000-4000-8000-000000000005";
const secondRoomTypeId = "73000000-0000-4000-8000-000000000009";
const secondPlanId = "73000000-0000-4000-8000-00000000000a";
const seasonSourceId = "73000000-0000-4000-8000-000000000006";
const secondSeasonSourceId = "73000000-0000-4000-8000-000000000007";
const additionalSourceId = "73000000-0000-4000-8000-000000000008";
const weekendSourceId = "73000000-0000-4000-8000-00000000000b";
const nonRefundableSourceId = "73000000-0000-4000-8000-00000000000c";
const acceptedAt = "2026-08-03T15:30:00.000Z";
const roleKey = "vay1072_recurring_pricing_integration";
const auditFailureFunction = "platform.vay1072_fail_recurring_pricing_audit";
const auditFailureTrigger = "trg_vay1072_fail_recurring_pricing_audit";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL PMS recurring pricing repositories", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  const repository = createPgPmsRecurringPricingCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 8,
    now: () => new Date(acceptedAt),
  });
  const read = createPgPmsRecurringPricingReadModel({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date(acceptedAt),
  });
  const pricing = createPgPmsPricingCommandRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date(acceptedAt),
    currencyChangeGuard: {
      async runWithCurrencyChangeGuard(_input, guarded) {
        return guarded([]);
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
    await seedPricingFoundation();
  });

  afterAll(async () => {
    await repository.close();
    await read.close();
    await pricing.close();
    await cleanup();
    await admin.end();
  });

  it("replays exact source creation and preserves identity through disable/re-enable", async () => {
    const create = seasonCommand("season-create", seasonSourceId, 0, 1, "Summer", "06-01", "08-31");
    const created = await repository.upsertRecurringSeason(create);
    expect(created).toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        optionalPricingAggregateRevision: 1,
        source: {
          sourceId: seasonSourceId,
          sourceRevision: 1,
          lifecycle: "active",
          roomPrices: [{ amountDecimal: "9999999999999.99" }],
        },
      },
    });
    await expect(repository.upsertRecurringSeason(create)).resolves.toEqual(created);
    await expect(read.getRecurringPricingBookingEvidence(propertyId)).resolves.toMatchObject({
      pricingCurrencyRevision: 1,
      optionalPricingAggregateRevision: 1,
      sources: [{ sourceId: seasonSourceId, sourceRevision: 1 }],
    });

    const disable = parseDisableRecurringPricingSourceCommand({
      ...context("season-disable"),
      sourceId: seasonSourceId,
      sourceKind: "season",
      expectedSourceRevision: 1,
    });
    if (!disable) throw new Error("invalid disable fixture");
    await expect(repository.disableRecurringPricingSource(disable)).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "disabled",
        optionalPricingAggregateRevision: 2,
        source: { sourceId: seasonSourceId, sourceRevision: 2, lifecycle: "disabled" },
      },
    });
    await expect(
      repository.upsertRecurringSeason(
        seasonCommand("season-re-enable", seasonSourceId, 2, 1, "Summer", "06-01", "08-31"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "re_enabled",
        optionalPricingAggregateRevision: 3,
        source: { sourceId: seasonSourceId, sourceRevision: 3, lifecycle: "active" },
      },
    });
    await expect(
      count("platform.product_audit_events", "action LIKE 'pms.recurring_pricing.%'"),
    ).resolves.toBe(3);
    await expect(
      count("platform.domain_events", "event_type = 'pms.recurring_pricing_source.changed'"),
    ).resolves.toBe(3);
    await expect(
      count("platform.outbox_events", "event_type = 'pms.recurring_pricing_source.changed'"),
    ).resolves.toBe(3);
  });

  it("fails safely on overlap, stale facts, and inapplicable additional-guest capacity", async () => {
    await repository.upsertRecurringSeason(
      seasonCommand("season-first", seasonSourceId, 0, 1, "Summer", "06-01", "08-31"),
    );
    await expect(
      repository.upsertRecurringSeason(
        seasonCommand(
          "season-overlap",
          secondSeasonSourceId,
          0,
          1,
          "High Summer",
          "08-01",
          "09-15",
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "season_overlap", conflictingSourceIds: [seasonSourceId] },
    });
    await expect(
      repository.upsertRecurringSeason(
        seasonCommand("season-stale", secondSeasonSourceId, 0, 99, "Winter", "11-01", "02-28"),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "room_facts_revision_conflict", roomTypeId, currentRevision: 1 },
    });
    const additional = parseUpsertAdditionalGuestPricingCommand({
      ...context("additional-capacity"),
      sourceId: additionalSourceId,
      expectedSourceRevision: 0,
      expectedPricingCurrencyRevision: 1,
      sourceKind: "additional_guest",
      roomTypeId,
      expectedRoomFactsRevision: 1,
      flexibleRatePlanId: planId,
      expectedFlexibleRatePlanRevision: 1,
      includedGuests: 2,
      amountDecimal: "0.00",
    });
    if (!additional) throw new Error("invalid additional guest fixture");
    await expect(repository.upsertAdditionalGuestPricing(additional)).resolves.toEqual({
      ok: false,
      error: {
        code: "additional_guest_capacity_inapplicable",
        roomTypeId,
        maximumAdultGuests: 2,
      },
    });
  });

  it("atomically creates and reads all four optional source kinds", async () => {
    await expect(
      repository.upsertRecurringSeason(
        seasonCommand("all-kinds-season", seasonSourceId, 0, 1, "Winter", "01-01", "02-28"),
      ),
    ).resolves.toMatchObject({ ok: true, response: { optionalPricingAggregateRevision: 1 } });
    await expect(repository.upsertWeekendSurcharge(weekendCommand())).resolves.toMatchObject({
      ok: true,
      response: {
        optionalPricingAggregateRevision: 2,
        source: { sourceKind: "weekend_surcharge", roomSurcharges: [{ amountDecimal: "15.00" }] },
      },
    });
    await expect(
      repository.upsertAdditionalGuestPricing(additionalGuestCommand()),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        optionalPricingAggregateRevision: 3,
        source: { sourceKind: "additional_guest", amountDecimal: "25.00" },
      },
    });
    const nonRefundable = await repository.upsertNonRefundablePricing(nonRefundableCommand());
    expect(nonRefundable).toMatchObject({
      ok: true,
      response: {
        optionalPricingAggregateRevision: 4,
        source: {
          sourceKind: "non_refundable",
          discountPercent: 12,
          roomPlans: [{ roomTypeId, flexibleRatePlanId: planId }],
          paymentTiming: "prepay_full",
          cancellationTerms: { refundPolicy: "no_refund" },
        },
      },
    });
    await expect(repository.upsertNonRefundablePricing(nonRefundableCommand())).resolves.toEqual(
      nonRefundable,
    );
    await expect(read.getRecurringPricingBookingEvidence(propertyId)).resolves.toMatchObject({
      optionalPricingAggregateRevision: 4,
      sources: [
        { sourceKind: "season", sourceId: seasonSourceId },
        { sourceKind: "weekend_surcharge", sourceId: weekendSourceId },
        { sourceKind: "additional_guest", sourceId: additionalSourceId },
        {
          sourceKind: "non_refundable",
          sourceId: nonRefundableSourceId,
          roomPlans: [{ roomTypeId }],
        },
      ],
    });
    await expect(
      count("platform.product_audit_events", "action LIKE 'pms.recurring_pricing.%'"),
    ).resolves.toBe(4);
  });

  it("scopes outbox deduplication to the operation when raw idempotency keys are reused", async () => {
    const sharedIdempotencyKey = "shared-cross-operation-key";
    await expect(
      repository.upsertRecurringSeason(
        seasonCommand(sharedIdempotencyKey, seasonSourceId, 0, 1, "Winter", "01-01", "02-28"),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      repository.upsertWeekendSurcharge(weekendCommand(sharedIdempotencyKey)),
    ).resolves.toMatchObject({ ok: true });

    const outboxes = await admin.query<{ outboxKey: string }>(
      `SELECT outbox_key AS "outboxKey"
       FROM platform.outbox_events
       WHERE property_id = $1::uuid
         AND event_type = 'pms.recurring_pricing_source.changed'
       ORDER BY outbox_key`,
      [propertyId],
    );
    expect(outboxes.rows.map(({ outboxKey }) => outboxKey)).toEqual([
      expect.stringContaining(".operation.pms.recurring_pricing.season.upsert."),
      expect.stringContaining(".operation.pms.recurring_pricing.weekend_surcharge.upsert."),
    ]);
    expect(new Set(outboxes.rows.map(({ outboxKey }) => outboxKey)).size).toBe(2);
  });

  it("keeps drifted sources visible and replaces bounded derived rows without source revision changes", async () => {
    await repository.upsertRecurringSeason(
      seasonCommand("season-create", seasonSourceId, 0, 1, "Winter", "01-01", "01-31"),
    );
    await expect(
      repository.materializeRecurringPricing(materializeCommand("materialize-stale-aggregate", 0)),
    ).resolves.toEqual({
      ok: false,
      error: { code: "optional_pricing_aggregate_revision_conflict", currentRevision: 1 },
    });
    const first = materializeCommand("materialize-valid", 1);
    await expect(repository.materializeRecurringPricing(first)).resolves.toMatchObject({
      ok: true,
      receipt: {
        sources: [
          {
            sourceId: seasonSourceId,
            sourceRevision: 1,
            lifecycle: "active",
            materializationRevision: 1,
            result: "materialized",
            materializedRowCount: 31,
          },
        ],
      },
    });
    await expect(materializedCount()).resolves.toBe(31);

    await seedSecondRoomPricingFoundation();
    await expect(repository.upsertWeekendSurcharge(weekendCommand())).resolves.toEqual({
      ok: false,
      error: {
        code: "recurring_pricing_room_plan_set_incomplete",
        sourceKind: "weekend_surcharge",
        missingRoomTypeIds: [secondRoomTypeId],
      },
    });
    await expect(
      repository.materializeRecurringPricing(
        materializeCommand("materialize-invalid", 1, "2026-01-10", "2026-01-15"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      receipt: {
        sources: [
          {
            sourceId: seasonSourceId,
            sourceRevision: 1,
            lifecycle: "invalid",
            materializationRevision: 2,
            result: "skipped_invalid",
            materializedRowCount: 0,
          },
        ],
      },
    });
    await expect(materializedCount()).resolves.toBe(0);
    await expect(read.getRecurringPricingSource(propertyId, seasonSourceId)).resolves.toMatchObject(
      {
        sourceRevision: 1,
        lifecycle: "invalid",
        materializationRevision: 2,
        validation: {
          state: "invalid",
          reasons: [{ code: "recurring_pricing_room_plan_missing", roomTypeId: secondRoomTypeId }],
        },
      },
    );
    const payload = await admin.query<{ payload: unknown }>(
      `SELECT payload FROM platform.domain_events
       WHERE property_id = $1::uuid AND event_type = 'pms.recurring_pricing.materialized'
       ORDER BY occurred_at DESC LIMIT 1`,
      [propertyId],
    );
    const text = JSON.stringify(payload.rows[0]?.payload);
    expect(text).not.toContain("9999999999999.99");
    expect(text).not.toContain("cancellationTerms");
  });

  it("clears only replaceable rows before edit, disable, and re-enable while retaining receipts", async () => {
    await repository.upsertRecurringSeason(
      seasonCommand("projection-create", seasonSourceId, 0, 1, "Winter", "01-01", "01-31"),
    );
    const firstMaterialization = await repository.materializeRecurringPricing(
      materializeCommand("projection-first", 1),
    );
    expect(firstMaterialization).toMatchObject({
      ok: true,
      receipt: {
        optionalPricingAggregateRevision: 1,
        sources: [
          {
            sourceId: seasonSourceId,
            sourceRevision: 1,
            materializationRevision: 1,
            materializedRowCount: 31,
          },
        ],
      },
    });
    if (!firstMaterialization.ok) throw new Error("first projection materialization failed");
    await expect(materializedCount()).resolves.toBe(31);
    await expect(sourceReceiptOrphanCount()).resolves.toBe(0);
    await expect(materializedRowOrphanCount()).resolves.toBe(0);

    await expect(
      repository.upsertRecurringSeason(
        seasonCommand("projection-edit", seasonSourceId, 1, 1, "Winter updated", "01-01", "01-31"),
      ),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        optionalPricingAggregateRevision: 2,
        source: { sourceRevision: 2, materializationRevision: 1 },
      },
    });
    await expect(materializedCount()).resolves.toBe(0);
    const secondMaterialization = await repository.materializeRecurringPricing(
      materializeCommand("projection-second", 2),
    );
    expect(secondMaterialization).toMatchObject({
      ok: true,
      receipt: {
        sources: [
          {
            sourceRevision: 2,
            materializationRevision: 2,
            materializedRowCount: 31,
          },
        ],
      },
    });
    if (!secondMaterialization.ok) throw new Error("second projection materialization failed");
    await expect(materializedCount()).resolves.toBe(31);
    await expect(sourceReceiptOrphanCount()).resolves.toBe(0);
    await expect(materializedRowOrphanCount()).resolves.toBe(0);

    const disable = parseDisableRecurringPricingSourceCommand({
      ...context("projection-disable"),
      sourceId: seasonSourceId,
      sourceKind: "season",
      expectedSourceRevision: 2,
    });
    if (!disable) throw new Error("invalid projection disable fixture");
    await expect(repository.disableRecurringPricingSource(disable)).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "disabled",
        optionalPricingAggregateRevision: 3,
        source: { sourceRevision: 3, materializationRevision: 2, lifecycle: "disabled" },
      },
    });
    await expect(materializedCount()).resolves.toBe(0);
    await expect(
      repository.upsertRecurringSeason(
        seasonCommand(
          "projection-re-enable",
          seasonSourceId,
          3,
          1,
          "Winter updated",
          "01-01",
          "01-31",
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        outcome: "re_enabled",
        optionalPricingAggregateRevision: 4,
        source: { sourceRevision: 4, materializationRevision: 2, lifecycle: "active" },
      },
    });
    await expect(materializedCount()).resolves.toBe(0);
    await expect(
      count("pms.recurring_pricing_materialization_source_receipts", "source_id = $2::uuid", [
        seasonSourceId,
      ]),
    ).resolves.toBe(2);
    const histories = await admin.query<{
      receiptId: string;
      optionalPricingAggregateRevision: string;
      sourceKind: string;
      sourceRevision: string;
      sourceLifecycle: string;
      materializationRevision: string;
      currency: string;
      pricingCurrencyRevision: string;
      materializedRowCount: number;
      materializedRowsSha256: string;
    }>(
      `SELECT receipt_id::text AS "receiptId",
              optional_pricing_aggregate_revision::text AS "optionalPricingAggregateRevision",
              source_kind AS "sourceKind", source_revision::text AS "sourceRevision",
              source_lifecycle AS "sourceLifecycle",
              materialization_revision::text AS "materializationRevision",
              currency::text AS currency,
              source_pricing_currency_revision::text AS "pricingCurrencyRevision",
              materialized_row_count AS "materializedRowCount",
              materialized_rows_sha256 AS "materializedRowsSha256"
       FROM pms.recurring_pricing_materialization_source_receipts
       WHERE property_id = $1::uuid AND source_id = $2::uuid
       ORDER BY materialization_revision`,
      [propertyId, seasonSourceId],
    );
    expect(histories.rows).toMatchObject([
      {
        receiptId: firstMaterialization.receipt.receiptId,
        optionalPricingAggregateRevision: "1",
        sourceKind: "season",
        sourceRevision: "1",
        sourceLifecycle: "active",
        materializationRevision: "1",
        currency: "EUR",
        pricingCurrencyRevision: "1",
        materializedRowCount: 31,
      },
      {
        receiptId: secondMaterialization.receipt.receiptId,
        optionalPricingAggregateRevision: "2",
        sourceKind: "season",
        sourceRevision: "2",
        sourceLifecycle: "active",
        materializationRevision: "2",
        currency: "EUR",
        pricingCurrencyRevision: "1",
        materializedRowCount: 31,
      },
    ]);
    for (const { materializedRowsSha256 } of histories.rows) {
      expect(materializedRowsSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    await expect(sourceReceiptOrphanCount()).resolves.toBe(0);
    await expect(materializedRowOrphanCount()).resolves.toBe(0);
    await expect(
      admin.query(
        `UPDATE pms.recurring_pricing_materialization_source_receipts
         SET materialized_row_count = materialized_row_count
         WHERE receipt_id = $1::uuid AND source_id = $2::uuid`,
        [firstMaterialization.receipt.receiptId, seasonSourceId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_recurring_pricing_materialization_receipt_immutable",
    });
    await expect(
      admin.query(
        `DELETE FROM pms.recurring_pricing_materialization_source_receipts
         WHERE receipt_id = $1::uuid AND source_id = $2::uuid`,
        [firstMaterialization.receipt.receiptId, seasonSourceId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_recurring_pricing_materialization_receipt_immutable",
    });
    await expect(
      count("pms.recurring_pricing_materialization_source_receipts", "source_id = $2::uuid", [
        seasonSourceId,
      ]),
    ).resolves.toBe(2);
  });

  it("rechecks scope before exact replay and fails closed for a foreign property/source pair", async () => {
    const command = seasonCommand("scope-replay", seasonSourceId, 0, 1, "Summer", "06-01", "08-31");
    await expect(repository.upsertRecurringSeason(command)).resolves.toMatchObject({ ok: true });
    await admin.query(
      `UPDATE identity.organization_resource_links SET status = 'suspended'
       WHERE organization_id = $1::uuid AND resource_id = $2::uuid::text`,
      [organizationId, propertyId],
    );
    await expect(repository.upsertRecurringSeason(command)).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    await expect(
      count("platform.domain_events", "event_type = 'pms.recurring_pricing_source.changed'"),
    ).resolves.toBe(1);
  });

  it("rolls back source, aggregate, audit, event, outbox, and idempotency on audit failure", async () => {
    await installAuditFailureTrigger();
    try {
      await expect(
        repository.upsertRecurringSeason(
          seasonCommand("audit-failure", seasonSourceId, 0, 1, "Summer", "06-01", "08-31"),
        ),
      ).rejects.toThrow("injected VAY-1072 audit failure");
      await expect(read.getRecurringPricingSource(propertyId, seasonSourceId)).resolves.toBeNull();
      await expect(readAggregateRevision()).resolves.toBe(0);
      await expect(
        count("platform.idempotency_keys", "operation LIKE 'pms.recurring_pricing.%'"),
      ).resolves.toBe(0);
      await expect(
        count("platform.domain_events", "event_type = 'pms.recurring_pricing_source.changed'"),
      ).resolves.toBe(0);
      await expect(
        count("platform.outbox_events", "event_type = 'pms.recurring_pricing_source.changed'"),
      ).resolves.toBe(0);
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  it("serializes a source write against a VAY-1069 currency change on the shared lock", async () => {
    const currencyCommand = parseUpsertPropertyPricingCurrencyCommand({
      ...context("currency-race-change"),
      expectedPricingCurrencyRevision: 1,
      currency: parsePmsPricingCurrency("USD"),
    });
    if (!currencyCommand) throw new Error("invalid currency race fixture");

    await admin.query("BEGIN");
    const lockKey = serializePmsPricingCurrencyDependencyLockKey(propertyId);
    if (!lockKey) throw new Error("invalid pricing dependency lock fixture");
    await admin.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey]);
    const sourcePromise = repository.upsertRecurringSeason(
      seasonCommand("currency-race-source", seasonSourceId, 0, 1, "Summer", "06-01", "08-31"),
    );
    const currencyPromise = pricing.upsertPropertyPricingCurrency(currencyCommand);
    try {
      await waitForAdvisoryWaiters(2);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      await Promise.allSettled([sourcePromise, currencyPromise]);
      throw error;
    }
    const [sourceResult, currencyResult] = await Promise.all([sourcePromise, currencyPromise]);
    const acceptedSource = sourceResult.ok;
    const blockedCurrency =
      !currencyResult.ok &&
      currencyResult.error.code === "pricing_currency_change_blocked" &&
      currencyResult.error.blockers.some(({ code }) => code === "rate_rule");
    const changedCurrency = currencyResult.ok;
    const staleSource =
      !sourceResult.ok && sourceResult.error.code === "pricing_currency_revision_conflict";
    expect((acceptedSource && blockedCurrency) || (changedCurrency && staleSource)).toBe(true);
  });

  it("does not accept a complete-set source across a concurrent active-room creation", async () => {
    await admin.query("BEGIN");
    await lockPmsRoomFactsMutationScope(admin, propertyId);
    const sourcePromise = repository.upsertRecurringSeason(
      seasonCommand("room-create-race-source", seasonSourceId, 0, 1, "Summer", "06-01", "08-31"),
    );
    try {
      await waitForAdvisoryWaiters(1);
      await seedSecondActiveRoom();
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      await Promise.allSettled([sourcePromise]);
      throw error;
    }

    await expect(sourcePromise).resolves.toEqual({
      ok: false,
      error: {
        code: "recurring_pricing_room_plan_set_incomplete",
        sourceKind: "season",
        missingRoomTypeIds: [secondRoomTypeId],
      },
    });
  });

  it("invalidates materialization when an active room is created concurrently", async () => {
    await repository.upsertRecurringSeason(
      seasonCommand("room-create-race-seed", seasonSourceId, 0, 1, "Summer", "06-01", "08-31"),
    );
    await admin.query("BEGIN");
    await lockPmsRoomFactsMutationScope(admin, propertyId);
    const materializationPromise = repository.materializeRecurringPricing(
      materializeCommand("room-create-race-materialize", 1),
    );
    try {
      await waitForAdvisoryWaiters(1);
      await seedSecondActiveRoom();
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      await Promise.allSettled([materializationPromise]);
      throw error;
    }

    await expect(materializationPromise).resolves.toMatchObject({
      ok: true,
      receipt: {
        sources: [
          {
            sourceId: seasonSourceId,
            lifecycle: "invalid",
            result: "skipped_invalid",
            materializedRowCount: 0,
          },
        ],
      },
    });
    await expect(materializedCount()).resolves.toBe(0);
  });

  function context(idempotencyKey: string) {
    return {
      organizationId,
      propertyId,
      idempotencyKey,
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: `request-${idempotencyKey}`,
        correlationId: `correlation-${idempotencyKey}`,
        requestedAt: acceptedAt,
      },
    };
  }

  function seasonCommand(
    idempotencyKey: string,
    requestedSourceId: string,
    expectedSourceRevision: number,
    expectedRoomFactsRevision: number,
    name: string,
    startMonthDay: string,
    endMonthDay: string,
  ) {
    const command = parseUpsertRecurringSeasonCommand({
      ...context(idempotencyKey),
      sourceId: requestedSourceId,
      expectedSourceRevision,
      expectedPricingCurrencyRevision: 1,
      sourceKind: "season",
      name,
      startMonthDay,
      endMonthDay,
      roomPrices: [
        {
          roomTypeId,
          expectedRoomFactsRevision,
          flexibleRatePlanId: planId,
          expectedFlexibleRatePlanRevision: 1,
          amountDecimal: "9999999999999.99",
        },
      ],
    });
    if (!command) throw new Error("invalid season integration fixture");
    return command;
  }

  function materializeCommand(
    idempotencyKey: string,
    expectedAggregateRevision: number,
    fromDate = "2026-01-01",
    throughDate = "2026-01-31",
  ) {
    const command = parseMaterializeRecurringPricingCommand({
      ...context(idempotencyKey),
      fromDate,
      throughDate,
      expectedOptionalPricingAggregateRevision: expectedAggregateRevision,
    });
    if (!command) throw new Error("invalid materialization integration fixture");
    return command;
  }

  function weekendCommand(idempotencyKey = "all-kinds-weekend") {
    const command = parseUpsertWeekendSurchargeCommand({
      ...context(idempotencyKey),
      sourceId: weekendSourceId,
      expectedSourceRevision: 0,
      expectedPricingCurrencyRevision: 1,
      sourceKind: "weekend_surcharge",
      weekdays: ["friday", "saturday"],
      roomSurcharges: [
        {
          roomTypeId,
          expectedRoomFactsRevision: 1,
          flexibleRatePlanId: planId,
          expectedFlexibleRatePlanRevision: 1,
          amountDecimal: "15.00",
        },
      ],
    });
    if (!command) throw new Error("invalid weekend integration fixture");
    return command;
  }

  function additionalGuestCommand() {
    const command = parseUpsertAdditionalGuestPricingCommand({
      ...context("all-kinds-additional"),
      sourceId: additionalSourceId,
      expectedSourceRevision: 0,
      expectedPricingCurrencyRevision: 1,
      sourceKind: "additional_guest",
      roomTypeId,
      expectedRoomFactsRevision: 1,
      flexibleRatePlanId: planId,
      expectedFlexibleRatePlanRevision: 1,
      includedGuests: 1,
      amountDecimal: "25.00",
    });
    if (!command) throw new Error("invalid additional guest integration fixture");
    return command;
  }

  function nonRefundableCommand() {
    const command = parseUpsertNonRefundablePricingCommand({
      ...context("all-kinds-non-refundable"),
      sourceId: nonRefundableSourceId,
      expectedSourceRevision: 0,
      expectedPricingCurrencyRevision: 1,
      sourceKind: "non_refundable",
      discountPercent: 12,
      roomPlans: [
        {
          roomTypeId,
          expectedRoomFactsRevision: 1,
          flexibleRatePlanId: planId,
          expectedFlexibleRatePlanRevision: 1,
        },
      ],
    });
    if (!command) throw new Error("invalid non-refundable integration fixture");
    return command;
  }

  async function seedAuthorizedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'vay1072@example.test', 'VAY-1072', 'active')`,
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'VAY-1072', 'vay1072', 'active')`,
      [organizationId],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'vay1072', 'VAY-1072')`,
      [propertyId],
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
       VALUES ('hotel_group', $1, 'pms.operations.manage') ON CONFLICT DO NOTHING`,
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

  async function seedPricingFoundation(): Promise<void> {
    await admin.query(
      `INSERT INTO pms.property_pricing_settings
         (property_id, currency, pricing_currency_revision, optional_pricing_aggregate_revision)
       VALUES ($1::uuid, 'EUR', 1, 0)`,
      [propertyId],
    );
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, occupancy_limits, base_rate_amount,
         currency, active, room_facts_revision
       ) VALUES (
         $1::uuid, $2::uuid, 'Suite', '',
         '{"total":2,"adults":2,"children":0}'::jsonb, NULL, NULL, TRUE, 1
       )`,
      [roomTypeId, propertyId],
    );
    await admin.query(
      `INSERT INTO pms.rate_plans (
         id, property_id, room_type_id, code, name, rate_type, meal_plan,
         payment_policy, deposit_policy, cancellation_policy_snapshot,
         base_rate_amount, currency, active, pricing_contract_version,
         flexible_rate_plan_revision, source_room_facts_revision,
         source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'ONB16-FLEX', 'Flexible', 'flexible', NULL,
         '{}'::jsonb, '{}'::jsonb,
         '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,
           "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
         100.00, 'EUR', TRUE, 'pms-pricing.v1', 1, 1, 1
       )`,
      [planId, propertyId, roomTypeId],
    );
  }

  async function seedSecondRoomPricingFoundation(): Promise<void> {
    await seedSecondActiveRoom();
    await admin.query(
      `INSERT INTO pms.rate_plans (
         id, property_id, room_type_id, code, name, rate_type, meal_plan,
         payment_policy, deposit_policy, cancellation_policy_snapshot,
         base_rate_amount, currency, active, pricing_contract_version,
         flexible_rate_plan_revision, source_room_facts_revision,
         source_pricing_currency_revision
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'ONB16-FLEX-2', 'Flexible', 'flexible', NULL,
         '{}'::jsonb, '{}'::jsonb,
         '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,
           "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
         120.00, 'EUR', TRUE, 'pms-pricing.v1', 1, 1, 1
       )`,
      [secondPlanId, propertyId, secondRoomTypeId],
    );
  }

  async function seedSecondActiveRoom(): Promise<void> {
    await admin.query(
      `INSERT INTO pms.room_types (
         id, property_id, name, description, occupancy_limits, base_rate_amount,
         currency, active, room_facts_revision
       ) VALUES (
         $1::uuid, $2::uuid, 'Second Suite', '',
         '{"total":2,"adults":2,"children":0}'::jsonb, NULL, NULL, TRUE, 1
       )`,
      [secondRoomTypeId, propertyId],
    );
  }

  async function installAuditFailureTrigger(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query(
      `CREATE FUNCTION ${auditFailureFunction}()
       RETURNS trigger LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.property_id = '${propertyId}'::uuid
            AND NEW.action LIKE 'pms.recurring_pricing.%' THEN
           RAISE EXCEPTION 'injected VAY-1072 audit failure';
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
        "DELETE FROM pms.recurring_pricing_materialized_rows WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_materialization_source_receipts WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_materialization_receipts WHERE property_id = $1::uuid",
        "DELETE FROM pms.non_refundable_rate_plan_source_rooms WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_source_room_values WHERE property_id = $1::uuid",
        "DELETE FROM pms.recurring_pricing_sources WHERE property_id = $1::uuid",
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

  async function count(
    table: string,
    predicate: string,
    predicateValues: readonly unknown[] = [],
  ): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}
       WHERE property_id = $1::uuid AND ${predicate}`,
      [propertyId, ...predicateValues],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function materializedCount(): Promise<number> {
    return count("pms.recurring_pricing_materialized_rows", "TRUE");
  }

  async function sourceReceiptOrphanCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pms.recurring_pricing_materialization_source_receipts source_receipt
       LEFT JOIN pms.recurring_pricing_materialization_receipts receipt
         ON receipt.id = source_receipt.receipt_id
        AND receipt.property_id = source_receipt.property_id
        AND receipt.horizon_start = source_receipt.horizon_start
        AND receipt.horizon_end = source_receipt.horizon_end
        AND receipt.optional_pricing_aggregate_revision =
            source_receipt.optional_pricing_aggregate_revision
       LEFT JOIN pms.recurring_pricing_sources source
         ON source.id = source_receipt.source_id
        AND source.property_id = source_receipt.property_id
        AND source.source_kind = source_receipt.source_kind
        AND source.currency = source_receipt.currency
        AND source.source_pricing_currency_revision =
            source_receipt.source_pricing_currency_revision
       WHERE source_receipt.property_id = $1::uuid
         AND (receipt.id IS NULL OR source.id IS NULL)`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? -1);
  }

  async function materializedRowOrphanCount(): Promise<number> {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM pms.recurring_pricing_materialized_rows materialized
       LEFT JOIN pms.recurring_pricing_materialization_source_receipts source_receipt
         ON source_receipt.receipt_id = materialized.receipt_id
        AND source_receipt.property_id = materialized.property_id
        AND source_receipt.horizon_start = materialized.horizon_start
        AND source_receipt.horizon_end = materialized.horizon_end
        AND source_receipt.source_id = materialized.source_id
        AND source_receipt.source_kind = materialized.source_kind
        AND source_receipt.optional_pricing_aggregate_revision =
            materialized.optional_pricing_aggregate_revision
        AND source_receipt.source_revision = materialized.source_revision
        AND source_receipt.source_lifecycle = materialized.source_lifecycle
        AND source_receipt.materialization_revision = materialized.materialization_revision
        AND source_receipt.currency = materialized.currency
        AND source_receipt.source_pricing_currency_revision =
            materialized.source_pricing_currency_revision
       LEFT JOIN pms.recurring_pricing_sources source
         ON source.id = materialized.source_id
        AND source.property_id = materialized.property_id
        AND source.source_kind = materialized.source_kind
        AND source.currency = materialized.currency
        AND source.source_pricing_currency_revision =
            materialized.source_pricing_currency_revision
       LEFT JOIN pms.room_types room
         ON room.id = materialized.room_type_id
        AND room.property_id = materialized.property_id
       WHERE materialized.property_id = $1::uuid
         AND (source_receipt.receipt_id IS NULL OR source.id IS NULL OR room.id IS NULL)`,
      [propertyId],
    );
    return Number(result.rows[0]?.count ?? -1);
  }

  async function readAggregateRevision(): Promise<number> {
    const result = await admin.query<{ revision: string }>(
      `SELECT optional_pricing_aggregate_revision::text AS revision
       FROM pms.property_pricing_settings WHERE property_id = $1::uuid`,
      [propertyId],
    );
    return Number(result.rows[0]?.revision ?? -1);
  }

  async function waitForAdvisoryWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted`,
      );
      if (Number(result.rows[0]?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for recurring pricing advisory lock contenders");
  }

  function assertSafeTestDatabase(connectionString: string): void {
    const url = new URL(connectionString);
    const database = url.pathname.slice(1).toLowerCase();
    if (!/(test|vayada_ci)/.test(database)) {
      throw new Error("Refusing to run VAY-1072 integration tests against a non-test database");
    }
  }
});
