import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_ROOM_ID,
  PMS_WEB_ROOM_TYPE_ID,
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

  test("shares the supported Feature Hub inventory without unfinished PMS modules", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    let affiliatesActive = false;
    let activationReads = 0;
    let activationWrites = 0;
    let releaseInitialRead = () => {};
    const initialRead = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    const activationPath = `/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations`;

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(new RegExp(`${activationPath}(?:/[^/]+)?$`), async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        activationReads += 1;
        await initialRead;
        return route.fulfill({
          json: {
            hotelId: PMS_WEB_PROPERTY_ID,
            canManage: true,
            supportedModules: ["affiliates"],
            activeModules: affiliatesActive ? ["affiliates"] : [],
            activations: [],
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
        json: {
          moduleId: "affiliates",
          isActive: affiliatesActive,
          activatedAt: affiliatesActive ? "2026-08-31T00:00:00.000Z" : null,
          deactivatedAt: affiliatesActive ? null : "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z",
        },
      });
    });
    await page.goto("/settings/feature-hub");

    await expect(page.getByRole("heading", { name: "Feature Hub" })).toBeVisible();
    await expect.poll(() => activationReads).toBeGreaterThan(0);
    await expect(page.getByRole("status")).toHaveText("Loading modules...");
    await expect(page.getByText("No modules in this category.")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /navigation$/i })).toHaveCount(0);
    releaseInitialRead();
    await expect(page.locator("article")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Affiliates", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /PMS Modules/i })).toHaveCount(0);
    for (const unavailable of ["Inbox", "Financials", "Lodgify", "Stripe", "PayPal", "Xendit"]) {
      await expect(page.getByRole("heading", { name: unavailable, exact: true })).toHaveCount(0);
    }
    const preview = page
      .getByRole("heading", { name: "Booking Engine navigation" })
      .locator("xpath=ancestor::section");
    await expect(preview.getByRole("listitem")).toHaveText([
      "Dashboard",
      "Design Studio",
      "Booking Flow",
      "Promo Codes",
      "Settings",
    ]);

    const activate = page.getByRole("switch", { name: "Activate Affiliates" });
    await activate.focus();
    await expect(activate).toBeFocused();
    await activate.press("Space");
    await expect.poll(() => activationWrites).toBe(1);
    await expect(page.getByRole("switch", { name: "Deactivate Affiliates" })).toBeChecked();

    const readsBeforeReload = activationReads;
    await page.reload();
    await expect.poll(() => activationReads).toBeGreaterThan(readsBeforeReload);
    await expect(page.getByRole("switch", { name: "Deactivate Affiliates" })).toBeChecked();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Affiliates", exact: true })).toBeVisible();
    await expect(preview).toBeVisible();
    await page.getByRole("button", { name: "Details" }).click();
    await expect(page.getByRole("dialog", { name: "Affiliates" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Affiliates" })).toHaveCount(0);

    await assertHealthy();
  });

  test("keeps a failed Feature Hub inventory read out of the PMS empty state", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations*`, (route) =>
      route.fulfill({ status: 503, json: { detail: "Feature Hub unavailable." } }),
    );

    await page.goto("/settings/feature-hub");

    await expect(page.getByText("Feature Hub unavailable.")).toBeVisible();
    await expect(page.getByText("No modules in this category.")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /navigation$/i })).toHaveCount(0);
    await expect(page.locator("article")).toHaveCount(0);
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
    const calendarSection = page.locator("section#calendar");
    await expect(
      calendarSection.getByRole("switch", { name: "Allow same-day bookings" }),
    ).toBeVisible();
    await expect(calendarSection.getByLabel("Same-day booking cutoff")).toHaveValue("18:00");
    await expect(
      calendarSection.getByText("This setting is shared between PMS and Booking Engine."),
    ).toBeVisible();
    const autoOpen = calendarSection.getByRole("switch", {
      name: "Auto-open future calendar",
    });
    await expect(autoOpen).not.toBeChecked();
    await expect(calendarSection.getByText(/Current horizon: Not active/)).toBeVisible();
    await expect(
      page
        .locator("section#booking-engine")
        .getByRole("switch", { name: "Allow same-day bookings" }),
    ).toHaveCount(0);
    await expect(page.getByText("Check-in & Check-out", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No settings can be changed here yet.")).toHaveCount(0);
    const checklistLinks = page.getByRole("link", { name: "Check-in checklist" });
    await expect(checklistLinks.last()).toBeVisible();
    await expect(page.getByRole("link", { name: "Check-out inspection" }).last()).toBeVisible();
    const teamLinks = page.getByRole("link", { name: "Team & Roles" });
    await expect(teamLinks.last()).toHaveAttribute("href", "/settings/team");

    await page.setViewportSize({ width: 390, height: 844 });
    await autoOpen.focus();
    await expect(autoOpen).toBeFocused();
    await autoOpen.press("Space");
    await calendarSection.getByLabel("Open through").selectOption("24");
    await calendarSection.getByRole("button", { name: "Save auto-open" }).click();
    await expect(calendarSection.getByRole("status")).toContainText(
      "Inventory and connected channels are updating",
    );
    await expect(calendarSection.getByText(/Current horizon: Sep 30, 2028/)).toBeVisible();
    await expect(calendarSection.getByRole("alert")).toContainText(
      `${PMS_WEB_ROOM_TYPE_ID} has no positive rate`,
    );
    await expect(checklistLinks.first()).toBeVisible();
    await checklistLinks.first().focus();
    await expect(checklistLinks.first()).toBeFocused();

    await assertHealthy();
  });

  test("shows the canonical staff roster through the Team & Roles deep link", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.goto("/settings/team");

    await expect(page.getByRole("heading", { name: "Team & Roles" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Team & Roles" }).last()).toHaveAttribute(
      "aria-current",
      "page",
    );
    const roster = page.getByRole("table");
    await expect(roster.getByText("Ada Lovelace")).toBeVisible();
    await expect(roster.getByText("ada@example.com")).toBeVisible();
    await expect(roster.getByText("Front Desk")).toBeVisible();
    await expect(roster.getByText("Alpenrose Munich")).toBeVisible();
    await expect(roster.getByText("Active", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileTeamLink = page.getByRole("link", { name: "Team & Roles" }).first();
    await expect(mobileTeamLink).toBeVisible();
    await mobileTeamLink.focus();
    await expect(mobileTeamLink).toBeFocused();

    await assertHealthy();
  });

  test("deactivates and reactivates staff while preserving failed status changes", async ({
    page,
  }) => {
    const rosterPath = "**/api/identity/staff/members";
    const statusPath = "**/api/identity/staff/members/*/status";
    const requests: Array<{ idempotencyKey: string | undefined; status: string }> = [];
    let releaseFirstRequest!: () => void;
    const firstRequestPending = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.unroute(rosterPath);
    await page.route(rosterPath, (route) =>
      route.fulfill({
        json: {
          members: [
            {
              id: "staff_membership_ada",
              name: "Ada Lovelace",
              email: "ada@example.com",
              roleKey: "front_desk",
              propertyIds: [PMS_WEB_PROPERTY_ID],
              status: "active",
              lastActiveAt: "2026-08-24T12:00:00.000Z",
            },
            {
              id: "staff_membership_grace",
              name: "Grace Hopper",
              email: "grace@example.com",
              roleKey: "hotel_manager",
              propertyIds: [PMS_WEB_PROPERTY_ID],
              status: "pending",
              lastActiveAt: null,
            },
          ],
        },
      }),
    );
    await page.route(statusPath, async (route) => {
      const status = (route.request().postDataJSON() as { status: string }).status;
      requests.push({
        idempotencyKey: route.request().headers()["idempotency-key"],
        status,
      });
      if (requests.length === 1) await firstRequestPending;
      return requests.length === 1
        ? route.fulfill({ status: 503, json: { code: "staff_status_update_failed" } })
        : route.fulfill({
            json: { membershipId: "staff_membership_ada", status },
          });
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/settings/team");

    const adaRow = page.getByRole("row").filter({ hasText: "Ada Lovelace" });
    const graceRow = page.getByRole("row").filter({ hasText: "Grace Hopper" });
    await expect(graceRow.getByText("Invitation pending")).toBeVisible();
    await expect(graceRow.getByRole("button")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const deactivate = adaRow.getByRole("button", { name: "Deactivate Ada Lovelace" });
    await deactivate.focus();
    await expect(deactivate).toBeFocused();
    await deactivate.click();
    await expect(
      adaRow.getByRole("button", { name: "Saving status for Ada Lovelace" }),
    ).toHaveAttribute("aria-busy", "true");
    releaseFirstRequest();
    await expect(adaRow.getByRole("alert")).toHaveText("Couldn’t update Ada Lovelace. Try again.");
    await expect(adaRow.getByText("Active", { exact: true })).toBeVisible();

    await deactivate.click();
    await expect(adaRow.getByText("Deactivated", { exact: true })).toBeVisible();
    const reactivate = adaRow.getByRole("button", { name: "Reactivate Ada Lovelace" });
    await reactivate.click();
    await expect(adaRow.getByText("Active", { exact: true })).toBeVisible();

    expect(requests.map((request) => request.status)).toEqual([
      "deactivated",
      "deactivated",
      "active",
    ]);
    expect(new Set(requests.map((request) => request.idempotencyKey)).size).toBe(3);
    expect(
      requests.every((request) => request.idempotencyKey?.startsWith("pms-staff-status:")),
    ).toBe(true);
  });

  test("distinguishes loading, empty, and failed team rosters", async ({ page }) => {
    const rosterPath = "**/api/identity/staff/members";
    let releaseRoster!: () => void;
    const rosterRelease = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(rosterPath, async (route) => {
      await rosterRelease;
      return route.fulfill({ json: { members: [] } });
    });
    await page.goto("/settings/team");

    await expect(page.getByRole("status")).toHaveText("Loading team members…");
    releaseRoster();
    await expect(page.getByText("No team members yet")).toBeVisible();

    await page.unroute(rosterPath);
    await page.route(rosterPath, (route) =>
      route.fulfill({ status: 503, json: { code: "staff_roster_failed" } }),
    );
    await page.reload();

    const alert = page.getByRole("alert").filter({ hasText: "We couldn’t load your team." });
    await expect(alert).toContainText("We couldn’t load your team.");
    const retry = alert.getByRole("button", { name: "Retry" });
    await retry.focus();
    await expect(retry).toBeFocused();

    await page.unroute(rosterPath);
    await page.route(rosterPath, (route) => route.fulfill({ json: { members: [] } }));
    await retry.click();
    await expect(page.getByText("No team members yet")).toBeVisible();
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
    await expect(page.getByRole("button", { name: /new booking/i }).first()).toBeEnabled();

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

  test("prices a new calendar booking and handles preview failures", async ({ page }, testInfo) => {
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "pms-web-operations");
    let previewAttempt = 0;
    let releaseFirstPreview!: () => void;
    const firstPreviewPending = new Promise<void>((resolve) => {
      releaseFirstPreview = resolve;
    });
    const manualBookingPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/manual-bookings`;

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [
            {
              ...pmsWebRoomType,
              ratePlans: [
                {
                  ratePlanId: "flexible-rate",
                  pricingContractVersion: "pms-pricing.v1",
                  name: "Flexible",
                  rateType: "flexible",
                  baseRate: { amountDecimal: "180.00", currency: "EUR" },
                  active: true,
                },
              ],
            },
          ],
          sourceFreshness: {},
        },
      }),
    );
    await page.route(`${manualBookingPath}/addons`, (route) =>
      route.fulfill({ json: { contractVersion: "pms-manual-booking.v1", addOns: [] } }),
    );
    await page.route(`${manualBookingPath}/capabilities`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-manual-booking.v1",
          canRecordPaidPayment: false,
        },
      }),
    );
    await page.route(`${manualBookingPath}/preview`, async (route) => {
      previewAttempt += 1;
      const body = route.request().postDataJSON();
      expect(body.stays[0]).toMatchObject({
        roomId: PMS_WEB_ROOM_ID,
        ratePlanId: "flexible-rate",
      });
      if (previewAttempt === 1) {
        await firstPreviewPending;
        return route.fulfill({
          json: {
            contractVersion: "pms-manual-booking.v1",
            currency: "EUR",
            stays: [
              {
                position: 1,
                roomId: PMS_WEB_ROOM_ID,
                ratePlanId: "flexible-rate",
                nightly: [],
                standardTotal: { amountDecimal: "360.00", currency: "EUR" },
                appliedTotal: { amountDecimal: "360.00", currency: "EUR" },
              },
            ],
            addOns: [],
            grandTotal: { amountDecimal: "360.00", currency: "EUR" },
          },
        });
      }
      if (previewAttempt === 2) {
        return route.fulfill({
          status: 503,
          json: {
            code: "manual_booking_preview_unavailable",
            message: "Preview is unavailable.",
          },
        });
      }
      return route.fulfill({
        status: 404,
        json: {
          code: "rate_plan_not_found",
          message: "rate plan not found.",
          field: "ratePlanId",
          stayPosition: 1,
        },
      });
    });

    await page.goto("/calendar");
    await page
      .getByRole("button", { name: /new booking/i })
      .last()
      .click();
    const dialog = page.getByRole("dialog", { name: "New booking" });
    await dialog.getByLabel("Room 1 check-in").fill("2026-09-10");
    await dialog.getByLabel("Room 1 check-out").fill("2026-09-12");
    const createBooking = dialog.getByRole("button", { name: "Create booking" });

    await expect(dialog.locator("[data-pricing-spinner]")).toBeVisible();
    await expect(createBooking).toBeDisabled();
    releaseFirstPreview();
    await expect(dialog.getByText("Total €360")).toBeVisible();
    await expect(createBooking).toBeEnabled();

    await dialog.getByLabel("Room 1 check-out").fill("2026-09-13");
    await expect(dialog.getByRole("alert")).toContainText("Couldn't calculate pricing.");
    await dialog.getByRole("button", { name: "Retry pricing" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "No rate found for 2026-09-10 – 2026-09-13. Set up a season in Rooms & Rates first.",
    );
    await expect(createBooking).toBeDisabled();
    await assertNoLegacyCalls();
  });
});
