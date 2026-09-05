import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

for (const enabled of [true, false]) {
  test(`incomplete calendar recovery when initially ${enabled ? "enabled" : "disabled"}`, async ({
    page,
  }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar-auto-open`, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 409, json: { code: "operating_calendar_not_configured" } })
        : route.fulfill({
            json: {
              contractVersion: "pms-calendar-auto-open.v1",
              setting: {
                contractVersion: "pms-calendar-auto-open.v1",
                propertyId: PMS_WEB_PROPERTY_ID,
                revision: 3,
                enabled,
                mode: "fixed",
                rollingMonths: null,
                fixedEndMonth: "2026-09",
                updatedAt: null,
              },
              horizon: {
                propertyTimeZone: "Europe/Athens",
                propertyLocalDate: "2026-09-05",
                targetOpenThrough: null,
              },
              warnings: [],
              setupError: enabled ? { code: "operating_calendar_not_configured" } : null,
            },
          }),
    );
    await page.goto("/settings#calendar");
    if (!enabled) {
      await page.getByRole("switch", { name: "Auto-open future calendar", exact: true }).click();
      await page.getByRole("button", { name: "Save auto-open", exact: true }).click();
    }
    const link = page.getByRole("link", { name: "Complete room and calendar setup" });
    await expect(link).toBeVisible();
    const login = new URL((await link.getAttribute("href"))!);
    expect(login.pathname).toBe("/login");
    const destination = new URL(login.searchParams.get("returnTo")!, login.origin);
    expect(destination.pathname).toBe("/setup");
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      entryProduct: "pms",
      returnProduct: "pms",
      returnTo: "/settings#calendar",
      propertyId: PMS_WEB_PROPERTY_ID,
      recovery: "pms-calendar",
      step: "calendar",
    });
    await expect(page.getByText(/ask your property administrator/)).toBeVisible();
    await link.focus();
    await expect(link).toBeFocused();
  });
}
