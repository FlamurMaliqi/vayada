import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTES, STORAGE_KEYS } from "@/lib/constants";
import { creatorService } from "@/services/api/creators";
import { authService } from "@/services/auth";

import { getMarketplacePostLoginRedirect } from "./postLoginRedirect";
import { checkProfileStatus } from "./profileStatus";
import { resolveMarketplaceSetupGuard } from "./sharedSetupGuard";

vi.mock("./profileStatus", () => ({
  checkProfileStatus: vi.fn(),
}));

vi.mock("./sharedSetupGuard", () => ({
  resolveMarketplaceSetupGuard: vi.fn(),
}));

vi.mock("@/services/api/creators", () => ({
  creatorService: { getMyProfile: vi.fn() },
}));

vi.mock("@/services/auth", () => ({
  authService: { getSessionUser: vi.fn() },
}));

describe("getMarketplacePostLoginRedirect", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authService.getSessionUser).mockReturnValue({
      id: "creator-user",
      email: "creator@example.test",
      name: "Creator User",
      phone: "+49 89 123456",
      status: "active",
    });
    vi.mocked(creatorService.getMyProfile).mockResolvedValue(completeCreatorProfile());
  });

  it("uses the creator profile guard and persists completion state", async () => {
    vi.mocked(checkProfileStatus).mockResolvedValue({
      profile_complete: false,
      profile_photo_required: false,
      missing_fields: ["profilePicture"],
      missing_platforms: false,
      completion_steps: [],
    });
    const storage = memoryStorage({ [STORAGE_KEYS.USER_TYPE]: "creator" });

    await expect(getMarketplacePostLoginRedirect(ROUTES.MARKETPLACE, storage)).resolves.toBe(
      ROUTES.PROFILE_COMPLETE,
    );
    expect(storage.getItem(STORAGE_KEYS.PROFILE_COMPLETE)).toBe("false");
  });

  it("returns creators with missing required contact details to onboarding", async () => {
    vi.mocked(authService.getSessionUser).mockReturnValue({
      id: "creator-user",
      email: "creator@example.test",
      name: "Creator User",
      phone: null,
      status: "active",
    });
    vi.mocked(checkProfileStatus).mockResolvedValue({
      profile_complete: true,
      profile_photo_required: false,
      missing_fields: [],
      missing_platforms: false,
      completion_steps: [],
    });
    const storage = memoryStorage({ [STORAGE_KEYS.USER_TYPE]: "creator" });

    await expect(getMarketplacePostLoginRedirect(ROUTES.MARKETPLACE, storage)).resolves.toBe(
      ROUTES.ONBOARDING,
    );
    expect(storage.getItem(STORAGE_KEYS.PROFILE_COMPLETE)).toBe("false");
  });

  it("returns creators with a missing photo to account details", async () => {
    vi.mocked(creatorService.getMyProfile).mockResolvedValue({
      ...completeCreatorProfile(),
      profilePicture: null,
      profilePictureMediaObjectId: null,
    });
    vi.mocked(checkProfileStatus).mockResolvedValue({
      profile_complete: true,
      profile_photo_required: false,
      missing_fields: [],
      missing_platforms: false,
      completion_steps: [],
    });
    const storage = memoryStorage({ [STORAGE_KEYS.USER_TYPE]: "creator" });

    await expect(getMarketplacePostLoginRedirect(ROUTES.MARKETPLACE, storage)).resolves.toBe(
      ROUTES.ONBOARDING,
    );
    expect(storage.getItem(STORAGE_KEYS.PROFILE_COMPLETE)).toBe("false");
  });

  it("treats a failed creator profile fetch as incomplete account details", async () => {
    vi.mocked(creatorService.getMyProfile).mockRejectedValue(new Error("profile unavailable"));
    vi.mocked(checkProfileStatus).mockResolvedValue({
      profile_complete: true,
      profile_photo_required: false,
      missing_fields: [],
      missing_platforms: false,
      completion_steps: [],
    });
    const storage = memoryStorage({ [STORAGE_KEYS.USER_TYPE]: "creator" });

    await expect(getMarketplacePostLoginRedirect(ROUTES.MARKETPLACE, storage)).resolves.toBe(
      ROUTES.ONBOARDING,
    );
    expect(storage.getItem(STORAGE_KEYS.PROFILE_COMPLETE)).toBe("false");
  });

  it("uses the marketplace setup guard for hotel users", async () => {
    vi.mocked(resolveMarketplaceSetupGuard).mockResolvedValue({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath: "/setup?entryProduct=marketplace",
      setupAction: "complete_product_activation",
      product: "marketplace",
      productStatus: "selected_incomplete",
      missingSteps: [],
    });
    const storage = memoryStorage({ [STORAGE_KEYS.USER_TYPE]: "hotel" });

    await expect(getMarketplacePostLoginRedirect(ROUTES.MARKETPLACE, storage)).resolves.toBe(
      "/setup?entryProduct=marketplace",
    );
    expect(storage.getItem(STORAGE_KEYS.PROFILE_COMPLETE)).toBe("false");
  });
});

function completeCreatorProfile() {
  return {
    id: "creator-profile",
    email: "creator@example.test",
    name: "Creator User",
    location: "Berlin",
    shortDescription: "Independent travel stories.",
    portfolioLink: null,
    phone: "+49 89 123456",
    profilePicture: "https://media.example/creator.png",
    profilePictureMediaObjectId: "media-creator",
    creatorType: "Travel" as const,
    platforms: [],
    audienceSize: 0,
    rating: { averageRating: 0, totalReviews: 0 },
    status: "pending" as const,
    createdAt: new Date("2026-07-15T10:00:00.000Z"),
    updatedAt: new Date("2026-07-15T10:00:00.000Z"),
  };
}

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
