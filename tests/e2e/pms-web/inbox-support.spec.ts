import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebInboxThread,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

for (const viewport of [
  { width: 320, height: 720 },
  { width: 390, height: 844 },
  { width: 390, height: 480 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
]) {
  test(`keeps Help clear of the Inbox composer at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize(viewport);
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    let supportRequests = 0;
    await page.route("**/api/support", async (route) => {
      supportRequests += 1;
      expect(route.request().postDataJSON()).toEqual({
        kind: "bug",
        message: "Synthetic mobile support test",
        page: "/inbox",
        product: "pms",
      });
      await route.fulfill({ json: { status: "accepted", reference: "support-e2e" } });
    });

    await page.goto("/inbox");
    await page.getByRole("button", { name: /Ada Lovelace, Booking.com/ }).click();
    const reply = page.getByRole("textbox", { name: "Reply", exact: true });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const help = page.getByRole("button", { name: "Help / Report a bug", exact: true });
    await reply.fill("Draft preserved while asking for help.");
    await expect(send).toBeEnabled();
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Help / Report a bug" }),
    ).toBeVisible();
    const helpBox = await help.boundingBox();
    const replyBox = await reply.boundingBox();
    expect(helpBox).not.toBeNull();
    expect(replyBox).not.toBeNull();
    expect(helpBox!.width).toBeGreaterThanOrEqual(44);
    expect(helpBox!.height).toBeGreaterThanOrEqual(44);
    expect(helpBox!.y + helpBox!.height).toBeLessThanOrEqual(replyBox!.y);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);

    // Test the bottom edge that the former floating Help button covered.
    const sendBox = await send.boundingBox();
    expect(sendBox).not.toBeNull();
    await send.click({ trial: true, position: { x: sendBox!.width / 2, y: sendBox!.height - 2 } });
    await page.screenshot({ path: testInfo.outputPath("inbox-help-layout.png") });

    await help.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Help and bug reports" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(help).toBeFocused();
    await expect(reply).toHaveValue("Draft preserved while asking for help.");

    await help.click();
    await dialog.getByLabel("What do you need?").selectOption("bug");
    await dialog.getByLabel("Message", { exact: true }).fill("Synthetic mobile support test");
    await dialog.getByRole("button", { name: "Send request" }).click();
    await expect(dialog.getByRole("status")).toContainText("support-e2e");
    expect(supportRequests).toBe(1);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(reply).toHaveValue("Draft preserved while asking for help.");
    await send.click();
    await expect(page.getByText("Queued", { exact: true })).toBeVisible();
    await assertHealthy();
  });
}

test("keeps mobile Help accessible while direct email sending is held", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(
    (url) =>
      url.pathname ===
      `/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads/${pmsWebInboxThread.id}`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          thread: {
            ...pmsWebInboxThread,
            channel: "email",
            providerChannel: null,
            unreadCount: 0,
            lastMessage: { preview: null, at: null, hasAttachments: false },
            replyRoute: {
              state: "held",
              channel: null,
              providerChannel: null,
              reasonCode: "approved_sender_unavailable",
            },
          },
          availableProviderActions: [],
          timeline: [],
          previousCursor: null,
        },
      }),
  );
  await page.goto(`/inbox?thread=${pmsWebInboxThread.id}`);
  const reply = page.getByRole("textbox", { name: "Reply", exact: true });
  await reply.fill("Do not send this draft.");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeDisabled();
  const help = page.getByRole("button", { name: "Help / Report a bug", exact: true });
  const helpBox = await help.boundingBox();
  const sendBox = await send.boundingBox();
  expect(helpBox!.y + helpBox!.height).toBeLessThanOrEqual(sendBox!.y);
  await help.click();
  await expect(page.getByRole("dialog", { name: "Help and bug reports" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reply).toHaveValue("Do not send this draft.");
  await expect(send).toBeDisabled();
});
