import { describe, expect, it } from "vitest";

import { ROUTES } from "@/lib/constants";
import { getPostLoginProfileRedirect } from "./profileRedirect";

describe("getPostLoginProfileRedirect", () => {
  it("keeps complete hotel users in the marketplace", () => {
    expect(
      getPostLoginProfileRedirect("hotel", {
        profile_complete: true,
        missing_fields: [],
        has_defaults: { location: false },
        missing_offers: false,
        completion_steps: [],
      }),
    ).toEqual({
      redirectPath: ROUTES.MARKETPLACE,
      profileComplete: true,
    });
  });

  it("sends incomplete hotel users to profile completion", () => {
    expect(
      getPostLoginProfileRedirect("hotel", {
        profile_complete: false,
        missing_fields: ["profile"],
        has_defaults: { location: false },
        missing_offers: true,
        completion_steps: ["Complete your marketplace hotel profile"],
      }),
    ).toEqual({
      redirectPath: ROUTES.PROFILE_COMPLETE,
      profileComplete: false,
    });
  });

  it.each(["hotel", "creator"] as const)(
    "treats missing %s profile status as incomplete",
    (userType) => {
      expect(getPostLoginProfileRedirect(userType, null)).toEqual({
        redirectPath: ROUTES.PROFILE_COMPLETE,
        profileComplete: false,
      });
    },
  );

  it("does not persist profile completion state for users outside marketplace profiles", () => {
    expect(getPostLoginProfileRedirect(null, null)).toEqual({
      redirectPath: ROUTES.MARKETPLACE,
      profileComplete: null,
    });
  });
});
