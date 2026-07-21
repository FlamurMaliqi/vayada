import { afterEach, describe, expect, it, vi } from "vitest";

import { vayadaApiClient } from "@vayada/marketplace-shared/api/client";
import {
  createMarketplaceExternalCollaboration,
  createMarketplaceTrip,
  deleteMarketplaceExternalCollaboration,
  deleteMarketplaceTrip,
  updateMarketplaceExternalCollaboration,
  updateMarketplaceTrip,
} from "@vayada/marketplace-shared/api/trips";

afterEach(() => vi.restoreAllMocks());

describe("marketplace trip typed client", () => {
  it("sends caller idempotency keys as headers and omits them from JSON bodies", async () => {
    const post = vi.spyOn(vayadaApiClient, "post").mockResolvedValue({});
    const put = vi.spyOn(vayadaApiClient, "put").mockResolvedValue({});
    const remove = vi.spyOn(vayadaApiClient, "delete").mockResolvedValue(undefined);

    await createMarketplaceTrip({
      idempotencyKey: "trip-create-key",
      name: "Bali campaign",
      startDate: "2026-09-10",
      endDate: "2026-09-20",
    });
    await updateMarketplaceTrip("trip-1", {
      idempotencyKey: "trip-update-key",
      name: "Bali launch",
    });
    await deleteMarketplaceTrip("trip-1", "trip-delete-key");
    await createMarketplaceExternalCollaboration({
      idempotencyKey: "external-create-key",
      title: "Seehof reel",
      startDate: "2026-09-12",
      endDate: "2026-09-16",
    });
    await updateMarketplaceExternalCollaboration("external-1", {
      idempotencyKey: "external-update-key",
      notes: "Confirmed",
    });
    await deleteMarketplaceExternalCollaboration("external-1", "external-delete-key");

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/api/marketplace/trips",
      expect.not.objectContaining({ idempotencyKey: expect.anything() }),
      { headers: { "Idempotency-Key": "trip-create-key" } },
    );
    expect(put).toHaveBeenNthCalledWith(
      1,
      "/api/marketplace/trips/trip-1",
      expect.not.objectContaining({ idempotencyKey: expect.anything() }),
      { headers: { "Idempotency-Key": "trip-update-key" } },
    );
    expect(remove).toHaveBeenNthCalledWith(1, "/api/marketplace/trips/trip-1", {
      headers: { "Idempotency-Key": "trip-delete-key" },
    });
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/api/marketplace/trips/external-collaborations",
      expect.not.objectContaining({ idempotencyKey: expect.anything() }),
      { headers: { "Idempotency-Key": "external-create-key" } },
    );
    expect(put).toHaveBeenNthCalledWith(
      2,
      "/api/marketplace/trips/external-collaborations/external-1",
      expect.not.objectContaining({ idempotencyKey: expect.anything() }),
      { headers: { "Idempotency-Key": "external-update-key" } },
    );
    expect(remove).toHaveBeenNthCalledWith(
      2,
      "/api/marketplace/trips/external-collaborations/external-1",
      { headers: { "Idempotency-Key": "external-delete-key" } },
    );
  });
});
