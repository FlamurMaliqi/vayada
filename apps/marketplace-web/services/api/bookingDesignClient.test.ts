import { ApiErrorResponse } from "./client";
import { createBookingDesignClient } from "./bookingDesignClient";
import { createBookingDesignButtonColors } from "@vayada/domain-booking";
import { beforeEach, describe, expect, it, vi } from "vitest";

const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
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

  it("loads only a strict, scope-bound private renderer snapshot", async () => {
    calls.get.mockResolvedValueOnce(readiness());
    await expect(client.loadReadiness({ organizationId, propertyId })).resolves.toEqual(
      readiness(),
    );
    expect(calls.get).toHaveBeenCalledWith(
      `/api/booking/properties/${propertyId}/booking-design/readiness`,
      undefined,
    );

    calls.get.mockResolvedValueOnce({ ...readiness(), propertyId: organizationId });
    await expect(client.loadReadiness({ organizationId, propertyId })).rejects.toThrow(
      /response is invalid/i,
    );
  });

  it("preserves an exact 503 provider-failure result instead of hiding it as transport failure", async () => {
    const failure = {
      outcome: "provider_failure",
      organizationId,
      propertyId,
      error: {
        code: "booking_design_safe_media_unavailable",
        evidencePort: "safe_media",
        errorSource: "provider",
      },
    };
    calls.get.mockRejectedValueOnce(new ApiErrorResponse(503, failure as never));
    await expect(client.loadReadiness({ organizationId, propertyId })).resolves.toEqual(failure);

    calls.get.mockRejectedValueOnce(
      new ApiErrorResponse(500, { code: "booking_design_readiness_port_contract_violation" }),
    );
    await expect(client.loadReadiness({ organizationId, propertyId })).rejects.toBeInstanceOf(
      ApiErrorResponse,
    );
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

function readiness() {
  const designSource = {
    ownerDomain: "booking",
    entityType: "design_revision",
    entityId: propertyId,
    revision: "design:1",
  };
  return {
    outcome: "ready",
    organizationId,
    propertyId,
    designSource,
    snapshot: {
      contractVersion: "booking-design-renderer.v1",
      organizationId,
      propertyId,
      sourceBindings: [
        designSource,
        {
          ownerDomain: "hotel_catalog",
          entityType: "property_media_assignment",
          entityId: propertyId,
          revision: "profile:7",
        },
        {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: "profile:7",
        },
      ],
      appearance: {
        primaryColor: "#4F46E5",
        fontPairing: "high-end-serif",
        headingFontFamily: "'Playfair Display', serif",
        bodyFontFamily: "'Source Sans Pro', sans-serif",
        button: createBookingDesignButtonColors("#4F46E5"),
      },
      profile: {
        displayName: "Canal House",
        contentLocale: "en",
        shortDescription:
          "A canonical description that is long enough for the private Booking preview.",
      },
      cover: { kind: "fallback", path: "/vayada-logo.png" },
    },
  } as const;
}
