import { describe, expect, it } from "vitest";

import { classifyBookingWebTraffic } from "./bookingWebEvents.js";

describe("Booking Web telemetry traffic policy", () => {
  it.each([
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "Mozilla/5.0 HeadlessChrome/127.0.0.0",
    "UptimeRobot/2.0",
  ])("classifies automated user agents as bot traffic", (userAgent) => {
    expect(classifyBookingWebTraffic(userAgent)).toBe("bot");
  });

  it("keeps browsers and older missing user-agent evidence in the human class", () => {
    expect(classifyBookingWebTraffic("Mozilla/5.0 Safari/605.1.15")).toBe("human");
    expect(classifyBookingWebTraffic(undefined)).toBe("human");
  });
});
