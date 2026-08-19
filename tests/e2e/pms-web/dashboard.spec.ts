import { expect, test } from "@playwright/test";

import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
  sharedPropertyProfile,
} from "../support/pmsWebMocks";

test.describe("pms-web dashboard", () => {
  test.use({ timezoneId: "Europe/Berlin" });

  test("uses the property-local day for its date and booking sections", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-06-24T17:34:00Z"));

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);

    const profileRoute = `**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/profile`;
    await page.unroute(profileRoute);
    await page.route(profileRoute, (route) =>
      route.fulfill({
        json: {
          ...sharedPropertyProfile,
          profile: {
            ...sharedPropertyProfile.profile,
            location: {
              ...sharedPropertyProfile.profile.location,
              timezone: "Asia/Makassar",
            },
          },
        },
      }),
    );

    const reservationsRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
    await page.unroute(reservationsRoute);
    await page.route(reservationsRoute, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [
            {
              ...pmsWebReservation,
              stay: {
                ...pmsWebReservation.stay,
                checkIn: "2026-06-24",
                checkOut: "2026-06-25",
              },
            },
          ],
          pagination: { total: 1, limit: 500, offset: 0 },
          sourceFreshness: {},
        },
      }),
    );

    await page.goto("/dashboard");

    await expect(page.getByText("Thursday, June 25, 2026", { exact: true })).toBeVisible();
    await expect(page.getByText("Thursday, Jun 25", { exact: true })).toBeVisible();
    await expect(page.getByText("Ada Lovelace", { exact: true })).toBeVisible();
    await expect(page.getByText("No arrivals today", { exact: true })).toHaveCount(2);
    await expect(page.getByText("No departures today", { exact: true })).toHaveCount(0);
  });
});
