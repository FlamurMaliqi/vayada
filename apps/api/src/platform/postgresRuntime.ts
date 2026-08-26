import pg from "pg";

const GENERAL_POOL_MAX = 8;
const SPECIALIZED_POOL_MAX = 1;
const CONNECTION_TIMEOUT_MS = 3_000;
type PgModule = Pick<typeof pg, "Pool">;
type PoolEntry = { pool: pg.Pool; references: number; closed: boolean };
type OwnedListener = {
  event: string | symbol;
  original: (...arguments_: unknown[]) => void;
  wrapped: (...arguments_: unknown[]) => void;
};
type Logger = {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
};

export type PostgresPoolSnapshot = Readonly<{
  physicalPoolCount: number;
  maxConnections: number;
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
}>;

export function installPostgresPoolRuntime(postgres: PgModule = pg): {
  snapshot(): PostgresPoolSnapshot;
  startTelemetry(logger: Logger, intervalMs?: number): () => void;
  close(): Promise<void>;
} {
  const OriginalPool = postgres.Pool;
  const entries = new Map<string, PoolEntry>();
  let unsharedPool = 0;
  const SharedPool = new Proxy(OriginalPool, {
    construct(target, args) {
      const requested = (args[0] ?? {}) as pg.PoolConfig;
      const specialized = hasClientTuning(requested);
      const bounded = {
        ...requested,
        max: specialized ? SPECIALIZED_POOL_MAX : GENERAL_POOL_MAX,
        connectionTimeoutMillis: boundedTimeout(requested.connectionTimeoutMillis),
        idleTimeoutMillis: 30_000,
      };
      const key = Object.values(requested).some(
        (value) => value !== null && (typeof value === "object" || typeof value === "function"),
      )
        ? `unshared:${unsharedPool++}`
        : poolKey(bounded);
      let entry = entries.get(key);
      if (!entry) {
        const pool = Reflect.construct(target, [bounded]) as pg.Pool;
        entry = { pool, references: 0, closed: false };
        entries.set(key, entry);
      }
      entry.references += 1;
      return lease(entry, key, entries);
    },
  }) as typeof pg.Pool;
  Object.defineProperty(postgres, "Pool", {
    configurable: true,
    writable: true,
    value: SharedPool,
  });
  const snapshot = (): PostgresPoolSnapshot => {
    const pools = [...entries.values()].filter(({ closed }) => !closed).map(({ pool }) => pool);
    return {
      physicalPoolCount: pools.length,
      maxConnections: pools.reduce((sum, pool) => sum + pool.options.max, 0),
      totalConnections: pools.reduce((sum, pool) => sum + pool.totalCount, 0),
      idleConnections: pools.reduce((sum, pool) => sum + pool.idleCount, 0),
      waitingRequests: pools.reduce((sum, pool) => sum + pool.waitingCount, 0),
    };
  };

  return {
    snapshot,
    startTelemetry(logger, intervalMs = 1_000) {
      logger.info(
        {
          ...snapshot(),
          generalPoolMax: GENERAL_POOL_MAX,
          specializedPoolMax: SPECIALIZED_POOL_MAX,
          connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
        },
        "PostgreSQL runtime pool budget configured",
      );
      const timer = setInterval(() => {
        const state = snapshot();
        if (state.waitingRequests > 0) logger.warn(state, "PostgreSQL runtime pool is saturated");
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    async close() {
      const pools = [...entries.values()];
      entries.clear();
      await Promise.all(
        pools.map(async (entry) => {
          if (entry.closed) return;
          entry.closed = true;
          await entry.pool.end();
        }),
      );
    },
  };
}

export function isPostgresUnavailableError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "53300" || candidate.code === "57P03") return true;
    if (
      typeof candidate.message === "string" &&
      /^(?:timeout\b.*\btrying to connect|connection terminated\b.*\bconnection timeout)$/i.test(
        candidate.message,
      )
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function lease(entry: PoolEntry, key: string, entries: Map<string, PoolEntry>): pg.Pool {
  let released = false;
  const listeners: OwnedListener[] = [];
  let facade: pg.Pool;
  facade = new Proxy(entry.pool, {
    get(pool, property) {
      if (property === "end") {
        return async () => {
          if (released || entry.closed) return;
          released = true;
          for (const listener of listeners.splice(0)) {
            pool.removeListener(listener.event, listener.wrapped);
          }
          entry.references -= 1;
          if (entry.references > 0) return;
          entries.delete(key);
          entry.closed = true;
          await pool.end();
        };
      }
      if (
        property === "on" ||
        property === "addListener" ||
        property === "once" ||
        property === "prependListener" ||
        property === "prependOnceListener"
      ) {
        return (event: string | symbol, original: (...arguments_: unknown[]) => void) => {
          const wrapped = (...arguments_: unknown[]) => original.apply(facade, arguments_);
          listeners.push({ event, original, wrapped });
          Reflect.apply(pool[property], pool, [event, wrapped]);
          return facade;
        };
      }
      if (property === "off" || property === "removeListener") {
        return (event: string | symbol, original: (...arguments_: unknown[]) => void) => {
          const index = listeners.findLastIndex(
            (listener) => listener.event === event && listener.original === original,
          );
          if (index !== -1) {
            const [listener] = listeners.splice(index, 1);
            pool.removeListener(event, listener.wrapped);
          }
          return facade;
        };
      }
      if (property === "removeAllListeners") {
        return (event?: string | symbol) => {
          for (let index = listeners.length - 1; index >= 0; index -= 1) {
            const listener = listeners[index];
            if (event !== undefined && listener.event !== event) continue;
            pool.removeListener(listener.event, listener.wrapped);
            listeners.splice(index, 1);
          }
          return facade;
        };
      }
      const value = Reflect.get(pool, property, pool) as unknown;
      return typeof value === "function" ? value.bind(pool) : value;
    },
  });
  return facade;
}

function boundedTimeout(requested: number | undefined): number {
  return requested && requested > 0
    ? Math.min(requested, CONNECTION_TIMEOUT_MS)
    : CONNECTION_TIMEOUT_MS;
}

function hasClientTuning(options: pg.PoolConfig): boolean {
  return [
    options.statement_timeout,
    options.lock_timeout,
    options.idle_in_transaction_session_timeout,
    options.options,
  ].some((value) => value !== undefined);
}

function poolKey(options: pg.PoolConfig): string {
  return JSON.stringify(
    Object.entries(options)
      .filter(([key]) => key !== "max" && key !== "idleTimeoutMillis")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
