import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";

test("host date editing previews impact and retries an uncertain apply with the same key", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  const previews: unknown[] = [],
    applied: Array<{ idempotencyKey: string }> = [];
  let accepted = false;
  await page.route(base, (route) =>
    accepted
      ? route.fulfill({ status: 503, json: { message: "Read unavailable" } })
      : route.fulfill({ json: { item: pmsWebReservation } }),
  );
  await page.route(`${base}/host-actions/preview`, (route) => {
    previews.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        previewId: "12790000-0000-4000-8000-000000000001",
        expiresAt: "2099-01-01T12:10:00Z",
        impact: {
          checkIn: "2026-10-12",
          checkOut: "2026-10-14",
          totalAmount: "200.00",
          newTotalAmount: "240.00",
          currency: "EUR",
          cancellationPolicy: {
            type: "flexible",
            previousDeadline: "2026-10-05",
            newDeadline: "2026-10-06",
            timezone: "Europe/Berlin",
          },
          inventory: "replace",
          payment: "no_payment_received",
        },
      },
    });
  });
  await page.route(`${base}/host-actions/apply`, (route) => {
    applied.push(route.request().postDataJSON());
    if (applied.length === 1)
      return route.fulfill({ status: 503, json: { message: "Response unavailable" } });
    accepted = true;
    return route.fulfill({
      json: { bookingId: PMS_WEB_RESERVATION_ID, lifecycleStatus: "confirmed" },
    });
  });
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const section = page.getByRole("region", { name: "Booking actions" });
  await section.getByRole("button", { name: "Edit stay dates" }).click();
  await section.getByLabel("Check-in", { exact: true }).fill("2026-10-12");
  await section.getByLabel("Check-out", { exact: true }).fill("2026-10-14");
  await section.getByLabel("Internal reason (not sent to the guest)").fill("Guest phoned");
  await section.getByRole("button", { name: "Preview impact" }).click();
  await expect(section.getByText("Booking total: 200.00 → 240.00 EUR")).toBeVisible();
  expect(previews).toEqual([
    {
      action: "edit_dates",
      reason: "Guest phoned",
      guestMessage: "",
      checkIn: "2026-10-12",
      checkOut: "2026-10-14",
    },
  ]);
  await expect(
    section.getByText("Free cancellation through: 2026-10-05 → 2026-10-06 (Europe/Berlin)"),
  ).toBeVisible();
  expect(applied).toHaveLength(0);
  await section.getByRole("button", { name: "Apply previewed action" }).click();
  await expect(section.getByRole("alert")).toContainText("Response unavailable");
  await section.getByRole("button", { name: "Apply previewed action" }).click();
  expect(applied[1]).toEqual(applied[0]);
  await expect(section.getByRole("status")).toContainText(
    "Booking updated, but the latest details could not be loaded.",
  );
});

test("a stale host cancellation preview can be refreshed before apply", async ({ page }) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  await page.route(base, (route) => route.fulfill({ json: { item: pmsWebReservation } }));
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  let previews = 0;
  await page.route(`${base}/host-actions/preview`, (route) => {
    previews++;
    return route.fulfill({
      json: {
        previewId: `preview-${previews}`,
        expiresAt: "2099-01-01T12:10:00Z",
        impact: {
          checkIn: "2026-10-12",
          checkOut: "2026-10-14",
          totalAmount: "200.00",
          newTotalAmount: "200.00",
          currency: "EUR",
          inventory: "release",
          payment: "no_payment_received",
        },
      },
    });
  });
  await page.route(`${base}/host-actions/apply`, (route) =>
    route.fulfill({
      status: 409,
      json: { message: "The booking changed. Preview this action again.", code: "stale_preview" },
    }),
  );
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  const section = page.getByRole("region", { name: "Booking actions" });
  await section.getByRole("button", { name: "Cancel booking", exact: true }).click();
  await section
    .getByLabel("Internal reason (not sent to the guest)")
    .fill("Internal staffing issue");
  await section
    .getByLabel("Message to guest (optional)")
    .fill("We're sorry.\n\nPlease contact us.");
  await section.getByRole("button", { name: "Preview impact" }).click();
  await section.getByRole("button", { name: "Apply previewed action" }).click();
  await expect(section.getByRole("alert")).toContainText("The booking changed");
  await section.getByRole("button", { name: "Review changes again" }).click();
  await expect(section.getByLabel("Internal reason (not sent to the guest)")).toHaveValue(
    "Internal staffing issue",
  );
  await section.getByRole("button", { name: "Preview impact" }).click();
  await expect(section.getByRole("button", { name: "Apply previewed action" })).toBeEnabled();
  expect(previews).toBe(2);
});
