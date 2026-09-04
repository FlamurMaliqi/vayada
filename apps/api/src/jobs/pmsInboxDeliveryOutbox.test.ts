import { describe, expect, it, vi } from "vitest";

import { relayPmsInboxDeliveryOutbox } from "./pmsInboxDeliveryOutbox.js";

describe("PMS Inbox delivery outbox relay", () => {
  it("publishes each ready reply into one scoped delivery job", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ published: "2" }],
    }));

    await expect(
      relayPmsInboxDeliveryOutbox("postgres://unused", {
        pool: { query } as never,
        limit: 2,
        now: new Date("2026-09-03T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ published: 2 });

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("INSERT INTO platform.jobs");
    expect(sql).toContain("ON CONFLICT (queue_name, job_key) DO NOTHING");
    expect(sql).toContain("job.source_outbox_event_id = candidate.id");
    expect(sql).toContain("status = 'published'");
    expect(values).toEqual([
      "pms.guest-message.deliver",
      2,
      "2026-09-03T00:00:00.000Z",
      "pms.guest-message.delivery",
    ]);
  });

  it("closes only a pool it owns", async () => {
    const end = vi.fn(async () => undefined);
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ published: 0 }],
    }));
    const external = { query, end };

    await relayPmsInboxDeliveryOutbox("postgres://unused", { pool: external as never });

    expect(end).not.toHaveBeenCalled();
  });
});
