import { describe, expect, it } from "vitest";

import { getRequestHost } from "./requestHost";
import { resolvePublicHotelUrls } from "./server/publicUrls";

describe("getRequestHost", () => {
  it("prefers the original forwarded host and preserves its port", () => {
    const headers = new Headers({
      host: "127.0.0.1:3002",
      "x-forwarded-host": "codex-qa-hotel.booking.localhost:1355, booking.localhost:1355",
    });

    expect(getRequestHost(headers)).toBe("codex-qa-hotel.booking.localhost:1355");
  });

  it("falls back to Host when no forwarded host is present", () => {
    expect(getRequestHost(new Headers({ host: "hotel.example.com" }))).toBe("hotel.example.com");
  });

  it("keeps the forwarded development port in public URLs", () => {
    const requestHost = getRequestHost(
      new Headers({
        host: "127.0.0.1:3002",
        "x-forwarded-host": "codex-qa-hotel.booking.localhost:1355",
      }),
    );

    expect(
      resolvePublicHotelUrls({
        requestHost,
        requestProtocol: "https",
        slug: "codex-qa-hotel",
        locale: "en",
      }).canonicalUrl,
    ).toBe("https://codex-qa-hotel.booking.localhost:1355/en");
  });
});
