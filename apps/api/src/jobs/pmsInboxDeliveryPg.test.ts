import { describe, expect, it, vi } from "vitest";

import { claimPmsInboxDeliveryJob, preparePmsInboxDeliveryJob } from "./pmsInboxDeliveryPg.js";

const JOB = {
  id: "13750000-0000-4000-8000-000000000001",
  workerId: "worker-1",
  propertyId: "13750000-0000-4000-8000-000000000002",
  messageId: "13750000-0000-4000-8000-000000000003",
  attemptNumber: 1,
  maxAttempts: 5,
  correlationId: "correlation-1",
};

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

  it("revalidates an OTA route and starts one provider attempt", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes("SELECT 1 FROM platform.jobs")) return { rows: [{ present: true }] };
      if (text.includes("FROM pms.messages message")) return { rows: [delivery()] };
      if (text.includes("FROM pms.message_attachments")) return { rows: [] };
      if (text.includes("INSERT INTO pms.message_delivery_attempts")) {
        return { rows: [{ id: "13750000-0000-4000-8000-000000000004" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const read = vi.fn();

    await expect(
      preparePmsInboxDeliveryJob({ query } as never, JOB, {
        emailEnabled: false,
        media: { read },
      }),
    ).resolves.toMatchObject({
      state: "ready",
      adapter: "channex",
      attemptId: "13750000-0000-4000-8000-000000000004",
      input: {
        providerIdempotencyReference: `message:${JOB.messageId}`,
        channel: "ota",
        providerConversationId: "provider-thread-1",
        recipientEmail: null,
        text: "Welcome!",
        attachments: [],
      },
    });
    expect(read).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("conversation_context_state"))).toBe(true);
    expect(queries.some((sql) => sql.includes("current_delivery_attempt_id"))).toBe(true);
  });

  it("holds revoked access before creating a provider attempt", async () => {
    const query = vi.fn(async (text: string) =>
      text.includes("SELECT 1 FROM platform.jobs")
        ? { rows: [{ present: true }] }
        : { rows: [{ ...delivery(), accessReady: false }] },
    );

    await expect(
      preparePmsInboxDeliveryJob({ query } as never, JOB, {
        emailEnabled: false,
        media: { read: vi.fn() },
      }),
    ).resolves.toEqual({ state: "blocked", failure: "access_unavailable" });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

function delivery() {
  return {
    body: "Welcome!",
    deliveryState: "queued",
    deliveryChannel: "ota",
    source: "channex",
    sourceThreadId: "provider-thread-1",
    providerChannel: "booking.com",
    conversationContextState: "linked",
    bookingChannel: "booking_com",
    guestEmail: "guest@example.test",
    accessReady: true,
    channexReady: true,
    currentAttemptId: null,
    currentAttemptOutcome: null,
    currentProviderReference: null,
  };
}
