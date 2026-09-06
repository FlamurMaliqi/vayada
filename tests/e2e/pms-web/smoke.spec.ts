import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_ROOM_ID,
  PMS_WEB_ROOM_TYPE_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebInboxThread,
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

  test("keeps a failed Feature Hub inventory read out of the PMS empty state", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations*`, (route) =>
      route.fulfill({ status: 503, json: { detail: "Feature Hub unavailable." } }),
    );

    await page.goto("/settings/feature-hub");

    await expect(page.getByText("Could not load modules. Please retry.")).toBeVisible();
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
    await expect(page.getByRole("button", { name: /Ada Lovelace, Booking.com/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Not available yet" })).toHaveCount(0);

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

  test("runs the guest Inbox workflow at mobile, tablet, and desktop widths", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/inbox");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    const desktopThread = page.getByRole("button", { name: /Ada Lovelace, Booking.com/ });
    await expect(desktopThread).toBeVisible();
    await desktopThread.click();
    await expect(page.getByRole("heading", { level: 2, name: "Ada Lovelace" })).toBeVisible();
    await expect(page.getByText("Linked booking")).toBeVisible();
    await expect(page.getByRole("separator", { name: "Unread messages" })).not.toBeVisible();
    const moreActions = page.getByRole("button", { name: "More conversation actions" });
    await moreActions.click();
    const providerAction = page.getByRole("button", { name: /Tell Booking.com/ });
    await expect(providerAction).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(moreActions).toBeFocused();
    await moreActions.click();
    await providerAction.click();
    await expect(providerAction).toHaveCount(0);
    const quickReplies = page.getByRole("button", { name: "Quick replies" });
    await quickReplies.click();
    await expect(page.getByRole("button", { name: /Early arrival/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(quickReplies).toBeFocused();
    await page.getByLabel("Reply").fill("We will check and get back to you shortly.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Queued", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 768, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await expect(page.getByRole("button", { name: "Guest & stay" })).toBeVisible();
    await page.getByRole("button", { name: "Guest & stay" }).click();
    const contextDrawer = page.getByRole("dialog", { name: "Guest and stay" });
    await expect(contextDrawer).toBeVisible();
    await expect
      .poll(async () => (await contextDrawer.boundingBox())?.x)
      .toBeGreaterThanOrEqual(360);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/inbox");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    const mobileThread = page.getByRole("button", { name: /Ada Lovelace, Booking.com/ });
    await mobileThread.click();
    await expect(page.getByRole("button", { name: "Back to Inbox" })).toBeVisible();
    await expect(page.getByLabel("Reply")).toBeVisible();
    await page.getByRole("button", { name: "Back to Inbox" }).click();
    await expect(mobileThread).toBeFocused();

    await assertHealthy();
  });

  test("keeps read-only Inbox access useful and preserves a reply after a version conflict", async ({
    page,
  }) => {
    const quickRepliesPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/quick-replies**`;
    const threadsPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads**`;
    let replyFailure: "version" | "resource" = "version";

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.unroute(quickRepliesPath);
    await page.route(quickRepliesPath, (route) =>
      route.fulfill({
        status: 403,
        json: {
          error: {
            code: "missing_permission",
            message: "Missing required PMS Inbox reply permission.",
            requestId: "request-read-only",
          },
        },
      }),
    );
    await page.goto("/inbox");
    await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
    await expect(page.getByText("Could we arrive a little early?")).toBeVisible();
    await expect(page.getByText(/Reply access is required/)).toBeVisible();
    await expect(page.getByLabel("Reply")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Translate" })).toHaveCount(0);

    await page.unroute(quickRepliesPath);
    await page.route(quickRepliesPath, (route) =>
      route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [],
        },
      }),
    );
    await page.route(threadsPath, (route) => {
      if (
        route.request().method() === "POST" &&
        new URL(route.request().url()).pathname.endsWith("/messages")
      ) {
        if (replyFailure === "resource") {
          return route.fulfill({
            status: 403,
            json: {
              error: {
                code: "missing_resource_access",
                message: "This property is no longer available.",
                requestId: "request-mutation-property-denied",
              },
            },
          });
        }
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "thread_version_conflict",
              message: "The conversation changed. Refresh and try again.",
              requestId: "request-version-conflict",
              details: { currentVersion: 4 },
            },
          },
        });
      }
      return route.fallback();
    });
    await page.reload();
    await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
    const reply = page.getByLabel("Reply");
    await reply.fill("Please keep this unsent draft.");
    await reply.press("Control+Enter");
    await expect(reply).toHaveValue("Please keep this unsent draft.");
    await expect(
      page.getByRole("alert").filter({ hasText: "Your draft is preserved" }),
    ).toBeVisible();
    replyFailure = "resource";
    await reply.press("Control+Enter");
    await expect(page.getByRole("heading", { name: "Inbox access unavailable" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.has("thread")).toBe(false);
  });

  test("keeps guest search out of browser history while restoring operational filters", async ({
    page,
  }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.goto("/inbox");

    await page.getByLabel("Search conversations").fill("Ada Lovelace");
    await expect.poll(() => page.url()).not.toContain("Ada");
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("unread")).toBe("true");
  });

  test("clears property Inbox data when read access is denied", async ({ page }) => {
    const threadsPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads**`;

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.unroute(threadsPath);
    await page.route(threadsPath, (route) =>
      route.fulfill({
        status: 403,
        json: {
          error: {
            code: "missing_resource_access",
            message: "This property is no longer available.",
            requestId: "request-property-denied",
          },
        },
      }),
    );

    await page.goto("/inbox?thread=thread-booking");
    await expect(page.getByRole("heading", { name: "Inbox access unavailable" })).toBeVisible();
    await expect(page.getByText("Ada Lovelace")).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.has("thread")).toBe(false);
  });

  test("clears cached Inbox data when a reply denial cannot revalidate read access", async ({
    page,
  }) => {
    const quickRepliesPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/quick-replies**`;
    const threadsPath = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads**`;

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.unroute(quickRepliesPath);
    await page.route(quickRepliesPath, (route) =>
      route.fulfill({
        status: 403,
        json: {
          error: {
            code: "missing_permission",
            message: "Missing required PMS Inbox permission.",
            requestId: "request-capability-denied",
          },
        },
      }),
    );
    await page.route(threadsPath, (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.pathname.endsWith("/messaging/threads") &&
        url.searchParams.get("limit") === "1"
      ) {
        return route.fulfill({
          status: 403,
          json: {
            error: {
              code: "missing_permission",
              message: "Missing required PMS Inbox read permission.",
              requestId: "request-read-recheck-denied",
            },
          },
        });
      }
      return route.fallback();
    });

    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Inbox access unavailable" })).toBeVisible();
    await expect(page.getByText("Ada Lovelace")).toHaveCount(0);
  });

  test("focuses the next conversation after a selected thread disappears", async ({ page }) => {
    const graceThread = {
      ...pmsWebInboxThread,
      id: "thread_grace_after_delete",
      guest: { displayName: "Grace Hopper" },
      unreadCount: 0,
    };
    let listRequests = 0;

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads**`,
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET") return route.fallback();
        if (url.pathname.endsWith("/messaging/threads")) {
          listRequests += 1;
          return route.fulfill({
            json: {
              contractVersion: "native-guest-inbox.v2",
              items: listRequests === 1 ? [pmsWebInboxThread, graceThread] : [graceThread],
              nextCursor: null,
            },
          });
        }
        if (url.pathname.endsWith(`/${pmsWebInboxThread.id}`)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return route.fulfill({
            status: 404,
            json: {
              error: {
                code: "thread_not_found",
                message: "Inbox thread was not found.",
                requestId: "request-thread-removed",
              },
            },
          });
        }
        return route.fallback();
      },
    );

    await page.goto(`/inbox?thread=${encodeURIComponent(pmsWebInboxThread.id)}`);
    const grace = page.getByRole("button", { name: /Grace Hopper, Booking.com/ });
    await expect(grace).toBeFocused();
    await expect.poll(() => new URL(page.url()).searchParams.has("thread")).toBe(false);
  });

  test("does not show a stale conversation after rapid thread selection", async ({ page }) => {
    let releaseAda!: () => void;
    let noteAdaRequested!: () => void;
    let noteAdaCompleted!: () => void;
    const adaRelease = new Promise<void>((resolve) => {
      releaseAda = resolve;
    });
    const adaRequested = new Promise<void>((resolve) => {
      noteAdaRequested = resolve;
    });
    const adaCompleted = new Promise<void>((resolve) => {
      noteAdaCompleted = resolve;
    });
    const graceThread = {
      ...pmsWebInboxThread,
      id: "thread_grace",
      guest: { displayName: "Grace Hopper" },
      unreadCount: 0,
      lastMessage: {
        preview: "Thank you for the directions.",
        at: "2026-09-04T08:15:00.000Z",
        hasAttachments: false,
      },
    };

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads**`,
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET") return route.fallback();
        if (url.pathname.endsWith("/messaging/threads")) {
          return route.fulfill({
            json: {
              contractVersion: "native-guest-inbox.v2",
              items: [pmsWebInboxThread, graceThread],
              nextCursor: null,
            },
          });
        }
        if (url.pathname.endsWith(`/${pmsWebInboxThread.id}`)) {
          noteAdaRequested();
          await adaRelease;
          await route.fulfill({
            json: {
              contractVersion: "native-guest-inbox.v2",
              thread: pmsWebInboxThread,
              availableProviderActions: ["booking_com_no_reply_needed"],
              timeline: [],
              previousCursor: null,
            },
          });
          noteAdaCompleted();
          return;
        }
        if (url.pathname.endsWith(`/${graceThread.id}`)) {
          return route.fulfill({
            json: {
              contractVersion: "native-guest-inbox.v2",
              thread: graceThread,
              availableProviderActions: [],
              timeline: [],
              previousCursor: null,
            },
          });
        }
        return route.fallback();
      },
    );

    await page.goto("/inbox");
    await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
    await adaRequested;
    await page.getByRole("button", { name: /Grace Hopper, Booking.com/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Grace Hopper" })).toBeVisible();
    releaseAda();
    await adaCompleted;
    await expect(page.getByRole("heading", { level: 2, name: "Grace Hopper" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Ada Lovelace" })).toHaveCount(0);
  });

  test("creates a verified room type without updating payment settings", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "pms-web-operations");
    const createdRoomTypeId = "99999999-9999-4999-8999-000000000001";
    const unitIds = [
      "99999999-9999-4999-8999-000000000002",
      "99999999-9999-4999-8999-000000000003",
    ];
    let paymentSettingsWrites = 0;
    let roomTypeCreates = 0;
    const labelWrites: Record<string, unknown>[] = [];
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
          item: {
            ...pmsWebRoomType,
            roomTypeId: createdRoomTypeId,
            name: "Castrop Suite",
            baseRate: { amountDecimal: "200.00", currency: "USD" },
            roomCount: 2,
          },
          commandMeta: { replayed: false },
        },
      });
    });
    await page.route(
      `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${createdRoomTypeId}/capacity`,
      (route) =>
        route.fulfill({
          json: {
            contractVersion: "pms-room-facts.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            roomTypeId: createdRoomTypeId,
            roomUnitsRevision: 1,
            activeUnitCount: 2,
            capturedAt: "2026-09-04T00:00:00.000Z",
          },
        }),
    );
    await page.route(
      `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${createdRoomTypeId}/units`,
      (route) =>
        route.fulfill({
          json: {
            items: unitIds.map((roomUnitId) => ({
              contractVersion: "pms-room-facts.v1",
              propertyId: PMS_WEB_PROPERTY_ID,
              roomTypeId: createdRoomTypeId,
              roomUnitId,
              lifecycle: "active",
              operationalLabel: null,
              operationalLabelStatus: "unverified",
            })),
          },
        }),
    );
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${createdRoomTypeId}/physical-units/*/operational-label`,
      (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        labelWrites.push(body);
        return route.fulfill({
          json: {
            contractVersion: "pms-room-facts.v1",
            outcome: "updated",
            propertyId: PMS_WEB_PROPERTY_ID,
            roomTypeId: createdRoomTypeId,
            roomUnitId: new URL(route.request().url()).pathname.split("/").at(-2),
            roomUnitsRevision: Number(body.expectedRevision) + 1,
            operationalLabel: body.operationalLabel,
            operationalLabelStatus: "verified",
            acceptedAt: "2026-09-04T00:00:00.000Z",
          },
        });
      },
    );

    const canonicalAt = "2026-09-04T00:00:00.000Z";
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-source`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-pricing.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          pricingCurrency: {
            contractVersion: "pms-pricing.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            currency: "USD",
            pricingCurrencyRevision: 1,
            createdAt: canonicalAt,
            updatedAt: canonicalAt,
          },
          flexibleRatePlans: [],
          capturedAt: canonicalAt,
        },
      }),
    );
    await page.route(
      `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${createdRoomTypeId}`,
      (route) =>
        route.fulfill({
          json: {
            contractVersion: "pms-room-facts.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            roomTypeId: createdRoomTypeId,
            roomFactsRevision: 1,
            lifecycle: "active",
            facts: {
              name: "Castrop Suite",
              description: "Suite",
              category: "suite",
              occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
              beds: [{ type: "king", quantity: 1 }],
              bedrooms: 1,
              bathrooms: 1,
              bathroomType: "private",
              size: null,
            },
            createdAt: canonicalAt,
            updatedAt: canonicalAt,
          },
        }),
    );
    let savedCreatePlan: Record<string, unknown> | undefined;
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${createdRoomTypeId}/flexible-rate-plan`,
      (route) => {
        savedCreatePlan = route.request().postDataJSON();
        return route.fulfill({
          json: {
            contractVersion: "pms-pricing.v1",
            outcome: "created",
            flexibleRatePlan: {
              contractVersion: "pms-pricing.v1",
              propertyId: PMS_WEB_PROPERTY_ID,
              roomTypeId: createdRoomTypeId,
              flexibleRatePlanId: "44444444-4444-4444-8444-444444444444",
              flexibleRatePlanRevision: 1,
              sourceRoomFactsRevision: 1,
              baseAmount: { amountDecimal: savedCreatePlan!.baseAmountDecimal, currency: "USD" },
              cancellationTerms: savedCreatePlan!.cancellationTerms,
              createdAt: canonicalAt,
              updatedAt: canonicalAt,
            },
            acceptedAt: canonicalAt,
          },
        });
      },
    );

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
    expect(savedCreatePlan).toMatchObject({
      expectedRoomFactsRevision: 1,
      expectedPricingCurrencyRevision: 1,
      expectedFlexibleRatePlanRevision: 0,
      baseAmountDecimal: "200.00",
    });
    expect(labelWrites).toEqual([
      { expectedRevision: 1, operationalLabel: "Castrop Suite 1" },
      { expectedRevision: 2, operationalLabel: "Castrop Suite 2" },
    ]);
    expect(paymentSettingsWrites).toBe(0);
    await expect(
      page.getByText("Payment settings updates is not available on PMS next-stack yet."),
    ).toHaveCount(0);
    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("saves a room rate through the canonical pricing owner", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "pms-web-operations");
    const roomTypeId = "22222222-2222-4222-8222-222222222222";
    let savedRate = "180.00";
    let canonicalPlanRevision = 0;
    let savedPlanBody: Record<string, unknown> | undefined;
    let roomReads = 0;
    const roomType = () => ({
      ...pmsWebRoomType,
      roomTypeId,
      version: "room-type-facts-v3",
      roomMediaRevision: 1,
      ratePlans:
        canonicalPlanRevision === 0
          ? []
          : [
              {
                ratePlanId: "11111111-1111-4111-8111-111111111111",
                pricingContractVersion: "pms-pricing.v1",
                code: "ONB15-FLEX",
                name: "Flexible",
                rateType: "flexible",
                mealPlan: null,
                baseRate: { amountDecimal: savedRate, currency: "EUR" },
                active: true,
              },
            ],
    });

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}`,
      (route) => {
        roomReads += 1;
        return route.fulfill({ json: { propertyId: PMS_WEB_PROPERTY_ID, item: roomType() } });
      },
    );
    const setupPath = `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}`;
    await page.route(`${setupPath}/capacity`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-room-facts.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId,
          roomUnitsRevision: 2,
          activeUnitCount: 1,
          capturedAt: "2026-09-04T00:00:00.000Z",
        },
      }),
    );
    await page.route(`${setupPath}/units`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              contractVersion: "pms-room-facts.v1",
              propertyId: PMS_WEB_PROPERTY_ID,
              roomTypeId,
              roomUnitId: "33333333-3333-4333-8333-333333333333",
              lifecycle: "active",
              operationalLabel: "Alpine Suite 1",
              operationalLabelStatus: "verified",
            },
          ],
        },
      }),
    );
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/pricing-source`, (route) =>
      route.fulfill({
        json: {
          pricingCurrency: { currency: "EUR", pricingCurrencyRevision: 4 },
          flexibleRatePlans:
            canonicalPlanRevision === 0
              ? []
              : [
                  {
                    roomTypeId,
                    flexibleRatePlanId: "11111111-1111-4111-8111-111111111111",
                    flexibleRatePlanRevision: canonicalPlanRevision,
                    sourceRoomFactsRevision: 3,
                    baseAmount: { amountDecimal: savedRate, currency: "EUR" },
                    cancellationTerms: {},
                  },
                ],
        },
      }),
    );
    await page.route(
      `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}/flexible-rate-plan`,
      (route) => {
        savedPlanBody = route.request().postDataJSON() as Record<string, unknown>;
        savedRate = "125.00";
        canonicalPlanRevision = 1;
        return route.fulfill({
          json: {
            flexibleRatePlan: {
              roomTypeId,
              flexibleRatePlanId: "11111111-1111-4111-8111-111111111111",
              flexibleRatePlanRevision: canonicalPlanRevision,
              sourceRoomFactsRevision: 3,
              baseAmount: { amountDecimal: savedRate, currency: "EUR" },
              cancellationTerms: {},
            },
          },
        });
      },
    );

    await page.goto(`/rooms/${roomTypeId}`);
    await page.getByRole("button", { name: "Pricing & Rates" }).click();
    await expect(page.getByText("(standard plan)")).toBeVisible();
    await expect(
      page.getByRole("combobox").filter({ has: page.locator('option[value="EUR"]') }),
    ).toBeDisabled();
    await expect(page.getByText("Currency is managed in property pricing settings.")).toBeVisible();
    const rateTable = page.getByText("Set rates per season").locator("xpath=../..");
    await rateTable.getByRole("spinbutton").first().fill("125");
    const readsBeforeLanguageChange = roomReads;
    await page.getByRole("button", { name: "PO", exact: true }).click();
    await page.getByRole("button", { name: /^Language/ }).click();
    await page.getByRole("button", { name: "🇩🇪 Deutsch", exact: true }).click();
    await expect(page.getByRole("button", { name: "Preise & Tarife" })).toBeVisible();
    await page.getByRole("button", { name: "PO", exact: true }).click();
    await page.getByRole("button", { name: /^Sprache/ }).click();
    await page.getByRole("button", { name: "🇬🇧 English", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pricing & Rates" })).toBeVisible();
    expect(roomReads).toBe(readsBeforeLanguageChange);
    await expect(rateTable.getByRole("spinbutton").first()).toHaveValue("125");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Room type updated successfully")).toBeVisible();
    expect(savedPlanBody).toMatchObject({
      expectedRoomFactsRevision: 3,
      expectedPricingCurrencyRevision: 4,
      expectedFlexibleRatePlanRevision: 0,
      baseAmountDecimal: "125.00",
    });
    await page.getByRole("button", { name: "Pricing & Rates" }).click();
    await expect(rateTable.getByRole("spinbutton").first()).toHaveValue("125");
    await assertNoLegacyCalls();
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
