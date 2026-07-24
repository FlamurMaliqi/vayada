import { describe, expect, it } from "vitest";

import { getRequestHost } from "./requestHost";
import { getCanonicalHostRedirectUrl, resolvePublicHotelUrls } from "./server/publicUrls";

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

  it("preserves the portless worktree hostname in public URLs", () => {
    const requestUrl = new URL(
      "https://hotel-alpenrose.polish-cookie-banner.booking.localhost:1355/en",
    );
    const policy = resolvePublicHotelUrls({
      requestHost: requestUrl.host,
      requestProtocol: "https",
      slug: "hotel-alpenrose",
      locale: "en",
    });

    expect(policy.canonicalUrl).toBe(requestUrl.toString().replace(/\/$/, ""));
    expect(getCanonicalHostRedirectUrl(policy, requestUrl)).toBeNull();
  });

  it("replaces a legacy tenant slug without treating it as part of the worktree hostname", () => {
    const requestUrl = new URL(
      "https://legacy-alpenrose.polish-cookie-banner.booking.localhost:1355/en",
    );
    const policy = resolvePublicHotelUrls({
      requestHost: requestUrl.host,
      requestProtocol: "https",
      slug: "alpenrose-resort",
      locale: "en",
    });

    expect(policy.canonicalUrl).toBe(
      "https://alpenrose-resort.polish-cookie-banner.booking.localhost:1355/en",
    );
    expect(getCanonicalHostRedirectUrl(policy, requestUrl)).toBe(policy.canonicalUrl);
  });
});
