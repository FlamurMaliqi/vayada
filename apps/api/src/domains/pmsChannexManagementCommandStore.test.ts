import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";

import { createPgPmsChannexManagementCommandPort } from "./pmsChannexManagementCommandStore.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const acceptedAt = new Date("2026-08-13T10:00:00.000Z");

describe("PMS Channex management command store", () => {
  it("atomically reserves idempotency, queues work, and audits the actor", async () => {
    const db = new FakeDb("new");
    const port = createPgPmsChannexManagementCommandPort({
      connectionString: "postgresql://target",
      pool: db.pool(),
      now: () => acceptedAt,
    });

    const result = await port.enqueue(context(), propertyId, command("enable"));

    expect(result).toMatchObject({ ok: true, replayed: false, operation: { status: "queued" } });
    expect(db.sql()).toContain("INSERT INTO platform.idempotency_keys");
    expect(db.sql()).toContain("INSERT INTO platform.jobs");
    expect(db.sql()).toContain("INSERT INTO platform.product_audit_events");
    expect(db.calls.at(-1)?.text).toBe("COMMIT");
    expect(db.sql()).not.toMatch(/external_webhook_events|legacy/i);
  });

  it("returns the existing operation for the same request and rejects key reuse", async () => {
    let db = new FakeDb("replay");
    let port = createPgPmsChannexManagementCommandPort({
      connectionString: "postgresql://target",
      pool: db.pool(),
      now: () => acceptedAt,
    });
    expect(await port.enqueue(context(), propertyId, command("enable"))).toMatchObject({
      ok: true,
      replayed: true,
      operation: { operationId: "323e4567-e89b-42d3-a456-426614174000" },
    });
    expect(db.sql().match(/INSERT INTO platform\.jobs/g)).toBeNull();

    db = new FakeDb("conflict");
    port = createPgPmsChannexManagementCommandPort({
      connectionString: "postgresql://target",
      pool: db.pool(),
    });
    expect(await port.enqueue(context(), propertyId, command("enable"))).toEqual({
      ok: false,
      code: "idempotency_conflict",
      message: "The idempotency key was already used for another command.",
    });
    expect(db.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("requires a target connection before dependent operations", async () => {
    const db = new FakeDb("disconnected");
    const port = createPgPmsChannexManagementCommandPort({
      connectionString: "postgresql://target",
      pool: db.pool(),
    });

    expect(await port.enqueue(context(), propertyId, command("sync_ari"))).toMatchObject({
      ok: false,
      code: "connection_required",
    });
    expect(db.sql()).not.toContain("INSERT INTO platform.jobs");
    expect(db.calls.at(-1)?.text).toBe("ROLLBACK");
  });
});

type Mode = "new" | "replay" | "conflict" | "disconnected";

class FakeDb {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  private fingerprint = "";

  constructor(private readonly mode: Mode) {}

  pool() {
    return {
      connect: async () => ({ query: this.query.bind(this), release() {} }),
      end: async () => undefined,
    };
  }

  sql() {
    return this.calls.map(({ text }) => text).join("\n");
  }

  async query<T>(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    if (text.includes("FROM pms.channel_connections")) return rows<T>([]);
    if (text.includes("INSERT INTO platform.idempotency_keys")) {
      this.fingerprint = String(values?.[2]);
      return rows<T>(this.mode === "new" ? [{ id: "idem-1" }] : []);
    }
    if (text.includes("SELECT request_fingerprint_hash")) {
      return rows<T>([
        { requestFingerprintHash: this.mode === "conflict" ? "different" : this.fingerprint },
      ]);
    }
    if (text.includes("INSERT INTO platform.jobs") || text.includes("FROM platform.jobs")) {
      return rows<T>([job()]);
    }
    return rows<T>([]);
  }
}

function rows<T>(values: unknown[]) {
  return { rows: values as T[], rowCount: values.length };
}

function job() {
  return {
    operationId: "323e4567-e89b-42d3-a456-426614174000",
    propertyId,
    status: "pending",
    attemptsMade: 0,
    maxAttempts: 5,
    runAfter: acceptedAt.toISOString(),
    acceptedAt: acceptedAt.toISOString(),
    payload: command("enable"),
    metadata: {},
  };
}

function command(operationType: "enable" | "sync_ari") {
  return { commandId: "command-1", idempotencyKey: "key-1", operationType };
}

function context(): RequestContext {
  return {
    actor: { internalUserId: "423e4567-e89b-42d3-a456-426614174000" },
    audit: { requestId: "request-1", source: "api", receivedAt: acceptedAt.toISOString() },
  } as RequestContext;
}
