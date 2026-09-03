import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HEADER_LOGO_MAX_BYTES,
  headerLogoDimensionsError,
  headerLogoFileFromUrl,
  headerLogoUploadError,
} from "./headerLogo";

describe("header logo upload", () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it("enforces the rendered 300 × 80 pixel bounds", async () => {
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        naturalWidth = 301;
        naturalHeight = 80;
        async decode() {}
      },
    );

    await expect(
      headerLogoDimensionsError(new File(["logo"], "logo.png", { type: "image/png" })),
    ).resolves.toBe("Choose a logo no larger than 300 × 80px.");
  });

  it("downloads a public logo URL into the secure upload flow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Blob(["logo"], { type: "image/png" }), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    await expect(headerLogoFileFromUrl("https://cdn.example.com/logo.png")).resolves.toMatchObject({
      name: "logo.png",
      type: "image/png",
    });
    await expect(headerLogoFileFromUrl("data:image/png;base64,abc")).rejects.toThrow(
      "Enter a public HTTP or HTTPS image URL.",
    );
  });
});
