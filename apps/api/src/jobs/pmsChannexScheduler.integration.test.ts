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

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const now = new Date("2026-09-03T10:00:00.000Z");

describe.skipIf(!TEST_DATABASE_URL)("PMS calendar auto-open candidate selection", () => {
  const admin = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const store = createPgPmsChannexSchedulerStore({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    max: 1,
  });

  beforeAll(() => assertSafeTestDatabase(TEST_DATABASE_URL!));
  afterAll(async () => Promise.all([admin.end(), store.close()]));

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
      fixedEndMonth: "2028-12-01",
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

    const nextPage = await store.findCalendarAutoOpenCandidates(now, 1);
    expect(nextPage.candidates.map(({ propertyId }) => propertyId)).toEqual([second.propertyId]);
    const secondSourceFingerprint = nextPage.candidates[0]!.sourceFingerprint;
    const secondEnqueue = await store.enqueueCalendarAutoOpenJob(
      nextPage.candidates[0]!,
      context(),
    );
    expect(secondEnqueue).toMatchObject({
      createdNewJob: true,
      eventKey: `pms.calendar-auto-open:${second.propertyId}:2028-12-31:source-${secondSourceFingerprint}:v2`,
      jobKey: `pms.calendar-auto-open:property:${second.propertyId}:open-through-2028-12-31:source-${secondSourceFingerprint}:v2`,
    });

    await admin.query("UPDATE pms.room_types SET room_facts_revision = 2 WHERE id = $1::uuid", [
      second.roomTypeId,
    ]);
    const changedSource = await store.findCalendarAutoOpenCandidates(now, 2);
    expect(changedSource.candidates).toHaveLength(2);
    expect(changedSource.candidates[0]).toMatchObject({
      propertyId: second.propertyId,
      openThrough: "2028-12-31",
      generatedCoverageThrough: null,
      source: { rooms: [{ roomFactsRevision: 2 }] },
    });
    expect(changedSource.candidates[0]!.sourceFingerprint).not.toBe(secondSourceFingerprint);
    expect(changedSource.candidates[1]).toMatchObject({
      propertyId: sparse.propertyId,
      generatedCoverageThrough: null,
    });

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
      status: "pending",
      sourceFingerprint: secondSourceFingerprint,
      events: 1,
      audits: 0,
      channexConnections: 0,
    });
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
       (property_id, room_type_id, stay_date, total_count, available_count)
     VALUES ($1::uuid, $2::uuid, $3::date, 2, 2)`,
    [property.propertyId, property.roomTypeId, stayDate],
  );
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
  return fingerprintPmsCalendarAutoOpenSource(
    createPmsCalendarAutoOpenSource({
      settingRevision: 1,
      propertyProfileRevision: 1,
      propertyTimeZone: "Europe/Berlin",
      operatingCalendarRevision: 1,
      rooms: [{ roomTypeId: property.roomTypeId, roomFactsRevision: 1, roomUnitsRevision: 1 }],
      pricing: {
        pricingCurrencyRevision: 1,
        flexibleRatePlans: [],
        optionalPricingAggregateRevision: 0,
      },
    }),
  );
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
