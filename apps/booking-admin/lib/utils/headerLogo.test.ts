import { describe, expect, it } from "vitest";

import { HEADER_LOGO_MAX_BYTES, headerLogoUploadError } from "./headerLogo";

describe("header logo upload", () => {
  it.each([
    ["logo.png", "image/png"],
    ["logo.jpg", "image/jpeg"],
    ["logo.svg", "image/svg+xml"],
    ["logo.SVG", ""],
  ])("accepts %s", (name, type) => {
    expect(headerLogoUploadError(new File(["logo"], name, { type }))).toBeNull();
  });

  it("rejects unsupported, empty, and oversized files", () => {
    expect(headerLogoUploadError(new File(["logo"], "logo.webp", { type: "image/webp" }))).toBe(
      "Choose a PNG, SVG, or JPEG logo.",
    );
    expect(headerLogoUploadError(new File([], "logo.png", { type: "image/png" }))).toBe(
      "Choose a logo that isn’t empty.",
    );
    expect(
      headerLogoUploadError(
        new File([new Uint8Array(HEADER_LOGO_MAX_BYTES + 1)], "logo.png", {
          type: "image/png",
        }),
      ),
    ).toBe("Choose a logo smaller than 500 KB.");
  });
});
