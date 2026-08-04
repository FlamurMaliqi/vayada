import { createHash } from "node:crypto";

import {
  PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM,
  PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION,
} from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import {
  loadPmsMandatoryChargePricingSourceSnapshot,
  type PmsMandatoryChargePricingSourceQueryClient,
} from "./domains/pmsMandatoryChargePricingSourceSnapshot.js";

const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const planId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const seasonId = "11111111-1111-4111-8111-111111111111";
const capturedAt = new Date("2026-08-03T14:30:00.000Z");

function rows(): unknown[][] {
  return [
    [
      {
        propertyId,
        currency: "EUR",
        pricingCurrencyRevision: "2",
        optionalPricingAggregateRevision: "5",
        createdAt: capturedAt,
        updatedAt: capturedAt,
      },
    ],
    [
      {
        propertyId,
        roomTypeId,
        roomFactsRevision: "4",
        occupancyLimits: { total: 4, adults: 2, children: 2 },
      },
    ],
    [
      {
        propertyId,
        roomTypeId,
        flexibleRatePlanId: planId,
        flexibleRatePlanRevision: "3",
        sourceRoomFactsRevision: "4",
        amountDecimal: "160.00",
        currency: "EUR",
        cancellationTerms: {
          type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: 7,
          afterDeadlinePenalty: "full_booking_amount",
          noShowPenalty: "full_booking_amount",
        },
        createdAt: capturedAt,
        updatedAt: capturedAt,
      },
    ],
    [
      {
        propertyId,
        sourceId: seasonId,
        sourceKind: "season",
        sourceRevision: "3",
        pricingCurrencyRevision: "2",
        currency: "EUR",
        configuredState: "disabled",
        validationState: "valid",
        validationRevision: "2",
        validatedAt: capturedAt,
        invalidReasons: [],
        lifecycle: "disabled",
        materializationRevision: "1",
        seasonName: "Summer",
        seasonStartMonth: "6",
        seasonStartDay: "1",
        seasonEndMonth: "8",
        seasonEndDay: "31",
        weekendDays: null,
        discountPercent: null,
        cancellationTermsType: null,
        refundPolicy: null,
        noShowPenalty: null,
        paymentTiming: null,
        createdAt: capturedAt,
        updatedAt: capturedAt,
      },
    ],
    [
      {
        sourceId: seasonId,
        sourceKind: "season",
        roomTypeId,
        roomFactsRevision: "4",
        flexibleRatePlanId: planId,
        flexibleRatePlanRevision: "3",
        seasonalAmount: "180.00",
        weekendAmount: null,
        maximumAdultGuests: null,
        includedGuests: null,
        additionalGuestAmount: null,
      },
    ],
    [],
  ];
}

function client(resultSets = rows()) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  let index = 0;
  const queryClient = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      const result = resultSets[index++] ?? [];
      return { rows: result, rowCount: result.length } as never;
    },
  } satisfies PmsMandatoryChargePricingSourceQueryClient;
  return { queryClient, queries };
}

describe("PMS mandatory-charge pricing-source snapshot loader", () => {
  it("loads active rooms and every retained owner pricing source through one client", async () => {
    const { queryClient, queries } = client();
    const snapshot = await loadPmsMandatoryChargePricingSourceSnapshot(
      queryClient,
      propertyId,
      capturedAt,
    );

    expect(snapshot).toMatchObject({
      payloadVersion: PMS_MANDATORY_CHARGE_PRICING_SOURCE_PAYLOAD_VERSION,
      propertyId,
      sourceRevisions: {
        pricingCurrencyRevision: 2,
        rooms: [{ roomTypeId, roomFactsRevision: 4 }],
        flexibleRatePlans: [
          {
            roomTypeId,
            flexibleRatePlanId: planId,
            flexibleRatePlanRevision: 3,
            sourceRoomFactsRevision: 4,
          },
        ],
        optionalPricingAggregateRevision: 5,
        recurringSources: [
          {
            sourceKind: "season",
            sourceId: seasonId,
            sourceRevision: 3,
            validationRevision: 2,
            materializationRevision: 1,
          },
        ],
      },
    });
    expect(
      createHash(PMS_MANDATORY_CHARGE_PRICING_SOURCE_FINGERPRINT_ALGORITHM)
        .update(snapshot!.serializedPayload)
        .digest("hex"),
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(queries).toHaveLength(6);
    expect(queries.every(({ values }) => values?.[0] === propertyId)).toBe(true);
    expect(queries[1]!.text).toContain("room_type.active IS TRUE");
    expect(queries[3]!.text).not.toMatch(/lifecycle\s*=/i);
    expect(snapshot?.serializedPayload).toContain('"disabled"');
    expect(queries.map(({ text }) => text).join("\n")).not.toMatch(/\bBEGIN\b|pg_advisory/i);
  });

  it("returns unconfigured without reading rooms or optional sources", async () => {
    const { queryClient, queries } = client([[]]);
    await expect(
      loadPmsMandatoryChargePricingSourceSnapshot(queryClient, propertyId, capturedAt),
    ).resolves.toBeNull();
    expect(queries).toHaveLength(1);
  });

  it("supports a configured source with no retained optional pricing", async () => {
    const configuredRows = rows();
    (configuredRows[0]![0] as Record<string, unknown>).optionalPricingAggregateRevision = "0";
    configuredRows[3] = [];
    configuredRows.splice(4);
    const { queryClient, queries } = client(configuredRows);
    const snapshot = await loadPmsMandatoryChargePricingSourceSnapshot(
      queryClient,
      propertyId,
      capturedAt,
    );
    expect(snapshot?.sourceRevisions.optionalPricingAggregateRevision).toBe(0);
    expect(snapshot?.sourceRevisions.recurringSources).toEqual([]);
    expect(queries).toHaveLength(4);
  });

  it("fails closed on malformed scope, capture time, or owner rows", async () => {
    const valid = client();
    await expect(
      loadPmsMandatoryChargePricingSourceSnapshot(valid.queryClient, "not-a-uuid", capturedAt),
    ).rejects.toThrow("scope is malformed");
    await expect(
      loadPmsMandatoryChargePricingSourceSnapshot(valid.queryClient, propertyId, new Date(NaN)),
    ).rejects.toThrow("capture time is invalid");

    const malformedRows = rows();
    (malformedRows[1]![0] as Record<string, unknown>).propertyId =
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const malformed = client(malformedRows);
    await expect(
      loadPmsMandatoryChargePricingSourceSnapshot(malformed.queryClient, propertyId, capturedAt),
    ).rejects.toThrow("active room escaped its property scope");
  });
});
