import { createHash, randomUUID } from "node:crypto";

import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  calculatePmsCalendarAutoOpenHorizon,
  isPmsCalendarAutoOpenConfiguration,
  isPmsCalendarAutoOpenFixedTargetWithinLimit,
  isPmsCalendarAutoOpenSetting,
  type PmsCalendarAutoOpenSetting,
  type PmsCalendarAutoOpenSetupError,
  type PmsCalendarAutoOpenSettingsPort,
  type PmsCalendarAutoOpenWarning,
  type PmsCalendarAutoOpenUpdateResult,
  type UpdatePmsCalendarAutoOpenSetting,
} from "@vayada/domain-pms";
import pg, { type QueryResult, type QueryResultRow } from "pg";

const OPERATION = "calendar_auto_open_setting_update";
const RESOURCE_TYPE = "calendar_auto_open_setting";

type Client = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
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
  warnings?: unknown;
};
type IdempotencyRow = QueryResultRow & {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  responseResourceProduct: string | null;
  responseResourceType: string | null;
  responseResourceId: string | null;
  metadata: unknown;
  expiresAt: Date | string;
};

export function createPgPmsCalendarAutoOpenSettingsRepository(config: {
  connectionString?: string;
  max?: number;
  pool?: Pool;
  now?: () => Date;
  randomId?: () => string;
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
  const makeId = config.randomId ?? randomUUID;

  return {
    async find(propertyId) {
      const row = (await read(pool, propertyId, false)).rows[0];
      return row ? setting(row) : null;
    },
    async findContext(propertyId) {
      const row = (await read(pool, propertyId, false)).rows[0];
      if (!row) return null;
      const current = setting(row);
      if (!validTimeZone(row.propertyTimeZone, current))
        throw new Error("PMS calendar auto-open property timezone is invalid");
      return {
        setting: current,
        propertyTimeZone: row.propertyTimeZone!,
        warnings: parseWarnings(row.warnings),
        setupError: current.enabled ? await readSetupError(pool, propertyId) : null,
      };
    },
    async update(command) {
      if (!validCommand(command)) return failure({ code: "invalid_setting" });
      const acceptedAt = now();
      if (!Number.isFinite(acceptedAt.valueOf()))
        throw new Error("Calendar auto-open clock is invalid");
      const keyHash = sha256(command.idempotencyKey);
      const fingerprint = commandFingerprint(command);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = (await read(client, command.propertyId, true)).rows[0];
        if (!current) return rollback(client, failure({ code: "property_not_found" }));
        const replay = await findReplay(
          client,
          command.propertyId,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (replay) return rollback(client, replay);
        const currentSetting = setting(current);
        if (!validTimeZone(current.propertyTimeZone, currentSetting))
          return rollback(client, failure({ code: "property_time_zone_invalid" }));
        if (current.revision !== command.expectedRevision)
          return rollback(
            client,
            failure({
              code: "calendar_auto_open_revision_conflict",
              currentRevision: current.revision,
            }),
          );
        const setupError = command.enabled
          ? await readSetupError(client, command.propertyId)
          : null;
        if (setupError) return rollback(client, failure(setupError));
        const fixedMonthError = validateSelectedFixedMonth(current, command, acceptedAt);
        if (fixedMonthError) return rollback(client, failure(fixedMonthError));
        const reservationId = await reserveIdempotency(
          client,
          command,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (!reservationId) return rollback(client, failure({ code: "command_in_progress" }));

        if (sameConfiguration(current, command)) {
          const result = success(
            "unchanged",
            currentSetting,
            current.propertyTimeZone!,
            acceptedAt,
            null,
          );
          await completeIdempotency(client, reservationId, result, acceptedAt);
          await client.query("COMMIT");
          return result;
        }

        const next = await persistSetting(client, current, command, acceptedAt);
        const saved = setting(next);
        const eventId = makeId();
        await insertChangedEvent(client, command, saved, eventId, keyHash, acceptedAt);
        const enqueueIntentId = shouldEnqueue(saved, next.propertyTimeZone!, acceptedAt)
          ? makeId()
          : null;
        if (enqueueIntentId)
          await insertEnqueueIntent(
            client,
            command,
            saved,
            eventId,
            enqueueIntentId,
            keyHash,
            acceptedAt,
          );
        const result = success(
          current.configured ? "updated" : "created",
          saved,
          next.propertyTimeZone!,
          acceptedAt,
          enqueueIntentId,
        );
        await insertAudit(
          client,
          command,
          currentSetting,
          saved,
          eventId,
          reservationId,
          enqueueIntentId,
          acceptedAt,
        );
        await completeIdempotency(client, reservationId, result, acceptedAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackQuietly(client);
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
       settings.updated_at AS "updatedAt", COALESCE(application.warnings, '[]'::jsonb) AS warnings
     FROM hotel_catalog.properties property
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN pms.calendar_auto_open_settings settings ON settings.property_id = property.id
     LEFT JOIN LATERAL (
       SELECT job.job_metadata #> '{calendarAutoOpenResult,warnings}' AS warnings
       FROM platform.jobs job
       WHERE job.property_id = property.id
         AND job.queue_name = 'pms.inventory.scheduler'
         AND job.job_type = 'pms.calendar-auto-open'
         AND job.status = 'succeeded'
         AND job.resource_product = 'pms'
         AND job.resource_type = 'property'
         AND job.resource_id = property.id::text
         AND job.payload #>> '{source,settingRevision}' = COALESCE(settings.revision, 0)::text
         AND jsonb_typeof(job.job_metadata #> '{calendarAutoOpenResult,warnings}') = 'array'
       ORDER BY job.finished_at DESC, job.created_at DESC, job.id DESC
       LIMIT 1
     ) application ON TRUE
     WHERE property.id = $1::uuid`,
    [propertyId],
  );
}

async function readSetupError(
  client: Pick<Client, "query">,
  propertyId: string,
): Promise<PmsCalendarAutoOpenSetupError | null> {
  const row = (
    await client.query<{
      calendarRevision: number | string | null;
      roomBindingsStale: boolean;
      labelsUnverified: boolean;
    }>(
      `WITH current_calendar AS (
         SELECT calendar_revision
         FROM pms.operating_calendar_revisions
         WHERE property_id=$1::uuid
         ORDER BY calendar_revision DESC
         LIMIT 1
       )
       SELECT
         (SELECT calendar_revision FROM current_calendar) AS "calendarRevision",
         EXISTS (
           SELECT 1
           FROM pms.room_types room
           LEFT JOIN pms.operating_calendar_room_bindings binding
             ON binding.property_id=room.property_id
            AND binding.room_type_id=room.id
            AND binding.calendar_revision=(SELECT calendar_revision FROM current_calendar)
           WHERE room.property_id=$1::uuid AND room.active IS TRUE
             AND (binding.room_type_id IS NULL
               OR binding.source_room_facts_revision IS DISTINCT FROM room.room_facts_revision
               OR binding.source_room_units_revision IS DISTINCT FROM room.room_units_revision)
         ) OR EXISTS (
           SELECT 1
           FROM pms.operating_calendar_room_bindings binding
           LEFT JOIN pms.room_types room
             ON room.property_id=binding.property_id
            AND room.id=binding.room_type_id
            AND room.active IS TRUE
           WHERE binding.property_id=$1::uuid
             AND binding.calendar_revision=(SELECT calendar_revision FROM current_calendar)
             AND room.id IS NULL
         ) AS "roomBindingsStale",
         EXISTS (
           SELECT 1 FROM pms.rooms room
           JOIN pms.room_types room_type
             ON room_type.property_id=room.property_id AND room_type.id=room.room_type_id
           WHERE room.property_id=$1::uuid AND room_type.active IS TRUE
             AND room.status<>'retired' AND room.operational_label_status<>'verified'
         ) AS "labelsUnverified"`,
      [propertyId],
    )
  ).rows[0];
  if (!row || row.calendarRevision === null) {
    return { code: "operating_calendar_not_configured" };
  }
  if (row.labelsUnverified) return { code: "physical_room_labels_unverified" };
  return row.roomBindingsStale ? { code: "operating_calendar_room_bindings_stale" } : null;
}

async function findReplay(
  client: Client,
  propertyId: string,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<PmsCalendarAutoOpenUpdateResult | null> {
  const existing = (
    await client.query<IdempotencyRow>(
      `SELECT id::text AS id, status,
              request_fingerprint_hash AS "requestFingerprintHash",
              response_status_code AS "responseStatusCode",
              response_body_hash AS "responseBodyHash",
              response_resource_product AS "responseResourceProduct",
              response_resource_type AS "responseResourceType",
              response_resource_id AS "responseResourceId",
              idempotency_metadata AS metadata, expires_at AS "expiresAt"
       FROM platform.idempotency_keys
       WHERE operation_scope = 'pms' AND operation = $1 AND key_hash = $2
         AND tenant_scope = 'property' AND organization_id IS NULL AND property_id = $3::uuid
       FOR UPDATE`,
      [OPERATION, keyHash, propertyId],
    )
  ).rows[0];
  if (!existing || new Date(existing.expiresAt) <= at) return null;
  if (existing.requestFingerprintHash !== fingerprint)
    return failure({ code: "idempotency_key_conflict" });
  if (existing.status !== "completed") return failure({ code: "command_in_progress" });
  const stored = isRecord(existing.metadata) ? parseSuccess(existing.metadata["result"]) : null;
  return stored &&
    stored.setting.propertyId === propertyId &&
    existing.responseStatusCode === responseStatus(stored) &&
    existing.responseBodyHash === sha256(JSON.stringify(stored)) &&
    existing.responseResourceProduct === "pms" &&
    existing.responseResourceType === RESOURCE_TYPE &&
    existing.responseResourceId === propertyId
    ? stored
    : failure({ code: "idempotency_key_conflict" });
}

async function reserveIdempotency(
  client: Client,
  command: UpdatePmsCalendarAutoOpenSetting,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, property_id, correlation_id,
       first_seen_at, last_seen_at, locked_until, expires_at, idempotency_metadata
     ) VALUES (
       'pms', $1, $2, $3, 'in_progress', 'property', NULL, $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '15 minutes',
       $6::timestamptz + interval '24 hours', jsonb_build_object('requestId', $7::text)
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET request_fingerprint_hash = EXCLUDED.request_fingerprint_hash,
       status = 'in_progress', response_status_code = NULL, response_body_hash = NULL,
       response_resource_product = NULL, response_resource_type = NULL,
       response_resource_id = NULL, correlation_id = EXCLUDED.correlation_id,
       first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at,
       locked_until = EXCLUDED.locked_until, completed_at = NULL, expires_at = EXCLUDED.expires_at,
       idempotency_metadata = EXCLUDED.idempotency_metadata
     WHERE platform.idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text AS id`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      at.toISOString(),
      command.audit.requestId,
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function persistSetting(
  client: Client,
  current: Row,
  command: UpdatePmsCalendarAutoOpenSetting,
  at: Date,
): Promise<Row> {
  const result = await client.query<Row>(
    `INSERT INTO pms.calendar_auto_open_settings (
       property_id, revision, enabled, mode, rolling_months, fixed_end_month, updated_at
     ) VALUES ($1::uuid, 1, $2, $3, $4, ($5::text || '-01')::date, $7::timestamptz)
     ON CONFLICT (property_id) DO UPDATE SET
       revision = calendar_auto_open_settings.revision + 1,
       enabled = EXCLUDED.enabled, mode = EXCLUDED.mode,
       rolling_months = EXCLUDED.rolling_months,
       fixed_end_month = EXCLUDED.fixed_end_month, updated_at = EXCLUDED.updated_at
     WHERE calendar_auto_open_settings.revision = $6
     RETURNING property_id::text AS "propertyId", $8::text AS "propertyTimeZone",
       TRUE AS configured, revision, enabled, mode, rolling_months AS "rollingMonths",
       to_char(fixed_end_month, 'YYYY-MM') AS "fixedEndMonth", updated_at AS "updatedAt"`,
    [
      command.propertyId,
      command.enabled,
      command.mode,
      command.rollingMonths,
      command.fixedEndMonth,
      command.expectedRevision,
      at.toISOString(),
      current.propertyTimeZone,
    ],
  );
  const saved = result.rows[0];
  if (!saved) throw new Error("PMS calendar auto-open expected-revision write failed");
  return saved;
}

async function insertChangedEvent(
  client: Client,
  command: UpdatePmsCalendarAutoOpenSetting,
  saved: PmsCalendarAutoOpenSetting,
  eventId: string,
  keyHash: string,
  at: Date,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO platform.domain_events (
       id, source_system, event_key, event_type, event_version, occurred_at,
       tenant_scope, organization_id, property_id, resource_product, resource_type,
       resource_id, actor_type, actor_user_id, correlation_id, causation_id,
       idempotency_key_hash, payload, event_metadata, privacy_scope
     ) VALUES (
       $1::uuid, 'pms', $2, 'pms.calendar_auto_open.setting_changed', 1, $3::timestamptz,
       'property', NULL, $4::uuid, 'pms', $5, $4::uuid::text, 'user', $6::uuid,
       $7, $8, $9, $10::jsonb, $11::jsonb, 'internal'
     )`,
    [
      eventId,
      settingEventKey(command.propertyId, saved.revision),
      at.toISOString(),
      command.propertyId,
      RESOURCE_TYPE,
      command.audit.actorUserId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      keyHash,
      JSON.stringify({
        propertyId: command.propertyId,
        revision: saved.revision,
        enabled: saved.enabled,
        mode: saved.mode,
      }),
      JSON.stringify({ contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION }),
    ],
  );
  if (result.rowCount !== 1) throw new Error("Calendar auto-open event insert failed");
}

async function insertEnqueueIntent(
  client: Client,
  command: UpdatePmsCalendarAutoOpenSetting,
  saved: PmsCalendarAutoOpenSetting,
  eventId: string,
  outboxId: string,
  keyHash: string,
  at: Date,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO platform.outbox_events (
       id, domain_event_id, outbox_key, destination, event_type,
       tenant_scope, organization_id, property_id, resource_product, resource_type,
       resource_id, correlation_id, idempotency_key_hash, payload, outbox_metadata,
       available_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'pms.inventory.scheduler',
       'pms.calendar_auto_open.evaluation_requested', 'property', NULL, $4::uuid,
       'pms', $5, $4::uuid::text, $6, $7, $8::jsonb, $9::jsonb,
       $10::timestamptz, $10::timestamptz, $10::timestamptz
     )`,
    [
      outboxId,
      eventId,
      `${settingEventKey(command.propertyId, saved.revision)}:evaluation:v1`,
      command.propertyId,
      RESOURCE_TYPE,
      command.audit.correlationId ?? command.audit.requestId,
      keyHash,
      JSON.stringify({ propertyId: command.propertyId, settingRevision: saved.revision }),
      JSON.stringify({
        contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
        source: "setting_change",
      }),
      at.toISOString(),
    ],
  );
  if (result.rowCount !== 1) throw new Error("Calendar auto-open enqueue intent insert failed");
}

async function insertAudit(
  client: Client,
  command: UpdatePmsCalendarAutoOpenSetting,
  previous: PmsCalendarAutoOpenSetting,
  next: PmsCalendarAutoOpenSetting,
  eventId: string,
  idempotencyId: string,
  enqueueIntentId: string | null,
  at: Date,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, domain_event_id, idempotency_key_id, correlation_id,
       causation_id, redacted_payload, audit_metadata, privacy_scope
     ) VALUES (
       $1, 'pms', 'pms.calendar_auto_open.setting_changed', $2::timestamptz,
       'property', NULL, $3::uuid, 'user', $4::uuid, 'pms', $5, $3::uuid::text,
       $6::uuid, $7::uuid, $8, $9, $10::jsonb, $11::jsonb, 'internal'
     )`,
    [
      `pms.calendar-auto-open.setting:${command.propertyId}:revision-${next.revision}:v1`,
      at.toISOString(),
      command.propertyId,
      command.audit.actorUserId,
      RESOURCE_TYPE,
      eventId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify({ previous: auditSetting(previous), next: auditSetting(next) }),
      JSON.stringify({
        contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
        enqueueIntentId,
      }),
    ],
  );
  if (result.rowCount !== 1) throw new Error("Calendar auto-open audit insert failed");
}

async function completeIdempotency(
  client: Client,
  id: string,
  result: Extract<PmsCalendarAutoOpenUpdateResult, { ok: true }>,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2, response_body_hash = $3,
         response_resource_product = 'pms', response_resource_type = $4,
         response_resource_id = $5, completed_at = $6::timestamptz,
         last_seen_at = $6::timestamptz, locked_until = NULL,
         idempotency_metadata = idempotency_metadata || jsonb_build_object('result', $7::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      responseStatus(result),
      sha256(JSON.stringify(result)),
      RESOURCE_TYPE,
      result.setting.propertyId,
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("Calendar auto-open idempotency completion failed");
}

function validCommand(command: UpdatePmsCalendarAutoOpenSetting): boolean {
  return (
    Number.isSafeInteger(command.expectedRevision) &&
    command.expectedRevision >= 0 &&
    command.expectedRevision < 2_147_483_647 &&
    command.idempotencyKey === command.idempotencyKey.trim() &&
    command.idempotencyKey.length >= 1 &&
    command.idempotencyKey.length <= 200 &&
    command.propertyId.length > 0 &&
    command.audit.actorUserId.length > 0 &&
    command.audit.requestId.length > 0 &&
    Number.isFinite(Date.parse(command.audit.requestedAt)) &&
    isPmsCalendarAutoOpenConfiguration(command)
  );
}

function commandFingerprint(command: UpdatePmsCalendarAutoOpenSetting): string {
  return sha256(
    JSON.stringify({
      propertyId: command.propertyId,
      expectedRevision: command.expectedRevision,
      enabled: command.enabled,
      mode: command.mode,
      rollingMonths: command.rollingMonths,
      fixedEndMonth: command.fixedEndMonth,
    }),
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
  if (command.mode !== "fixed") return null;
  const localMonth = propertyLocalMonth(acceptedAt, current.propertyTimeZone);
  if (!localMonth) return { code: "property_time_zone_invalid" };
  const preservesSelectedMonth =
    current.configured &&
    current.mode === "fixed" &&
    current.fixedEndMonth === command.fixedEndMonth;
  if (preservesSelectedMonth && (command.fixedEndMonth! < localMonth || !command.enabled)) {
    return null;
  }
  return command.fixedEndMonth! < localMonth ||
    !isPmsCalendarAutoOpenFixedTargetWithinLimit(command, current.propertyTimeZone!, acceptedAt)
    ? { code: "invalid_setting" }
    : null;
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
    revision: Number(row.revision),
    enabled: row.enabled,
    mode: row.mode,
    rollingMonths: row.rollingMonths,
    fixedEndMonth: row.fixedEndMonth,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  });
}

function parseWarnings(value: unknown): readonly PmsCalendarAutoOpenWarning[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.flatMap((candidate) => {
      const roomTypeId = isRecord(candidate) ? candidate["roomTypeId"] : null;
      const from = isRecord(candidate) ? candidate["from"] : null;
      const through = isRecord(candidate) ? candidate["through"] : null;
      if (
        !isRecord(candidate) ||
        candidate["code"] !== "missing_rate" ||
        !isUuid(roomTypeId) ||
        !isDateOnly(from) ||
        !isDateOnly(through) ||
        from > through
      )
        return [];
      return [
        {
          code: "missing_rate" as const,
          roomTypeId,
          from,
          through,
        },
      ];
    }),
  );
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function success(
  outcome: "created" | "updated" | "unchanged",
  value: PmsCalendarAutoOpenSetting,
  propertyTimeZone: string,
  at: Date,
  enqueueIntentId: string | null,
): Extract<PmsCalendarAutoOpenUpdateResult, { ok: true }> {
  return {
    ok: true,
    outcome,
    setting: value,
    propertyTimeZone,
    evaluatedAt: at.toISOString(),
    enqueueIntentId,
  };
}

function parseSuccess(
  value: unknown,
): Extract<PmsCalendarAutoOpenUpdateResult, { ok: true }> | null {
  if (!isRecord(value) || value["ok"] !== true || !isPmsCalendarAutoOpenSetting(value["setting"]))
    return null;
  const storedSetting = value["setting"];
  const outcome = value["outcome"];
  const propertyTimeZone = value["propertyTimeZone"];
  const evaluatedAt = value["evaluatedAt"];
  const enqueueIntentId = value["enqueueIntentId"];
  if (
    (outcome !== "created" && outcome !== "updated" && outcome !== "unchanged") ||
    typeof propertyTimeZone !== "string" ||
    typeof evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(evaluatedAt)) ||
    (enqueueIntentId !== null && typeof enqueueIntentId !== "string") ||
    !validTimeZone(propertyTimeZone, value["setting"])
  )
    return null;
  return success(
    outcome,
    Object.freeze({
      contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
      propertyId: storedSetting.propertyId,
      revision: storedSetting.revision,
      enabled: storedSetting.enabled,
      mode: storedSetting.mode,
      rollingMonths: storedSetting.rollingMonths,
      fixedEndMonth: storedSetting.fixedEndMonth,
      updatedAt: storedSetting.updatedAt,
    }),
    propertyTimeZone,
    new Date(evaluatedAt),
    enqueueIntentId,
  );
}

function validTimeZone(
  timeZone: string | null,
  value: PmsCalendarAutoOpenSetting,
): timeZone is string {
  try {
    if (!timeZone) return false;
    calculatePmsCalendarAutoOpenHorizon(value, timeZone, new Date(0));
    return true;
  } catch {
    return false;
  }
}

function shouldEnqueue(value: PmsCalendarAutoOpenSetting, timeZone: string, at: Date): boolean {
  const horizon = calculatePmsCalendarAutoOpenHorizon(value, timeZone, at);
  return Boolean(
    value.enabled &&
    horizon.targetOpenThrough &&
    horizon.targetOpenThrough >= horizon.propertyLocalDate,
  );
}

function auditSetting(value: PmsCalendarAutoOpenSetting) {
  return {
    revision: value.revision,
    enabled: value.enabled,
    mode: value.mode,
    rollingMonths: value.rollingMonths,
    fixedEndMonth: value.fixedEndMonth,
  };
}

function settingEventKey(propertyId: string, revision: number): string {
  return `pms.calendar-auto-open.setting:${propertyId}:revision-${revision}:v1`;
}

function responseStatus(result: Extract<PmsCalendarAutoOpenUpdateResult, { ok: true }>): number {
  return result.outcome === "created" ? 201 : 200;
}

function failure(
  error: Extract<PmsCalendarAutoOpenUpdateResult, { ok: false }>["error"],
): PmsCalendarAutoOpenUpdateResult {
  return { ok: false, error };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function rollback<Result>(client: Pick<Client, "query">, result: Result): Promise<Result> {
  await client.query("ROLLBACK");
  return result;
}

async function rollbackQuietly(client: Pick<Client, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the command failure.
  }
}
