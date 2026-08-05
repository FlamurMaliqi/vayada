import { describe, expect, it } from "vitest";
import {
  createSharedAccountProfileImageUploader,
  isSharedAccountDetailsComplete,
  isValidSharedAccountPhone,
  normalizeSharedAccountName,
  sharedAccountInitials,
  sharedAccountProfileImageError,
  splitSharedAccountName,
} from "@vayada/product-onboarding";

describe("shared account details", () => {
  it("requires a full name and valid phone without requiring hotel-manager media", () => {
    expect(isSharedAccountDetailsComplete(null)).toBe(false);
    expect(isSharedAccountDetailsComplete({ name: "Flamur" })).toBe(false);
    expect(isSharedAccountDetailsComplete({ name: "Flamur Maliqi" })).toBe(false);
    expect(
      isSharedAccountDetailsComplete({
        name: "Flamur Maliqi",
        profilePictureUrl: "https://media.example/profile.webp",
        profilePictureMediaObjectId: "media-profile-1",
      }),
    ).toBe(false);
    expect(
      isSharedAccountDetailsComplete({
        name: "Flamur Maliqi",
        phone: "not-a-phone",
        profilePictureUrl: "https://media.example/profile.webp",
        profilePictureMediaObjectId: "media-profile-1",
      }),
    ).toBe(false);
    expect(isSharedAccountDetailsComplete({ name: "Flamur Maliqi", phone: "+49 89 123456" })).toBe(
      true,
    );
  });

  it("validates optional phone numbers by format and digit count", () => {
    expect(isValidSharedAccountPhone("")).toBe(true);
    expect(isValidSharedAccountPhone("+49 89 123456")).toBe(true);
    expect(isValidSharedAccountPhone("(212) 555-0198")).toBe(true);
    expect(isValidSharedAccountPhone("sdfdsfsfsdfdsf")).toBe(false);
    expect(isValidSharedAccountPhone("+49 12")).toBe(false);
  });

  it("prefills first name and keeps the remaining name as the last name", () => {
    expect(splitSharedAccountName("  Ada   Byron Lovelace ")).toEqual({
      firstName: "Ada",
      lastName: "Byron Lovelace",
    });
  });

  it("normalizes the persisted full name", () => {
    expect(normalizeSharedAccountName(" Ada ", " Byron  Lovelace ")).toBe("Ada Byron Lovelace");
    expect(normalizeSharedAccountName("Ada", "")).toBe("Ada");
    expect(normalizeSharedAccountName("", "Lovelace")).toBe("Lovelace");
  });

  it("renders stable manager initials without using property media", () => {
    expect(sharedAccountInitials(" Flamur ", " Maliqi ")).toBe("FM");
    expect(sharedAccountInitials("", "")).toBe("?");
  });

  it("accepts supported profile photos within the shared 5 MB limit", () => {
    expect(
      sharedAccountProfileImageError(new File(["profile"], "profile.webp", { type: "image/webp" })),
    ).toBeNull();
    expect(
      sharedAccountProfileImageError(new File(["profile"], "profile.gif", { type: "image/gif" })),
    ).toBe("Choose a JPG, PNG, or WebP image.");
    expect(sharedAccountProfileImageError(new File(["profile"], "camera.HEIC", { type: "" }))).toBe(
      "HEIC and HEIF photos aren’t supported yet. Convert the photo to JPG, PNG, or WebP and try again.",
    );
    expect(sharedAccountProfileImageError(new File(["profile"], "camera.JPG"))).toBeNull();
    expect(sharedAccountProfileImageError(new File([], "empty.png", { type: "image/png" }))).toBe(
      "Choose an image that isn’t empty.",
    );
    expect(
      sharedAccountProfileImageError(
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
      ),
    ).toBe("Choose an image smaller than 5 MB.");
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

  it("uses inferred mobile MIME consistently for account photo create and finalize", async () => {
    const requests: Array<{ endpoint: string; data: unknown }> = [];
    const responses = [
      {
        uploadSession: { sessionId: "mobile-session" },
        uploadTargets: [
          {
            uploadTargetId: "mobile-target",
            method: "PUT" as const,
            uploadUrl: "https://uploads.vayada.localhost/deterministic",
            headers: {},
          },
        ],
      },
      {
        mediaObjects: [
          {
            mediaId: "mobile-media",
            storageKey: "profiles/mobile.png",
            variants: [{ publicCdnUrl: "https://cdn.example.test/mobile.png" }],
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

    await uploader("user_mobile", new File(["profile"], "camera.png"));

    expect(requests[0]?.data).toMatchObject({
      files: [{ contentType: "image/png" }],
    });
    expect(requests[1]?.data).toMatchObject({
      files: [{ contentType: "image/png" }],
    });
  });

  it("does not persist a profile photo until a public variant exists", async () => {
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
            variants: [{ publicCdnUrl: null }],
          },
        ],
      },
    ];
    const uploader = createSharedAccountProfileImageUploader({
      post: async <T>() => responses.shift() as T,
    });

    await expect(
      uploader("user-owner", new File(["profile"], "profile.webp", { type: "image/webp" })),
    ).rejects.toThrow("The profile image is still processing. Please try again later.");
  });
});
