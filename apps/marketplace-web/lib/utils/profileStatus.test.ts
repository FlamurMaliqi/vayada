import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "@/services/api/client";
import { creatorService } from "@/services/api/creators";
import { hotelService } from "@/services/api/hotels";
import { checkProfileStatus } from "./profileStatus";

vi.mock("@/services/api/creators", () => ({
  creatorService: { getProfileStatus: vi.fn() },
}));

vi.mock("@/services/api/hotels", () => ({
  hotelService: { getProfileStatus: vi.fn() },
}));

describe("checkProfileStatus", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns null for missing creator profiles", async () => {
    vi.mocked(creatorService.getProfileStatus).mockRejectedValue(
      new ApiErrorResponse(404, { detail: "Creator profile was not found" }),
    );

    await expect(checkProfileStatus("creator")).resolves.toBeNull();
  });

  it("surfaces non-404 creator profile status failures", async () => {
    const error = new ApiErrorResponse(500, { detail: "Database unavailable" });
    vi.mocked(creatorService.getProfileStatus).mockRejectedValue(error);

    await expect(checkProfileStatus("creator")).rejects.toBe(error);
  });

  it("does not call marketplace profile APIs for admin users", async () => {
    await expect(checkProfileStatus("admin")).resolves.toBeNull();
    expect(creatorService.getProfileStatus).not.toHaveBeenCalled();
    expect(hotelService.getProfileStatus).not.toHaveBeenCalled();
  });
});
