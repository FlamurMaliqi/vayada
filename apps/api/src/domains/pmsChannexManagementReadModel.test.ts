import { describe, expect, it, vi } from "vitest";

import { createPgPmsChannexManagementReadRepository } from "./pmsChannexManagementReadModel.js";

const modes = {
  connection: "observe_only",
  provisioning: "observe_only",
  ariSync: "observe_only",
  bookingSync: "observe_only",
  markups: "observe_only",
  messaging: "observe_only",
  iframe: "observe_only",
} as const;

describe("PMS Channex management read model", () => {
  it("returns a complete empty target snapshot for a disconnected property", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = createPgPmsChannexManagementReadRepository({
      connectionString: "postgres://target",
      pool: { query, end: vi.fn() } as never,
    });

    const snapshot = await repository.getSnapshot("00000000-0000-4000-8000-000000000001", modes);

    expect(snapshot).toMatchObject({
      contractVersion: "pms-channex-management.v1",
      connection: { status: "disconnected", externalPropertyId: null },
      mappings: { roomTypes: [], ratePlans: [] },
      channels: [],
      googleFreeBookingLinks: {
        status: "disabled",
        bookingUrlTemplate: null,
        currency: null,
        businessProfileConfirmedAt: null,
        preflight: {
          propertyName: false,
          address: false,
          phone: false,
          bookingEngine: false,
          activeRatesAndAvailability: false,
        },
      },
      markups: [],
      capabilityModes: modes,
      activeOperation: null,
    });
    expect(snapshot.sync.ari.status).toBe("idle");
    expect(query).toHaveBeenCalledTimes(6);
    for (const callIndex of [1, 2, 3]) {
      expect(query.mock.calls[callIndex]?.[0]).toContain("connection.provider = 'channex'");
    }
  });

  it("publishes Google readiness from canonical target state", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            status: "connected",
            externalPropertyId: "external-1",
            messagingAppInstalled: false,
            metadata: {
              googleFreeBookingLinks: {
                businessProfileConfirmedAt: "2026-08-13T10:00:00.000Z",
              },
              connectedChannels: [
                {
                  key: "google_hotel",
                  application: "GHA",
                  title: "Google Hotel",
                  isActive: true,
                },
              ],
            },
            ariMappingMissing: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            propertyName: true,
            address: true,
            phone: true,
            bookingEngine: true,
            activeRatesAndAvailability: true,
            bookingBaseUrl: "https://book.vayada.com/alpine",
            customDomainUrl: "https://book.alpine.test/stay",
            currency: "EUR",
          },
        ],
      });
    const repository = createPgPmsChannexManagementReadRepository({
      connectionString: "postgres://target",
      pool: { query, end: vi.fn() } as never,
    });

    const snapshot = await repository.getSnapshot("00000000-0000-4000-8000-000000000001", modes);

    expect(snapshot.googleFreeBookingLinks).toEqual({
      status: "active",
      bookingUrlTemplate: "https://book.alpine.test/stay?checkin=(CHECKIN_DATE)&nights=(LENGTH)",
      currency: "EUR",
      businessProfileConfirmedAt: "2026-08-13T10:00:00.000Z",
      preflight: {
        propertyName: true,
        address: true,
        phone: true,
        bookingEngine: true,
        activeRatesAndAvailability: true,
      },
    });
    expect(query.mock.calls[5]?.[0]).toContain("hotel_catalog.property_contact_channels");
    expect(query.mock.calls[5]?.[0]).toContain("distribution.public_hotel_bookability_profiles");
    expect(query.mock.calls[5]?.[0]).toContain("pms.inventory_days");
    expect(query.mock.calls[5]?.[0]).toContain("plan.currency = profile.default_currency::text");
  });

  it("suppresses inactive or disconnected markups", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            status: "disconnected",
            externalPropertyId: null,
            messagingAppInstalled: false,
            metadata: {},
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { channel: "booking_com", markupPercent: 12, status: "active" },
          { channel: "airbnb", markupPercent: 15, status: "disabled" },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const repository = createPgPmsChannexManagementReadRepository({
      connectionString: "postgres://target",
      pool: { query, end: vi.fn() } as never,
    });

    const snapshot = await repository.getSnapshot("00000000-0000-4000-8000-000000000001", modes);

    expect(snapshot.markups).toEqual([]);
  });

  it.each([
    ["pending", 0, "queued", null],
    ["pending", 1, "retry_scheduled", "2026-08-14T00:00:00.000Z"],
    ["running", 1, "running", null],
    ["succeeded", 1, "succeeded", null],
    ["failed", 1, "failed", null],
    ["canceled", 1, "failed", null],
    ["dead_lettered", 1, "dead_lettered", null],
  ] as const)(
    "maps platform job status %s into the public contract",
    async (status, attemptsMade, expected, retryAfter) => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            operationId: "00000000-0000-4000-8000-000000000002",
            propertyId: "00000000-0000-4000-8000-000000000001",
            status,
            attemptsMade,
            maxAttempts: 5,
            runAfter: "2026-08-14T00:00:00.000Z",
            acceptedAt: "2026-08-13T00:00:00.000Z",
            payload: {
              operationType: "sync_ari",
              commandId: "command-1",
              idempotencyKey: "key-1",
            },
            metadata: {},
          },
        ],
      });
      const repository = createPgPmsChannexManagementReadRepository({
        connectionString: "postgres://target",
        pool: { query, end: vi.fn() } as never,
      });

      const operation = await repository.getOperation(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      );

      expect(operation).toMatchObject({ status: expected, retryAfter });
    },
  );
});
