import { createHash } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  createPmsMandatoryChargePricingSourceSnapshot,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
} from "@vayada/domain-pms";

import {
  NEXT_STACK_ORIGINS,
  arrayField,
  numberField,
  record,
  recordField,
  stringField,
  type JsonApi,
} from "./support";

type Args = {
  accessToken: string;
  api: JsonApi;
  propertyId: string;
  request: APIRequestContext;
  roomTypeId: string;
};

export async function configureGuestPolicyForManualBooking(args: Args): Promise<void> {
  const { accessToken, api, propertyId, request, roomTypeId } = args;
  await test.step("create guest-policy revision 1 and prove manual preview fails closed first", async () => {
    const setup = await api.json<Record<string, unknown>>(
      "GET",
      `/api/booking/properties/${propertyId}/booking-guest-policy`,
    );
    expect(setup.current).toBeNull();
    expect(setup.composition).toBeNull();
    expect(recordField(setup, "draft")).toMatchObject({
      phoneRequired: true,
      arrivalTimeEnabled: false,
      specialRequestsEnabled: true,
    });

    // Setup identities include the unlabeled units hidden by the operational room list.
    const units = await api.json<Record<string, unknown>>(
        "GET",
        `/api/pms/setup/properties/${propertyId}/room-types/${roomTypeId}/units`,
      ),
      setupUnits = arrayField(units, "items").map(record);
    expect(setupUnits).toHaveLength(2);
    for (const unit of setupUnits) {
      expect(unit).toMatchObject({
        propertyId,
        roomTypeId,
        lifecycle: "active",
        operationalLabelStatus: "unverified",
      });
    }
    const roomUnitsRevision = await verifyOperationalLabels(
      api,
      propertyId,
      roomTypeId,
      setupUnits,
    );
    const rooms = await api.json<Record<string, unknown>>(
        "GET",
        `/api/pms/properties/${propertyId}/rooms`,
      ),
      physicalRooms = arrayField(rooms, "items")
        .map(record)
        .filter((room) => stringField(room, "roomTypeId") === roomTypeId);
    expect(physicalRooms).toHaveLength(2);
    const roomId = stringField(physicalRooms[0]!, "roomId"),
      previewCommand = manualPreviewCommand(roomId);
    expect(await previewStatus(request, accessToken, propertyId, previewCommand)).toEqual([
      404,
      "rate_not_found",
    ]);
    await configurePricing(api, propertyId, roomTypeId);
    await configureInventory(api, propertyId, roomTypeId, roomUnitsRevision);

    const choices = {
        defaultGuestLanguage: "en",
        childrenEnabled: false,
        adultAgeThreshold: null,
        phoneRequired: true,
        arrivalTimeEnabled: false,
        specialRequestsEnabled: true,
        checkInTime: "15:00",
        checkOutTime: "12:00",
      },
      preview = await api.json<Record<string, unknown>>(
        "POST",
        `/api/booking/properties/${propertyId}/booking-guest-policy/preview`,
        { choices },
      );
    expect(preview.outcome, JSON.stringify(preview)).toBe("ready");
    const sourceFingerprint = stringField(recordField(preview, "bundle"), "sourceFingerprint"),
      command = {
        expectedRevision: 0,
        expectedSourceFingerprint: sourceFingerprint,
        choices,
        confirmPolicyBundle: true,
      },
      key = `next-smoke:guest-policy:${propertyId}`,
      created = await putPolicy(request, accessToken, propertyId, key, command);
    expect([created.status, created.body.outcome]).toEqual([201, "created"]);
    expect(recordField(created.body, "revision").revision).toBe(1);

    const replayed = await putPolicy(request, accessToken, propertyId, key, command);
    expect([replayed.status, replayed.body.outcome]).toEqual([200, "idempotent_replay"]);
    expect(replayed.body.revision).toEqual(created.body.revision);
    expect(await previewStatus(request, accessToken, propertyId, previewCommand)).toEqual([
      200,
      null,
    ]);
  });
}

async function verifyOperationalLabels(
  api: JsonApi,
  propertyId: string,
  roomTypeId: string,
  rooms: Record<string, unknown>[],
): Promise<number> {
  let expectedRevision = 1;
  for (const [index, room] of rooms.entries()) {
    const roomId = stringField(room, "roomUnitId"),
      label = `QA-${index + 101}`,
      response = await api.json<Record<string, unknown>>(
        "PUT",
        `/api/pms/properties/${propertyId}/room-types/${roomTypeId}/physical-units/${roomId}/operational-label`,
        { expectedRevision, operationalLabel: label },
        { "Idempotency-Key": `next-smoke:room-label:${propertyId}:${roomId}` },
      );
    expect(response).toMatchObject({
      outcome: "updated",
      roomUnitId: roomId,
      operationalLabel: label,
      operationalLabelStatus: "verified",
    });
    expectedRevision = numberField(response, "roomUnitsRevision");
  }
  return expectedRevision;
}

async function configureInventory(
  api: JsonApi,
  propertyId: string,
  roomTypeId: string,
  roomUnitsRevision: number,
): Promise<void> {
  const profile = await api.json<Record<string, unknown>>(
      "GET",
      `/api/hotel-setup/properties/${propertyId}/steps/present-hotel`,
    ),
    proposal = {
      expectedCalendarRevision: 0,
      expectedPropertyProfileRevision: numberField(profile, "profileRevision"),
      schedule: { mode: "year_round", periods: [] },
      defaultMinimumStayNights: 1,
      roomTypeLimits: [
        {
          roomTypeId,
          expectedRoomFactsRevision: 1,
          expectedRoomUnitsRevision: roomUnitsRevision,
          startingSellableLimitCount: 2,
        },
      ],
    },
    preview = await api.json<Record<string, unknown>>(
      "POST",
      `/api/pms/properties/${propertyId}/operating-calendar/impact-preview`,
      proposal,
    );
  expect(preview.propertyId).toBe(propertyId);
  const calendar = await api.json<Record<string, unknown>>(
    "PUT",
    `/api/pms/properties/${propertyId}/operating-calendar`,
    { ...proposal, impactConfirmation: recordField(preview, "confirmation") },
    { "Idempotency-Key": `next-smoke:operating-calendar:${propertyId}` },
  );
  expect(calendar.outcome).toBe("created");
  expect(recordField(calendar, "configuration")).toMatchObject({
    propertyId,
    calendarRevision: 1,
  });

  const horizon = berlinInventoryHorizon(),
    materialized = await api.json<Record<string, unknown>>(
      "POST",
      `/api/pms/properties/${propertyId}/inventory-materialization`,
      { expectedCalendarRevision: 1, horizon },
      { "Idempotency-Key": `next-smoke:inventory-materialization:${propertyId}` },
      60_000,
    );
  expect(materialized).toMatchObject({
    ok: true,
    outcome: "applied",
    coverage: {
      materializedRevision: 1,
      coverageFrom: horizon.from,
      coverageThrough: horizon.through,
    },
  });
}

function berlinInventoryHorizon(): { from: string; through: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date()),
    value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value,
    from = `${value("year")}-${value("month")}-${value("day")}`,
    start = Date.parse(`${from}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error("Hotel-local inventory horizon is invalid.");
  return {
    from,
    through: new Date(start + 365 * 86_400_000).toISOString().slice(0, 10),
  };
}

async function configurePricing(api: JsonApi, propertyId: string, roomTypeId: string) {
  await api.json(
    "PUT",
    `/api/pms/properties/${propertyId}/pricing-source/currency`,
    { expectedPricingCurrencyRevision: 0, currency: "EUR" },
    { "Idempotency-Key": `next-smoke:pricing-currency:${propertyId}` },
  );
  await api.json(
    "PUT",
    `/api/pms/properties/${propertyId}/room-types/${roomTypeId}/flexible-rate-plan`,
    {
      expectedRoomFactsRevision: 1,
      expectedPricingCurrencyRevision: 1,
      expectedFlexibleRatePlanRevision: 0,
      baseAmountDecimal: "150.00",
      cancellationTerms: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
      },
    },
    { "Idempotency-Key": `next-smoke:flexible-rate-plan:${propertyId}` },
  );
  const pricing = parsePmsPricingSourceSnapshot(
      await api.json("GET", `/api/pms/properties/${propertyId}/pricing-source`),
    ),
    recurringPricing = parsePmsRecurringPricingBookingEvidence(
      await api.json(
        "GET",
        `/api/pms/properties/${propertyId}/pricing-source/recurring-booking-evidence`,
      ),
    );
  if (!pricing || !recurringPricing) throw new Error("PMS pricing evidence is malformed.");
  const source = createPmsMandatoryChargePricingSourceSnapshot({
      rooms: [
        {
          roomTypeId,
          roomFactsRevision: 1,
          occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
        },
      ],
      pricing,
      recurringPricing,
    }),
    fingerprint = createHash("sha256").update(source.serializedPayload).digest("hex");
  await api.json(
    "PUT",
    `/api/pms/properties/${propertyId}/mandatory-charge-confirmation`,
    {
      expectedConfirmationRevision: 0,
      claimedPricingSourceFingerprint: fingerprint,
      expectedPricingSourceRevisions: source.sourceRevisions,
    },
    { "Idempotency-Key": `next-smoke:mandatory-charge:${propertyId}` },
  );
}

function manualPreviewCommand(roomId: string) {
  const checkIn = new Date();
  checkIn.setUTCHours(0, 0, 0, 0);
  checkIn.setUTCDate(checkIn.getUTCDate() + 5);
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + 1);
  return {
    contractVersion: "pms-manual-booking.v1",
    stays: [
      {
        position: 1,
        roomId,
        checkIn: checkIn.toISOString().slice(0, 10),
        checkOut: checkOut.toISOString().slice(0, 10),
        adults: 1,
        children: 0,
        ratePlanId: null,
        pricing: {
          kind: "custom",
          nightlyAmount: { amountDecimal: "150.00", currency: "EUR" },
        },
      },
    ],
    addOns: [],
  };
}

async function previewStatus(
  request: APIRequestContext,
  accessToken: string,
  propertyId: string,
  command: ReturnType<typeof manualPreviewCommand>,
): Promise<[number, string | null]> {
  const response = await request.post(
      `${NEXT_STACK_ORIGINS.api}/api/pms/properties/${propertyId}/manual-bookings/preview`,
      { headers: { authorization: `Bearer ${accessToken}` }, data: command },
    ),
    body = record(await response.json());
  return [response.status(), typeof body.code === "string" ? body.code : null];
}

async function putPolicy(
  request: APIRequestContext,
  accessToken: string,
  propertyId: string,
  key: string,
  command: Record<string, unknown>,
) {
  const response = await request.put(
    `${NEXT_STACK_ORIGINS.api}/api/booking/properties/${propertyId}/booking-guest-policy`,
    {
      headers: { authorization: `Bearer ${accessToken}`, "Idempotency-Key": key },
      data: command,
    },
  );
  return { status: response.status(), body: record(await response.json()) };
}
