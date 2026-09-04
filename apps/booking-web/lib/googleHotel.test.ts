import { describe, expect, it } from "vitest";

import { googleHotelStay, googleHotelTrafficSource } from "./googleHotel";

describe("Google Hotel landing links", () => {
  it("converts lowercase checkin and nights into a stay", () => {
    expect(
      googleHotelStay(
        new URLSearchParams("checkin=2026-09-10&nights=3"),
        new Date("2026-09-05T12:00:00"),
      ),
    ).toEqual({ checkIn: "2026-09-10", checkOut: "2026-09-13" });
  });

  it.each([
    "checkin=2026-09-04&nights=2",
    "checkin=not-a-date&nights=2",
    "checkin=2026-02-30&nights=2",
    "checkin=2026-09-10&nights=0",
    "checkin=2026-09-10&nights=366",
  ])("rejects invalid or past Google stay params: %s", (query) => {
    expect(googleHotelStay(new URLSearchParams(query), new Date("2026-09-05T12:00:00"))).toBeNull();
  });

  it("classifies free links and paid Hotel Ads without accepting lookalike hosts", () => {
    expect(
      googleHotelTrafficSource(
        new URLSearchParams(),
        "https://www.google.com/travel/hotels/entity/CgsI",
      ),
    ).toBe("Google Free Booking Links");
    expect(
      googleHotelTrafficSource(
        new URLSearchParams("gclid=paid-click"),
        "https://www.google.com/hotels/example",
      ),
    ).toBe("Google Hotel Ads");
    expect(
      googleHotelTrafficSource(
        new URLSearchParams(),
        "https://google.com.attacker.test/travel/hotels",
      ),
    ).toBeNull();
    expect(
      googleHotelTrafficSource(
        new URLSearchParams("checkin=2026-09-10&nights=2"),
        "https://www.google.com/",
      ),
    ).toBe("Google Free Booking Links");
  });
});
