import { describe, expect, it } from "vitest";

import { resolveLocalApiOrigin } from "./localApiOrigin";

describe("resolveLocalApiOrigin", () => {
  it("keeps the API on the browser's isolated portless proxy", () => {
    expect(
      resolveLocalApiOrigin("https://api.localhost", {
        hostname: "pms.localhost",
        port: "1355",
      }),
    ).toBe("https://api.localhost:1355");
  });

  it("preserves an explicitly configured API port", () => {
    expect(
      resolveLocalApiOrigin("https://api.localhost:1356", {
        hostname: "admin.booking.localhost",
        port: "1355",
      }),
    ).toBe("https://api.localhost:1356");
  });

  it.each(["foo.api.localhost", "notapi.localhost"])(
    "does not rewrite lookalike API host %s",
    (hostname) => {
      expect(
        resolveLocalApiOrigin(`https://${hostname}`, {
          hostname: "pms.localhost",
          port: "1355",
        }),
      ).toBe(`https://${hostname}`);
    },
  );

  it("does not alter production origins", () => {
    expect(
      resolveLocalApiOrigin("https://api.vayada.com", {
        hostname: "pms.vayada.com",
        port: "",
      }),
    ).toBe("https://api.vayada.com");
  });
});
