import pg from "pg";

export const DEFAULT_PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE = 100;
const MAX_TIMER_INTERVAL_MS = 2_147_483_647;

export type PropertySetupDraftRetentionPool = {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<{ id: string }> }>;
  end(): Promise<void>;
};

export type PropertySetupDraftRetentionStore = {
  deleteExpiredBatch(now: Date, limit: number): Promise<{ sessions: number; stepDrafts: number }>;
  close(): Promise<void>;
};

export function createPgPropertySetupDraftRetentionStore(config: {
  connectionString: string;
  max?: number;
  pool?: PropertySetupDraftRetentionPool;
}): PropertySetupDraftRetentionStore {
  if (!config.connectionString.trim()) {
    throw new Error("Property setup draft retention connectionString must not be empty");
  }
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async deleteExpiredBatch(now, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Property setup draft retention limit must be a positive integer");
      }
      const values: [string, number] = [now.toISOString(), limit];
      const expiredSessions = await pool.query(
        `WITH expired AS (
           SELECT id
             FROM hotel_catalog.property_setup_sessions
            WHERE retention_expires_at <= $1::timestamptz
            ORDER BY retention_expires_at ASC, id ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM hotel_catalog.property_setup_sessions AS session
          USING expired
          WHERE session.id = expired.id
         RETURNING session.id::text AS id`,
        values,
      );
      const expiredStepDrafts = await pool.query(
        `WITH expired AS (
           SELECT session_id, step_id
             FROM hotel_catalog.property_setup_step_drafts
            WHERE retention_expires_at <= $1::timestamptz
            ORDER BY retention_expires_at ASC, session_id ASC, step_id ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM hotel_catalog.property_setup_step_drafts AS draft
          USING expired
          WHERE draft.session_id = expired.session_id
            AND draft.step_id = expired.step_id
         RETURNING draft.session_id::text AS id`,
        values,
      );
      return {
        sessions: expiredSessions.rows.length,
        stepDrafts: expiredStepDrafts.rows.length,
      };
    },

    async close() {
      await pool.end();
    },
  };
}

type RetentionLogger = {
  warn(context: { err: unknown }, message: string): void;
};

export function startPropertySetupDraftRetentionWorker(options: {
  store: PropertySetupDraftRetentionStore;
  enabled: boolean;
  intervalMs: number;
  batchSize?: number;
  now?: () => Date;
  logger: RetentionLogger;
}): { runNow(): Promise<void>; close(): Promise<void> } {
  const batchSize = options.batchSize ?? DEFAULT_PROPERTY_SETUP_DRAFT_RETENTION_BATCH_SIZE;
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 1 ||
    options.intervalMs > MAX_TIMER_INTERVAL_MS
  ) {
    throw new Error(
      `Property setup draft retention interval must be between 1 and ${MAX_TIMER_INTERVAL_MS}`,
    );
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("Property setup draft retention batch size must be a positive integer");
  }

  const now = options.now ?? (() => new Date());
  let activeRun: Promise<void> | undefined;
  let closing = false;
  const runNow = (): Promise<void> => {
    if (closing) return Promise.resolve();
    if (activeRun) return activeRun;
    const cutoff = now();
    activeRun = drainExpiredDrafts(options.store, cutoff, batchSize, () => !closing)
      .then(() => undefined)
      .catch((error: unknown) => {
        options.logger.warn({ err: error }, "Property setup draft retention cleanup failed");
      })
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  };

  const timer = options.enabled ? setInterval(() => void runNow(), options.intervalMs) : undefined;
  timer?.unref();
  if (options.enabled) void runNow();

  return {
    runNow,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      await activeRun;
      await options.store.close();
    },
  };
}

async function drainExpiredDrafts(
  store: PropertySetupDraftRetentionStore,
  cutoff: Date,
  batchSize: number,
  shouldContinue: () => boolean,
): Promise<void> {
  while (true) {
    const deleted = await store.deleteExpiredBatch(cutoff, batchSize);
    if (!shouldContinue() || (deleted.sessions < batchSize && deleted.stepDrafts < batchSize)) {
      return;
    }
  }
}
