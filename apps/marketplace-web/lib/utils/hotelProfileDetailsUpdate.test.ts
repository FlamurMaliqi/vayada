import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProfileHotelProfile } from "@/components/profile/types";
import { ApiErrorResponse } from "@/services/api/client";
import { buildHotelProfileDetailsUpdate, profileSaveErrorMessage } from "@/hooks/useHotelProfile";

describe("hotel profile details updates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not publish the signed-in account email during a photo and details save", () => {
    const businessEmail = "reception@alpenrose.example";
    const accountEmail = "owner.personal@example.com";
    const getItem = vi.fn(() => accountEmail);
    vi.stubGlobal("localStorage", { getItem });

    const profile: ProfileHotelProfile = {
      id: "property-one",
      canonicalProfileRevision: 3,
      publicProfileRevision: 3,
      name: "Hotel Alpenrose",
      picture: "https://cdn.example/old-cover.jpg",
      location: "Munich, Germany",
      localityPublic: true,
      status: "verified",
      website: "https://alpenrose.example",
      about: "Our original creator-facing introduction.",
      email: businessEmail,
      phone: "+49 89 123456",
      listings: [],
    };

    const payload = buildHotelProfileDetailsUpdate(
      profile,
      {
        name: "Hotel Alpenrose Munich",
        picture: profile.picture!,
        location: profile.location,
        localityPublic: profile.localityPublic,
        website: profile.website!,
        about: "Our updated creator-facing introduction.",
      },
      profile.phone!,
      {
        url: "https://cdn.example/new-cover.jpg",
        mediaObjectId: "media-one",
      },
    );

    expect(accountEmail).not.toBe(businessEmail);
    expect(getItem).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      name: "Hotel Alpenrose Munich",
      about: "Our updated creator-facing introduction.",
      picture: "https://cdn.example/new-cover.jpg",
      pictureMediaObjectId: "media-one",
      picture_media_object_id: "media-one",
    });
    expect(payload).not.toHaveProperty("email");
  });

  it("includes an explicit locality consent revocation", () => {
    const profile: ProfileHotelProfile = {
      id: "property-one",
      canonicalProfileRevision: 3,
      publicProfileRevision: 3,
      name: "Hotel Alpenrose",
      location: "Munich, Germany",
      localityPublic: true,
      status: "verified",
      website: "https://alpenrose.example",
      about: "Our original creator-facing introduction.",
      email: "reception@alpenrose.example",
      phone: "+49 89 123456",
      listings: [],
    };

    expect(
      buildHotelProfileDetailsUpdate(
        profile,
        {
          name: profile.name,
          picture: "",
          location: profile.location,
          localityPublic: false,
          website: profile.website!,
          about: profile.about!,
        },
        profile.phone!,
      ),
    ).toEqual({ localityPublic: false });
  });

  it("sends null when optional public text fields are cleared", () => {
    const profile: ProfileHotelProfile = {
      id: "property-one",
      canonicalProfileRevision: 3,
      publicProfileRevision: 3,
      name: "Hotel Alpenrose",
      location: "Munich, Germany",
      localityPublic: true,
      status: "verified",
      website: "https://alpenrose.example",
      about: "Our original creator-facing introduction.",
      email: "reception@alpenrose.example",
      listings: [],
    };

    expect(
      buildHotelProfileDetailsUpdate(
        profile,
        {
          name: profile.name,
          picture: "",
          location: profile.location,
          localityPublic: profile.localityPublic,
          website: "",
          about: "",
        },
        "",
      ),
    ).toEqual({ website: null, about: null });
  });

  it("prioritizes the actionable revision-conflict message over API detail", () => {
    expect(
      profileSaveErrorMessage(
        new ApiErrorResponse(409, {
          code: "profile_revision_conflict",
          detail: "Expected revision 3 but found revision 4.",
        }),
        "Failed to save profile",
      ),
    ).toBe(
      "This hotel profile changed in another tab. Refresh the page and make your changes again.",
    );
  });
});
