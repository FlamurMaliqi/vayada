import { describe, expect, it } from "vitest";

import {
  creatorIdentityPhotoPatch,
  hasRequiredCreatorAccountDetails,
  hasRequiredCreatorContactDetails,
  resolveCreatorContactDetails,
} from "./creatorAccountRequirements";

const photo = {
  profilePicture: "https://cdn.example.com/creator.webp",
  profilePictureMediaObjectId: "media_creator_001",
};

describe("creator account requirements", () => {
  it("requires a full name and valid phone", () => {
    expect(hasRequiredCreatorContactDetails({ name: "Lina Berg", phone: "+49 89 123456" })).toBe(
      true,
    );
    expect(hasRequiredCreatorContactDetails({ name: "Lina Berg", phone: "not-a-phone" })).toBe(
      false,
    );
    expect(hasRequiredCreatorContactDetails({ name: "Lina", phone: "+49 89 123456" })).toBe(false);
  });

  it("also requires canonical profile media", () => {
    expect(
      hasRequiredCreatorAccountDetails({ name: "Lina Berg", phone: "+49 89 123456" }, photo),
    ).toBe(true);
    expect(
      hasRequiredCreatorAccountDetails(
        { name: "Lina Berg", phone: "+49 89 123456" },
        { ...photo, profilePictureMediaObjectId: null },
      ),
    ).toBe(false);
  });

  it("accepts canonical identity media when the creator profile has no photo yet", () => {
    expect(
      hasRequiredCreatorAccountDetails(
        {
          name: "Lina Berg",
          phone: "+49 89 123456",
          profilePictureUrl: photo.profilePicture,
          profilePictureMediaObjectId: photo.profilePictureMediaObjectId,
        },
        { profilePicture: null, profilePictureMediaObjectId: null },
      ),
    ).toBe(true);
  });

  it("falls back to canonical identity contact details during creator hydration", () => {
    expect(
      resolveCreatorContactDetails(
        { name: "Lina Berg", phone: "+49 89 123456" },
        { name: "", phone: null },
      ),
    ).toEqual({ name: "Lina Berg", phone: "+49 89 123456" });
    expect(
      resolveCreatorContactDetails(
        { name: "Identity Name", phone: "+49 89 111111" },
        { name: "Creator Name", phone: "+49 89 222222" },
      ),
    ).toEqual({ name: "Creator Name", phone: "+49 89 222222" });
  });

  it("persists the canonical identity media ID only when the creator profile lacks one", () => {
    const identity = {
      profilePictureUrl: "https://cdn.example.com/identity.webp",
      profilePictureMediaObjectId: "media_identity_001",
    };

    expect(creatorIdentityPhotoPatch(identity, {})).toEqual({
      profilePictureMediaObjectId: "media_identity_001",
    });
    expect(
      creatorIdentityPhotoPatch(identity, {
        profilePicture: "https://cdn.example.com/creator-existing.webp",
        profilePictureMediaObjectId: "media_creator_existing",
      }),
    ).toEqual({});
    expect(
      creatorIdentityPhotoPatch(identity, {
        profilePicture: null,
        profilePictureMediaObjectId: "media_creator_stale",
      }),
    ).toEqual({ profilePictureMediaObjectId: "media_identity_001" });
    expect(
      creatorIdentityPhotoPatch(
        { ...identity, profilePictureUrl: null },
        { profilePictureMediaObjectId: null },
      ),
    ).toEqual({});
  });
});
