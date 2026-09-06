import { afterEach, describe, expect, it, vi } from "vitest";
import { hotelService } from "./hotel";
import { bookingWebPublicApi } from "./bookingWebPublic";

afterEach(() => vi.restoreAllMocks());

describe("search feedback", () => {
  it("preserves a deep link's room minimum when refreshing availability", async () => {
    const offers = vi
      .spyOn(bookingWebPublicApi, "getOffers")
      .mockResolvedValue({ request: { nights: 2, rooms: 4 }, status: "bookable" });
    await hotelService.searchRooms("test", "2026-09-12", "2026-09-14", 6, 0, "de", 4);
    expect(offers).toHaveBeenCalledWith(
      "test",
      expect.objectContaining({ adults: 6, children: 0, rooms: 4 }),
    );
  });
  it.each([
    { status: "unavailable", codes: ["occupancy_unavailable"], message: "guestCountUnavailable" },
    { status: "unavailable", codes: ["unsupported_occupancy"], message: "guestCountUnsupported" },
    { status: "unavailable", codes: ["sold_out"], message: "noAvailability" },
    { status: "unavailable", codes: ["min_stay_not_met"], message: "noAvailability" },
    {
      status: "unavailable",
      codes: ["occupancy_unavailable", "payment_disabled"],
      message: "noAvailability",
    },
    {
      status: "unavailable",
      codes: ["occupancy_unavailable", "unavailable_data"],
      message: "availabilityError",
    },
    { status: "stale", codes: ["stale_data"], message: "availabilityError" },
    { status: "bookable", codes: [], message: null },
  ] as const)("maps $status / $codes to $message", async ({ status, codes, message }) => {
    vi.spyOn(bookingWebPublicApi, "getOffers").mockResolvedValue({
      request: { nights: 2, rooms: 1 },
      status,
      unavailableReasons: codes.map((code) => ({ code })),
    });
    const result = await hotelService.searchRooms("test", "2026-09-12", "2026-09-14", 3, 1, "de");
    expect(result.searchMessage).toBe(message);
  });
});
