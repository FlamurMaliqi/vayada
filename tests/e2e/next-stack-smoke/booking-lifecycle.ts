import { expect, type APIRequestContext } from "@playwright/test";

import {
  NEXT_STACK_ORIGINS,
  arrayField,
  futureStay,
  numberField,
  publicApi,
  record,
  recordField,
  stringField,
  type SmokeEnvironment,
} from "./support";

export type Stay = ReturnType<typeof futureStay>;
export type BookingResource = {
  bookingId: string;
  email: string;
  mode: "instant" | "request";
  resolved: boolean;
  slug: string;
};
export type Offer = Record<string, unknown> & {
  availableRooms: number;
  roomTypeId: string;
};

export async function runQuoteLifecycle(
  request: APIRequestContext,
  environment: SmokeEnvironment,
  slug: string,
  stay: Stay,
  offer: Offer,
  mode: "instant" | "request",
  bookings: BookingResource[],
  checkout?: {
    key: string;
    promoCode: string;
    assertQuote: (quote: Record<string, unknown>) => void;
  },
): Promise<void> {
  const api = publicApi(request);
  const guestEmail = `qa-next-guest-${environment.runId}@${environment.emailDomain}`;
  const booking = {
    roomTypeId: offer.roomTypeId,
    guestFirstName: "Taylor",
    guestLastName: "Smoke",
    guestEmail,
    guestPhone: "+49 30 5550104",
    guestCountry: "DE",
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: 2,
    children: 0,
    numberOfRooms: 1,
    paymentMethod: "pay_at_property",
    rateType: "flexible",
    ...(checkout ? { promoCode: checkout.promoCode } : {}),
  };
  const quote = await api.json<Record<string, unknown>>(
    "POST",
    `/api/booking-web/hotels/${slug}/bookings/quote`,
    booking,
    { "Idempotency-Key": `next-smoke:${environment.runId}:${checkout?.key ?? mode}:quote` },
  );
  expect(quote.acceptanceMode).toBe(mode);
  checkout?.assertQuote(quote);
  const created = await api.json<Record<string, unknown>>(
    "POST",
    `/api/booking-web/hotels/${slug}/bookings`,
    {
      ...booking,
      quoteId: stringField(quote, "quoteId"),
      expectedTotalAmount: numberField(quote, "totalAmount"),
      balanceAmount: numberField(quote, "balanceAmount"),
    },
    { "Idempotency-Key": `next-smoke:${environment.runId}:${checkout?.key ?? mode}:booking` },
  );
  const persisted = recordField(created, "booking");
  const resource: BookingResource = {
    bookingId: stringField(persisted, "id"),
    email: guestEmail,
    mode,
    resolved: false,
    slug,
  };
  bookings.push(resource);
  expect(persisted.totalAmount).toBe(numberField(quote, "totalAmount"));
  expect(persisted.balanceAmount).toBe(numberField(quote, "balanceAmount"));
  await waitForAvailability(request, slug, stay, offer.availableRooms - 1);
  if (mode === "request") {
    await api.json(
      "POST",
      `/api/booking-web/hotels/${slug}/bookings/${resource.bookingId}/withdraw`,
      { guestEmail },
    );
  } else {
    await api.json(
      "POST",
      `/api/booking-web/hotels/${slug}/bookings/${resource.bookingId}/cancel-preview`,
      { guestEmail },
    );
    await api.json(
      "POST",
      `/api/booking-web/hotels/${slug}/bookings/${resource.bookingId}/cancel`,
      { guestEmail },
    );
  }
  resource.resolved = true;
}

export async function waitForOffer(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
  availableRooms: number,
): Promise<Offer> {
  let latest: Offer | null = null;
  await expect
    .poll(
      async () => {
        latest = await firstOffer(request, slug, stay);
        return latest?.availableRooms ?? 0;
      },
      { timeout: 45_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(availableRooms);
  return latest!;
}

export async function waitForNoPublicOffer(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
): Promise<void> {
  await expect
    .poll(async () => (await firstOffer(request, slug, stay)) === null, {
      timeout: 45_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(true);
}

async function waitForAvailability(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
  availableRooms: number,
): Promise<void> {
  await expect
    .poll(async () => (await firstOffer(request, slug, stay))?.availableRooms ?? 0, {
      timeout: 45_000,
      intervals: [500, 1_000, 2_000],
    })
    .toBe(availableRooms);
}

async function firstOffer(
  request: APIRequestContext,
  slug: string,
  stay: Stay,
): Promise<Offer | null> {
  const query = new URLSearchParams({
    check_in: stay.checkIn,
    check_out: stay.checkOut,
    rooms: "1",
    adults: "2",
    children: "0",
    currency: "EUR",
    locale: "en",
  });
  const response = await request.get(
    `${NEXT_STACK_ORIGINS.api}/api/booking-web/hotels/${encodeURIComponent(slug)}/offers?${query}`,
  );
  if (response.status() === 404 || response.status() === 409) return null;
  if (!response.ok()) throw new Error(`Public offers returned ${response.status()}.`);
  const body = record(await response.json());
  if (body.quote == null) return null;
  const offers = arrayField(record(body.quote), "offers");
  if (!offers.length) return null;
  const offer = record(offers[0]);
  const availableRooms = Number(offer.availableRooms);
  if (!Number.isInteger(availableRooms) || availableRooms < 0) {
    throw new Error("Public offer has invalid availableRooms.");
  }
  return {
    ...offer,
    availableRooms,
    roomTypeId: stringField(offer, "roomTypeId"),
  };
}
