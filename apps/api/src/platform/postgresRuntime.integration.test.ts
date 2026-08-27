import pg from "pg";
import { describe, expect, it } from "vitest";

import { installPostgresPoolRuntime } from "./postgresRuntime.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL runtime pool budget", () => {
  it("serves concurrent logical pools through one bounded physical pool", async () => {
    if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(TEST_DATABASE_URL!).pathname)) {
      throw new Error("Refusing to run PostgreSQL pool integration outside a test database");
    }
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const pools = Array.from(
      { length: 24 },
      () => new postgres.Pool({ connectionString: TEST_DATABASE_URL!, max: 10 }),
    );

    try {
      await Promise.all(pools.map((pool) => pool.query("SELECT pg_sleep(0.05)")));
      expect(runtime.snapshot()).toMatchObject({
        physicalPoolCount: 1,
        maxConnections: 8,
        totalConnections: 8,
        idleConnections: 8,
        waitingRequests: 0,
      });
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await runtime.close();
    }
  });
});
