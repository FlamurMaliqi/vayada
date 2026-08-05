import { describe, expect, it } from "vitest";

import {
  clearPendingPropertyLogo,
  readPendingPropertyLogo,
  sharedPropertyLogoContentType,
  sharedPropertyLogoError,
  writePendingPropertyLogo,
} from "./sharedPropertyLogo";

describe("shared property logo", () => {
  it("accepts only canonical property-logo image formats within 10 MB", () => {
    expect(sharedPropertyLogoError(new File(["logo"], "logo.webp", { type: "image/webp" }))).toBe(
      null,
    );
    expect(sharedPropertyLogoError(new File(["logo"], "logo.svg", { type: "image/svg+xml" }))).toBe(
      "Choose a JPG, PNG, or WebP logo.",
    );
    expect(sharedPropertyLogoError(new File([], "empty.png", { type: "image/png" }))).toBe(
      "Choose a logo that isn’t empty.",
    );
    expect(
      sharedPropertyLogoError(
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" }),
      ),
    ).toBe("Choose a logo smaller than 10 MB.");
    expect(sharedPropertyLogoContentType(new File(["logo"], "camera.PNG"))).toBe("image/png");
  });

  it("stores only assignment retry metadata scoped to the property", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const pending = {
      mediaObjectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expectedProfileRevision: 3,
      assignmentIdempotencyKey: "assign-logo-1",
    };

    writePendingPropertyLogo(storage, "property-1", pending);

    expect(readPendingPropertyLogo(storage, "property-1")).toEqual(pending);
    expect(readPendingPropertyLogo(storage, "property-2")).toBeNull();
    expect([...values.values()].join(" ")).not.toMatch(
      /address|contact|uploadUrl|storageKey|invite|Hotel Alpenrose/,
    );
    clearPendingPropertyLogo(storage, "property-1");
    expect(readPendingPropertyLogo(storage, "property-1")).toBeNull();
  });

  it("fails closed for malformed retry data", () => {
    const storage = {
      getItem: () => JSON.stringify({ mediaObjectId: "not-a-uuid" }),
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(readPendingPropertyLogo(storage, "property-1")).toBeNull();
  });
});
