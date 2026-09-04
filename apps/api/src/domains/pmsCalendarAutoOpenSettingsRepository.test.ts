import type { UpdatePmsCalendarAutoOpenSetting } from "@vayada/domain-pms";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsCalendarAutoOpenSettingsRepository } from "./pmsCalendarAutoOpenSettingsRepository.js";

const propertyId = "14330000-0000-4000-8000-000000000001";
const virtual = row({ configured: false, revision: 0 });

describe("PMS calendar auto-open settings repository", () => {
  it("reads the virtual disabled default without inserting", async () => {
    const pool = new TestPool([virtual]);
    const repository = createPgPmsCalendarAutoOpenSettingsRepository({ pool });
    await expect(repository.find(propertyId)).resolves.toMatchObject({
      revision: 0,
      enabled: false,
      mode: "rolling",
      rollingMonths: 18,
      fixedEndMonth: null,
      updatedAt: null,
    });
    expect(pool.sql).toHaveLength(1);
  });

  it("reads typed warnings from the latest canonical application result", async () => {
    const warning = {
      code: "missing_rate",
      roomTypeId: "14330000-0000-4000-8000-000000000004",
      from: "2027-01-01",
      through: "2027-01-31",
    };
    const pool = new TestPool([
      {
        ...virtual,
        warnings: [
          warning,
          { ...warning, roomTypeId: "" },
          { ...warning, from: "2027-99-01" },
          { ...warning, from: "2027-02-01", through: "2027-01-31" },
          { code: "unknown" },
        ],
      },
    ]);
    const repository = createPgPmsCalendarAutoOpenSettingsRepository({ pool });

    await expect(repository.findContext(propertyId)).resolves.toMatchObject({
      warnings: [warning],
    });
    expect(pool.sql[0]).toContain("calendarAutoOpenResult,warnings");
    expect(pool.sql[0]).toContain("source,settingRevision");
  });

  it("creates rolling revision one and updates fixed revision two", async () => {
    const rolling = row({ configured: true, revision: 1, enabled: true, rollingMonths: 24 });
    const createPool = new TestPool([virtual], [rolling]);
    const creator = createPgPmsCalendarAutoOpenSettingsRepository({ pool: createPool });
    await expect(creator.update(command({ rollingMonths: 24 }))).resolves.toMatchObject({
      ok: true,
      outcome: "created",
      setting: { revision: 1 },
    });
    expect(createPool.sql.join("\n")).toContain("FOR UPDATE OF property");
    expect(createPool.sql.join("\n")).toContain("calendar_auto_open_settings.revision = $6");
    expect(createPool.sql.join("\n")).toContain("pms.calendar_auto_open.setting_changed");
    expect(createPool.sql.join("\n")).toContain("pms.inventory.scheduler");
    expect(createPool.sql.join("\n")).toContain("platform.product_audit_events");

    const fixed = row({
      configured: true,
      revision: 2,
      enabled: true,
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2028-06",
    });
    const updater = createPgPmsCalendarAutoOpenSettingsRepository({
      pool: new TestPool([rolling], [fixed]),
      now: () => new Date("2026-09-03T08:00:00.000Z"),
    });
    await expect(
      updater.update(
        command({
          expectedRevision: 1,
          mode: "fixed",
          rollingMonths: null,
          fixedEndMonth: "2028-06",
        }),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "updated", setting: { revision: 2 } });
  });

  it("rejects invalid values and stale revisions without writing", async () => {
    const invalidPool = new TestPool([]);
    const invalid = createPgPmsCalendarAutoOpenSettingsRepository({ pool: invalidPool });
    await expect(invalid.update(command({ fixedEndMonth: "2028-06" }))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_setting" },
    });
    expect(invalidPool.sql).toEqual([]);

    const stalePool = new TestPool([row({ configured: true, revision: 3 })]);
    const stale = createPgPmsCalendarAutoOpenSettingsRepository({ pool: stalePool });
    await expect(stale.update(command({ expectedRevision: 2 }))).resolves.toEqual({
      ok: false,
      error: { code: "calendar_auto_open_revision_conflict", currentRevision: 3 },
    });
    expect(stalePool.sql.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
    expect(stalePool.sql.at(-1)).toBe("ROLLBACK");
  });

  it("uses the property-local month but preserves a stored historical fixed month", async () => {
    const now = () => new Date("2026-08-31T16:30:00.000Z");
    const pastPool = new TestPool([virtual]);
    const repository = createPgPmsCalendarAutoOpenSettingsRepository({ pool: pastPool, now });
    await expect(
      repository.update(command({ mode: "fixed", rollingMonths: null, fixedEndMonth: "2026-08" })),
    ).resolves.toEqual({ ok: false, error: { code: "invalid_setting" } });

    const tooFar = createPgPmsCalendarAutoOpenSettingsRepository({
      pool: new TestPool([virtual]),
      now,
    });
    await expect(
      tooFar.update(command({ mode: "fixed", rollingMonths: null, fixedEndMonth: "2028-10" })),
    ).resolves.toEqual({ ok: false, error: { code: "invalid_setting" } });

    const missingZone = createPgPmsCalendarAutoOpenSettingsRepository({
      pool: new TestPool([{ ...virtual, propertyTimeZone: null }]),
      now,
    });
    await expect(
      missingZone.update(command({ mode: "fixed", rollingMonths: null, fixedEndMonth: "2027-08" })),
    ).resolves.toEqual({ ok: false, error: { code: "property_time_zone_invalid" } });

    const existingFar = row({
      configured: true,
      revision: 6,
      enabled: true,
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2029-01",
    });
    const disabledFar = { ...existingFar, revision: 7, enabled: false };
    const disableFar = createPgPmsCalendarAutoOpenSettingsRepository({
      pool: new TestPool([existingFar], [disabledFar]),
      now,
    });
    await expect(
      disableFar.update(
        command({
          expectedRevision: 6,
          enabled: false,
          mode: "fixed",
          rollingMonths: null,
          fixedEndMonth: "2029-01",
        }),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "updated", setting: { revision: 7 } });
    const reenableFar = createPgPmsCalendarAutoOpenSettingsRepository({
      pool: new TestPool([disabledFar]),
      now,
    });
    await expect(
      reenableFar.update(
        command({
          expectedRevision: 7,
          enabled: true,
          mode: "fixed",
          rollingMonths: null,
          fixedEndMonth: "2029-01",
        }),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "invalid_setting" } });

    const historical = row({
      configured: true,
      revision: 4,
      enabled: true,
      mode: "fixed",
      rollingMonths: null,
      fixedEndMonth: "2026-08",
    });
    const disabled = { ...historical, revision: 5, enabled: false };
    const preservedPool = new TestPool([historical], [disabled]);
    const preserved = createPgPmsCalendarAutoOpenSettingsRepository({
      pool: preservedPool,
      now,
    });
    await expect(
      preserved.update(
        command({
          expectedRevision: 4,
          enabled: false,
          mode: "fixed",
          rollingMonths: null,
          fixedEndMonth: "2026-08",
        }),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "updated", setting: { revision: 5 } });
    expect(preservedPool.sql.some((sql) => sql.includes("platform.outbox_events"))).toBe(false);

    const reenabled = { ...historical, revision: 6 };
    const expiredPool = new TestPool([disabled], [reenabled]);
    const expired = createPgPmsCalendarAutoOpenSettingsRepository({ pool: expiredPool, now });
    await expect(
      expired.update(
        command({
          expectedRevision: 5,
          enabled: true,
          mode: "fixed",
          rollingMonths: null,
          fixedEndMonth: "2026-08",
        }),
      ),
    ).resolves.toMatchObject({ ok: true, outcome: "updated", setting: { revision: 6 } });
    expect(expiredPool.sql.some((sql) => sql.includes("platform.outbox_events"))).toBe(false);
  });

  it("does not advance an exact current value", async () => {
    const pool = new TestPool([row({ configured: true, revision: 4 })]);
    const repository = createPgPmsCalendarAutoOpenSettingsRepository({ pool });
    await expect(
      repository.update(command({ expectedRevision: 4, enabled: false })),
    ).resolves.toMatchObject({ ok: true, outcome: "unchanged", setting: { revision: 4 } });
    expect(pool.sql.some((sql) => sql.includes("calendar_auto_open_settings ("))).toBe(false);
    expect(pool.sql.some((sql) => sql.includes("platform.domain_events"))).toBe(false);
    expect(pool.sql.some((sql) => sql.includes("platform.outbox_events"))).toBe(false);
    expect(pool.sql.some((sql) => sql.includes("platform.product_audit_events"))).toBe(false);
    expect(pool.sql.at(-1)).toBe("COMMIT");
  });
});

type Row = {
  propertyId: string;
  propertyTimeZone: string | null;
  configured: boolean;
  revision: number;
  enabled: boolean;
  mode: "rolling" | "fixed";
  rollingMonths: 12 | 18 | 24 | null;
  fixedEndMonth: string | null;
  updatedAt: string | null;
  warnings?: unknown;
};
function row(overrides: Partial<Row>): Row {
  return {
    propertyId,
    propertyTimeZone: "Asia/Taipei",
    configured: false,
    revision: 0,
    enabled: false,
    mode: "rolling",
    rollingMonths: 18,
    fixedEndMonth: null,
    updatedAt: null,
    ...overrides,
  };
}
function command(
  overrides: Partial<UpdatePmsCalendarAutoOpenSetting> = {},
): UpdatePmsCalendarAutoOpenSetting {
  return {
    propertyId,
    expectedRevision: 0,
    enabled: true,
    mode: "rolling",
    rollingMonths: 18,
    fixedEndMonth: null,
    idempotencyKey: "calendar-auto-open-key",
    audit: {
      actorUserId: "14330000-0000-4000-8000-000000000002",
      requestId: "request-1",
      correlationId: "correlation-1",
      requestedAt: "2026-09-03T08:00:00.000Z",
    },
    ...overrides,
  };
}
class TestPool {
  readonly sql: string[] = [];
  constructor(
    private readonly reads: Row[],
    private readonly writes: Row[] = [],
  ) {}
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
  async end() {}
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.sql.push(text);
    const rows = text.includes("FOR UPDATE OF property")
      ? [{ id: propertyId }]
      : text.includes("FROM hotel_catalog.properties")
        ? this.reads.splice(0, 1)
        : text.includes("FROM platform.idempotency_keys")
          ? []
          : text.includes("INSERT INTO platform.idempotency_keys")
            ? [{ id: "14330000-0000-4000-8000-000000000003" }]
            : text.includes("INSERT INTO pms.calendar_auto_open_settings")
              ? this.writes.splice(0, 1)
              : [];
    return {
      rows: rows as unknown as T[],
      rowCount: text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" ? 0 : 1,
    };
  }
}
