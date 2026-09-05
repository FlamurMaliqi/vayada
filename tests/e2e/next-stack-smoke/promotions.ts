import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  runQuoteLifecycle,
  waitForOffer,
  type BookingResource,
  type Stay,
} from "./booking-lifecycle";
import {
  NEXT_STACK_ORIGINS,
  numberField,
  publicApi,
  type JsonApi,
  type SmokeEnvironment,
} from "./support";

export async function runPromotionAcceptance(input: {
  api: JsonApi;
  bookings: BookingResource[];
  environment: SmokeEnvironment;
  page: Page;
  propertyId: string;
  request: APIRequestContext;
  roomTypeId: string;
  slug: string;
  stay: Stay;
}): Promise<void> {
  const { api, bookings, environment, page, propertyId, request, roomTypeId, slug, stay } = input;
  const settingsPath = `/api/booking/hotels/${propertyId}/settings/last-minute`;
  const codesPath = `/api/booking/hotels/${propertyId}/promo-codes`;
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Early bird", exact: true }) });
  const guest = await page.context().newPage();
  const query = new URLSearchParams({
    room: roomTypeId,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: "2",
    children: "0",
    rooms: "1",
    rateType: "flexible",
  });
  const guestUrl = `https://${slug}.next-booking.vayada.com/en/book`;

  await test.step("create, edit and pause an automatic promotion in deployed Promos", async () => {
    await page.goto(`${NEXT_STACK_ORIGINS.bookingAdmin}/promo-codes`);
    await expect(page.getByRole("heading", { name: "Promos", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "+ New promotion", exact: true }).click();
    await page.getByLabel("Promotion type").selectOption("EARLY_BIRD");
    await page.getByLabel("Minimum days ahead").fill("1");
    await page.getByRole("button", { name: "Save promotion", exact: true }).click();
    await expect(card).toContainText("10% off");
    await card.getByRole("button", { name: "Edit Early bird", exact: true }).click();
    await page.getByLabel("Discount percentage").fill("20");
    await page.getByRole("button", { name: "Save promotion", exact: true }).click();
    await expect(card).toContainText("20% off");
    await card.getByRole("switch").click();
    await expect(card).toContainText("Paused");
    await page.reload();
    await expect(card).toContainText("Paused");
    const saved = await api.json<Record<string, unknown>>("GET", settingsPath);
    expect(saved.promotions).toEqual([
      expect.objectContaining({
        type: "EARLY_BIRD",
        active: false,
        discountPercent: 20,
        threshold: 1,
      }),
    ]);
  });

  await waitForOffer(request, slug, stay, 2);
  await guest.goto(`${guestUrl}?${query}`);
  await expect(guest.getByRole("heading", { name: "Booking Summary", exact: true })).toBeVisible();
  await expect(guest.getByText("Early bird", { exact: true })).toHaveCount(0);
  const baseline = await publicApi(request).json<Record<string, unknown>>(
    "POST",
    `/api/booking-web/hotels/${slug}/bookings/quote`,
    {
      roomTypeId,
      ...stay,
      adults: 2,
      children: 0,
      numberOfRooms: 1,
      paymentMethod: "pay_at_property",
      rateType: "flexible",
    },
    { "Idempotency-Key": `next-smoke:${environment.runId}:promotion-baseline` },
  );
  expect(baseline.promotion).toBeUndefined();
  await card.getByRole("switch").click();
  await expect(card).toContainText("Active");

  await test.step("show the named promotion and persist the better deal without stacking", async () => {
    await guest.goto(`${guestUrl}?${query}`);
    await expect(guest.getByText("Early bird", { exact: true }).first()).toBeVisible();
    for (const [mode, percent] of [
      ["instant", 10],
      ["request", 30],
    ] as const) {
      const code = `QA${percent}`;
      await api.json("POST", codesPath, {
        code,
        discountType: "percentage",
        discountValue: String(percent),
        maxUses: 10,
        isActive: true,
      });
      await api.json("PUT", `/api/pms/properties/${propertyId}/booking-acceptance`, {
        acceptanceMode: mode,
      });
      const validation = guest.waitForResponse(
        (response) =>
          response.url().includes("/promo/validate") && response.request().method() === "POST",
      );
      await guest.goto(`${guestUrl}?${query}&promoCode=${code}`);
      expect((await validation).ok()).toBe(true);
      if (percent < 20) {
        await expect(guest.getByText("Early bird", { exact: true }).first()).toBeVisible();
        await expect(guest.getByText(`Promo ${code}: -${percent}%`, { exact: true })).toHaveCount(
          0,
        );
      } else {
        await expect(
          guest.getByText(`Promo ${code}: -${percent}%`, { exact: true }).first(),
        ).toBeVisible();
        await expect(guest.getByText("Early bird", { exact: true })).toHaveCount(0);
      }
      const offer = await waitForOffer(request, slug, stay, 2);
      await runQuoteLifecycle(request, environment, slug, stay, offer, mode, bookings, {
        key: `promotion-${mode}`,
        promoCode: code,
        assertQuote(quote) {
          const discount =
            Math.round(numberField(baseline, "roomTotal") * Math.max(20, percent)) / 100;
          expect(numberField(quote, "totalAmount")).toBeCloseTo(
            numberField(baseline, "totalAmount") - discount,
            2,
          );
          if (percent < 20) {
            expect(quote.promotion).toMatchObject({ name: "Early bird", discountAmount: discount });
            expect(quote.promotionDiscount).toBe(discount);
            expect(quote.promoCode).toBeNull();
            expect(quote.promoDiscount).toBe(0);
          } else {
            expect(quote.promotion).toBeUndefined();
            expect(quote.promoCode).toBe(code);
            expect(quote.promoDiscount).toBe(discount);
          }
        },
      });
      await waitForOffer(request, slug, stay, 2);
    }
  });

  await api.json("PUT", `/api/pms/properties/${propertyId}/booking-acceptance`, {
    acceptanceMode: "instant",
  });

  await test.step("delete the promotion and confirm it disappears for guests", async () => {
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "+ New promotion", exact: true })).toBeEnabled();
    await expect(card).toHaveCount(0);
    const saved = await api.json<Record<string, unknown>>("GET", settingsPath);
    expect(saved.promotions).toEqual([]);
    await guest.goto(`${guestUrl}?${query}`);
    await expect(
      guest.getByRole("heading", { name: "Booking Summary", exact: true }),
    ).toBeVisible();
    await expect(guest.getByText("Early bird", { exact: true })).toHaveCount(0);
  });
  await guest.close();
}
