import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";

import { type BookingResource } from "./booking-lifecycle";
import {
  NEXT_STACK_ORIGINS,
  arrayField,
  record,
  recordField,
  stringField,
  type JsonApi,
  type SmokeEnvironment,
} from "./support";

const METHODS = ["pay_at_property", "bank_transfer", "manual_card", "cash", "other"] as const;
type ManualBody = Record<string, unknown>;

type Args = {
  accessToken: string;
  addonItemIds: string[];
  api: JsonApi;
  bookings: BookingResource[];
  environment: SmokeEnvironment;
  foreignAccessToken: string;
  page: Page;
  propertyId: string;
  request: APIRequestContext;
  slug: string;
  testInfo: TestInfo;
};

export async function runManualBookingAcceptance(args: Args): Promise<void> {
  const { api, bookings, environment, page, propertyId, request, slug, testInfo } = args;
  await test.step("verify paid manual-booking capability", async () => {
    const response = await request.get(
      `${NEXT_STACK_ORIGINS.api}/api/pms/properties/${propertyId}/manual-bookings/capabilities`,
      { headers: { authorization: `Bearer ${args.accessToken}` } },
    );
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      contractVersion: "pms-manual-booking.v1",
      canRecordPaidPayment: true,
    });
  });
  await test.step("create target manual-booking add-on evidence", async () => {
    const addon = await api.json<Record<string, unknown>>(
      "POST",
      `/api/booking/hotels/${propertyId}/addon-items`,
      {
        name: "QA breakfast basket",
        description: "Synthetic add-on for manual-booking acceptance.",
        price: "18.00",
        currency: "EUR",
        category: "dining",
        pricingModel: "per_stay",
        publicVisible: true,
        status: "active",
      },
    );
    args.addonItemIds.push(stringField(addon, "addonItemId"));
  });

  const created = await test.step("create a paid heterogeneous booking in PMS Web", async () => {
    let previewEnabled = false;
    await page.route(`**/api/pms/properties/${propertyId}/manual-bookings/preview`, (route) =>
      previewEnabled ? route.continue() : route.abort(),
    );
    const roomsResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === `/api/pms/properties/${propertyId}/rooms`
      );
    });
    await page.goto(`${NEXT_STACK_ORIGINS.pms}/calendar`);
    const roomsResponse = await roomsResponsePromise;
    const rooms = record(await roomsResponse.json());
    expect(roomsResponse.status(), JSON.stringify(rooms)).toBe(200);
    expect(rooms.propertyId).toBe(propertyId);
    expect(arrayField(rooms, "items")).toHaveLength(2);
    await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
    await expect(page.getByText("#QA-101", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "+ New Booking", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New booking" });
    await expect(dialog).toBeVisible();

    const firstCheckIn = futureDate(5),
      firstCheckOut = futureDate(7),
      secondCheckIn = futureDate(6),
      secondCheckOut = futureDate(9);
    await dialog.getByLabel("Room 1 check-in").fill(firstCheckIn);
    await dialog.getByRole("button", { name: "+ Add another room" }).click();
    await dialog.getByLabel("Room 2 check-in").fill(secondCheckIn);
    await dialog.getByLabel("Room 2 check-out").fill(secondCheckOut);
    await dialog.getByLabel("Room 2 rate plan").selectOption({ label: "Custom rate" });
    await dialog.getByLabel("Room 2 nightly rate").fill("175.00");

    await dialog.getByLabel("First name").fill("Vera");
    await dialog.getByLabel("Last name").fill("Acceptance");
    const email = `qa-next-manual-${environment.runId}@${environment.emailDomain}`;
    await dialog.locator('input[type="email"]').fill(email);
    await dialog.locator('input[name="phoneE164"]').fill("+49305550105");
    await dialog.getByLabel("Guest country").fill("DE");
    await dialog.getByLabel("QA breakfast basket", { exact: true }).check();
    await dialog.getByLabel("QA breakfast basket packages").fill("2");
    await dialog.getByLabel("Manual source").selectOption("email");
    await dialog.getByLabel("Expected method").selectOption("bank_transfer");
    await expect(dialog.getByLabel("Paid", { exact: true })).toBeEnabled();
    await dialog.getByLabel("Paid", { exact: true }).check();
    await dialog.getByLabel("Special requests (visible to guest)").fill("Quiet room near the lift");
    await dialog
      .getByLabel("Private note (staff only)")
      .fill("Internal QA note — never show guest");
    const previewResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pms/properties/${propertyId}/manual-bookings/preview`
      );
    });
    previewEnabled = true;
    await dialog.getByLabel("Room 1 check-out").fill(firstCheckOut);
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status(), await previewResponse.text()).toBe(200);
    await expect(dialog.getByText("Server total pending")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Create booking" })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("manual-booking-preview.png"),
      fullPage: true,
    });

    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === `/api/pms/properties/${propertyId}/manual-bookings`
      );
    });
    await dialog.getByRole("button", { name: "Create booking" }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const result = record(await response.json()),
      body = record(response.request().postDataJSON());
    bookings.push(manualResource(result, email, slug));
    assertCreatedResult(result, "paid");
    await expect(page.getByText("Booking created.")).toBeVisible();
    await expect(page.getByText("Vera Acceptance", { exact: true })).toHaveCount(2);
    await page.screenshot({
      path: testInfo.outputPath("manual-booking-calendar.png"),
      fullPage: true,
    });
    return { body, email, result };
  });

  await test.step("verify replay, rejection, detail and check-in contracts", async () => {
    const { accessToken } = args,
      bookingId = stringField(created.result, "guestBookingId");
    const replay = await post(request, accessToken, propertyId, created.body);
    expect(replay.status()).toBe(200);
    const replayed = record(await replay.json());
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.guestBookingId).toBe(bookingId);
    expect(replayed.paymentEvidenceId).toBe(created.result.paymentEvidenceId);
    const payments = await api.json<Record<string, unknown>>(
      "GET",
      `/api/finance/properties/${propertyId}/reconciliation/payments?limit=100`,
    );
    expect(
      arrayField(payments, "items")
        .map(record)
        .filter((item) => item.subjectId === replayed.paymentEvidenceId),
    ).toHaveLength(1);

    const list = await api.json<Record<string, unknown>>(
      "GET",
      `/api/pms/properties/${propertyId}/reservations?search=${encodeURIComponent(stringField(created.result, "bookingReference"))}`,
    );
    expect(arrayField(list, "items")).toHaveLength(1);

    await expectFailure(
      post(request, accessToken, propertyId, { ...created.body, privateNote: "changed" }),
      409,
      "idempotency_conflict",
    );
    for (const directSource of ["booking_engine", "vayada"]) {
      await expectFailure(
        post(request, accessToken, propertyId, fresh(created.body, { directSource })),
        422,
        "invalid_source",
      );
    }
    await expectFailure(
      post(request, accessToken, propertyId, fresh(created.body)),
      409,
      "room_unavailable",
    );
    const firstStay = {
      ...record(arrayField(created.body, "stays")[0]),
      checkIn: futureDate(12),
      checkOut: futureDate(14),
    };
    await expectFailure(
      post(
        request,
        accessToken,
        propertyId,
        fresh(created.body, { stays: [firstStay, { ...firstStay, position: 2 }] }),
      ),
      409,
      "room_unavailable",
    );
    await expectFailure(
      post(request, args.foreignAccessToken, propertyId, fresh(created.body)),
      403,
      "forbidden",
    );
    await expectFailure(post(request, "", propertyId, fresh(created.body)), 401, "unauthenticated");

    await page.getByText("Vera Acceptance", { exact: true }).first().click();
    await expect(page.getByText("Expected payment method", { exact: true })).toBeVisible();
    await expect(page.getByText("Bank transfer", { exact: true })).toBeVisible();
    await expect(page.getByText("Payment recorded", { exact: true })).toBeVisible();
    await expect.soft(page.getByText("Quiet room near the lift", { exact: true })).toBeVisible();
    await expect.soft(page.getByText("QA breakfast basket", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Internal QA note — never show guest", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("manual-booking-detail.png"),
      fullPage: true,
    });

    const detail = recordField(
        await api.json("GET", `/api/pms/properties/${propertyId}/reservations/${bookingId}`),
        "item",
      ),
      primaryGuest = recordField(detail, "primaryGuest"),
      assignments = arrayField(detail, "assignments").map(record);
    expect(detail.source).toBe("manual");
    expect(primaryGuest.email).toBe(created.email);
    expect(primaryGuest.phone).toBe("+49305550105");
    expect(primaryGuest.countryCode).toBe("DE");
    expect(detail.privateNoteCount).toBe(1);
    expect(assignments).toHaveLength(2);
    expect(assignments.map((assignment) => assignment.channel)).toEqual(["email", "email"]);

    const lookup = await request.post(
      `${NEXT_STACK_ORIGINS.api}/api/booking-web/hotels/${slug}/bookings/lookup`,
      {
        data: {
          bookingReference: stringField(created.result, "bookingReference"),
          guestEmail: created.email,
        },
      },
    );
    expect(lookup.ok()).toBe(true);
    expect(JSON.stringify(await lookup.json())).not.toContain(
      "Internal QA note — never show guest",
    );

    await page.goto(`${NEXT_STACK_ORIGINS.pms}/check-in/${bookingId}`);
    await expect(page.getByText("Bank transfer", { exact: true })).toBeVisible();
    await expect(page.getByText("Payment recorded", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("manual-booking-check-in.png"),
      fullPage: true,
    });
  });

  await test.step("verify every expected payment method for paid and unpaid bookings", async () => {
    const firstStay = record(arrayField(created.body, "stays")[0]);
    for (const [methodIndex, expectedMethod] of METHODS.entries()) {
      for (const [settledIndex, status] of (["unpaid", "paid"] as const).entries()) {
        const offset = 20 + methodIndex * 2 + settledIndex,
          email = `qa-next-${expectedMethod}-${status}-${environment.runId}@${environment.emailDomain}`;
        const body = fresh(created.body, {
          addOns: [],
          directSource: "email",
          guest: {
            firstName: "Method",
            lastName: `${methodIndex}-${status}`,
            email,
            phoneE164: null,
            countryCode: "DE",
            specialRequests: null,
          },
          payment: {
            expectedMethod,
            settlement: status === "paid" ? { status, reference: null } : { status },
          },
          privateNote: null,
          stays: [
            {
              ...firstStay,
              position: 1,
              checkIn: futureDate(offset),
              checkOut: futureDate(offset + 1),
            },
          ],
        });
        const response = await post(request, args.accessToken, propertyId, body);
        expect(response.status()).toBe(201);
        const result = record(await response.json());
        bookings.push(manualResource(result, email, slug));
        assertCreatedResult(result, status);

        const bookingId = stringField(result, "guestBookingId");
        const detail = recordField(
            await api.json("GET", `/api/pms/properties/${propertyId}/reservations/${bookingId}`),
            "item",
          ),
          payment = recordField(detail, "payment");
        expect(payment.expectedMethod).toBe(expectedMethod);
        expect(payment.status).toBe(status);
        await page.goto(`${NEXT_STACK_ORIGINS.pms}/bookings/${bookingId}`);
        const paymentGrid = page
          .getByText("Expected method", { exact: true })
          .locator("..")
          .locator("..");
        await expect(
          paymentGrid
            .getByText("Expected method", { exact: true })
            .locator("..")
            .getByText(methodLabel(expectedMethod), { exact: true }),
        ).toBeVisible();
        await expect(
          paymentGrid
            .getByText("Status", { exact: true })
            .locator("..")
            .getByText(status === "paid" ? "Paid" : "Unpaid", { exact: true }),
        ).toBeVisible();
      }
    }
    const payments = await api.json<Record<string, unknown>>(
      "GET",
      `/api/finance/properties/${propertyId}/reconciliation/payments?limit=100`,
    );
    expect(payments.total).toBe(6);
  });
}

function assertCreatedResult(result: Record<string, unknown>, status: "paid" | "unpaid"): void {
  expect(result.outcome).toBe("created");
  expect(result.paymentStatus).toBe(status);
  expect(arrayField(result, "sideEffects").slice().sort()).toEqual(
    ["ari_changed", "audit_event", "calendar_refresh", "guest_confirmation"].sort(),
  );
  const total = Number(stringField(recordField(result, "total"), "amountDecimal")),
    balance = Number(stringField(recordField(result, "balance"), "amountDecimal"));
  expect(total).toBeGreaterThan(0);
  if (status === "paid") {
    expect(balance).toBe(0);
    expect(stringField(result, "paymentEvidenceId")).toMatch(/^[0-9a-f-]{36}$/);
  } else {
    expect(balance).toBe(total);
    expect(result.paymentEvidenceId).toBeNull();
  }
}

async function post(
  request: APIRequestContext,
  accessToken: string,
  propertyId: string,
  body: ManualBody,
) {
  return request.post(
    `${NEXT_STACK_ORIGINS.api}/api/pms/properties/${propertyId}/manual-bookings`,
    { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {}, data: body },
  );
}

async function expectFailure(
  responsePromise: ReturnType<typeof post>,
  status: number,
  code: string,
) {
  const response = await responsePromise;
  expect(response.status()).toBe(status);
  expect(record(await response.json()).code).toBe(code);
}

function fresh(body: ManualBody, patch: ManualBody = {}): ManualBody {
  const id = randomUUID();
  return { ...body, ...patch, commandId: id, idempotencyKey: id };
}

function manualResource(
  result: Record<string, unknown>,
  email: string,
  slug: string,
): BookingResource {
  return {
    bookingId: stringField(result, "guestBookingId"),
    email,
    mode: "instant",
    resolved: false,
    slug,
  };
}

function futureDate(offset: number): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function methodLabel(value: (typeof METHODS)[number]): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
