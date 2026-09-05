import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

for (const { enabled, save } of [
  { enabled: true, save: false },
  { enabled: true, save: true },
  { enabled: false, save: true },
]) {
  test(`incomplete calendar recovery when initially ${enabled ? "enabled" : "disabled"} on ${save ? "save" : "load"}`, async ({
    page,
  }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    let patches = 0;
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar-auto-open`, (route) => {
      if (route.request().method() === "PATCH") {
        patches++;
        return route.fulfill({ status: 409, json: { code: "operating_calendar_not_configured" } });
      }
      return route.fulfill({
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
          setupError: !save ? { code: "operating_calendar_not_configured" } : null,
        },
      });
    });
    await page.goto("/settings#calendar");
    if (save) {
      if (!enabled)
        await page.getByRole("switch", { name: "Auto-open future calendar", exact: true }).click();
      else await page.getByLabel("Open through month", { exact: true }).fill("2026-10");
      await page.getByRole("button", { name: "Save auto-open", exact: true }).click();
    }
    const link = page.getByRole("link", { name: "Complete room and calendar setup" });
    await expect(link).toBeVisible();
    expect(patches).toBe(save ? 1 : 0);
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
