import { expect, test } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  PMS_WEB_ROOM_ID,
  PMS_WEB_ROOM_TYPE_ID,
  pmsWebReservation,
} from "../support/pmsWebMocks";

const futureReservation = {
  ...pmsWebReservation,
  guestBookingId: `${PMS_WEB_RESERVATION_ID}_future`,
  bookingReference: "VAY-FUTURE",
  stay: { ...pmsWebReservation.stay, checkIn: "2027-02-14", checkOut: "2027-02-16" },
  primaryGuest: {
    ...pmsWebReservation.primaryGuest,
    displayName: "Future Guest",
    email: "future@example.com",
  },
};

const futureBlock = {
  blockId: "room_block_future",
  roomTypeId: PMS_WEB_ROOM_TYPE_ID,
  roomId: PMS_WEB_ROOM_ID,
  startsOn: "2027-02-20",
  endsOn: "2027-02-20",
  blockedCount: 1,
  reason: "Owner maintenance",
};

test.describe("mobile PMS calendar", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fetches the visible range and renders bookings and blocks six months ahead", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-08-11T12:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);

    const reservationRanges: Array<{ from: string | null; to: string | null }> = [];
    const blockRanges: Array<{ from: string | null; to: string | null }> = [];
    let releaseFutureRequests!: () => void;
    const futureRequests = new Promise<void>((resolve) => {
      releaseFutureRequests = resolve;
    });

    const reservationsRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
    await page.unroute(reservationsRoute);
    await page.route(reservationsRoute, async (route) => {
      const url = new URL(route.request().url());
      const range = {
        from: url.searchParams.get("stayFrom"),
        to: url.searchParams.get("stayTo"),
      };
      reservationRanges.push(range);
      const isFutureRange = range.from === "2027-02-01" && range.to === "2027-03-01";
      if (isFutureRange) await futureRequests;
      const items = isFutureRange ? [futureReservation] : [pmsWebReservation];
      await route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items,
          sourceFreshness: {},
          pagination: { total: items.length, limit: 500, offset: 0 },
        },
      });
    });

    const blocksRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`;
    await page.unroute(blocksRoute);
    await page.route(blocksRoute, async (route) => {
      const url = new URL(route.request().url());
      const range = {
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
      };
      blockRanges.push(range);
      const isFutureRange = range.from === "2027-02-01" && range.to === "2027-03-01";
      if (isFutureRange) await futureRequests;
      await route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: isFutureRange ? [futureBlock] : [],
          sourceFreshness: {},
        },
      });
    });

    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: "August", exact: true })).toBeVisible();
    await expect(page.getByText("Loading bookings and blocks...")).toBeHidden();

    for (let month = 0; month < 6; month += 1) {
      await page.getByRole("button", { name: "Next month" }).click();
    }

    await expect(page.getByRole("heading", { name: "February", exact: true })).toBeVisible();
    await expect
      .poll(() => reservationRanges.at(-1))
      .toEqual({
        from: "2027-02-01",
        to: "2027-03-01",
      });
    await expect
      .poll(() => blockRanges.at(-1))
      .toEqual({
        from: "2027-02-01",
        to: "2027-03-01",
      });
    await expect(page.getByText("Loading bookings and blocks...")).toBeVisible();
    await expect(page.getByText("No bookings or blocks on this day")).toBeHidden();

    releaseFutureRequests();

    const bookedDay = page.locator('[data-day="2027-02-14"]');
    await bookedDay.click();
    await expect(page.getByText("Future Guest")).toBeVisible();
    await expect(
      bookedDay.locator('[class~="w-1"][class~="h-1"][class~="rounded-full"]'),
    ).toHaveCount(1);

    const blockedDay = page.locator('[data-day="2027-02-20"]');
    await blockedDay.click();
    await expect(page.getByText("Owner maintenance")).toBeVisible();
    await expect(
      blockedDay.locator('[class~="w-1"][class~="h-1"][class~="rounded-full"]'),
    ).toHaveCount(1);

    const settledReservationRequestCount = reservationRanges.length;
    const settledBlockRequestCount = blockRanges.length;
    await page.waitForTimeout(250);
    expect(reservationRanges).toHaveLength(settledReservationRequestCount);
    expect(blockRanges).toHaveLength(settledBlockRequestCount);
  });
});
