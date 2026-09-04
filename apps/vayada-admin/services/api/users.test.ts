import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  createOffer: vi.fn(),
  deleteOffer: vi.fn(),
  getCreatorReview: vi.fn(),
  getHotelReview: vi.fn(),
  updateOffer: vi.fn(),
  verifyOffer: vi.fn(),
}));
const hotelIdentityUser = {
  id: "user-hotel",
  email: "hotel@example.test",
  name: "Hotel",
  type: "hotel",
  status: "verified",
  emailVerified: true,
  avatar: null,
  createdAt: "2026-06-12T10:00:00.000Z",
  updatedAt: "2026-06-13T10:00:00.000Z",
  profile: null,
};
const creatorIdentityUser = { ...hotelIdentityUser, id: "user-creator", type: "creator" };
const creatorReview = {
  moderation: { allowed: true, allowedTransitions: ["active", "rejected", "archived"] },
  profile: {
    creatorProfileId: "creator-profile-801",
    locationText: "Vienna",
    shortDescription: null,
    portfolioUrl: null,
    phone: null,
    profilePictureUrl: "https://cdn.example.test/creator.webp",
    profilePictureMediaObjectId: "media-creator-801",
    profileComplete: true,
    profileCompletedAt: "2026-06-13T10:00:00.000Z",
    profileStatus: "pending",
    createdAt: "2026-06-12T10:00:00.000Z",
    updatedAt: "2026-06-13T10:00:00.000Z",
    platforms: [
      {
        platformId: "platform-instagram",
        platform: "instagram",
        handle: "lina",
        profileUrl: "https://instagram.example.test/lina",
        followerCount: 100,
        engagementRate: 4,
        audienceAgeGroups: [{ ageRange: "18-24", percentage: 70 }],
        audienceGenderSplit: { male: 30, female: 60, other: 10 },
        createdAt: "2026-06-12T10:00:00.000Z",
        updatedAt: "2026-06-13T10:00:00.000Z",
      },
      {
        platformId: "platform-instagram-travel",
        platform: "instagram",
        handle: "lina-travel",
        profileUrl: "https://instagram.example.test/lina-travel",
        followerCount: 25,
        engagementRate: 2,
        createdAt: "2026-06-12T10:00:00.000Z",
        updatedAt: "2026-06-13T10:00:00.000Z",
      },
    ],
  },
};

vi.mock("./client", () => ({
  apiClient: { get: mocks.get, post: vi.fn(), patch: vi.fn(), put: mocks.put, delete: vi.fn() },
}));
vi.mock("@vayada/marketplace-shared/api/admin", () => ({
  createMarketplaceAdminOffer: mocks.createOffer,
  deleteMarketplaceAdminOffer: mocks.deleteOffer,
  getMarketplaceAdminCreatorReview: mocks.getCreatorReview,
  getMarketplaceAdminHotelReview: mocks.getHotelReview,
  updateMarketplaceAdminOffer: mocks.updateOffer,
  verifyMarketplaceAdminOffer: mocks.verifyOffer,
}));

import { usersService } from "./users";

describe("usersService media writes", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("persists creator media by object ID", async () => {
    mocks.put.mockResolvedValue({ updatedAt: "2026-09-01T00:00:00.000Z" });

    await usersService.updateCreatorProfile("user-creator", {
      profilePictureMediaObjectId: "media-creator",
    });

    expect(mocks.put).toHaveBeenCalledWith(
      "/api/marketplace/admin/users/user-creator/profile/creator",
      { profilePictureMediaObjectId: "media-creator" },
    );
  });

  it("does not send an empty creator profile update", async () => {
    await expect(usersService.updateCreatorProfile("user-creator", {})).resolves.toEqual({});
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("returns the created offer ID needed to scope subsequent media uploads", async () => {
    const offer = { offerId: "offer-801" };
    mocks.createOffer.mockResolvedValue(offer);

    await expect(
      usersService.createOffer("user-hotel", {
        name: "Creator stay",
        location: "Vienna",
        description: "A creator-ready stay.",
      }),
    ).resolves.toBe(offer);
  });

  it("hydrates the exact creator profile and its persisted media ID", async () => {
    mocks.get.mockResolvedValue(creatorIdentityUser);
    mocks.getCreatorReview.mockResolvedValue(creatorReview);

    await expect(usersService.getUserById("user-creator")).resolves.toMatchObject({
      creatorModeration: {
        allowed: true,
        allowedTransitions: ["active", "rejected", "archived"],
      },
      profile: {
        id: "creator-profile-801",
        profileStatus: "pending",
        profilePictureMediaObjectId: "media-creator-801",
        platforms: [
          { id: "platform-instagram", name: "Instagram", handle: "lina" },
          { id: "platform-instagram-travel", name: "Instagram", handle: "lina-travel" },
        ],
      },
    });
  });

  it("retains offer media IDs and forwards only selected IDs for publication", async () => {
    mocks.get.mockResolvedValue(hotelIdentityUser);
    mocks.getHotelReview.mockResolvedValue({
      profile: {
        propertyId: "property-801",
        location: "Vienna",
      },
      offers: [
        {
          offerId: "offer-801",
          propertyId: "property-801",
          title: "Creator stay",
          offerSummary: null,
          offerStatus: "verified",
          media: [
            {
              mediaObjectId: "media-offer-801",
              url: "https://cdn.example.test/offer.webp",
              approvalStatus: "approved",
              lifecycleStatus: "active",
            },
          ],
          deliverables: [],
          compensationOptions: [],
          creatorRequirements: null,
          createdAt: "2026-06-12T10:00:00.000Z",
          updatedAt: "2026-06-13T10:00:00.000Z",
        },
      ],
    });

    const user = await usersService.getUserById("user-hotel");
    expect(user.profile).toMatchObject({
      listings: [
        {
          media: [{ mediaObjectId: "media-offer-801" }],
          images: ["https://cdn.example.test/offer.webp"],
        },
      ],
    });

    await usersService.verifyOffer("user-hotel", "offer-801", ["media-offer-801"]);
    expect(mocks.verifyOffer).toHaveBeenCalledWith("user-hotel", "offer-801", ["media-offer-801"]);
  });
});
