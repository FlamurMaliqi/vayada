import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_ADDON_ITEMS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";

test("shared editor validates, uploads five photos, changes cover, removes and reopens", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const noLegacy = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");
  await mockBookingAdminBookingFlow(page);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("https://addon-photos.test/**", (route) =>
    route.fulfill({ contentType: "image/png", body: png }),
  );
  let uploads = 0;
  await page.route("**/api/media/upload-sessions", async (route) => {
    expect(route.request().postDataJSON().purpose).toBe("booking.addon.image");
    uploads++;
    await route.fulfill({
      json: {
        uploadSession: { sessionId: String(uploads), status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: String(uploads),
            uploadUrl: "https://uploads.vayada.localhost/test",
            method: "PUT",
            headers: {},
          },
        ],
      },
    });
  });
  await page.route("**/api/media/upload-sessions/*/finalize", async (route) => {
    const index = route.request().url().split("/").at(-2);
    await route.fulfill({
      json: {
        mediaObjects: [
          {
            mediaId: `d3000000-0000-4000-8000-00000000068${index}`,
            variants: [{ publicCdnUrl: `https://addon-photos.test/${index}.png` }],
          },
        ],
      },
    });
  });
  let items: Record<string, unknown>[] = [];
  await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, async (route) => {
    const method = route.request().method();
    if (method === "GET")
      return route.fulfill({
        json: {
          addonItems: items,
          propertyCurrency: "EUR",
          propertyPlan: { plan: "fixed", limits: { maxAddons: 9 } },
        },
      });
    const body = route.request().postDataJSON();
    const photos = body.photos.map((photo: { mediaObjectId: string; isCover: boolean }) => ({
      ...photo,
      imageUrl: `https://addon-photos.test/${photo.mediaObjectId.slice(-1)}.png`,
    }));
    const cover = photos.find((photo: { isCover: boolean }) => photo.isCover);
    items = [
      {
        ...body,
        photos,
        imageUrl: cover?.imageUrl ?? null,
        imageMediaObjectId: cover?.mediaObjectId ?? null,
        addonItemId: "breakfast",
        sortOrder: 0,
      },
    ];
    await route.fulfill({ status: method === "POST" ? 201 : 200, json: items[0] });
  });
  await page.goto("/booking-flow");
  await page.getByRole("button", { name: /^Add-ons$/ }).click();
  await page.getByRole("button", { name: "Add Experience" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create Add-on", exact: true }).click();
  await expect(dialog.getByText("Name is required.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create Add-on", exact: true })).toBeEnabled();
  await dialog.getByLabel(/^Name \*/).fill("Breakfast");
  await dialog.getByLabel(/^Base price \(EUR\) \*/).fill("15.00");
  await dialog.getByRole("radio", { name: /^Per person \/ night/ }).check();
  await dialog.getByLabel("Max quantity", { exact: true }).fill("2");
  await dialog.getByLabel("Lead time", { exact: true }).fill("24h before");
  await dialog
    .getByLabel("Add photos", { exact: true })
    .setInputFiles(
      Array.from({ length: 5 }, (_, i) => ({
        name: `photo-${i}.png`,
        mimeType: "image/png",
        buffer: png,
      })),
    );
  await expect(dialog.getByLabel("Add photos", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Set photo 3 as cover", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("addon-editor-five-photos.png") });
  await dialog.getByRole("button", { name: "Create Add-on", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(uploads).toBe(5);
  expect(items[0]).toMatchObject({
    currency: "EUR",
    pricingModel: "per_guest_night",
    maxQuantity: 2,
    leadTime: "24h before",
  });
  await page.getByRole("button", { name: "Edit Breakfast", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Set photo 3 as cover", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Remove photo 2", exact: true }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Edit Breakfast", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^Set photo/ })).toHaveCount(4);
  await expect(
    dialog.getByRole("button", { name: "Set photo 2 as cover", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await noLegacy();
});
