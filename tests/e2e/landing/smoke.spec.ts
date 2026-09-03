import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

const routes = [
  {
    path: "/",
    heading: /Hotels grow direct. Creators find great stays./i,
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

test("homepage exposes distinct hotel, creator and account actions", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);

  await page.goto("/");

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("link", { name: "Hotel products" })).toHaveAttribute(
    "href",
    "/#products",
  );
  await expect(navigation.getByRole("link", { name: "Browse hotel stays" })).toHaveAttribute(
    "href",
    /\/properties$/,
  );
  await expect(navigation.getByRole("link", { name: "Log in" })).toHaveAttribute(
    "href",
    /\/login$/,
  );
  await expect(navigation.getByRole("link", { name: "Sign up" })).toHaveAttribute(
    "href",
    /\/signup$/,
  );
  await expect(navigation).not.toContainText(/Properties|Hotel-Creator-Network|Partner Program/i);

  await expect(page.getByRole("link", { name: "Explore hotel products" })).toHaveAttribute(
    "href",
    "/#products",
  );
  await expect(page.getByRole("link", { name: "Browse hotel stays" }).last()).toHaveAttribute(
    "href",
    /\/properties$/,
  );
  await expect(page.getByRole("heading", { name: "Booking Engine", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "PMS", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Creator Marketplace", level: 3 })).toBeVisible();

  await assertHealthy();
});

test("homepage keeps its primary journeys usable on mobile", async ({ page }, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");

  await expect(page.getByRole("link", { name: "Explore hotel products" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse hotel stays" }).last()).toBeVisible();
  await page.locator("summary").click();
  const mobileNavigation = page.locator("#mobile-navigation");
  const hotelProductsLink = mobileNavigation.getByRole("link", { name: "Hotel products" });
  await expect(hotelProductsLink).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Browse hotel stays" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(mobileNavigation.getByRole("link", { name: "Sign up" })).toBeVisible();
  await hotelProductsLink.click();
  await expect(page.locator("details")).toHaveJSProperty("open", false);
  await expect(
    page.getByRole("heading", { name: "Three products, one direct-growth stack", level: 2 }),
  ).toBeInViewport();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await assertHealthy();
});
