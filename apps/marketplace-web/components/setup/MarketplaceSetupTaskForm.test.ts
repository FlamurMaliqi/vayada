import { describe, expect, it } from "vitest";

import { ApiErrorResponse } from "@/services/api/client";

import { errorMessage } from "./MarketplaceSetupTaskForm";

describe("Marketplace setup error messages", () => {
  it("uses an actionable API message when detail is null", () => {
    const error = new ApiErrorResponse(400, {
      detail: null as never,
      message: "The selected property cannot accept this media upload.",
    });

    expect(errorMessage(error, "Failed to save this step.")).toBe(
      "The selected property cannot accept this media upload.",
    );
  });
});
