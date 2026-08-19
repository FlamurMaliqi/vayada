import { expect, test } from "@playwright/test";
import { mockPmsWebAuthenticatedSession, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";
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
    await expect(page.getByText(/room blocks are available/i)).toBeVisible();
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
});
