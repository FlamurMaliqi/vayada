import { describe, expect, it, vi } from "vitest";

import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import { channexRequests, createChannexManagementProvider } from "./channexManagement.js";

describe("Channex management provider", () => {
  it("executes a prepared action with auth and idempotency headers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(204));
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: { plan: async () => ({ requests: [channexRequests.availability([])] }) },
      fetch: fetcher,
    });

    await expect(provider.execute(job("sync_ari"))).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "https://staging.channex.io/api/v1/availability",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "user-api-key": "secret",
          "idempotency-key": "key-1",
        }),
      }),
    );
  });

  it.each([
    [429, "rate_limited"],
    [503, "provider_unavailable"],
    [422, "invalid_payload"],
    [403, "provider_rejected"],
  ] as const)("classifies HTTP %s as %s", async (status, code) => {
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: { plan: async () => ({ requests: [channexRequests.availability([])] }) },
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(status, { errors: { detail: "no" } })),
    });
    await expect(provider.execute(job("sync_ari"))).resolves.toMatchObject({
      ok: false,
      code,
      statusCode: status,
    });
  });

  it("hands pulled booking revisions to the existing intake owner", async () => {
    const handoff = vi.fn();
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: {
        plan: async () => ({
          requests: [channexRequests.bookingRevisionFeed("external-1")],
          bookingRevisionHandoff: handoff,
        }),
      },
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(200, { data: [{ id: "revision-1" }] })),
    });
    await provider.execute(job("sync_bookings"));
    expect(handoff).toHaveBeenCalledWith([{ id: "revision-1" }]);
  });

  it("does not send a request when target planning fails", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: {
        plan: async () => {
          throw new Error("missing mapping");
        },
      },
      fetch: fetcher,
    });
    await expect(provider.execute(job("provision"))).resolves.toMatchObject({
      ok: false,
      code: "invalid_state",
      message: "missing mapping",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function job(operationType: ChannexManagementJob["input"]["operationType"]): ChannexManagementJob {
  return {
    jobId: "job-1",
    propertyId: "property-1",
    correlationId: null,
    attemptNumber: 1,
    maxAttempts: 5,
    input: { commandId: "command-1", idempotencyKey: "key-1", operationType },
  };
}

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "request-1" },
  });
}
