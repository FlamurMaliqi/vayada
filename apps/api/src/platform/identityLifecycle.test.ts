import type { UpdateIdentityUserProfileCommand } from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import { membershipPermissionGrantRows, updateIdentityUserProfile } from "./identityLifecycle.js";

describe("identity lifecycle writer", () => {
  it("maps membership permission keys to role grants", () => {
    expect(
      membershipPermissionGrantRows({
        organization: {
          kind: "hotel_group",
          name: "Alpenrose Hotel Group",
        },
        membership: {
          roleKey: "hotel_owner",
          propertyAccessMode: "all",
          permissionKeys: ["hotel_catalog.setup.read", "hotel_catalog.setup.manage"],
        },
      }),
    ).toEqual([
      {
        organizationKind: "hotel_group",
        roleKey: "hotel_owner",
        permissionKey: "hotel_catalog.setup.read",
      },
      {
        organizationKind: "hotel_group",
        roleKey: "hotel_owner",
        permissionKey: "hotel_catalog.setup.manage",
      },
    ]);
  });

  it("distinguishes omitted profile pictures from explicit clears", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const command: UpdateIdentityUserProfileCommand = {
      commandType: "identity.user.profile.update",
      commandId: "command_profile_clear",
      idempotencyKey: "profile-clear-user_1",
      audit: {
        actor: { kind: "user", userId: "user_1" },
        source: "web",
        requestId: "request_profile_clear",
        reason: "Clear profile picture",
        requestedAt: "2026-07-16T10:00:00.000Z",
      },
      payload: {
        userId: "user_1",
        profilePictureUrl: null,
        profilePictureMediaObjectId: null,
      },
    };

    await updateIdentityUserProfile({ query } as never, command);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHEN $5::boolean"), [
      "user_1",
      null,
      false,
      null,
      true,
      null,
      true,
      null,
    ]);

    await updateIdentityUserProfile({ query } as never, {
      ...command,
      payload: { userId: "user_1" },
    });

    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("WHEN $5::boolean"), [
      "user_1",
      null,
      false,
      null,
      false,
      null,
      false,
      null,
    ]);
  });
});
