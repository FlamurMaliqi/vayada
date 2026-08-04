import { ApiErrorResponse } from "./client";
import { createBookingDesignClient } from "./bookingDesignClient";
import { beforeEach, describe, expect, it, vi } from "vitest";

const propertyId = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-04T12:00:00.000Z";
const calls = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const client = createBookingDesignClient(calls);

describe("bookingDesignClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats an explicit not-configured read as absent without swallowing other failures", async () => {
    calls.get.mockRejectedValueOnce(
      new ApiErrorResponse(404, { code: "booking_design_not_configured" }),
    );
    await expect(client.load(propertyId)).resolves.toBeNull();

    calls.get.mockRejectedValueOnce(new ApiErrorResponse(500, { code: "internal_error" }));
    await expect(client.load(propertyId)).rejects.toBeInstanceOf(ApiErrorResponse);
  });

  it("upserts only allowlisted private design choices and validates the owner receipt", async () => {
    calls.put.mockResolvedValue({ outcome: "created", design: design(1) });
    await expect(
      client.save(propertyId, {
        expectedRevision: 0,
        choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
      }),
    ).resolves.toEqual(design(1));
    expect(calls.put).toHaveBeenCalledWith(
      `/api/booking/properties/${propertyId}/booking-design`,
      { expectedRevision: 0, primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
      expect.any(Object),
    );

    calls.put.mockResolvedValue({
      outcome: "created",
      design: { ...design(1), propertyId: "22222222-2222-4222-8222-222222222222" },
    });
    await expect(
      client.save(propertyId, {
        expectedRevision: 0,
        choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
      }),
    ).rejects.toThrow(/response is invalid/i);
  });
});

function design(revision: number) {
  return {
    contractVersion: "booking-design.v1",
    propertyId,
    revision,
    choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
    createdAt: now,
  };
}
