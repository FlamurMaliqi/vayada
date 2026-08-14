import { expect, test, type Page } from "@playwright/test";
import publicBookabilityCases from "../../../engineering/fixtures/public-bookability/cases.json";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-web tenant smoke", () => {
  test("renders the seeded tenant from the request host", async ({ page, baseURL }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    await page.goto("/");

    expect(new URL(baseURL ?? page.url()).hostname.split(".")[0]).toBe(SEEDED_BOOKING_SLUG);
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Check Availability/i })).toBeVisible();
    await page.getByText("2 Adults", { exact: true }).click();
    const guestSelector = page.getByTestId("guest-selector");
    await expect(guestSelector.getByText("Ages 18+", { exact: true })).toBeVisible();
    await expect(guestSelector.getByText("Ages 0-17", { exact: true })).toBeVisible();
    await guestSelector.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: /Available Accommodations/i })).toBeVisible();
    await expect(page.getByText("Alpine Suite")).toBeVisible();
    await expect(page.getByRole("button", { name: /Select This Rate/i }).first()).toBeVisible();
    const nav = page.locator("nav");
    await nav.getByRole("button", { name: "Contact", exact: true }).click();
    await expect(nav.getByText("Phone", { exact: true })).toBeVisible();
    await expect(nav.getByText("Email", { exact: true })).toBeVisible();
    await expect(nav.getByText("WhatsApp", { exact: true })).toHaveCount(0);
    await nav.getByRole("button", { name: "Contact", exact: true }).click();
    await nav.getByRole("button", { name: "EN", exact: true }).click();
    await expect(nav.getByRole("button", { name: "Nederlands", exact: true })).toBeVisible();

    const graph = await publicStructuredDataGraph(page);
    const hotelNode = graph.find((node) => node["@type"] === "Hotel");
    expect(hotelNode).toMatchObject({
      "@type": "Hotel",
      name: "Hotel Alpenrose",
      url: "http://hotel-alpenrose.booking.localhost:3002/en",
      checkinTime: "15:00",
      checkoutTime: "11:00",
    });
    expect(hotelNode?.image).toContain(
      "http://hotel-alpenrose.booking.localhost:3002/vayada-logo.png",
    );

    const availableRoom = graph.find(
      (node) => node["@type"] === "HotelRoom" && node.name === "Alpine Suite",
    );
    expect(availableRoom).toMatchObject({
      "@type": "HotelRoom",
      name: "Alpine Suite",
      containedInPlace: { "@id": "http://hotel-alpenrose.booking.localhost:3002/en#hotel" },
    });
    expect(availableRoom?.offers).toBeUndefined();

    const unavailableRoom = graph.find(
      (node) => node["@type"] === "HotelRoom" && node.name === "Garden Room",
    );
    expect(unavailableRoom).toBeTruthy();
    expect(unavailableRoom?.offers).toBeUndefined();

    const quoteUnavailableCases = publicBookabilityCases.cases
      .filter((fixture) => fixture.expected.offerCount === 0)
      .map((fixture) => fixture.caseId);
    expect(quoteUnavailableCases).toEqual(
      expect.arrayContaining(["sold-out", "payment-disabled", "min-stay-not-met"]),
    );
    expect(
      graph.filter((node) => node["@type"] === "HotelRoom").every((node) => !node.offers),
    ).toBe(true);

    await assertHealthy();
  });

  test("shows WhatsApp only when the hotel publishes a WhatsApp number", async ({ page }) => {
    await mockBookingApis(page, {
      publicContacts: [
        { type: "phone", value: "+41 44 000 00 00" },
        { type: "whatsapp", value: "+41 79 123 45 67" },
        { type: "email", value: "stay@alpenrose.test" },
      ],
    });

    await page.goto("/");
    const nav = page.locator("nav");
    await nav.getByRole("button", { name: "Contact", exact: true }).click();

    await expect(nav.getByText("WhatsApp", { exact: true })).toBeVisible();
    await expect(nav.getByText("+41 79 123 45 67", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute(
      "href",
      "https://wa.me/41791234567",
    );
  });

  test("uses a constrained header logo without displacing mobile actions", async ({ page }) => {
    await mockBookingApis(page, { headerLogoUrl: "/vayada-logo.png" });

    await page.goto("/");
    const nav = page.locator("nav");
    const logo = nav.getByAltText("Hotel Alpenrose logo");
    await expect(logo).toBeVisible();
    await expect(nav.getByText("Hotel Alpenrose", { exact: true })).toHaveCount(0);
    expect((await logo.boundingBox())?.height).toBeLessThanOrEqual(40);

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(logo).toBeVisible();
    expect((await logo.boundingBox())?.height).toBeLessThanOrEqual(32);
    await expect(nav.getByRole("button", { name: "Refer", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "EN", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "EUR", exact: true })).toBeVisible();
    expect((await nav.boundingBox())?.height).toBe(64);
  });

  test("hides children in the guest selector when the target profile disables them", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page, {
      supportedQuoteParameters: {
        childrenSupported: false,
        adultAgeThreshold: 21,
      },
    });

    await page.goto("/");

    await page.getByText("2 Adults", { exact: true }).click();
    const guestSelector = page.getByTestId("guest-selector");
    await expect(guestSelector.getByText("Ages 21+", { exact: true })).toBeVisible();
    await expect(guestSelector.getByText("Children", { exact: true })).toHaveCount(0);
    await expect(guestSelector.getByText("Ages 0-20", { exact: true })).toHaveCount(0);

    await assertHealthy();
  });

  test("shows pending feedback when selecting a rate", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    await page.goto("/");

    let releaseNavigation!: () => void;
    await page.route("**/addons?**", async (route) => {
      await new Promise<void>((resolve) => {
        releaseNavigation = resolve;
      });
      await route.continue();
    });

    const selectButton = page.getByTestId("select-rate-alpine-suite");
    await expect(selectButton).toBeVisible();
    await selectButton.click({ noWaitAfter: true });

    const pendingButton = page.getByTestId("select-rate-alpine-suite");
    await expect(pendingButton).toBeVisible();
    await expect(pendingButton).toBeDisabled();
    await expect(pendingButton).toHaveAttribute("aria-busy", "true");
    await expect(pendingButton).toContainText("Preparing checkout");
    releaseNavigation();

    await assertHealthy();
  });

  test("keeps public structured data off checkout routes", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    await page.goto(
      "/book?room=alpine-suite&checkIn=2026-09-12&checkOut=2026-09-15&adults=2&children=0&rooms=1&rateType=flexible",
    );

    await expect(page).toHaveTitle(/Guest Details \| Book Your Stay/);
    await expect(
      page.locator('script[type="application/ld+json"]#booking-web-public-structured-data'),
    ).toHaveCount(0);
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);

    await assertHealthy();
  });

  test("requests card-sized room and add-on images", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    await page.goto("/");
    await expect(page.getByText("Alpine Suite")).toBeVisible();

    const roomImageWidths = await optimizedImageWidths(page, 'img[alt="Alpine Suite"]');
    if (roomImageWidths.length > 0) {
      expect(Math.max(...roomImageWidths)).toBeLessThanOrEqual(640);
    }

    await page.goto(
      "/addons?room=alpine-suite&checkIn=2026-09-12&checkOut=2026-09-15&adults=2&children=0&rooms=1&rateType=flexible",
    );
    await expect(page.getByText("Airport Transfer")).toBeVisible();

    const addonImageWidths = await optimizedImageWidths(page, 'img[alt="Airport Transfer"]');
    if (addonImageWidths.length > 0) {
      expect(Math.max(...addonImageWidths)).toBeLessThanOrEqual(640);
    }

    await assertHealthy();
  });

  test("previews a date-only booking change without asking for add-ons", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);

    const booking = {
      id: "booking-change-1",
      bookingReference: "B-CHANGE-1",
      hotelName: "Hotel Alpenrose",
      roomName: "Alpine Suite",
      guestFirstName: "Ada",
      guestLastName: "Lovelace",
      guestEmail: "guest@example.test",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      nights: 3,
      adults: 2,
      children: 0,
      numberOfRooms: 1,
      nightlyRate: 240,
      totalAmount: 720,
      balanceAmount: 720,
      currency: "EUR",
      status: "confirmed",
      paymentMethod: "pay_at_property",
      paymentStatus: "unpaid",
      createdAt: "2026-07-22T10:00:00.000Z",
    };
    let previewPayload: Record<string, unknown> | null = null;

    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
      async (route) => {
        await route.fulfill({ json: booking });
      },
    );
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/${booking.id}/change-request**`,
      async (route) => {
        const url = new URL(route.request().url());
        if (route.request().method() === "GET") {
          await route.fulfill({ json: null });
          return;
        }
        if (url.pathname.endsWith("/preview")) {
          previewPayload = route.request().postDataJSON() as Record<string, unknown>;
          const hasNewDates =
            previewPayload.checkIn === "2026-09-16" && previewPayload.checkOut === "2026-09-18";
          await route.fulfill({
            json: {
              oldTotal: 720,
              newTotal: hasNewDates ? 510 : 720,
              priceDifference: hasNewDates ? -210 : 0,
              currency: "EUR",
              blocked: !hasNewDates,
              blockReason: hasNewDates
                ? null
                : "Choose different dates before submitting a change request.",
              available: hasNewDates,
            },
          });
          return;
        }
        await route.fulfill({ status: 405, json: { detail: "Unexpected test request" } });
      },
    );

    await page.goto("/booking/B-CHANGE-1/request-change?email=guest%40example.test");

    await expect(page.getByRole("heading", { name: "Request Booking Changes" })).toBeVisible();
    await expect(page.getByText("Add-ons", { exact: true })).toHaveCount(0);
    const dateInputs = page.locator('input[type="date"]');
    await expect(dateInputs).toHaveCount(2);
    await expect(dateInputs.nth(0)).toHaveValue("2026-09-12");
    await expect(dateInputs.nth(1)).toHaveValue("2026-09-15");

    await dateInputs.nth(0).fill("2026-09-16");
    await dateInputs.nth(1).fill("2026-09-18");

    await expect.poll(() => previewPayload?.checkIn).toBe("2026-09-16");
    expect(previewPayload).toMatchObject({
      checkIn: "2026-09-16",
      checkOut: "2026-09-18",
      addonIds: [],
      addonQuantities: {},
      addonDates: {},
    });
    await expect(page.getByText("€510", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit Change Request" })).toBeEnabled();

    await assertHealthy();
  });
});

type JsonLdNode = {
  "@type"?: string;
  name?: string;
  url?: string;
  image?: string[];
  checkinTime?: string;
  checkoutTime?: string;
  containedInPlace?: { "@id": string };
  offers?: {
    "@type": string;
    price: number;
    priceCurrency: string;
    availability: string;
  };
};

async function publicStructuredDataGraph(page: Page) {
  const rawStructuredData = await page
    .locator('script[type="application/ld+json"]#booking-web-public-structured-data')
    .textContent();
  expect(rawStructuredData).toBeTruthy();
  const structuredData = JSON.parse(rawStructuredData ?? "{}") as { "@graph"?: JsonLdNode[] };
  expect(structuredData["@graph"]).toBeTruthy();
  return structuredData["@graph"] ?? [];
}

async function optimizedImageWidths(page: Page, selector: string): Promise<number[]> {
  await page.waitForFunction((imageSelector) => {
    return Array.from(document.querySelectorAll(imageSelector)).every((image) => {
      const img = image as HTMLImageElement;
      return img.complete && Boolean(img.currentSrc);
    });
  }, selector);

  const srcs = await page
    .locator(selector)
    .evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).currentSrc).filter(Boolean),
    );
  const widths = srcs
    .map((src) => new URL(src, page.url()).searchParams.get("w"))
    .filter((width): width is string => Boolean(width))
    .map(Number);

  if (widths.length === 0) {
    // Development deliberately serves the trusted local media CDN directly.
    // Production and other non-local deployments must keep using optimized widths.
    expect(srcs.every((src) => new URL(src, page.url()).hostname.endsWith(".localhost"))).toBe(
      true,
    );
  }
  return widths;
}
