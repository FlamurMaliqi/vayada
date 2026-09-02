import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  isPmsCalendarAutoOpenConfiguration,
  type PmsCalendarAutoOpenSetting,
  type PmsCalendarAutoOpenSettingsPort,
  type PmsCalendarAutoOpenUpdateResult,
  type UpdatePmsCalendarAutoOpenSetting,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  release(): void;
};
type Pool = Pick<Client, "query"> & { connect(): Promise<Client>; end(): Promise<void> };
type Row = QueryResultRow & {
  propertyId: string;
  propertyTimeZone: string | null;
  configured: boolean;
  revision: number;
  enabled: boolean;
  mode: "rolling" | "fixed";
  rollingMonths: 12 | 18 | 24 | null;
  fixedEndMonth: string | null;
  updatedAt: Date | string | null;
};

export function createPgPmsCalendarAutoOpenSettingsRepository(config: {
  connectionString?: string;
  max?: number;
  pool?: Pool;
  now?: () => Date;
}): PmsCalendarAutoOpenSettingsPort & { close(): Promise<void> } {
  const ownsPool = !config.pool;
  if (ownsPool && !config.connectionString?.trim())
    throw new Error("PMS calendar auto-open settings connectionString must not be empty");
  const pool: Pool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as unknown as Pool);
  const now = config.now ?? (() => new Date());

  return {
    async find(propertyId) {
      const row = (await read(pool, propertyId, false)).rows[0];
      return row ? setting(row) : null;
    },
    async update(command) {
      if (!validCommand(command)) return failure({ code: "invalid_setting" });
      const acceptedAt = now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = (await read(client, command.propertyId, true)).rows[0];
        if (!current) return await rollback(client, failure({ code: "property_not_found" }));
        if (current.revision !== command.expectedRevision)
          return await rollback(
            client,
            failure({
              code: "calendar_auto_open_revision_conflict",
              currentRevision: current.revision,
            }),
          );
        const fixedMonthError = validateSelectedFixedMonth(current, command, acceptedAt);
        if (fixedMonthError) return await rollback(client, failure(fixedMonthError));
        if (sameConfiguration(current, command)) {
          await client.query("COMMIT");
          return { ok: true, outcome: "unchanged", setting: setting(current) };
        }
        const next = (
          await client.query<Row>(
            `INSERT INTO pms.calendar_auto_open_settings (
               property_id, revision, enabled, mode, rolling_months, fixed_end_month, updated_at
             ) VALUES ($1::uuid, 1, $2, $3, $4, ($5::text || '-01')::date, $7::timestamptz)
             ON CONFLICT (property_id) DO UPDATE SET
               revision = calendar_auto_open_settings.revision + 1,
               enabled = EXCLUDED.enabled, mode = EXCLUDED.mode,
               rolling_months = EXCLUDED.rolling_months,
               fixed_end_month = EXCLUDED.fixed_end_month, updated_at = EXCLUDED.updated_at
             WHERE calendar_auto_open_settings.revision = $6
             RETURNING property_id::text AS "propertyId", TRUE AS configured, revision, enabled,
               mode, rolling_months AS "rollingMonths",
               to_char(fixed_end_month, 'YYYY-MM') AS "fixedEndMonth", updated_at AS "updatedAt"`,
            [
              command.propertyId,
              command.enabled,
              command.mode,
              command.rollingMonths,
              command.fixedEndMonth,
              command.expectedRevision,
              acceptedAt.toISOString(),
            ],
          )
        ).rows[0];
        if (!next)
          return await rollback(
            client,
            failure({
              code: "calendar_auto_open_revision_conflict",
              currentRevision: current.revision,
            }),
          );
        await client.query("COMMIT");
        return {
          ok: true,
          outcome: current.configured ? "updated" : "created",
          setting: setting(next),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function read(client: Pick<Client, "query">, propertyId: string, lock: boolean) {
  if (lock)
    await client.query(
      `SELECT property.id FROM hotel_catalog.properties property
       WHERE property.id = $1::uuid FOR UPDATE OF property`,
      [propertyId],
    );
  return client.query<Row>(
    `SELECT property.id::text AS "propertyId", location.timezone AS "propertyTimeZone",
       settings.property_id IS NOT NULL AS configured,
       COALESCE(settings.revision, 0) AS revision, COALESCE(settings.enabled, FALSE) AS enabled,
       COALESCE(settings.mode, 'rolling') AS mode,
       CASE WHEN settings.property_id IS NULL THEN 18 ELSE settings.rolling_months END AS "rollingMonths",
       to_char(settings.fixed_end_month, 'YYYY-MM') AS "fixedEndMonth",
       settings.updated_at AS "updatedAt"
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN pms.calendar_auto_open_settings settings ON settings.property_id = property.id
     WHERE property.id = $1::uuid`,
    [propertyId],
  );
}

function validCommand(command: UpdatePmsCalendarAutoOpenSetting): boolean {
  return (
    Number.isSafeInteger(command.expectedRevision) &&
    command.expectedRevision >= 0 &&
    command.expectedRevision < 2_147_483_647 &&
    isPmsCalendarAutoOpenConfiguration(command)
  );
}

function sameConfiguration(row: Row, command: UpdatePmsCalendarAutoOpenSetting): boolean {
  return (
    row.enabled === command.enabled &&
    row.mode === command.mode &&
    row.rollingMonths === command.rollingMonths &&
    row.fixedEndMonth === command.fixedEndMonth
  );
}

function validateSelectedFixedMonth(
  current: Row,
  command: UpdatePmsCalendarAutoOpenSetting,
  acceptedAt: Date,
): Extract<PmsCalendarAutoOpenUpdateResult, { ok: false }>["error"] | null {
  if (
    command.mode !== "fixed" ||
    (current.configured &&
      current.mode === "fixed" &&
      current.fixedEndMonth === command.fixedEndMonth)
  )
    return null;
  const localMonth = propertyLocalMonth(acceptedAt, current.propertyTimeZone);
  if (!localMonth) return { code: "property_time_zone_invalid" };
  return command.fixedEndMonth! < localMonth ? { code: "invalid_setting" } : null;
}

function propertyLocalMonth(instant: Date, timeZone: string | null): string | null {
  try {
    if (!timeZone || !Number.isFinite(instant.valueOf())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value ?? "";
    const month = `${part("year")}-${part("month")}`;
    return /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month) ? month : null;
  } catch {
    return null;
  }
}

function setting(row: Row): PmsCalendarAutoOpenSetting {
  return Object.freeze({
    contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
    propertyId: row.propertyId,
    revision: row.revision,
    enabled: row.enabled,
    mode: row.mode,
    rollingMonths: row.rollingMonths,
    fixedEndMonth: row.fixedEndMonth,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  });
}

function failure(
  error: Extract<PmsCalendarAutoOpenUpdateResult, { ok: false }>["error"],
): PmsCalendarAutoOpenUpdateResult {
  return { ok: false, error };
}

async function rollback<Result>(client: Pick<Client, "query">, result: Result): Promise<Result> {
  await client.query("ROLLBACK");
  return result;
}
