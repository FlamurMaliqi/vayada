import { describe, expect, it } from "vitest";
import {
  createSharedAccountProfileImageUploader,
  isSharedAccountDetailsComplete,
  normalizeSharedAccountName,
  sharedAccountProfileImageError,
  splitSharedAccountName,
} from "@vayada/product-onboarding";

describe("shared account details", () => {
  it("requires both first and last name before skipping the shared step", () => {
    expect(isSharedAccountDetailsComplete(null)).toBe(false);
    expect(isSharedAccountDetailsComplete("Flamur")).toBe(false);
    expect(isSharedAccountDetailsComplete("Flamur Maliqi")).toBe(true);
  });

  it("prefills first name and keeps the remaining name as the last name", () => {
    expect(splitSharedAccountName("  Ada   Byron Lovelace ")).toEqual({
      firstName: "Ada",
      lastName: "Byron Lovelace",
    });
  });

  it("normalizes the persisted full name", () => {
    expect(normalizeSharedAccountName(" Ada ", " Byron  Lovelace ")).toBe("Ada Byron Lovelace");
  });

  it("accepts supported profile photos within the shared 5 MB limit", () => {
    expect(
      sharedAccountProfileImageError(new File(["profile"], "profile.webp", { type: "image/webp" })),
    ).toBeNull();
    expect(
      sharedAccountProfileImageError(new File(["profile"], "profile.gif", { type: "image/gif" })),
    ).toBe("Choose a JPG, PNG, or WebP image.");
  });

  it("uploads an account photo against the signed-in user's shared profile", async () => {
    const requests: Array<{ endpoint: string; data: unknown }> = [];
    const responses = [
      {
        uploadSession: { sessionId: "upload-session-1" },
        uploadTargets: [
          {
            uploadTargetId: "upload-target-1",
            method: "PUT",
            uploadUrl: "https://uploads.vayada.localhost/upload-session-1",
            headers: {},
          },
        ],
      },
      {
        mediaObjects: [
          {
            mediaId: "media-profile-1",
            storageKey: "staging/upload-session-1/profile.webp",
            variants: [{ publicCdnUrl: "https://media.example/profile.webp" }],
          },
        ],
      },
    ];
    const uploader = createSharedAccountProfileImageUploader({
      post: async <T>(endpoint: string, data?: unknown) => {
        requests.push({ endpoint, data });
        return responses.shift() as T;
      },
    });

    await expect(
      uploader("user-owner", new File(["profile"], "profile.webp", { type: "image/webp" })),
    ).resolves.toEqual({
      profilePictureUrl: "https://media.example/profile.webp",
      profilePictureMediaObjectId: "media-profile-1",
    });
    expect(requests[0]).toMatchObject({
      endpoint: "/api/media/upload-sessions",
      data: {
        purpose: "identity.user.profile_image",
        resource: {
          product: "platform",
          resourceType: "user_profile",
          resourceId: "user-owner",
        },
      },
    });
  });
});
