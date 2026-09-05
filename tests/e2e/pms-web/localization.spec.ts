import { expect, test } from "@playwright/test";

import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_ROOM_ID,
  PMS_WEB_ROOM_TYPE_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

test("applies German to login", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("admin_language", "de"));

  await page.goto("/login");

  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { name: "Bei vayada anmelden" })).toBeVisible();
  await expect(
    page.getByText("Melden Sie sich mit Ihrer E-Mail-Adresse und Ihrem Passwort an."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Mit Google fortfahren" })).toBeVisible();
  await expect(page.getByText("oder", { exact: true })).toBeVisible();
});

test("applies German across settings and room setup", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("admin_language", "de"));
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);

  await page.goto("/settings");

  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(page.getByRole("heading", { name: "Einstellungen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unterkunft" }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Kalender" }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Buchungsmaschine" }).last()).toBeVisible();
  await expect(page.getByRole("link", { name: "Posteingang" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Bewertungen" })).toBeVisible();
  await expect(page.getByText("Property Details", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Inbox", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Reviews", { exact: true })).toHaveCount(0);

  await expect(page.getByText(/Ankünfte ·/)).toBeVisible();
  await page
    .getByRole("button", { name: "Reservierungen, Gäste, Zimmer, Einstellungen, Seiten suchen..." })
    .click();
  await expect(
    page.getByPlaceholder("Reservierungen, Gäste, Zimmer, Einstellungen, Seiten suchen..."),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto("/rooms/new");

  await expect(page.getByRole("heading", { name: "Neuer Zimmertyp" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Zimmerdetails" })).toBeVisible();
  await expect(page.getByText("Zimmertyp-Grundlagen", { exact: true })).toBeVisible();
  await expect(page.getByText("Zimmertyp-Name")).toBeVisible();
  await expect(page.getByText("Maximale Gesamtbelegung")).toBeVisible();
  await expect(page.getByText("Max. Erwachsene", { exact: true })).toBeVisible();
  await expect(page.getByText("Max. Kinder", { exact: true })).toBeVisible();
  await expect(page.getByText("Gesamtzahl Zimmer")).toBeVisible();
  await expect(page.getByText("Zimmergröße (m²)")).toBeVisible();

  await page.getByRole("button", { name: "Preise & Tarife" }).click();
  await expect(page.getByRole("heading", { name: "Wann haben Sie geöffnet?" })).toBeVisible();

  await page.getByRole("button", { name: "Bilder & Ausstattung" }).click();
  await expect(page.getByText("Zimmerbilder", { exact: true })).toBeVisible();

  for (const englishCopy of [
    "Room Details",
    "Pricing & Rates",
    "Images & Amenities",
    "Room Type Basics",
    "Total Rooms",
  ]) {
    await expect(page.getByText(englishCopy, { exact: true })).toHaveCount(0);
  }

  const templateResponse = {
    contractVersion: "pms-operations.v1",
    propertyId: PMS_WEB_PROPERTY_ID,
    template: { steps: [], updatedAt: null, updatedByUserId: null },
    sourceFreshness: {},
  };
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-in-checklist`, (route) =>
    route.fulfill({ json: templateResponse }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-out-inspection`, (route) =>
    route.fulfill({ json: templateResponse }),
  );

  await page.goto("/settings/checkin-checklist");
  await page.getByRole("button", { name: "Standardwerte wiederherstellen" }).click();
  await expect(page.getByText("Ausweise oder Reisepässe der Gäste prüfen").first()).toBeVisible();
  await expect(page.getByText("Verify guest IDs / passports", { exact: true })).toHaveCount(0);

  await page.goto("/settings/checkout-inspection");
  await page.getByRole("button", { name: "Schritt hinzufügen" }).click();
  await expect(page.getByText("Problem", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Details hinzufügen…", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Issue", { exact: true })).toHaveCount(0);

  const startsOn = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  const endsOn = new Date(`${startsOn}T12:00:00Z`);
  endsOn.setUTCDate(endsOn.getUTCDate() + 1);
  await page.unroute(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`);
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [
          {
            blockId: "localized-room-block",
            version: "room-block-v1",
            roomTypeId: PMS_WEB_ROOM_TYPE_ID,
            roomId: PMS_WEB_ROOM_ID,
            startsOn,
            endsOn: endsOn.toISOString().slice(0, 10),
            blockedCount: 1,
            reason: null,
            status: "active",
          },
        ],
        sourceFreshness: {},
      },
    }),
  );

  await page.goto("/calendar");
  await expect(page.getByRole("button", { name: "Gesperrt", exact: true })).toBeVisible();
  await expect(page.getByText("Blocked", { exact: true })).toHaveCount(0);
});
