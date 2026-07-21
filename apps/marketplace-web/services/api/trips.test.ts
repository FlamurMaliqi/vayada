import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildMarketplaceTripIdempotencyKey: vi.fn(),
  createMarketplaceTrip: vi.fn(),
  updateMarketplaceTrip: vi.fn(),
  deleteMarketplaceTrip: vi.fn(),
  createMarketplaceExternalCollaboration: vi.fn(),
  updateMarketplaceExternalCollaboration: vi.fn(),
  deleteMarketplaceExternalCollaboration: vi.fn(),
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
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

vi.mock("./client", () => ({ apiClient: mocks.apiClient }));

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

  it("reuses the same caller key when the target route falls back to legacy", async () => {
    mocks.createMarketplaceTrip.mockRejectedValue({ status: 404, data: { detail: "Not Found" } });
    mocks.apiClient.post.mockResolvedValue({ id: "legacy-created" });

    await tripService.createTrip({
      name: "Bali campaign",
      start_date: "2026-09-10",
      end_date: "2026-09-20",
    });

    expect(mocks.createMarketplaceTrip).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "key:trip.create:new" }),
    );
    expect(mocks.apiClient.post).toHaveBeenCalledWith(
      "/trips",
      expect.objectContaining({ name: "Bali campaign" }),
      { headers: { "Idempotency-Key": "key:trip.create:new" } },
    );
    expect(mocks.buildMarketplaceTripIdempotencyKey).toHaveBeenCalledTimes(1);
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
