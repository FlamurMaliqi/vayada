import { expect, test } from "@playwright/test";
import {
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  PMS_WEB_PROPERTY_ID,
  pmsWebRoomType,
} from "../support/pmsWebMocks";

test("creates, renames and safely retires physical rooms using target commands", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const roomTypeId = "f1000000-0000-4000-8000-000000000002";
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        items: [{ ...pmsWebRoomType, roomTypeId }],
        sourceFreshness: {},
      },
    }),
  );
  let revision = 1;
  let label = "101";
  let exists = true;
  const writes: string[] = [];
  const roomId = "f1000000-0000-4000-8000-000000000001";
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        sourceFreshness: {},
        items: exists
          ? [
              {
                roomId,
                roomTypeId: roomTypeId,
                roomNumber: label,
                floor: "1",
                status: "available",
                sortOrder: 1,
                metadata: { roomUnitsRevision: revision },
              },
            ]
          : [],
      },
    }),
  );
  await page.route(
    `**/api/pms/setup/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}/capacity`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "pms-room-facts.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId: roomTypeId,
          roomUnitsRevision: revision,
          activeUnitCount: exists ? 1 : 0,
          capturedAt: new Date().toISOString(),
        },
      }),
  );
  let protect = true;
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types/${roomTypeId}/physical-units**`,
    async (route) => {
      const method = route.request().method();
      if (method === "OPTIONS")
        return route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "POST,PUT,DELETE",
          },
        });
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(revision);
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      writes.push(method);
      if (method === "POST" && body.changes?.operationalLabel === "104") {
        return route.fulfill({
          status: 409,
          json: {
            code: "operational_label_conflict",
            message: "A room with this number already exists.",
          },
        });
      }
      if (method === "DELETE" && protect) {
        protect = false;
        return route.fulfill({
          status: 409,
          json: {
            code: "physical_room_protected",
            message: "This room has a protected reservation.",
          },
        });
      }
      revision++;
      exists = method !== "DELETE";
      if (body.changes?.operationalLabel) label = body.changes.operationalLabel;
      return route.fulfill({
        json: {
          propertyId: PMS_WEB_PROPERTY_ID,
          roomTypeId: roomTypeId,
          roomUnitId: roomId,
          roomUnitsRevision: revision,
        },
      });
    },
  );
  await page.goto("/rooms");
  await page.getByText("Alpine Suite", { exact: true }).first().click();
  await page.getByRole("button", { name: /rename room/i }).click();
  await page.locator('input[value="101"]').fill("102");
  await page.getByTitle("Save", { exact: true }).click();
  await expect(page.getByText(/^#102/)).toBeVisible();
  await page.getByRole("button", { name: "Add Room", exact: true }).click();
  await page.getByPlaceholder(/room number/i).fill("102");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("A room with this number already exists.");
  await expect(page.getByPlaceholder(/room number/i)).toHaveValue("102");
  await page.getByPlaceholder(/room number/i).fill("103");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /delete room/i }).click();
  const dialog = page.waitForEvent("dialog");
  await page
    .getByRole("button", { name: /delete room/i })
    .last()
    .click();
  const blocker = await dialog;
  expect(blocker.message()).toContain("protected reservation");
  await blocker.accept();
  await expect(page.getByText(/^#102/)).toBeVisible();
  await page.getByRole("button", { name: /delete room/i }).click();
  await page
    .getByRole("button", { name: /delete room/i })
    .last()
    .click();
  await expect(page.getByText(/^#102/)).toHaveCount(0);
  await page.getByRole("button", { name: "Add Room", exact: true }).click();
  await page.getByPlaceholder(/room number/i).fill("104");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("A room with this number already exists.");
  await expect(page.getByPlaceholder(/room number/i)).toHaveValue("104");
  await page.getByPlaceholder(/room number/i).fill("103");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/^#103/)).toBeVisible();
  expect(writes).toEqual(["PUT", "DELETE", "DELETE", "POST", "POST"]);
});
