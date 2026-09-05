import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  sharedPropertyProfile,
} from "../support/pmsWebMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";

test("readable timezone labels preserve IANA values when saved and reloaded", async ({
  page,
}, testInfo) => {
  const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "pms-web-operations");
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  let savedTimezone = "America/Sao_Paulo";
  await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/profile`, (route) => {
    if (route.request().method() === "PUT") {
      savedTimezone = route.request().postDataJSON().patch.location.timezone;
    }
    return route.fulfill({
      json: {
        ...sharedPropertyProfile,
        profile: {
          ...sharedPropertyProfile.profile,
          location: { ...sharedPropertyProfile.profile.location, timezone: savedTimezone },
        },
      },
    });
  });
  await page.goto("/settings");
  const timezone = page.getByLabel("Timezone*");
  await expect(timezone).toHaveValue("America/Sao_Paulo");
  await expect(timezone.locator("option:checked")).toHaveText("America/Sao Paulo");
  await expect(timezone.locator('option[value="America/New_York"]')).toHaveText("America/New York");
  await expect(timezone.locator('option[value="Europe/Berlin"]')).toHaveText("Europe/Berlin");
  await timezone.selectOption({ label: "America/New York" });
  await expect(timezone).toHaveValue("America/New_York");
  await page
    .locator("#property-details")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect.poll(() => savedTimezone).toBe("America/New_York");
  await page.reload();
  await expect(timezone).toHaveValue("America/New_York");
  await expect(timezone.locator("option:checked")).toHaveText("America/New York");
  await page.goto("/inbox");
  await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
  await page.getByRole("button", { name: "Follow up", exact: true }).last().click();
  await expect(page.getByText(/property-local time \(America\/New York\)/)).toBeVisible();
  await assertNoLegacyCalls();
});
