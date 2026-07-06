import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTES, STORAGE_KEYS } from "@/lib/constants";

import { getMarketplacePostLoginRedirect } from "./postLoginRedirect";
import { checkProfileStatus } from "./profileStatus";
import { resolveMarketplaceSetupGuard } from "./sharedSetupGuard";

vi.mock("./profileStatus", () => ({
  checkProfileStatus: vi.fn(),
}));

vi.mock("./sharedSetupGuard", () => ({
  resolveMarketplaceSetupGuard: vi.fn(),
}));

describe("getMarketplacePostLoginRedirect", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses the creator profile guard and persists completion state", async () => {
    vi.mocked(checkProfileStatus).mockResolvedValue({
      profile_complete: false,
      missing_fields: ["profile"],
      has_defaults: { location: false },
      missing_listings: false,
      completion_steps: [],
    });
    const storage = memoryStorage({ [STORAGE_KEYS.USER_TYPE]: "creator" });

    await expect(getMarketplacePostLoginRedirect(ROUTES.MARKETPLACE, storage)).resolves.toBe(
      ROUTES.PROFILE_COMPLETE,
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

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
