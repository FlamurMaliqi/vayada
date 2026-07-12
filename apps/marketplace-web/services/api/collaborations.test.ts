import { describe, expect, it } from "vitest";

import { toLegacyCollaborationType } from "@vayada/marketplace-shared/api/collaborations";

describe("toLegacyCollaborationType", () => {
  it("preserves primary compensation when affiliate terms are additive", () => {
    expect(toLegacyCollaborationType("free_stay", true, "12.5")).toBe("Free Stay");
  });

  it("uses Affiliate only for complete affiliate-only terms", () => {
    expect(toLegacyCollaborationType(null, true, "12.5")).toBe("Affiliate");
    expect(toLegacyCollaborationType("free_stay", true, null)).toBe("Free Stay");
    expect(toLegacyCollaborationType(null, true, null)).toBeNull();
  });
});
