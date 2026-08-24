import { expect, test } from "@playwright/test";

import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

test.describe("booking-admin Feature Hub", () => {
  test("activates the supported module, persists it across reload, and updates navigation", async ({
    page,
  }) => {
    let affiliatesActive = false;
    let activationReads = 0;
    let activationWrites = 0;
    let releaseStaleRead = () => {};
    const staleRead = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const activationPath = `/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/module-activations`;

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(new RegExp(`${activationPath}(?:/[^/]+)?$`), async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        activationReads += 1;
        const activeAtRead = affiliatesActive;
        if (activationReads === 2) await staleRead;
        return route.fulfill({
          json: {
            hotelId: BOOKING_ADMIN_PROPERTY_ID,
            canManage: true,
            supportedModules: ["affiliates"],
            activeModules: activeAtRead ? ["affiliates"] : [],
            activations: [
              {
                moduleId: "affiliates",
                isActive: activeAtRead,
                activatedAt: activeAtRead ? "2026-08-24T00:00:00.000Z" : null,
                deactivatedAt: activeAtRead ? null : "2026-08-23T00:00:00.000Z",
                updatedAt: "2026-08-24T00:00:00.000Z",
              },
            ],
          },
        });
      }
      if (request.method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": request.headers().origin ?? "*",
            "access-control-allow-headers": "authorization,content-type",
            "access-control-allow-methods": "GET,PATCH,OPTIONS",
          },
        });
      }

      expect(request.method()).toBe("PATCH");
      expect(new URL(request.url()).pathname).toBe(`${activationPath}/affiliates`);
      const body = request.postDataJSON() as { moduleId: string; isActive: boolean };
      expect(body.moduleId).toBe("affiliates");
      affiliatesActive = body.isActive;
      activationWrites += 1;
      return route.fulfill({
        headers: { "access-control-allow-origin": request.headers().origin ?? "*" },
        json: {
          moduleId: "affiliates",
          isActive: affiliatesActive,
          activatedAt: affiliatesActive ? "2026-08-24T00:00:00.000Z" : null,
          deactivatedAt: affiliatesActive ? null : "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
      });
    });

    await page.goto("/settings/feature-hub");
    await expect.poll(() => activationReads).toBeGreaterThanOrEqual(2);

    const navigation = page.getByRole("navigation");
    await expect(navigation.getByRole("link", { name: "Affiliates" })).toHaveCount(0);
    await expect(page.locator("article")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Affiliates" })).toBeVisible();
    for (const unsupported of ["Inbox", "Financials", "Lodgify", "Stripe", "PayPal", "Xendit"]) {
      await expect(page.getByRole("heading", { name: unsupported, exact: true })).toHaveCount(0);
    }

    const activate = page.getByRole("switch", { name: "Activate Affiliates" });
    await expect(activate).toBeEnabled();
    await activate.focus();
    await expect(activate).toBeFocused();
    await expect(activate).not.toBeChecked();
    await activate.click();

    await expect.poll(() => activationWrites).toBe(1);
    releaseStaleRead();
    await expect(page.getByText("Syncing")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Deactivate Affiliates" })).toBeChecked();
    await expect(navigation.getByRole("link", { name: "Affiliates" })).toBeVisible();
    expect(activationWrites).toBe(1);

    const readsBeforeReload = activationReads;
    await page.reload();
    await expect.poll(() => activationReads).toBeGreaterThan(readsBeforeReload);

    await expect(page.getByRole("switch", { name: "Deactivate Affiliates" })).toBeChecked();
    await expect(navigation.getByRole("link", { name: "Affiliates" })).toBeVisible();
    expect(activationWrites).toBe(1);
  });

  test("keeps activation controls read-only without property manage permission", async ({
    page,
  }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/module-activations`,
      (route) =>
        route.fulfill({
          json: {
            hotelId: BOOKING_ADMIN_PROPERTY_ID,
            canManage: false,
            supportedModules: ["affiliates"],
            activeModules: [],
            activations: [],
          },
        }),
    );

    await page.goto("/settings/feature-hub");

    await expect(page.getByRole("switch", { name: "Activate Affiliates" })).toBeDisabled();
  });

  test("ignores cross-property storage events until canonical scope resolves", async ({ page }) => {
    let activationReads = 0;
    let releaseReads = () => {};
    const readsBlocked = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/module-activations`,
      async (route) => {
        activationReads += 1;
        await readsBlocked;
        return route.fulfill({
          json: {
            hotelId: BOOKING_ADMIN_PROPERTY_ID,
            canManage: true,
            supportedModules: ["affiliates"],
            activeModules: [],
            activations: [],
          },
        });
      },
    );

    await page.goto("/settings/feature-hub");
    await expect.poll(() => activationReads).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "vayada-feature-modules-changed",
          newValue: JSON.stringify({
            hotelId: "another-property",
            canManage: true,
            supportedModuleIds: ["affiliates"],
            activeModuleIds: ["affiliates"],
            source: "write",
          }),
        }),
      );
    });
    releaseReads();

    const activate = page.getByRole("switch", { name: "Activate Affiliates" });
    await expect(activate).toBeEnabled();
    await expect(activate).not.toBeChecked();
    await expect(
      page.getByRole("navigation").getByRole("link", { name: "Affiliates" }),
    ).toHaveCount(0);
  });
});
