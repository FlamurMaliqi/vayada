import { expect, test, type Page } from "@playwright/test";

import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_ROOM_ID,
  PMS_WEB_ROOM_TYPE_ID,
} from "../support/pmsWebMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";

test.describe("target PMS room blocks", () => {
  test("creates, rejects a stale edit, updates, and releases without a page reload", async ({
    page,
  }, testInfo) => {
    await page.clock.setFixedTime(new Date("2026-08-11T12:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    const target = await mockRoomBlockCommands(page);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "pms-web-operations");
    let documentLoads = 0;
    page.on("request", (request) => {
      if (request.resourceType() === "document") documentLoads += 1;
    });

    await page.goto("/calendar");
    await expect(page.getByRole("button", { name: "Block Room" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "New Booking" })).toBeDisabled();

    await page.getByRole("button", { name: "Block Room" }).click();
    await page.locator('input[type="date"]').nth(0).fill("2026-08-20");
    await page.locator('input[type="date"]').nth(1).fill("2026-08-23");
    await page.getByRole("checkbox").check();
    await page.getByPlaceholder(/Maintenance/).fill("Maintenance");
    await page.getByRole("button", { name: "Block room", exact: true }).click();
    await expect(page.getByText("Maintenance").first()).toBeVisible();

    target.rejectNextPatch();
    await page.getByText("Maintenance").first().click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.locator('input[type="date"]').nth(1).fill("2026-08-25");
    await page.getByPlaceholder(/Maintenance/).fill("Extended maintenance");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Room block changed. Refresh and try again.")).toBeVisible();
    expect(target.activeBlocks()).toHaveLength(1);

    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Extended maintenance").first()).toBeVisible();
    await page.getByText("Extended maintenance").first().click();
    await page.getByRole("button", { name: "Unblock" }).click();
    await page.getByRole("button", { name: "Unblock" }).click();
    await expect(page.getByText("Extended maintenance")).toHaveCount(0);

    expect(target.methods()).toEqual(["POST", "PATCH", "PATCH", "DELETE"]);
    expect(target.refreshCount()).toBeGreaterThanOrEqual(4);
    expect(target.payloads()).toEqual([
      expect.objectContaining({
        roomTypeId: PMS_WEB_ROOM_TYPE_ID,
        roomIds: [PMS_WEB_ROOM_ID],
        startsOn: "2026-08-20",
        endsOn: "2026-08-22",
      }),
      expect.objectContaining({ expectedVersion: "room-block-v1", endsOn: "2026-08-24" }),
      expect.objectContaining({ expectedVersion: "room-block-v1", endsOn: "2026-08-24" }),
      expect.objectContaining({ expectedVersion: "room-block-v2" }),
    ]);
    expect(documentLoads).toBe(1);
    await assertNoLegacyCalls();
  });

  test("creates a room block from the mobile calendar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime(new Date("2026-08-11T12:00:00.000Z"));
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    const target = await mockRoomBlockCommands(page);

    await page.goto("/calendar");
    await page.getByRole("button", { name: "Block" }).click();
    await page.getByRole("checkbox").check();
    await page.getByPlaceholder(/Maintenance/).fill("Mobile maintenance");
    await page.getByRole("button", { name: "Block room", exact: true }).click();

    await expect(page.getByText("Mobile maintenance").first()).toBeVisible();
    expect(target.methods()).toEqual(["POST"]);
    expect(target.payloads()[0]).toMatchObject({
      roomIds: [PMS_WEB_ROOM_ID],
      startsOn: "2026-08-11",
      endsOn: "2026-08-11",
    });
  });
});

async function mockRoomBlockCommands(page: Page) {
  const baseRoutePattern = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`;
  const routePattern = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks**`;
  const requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let refreshes = 0;
  let stalePatch = false;
  let blocks: Array<Record<string, unknown>> = [];
  await page.unroute(baseRoutePattern);
  await page.route(routePattern, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") {
      const origin = route.request().headers().origin ?? "*";
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "authorization,content-type",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Credentials": "true",
        },
      });
    }
    if (method === "GET") {
      refreshes += 1;
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: blocks.filter((block) => block.status === "active"),
          sourceFreshness: {},
        },
      });
    }
    const payload = route.request().postDataJSON() as Record<string, unknown>;
    requests.push({ method, payload });
    if (method === "PATCH" && stalePatch) {
      stalePatch = false;
      return route.fulfill({
        status: 409,
        json: {
          statusCode: 409,
          code: "version_conflict",
          category: "conflict",
          message: "Room block changed. Refresh and try again.",
        },
      });
    }
    if (method === "POST") {
      blocks = (payload.roomIds as string[]).map((roomId, index) => ({
        blockId: `room-block-${index + 1}`,
        version: "room-block-v1",
        roomTypeId: payload.roomTypeId,
        roomId,
        startsOn: payload.startsOn,
        endsOn: payload.endsOn,
        blockedCount: 1,
        reason: payload.reason,
        status: "active",
      }));
    } else if (method === "PATCH") {
      blocks = blocks.map((block) => ({
        ...block,
        version: "room-block-v2",
        startsOn: payload.startsOn ?? block.startsOn,
        endsOn: payload.endsOn ?? block.endsOn,
        reason: payload.reason ?? block.reason,
      }));
    } else if (method === "DELETE") {
      blocks = blocks.map((block) => ({ ...block, version: "room-block-v3", status: "released" }));
    }
    return route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: blocks,
        commandMeta: {
          commandId: payload.commandId,
          idempotencyKey: payload.idempotencyKey,
          sideEffects: ["calendar_refresh", "ari_changed", "audit_event"],
        },
      },
    });
  });
  return {
    rejectNextPatch: () => {
      stalePatch = true;
    },
    activeBlocks: () => blocks.filter((block) => block.status === "active"),
    methods: () => requests.map((request) => request.method),
    payloads: () => requests.map((request) => request.payload),
    refreshCount: () => refreshes,
  };
}
