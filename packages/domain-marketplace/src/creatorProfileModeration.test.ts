import { describe, expect, it } from "vitest";

import {
  canModerateMarketplaceCreatorProfile,
  isMarketplaceCreatorModerationReason,
  isMarketplaceCreatorModerationTargetStatus,
  isMarketplaceCreatorProfileStatus,
} from "./creatorProfileModeration.js";

describe("creator profile moderation contract", () => {
  it.each([
    ["pending", "active"],
    ["pending", "rejected"],
    ["pending", "archived"],
    ["active", "suspended"],
    ["active", "archived"],
    ["rejected", "active"],
    ["rejected", "archived"],
    ["suspended", "active"],
    ["suspended", "archived"],
  ] as const)("allows %s -> %s", (currentStatus, nextStatus) => {
    expect(canModerateMarketplaceCreatorProfile(currentStatus, nextStatus)).toBe(true);
  });

  it.each([
    ["active", "rejected"],
    ["rejected", "suspended"],
    ["archived", "active"],
  ] as const)("rejects %s -> %s", (currentStatus, nextStatus) => {
    expect(canModerateMarketplaceCreatorProfile(currentStatus, nextStatus)).toBe(false);
  });

  it("keeps pending a stored state but not a moderation target", () => {
    expect(isMarketplaceCreatorProfileStatus("pending")).toBe(true);
    expect(isMarketplaceCreatorModerationTargetStatus("pending")).toBe(false);
  });

  it.each(["reason\u0000", "reason\u000a", "reason\ud800", "reason\udc00"])(
    "rejects a JSONB-incompatible reason %#",
    (reason) => {
      expect(isMarketplaceCreatorModerationReason(reason)).toBe(false);
    },
  );
});
