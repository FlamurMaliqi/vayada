import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import { createPgPmsChannexIframeSessionPort } from "./pmsChannexIframeSession.js";

const now = new Date("2026-08-13T10:00:00.000Z");

describe("PMS Channex iframe sessions", () => {
  it("creates a short-lived provider URL and audits without persisting the token", async () => {
    const db = new FakePool("external-property");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { token: "one-time-secret" } }), { status: 200 }),
      );
    const port = createPgPmsChannexIframeSessionPort({
      connectionString: "postgresql://target",
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "api-secret",
      pool: db,
      fetch: fetcher,
      now: () => now,
    });

    await expect(port.createSession(context(), "property-1")).resolves.toEqual({
      ok: true,
      contractVersion: "pms-channex-management.v1",
      iframeUrl:
        "https://staging.channex.io/auth/exchange?oauth_session_key=one-time-secret&app_mode=headless&redirect_to=%2Fchannels&property_id=external-property&lng=en",
      expiresAt: "2026-08-13T10:15:00.000Z",
    });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://staging.channex.io/api/v1/auth/one_time_token"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "user-api-key": "api-secret" }),
      }),
    );
    expect(db.sql()).toContain("pms.channex.iframe_session.created");
    expect(db.sql()).toContain("$3::text");
    expect(db.values()).not.toContain("one-time-secret");
  });

  it("fails closed before provider access when no target connection exists", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const port = createPgPmsChannexIframeSessionPort({
      connectionString: "postgresql://target",
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "api-secret",
      pool: new FakePool(null),
      fetch: fetcher,
    });
    await expect(port.createSession(context(), "property-1")).resolves.toMatchObject({
      ok: false,
      code: "connection_required",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

class FakePool {
  calls: Array<{ text: string; values?: unknown[] }> = [];
  constructor(private readonly externalPropertyId: string | null) {}
  async query<T>(text: string, values?: unknown[]) {
    this.calls.push({ text, values });
    const rows =
      text.includes("FROM pms.channel_connections") && this.externalPropertyId
        ? [{ externalPropertyId: this.externalPropertyId }]
        : [];
    return { rows: rows as T[] };
  }
  async end() {}
  sql() {
    return this.calls.map(({ text }) => text).join("\n");
  }
  values() {
    return this.calls.flatMap(({ values }) => values ?? []).join(" ");
  }
}

function context(): RequestContext {
  return {
    actor: { internalUserId: "123e4567-e89b-42d3-a456-426614174000" },
    locale: "en",
    audit: { requestId: "request-1", source: "api", receivedAt: now.toISOString() },
  } as RequestContext;
}
