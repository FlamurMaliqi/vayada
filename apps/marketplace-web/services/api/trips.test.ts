import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildMarketplaceTripIdempotencyKey: vi.fn(),
  createMarketplaceTrip: vi.fn(),
  updateMarketplaceTrip: vi.fn(),
  deleteMarketplaceTrip: vi.fn(),
  createMarketplaceExternalCollaboration: vi.fn(),
  updateMarketplaceExternalCollaboration: vi.fn(),
  deleteMarketplaceExternalCollaboration: vi.fn(),
}));

vi.mock("@vayada/marketplace-shared/api/trips", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vayada/marketplace-shared/api/trips")>();
  return {
    ...actual,
    buildMarketplaceTripIdempotencyKey: mocks.buildMarketplaceTripIdempotencyKey,
    createMarketplaceTrip: mocks.createMarketplaceTrip,
    updateMarketplaceTrip: mocks.updateMarketplaceTrip,
    deleteMarketplaceTrip: mocks.deleteMarketplaceTrip,
    createMarketplaceExternalCollaboration: mocks.createMarketplaceExternalCollaboration,
    updateMarketplaceExternalCollaboration: mocks.updateMarketplaceExternalCollaboration,
    deleteMarketplaceExternalCollaboration: mocks.deleteMarketplaceExternalCollaboration,
  };
});

import { tripService } from "./trips";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildMarketplaceTripIdempotencyKey.mockImplementation(
    ({ action, resourceId }: { action: string; resourceId: string }) =>
      `key:${action}:${resourceId}`,
  );
  mocks.createMarketplaceTrip.mockResolvedValue(targetTrip());
  mocks.updateMarketplaceTrip.mockResolvedValue(targetTrip());
  mocks.deleteMarketplaceTrip.mockResolvedValue(undefined);
  mocks.createMarketplaceExternalCollaboration.mockResolvedValue(targetExternalCollaboration());
  mocks.updateMarketplaceExternalCollaboration.mockResolvedValue(targetExternalCollaboration());
  mocks.deleteMarketplaceExternalCollaboration.mockResolvedValue(undefined);
});

describe("tripService idempotency", () => {
  it("supplies a distinct action key to every trip write", async () => {
    await tripService.createTrip({
      name: "Bali campaign",
      start_date: "2026-09-10",
      end_date: "2026-09-20",
    });
    await tripService.updateTrip("legacy-trip-bali", { name: "Bali launch" });
    await tripService.deleteTrip("legacy-trip-bali");

    expect(mocks.createMarketplaceTrip).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "key:trip.create:new" }),
    );
    expect(mocks.updateMarketplaceTrip).toHaveBeenCalledWith(
      "legacy-trip-bali",
      expect.objectContaining({ idempotencyKey: "key:trip.update:legacy-trip-bali" }),
    );
    expect(mocks.deleteMarketplaceTrip).toHaveBeenCalledWith(
      "legacy-trip-bali",
      "key:trip.delete:legacy-trip-bali",
    );
  });

  it("supplies a distinct action key to every external-collaboration write", async () => {
    await tripService.createExternalCollaboration({
      trip_id: "legacy-trip-bali",
      title: "Seehof winter reel",
      start_date: "2026-09-12",
      end_date: "2026-09-16",
    });
    await tripService.updateExternalCollaboration("legacy-external-seehof", {
      notes: "Confirmed",
    });
    await tripService.deleteExternalCollaboration("legacy-external-seehof");

    expect(mocks.createMarketplaceExternalCollaboration).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "key:external-collaboration.create:new",
        tripId: "legacy-trip-bali",
      }),
    );
    expect(mocks.updateMarketplaceExternalCollaboration).toHaveBeenCalledWith(
      "legacy-external-seehof",
      expect.objectContaining({
        idempotencyKey: "key:external-collaboration.update:legacy-external-seehof",
      }),
    );
    expect(mocks.deleteMarketplaceExternalCollaboration).toHaveBeenCalledWith(
      "legacy-external-seehof",
      "key:external-collaboration.delete:legacy-external-seehof",
    );
  });

  it("surfaces target route failures without calling the retired legacy API", async () => {
    const routeError = { status: 404, data: { detail: "Not Found" } };
    mocks.createMarketplaceTrip.mockRejectedValue(routeError);

    await expect(
      tripService.createTrip({
        name: "Bali campaign",
        start_date: "2026-09-10",
        end_date: "2026-09-20",
      }),
    ).rejects.toBe(routeError);
  });

  it("lets a logical caller reuse its key across a separate timeout retry", async () => {
    mocks.createMarketplaceTrip.mockRejectedValueOnce(new TypeError("Network request timed out"));
    const data = {
      name: "Bali campaign",
      start_date: "2026-09-10",
      end_date: "2026-09-20",
    };
    const options = { idempotencyKey: "trip-create-submission-123" };

    await expect(tripService.createTrip(data, options)).rejects.toThrow("timed out");
    await expect(tripService.createTrip(data, options)).resolves.toMatchObject({
      id: "legacy-trip-bali",
    });

    expect(mocks.createMarketplaceTrip).toHaveBeenCalledTimes(2);
    expect(mocks.createMarketplaceTrip.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: "trip-create-submission-123",
    });
    expect(mocks.createMarketplaceTrip.mock.calls[1]?.[0]).toMatchObject({
      idempotencyKey: "trip-create-submission-123",
    });
    expect(mocks.buildMarketplaceTripIdempotencyKey).not.toHaveBeenCalled();
  });

  it("reuses a generated trip-create key after an uncertain failure and rotates after success", async () => {
    const request = {
      name: "Retry-safe Lisbon trip",
      start_date: "2026-10-01",
      end_date: "2026-10-08",
    };
    mocks.buildMarketplaceTripIdempotencyKey
      .mockReturnValueOnce("pending-trip-key")
      .mockReturnValueOnce("next-trip-key");
    mocks.createMarketplaceTrip
      .mockRejectedValueOnce(new Error("connection dropped after commit"))
      .mockResolvedValueOnce(targetTrip())
      .mockResolvedValueOnce(targetTrip());

    await expect(tripService.createTrip(request)).rejects.toThrow(
      "connection dropped after commit",
    );
    await expect(tripService.createTrip(request)).resolves.toMatchObject({
      id: "legacy-trip-bali",
    });
    await expect(tripService.createTrip(request)).resolves.toMatchObject({
      id: "legacy-trip-bali",
    });

    expect(
      mocks.createMarketplaceTrip.mock.calls.map(([payload]) => payload.idempotencyKey),
    ).toEqual(["pending-trip-key", "pending-trip-key", "next-trip-key"]);
  });

  it("reuses a generated external-collaboration create key across retries", async () => {
    const request = {
      title: "Retry-safe hotel partnership",
      hotel_name: "Hotel Seehof",
      collaboration_type: "Paid" as const,
      start_date: "2026-09-12",
      end_date: "2026-09-16",
    };
    mocks.buildMarketplaceTripIdempotencyKey.mockReturnValueOnce("pending-external-key");
    mocks.createMarketplaceExternalCollaboration
      .mockRejectedValueOnce(new Error("response was lost"))
      .mockResolvedValueOnce(targetExternalCollaboration());

    await expect(tripService.createExternalCollaboration(request)).rejects.toThrow(
      "response was lost",
    );
    await expect(tripService.createExternalCollaboration(request)).resolves.toMatchObject({
      id: "legacy-external-seehof",
    });

    expect(
      mocks.createMarketplaceExternalCollaboration.mock.calls.map(
        ([payload]) => payload.idempotencyKey,
      ),
    ).toEqual(["pending-external-key", "pending-external-key"]);
  });

  it("passes an explicit request key through unchanged", async () => {
    await tripService.createTrip({
      idempotency_key: "calendar-modal-trip-17",
      name: "Explicit key trip",
      start_date: "2026-11-01",
      end_date: "2026-11-04",
    });

    expect(mocks.createMarketplaceTrip).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "calendar-modal-trip-17" }),
    );
    expect(mocks.buildMarketplaceTripIdempotencyKey).not.toHaveBeenCalled();
  });

  it("surfaces canonical target errors without retrying a legacy API", async () => {
    const targetError = Object.assign(new Error("Marketplace trip write model is unavailable."), {
      status: 500,
      data: { code: "write_model_unavailable", category: "write_model" },
    });
    mocks.createMarketplaceTrip.mockRejectedValueOnce(targetError);

    await expect(
      tripService.createTrip({
        name: "Canonical error trip",
        start_date: "2026-12-01",
        end_date: "2026-12-04",
      }),
    ).rejects.toBe(targetError);
    expect(mocks.createMarketplaceTrip).toHaveBeenCalledTimes(1);
  });

  it("clears nullable trip fields through the target API", async () => {
    await tripService.updateTrip("legacy-trip-bali", {
      location: null,
      notes: null,
    });

    expect(mocks.updateMarketplaceTrip).toHaveBeenCalledWith(
      "legacy-trip-bali",
      expect.objectContaining({
        locationText: null,
        notes: null,
      }),
    );
  });

  it("updates and unlinks an external collaboration without losing its type", async () => {
    await tripService.updateExternalCollaboration("legacy-external-seehof", {
      trip_id: null,
      collaboration_type: "Affiliate",
      hotel_name: null,
    });

    expect(mocks.updateMarketplaceExternalCollaboration).toHaveBeenCalledWith(
      "legacy-external-seehof",
      expect.objectContaining({
        tripId: null,
        hotelName: null,
        collaborationType: "affiliate",
      }),
    );
  });
});

function targetTrip() {
  return {
    contractVersion: "marketplace-trips-external.v1",
    authorizationMode: "creator_workspace_resource_link",
    tripId: "legacy-trip-bali",
    creatorProfileId: "creator-profile-001",
    organizationId: "creator-organization-001",
    sourceTripId: "legacy-trip-bali",
    name: "Bali campaign",
    locationText: null,
    startDate: "2026-09-10",
    endDate: "2026-09-20",
    notes: null,
    externalCollaborations: [],
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}

function targetExternalCollaboration() {
  return {
    contractVersion: "marketplace-trips-external.v1",
    authorizationMode: "creator_workspace_resource_link",
    externalCollaborationId: "legacy-external-seehof",
    creatorProfileId: "creator-profile-001",
    organizationId: "creator-organization-001",
    tripId: "legacy-trip-bali",
    sourceExternalCollaborationId: "legacy-external-seehof",
    title: "Seehof winter reel",
    hotelName: "Hotel Seehof",
    locationText: "Tyrol, Austria",
    collaborationType: "custom_external",
    startDate: "2026-09-12",
    endDate: "2026-09-16",
    deliverablesSummary: "One reel",
    notes: null,
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}
