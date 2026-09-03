import { describe, expect, it, vi } from "vitest";

import { claimPmsInboxDeliveryJob } from "./pmsInboxDeliveryPg.js";

describe("PostgreSQL PMS Inbox delivery store", () => {
  it("claims one due job with a fenced worker attempt", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return text.includes("RETURNING job.id::text")
        ? {
            rows: [
              {
                id: "job-1",
                workerId: "worker-1",
                propertyId: "property-1",
                messageId: "message-1",
                attemptNumber: 2,
                maxAttempts: 5,
                correlationId: "correlation-1",
              },
            ],
          }
        : { rows: [] };
    });

    await expect(claimPmsInboxDeliveryJob({ query } as never, "worker-1")).resolves.toEqual({
      id: "job-1",
      workerId: "worker-1",
      propertyId: "property-1",
      messageId: "message-1",
      attemptNumber: 2,
      maxAttempts: 5,
      correlationId: "correlation-1",
    });

    expect(calls[0]?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0]?.text).toContain("attempts_count < max_attempts");
    expect(calls[0]?.values).toEqual([
      "pms.guest-message.delivery",
      "pms.guest-message.deliver",
      "worker-1",
    ]);
    expect(calls[1]?.text).toContain("status = 'timed_out'");
    expect(calls[2]?.text).toContain("INSERT INTO platform.job_attempts");
    expect(calls[2]?.values).toEqual(["job-1", 2, "worker-1"]);
  });

  it("returns null without creating an attempt when no work is due", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({ rows: [] }));
    await expect(claimPmsInboxDeliveryJob({ query } as never, "worker-1")).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
  });
});
