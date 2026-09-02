import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ moderate: vi.fn() }));

vi.mock("@vayada/marketplace-shared/api/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vayada/marketplace-shared/api/admin")>()),
  moderateMarketplaceAdminCreatorProfile: mocks.moderate,
}));

import {
  createCreatorModerationIdempotencyKey,
  creatorModerationFailure,
  creatorModerationReasonError,
  getCreatorModerationActions,
  moderateCreatorProfile,
} from "./creatorModeration";

describe("creator moderation service", () => {
  beforeEach(() => {
    mocks.moderate.mockReset();
  });

  it.each([
    ["pending", ["active", "rejected", "archived"], ["active", "rejected", "archived"]],
    ["pending", ["rejected", "archived"], ["rejected", "archived"]],
    ["active", ["suspended", "archived"], ["suspended", "archived"]],
    ["rejected", ["active", "archived"], ["active", "archived"]],
    ["suspended", ["active", "archived"], ["active", "archived"]],
    ["archived", [], []],
  ] as const)("offers only server-authorized transitions from %s", (status, allowed, expected) => {
    expect(getCreatorModerationActions(status, allowed).map((action) => action.nextStatus)).toEqual(
      expected,
    );
  });

  it("requires a bounded audit reason", () => {
    expect(creatorModerationReasonError("   ")).toBe("Enter a reason for this decision.");
    expect(creatorModerationReasonError("a".repeat(1001))).toContain("1,000");
    expect(creatorModerationReasonError("first line\nsecond line")).toContain("single line");
    expect(creatorModerationReasonError("reason\twith tab")).toContain("single line");
    expect(creatorModerationReasonError("malformed \ud800")).toContain("single line");
    expect(creatorModerationReasonError("👍 reviewed")).toBeNull();
    expect(creatorModerationReasonError("Reviewed and approved.")).toBeNull();
  });

  it("sends the expected state, trimmed reason, and idempotency key", async () => {
    mocks.moderate.mockResolvedValue({ profileStatus: "active" });

    await moderateCreatorProfile({
      creatorProfileId: "creator-profile-1419",
      currentStatus: "pending",
      nextStatus: "active",
      reason: "  Profile reviewed and approved.  ",
      idempotencyKey: "moderation-key-1419",
    });

    expect(mocks.moderate).toHaveBeenCalledWith(
      "creator-profile-1419",
      {
        expectedStatus: "pending",
        nextStatus: "active",
        reason: "Profile reviewed and approved.",
      },
      "moderation-key-1419",
    );
  });

  it("creates a scoped idempotency key", () => {
    expect(createCreatorModerationIdempotencyKey("creator/profile", "suspended")).toMatch(
      /^marketplace\.admin\.creator\.suspended:creator_profile:.+:v1$/,
    );
  });

  it("returns the server state when a stale moderation request conflicts", () => {
    expect(
      creatorModerationFailure({
        status: 409,
        data: { code: "profile_status_conflict", currentStatus: "suspended" },
      }),
    ).toEqual({
      message: "This profile changed elsewhere. Review its refreshed state before trying again.",
      currentStatus: "suspended",
      refreshRequired: true,
    });
  });

  it("maps authorization and profile-completeness failures to useful feedback", () => {
    expect(creatorModerationFailure({ status: 403, data: {} }).message).toContain("permission");
    expect(
      creatorModerationFailure({ status: 409, data: { code: "profile_incomplete" } }),
    ).toMatchObject({ refreshRequired: true, message: expect.stringContaining("incomplete") });
    expect(
      creatorModerationFailure({ status: 404, data: { code: "creator_profile_not_found" } }),
    ).toMatchObject({
      refreshRequired: true,
      message: expect.stringContaining("no longer exists"),
    });
  });
});
