import { createHash } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { BookingPricingSourceFingerprint } from "./bookingPricingEvidence.js";
import {
  BOOKING_GUEST_POLICY_AUTHORIZATION,
  BOOKING_GUEST_POLICY_OUTBOX_METADATA,
  createBookingGuestPolicyNewDraft,
  createBookingGuestPolicyPublicProjection,
  parseBookingGuestPolicyChangedEvent,
  parseUpsertBookingGuestPolicyRequest,
  serializeBookingGuestPolicyCommandFingerprint,
  type BookingGuestPolicyChangedEvent,
  type PersistBookingGuestPolicyCommand,
  type BookingGuestPolicyRevision,
  type UpsertBookingGuestPolicyCommand,
} from "./bookingGuestPolicyAggregate.js";
import {
  BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  type BookingGuestPolicyBundle,
  type BookingGuestPolicyHash,
} from "./bookingGuestPolicy.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const propertyId = "20000000-0000-4000-8000-000000000002";
const revisionId = "30000000-0000-4000-8000-000000000003";
const outboxEventId = "40000000-0000-4000-8000-000000000004";
const confirmationId = "50000000-0000-4000-8000-000000000005";
const sourceFingerprint = `sha256:${"1".repeat(64)}` as BookingGuestPolicyHash;
const bundleHash = `sha256:${"2".repeat(64)}` as BookingGuestPolicyHash;

describe("Booking guest-policy aggregate contract", () => {
  it("owns authorization, source-read outbox metadata, and immutable new-draft defaults", () => {
    expect(BOOKING_GUEST_POLICY_AUTHORIZATION).toEqual({
      permission: "booking.settings.manage",
      entitlement: { product: "booking", key: "booking-engine" },
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        allowedRelationships: ["owner", "operator"],
      },
    });
    expect(BOOKING_GUEST_POLICY_OUTBOX_METADATA).toEqual({ sourceReadRequired: true });
    const draft = createBookingGuestPolicyNewDraft();
    expect(draft).toEqual({
      defaultGuestLanguage: null,
      childrenEnabled: null,
      adultAgeThreshold: null,
      phoneRequired: true,
      arrivalTimeEnabled: false,
      specialRequestsEnabled: true,
      checkInTime: null,
      checkOutTime: null,
    });
    expect(Object.isFrozen(draft)).toBe(true);
  });

  it("strictly parses every required choice and preserves optional choices as non-blocking data", () => {
    const value = {
      expectedRevision: 0,
      expectedSourceFingerprint: sourceFingerprint,
      choices: choices(),
      confirmPolicyBundle: true,
    };
    const parsed = parseUpsertBookingGuestPolicyRequest(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.choices)).toBe(true);
    for (const invalid of [
      { ...value, extra: true },
      { ...value, expectedRevision: 2_147_483_647 },
      { ...value, expectedSourceFingerprint: "sha256:bad" },
      { ...value, confirmPolicyBundle: "yes" },
      { ...value, choices: { ...value.choices, phoneRequired: undefined } },
    ])
      expect(parseUpsertBookingGuestPolicyRequest(invalid)).toBeNull();
  });

  it("fingerprints optional guest choices even when the public policy bundle hash is unchanged", () => {
    const original = command();
    const originalFingerprint = serializeBookingGuestPolicyCommandFingerprint(original);
    expect(
      serializeBookingGuestPolicyCommandFingerprint({
        ...original,
        organizationId: organizationId.toUpperCase(),
        propertyId: propertyId.toUpperCase(),
      }),
    ).toBe(originalFingerprint);
    expect(
      serializeBookingGuestPolicyCommandFingerprint({
        ...original,
        choices: { ...original.choices, phoneRequired: false },
      }),
    ).not.toBe(originalFingerprint);
    expect(() =>
      serializeBookingGuestPolicyCommandFingerprint({
        ...original,
        choices: {
          ...original.choices,
          ignored: "internal-noise",
        } as unknown as UpsertBookingGuestPolicyCommand["choices"],
      }),
    ).toThrow("Booking guest-policy command is invalid");
    expect(() =>
      serializeBookingGuestPolicyCommandFingerprint({
        ...original,
        expectedSourceFingerprint: "sha256:bad",
      } as UpsertBookingGuestPolicyCommand),
    ).toThrow("Booking guest-policy command is invalid");
    expect(() =>
      serializeBookingGuestPolicyCommandFingerprint({
        ...original,
        expectedRevision: 2_147_483_647,
      }),
    ).toThrow("Booking guest-policy command is invalid");
  });

  it("parses only the secret-safe invalidation event vocabulary", () => {
    const event = {
      contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
      eventType: BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
      revisionId,
      propertyId,
      guestPolicyRevision: 1,
      confirmationRevision: 1,
      outcome: "created",
    } as const;
    expect(parseBookingGuestPolicyChangedEvent(event)).toEqual(event);
    expect(
      parseBookingGuestPolicyChangedEvent({ ...event, policy: "late arrival allowed" }),
    ).toBeNull();
    expect(parseBookingGuestPolicyChangedEvent({ ...event, guestPolicyRevision: 0 })).toBeNull();
    expectTypeOf<BookingGuestPolicyChangedEvent>().not.toHaveProperty("choices");
    expectTypeOf<BookingGuestPolicyChangedEvent>().not.toHaveProperty("bundleHash");
    expectTypeOf<UpsertBookingGuestPolicyCommand>().not.toHaveProperty("bundle");
    expectTypeOf<PersistBookingGuestPolicyCommand>().toHaveProperty("bundle");
  });

  it("projects only structured public policy and strips guest-form choices and owner revisions", () => {
    const projection = createBookingGuestPolicyPublicProjection(revision());
    expect(Object.keys(projection)).toEqual([
      "contractVersion",
      "propertyId",
      "guestPolicyRevision",
      "catalogProfileSourceRevision",
      "sourceFingerprint",
      "bundleHash",
      "policy",
    ]);
    expect(Object.keys(projection.policy)).toEqual([
      "childrenEnabled",
      "adultAgeThreshold",
      "checkInTime",
      "checkOutTime",
      "pricingCurrency",
      "propertyTimeZone",
      "rates",
    ]);
    expect(projection.policy.rates[0]).toEqual({
      roomTypeId: "60000000-0000-4000-8000-000000000006",
      flexible: {
        freeCancellationDeadlineDays: 2,
        cutoff: { localTime: "18:00", timeZone: "Europe/Berlin" },
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
      },
      nonRefundable: {
        refundPolicy: "no_refund",
        noShowPenalty: "full_booking_amount",
        paymentTiming: "prepay_full",
      },
      additionalGuest: {
        includedGuestsPerRoom: 2,
        amountDecimal: "15.00",
        currency: "EUR",
        countedGuestTypes: ["adult", "child"],
      },
    });
    expect(JSON.stringify(projection)).not.toContain("phoneRequired");
    expect(JSON.stringify(projection)).not.toContain("defaultGuestLanguage");
    expect(JSON.stringify(projection)).not.toContain("flexible_rate_plan");
    expect(Object.isFrozen(projection.policy.rates[0]?.flexible.cutoff)).toBe(true);
    expect(() =>
      createBookingGuestPolicyPublicProjection({
        ...revision(),
        catalogProfileSourceRevision: "profile:8",
      }),
    ).toThrow("Booking guest-policy revision is invalid");
    expect(() =>
      createBookingGuestPolicyPublicProjection({
        ...revision(),
        bundle: { ...revision().bundle, bundleHash },
      }),
    ).toThrow("Booking guest-policy revision is invalid");
    expect(() =>
      createBookingGuestPolicyPublicProjection({
        ...revision(),
        projectionReceipt: { outcome: "applied" } as never,
      }),
    ).toThrow("Booking guest-policy revision is invalid");
  });
});

function choices() {
  return {
    defaultGuestLanguage: "en" as const,
    childrenEnabled: true,
    adultAgeThreshold: 18,
    phoneRequired: true,
    arrivalTimeEnabled: false,
    specialRequestsEnabled: true,
    checkInTime: "15:00",
    checkOutTime: "11:00",
  };
}

function bundle(): BookingGuestPolicyBundle {
  const roomTypeId = "60000000-0000-4000-8000-000000000006";
  const flexibleSource = {
    ownerDomain: "pms" as const,
    entityType: "pms_flexible_rate_plan.v1" as const,
    entityId: "70000000-0000-4000-8000-000000000007",
    revision: "4",
  };
  const nonRefundableSource = {
    ownerDomain: "pms" as const,
    entityType: "pms_recurring_pricing_rule.v1" as const,
    entityId: "80000000-0000-4000-8000-000000000008",
    revision: "5",
  };
  const additionalGuestSource = {
    ownerDomain: "pms" as const,
    entityType: "pms_recurring_pricing_rule.v1" as const,
    entityId: "90000000-0000-4000-8000-000000000009",
    revision: "6",
  };
  const sourceBindings = [
    {
      ownerDomain: "hotel_catalog" as const,
      entityType: "property_profile",
      entityId: propertyId,
      revision: "profile:7",
    },
    {
      ownerDomain: "pms" as const,
      entityType: "pms_property_pricing_currency.v1",
      entityId: propertyId,
      revision: "2",
    },
    {
      ownerDomain: "pms" as const,
      entityType: "pms_optional_pricing_aggregate.v1",
      entityId: propertyId,
      revision: "3",
    },
    {
      ownerDomain: "pms" as const,
      entityType: "pms_room_facts.v1",
      entityId: roomTypeId,
      revision: "3",
    },
    flexibleSource,
    nonRefundableSource,
    additionalGuestSource,
    {
      ownerDomain: "pms" as const,
      entityType: "pms_mandatory_charge_confirmation.v1",
      entityId: propertyId,
      revision: "4",
    },
  ].sort((left, right) => {
    const leftTuple = JSON.stringify(Object.values(left));
    const rightTuple = JSON.stringify(Object.values(right));
    return leftTuple < rightTuple ? -1 : leftTuple > rightTuple ? 1 : 0;
  });
  const rates = [
    {
      roomTypeId,
      roomFactsRevision: 3,
      flexible: {
        source: flexibleSource,
        freeCancellationDeadlineDays: 2,
        cutoff: { localTime: "18:00", timeZone: "Europe/Berlin" },
        afterDeadlinePenalty: "full_booking_amount" as const,
        noShowPenalty: "full_booking_amount" as const,
      },
      nonRefundable: {
        source: {
          source: nonRefundableSource,
          validationRevision: 2,
          materializationRevision: 2,
        },
        refundPolicy: "no_refund" as const,
        noShowPenalty: "full_booking_amount" as const,
        paymentTiming: "prepay_full" as const,
      },
      additionalGuest: {
        source: {
          source: additionalGuestSource,
          validationRevision: 3,
          materializationRevision: 3,
        },
        includedGuestsPerRoom: 2,
        amountDecimal: "15.00",
        currency: "EUR",
        countedGuestTypes: ["adult", "child"] as const,
      },
    },
  ];
  const computedSourceFingerprint = hash([
    BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    "3".repeat(64),
    4,
    sourceBindings,
    rates.map(({ roomTypeId: id, roomFactsRevision, flexible, nonRefundable, additionalGuest }) => [
      id,
      roomFactsRevision,
      flexible.source,
      nonRefundable?.source ?? null,
      additionalGuest?.source ?? null,
    ]),
  ]);
  const computedBundleHash = hash([
    BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    computedSourceFingerprint,
    {
      childrenEnabled: true,
      adultAgeThreshold: 18,
      checkInTime: "15:00",
      checkOutTime: "11:00",
    },
    "EUR",
    "Europe/Berlin",
    rates,
  ]);
  return {
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    organizationId,
    propertyId,
    choices: choices(),
    pricingCurrency: "EUR",
    propertyTimeZone: "Europe/Berlin",
    pricingSourceFingerprint: "3".repeat(64) as BookingPricingSourceFingerprint,
    mandatoryChargeConfirmationRevision: 4,
    sourceBindings,
    sourceFingerprint: computedSourceFingerprint,
    rates,
    bundleHash: computedBundleHash,
  } as BookingGuestPolicyBundle;
}

function hash(value: unknown): BookingGuestPolicyHash {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function command(): UpsertBookingGuestPolicyCommand {
  return {
    organizationId,
    propertyId,
    idempotencyKey: "guest-policy-1",
    audit: {
      actor: { kind: "user", userId: "a0000000-0000-4000-8000-00000000000a" },
      requestId: "request-1",
      correlationId: null,
      requestedAt: "2026-08-04T18:00:00.000Z",
    },
    expectedRevision: 0,
    expectedSourceFingerprint: sourceFingerprint,
    choices: choices(),
    confirmPolicyBundle: true,
  };
}

function revision(): BookingGuestPolicyRevision {
  return {
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    revisionId,
    organizationId,
    propertyId,
    revision: 1,
    catalogProfileSourceRevision: "profile:7",
    bundle: bundle(),
    confirmation: {
      confirmationId,
      confirmationRevision: 1,
      basis: "explicit",
      basedOnConfirmationId: null,
      reviewedAt: "2026-08-04T18:00:00.000Z",
      recordedAt: "2026-08-04T18:00:00.000Z",
    },
    projectionReceipt: null,
    outboxEventId,
    acceptedAt: "2026-08-04T18:00:00.000Z",
  };
}
