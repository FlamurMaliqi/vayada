import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebRoomType,
} from "../support/pmsWebMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test.describe("pms-web smoke", () => {
  test("login page renders custom password auth", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in to vayada/i, level: 1 })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await assertHealthy();
  });

  test("@signup signup renders custom password auth", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/signup");

    await expect(
      page.getByRole("heading", { name: /create your vayada account/i, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();

    await assertHealthy();
  });

  test("shows Settings and Feature Hub after Channel Manager", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.goto("/dashboard");

    const navigation = page.getByRole("navigation");
    const channelManager = navigation.getByText("Channel Manager", { exact: true }).locator("..");
    const settings = channelManager.locator("xpath=following-sibling::*[1]");
    const featureHub = settings.locator("xpath=following-sibling::*[1]");

    await expect(settings).toHaveAttribute("href", "/settings");
    await expect(featureHub).toHaveAttribute("href", "/settings/feature-hub");

    await settings.click();
    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();
    await featureHub.click();
    await expect(page.getByRole("heading", { name: "Feature Hub" })).toBeVisible();

    await assertHealthy();
  });

  test("keeps unfinished Feature Hub modules and empty product tabs hidden", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    const activationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations`,
    );
    await page.goto("/settings/feature-hub");

    await expect(page.getByRole("heading", { name: "Feature Hub" })).toBeVisible();
    await activationResponse;
    await expect(page.locator("article")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /PMS Modules/i })).toHaveCount(0);
    for (const unavailable of ["Inbox", "Financials", "Affiliates"]) {
      await expect(page.getByRole("heading", { name: unavailable, exact: true })).toHaveCount(0);
    }
    const preview = page
      .getByRole("heading", { name: "PMS navigation" })
      .locator("xpath=ancestor::section");
    await expect(preview.getByRole("listitem")).toHaveText([
      "Dashboard",
      "Calendar",
      "Reservations",
      "Reviews",
      "Rooms & Rates",
      "Channel Manager",
      "Settings",
    ]);

    await assertHealthy();
  });

  test("settings only lists delivered destinations", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.goto("/settings#calendar");

    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Calendar" }).last()).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("Check-in & Check-out", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No settings can be changed here yet.")).toHaveCount(0);
    const checklistLinks = page.getByRole("link", { name: "Check-in checklist" });
    await expect(checklistLinks.last()).toBeVisible();
    await expect(page.getByRole("link", { name: "Check-out inspection" }).last()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(checklistLinks.first()).toBeVisible();
    await checklistLinks.first().focus();
    await expect(checklistLinks.first()).toBeFocused();

    await assertHealthy();
  });

  test("loads migrated PMS operations surfaces without legacy helper calls", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "pms-web-operations");

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);

    await page.goto("/rooms");
    await expect(page.getByRole("heading", { name: /rooms/i })).toBeVisible();
    await expect(page.getByText("Alpine Suite").first()).toBeVisible();

    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: /calendar/i })).toBeVisible();
    await expect(page.getByText("Alpine Suite").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /block room/i }).first()).toBeEnabled();
    await expect(page.getByRole("button", { name: /new booking/i }).first()).toBeDisabled();

    await page.goto("/channel-manager");
    await expect(page.getByRole("heading", { level: 1, name: /channel/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Channex connection" })).toBeVisible();
    await expect(page.getByText(/observe-only mode/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable connection" })).toBeDisabled();

    await page.goto("/inbox");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Not available yet" })).toBeVisible();

    await page.goto("/financials");
    await expect(page.getByRole("heading", { level: 1, name: "Financials" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Not available yet" })).toBeVisible();

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();
    await expect(page.getByLabel("Timezone")).toHaveValue("Europe/Berlin");
    await expect(page.getByLabel("Country (ISO code)")).toHaveValue("DE");
    await expect(page.getByText("Booking.com", { exact: true })).toBeVisible();
    await expect(page.getByText("Other OTA", { exact: true })).toBeVisible();
    await expect(page.getByText("Not configured")).toHaveCount(4);
    await page.getByRole("button", { name: "Configure" }).first().click();
    await page.getByLabel("Commission percentage").fill("14.25");
    await page.getByLabel("Effective time (your device timezone)").fill("2026-09-01T12:00");
    await page.getByRole("button", { name: "Save commission" }).click();
    await expect(page.getByRole("button", { name: "Configure" }).first()).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("Airbnb saved at 14.25%");
    await expect(page.getByText(/14.25%.*Revision 1/)).toBeVisible();
    await expect(page.getByText("Editing not available yet")).toBeVisible();
    const instantAcceptance = page.getByRole("switch", {
      name: "Accept bookings instantly",
    });
    await expect(instantAcceptance).toBeChecked();
    await instantAcceptance.click();
    await expect(instantAcceptance).not.toBeChecked();
    await expect(page.getByText("Booking acceptance settings saved")).toBeVisible();

    await page.goto("/settings/feature-hub");
    await expect(page.getByText("Inbox", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Financials", { exact: true })).toHaveCount(0);

    await page.goto("/bookings");
    await expect(page.getByRole("heading", { name: /reservation|booking/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Ada Lovelace/ }).first()).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("creates a room type without updating payment settings", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    let paymentSettingsWrites = 0;
    let roomTypeCreates = 0;
    let notePaymentSettingsRequested!: () => void;
    let releasePaymentSettings!: () => void;
    const paymentSettingsRequested = new Promise<void>((resolve) => {
      notePaymentSettingsRequested = resolve;
    });
    const paymentSettingsRelease = new Promise<void>((resolve) => {
      releasePaymentSettings = resolve;
    });

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/payment-settings`,
      async (route) => {
        if (route.request().method() === "GET") {
          notePaymentSettingsRequested();
          await paymentSettingsRelease;
          return route.fallback();
        }
        paymentSettingsWrites += 1;
        return route.fulfill({
          status: 501,
          json: { message: "Payment settings updates is not available on PMS next-stack yet." },
        });
      },
    );
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      roomTypeCreates += 1;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ name: "Castrop Suite", currency: "USD" });
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: pmsWebRoomType,
          commandMeta: { replayed: false },
        },
      });
    });

    await page.goto("/rooms/new");
    await page.getByPlaceholder("e.g. Two-Bedroom Villa").fill("Castrop Suite");
    await page.getByRole("button", { name: "Pricing & Rates" }).click();
    await page.getByRole("button", { name: "Add season" }).click();
    const seasonCard = page.getByPlaceholder("Season name").locator("xpath=../..");
    await page.getByPlaceholder("Season name").fill("Year-round");
    await seasonCard.getByRole("combobox").nth(1).selectOption("1");
    await seasonCard.getByRole("combobox").nth(2).selectOption("1");
    await seasonCard.getByRole("combobox").nth(3).selectOption("31");
    await seasonCard.getByRole("combobox").nth(4).selectOption("12");
    const rateTable = page.getByText("Set rates per season").locator("xpath=../..");
    const currency = rateTable.getByRole("combobox");
    await paymentSettingsRequested;
    await currency.selectOption("USD");
    const paymentSettingsResponse = page.waitForResponse(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/payment-settings`,
    );
    releasePaymentSettings();
    await paymentSettingsResponse;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(currency).toHaveValue("USD");
    await rateTable.getByRole("spinbutton").first().fill("200");
    await page.getByRole("button", { name: "Create Room Type" }).click();

    await expect(page).toHaveURL(/\/rooms$/);
    expect(roomTypeCreates).toBe(1);
    expect(paymentSettingsWrites).toBe(0);
    await expect(
      page.getByText("Payment settings updates is not available on PMS next-stack yet."),
    ).toHaveCount(0);
    await assertHealthy();
  });
});
