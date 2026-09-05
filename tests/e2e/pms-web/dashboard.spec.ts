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
    await page.clock.install({ time: new Date("2026-06-24T17:34:00Z") });

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

    const calendarRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar?*`;
    const requestedCalendarRanges = new Set<string>();
    await page.unroute(calendarRoute);
    await page.route(calendarRoute, (route) => {
      requestedCalendarRanges.add(new URL(route.request().url()).search);
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          days: [
            {
              stayDate: "2026-06-25",
              roomTypeId: "room-type-turnover",
              totalCount: 2,
              assignedCount: 1,
              occupiedCount: 1,
              blockedCount: 1,
              availableCount: 0,
              assignmentRefs: ["assignment-turnover"],
              status: "limited",
            },
            {
              stayDate: "2026-06-25",
              roomTypeId: "room-type-multi",
              totalCount: 2,
              assignedCount: 1,
              occupiedCount: 1,
              blockedCount: 0,
              availableCount: 0,
              assignmentRefs: ["assignment-multi"],
              status: "open",
            },
            {
              stayDate: "2026-06-25",
              roomTypeId: "room-type-pending-hold",
              totalCount: 1,
              assignedCount: 1,
              occupiedCount: 0,
              blockedCount: 0,
              availableCount: 0,
              assignmentRefs: [],
              status: "limited",
            },
            {
              stayDate: "2026-06-26",
              roomTypeId: "room-type-closed",
              totalCount: 2,
              assignedCount: 0,
              occupiedCount: 0,
              blockedCount: 0,
              availableCount: 0,
              assignmentRefs: [],
              status: "closed",
            },
          ],
          sourceFreshness: {},
        },
      });
    });

    await page.goto("/dashboard");

    await expect(page.getByText("Thursday, June 25, 2026", { exact: true })).toBeVisible();
    await expect(page.getByText("Jun 25 – Jul 8", { exact: true })).toBeVisible();
    await expect(page.getByText("Today", { exact: true }).locator("..")).toContainText("25");
    await expect(page.getByText("Thursday, Jun 25", { exact: true })).toBeVisible();
    await expect(page.getByText("Ada Lovelace", { exact: true })).toBeVisible();
    await expect(page.getByText("No arrivals today", { exact: true })).toHaveCount(2);
    await expect(page.getByText("No departures today", { exact: true })).toHaveCount(0);

    const occupancyCard = page.getByText("Occupancy Tonight", { exact: true }).locator("../..");
    await expect(occupancyCard).toContainText("100%");
    await expect(occupancyCard).toContainText("2 of 2 rooms occupied");

    const todayBar = page.getByRole("img", { name: "2026-06-25: 100% occupancy" });
    await expect(todayBar).toBeVisible();
    await todayBar.hover();
    await expect(todayBar).toContainText("Occupancy: 100%");
    await expect(
      page.getByRole("img", { name: "2026-06-26: occupancy unavailable" }),
    ).toBeVisible();
    expect(requestedCalendarRanges).toContain("?from=2026-06-25&to=2026-07-08");

    await page.getByRole("button", { name: "Next week" }).click();
    await expect(occupancyCard).toContainText("100%");
    await expect(page.getByText("Jul 2 – Jul 15", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByText("Jun 25 – Jul 8", { exact: true })).toBeVisible();

    await page.clock.fastForward("22:27:00");
    await expect(page.getByText("Friday, June 26, 2026", { exact: true })).toBeVisible();
    await expect(page.getByText("Jun 26 – Jul 9", { exact: true })).toBeVisible();
    await expect(occupancyCard).toContainText("Unavailable");
    expect(requestedCalendarRanges).toContain("?from=2026-06-26&to=2026-07-09");
  });

  test("distinguishes a failed inventory request from unavailable inventory", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-08-20T12:00:00Z") });
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.unroute(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar?*`);
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar?*`, (route) =>
      route.fulfill({ status: 503, json: { code: "read_model_unavailable" } }),
    );

    await page.goto("/dashboard");

    const occupancyCard = page.getByText("Occupancy Tonight", { exact: true }).locator("../..");
    await expect(occupancyCard).toContainText("Couldn’t load occupancy");
    await expect(occupancyCard).not.toContainText("Unavailable");
    await expect(
      page.getByRole("img", { name: "2026-08-20: occupancy failed to load" }),
    ).toBeVisible();
  });
});

test("browses arrivals and departures independently across property-local dates", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-03-28T23:30:00Z") });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const reservationsRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`;
  await page.unroute(reservationsRoute);
  await page.route(reservationsRoute, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: ["2026-03-29", "2026-03-30", "2026-03-31", "2026-04-01"].flatMap((date, index) =>
          ["Arrival", "Departure"].map((kind) => ({
            ...pmsWebReservation,
            guestBookingId: `navigation-${kind}-${index}`,
            primaryGuest: {
              ...pmsWebReservation.primaryGuest,
              displayName: `${kind}${index} Navigation`,
            },
            stay: {
              ...pmsWebReservation.stay,
              checkIn: kind === "Arrival" ? date : "2026-03-20",
              checkOut: kind === "Departure" ? date : "2026-04-10",
            },
          })),
        ),
        pagination: { total: 8, limit: 500, offset: 0 },
        sourceFreshness: {},
      },
    }),
  );
  await page.goto("/dashboard");
  const arrivals = page.locator('section[aria-labelledby="arrivals-heading"]');
  const departures = page.locator('section[aria-labelledby="departures-heading"]');
  await expect(arrivals.getByRole("heading")).toHaveText("Arrivals • Mar 29, 2026");
  await expect(departures.getByRole("heading")).toHaveText("Departures • Mar 29, 2026");
  await expect(arrivals.getByRole("button", { name: "Previous day" })).toBeDisabled();
  await expect(departures).toContainText("Departure0 Navigation");
  for (const [index, date] of ["Mar 30", "Mar 31", "Apr 1"].entries()) {
    await arrivals.getByRole("button", { name: "Next day" }).click();
    await expect(arrivals.getByRole("heading")).toHaveText(`Arrivals • ${date}, 2026`);
    await expect(arrivals).toContainText(`Arrival${index + 1} Navigation`);
    await expect(arrivals).not.toContainText("Arrival0 Navigation");
    await expect(departures).toContainText("Departure0 Navigation");
  }
  await arrivals.getByRole("button", { name: /Arrival3 Navigation/ }).click();
  const preview = page.getByRole("dialog");
  await expect(preview).toContainText("Arrivals • Apr 1, 2026");
  await expect(preview.getByRole("link", { name: "Start check-in" })).toHaveCount(0);
  await expect(preview.getByRole("link", { name: "View full booking" })).toBeVisible();
  await preview.getByRole("button", { name: "Close", exact: true }).click();
  await departures.getByRole("button", { name: "Next day" }).click();
  await expect(departures).toContainText("Departure1 Navigation");
  await expect(arrivals).toContainText("Arrival3 Navigation");
  await departures.getByRole("button", { name: "Previous day" }).click();
  await expect(departures).toContainText("Departure0 Navigation");
  await arrivals.getByRole("button", { name: "Next day" }).click();
  await expect(arrivals).toContainText("No arrivals on this date");
  await arrivals.getByRole("button", { name: "Today", exact: true }).click();
  await expect(arrivals).toContainText("Arrival0 Navigation");
  await expect(arrivals.getByRole("button", { name: "Previous day" })).toBeDisabled();
  for (let day = 0; day < 4; day++) {
    await departures.getByRole("button", { name: "Next day" }).click();
  }
  await expect(departures).toContainText("No departures on this date");
  await departures.getByRole("button", { name: "Today", exact: true }).click();
  await expect(departures).toContainText("Departure0 Navigation");
  await expect(page.getByText("Arrivals Today", { exact: true }).locator("../..")).toContainText(
    "1",
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(arrivals.getByRole("button", { name: "Next day" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
