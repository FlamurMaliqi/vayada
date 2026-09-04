import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createPmsInboxProductionRuntime,
  createUnavailablePmsInboxEmailReplyRouteReadPort,
  type PmsInboxRuntimeFactories,
  type PmsInboxRuntimePool,
} from "./pmsInboxProductionRuntime.js";

const PROPERTY = "13736000-0000-4000-8000-000000000001";
const THREAD = "13736000-0000-4000-8000-000000000002";

describe("PMS Inbox production runtime", () => {
  it("composes every target Inbox database port over an injected pool", async () => {
    const pool = unusedPool();
    const runtime = createPmsInboxProductionRuntime({
      connectionString: "",
      attachmentMediaAccessEnabled: true,
      pool,
    });

    expect(Object.keys(runtime.routes).sort()).toEqual([
      "pmsInboxMarkReadPort",
      "pmsInboxProviderActionPort",
      "pmsInboxQuickReplyPort",
      "pmsInboxReadPort",
      "pmsInboxReplyPort",
      "pmsInboxStaffCommandPort",
      "pmsInboxStartDirectEmailPort",
      "pmsInboxTriagePort",
    ]);
    expect(runtime.emailReplyRoutes).toBeDefined();
    await runtime.close();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("adds assistance only when a real service is supplied and closes it once", async () => {
    const close = vi.fn(async () => undefined);
    const runtime = createPmsInboxProductionRuntime({
      connectionString: "",
      attachmentMediaAccessEnabled: false,
      pool: unusedPool(),
      assistanceService: { assist: vi.fn(async () => ({ ok: false as const })), close },
    });

    expect(runtime.routes.pmsInboxAssistancePort).toBeDefined();
    await runtime.close();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an owned pool even when the assistance provider fails to close", async () => {
    const pool = unusedPool();
    const providerFailure = new Error("provider close failed");
    const factories: PmsInboxRuntimeFactories = { createPool: vi.fn(() => pool) };
    const runtime = createPmsInboxProductionRuntime(
      {
        connectionString: "postgresql://target.test/vayada",
        attachmentMediaAccessEnabled: false,
        assistanceService: {
          assist: vi.fn(async () => ({ ok: false as const })),
          close: vi.fn(async () => {
            throw providerFailure;
          }),
        },
      },
      factories,
    );

    await expect(runtime.close()).rejects.toBe(providerFailure);
    expect(pool.end).toHaveBeenCalledOnce();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("deduplicates concurrent shutdown calls", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = unusedPool();
    pool.end.mockImplementation(() => barrier);
    const providerClose = vi.fn(() => barrier);
    const runtime = createPmsInboxProductionRuntime(
      {
        connectionString: "postgresql://target.test/vayada",
        attachmentMediaAccessEnabled: false,
        assistanceService: {
          assist: vi.fn(async () => ({ ok: false as const })),
          close: providerClose,
        },
      },
      { createPool: vi.fn(() => pool) },
    );

    const first = runtime.close();
    const second = runtime.close();
    await vi.waitFor(() => {
      expect(providerClose).toHaveBeenCalledOnce();
      expect(pool.end).toHaveBeenCalledOnce();
    });
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(providerClose).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("holds email until both a guest address and approved sender exist", async () => {
    const port = createUnavailablePmsInboxEmailReplyRouteReadPort();
    await expect(
      port.resolveReplyRoutes({
        propertyId: PROPERTY,
        threads: [
          { threadId: THREAD, guestEmail: null },
          { threadId: crypto.randomUUID(), guestEmail: "guest@example.test" },
        ],
      }),
    ).resolves.toEqual([
      {
        propertyId: PROPERTY,
        threadId: THREAD,
        route: {
          state: "held",
          channel: null,
          providerChannel: null,
          reasonCode: "guest_email_unavailable",
        },
      },
      {
        propertyId: PROPERTY,
        threadId: expect.any(String),
        route: {
          state: "held",
          channel: null,
          providerChannel: null,
          reasonCode: "approved_sender_unavailable",
        },
      },
    ]);
  });

  it("rejects an empty connection string without an injected pool", () => {
    expect(() =>
      createPmsInboxProductionRuntime({
        connectionString: "",
        attachmentMediaAccessEnabled: false,
      }),
    ).toThrow("connectionString");
  });
});

function unusedPool(): PmsInboxRuntimePool & { end: ReturnType<typeof vi.fn> } {
  return {
    query<T extends QueryResultRow = QueryResultRow>(): Promise<
      Pick<QueryResult<T>, "rows" | "rowCount">
    > {
      throw new Error("Unexpected Inbox runtime query");
    },
    connect() {
      throw new Error("Unexpected Inbox runtime connection");
    },
    end: vi.fn(async () => undefined),
  };
}
