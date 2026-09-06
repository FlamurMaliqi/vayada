import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";

test("manual cancellation keeps the private reason separate and accepts an optional guest message", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  let canceled = false;
  await page.route(base, (route) =>
    canceled
      ? route.fulfill({ status: 503, json: { message: "Read unavailable" } })
      : route.fulfill({
          json: {
            item: {
              ...pmsWebReservation,
              source: "manual",
              status: canceled ? "canceled" : "confirmed",
            },
          },
        }),
  );
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  const messages: unknown[] = [];
  await page.route(`${base}/cancel`, async (route) => {
    messages.push(route.request().postDataJSON());
    if (messages.length === 1)
      return route.fulfill({ status: 503, json: { message: "Try again" } });
    canceled = true;
    return route.fulfill({ json: {} });
  });
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await page.getByRole("button", { name: "Cancel Booking", exact: true }).click();
  const submit = page.getByRole("button", { name: "Cancel Booking", exact: true }).last();
  await expect(submit).toBeDisabled();
  await page.getByLabel("Cancellation reason (internal only)").fill("Private staffing issue");
  await expect(submit).toBeEnabled();
  const message = "Sorry about this.\n\nPlease contact us <help@example.test>.";
  await page.getByLabel("Message to guest (optional)").fill(message);
  await submit.click();
  await expect(submit).toBeEnabled();
  expect(messages[0]).toMatchObject({ reason: "Private staffing issue", guestMessage: message });
  await expect(page.getByLabel("Message to guest (optional)")).toHaveValue(message);
  await page.getByLabel("Message to guest (optional)").fill("  ");
  await submit.click();
  await expect(page.getByLabel("Message to guest (optional)")).toHaveCount(0);
  expect(messages[1]).not.toHaveProperty("guestMessage");
  await expect(
    page.getByText("Booking canceled. Reload the page to refresh reservation details."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel Booking", exact: true })).toHaveCount(0);
});
