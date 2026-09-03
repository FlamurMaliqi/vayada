import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
} from "@vayada/domain-pms";

import {
  PMS_CALENDAR_AUTO_OPEN_QUEUE,
  createPgPmsChannexSchedulerStore,
} from "./pmsChannexScheduler.js";
import { createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort } from "../domains/hotelCatalogOperatingCalendarPropertyProfileEvidence.js";
import {
  createPgPmsCalendarAutoOpenWorkerStore,
  runPmsCalendarAutoOpenWorkerOnce,
} from "./pmsCalendarAutoOpenWorker.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const now = new Date("2026-09-03T10:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("PMS calendar auto-open candidate selection", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const store = createPgPmsChannexSchedulerStore({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    max: 1,
  });
  const propertyProfileEvidence = createPgHotelCatalogOperatingCalendarPropertyProfileEvidencePort({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
  });
  const worker = createPgPmsCalendarAutoOpenWorkerStore({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    propertyProfileEvidence,
  });

  beforeAll(() => assertSafeTestDatabase(TEST_DATABASE_URL!));
  afterAll(async () =>
    Promise.all([admin.end(), store.close(), worker.close?.(), propertyProfileEvidence.close()]),
  );

  it("paginates canonical property settings without Channex and reselects changed sources", async () => {
    const incompletePropertyId = await seedIncompleteProperty(admin, 0);
    const first = await seedProperty(admin, 1, {
      mode: "rolling",
      rollingMonths: 12,
      fixedEndMonth: null,
    });
    const second = await seedProperty(admin, 2, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2028-09-01",
    });
    await seedProperty(admin, 3, {
      enabled: false,
      mode: "rolling",
      rollingMonths: 12,
      fixedEndMonth: null,
    });
    await seedProperty(admin, 4, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-08-01",
    });
    const covered = await seedProperty(admin, 5, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-12-01",
    });
    await seedCoverage(admin, covered, "2026-09-03", "2026-12-31", sourceFingerprint(covered));
    const sparse = await seedProperty(admin, 6, {
      mode: "rolling",
      rollingMonths: 12,
      fixedEndMonth: null,
    });
    await seedSparseInventoryDay(admin, sparse, "2027-09-30");

    const firstPage = await store.findCalendarAutoOpenCandidates(now, 1);
    expect(firstPage.failures).toEqual([
      {
        propertyId: incompletePropertyId,
        stage: "selection",
        message: "PMS calendar auto-open property source is incomplete",
      },
    ]);
    expect(firstPage.candidates).toHaveLength(1);
    expect(firstPage.candidates[0]).toMatchObject({
      propertyId: first.propertyId,
      openFrom: "2026-09-03",
      openThrough: "2027-09-30",
      roomTypeIds: [first.roomTypeId],
      generatedCoverageThrough: null,
      source: {
        contractVersion: "pms-calendar-auto-open-source.v1",
        settingRevision: 1,
        propertyProfileRevision: 1,
        propertyTimeZone: "Europe/Berlin",
        operatingCalendarRevision: 1,
        rooms: [{ roomTypeId: first.roomTypeId, roomFactsRevision: 1, roomUnitsRevision: 1 }],
        pricing: {
          pricingCurrencyRevision: 1,
          flexibleRatePlans: [],
          optionalPricingAggregateRevision: 0,
        },
      },
    });
    const firstEnqueue = await store.enqueueCalendarAutoOpenJob(
      firstPage.candidates[0]!,
      context(),
    );
    expect(firstEnqueue.createdNewJob).toBe(true);
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-test",
        now: () => now,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "partial" });
    const applied = await admin.query(
      `SELECT job.status,
              (SELECT count(*)::int FROM pms.inventory_days day
               WHERE day.property_id=job.property_id) AS days,
              (SELECT min(generated_sellable_limit_count)::int FROM pms.inventory_days day
               WHERE day.property_id=job.property_id) AS "minimumGenerated",
              (SELECT max(available_count)::int FROM pms.inventory_days day
               WHERE day.property_id=job.property_id) AS "maximumAvailable",
              (SELECT bool_and(rate_gate_open IS FALSE) FROM pms.inventory_days day
               WHERE day.property_id=job.property_id) AS "rateGated",
              (SELECT coverage_through::text FROM pms.inventory_materialization_coverage coverage
               WHERE coverage.property_id=job.property_id) AS "coverageThrough",
              (SELECT count(*)::int FROM platform.outbox_events outbox
               WHERE outbox.property_id=job.property_id
                 AND outbox.destination='distribution.inventory-projection') AS projections,
              (SELECT count(*)::int FROM platform.outbox_events outbox
               WHERE outbox.property_id=job.property_id
                 AND outbox.event_type='pms.inventory.ari_changed') AS ari,
              (SELECT bool_and((outbox.payload->>'rateGateOpen')::boolean IS FALSE)
               FROM platform.outbox_events outbox WHERE outbox.property_id=job.property_id
                 AND outbox.event_type='pms.inventory.ari_changed') AS "ariRateGated",
              job.job_metadata->'calendarAutoOpenResult'->>'outcome' AS outcome
       FROM platform.jobs job WHERE job.job_key=$1`,
      [firstEnqueue.jobKey],
    );
    expect(applied.rows[0]).toEqual({
      status: "succeeded",
      days: 393,
      minimumGenerated: 0,
      maximumAvailable: 0,
      rateGated: true,
      coverageThrough: "2027-09-30",
      projections: 1,
      ari: 1,
      ariRateGated: true,
      outcome: "partial",
    });
    const durableRateGate = await store.enqueueAriPushJob(
      {
        source: "incremental",
        propertyId: first.propertyId,
        organizationId: first.organizationId,
        connectionId: randomUUID(),
        channexPropertyId: "channex-property",
        roomTypeId: first.roomTypeId,
        channexRoomTypeId: "channex-room",
        dateRange: { from: "2026-09-03", to: "2026-09-03" },
        inventoryVersion: "vay-1436-rate-gated",
        rateGateOpen: false,
        triggerRefId: "vay-1436-rate-gated",
        correlationId: "vay-1436-rate-gated",
      },
      context(),
    );
    expect(
      await admin.query(
        `SELECT payload->>'rateGateOpen' AS "rateGateOpen"
         FROM platform.jobs WHERE job_key=$1`,
        [durableRateGate.job.jobKey],
      ),
    ).toMatchObject({ rows: [{ rateGateOpen: "false" }] });

    await admin.query(
      `UPDATE pms.inventory_days
       SET inventory_revision=inventory_revision+1, manual_source_revision=1,
           manual_sellable_limit_count=1, effective_sellable_limit_count=1,
           available_count=1
       WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND stay_date='2026-09-03'`,
      [first.propertyId, first.roomTypeId],
    );
    await admin.query(
      `INSERT INTO pms.rate_plans(
         id,property_id,room_type_id,code,name,rate_type,base_rate_amount,currency,active,
         cancellation_policy_snapshot,pricing_contract_version,flexible_rate_plan_revision,
         source_room_facts_revision,source_pricing_currency_revision)
       VALUES($1::uuid,$2::uuid,$3::uuid,'flexible','Flexible','flexible',100,'EUR',TRUE,
         '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":1,
           "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
         'pms-pricing.v1',1,1,1)`,
      [randomUUID(), first.propertyId, first.roomTypeId],
    );
    const pricedSource = sourceFor(first, 1);
    await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: first.propertyId,
        organizationId: first.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2027-09-30",
        roomTypeIds: [first.roomTypeId],
        generatedCoverageThrough: "2027-09-30",
        source: pricedSource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(pricedSource),
      },
      context(),
    );
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-test",
        now: () => now,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "applied" });
    expect(
      await admin.query(
        `SELECT generated_sellable_limit_count AS generated,
                manual_sellable_limit_count AS manual,
                effective_sellable_limit_count AS effective,
                available_count AS available, manual_source_revision AS "manualRevision",
                rate_gate_open AS "rateGateOpen"
         FROM pms.inventory_days
         WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND stay_date='2026-09-03'`,
        [first.propertyId, first.roomTypeId],
      ),
    ).toMatchObject({
      rows: [
        {
          generated: 2,
          manual: 1,
          effective: 1,
          available: 1,
          manualRevision: 1,
          rateGateOpen: true,
        },
      ],
    });

    const beforeReprice = (
      await admin.query<{
        inventoryRevision: number;
        projections: number;
        ari: number;
      }>(
        `SELECT day.inventory_revision AS "inventoryRevision",
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=day.property_id
                   AND outbox.destination='distribution.inventory-projection') AS projections,
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=day.property_id
                   AND outbox.event_type='pms.inventory.ari_changed') AS ari
         FROM pms.inventory_days day
         WHERE day.property_id=$1::uuid AND day.room_type_id=$2::uuid
           AND day.stay_date='2026-09-03'`,
        [first.propertyId, first.roomTypeId],
      )
    ).rows[0]!;
    await admin.query(
      `UPDATE pms.rate_plans
       SET base_rate_amount=110, flexible_rate_plan_revision=2
       WHERE property_id=$1::uuid AND room_type_id=$2::uuid`,
      [first.propertyId, first.roomTypeId],
    );
    const repricedCandidate = await store.findCalendarAutoOpenCandidates(now, 1);
    expect(repricedCandidate.candidates).toHaveLength(1);
    expect(repricedCandidate.candidates[0]).toMatchObject({
      propertyId: first.propertyId,
      generatedCoverageThrough: "2027-09-30",
      source: { pricing: { flexibleRatePlans: [{ flexibleRatePlanRevision: 2 }] } },
    });
    const repriced = await store.enqueueCalendarAutoOpenJob(
      repricedCandidate.candidates[0]!,
      context(),
    );
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-reprice-test",
        now: () => now,
      }),
    ).resolves.toMatchObject({
      outcome: "succeeded",
      applicationOutcome: "applied",
    });
    expect(
      await admin.query(
        `SELECT day.inventory_revision AS "inventoryRevision",
                day.generated_pricing_source_fingerprint AS fingerprint,
                day.manual_sellable_limit_count AS manual,
                day.available_count AS available,
                (job.job_metadata->'calendarAutoOpenResult'->>'changedDayCount')::int
                  AS "changedDayCount",
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=day.property_id
                   AND outbox.destination='distribution.inventory-projection') AS projections,
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=day.property_id
                   AND outbox.event_type='pms.inventory.ari_changed') AS ari
         FROM pms.inventory_days day
         JOIN platform.jobs job ON job.job_key=$3
         WHERE day.property_id=$1::uuid AND day.room_type_id=$2::uuid
           AND day.stay_date='2026-09-03'`,
        [first.propertyId, first.roomTypeId, repriced.jobKey],
      ),
    ).toMatchObject({
      rows: [
        {
          inventoryRevision: beforeReprice.inventoryRevision + 1,
          fingerprint: repricedCandidate.candidates[0]!.sourceFingerprint,
          manual: 1,
          available: 1,
          changedDayCount: 393,
          projections: beforeReprice.projections + 1,
          ari: beforeReprice.ari + 1,
        },
      ],
    });
    expect(repriced.createdNewJob).toBe(true);

    const nextPage = await store.findCalendarAutoOpenCandidates(now, 1);
    expect(nextPage.candidates.map(({ propertyId }) => propertyId)).toEqual([second.propertyId]);
    const secondSourceFingerprint = nextPage.candidates[0]!.sourceFingerprint;
    const secondEnqueue = await store.enqueueCalendarAutoOpenJob(
      nextPage.candidates[0]!,
      context(),
    );
    expect(secondEnqueue).toMatchObject({
      createdNewJob: true,
      eventKey: `pms.calendar-auto-open:${second.propertyId}:2028-09-30:source-${secondSourceFingerprint}:v2`,
      jobKey: `pms.calendar-auto-open:property:${second.propertyId}:open-through-2028-09-30:source-${secondSourceFingerprint}:v2`,
    });

    await admin.query("UPDATE pms.room_types SET room_facts_revision = 2 WHERE id = $1::uuid", [
      second.roomTypeId,
    ]);
    const changedSource = await store.findCalendarAutoOpenCandidates(now, 2);
    expect(changedSource.candidates).toHaveLength(2);
    expect(changedSource.candidates[0]).toMatchObject({
      propertyId: second.propertyId,
      openThrough: "2028-09-30",
      generatedCoverageThrough: null,
      source: { rooms: [{ roomFactsRevision: 2 }] },
    });
    expect(changedSource.candidates[0]!.sourceFingerprint).not.toBe(secondSourceFingerprint);
    expect(changedSource.candidates[1]).toMatchObject({
      propertyId: sparse.propertyId,
      generatedCoverageThrough: null,
    });
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-test",
        now: () => now,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "unchanged" });
    expect(
      await admin.query(
        `SELECT count(*)::int AS count FROM pms.inventory_days WHERE property_id=$1`,
        [second.propertyId],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });

    const persisted = await admin.query<{
      queueName: string;
      status: string;
      sourceFingerprint: string;
      events: number;
      audits: number;
      channexConnections: number;
    }>(
      `SELECT job.queue_name AS "queueName", job.status,
              job.payload ->> 'sourceFingerprint' AS "sourceFingerprint",
              (SELECT count(*)::int FROM platform.domain_events event
               WHERE event.property_id = job.property_id
                 AND event.event_type = 'pms.calendar-auto-open') AS events,
              (SELECT count(*)::int FROM platform.product_audit_events audit
               WHERE audit.property_id = job.property_id
                 AND audit.action = 'pms.calendar_auto_open') AS audits,
              (SELECT count(*)::int FROM pms.channel_connections connection
               WHERE connection.property_id = job.property_id) AS "channexConnections"
       FROM platform.jobs job
       WHERE job.property_id = $1::uuid AND job.job_type = 'pms.calendar-auto-open'`,
      [second.propertyId],
    );
    expect(persisted.rows[0]).toEqual({
      queueName: PMS_CALENDAR_AUTO_OPEN_QUEUE,
      status: "succeeded",
      sourceFingerprint: secondSourceFingerprint,
      events: 1,
      audits: 0,
      channexConnections: 0,
    });

    const rollbackProperty = await seedProperty(admin, 7, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-12-01",
    });
    const rollbackSource = sourceFor(rollbackProperty);
    const rollbackJob = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: rollbackProperty.propertyId,
        organizationId: rollbackProperty.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2026-12-31",
        roomTypeIds: [rollbackProperty.roomTypeId],
        generatedCoverageThrough: null,
        source: rollbackSource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(rollbackSource),
      },
      context(),
    );
    await admin.query(
      `CREATE FUNCTION platform.vay1436_fail_application_audit() RETURNS trigger
       LANGUAGE plpgsql AS $$BEGIN
         IF NEW.property_id='${rollbackProperty.propertyId}'::uuid
           AND NEW.action='pms.calendar_auto_open.applied'
         THEN RAISE EXCEPTION 'forced VAY-1436 rollback'; END IF; RETURN NEW;
       END$$;
       CREATE TRIGGER vay1436_fail_application_audit
       BEFORE INSERT ON platform.product_audit_events
       FOR EACH ROW EXECUTE FUNCTION platform.vay1436_fail_application_audit()`,
    );
    try {
      await expect(
        runPmsCalendarAutoOpenWorkerOnce({
          store: worker,
          workerId: "vay-1436-test",
          now: () => now,
        }),
      ).resolves.toMatchObject({ outcome: "retry_scheduled", jobId: expect.any(String) });
    } finally {
      await admin.query(
        `DROP TRIGGER vay1436_fail_application_audit ON platform.product_audit_events;
         DROP FUNCTION platform.vay1436_fail_application_audit()`,
      );
    }
    expect(
      await admin.query(
        `SELECT job.status, job.attempts_count::int AS attempts,
                job.job_metadata ? 'calendarAutoOpenResult' AS applied,
                (SELECT count(*)::int FROM pms.inventory_days day
                 WHERE day.property_id=job.property_id) AS days,
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=job.property_id) AS outboxes
         FROM platform.jobs job WHERE job.job_key=$1`,
        [rollbackJob.jobKey],
      ),
    ).toMatchObject({
      rows: [{ status: "pending", attempts: 1, applied: false, days: 0, outboxes: 0 }],
    });
    await admin.query(
      `UPDATE platform.jobs SET run_after='2099-01-01T00:00:00Z'
       WHERE job_key=$1`,
      [rollbackJob.jobKey],
    );

    const replayProperty = await seedProperty(admin, 8, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-12-01",
    });
    const replaySource = sourceFor(replayProperty);
    const replayJob = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: replayProperty.propertyId,
        organizationId: replayProperty.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2026-12-31",
        roomTypeIds: [replayProperty.roomTypeId],
        generatedCoverageThrough: null,
        source: replaySource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(replaySource),
      },
      context(),
    );
    const abandoned = await worker.claim({ workerId: "abandoned-vay-1436", now });
    expect(abandoned).toMatchObject({ jobId: expect.any(String), jobKey: replayJob.jobKey });
    if (!abandoned || "deadLetteredJobId" in abandoned) {
      throw new Error("Expected a claimed calendar auto-open job");
    }
    await expect(
      worker.apply(abandoned, { workerId: "abandoned-vay-1436", now }),
    ).resolves.toMatchObject({ outcome: "partial" });
    const recoveredAt = new Date(now.getTime() + 6 * 60_000);
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-recovery-test",
        now: () => recoveredAt,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "partial" });
    expect(
      await admin.query(
        `SELECT job.status, job.attempts_count::int AS attempts,
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=job.property_id
                   AND outbox.destination='distribution.inventory-projection') AS projections,
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=job.property_id
                   AND outbox.event_type='pms.inventory.ari_changed') AS ari
         FROM platform.jobs job WHERE job.job_key=$1`,
        [replayJob.jobKey],
      ),
    ).toMatchObject({
      rows: [{ status: "succeeded", attempts: 2, projections: 1, ari: 1 }],
    });

    const invalidProperty = await seedProperty(admin, 9, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-12-01",
    });
    const invalidSource = sourceFor(invalidProperty);
    const invalidJob = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: invalidProperty.propertyId,
        organizationId: invalidProperty.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2026-12-31",
        roomTypeIds: [invalidProperty.roomTypeId],
        generatedCoverageThrough: null,
        source: invalidSource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(invalidSource),
      },
      context(),
    );
    await admin.query(`UPDATE platform.jobs SET payload='{}'::jsonb WHERE job_key=$1`, [
      invalidJob.jobKey,
    ]);
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-test",
        now: () => now,
      }),
    ).resolves.toMatchObject({ outcome: "dead_lettered" });
    expect(
      await admin.query(
        `SELECT job.status, job.attempts_count::int AS attempts,
                dead.reason_code AS reason,
                dead.failure_payload->>'replayEligible' AS replay
         FROM platform.jobs job
         JOIN platform.dead_letter_events dead ON dead.job_id=job.id
         WHERE job.job_key=$1`,
        [invalidJob.jobKey],
      ),
    ).toMatchObject({
      rows: [
        {
          status: "dead_lettered",
          attempts: 1,
          reason: "non_retryable_error",
          replay: "false",
        },
      ],
    });

    const delayedProperty = await seedProperty(admin, 10, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-12-01",
    });
    const delayedSource = sourceFor(delayedProperty);
    const delayedJob = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: delayedProperty.propertyId,
        organizationId: delayedProperty.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2026-12-31",
        roomTypeIds: [delayedProperty.roomTypeId],
        generatedCoverageThrough: null,
        source: delayedSource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(delayedSource),
      },
      context(),
    );
    const delayedNow = new Date("2026-09-09T22:30:00.000Z");
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-delayed-test",
        now: () => delayedNow,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "partial" });
    expect(
      await admin.query(
        `SELECT min(day.stay_date)::text AS "firstDate", count(*)::int AS days,
                (SELECT coverage_from::text FROM pms.inventory_materialization_coverage
                 WHERE property_id=$1::uuid) AS "coverageFrom"
         FROM pms.inventory_days day WHERE day.property_id=$1::uuid`,
        [delayedProperty.propertyId],
      ),
    ).toMatchObject({ rows: [{ firstDate: "2026-09-10", days: 113, coverageFrom: "2026-09-10" }] });
    expect(delayedJob.createdNewJob).toBe(true);

    const expiredProperty = await seedProperty(admin, 11, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-08-01",
    });
    const expiredSource = sourceFor(expiredProperty);
    const expiredJob = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: expiredProperty.propertyId,
        organizationId: expiredProperty.organizationId,
        openFrom: "2026-08-01",
        openThrough: "2026-08-31",
        roomTypeIds: [expiredProperty.roomTypeId],
        generatedCoverageThrough: "2026-12-31",
        source: expiredSource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(expiredSource),
      },
      context(),
    );
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-expired-test",
        now: () => delayedNow,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "unchanged" });
    expect(
      await admin.query(
        `SELECT (SELECT count(*)::int FROM pms.inventory_days
                 WHERE property_id=$1::uuid) AS days,
                (SELECT count(*)::int FROM platform.outbox_events
                 WHERE property_id=$1::uuid) AS outboxes,
                job.job_metadata->'calendarAutoOpenResult'->>'changedDayCount' AS changed
         FROM platform.jobs job WHERE job.job_key=$2`,
        [expiredProperty.propertyId, expiredJob.jobKey],
      ),
    ).toMatchObject({ rows: [{ days: 0, outboxes: 0, changed: "0" }] });

    const exhaustedProperty = await seedProperty(admin, 12, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-12-01",
    });
    const exhaustedSource = sourceFor(exhaustedProperty);
    const exhaustedJob = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: exhaustedProperty.propertyId,
        organizationId: exhaustedProperty.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2026-12-31",
        roomTypeIds: [exhaustedProperty.roomTypeId],
        generatedCoverageThrough: null,
        source: exhaustedSource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(exhaustedSource),
      },
      context(),
    );
    await admin.query(
      `UPDATE platform.jobs SET status='running',attempts_count=max_attempts,
         locked_by='lost-worker',locked_at=$2::timestamptz - interval '6 minutes'
       WHERE job_key=$1`,
      [exhaustedJob.jobKey, delayedNow.toISOString()],
    );
    await admin.query(
      `INSERT INTO platform.job_attempts (job_id,attempt_number,status,worker_id,started_at)
       SELECT id,max_attempts,'running','lost-worker',$2::timestamptz - interval '7 minutes'
       FROM platform.jobs WHERE job_key=$1`,
      [exhaustedJob.jobKey, delayedNow.toISOString()],
    );
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-exhausted-test",
        now: () => delayedNow,
      }),
    ).resolves.toMatchObject({ outcome: "dead_lettered", jobId: expect.any(String) });
    expect(
      await admin.query(
        `SELECT job.status,dead.reason_code AS reason
         FROM platform.jobs job JOIN platform.dead_letter_events dead ON dead.job_id=job.id
         WHERE job.job_key=$1`,
        [exhaustedJob.jobKey],
      ),
    ).toMatchObject({ rows: [{ status: "dead_lettered", reason: "max_attempts_exhausted" }] });
  });

  it("rejects untrusted job horizons and generated coverage without inventory", async () => {
    const property = await seedProperty(admin, 19, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-12-01",
    });
    const source = sourceFor(property);
    const enqueue = (
      openFrom: string,
      openThrough: string,
      generatedCoverageThrough: string | null = null,
    ) =>
      store.enqueueCalendarAutoOpenJob(
        {
          propertyId: property.propertyId,
          organizationId: property.organizationId,
          openFrom,
          openThrough,
          roomTypeIds: [property.roomTypeId],
          generatedCoverageThrough,
          source,
          sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(source),
        },
        context(),
      );
    const jobs = await Promise.all([
      enqueue("2026-09-03", "2028-10-31"),
      enqueue("9000-01-01", "9002-01-31"),
      enqueue("2026-09-03", "2027-09-30"),
      enqueue("2026-09-03", "2026-12-31", "2027-01-31"),
    ]);
    for (const workerId of ["oversized", "shifted", "setting-mismatch", "coverage-mismatch"]) {
      await expect(
        runPmsCalendarAutoOpenWorkerOnce({
          store: worker,
          workerId: `vay-1436-${workerId}-test`,
          now: () => now,
        }),
      ).resolves.toMatchObject({ outcome: "dead_lettered", jobId: expect.any(String) });
    }
    expect(
      await admin.query(
        `SELECT count(*)::int AS jobs,
                count(*) FILTER (WHERE job.status='dead_lettered')::int AS dead,
                (SELECT count(*)::int FROM pms.inventory_days day
                 WHERE day.property_id=$1::uuid) AS days,
                count(*) FILTER (WHERE dead.reason_code='non_retryable_error')::int AS permanent
         FROM platform.jobs job
         JOIN platform.dead_letter_events dead ON dead.job_id=job.id
         WHERE job.job_key=ANY($2::text[])`,
        [property.propertyId, jobs.map(({ jobKey }) => jobKey)],
      ),
    ).toMatchObject({
      rows: [{ jobs: 4, dead: 4, days: 0, permanent: 4 }],
    });
  });

  it("materializes complete ordered multi-room coverage from sparse state", async () => {
    const property = await seedProperty(admin, 20, {
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-09-01",
    });
    const secondRoomTypeId = await addBoundRoom(admin, property);
    await admin.query(
      `INSERT INTO pms.inventory_days (
         property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
         inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
         generated_source_revision,channel_source_revision,manual_source_revision,
         block_source_revision,booking_source_revision
       ) SELECT $1::uuid,room_type_id,'2026-09-03',2,2,1,1,2,2,1,0,0,0,0
         FROM unnest($2::uuid[]) room_type_id`,
      [property.propertyId, [property.roomTypeId, secondRoomTypeId]],
    );
    await admin.query(
      `INSERT INTO pms.rate_plans(
         id,property_id,room_type_id,code,name,rate_type,base_rate_amount,currency,active,
         cancellation_policy_snapshot,pricing_contract_version,flexible_rate_plan_revision,
         source_room_facts_revision,source_pricing_currency_revision)
       VALUES($1::uuid,$2::uuid,$3::uuid,'flexible','Flexible','flexible',100,'EUR',TRUE,
         '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":1,
           "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}'::jsonb,
         'pms-pricing.v1',1,1,1)`,
      [randomUUID(), property.propertyId, property.roomTypeId],
    );
    const source = createPmsCalendarAutoOpenSource({
      settingRevision: 1,
      propertyProfileRevision: 1,
      propertyTimeZone: "Europe/Berlin",
      operatingCalendarRevision: 1,
      rooms: [property.roomTypeId, secondRoomTypeId].map((roomTypeId) => ({
        roomTypeId,
        roomFactsRevision: 1,
        roomUnitsRevision: 1,
      })),
      pricing: {
        pricingCurrencyRevision: 1,
        flexibleRatePlans: [{ roomTypeId: property.roomTypeId, flexibleRatePlanRevision: 1 }],
        optionalPricingAggregateRevision: 0,
      },
    });
    const job = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: property.propertyId,
        organizationId: property.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2026-09-30",
        roomTypeIds: source.rooms.map(({ roomTypeId }) => roomTypeId),
        generatedCoverageThrough: null,
        source,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(source),
      },
      context(),
    );
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-multi-room-test",
        now: () => now,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "partial" });
    const rooms = await admin.query<{
      roomTypeId: string;
      days: number;
      firstDate: string;
      lastDate: string;
      rateGateOpen: boolean;
    }>(
      `SELECT room_type_id::text AS "roomTypeId",count(*)::int AS days,
              min(stay_date)::text AS "firstDate",max(stay_date)::text AS "lastDate",
              bool_and(rate_gate_open) AS "rateGateOpen"
       FROM pms.inventory_days WHERE property_id=$1::uuid
       GROUP BY room_type_id ORDER BY room_type_id`,
      [property.propertyId],
    );
    expect(rooms.rows).toEqual(
      [
        { roomTypeId: property.roomTypeId, rateGateOpen: true },
        { roomTypeId: secondRoomTypeId, rateGateOpen: false },
      ]
        .sort((left, right) => left.roomTypeId.localeCompare(right.roomTypeId))
        .map((room) => ({
          ...room,
          days: 28,
          firstDate: "2026-09-03",
          lastDate: "2026-09-30",
        })),
    );
    expect(
      await admin.query(
        `SELECT coverage.room_type_count AS rooms,
                coverage.materialized_day_count AS days,
                jsonb_array_length(job.job_metadata->'calendarAutoOpenResult'->'warnings')
                  AS warnings,
                (SELECT count(*)::int FROM platform.outbox_events outbox
                 WHERE outbox.property_id=coverage.property_id
                   AND outbox.event_type='pms.inventory.ari_changed') AS ari
         FROM pms.inventory_materialization_coverage coverage
         JOIN platform.jobs job ON job.job_key=$2
         WHERE coverage.property_id=$1::uuid`,
        [property.propertyId, job.jobKey],
      ),
    ).toMatchObject({ rows: [{ rooms: 2, days: 56, warnings: 1, ari: 2 }] });

    await admin.query(
      `UPDATE pms.rate_plans SET base_rate_amount=110,flexible_rate_plan_revision=2
       WHERE property_id=$1::uuid AND room_type_id=$2::uuid`,
      [property.propertyId, property.roomTypeId],
    );
    const changedSource = createPmsCalendarAutoOpenSource({
      ...source,
      pricing: {
        ...source.pricing,
        flexibleRatePlans: [{ roomTypeId: property.roomTypeId, flexibleRatePlanRevision: 2 }],
      },
    });
    const staleCoverageJob = await store.enqueueCalendarAutoOpenJob(
      {
        propertyId: property.propertyId,
        organizationId: property.organizationId,
        openFrom: "2026-09-03",
        openThrough: "2026-09-10",
        roomTypeIds: changedSource.rooms.map(({ roomTypeId }) => roomTypeId),
        generatedCoverageThrough: null,
        source: changedSource,
        sourceFingerprint: fingerprintPmsCalendarAutoOpenSource(changedSource),
      },
      context(),
    );
    await expect(
      runPmsCalendarAutoOpenWorkerOnce({
        store: worker,
        workerId: "vay-1436-stale-coverage-test",
        now: () => now,
      }),
    ).resolves.toMatchObject({ outcome: "succeeded", applicationOutcome: "partial" });
    expect(
      await admin.query(
        `SELECT coverage_through::text AS "coverageThrough",materialized_day_count AS days,
                (job.job_metadata->'calendarAutoOpenResult'->>'changedDayCount')::int AS changed
         FROM pms.inventory_materialization_coverage coverage
         JOIN platform.jobs job ON job.job_key=$2
         WHERE coverage.property_id=$1::uuid`,
        [property.propertyId, staleCoverageJob.jobKey],
      ),
    ).toMatchObject({ rows: [{ coverageThrough: "2026-09-30", days: 56, changed: 56 }] });
  });
});

type SeededProperty = { propertyId: string; roomTypeId: string; organizationId: string };

async function seedIncompleteProperty(admin: pg.Pool, order: number): Promise<string> {
  const propertyId = orderedUuid(order);
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'VAY-1435 Incomplete Candidate')`,
    [propertyId, `vay-1435-incomplete-${propertyId}`],
  );
  await admin.query(
    `INSERT INTO pms.calendar_auto_open_settings
       (property_id, revision, enabled, mode, rolling_months, fixed_end_month)
     VALUES ($1::uuid, 1, TRUE, 'rolling', 12, NULL)`,
    [propertyId],
  );
  return propertyId;
}

async function seedProperty(
  admin: pg.Pool,
  order: number,
  setting: {
    enabled?: boolean;
    mode: "rolling" | "fixed";
    rollingMonths: 12 | null;
    fixedEndMonth: string | null;
  },
): Promise<SeededProperty> {
  const propertyId = orderedUuid(order);
  const roomTypeId = randomUUID();
  const organizationId = randomUUID();
  await admin.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1::uuid, $2, 'VAY-1435 Candidate')`,
    [propertyId, `vay-1435-${propertyId}`],
  );
  await admin.query(
    `INSERT INTO hotel_catalog.property_locations (property_id, timezone)
     VALUES ($1::uuid, 'Europe/Berlin')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO pms.room_types (id, property_id, name)
     VALUES ($1::uuid, $2::uuid, 'Candidate Room')`,
    [roomTypeId, propertyId],
  );
  await admin.query(
    `INSERT INTO pms.property_pricing_settings (property_id, currency)
     VALUES ($1::uuid, 'EUR')`,
    [propertyId],
  );
  await admin.query(
    `INSERT INTO pms.calendar_auto_open_settings
       (property_id, revision, enabled, mode, rolling_months, fixed_end_month)
     VALUES ($1::uuid, 1, $2, $3, $4, $5::date)`,
    [
      propertyId,
      setting.enabled ?? true,
      setting.mode,
      setting.rollingMonths,
      setting.fixedEndMonth,
    ],
  );

  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO pms.operating_calendar_revisions
         (organization_id, property_id, calendar_revision, contract_version,
          property_profile_revision, property_time_zone, schedule_mode,
          recurring_period_count, room_binding_count, default_minimum_stay_nights,
          idempotency_key_id, domain_event_id, outbox_event_id, created_by_user_id,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 1, 'pms-operating-calendar.v1', 1, 'Europe/Berlin',
          'year_round', 0, 1, 1, $3::uuid, $4::uuid, $5::uuid, $6::uuid, now(), now())`,
      [organizationId, propertyId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );
    await client.query(
      `INSERT INTO pms.operating_calendar_room_bindings
         (property_id, calendar_revision, room_type_id, source_room_facts_revision,
          source_room_units_revision, physical_capacity_count, starting_sellable_limit_count)
       VALUES ($1::uuid, 1, $2::uuid, 1, 1, 2, 2)`,
      [propertyId, roomTypeId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { propertyId, roomTypeId, organizationId };
}

async function seedSparseInventoryDay(
  admin: pg.Pool,
  property: SeededProperty,
  stayDate: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO pms.inventory_days
       (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,
        inventory_revision,generated_sellable_limit_count,effective_sellable_limit_count,
        generated_source_revision,channel_source_revision,manual_source_revision,
        block_source_revision,booking_source_revision)
     VALUES ($1::uuid,$2::uuid,$3::date,2,2,1,1,2,2,1,0,0,0,0)`,
    [property.propertyId, property.roomTypeId, stayDate],
  );
}

async function addBoundRoom(admin: pg.Pool, property: SeededProperty): Promise<string> {
  const roomTypeId = randomUUID();
  await admin.query(
    `INSERT INTO pms.room_types (id,property_id,name)
     VALUES ($1::uuid,$2::uuid,'Second Candidate Room')`,
    [roomTypeId, property.propertyId],
  );
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE pms.operating_calendar_revisions SET room_binding_count=2
       WHERE property_id=$1::uuid AND calendar_revision=1`,
      [property.propertyId],
    );
    await client.query(
      `INSERT INTO pms.operating_calendar_room_bindings (
         property_id,calendar_revision,room_type_id,source_room_facts_revision,
         source_room_units_revision,physical_capacity_count,starting_sellable_limit_count
       ) VALUES ($1::uuid,1,$2::uuid,1,1,2,2)`,
      [property.propertyId, roomTypeId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return roomTypeId;
}

async function seedCoverage(
  admin: pg.Pool,
  property: SeededProperty,
  from: string,
  through: string,
  sourceFingerprint: string,
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const domainEventId = randomUUID();
    await client.query(
      `INSERT INTO platform.domain_events
         (id, source_system, event_key, event_type, occurred_at, tenant_scope,
          property_id, resource_product, resource_type, resource_id, actor_type, payload)
       VALUES ($1::uuid, 'pms', $2, 'pms.inventory.projection_refresh_requested', now(), 'property',
               $3::uuid, 'pms', 'property', $3::uuid::text, 'system', $4::jsonb)`,
      [
        domainEventId,
        `vay-1435-coverage:${property.propertyId}`,
        property.propertyId,
        JSON.stringify({
          contractVersion: "pms-inventory-materialization.v1",
          destination: "distribution.inventory-projection",
          eventType: "pms.inventory.projection_refresh_requested",
          organizationId: property.organizationId,
          propertyId: property.propertyId,
          configurationSource: {
            ownerDomain: "pms",
            entityType: "pms_operating_calendar.v1",
            entityId: property.propertyId,
            revision: "calendar:1",
          },
          materializedRevision: 1,
          coverageFrom: from,
          coverageThrough: through,
          roomTypeIds: [property.roomTypeId],
          reason: "horizon_extension",
        }),
      ],
    );
    await client.query(
      `INSERT INTO platform.jobs
         (job_key, queue_name, job_type, source_domain_event_id, status, attempts_count,
          max_attempts, run_after, finished_at, tenant_scope, property_id, resource_product,
          resource_type, resource_id, payload)
       VALUES ($1, 'pms.inventory.scheduler', 'pms.calendar-auto-open', $2::uuid,
               'succeeded', 1, 5, now(), now(), 'property', $3::uuid, 'pms', 'property',
               $3::uuid::text, $4::jsonb)`,
      [
        `pms.calendar-auto-open:property:${property.propertyId}:open-through-${through}:source-${sourceFingerprint}:v2`,
        domainEventId,
        property.propertyId,
        JSON.stringify({ sourceFingerprint, openThrough: through }),
      ],
    );
    await client.query(
      `INSERT INTO pms.inventory_materialization_coverage
         (property_id, organization_id, calendar_revision, materialized_revision,
          coverage_from, coverage_through, room_type_count, expected_day_count,
          materialized_day_count, last_changed_materialization_idempotency_key_id,
          last_changed_materialization_domain_event_id,
          last_changed_materialization_outbox_event_id, updated_at)
       SELECT $1::uuid, revision.organization_id, 1, 1, $2::date, $3::date, 1,
              ($3::date - $2::date) + 1, ($3::date - $2::date) + 1,
              $4::uuid, $5::uuid, $6::uuid, now()
       FROM pms.operating_calendar_revisions revision
       WHERE revision.property_id = $1::uuid AND revision.calendar_revision = 1`,
      [property.propertyId, from, through, randomUUID(), domainEventId, randomUUID()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sourceFingerprint(property: SeededProperty): string {
  return fingerprintPmsCalendarAutoOpenSource(sourceFor(property));
}

function sourceFor(property: SeededProperty, flexibleRatePlanRevision?: number) {
  return createPmsCalendarAutoOpenSource({
    settingRevision: 1,
    propertyProfileRevision: 1,
    propertyTimeZone: "Europe/Berlin",
    operatingCalendarRevision: 1,
    rooms: [{ roomTypeId: property.roomTypeId, roomFactsRevision: 1, roomUnitsRevision: 1 }],
    pricing: {
      pricingCurrencyRevision: 1,
      flexibleRatePlans: flexibleRatePlanRevision
        ? [{ roomTypeId: property.roomTypeId, flexibleRatePlanRevision }]
        : [],
      optionalPricingAggregateRevision: 0,
    },
  });
}

function orderedUuid(order: number): string {
  return `${order.toString(16).padStart(8, "0")}-0000-4000-8000-${randomUUID().replaceAll("-", "").slice(-12)}`;
}

function context() {
  return {
    now,
    workerId: "vay-1435-test",
    correlationId: "vay-1435-test",
  };
}

function assertSafeTestDatabase(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to use non-test database "${databaseName}"`);
  }
}
