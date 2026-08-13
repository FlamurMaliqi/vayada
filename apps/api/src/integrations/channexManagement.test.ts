import { describe, expect, it, vi } from "vitest";

import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import { channexRequests, createChannexManagementProvider } from "./channexManagement.js";

describe("Channex management provider", () => {
  it("executes a prepared action with provider authentication", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(204));
    const onProgress = vi.fn();
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: { plan: async () => ({ requests: [channexRequests.availability([])] }) },
      fetch: fetcher,
    });

    await expect(provider.execute(job("sync_ari"), { onProgress })).resolves.toMatchObject({
      ok: true,
    });
    expect(onProgress).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://staging.channex.io/api/v1/availability",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "user-api-key": "secret",
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

  it("captures provider IDs while provisioning rooms before their rates", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { data: { id: "external-room" } }))
      .mockResolvedValueOnce(response(200, { data: { id: "external-rate" } }));
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: {
        plan: async () => ({
          externalPropertyId: "external-property",
          requests: [
            channexRequests.createRoomType({
              roomTypeId: "room-1",
              roomTypeName: "Deluxe",
              roomType: { property_id: "external-property", title: "Deluxe" },
            }),
            channexRequests.createRatePlan({
              roomTypeId: "room-1",
              ratePlanId: "rate-1",
              ratePlanName: "Flexible",
              channel: "direct",
              sellMode: "per_room",
              markupPercent: 0,
              ratePlan: { property_id: "external-property", title: "Flexible" },
            }),
          ],
        }),
      },
      fetch: fetcher,
    });

    await expect(provider.execute(job("provision"))).resolves.toMatchObject({
      ok: true,
      roomTypeMappings: [{ roomTypeId: "room-1", externalRoomTypeId: "external-room" }],
      ratePlanMappings: [
        {
          ratePlanId: "rate-1",
          externalRoomTypeId: "external-room",
          externalRatePlanId: "external-rate",
        },
      ],
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      rate_plan: { room_type_id: "external-room" },
    });
  });

  it("normalizes connected channels for the target read model", async () => {
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: {
        plan: async () => ({
          requests: [channexRequests.listChannels("external-property")],
        }),
      },
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        response(200, {
          data: [
            {
              id: "channel-1",
              attributes: { application: "BookingCom", title: "Booking.com", is_active: true },
            },
          ],
        }),
      ),
    });
    await expect(provider.execute(job("provision"))).resolves.toMatchObject({
      ok: true,
      channels: [
        { key: "booking_com", application: "BookingCom", title: "Booking.com", isActive: true },
      ],
    });
  });

  it("reconciles provider state and checkpoints it before skipping duplicate creates", async () => {
    const checkpoint = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(200, { data: [{ id: "external-property", attributes: { title: "Hotel" } }] }),
      );
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: {
        plan: async () => ({
          requests: [
            channexRequests.findProperty("Hotel"),
            channexRequests.createProperty({ title: "Hotel" }),
          ],
          checkpoint,
        }),
      },
      fetch: fetcher,
    });

    await expect(provider.execute(job("enable"))).resolves.toMatchObject({
      ok: true,
      externalPropertyId: "external-property",
      connectionStatus: "connected",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ externalPropertyId: "external-property" }),
    );
  });

  it("checks messaging installation before applying the per-property add-on", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(200, {
        data: [{ id: "app-1", attributes: { application_code: "channex_messages" } }],
      }),
    );
    const provider = createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "secret",
      plans: {
        plan: async () => ({
          requests: [
            channexRequests.listInstalledApplications("property-1"),
            channexRequests.installMessaging("property-1"),
          ],
        }),
      },
      fetch: fetcher,
    });
    await expect(provider.execute(job("install_messaging"))).resolves.toMatchObject({
      ok: true,
      messagingAppInstalled: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
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
