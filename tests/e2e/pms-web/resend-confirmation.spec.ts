import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";

test("confirms resend, prevents duplicate sends, and reports provider success or failure", async ({
  page,
}) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  const base = `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`;
  await page.route(base, (route) => route.fulfill({ json: { item: pmsWebReservation } }));
  for (const suffix of ["notes", "additional-guests"])
    await page.route(`${base}/${suffix}`, (route) => route.fulfill({ json: { items: [] } }));
  let sends = 0,
    status = "pending";
  await page.route(`${base}/confirmation-email`, (route) => {
    sends++;
    return route.fulfill({ status: 202, json: { jobId: "job-930" } });
  });
  await page.route(`${base}/confirmation-email/job-930`, (route) =>
    route.fulfill({ json: { status } }),
  );
  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Resend confirmation email" }).click();
  await expect(page.getByText("Resend the booking confirmation email to the guest?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(sends).toBe(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Resend confirmation email" }).click();
  await page.getByRole("button", { name: "Resend", exact: true }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("button", { name: "Sending confirmation…" })).toBeDisabled();
  expect(sends).toBe(1);
  await expect(page.getByText("Confirmation email sent successfully.")).toHaveCount(0);
  status = "succeeded";
  await expect(page.getByText("Confirmation email sent successfully.")).toBeVisible();
  await page.getByRole("button", { name: "Resend confirmation email" }).click();
  status = "dead_lettered";
  await page.getByRole("button", { name: "Resend", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Confirmation email could not be sent" }),
  ).toBeVisible();
  expect(sends).toBe(2);
});
