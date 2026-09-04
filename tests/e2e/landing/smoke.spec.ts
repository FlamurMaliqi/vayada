import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

const routes = [
  {
    path: "/",
    heading: /Hotels are losing control over their demand/i,
  },
  {
    path: "/booking-engine",
    heading: /The booking engine built for independent hospitality/i,
  },
  {
    path: "/pms",
    heading: /The PMS built for modern independent hospitality/i,
  },
  {
    path: "/pricing",
    heading: /Pricing built for direct bookings/i,
  },
  {
    path: "/contact",
    heading: /Get in touch with vayada/i,
  },
];

test.describe("landing smoke", () => {
  for (const route of routes) {
    test(`${route.path} renders the public shell`, async ({ page }, testInfo) => {
      const assertHealthy = watchPageHealth(page, testInfo);

      await page.goto(route.path);

      await expect(page.getByRole("heading", { name: route.heading, level: 1 })).toBeVisible();
      await expect(page.getByRole("navigation")).toContainText(/vayada/i);
      await expect(page.locator("footer")).toContainText(/vayada/i);

      await assertHealthy();
    });
  }
});
