import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";

import { createTargetSameDayBookingSettingsPort } from "./sameDayBookingSettings.js";

const PROPERTY = "13550000-0000-4000-8000-000000000001";
const USER = "13550000-0000-4000-8000-000000000002";

describe("target same-day booking settings", () => {
  it("commits one Distribution event and retryable Channex job, then replays", async () => {
    const pool = new SettingsPool();
    const port = createTargetSameDayBookingSettingsPort({
      connectionString: "postgresql://target",
      pool,
      now: () => new Date("2026-08-31T10:00:00Z"),
    });
    const command = {
      commandId: "command-1",
      idempotencyKey: "key-1",
      enabled: false,
      cutoffLocalTime: "12:30",
    } as const;

    const first = await port.update(context(), PROPERTY, command);
    const replay = await port.update(context(), PROPERTY, command);

    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      channexOperationId: "13550000-0000-4000-8000-000000000005",
      settings: { enabled: false, cutoffLocalTime: "12:30", revision: 3 },
    });
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      channexOperationId: "13550000-0000-4000-8000-000000000005",
      settings: { revision: 3 },
    });
    expect(pool.sql.filter((sql) => sql.includes("platform.outbox_events"))).toHaveLength(1);
    expect(pool.sql.filter((sql) => sql.includes("INSERT INTO platform.jobs"))).toHaveLength(1);
    expect(pool.sql.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(pool.sql.join("\n")).toContain("max_attempts");
    expect(pool.sql.join("\n")).toContain("platform.product_audit_events");
    expect(pool.sql.join("\n")).toContain("FOR UPDATE OF property");
  });

  it("replays the original response after a newer command changes the policy", async () => {
    const pool = new SettingsPool();
    const port = createTargetSameDayBookingSettingsPort({
      connectionString: "postgresql://target",
      pool,
      now: () => new Date("2026-08-31T10:00:00Z"),
    });
    const first = {
      commandId: "command-a",
      idempotencyKey: "key-a",
      enabled: false,
      cutoffLocalTime: "12:30",
    } as const;

    await port.update(context(), PROPERTY, first);
    await port.update(context(), PROPERTY, {
      commandId: "command-b",
      idempotencyKey: "key-b",
      enabled: true,
      cutoffLocalTime: "17:00",
    });
    const replay = await port.update(context(), PROPERTY, first);

    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      settings: { enabled: false, cutoffLocalTime: "12:30", revision: 3 },
    });
  });
});

class SettingsPool {
  sql: string[] = [];
  private readonly reservations = new Map<
    string,
    { id: string; fingerprint: string; response: unknown; channexOperationId: string | null }
  >();
  private current = row(true, "18:00", 2, "2026-08-31T09:00:00Z");

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
  async end() {}
  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.sql.push(text);
    let rows: unknown[] = [];
    if (text.includes("INSERT INTO platform.idempotency_keys") && text.includes("'booking'")) {
      const keyHash = String(values[1]);
      if (!this.reservations.has(keyHash)) {
        const id = `13550000-0000-4000-8000-${String(this.reservations.size + 3).padStart(12, "0")}`;
        this.reservations.set(keyHash, {
          id,
          fingerprint: String(values[2]),
          response: null,
          channexOperationId: null,
        });
        rows = [{ id }];
      }
    } else if (text.includes('request_fingerprint_hash AS "requestFingerprintHash"')) {
      const reservation = this.reservations.get(String(values[1]));
      rows = reservation
        ? [
            {
              requestFingerprintHash: reservation.fingerprint,
              channexOperationId: reservation.channexOperationId,
              response: reservation.response,
            },
          ]
        : [];
    } else if (text.includes("FROM hotel_catalog.properties property")) {
      rows = [this.current];
    } else if (text.includes("INSERT INTO booking.same_day_booking_policies")) {
      this.current = row(
        Boolean(values[1]),
        values[2] as string | null,
        this.current.revision + 1,
        String(values[3]),
      );
      rows = [this.current];
    } else if (text.includes("INSERT INTO platform.domain_events")) {
      rows = [{ id: "13550000-0000-4000-8000-000000000003" }];
    } else if (text.includes("INSERT INTO platform.outbox_events")) {
      rows = [{ id: "13550000-0000-4000-8000-000000000004" }];
    } else if (text.includes("FROM pms.channel_connections")) {
      rows = [{ connected: true }];
    } else if (text.includes("INSERT INTO platform.jobs")) {
      rows = [{ id: "13550000-0000-4000-8000-000000000005" }];
    } else if (text.includes("response_status_code = 200")) {
      const reservation = [...this.reservations.values()].find(({ id }) => id === values[0]);
      if (reservation) {
        reservation.channexOperationId = values[4] as string | null;
        reservation.response = JSON.parse(String(values[5]));
      }
    }
    return { rows: rows as T[] };
  }
}

function row(
  enabled: boolean,
  cutoffLocalTime: string | null,
  revision: number,
  updatedAt: string,
) {
  return {
    propertyId: PROPERTY,
    propertyTimeZone: "Europe/Vienna",
    configured: true,
    enabled,
    cutoffLocalTime,
    revision,
    updatedAt,
  };
}

function context(): RequestContext {
  return {
    actor: { internalUserId: USER },
    audit: { requestId: "request-1", correlationId: "correlation-1" },
  } as RequestContext;
}
