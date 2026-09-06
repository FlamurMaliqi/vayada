import { expect, test } from "@playwright/test";

import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_ROOM_TYPE_ID,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

const baseRoomRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`;
const roomRoute = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms**`;
const roomIds = ["room_101", "room_102"];

test("calendar matches Rooms & Rates across mixed types, saved room order and reloads", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const types = ["Double Room", "Twin Room", "Bungalow"].map((name) => ({
    ...pmsWebRoomType,
    roomTypeId: name,
    name,
    roomCount: 2,
  }));
  // Interleaved API order, including a deliberately saved 10-before-2 order.
  let rooms = [
    ["Double Room", "10"],
    ["Twin Room", "1"],
    ["Bungalow", "A2"],
    ["Twin Room", "2"],
    ["Double Room", "2"],
    ["Bungalow", "A10"],
  ].map(([roomTypeId, number], sortOrder) => ({
    roomId: `${roomTypeId}-${number}`,
    roomTypeId,
    roomNumber: `${roomTypeId} ${number}`,
    sortOrder,
    status: "available",
    metadata: {},
  }));
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({ json: { items: types, propertyId: PMS_WEB_PROPERTY_ID } }),
  );
  await page.unroute(baseRoomRoute);
  let version = "original-flat-order-version";
  await page.route(roomRoute, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
        },
      });
    }
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      expect(body.expectedVersion).toBe(version);
      expect(new Set(body.orderedRoomIds).size).toBe(rooms.length);
      rooms = body.orderedRoomIds.map((id: string) => rooms.find((room) => room.roomId === id)!);
      version = "saved-order-version";
      return route.fulfill({
        json: { orderVersion: version, orderedRoomIds: body.orderedRoomIds },
      });
    }
    return route.fulfill({
      json: { items: rooms, orderVersion: version, propertyId: PMS_WEB_PROPERTY_ID },
    });
  });
  const expected = [
    "Double Room 10",
    "Double Room 2",
    "Twin Room 1",
    "Twin Room 2",
    "Bungalow A2",
    "Bungalow A10",
  ];
  const roomLabels = () => page.getByText(/^#/);
  const checkRoomsAndRates = async () => {
    await page.goto("/rooms");
    for (const type of types) await page.getByText(type.name, { exact: true }).click();
    await expect(roomLabels()).toHaveText(expected.map((label) => `#${label}`));
  };
  await checkRoomsAndRates();
  await page.goto("/calendar");
  await expect(roomLabels()).toHaveText(expected.map((label) => `#${label}`));
  await page.getByRole("button", { name: "Room view options" }).click();
  await page.getByRole("button", { name: "Reorder rooms" }).click();
  for (const index of [0, 2, 4])
    await expect(page.getByRole("button", { name: "Move up" }).nth(index)).toBeDisabled();
  for (const index of [1, 3, 5])
    await expect(page.getByRole("button", { name: "Move down" }).nth(index)).toBeDisabled();
  await page.getByRole("button", { name: "Move down" }).first().click();
  [expected[0], expected[1]] = [expected[1], expected[0]];
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByText("Reordering rooms")).not.toBeVisible();
  await page.reload();
  await expect(roomLabels()).toHaveText(expected.map((label) => `#${label}`));
  await checkRoomsAndRates();
});

test("room order can be cancelled, saved, and restored after reload", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);

  let rooms = roomIds.map((roomId, index) => ({
    roomId,
    roomTypeId: PMS_WEB_ROOM_TYPE_ID,
    roomNumber: String(101 + index),
    floor: "1",
    status: "available",
    sortOrder: index + 1,
    metadata: { roomTypeName: "Alpine Suite" },
  }));
  const savedOrders: string[][] = [];
  let orderVersion = "room-order-v1";
  let releaseFirstPatch!: () => void;
  let markFirstPatchStarted!: () => void;
  const firstPatchDelay = new Promise<void>((resolve) => (releaseFirstPatch = resolve));
  const firstPatchStarted = new Promise<void>((resolve) => (markFirstPatchStarted = resolve));
  let patchAttempts = 0;
  const fetchedOrderVersions: string[] = [];
  let delayNextRoomFetch = false;
  let releaseRoomFetch!: () => void;
  let markRoomFetchStarted!: () => void;
  const roomFetchDelay = new Promise<void>((resolve) => (releaseRoomFetch = resolve));
  const roomFetchStarted = new Promise<void>((resolve) => (markRoomFetchStarted = resolve));
  await page.unroute(baseRoomRoute);
  await page.route(roomRoute, async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": route.request().headers().origin ?? "*",
          "Access-Control-Allow-Headers": "authorization,content-type",
          "Access-Control-Allow-Methods": "GET,PATCH,OPTIONS",
        },
      });
    }
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        expectedVersion: string;
        orderedRoomIds: string[];
      };
      patchAttempts += 1;
      if (patchAttempts === 1) {
        expect(body.expectedVersion).toBe("room-order-v1");
        markFirstPatchStarted();
        await firstPatchDelay;
        orderVersion = "room-order-v2";
        return route.fulfill({
          status: 409,
          json: { code: "room_order_conflict", message: "Rooms changed elsewhere." },
        });
      }
      expect(body.expectedVersion).toBe("room-order-v2");
      savedOrders.push(body.orderedRoomIds);
      rooms = body.orderedRoomIds.map((roomId, index) => ({
        ...rooms.find((room) => room.roomId === roomId)!,
        sortOrder: index + 1,
      }));
      orderVersion = "room-order-v3";
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          orderedRoomIds: body.orderedRoomIds,
          orderVersion,
          commandMeta: {},
        },
      });
    }
    if (delayNextRoomFetch) {
      delayNextRoomFetch = false;
      markRoomFetchStarted();
      await roomFetchDelay;
    }
    fetchedOrderVersions.push(orderVersion);
    return route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: rooms,
        orderVersion,
        sourceFreshness: {},
      },
    });
  });

  await page.goto("/calendar");
  const menu = page.getByRole("button", { name: "Room view options" });
  const roomCells = page.locator("table tbody > tr > td:first-child");

  await menu.click();
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await menu.click();
  await page.getByRole("button", { name: "Reorder rooms" }).click();

  await expect(page.getByText("Reordering rooms")).toBeVisible();
  await expect(roomCells.nth(0)).toContainText("#101");
  await expect(roomCells.nth(1)).toContainText("#102");
  await expect(page.getByRole("button", { name: "Move up" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move down" }).last()).toBeDisabled();

  await page.getByRole("button", { name: "Move down" }).first().click();
  await expect(roomCells.nth(0)).toContainText("#102");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(roomCells.nth(0)).toContainText("#101");
  expect(savedOrders).toEqual([]);

  await menu.click();
  await page.getByRole("button", { name: "Month", exact: true }).click();
  orderVersion = "room-order-v2";
  delayNextRoomFetch = true;
  await menu.click();
  await page.getByRole("button", { name: "Reorder rooms" }).click();
  await roomFetchStarted;
  releaseRoomFetch();
  await expect.poll(() => fetchedOrderVersions.at(-1)).toBe("room-order-v2");
  await page.getByRole("button", { name: "Move down" }).first().click();
  await page.getByRole("button", { name: "Save order" }).click();
  await firstPatchStarted;
  await expect(page.getByRole("button", { name: "Move down" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Move up" }).last()).toBeDisabled();
  releaseFirstPatch();
  await expect(
    page.getByRole("alert").filter({ hasText: "Rooms changed elsewhere" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save order" }).click();
  await expect.poll(() => savedOrders).toEqual([["room_102", "room_101"]]);

  await page.reload();
  await expect(roomCells.nth(0)).toContainText("#102");
  await expect(roomCells.nth(1)).toContainText("#101");
});
