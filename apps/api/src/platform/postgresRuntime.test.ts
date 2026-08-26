import pg from "pg";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createPgFinanceExpenseCategoryRepository } from "../domains/financeExpenseCategoryRepository.js";
import { createPgFinanceManualExpenseRepository } from "../domains/financeManualExpenseRepository.js";
import { installPostgresPoolRuntime, isPostgresUnavailableError } from "./postgresRuntime.js";

describe("PostgreSQL runtime capacity", () => {
  it("shares and bounds equivalent pools while preserving client-specific timeouts", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const first = new postgres.Pool({ connectionString: "postgresql://example/target", max: 20 });
    const second = new postgres.Pool({ connectionString: "postgresql://example/target", max: 2 });
    const specialized = new postgres.Pool({
      connectionString: "postgresql://example/target",
      statement_timeout: 5_000,
    });
    const discrete = [() => "first", () => "second"].map(
      (password) =>
        new postgres.Pool({ host: "example", database: "target", user: "vayada", password }),
    );
    const encodings = ["UTF8", "LATIN1"].map(
      (client_encoding) => new postgres.Pool({ host: "example", client_encoding }),
    );
    expect(first).not.toBe(second);
    expect(first.options.max).toBe(8);
    expect(first.options.connectionTimeoutMillis).toBe(3_000);
    expect(specialized.options.max).toBe(1);
    expect(runtime.snapshot()).toMatchObject({ physicalPoolCount: 6, maxConnections: 41 });
    await first.end();
    expect(runtime.snapshot().physicalPoolCount).toBe(6);
    await second.end();
    expect(runtime.snapshot().physicalPoolCount).toBe(5);
    await specialized.end();
    await Promise.all([...discrete, ...encodings].map((pool) => pool.end()));
  });
  it.each([
    Object.assign(new Error("too many connections"), { code: "53300" }),
    new Error("timeout exceeded when trying to connect"),
    new Error("Connection terminated due to connection timeout"),
  ])("recognizes bounded connection acquisition failures", (error) => {
    expect(isPostgresUnavailableError(error)).toBe(true);
  });
  it("does not misclassify a non-PostgreSQL connection timeout", () => {
    expect(
      isPostgresUnavailableError(
        new Error(
          "the request socket did not establish a connection with the server within the configured timeout",
        ),
      ),
    ).toBe(false);
  });
  it("applies sharing to repositories that imported pg before installation", async () => {
    const OriginalPool = pg.Pool;
    const runtime = installPostgresPoolRuntime(pg);
    const category = createPgFinanceExpenseCategoryRepository("postgresql://example/target");
    const expense = createPgFinanceManualExpenseRepository("postgresql://example/target");
    try {
      expect(runtime.snapshot()).toMatchObject({ physicalPoolCount: 1, maxConnections: 8 });
    } finally {
      await Promise.all([category.close(), expense.close()]);
      Object.defineProperty(pg, "Pool", {
        configurable: true,
        writable: true,
        value: OriginalPool,
      });
    }
  });
  it("removes listeners owned by short-lived leases", async () => {
    const postgres = { Pool: pg.Pool };
    const runtime = installPostgresPoolRuntime(postgres);
    const keeper = new postgres.Pool({ connectionString: "postgresql://example/target" });
    for (let index = 0; index < 12; index += 1) {
      const transient = new postgres.Pool({ connectionString: "postgresql://example/target" });
      transient.on("error", () => undefined);
      await transient.end();
    }
    expect(keeper.listenerCount("error")).toBe(0);
    expect(runtime.snapshot()).toMatchObject({ physicalPoolCount: 1, maxConnections: 8 });
    await keeper.end();
  });
  it("returns a typed 503 when PostgreSQL cannot acquire a connection", async () => {
    const app = buildApp({ logger: false });
    app.get("/__test/database-unavailable", async () => {
      throw Object.assign(new Error("too many connections"), { code: "53300" });
    });
    const response = await app.inject({ method: "GET", url: "/__test/database-unavailable" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      statusCode: 503,
      error: "Service Unavailable",
      message: "Database is temporarily unavailable",
      code: "database_unavailable",
    });
    await app.close();
  });
});
