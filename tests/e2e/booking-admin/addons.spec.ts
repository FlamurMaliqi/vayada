import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_ADDON_ITEMS_PATH,
  BOOKING_ADMIN_ADDON_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin add-ons settings cutover", () => {
  test("loads and saves display settings through the TypeScript contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");

    await mockBookingAdminBookingFlow(page);

    const contractRequests: string[] = [];
    const itemContractRequests: Array<{ method: string; pathname: string }> = [];
    const typedItemWrites: Array<{ method: string; pathname: string; body?: unknown }> = [];
    const typedWrites: unknown[] = [];
    const propertyPlan = {
      propertyId: "property_alpenrose",
      plan: "commission" as const,
      limits: {
        maxRoomPhotosPerType: 10,
        maxAddons: 3,
        guestContactAccess: "after_acceptance" as const,
      },
    };
    let addonItems = [
      {
        addonItemId: "addon_airport_transfer",
        hotelId: BOOKING_ADMIN_HOTEL_ID,
        propertyId: "property_alpenrose",
        name: "Airport transfer",
        description: "Private pickup from the airport.",
        price: "45.00",
        currency: "EUR",
        category: "transport",
        imageUrl: null,
        duration: "45 min",
        pricingModel: "per_stay",
        publicVisible: true,
        status: "active",
        sortOrder: 0,
        ownershipKind: "property",
        partnerCommissionRate: null,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
      {
        addonItemId: "addon_breakfast_basket",
        hotelId: BOOKING_ADMIN_HOTEL_ID,
        propertyId: "property_alpenrose",
        name: "Breakfast basket",
        description: "A prepared breakfast delivered to the room.",
        price: "28.00",
        currency: "EUR",
        category: "dining",
        imageUrl: null,
        duration: null,
        pricingModel: "per_guest",
        publicVisible: true,
        status: "active",
        sortOrder: 1,
        ownershipKind: "property",
        partnerCommissionRate: null,
        createdAt: "2026-06-01T10:02:00.000Z",
        updatedAt: "2026-06-01T10:02:00.000Z",
      },
    ];
    await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      itemContractRequests.push({ method: request.method(), pathname });

      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const created = {
          addonItemId: "addon_spa_ritual",
          hotelId: BOOKING_ADMIN_HOTEL_ID,
          propertyId: "property_alpenrose",
          name: body.name,
          description: body.description,
          price: body.price,
          currency: body.currency,
          category: body.category,
          imageUrl: body.imageUrl,
          duration: body.duration,
          pricingModel: body.pricingModel,
          publicVisible: body.publicVisible,
          status: body.status,
          sortOrder: body.sortOrder ?? addonItems.length,
          ownershipKind: body.ownershipKind,
          partnerCommissionRate: body.partnerCommissionRate,
          createdAt: "2026-06-01T10:05:00.000Z",
          updatedAt: "2026-06-01T10:05:00.000Z",
        };
        typedItemWrites.push({ method: "POST", pathname, body });
        addonItems = [...addonItems, created];
        await route.fulfill({ status: 201, json: created });
        return;
      }

      if (request.method() === "PATCH") {
        const body = request.postDataJSON();
        const addonItemId = pathname.split("/").pop();
        const updatedAt = "2026-06-01T10:10:00.000Z";
        const updated = addonItems
          .filter((item) => item.addonItemId === addonItemId)
          .map((item) => ({ ...item, ...body, updatedAt }))[0];
        typedItemWrites.push({ method: "PATCH", pathname, body });
        addonItems = addonItems.map((item) =>
          item.addonItemId === addonItemId ? (updated ?? item) : item,
        );
        await route.fulfill({ json: updated });
        return;
      }

      if (request.method() === "DELETE") {
        const addonItemId = pathname.split("/").pop();
        typedItemWrites.push({ method: "DELETE", pathname });
        addonItems = addonItems.filter((item) => item.addonItemId !== addonItemId);
        await route.fulfill({ status: 204 });
        return;
      }

      expect(request.method()).toBe("GET");
      await route.fulfill({ json: { addonItems, propertyPlan, propertyCurrency: "EUR" } });
    });
    await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        typedWrites.push(body);
        await route.fulfill({ json: body });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      await route.fulfill({
        json: { showAddonsStep: true, groupAddonsByCategory: false },
      });
    });

    await page.goto("/booking-flow");
    await page.getByRole("button", { name: /^Add-ons$/ }).click();

    const addonNames = page.getByTestId("booking-addon-item-name");
    await expect(addonNames).toHaveText(["Airport transfer", "Breakfast basket"]);

    await page
      .getByRole("button", { name: "Drag Airport transfer" })
      .dragTo(page.getByTestId("booking-addon-item-addon_breakfast_basket"));

    await expect(addonNames).toHaveText(["Breakfast basket", "Airport transfer"]);

    await page.getByRole("button", { name: "Add Experience" }).click();
    await page.getByLabel("Name").fill("Spa ritual");
    await page.getByLabel("Description").fill("Private treatment.");
    await page.getByLabel("Price").fill("125.50");
    await page.getByLabel("Category").selectOption("wellness");
    await page.getByLabel("Duration").fill("90 min");
    await page.getByRole("radio", { name: "Per person", exact: true }).check();
    await page.getByLabel("Ownership").selectOption("partner");
    await page.getByRole("button", { name: "Create Add-on" }).click();
    expect(typedItemWrites.filter((write) => write.method === "POST")).toHaveLength(0);
    await page.getByLabel("Partner commission (%)").fill("12.5000");
    await page.getByRole("button", { name: "Create Add-on" }).click();
    await expect(page.getByText("Spa ritual")).toBeVisible();
    await expect(page.getByText("Partner · 12.5000%")).toBeVisible();

    await page.getByRole("button", { name: "Edit Spa ritual" }).click();
    await page.getByLabel("Name").fill("Spa ritual deluxe");
    await page.getByLabel("Ownership").selectOption("property");
    await expect(page.getByLabel("Partner commission (%)")).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Spa ritual deluxe")).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete Spa ritual deluxe" }).click();
    await expect(page.getByText("Spa ritual deluxe")).not.toBeVisible();

    await expect(page.getByRole("heading", { name: "Display Settings" })).toBeVisible();
    await expect(page.getByRole("switch", { name: /Show Add-ons Step/ })).toBeVisible();

    const groupToggle = page.getByRole("switch", { name: /Group by Category/ });
    await expect(groupToggle).toBeVisible();
    await groupToggle.click();

    await expect.poll(() => typedWrites.length).toBe(1);

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(itemContractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_ADDON_SETTINGS_PATH);
    expect(itemContractRequests[0]).toEqual({
      method: "GET",
      pathname: BOOKING_ADMIN_ADDON_ITEMS_PATH,
    });
    const reorderWrites = typedItemWrites.filter(
      (write) =>
        write.method === "PATCH" &&
        typeof write.body === "object" &&
        write.body !== null &&
        "sortOrder" in write.body,
    );
    expect(reorderWrites).toEqual(
      expect.arrayContaining([
        {
          method: "PATCH",
          pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_airport_transfer`,
          body: { sortOrder: 1 },
        },
        {
          method: "PATCH",
          pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_breakfast_basket`,
          body: { sortOrder: 0 },
        },
      ]),
    );

    const nonReorderWrites = typedItemWrites.filter((write) => !reorderWrites.includes(write));
    expect(nonReorderWrites).toEqual([
      {
        method: "POST",
        pathname: BOOKING_ADMIN_ADDON_ITEMS_PATH,
        body: {
          name: "Spa ritual",
          description: "Private treatment.",
          price: "125.50",
          currency: "EUR",
          category: "wellness",
          photos: [],
          leadTime: null,
          location: null,
          maxGuests: null,
          maxQuantity: 1,
          duration: "90 min",
          pricingModel: "per_guest",
          publicVisible: true,
          status: "active",
          sortOrder: 2,
          ownershipKind: "partner",
          partnerCommissionRate: "12.5000",
        },
      },
      {
        method: "PATCH",
        pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_spa_ritual`,
        body: {
          name: "Spa ritual deluxe",
          description: "Private treatment.",
          price: "125.50",
          currency: "EUR",
          category: "wellness",
          photos: [],
          leadTime: null,
          location: null,
          maxGuests: null,
          maxQuantity: 1,
          duration: "90 min",
          pricingModel: "per_guest",
          ownershipKind: "property",
          partnerCommissionRate: null,
        },
      },
      {
        method: "DELETE",
        pathname: `${BOOKING_ADMIN_ADDON_ITEMS_PATH}/addon_spa_ritual`,
      },
    ]);
    expect(typedWrites).toEqual([{ showAddonsStep: true, groupAddonsByCategory: true }]);

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
