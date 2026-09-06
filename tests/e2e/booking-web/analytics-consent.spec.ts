import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

test("accepts, reopens and withdraws optional analytics without blocking rooms", async ({
  page,
}) => {
  await mockBookingApis(page);
  const events: { sessionId: string; analyticsConsent: boolean; consentVersion: number }[] = [];
  await page.route("**/api/booking-web/events", (route) => {
    events.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  const identifiers = () =>
    page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("vayada_sid")));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Optional analytics", exact: true }),
  ).toBeVisible();
  expect(events).toEqual([]);
  expect(await identifiers()).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Optional analytics", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await page.getByRole("button", { name: "Reject analytics", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Privacy choices", exact: true })).toBeVisible();
  expect(events).toEqual([]);
  expect(await identifiers()).toEqual([]);
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await page.getByRole("button", { name: "Allow analytics", exact: true }).click();
  await expect(page.getByRole("button", { name: "Privacy choices", exact: true })).toBeFocused();
  await page.reload();
  await expect.poll(() => events.length).toBeGreaterThan(0);
  expect(events[0]).toMatchObject({ analyticsConsent: true, consentVersion: 1 });
  expect(await identifiers()).toEqual([`vayada_sid:${SEEDED_BOOKING_SLUG}`]);
  await page.getByRole("button", { name: "Privacy choices", exact: true }).click();
  await page.getByRole("button", { name: "Reject analytics", exact: true }).click();
  expect(await identifiers()).toEqual([]);
  const count = events.length;
  await page.reload();
  await page.getByRole("button", { name: "View Details", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Alpine Suite" })).toBeVisible();
  expect(events.length).toBe(count);
  expect(await identifiers()).toEqual([]);
});
