import {
  BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  composeBookingGuestPolicy,
  createBookingPricingSourceFingerprint,
  parseBookingGuestPolicyRevision,
  type BookingGuestPolicyBundle,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyCurrentOwnerEvidenceResult,
  type BookingGuestPolicyOwnerEvidencePorts,
  type BookingGuestPolicyProjectionReceipt,
  type BookingGuestPolicyRevision,
  type BookingPricingOwnerEvidenceInput,
  type PersistBookingGuestPolicyCommand,
  type UpsertBookingGuestPolicyCommand,
} from "@vayada/domain-booking";
import { vi } from "vitest";

import { createBookingGuestPolicyApplication } from "./domains/bookingGuestPolicyApplication.js";

export const organizationId = "10000000-0000-4000-8000-000000000001";
export const propertyId = "20000000-0000-4000-8000-000000000002";
export const otherPropertyId = "20000000-0000-4000-8000-000000000012";
const roomTypeId = "30000000-0000-4000-8000-000000000003";
const planId = "40000000-0000-4000-8000-000000000004";
export const actorUserId = "50000000-0000-4000-8000-000000000005";
export const revisionId = "60000000-0000-4000-8000-000000000006";
const confirmationId = "70000000-0000-4000-8000-000000000007";
export const outboxEventId = "80000000-0000-4000-8000-000000000008";
export const receiptId = "90000000-0000-4000-8000-000000000009";
export const now = "2026-08-05T08:00:00.000Z";

export const choices = {
  defaultGuestLanguage: "en" as const,
  childrenEnabled: true,
  adultAgeThreshold: 18,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};

export function applicationHarness(
  options: {
    current?: BookingGuestPolicyRevision | null;
    replay?: BookingGuestPolicyRevision;
  } = {},
) {
  const evidence = pricingEvidence();
  const catalogProfile = {
    outcome: "available" as const,
    evidence: {
      source: {
        ownerDomain: "hotel_catalog" as const,
        entityType: "property_profile" as const,
        entityId: propertyId,
        revision: "profile:8",
      },
      timeZone: "Europe/Berlin",
    },
  };
  const fingerprint = createBookingPricingSourceFingerprint(
    { organizationId, propertyId },
    evidence,
  );
  const ownerSpies = {
    catalog: vi.fn(async () => catalogProfile),
    rooms: vi.fn(async () => evidence.roomPublication),
    pricing: vi.fn(async () => evidence.pricing),
    recurring: vi.fn(async () => evidence.recurringPricing),
    confirmation: vi.fn(async () => ({
      outcome: "available" as const,
      evidence: {
        organizationId,
        propertyId,
        pricingSourceFingerprint: fingerprint,
        confirmationRevision: 6,
        confirmedAt: now,
      },
    })),
  };
  const ownerEvidence: BookingGuestPolicyOwnerEvidencePorts = {
    catalogProfile: {
      bookingGuestPolicyCatalogProfileEvidencePort: "hotel_catalog",
      getCatalogProfileEvidence: ownerSpies.catalog,
    },
    rooms: { getRoomPublicationSnapshot: ownerSpies.rooms },
    pricing: { getPricingSourceSnapshot: ownerSpies.pricing },
    recurringPricing: { getRecurringPricingBookingEvidence: ownerSpies.recurring },
    mandatoryChargeConfirmation: {
      bookingPricingConfirmationEvidencePort: "pms_mandatory_charges",
      getMandatoryChargeConfirmation: ownerSpies.confirmation,
    },
  };
  const current = options.current === undefined ? null : options.current;
  const persist = vi.fn(async (input: PersistBookingGuestPolicyCommand) => ({
    ok: true as const,
    outcome: "created" as const,
    revision: revisionFixture({ bundle: input.bundle }),
  }));
  const application = createBookingGuestPolicyApplication({
    authorizedReplay: {
      async findAuthorizedReplay() {
        return options.replay
          ? { outcome: "replay" as const, revision: options.replay }
          : { outcome: "not_found" as const };
      },
    },
    persistence: { persistGuestPolicy: persist },
    read: {
      async getCurrentGuestPolicy() {
        return current;
      },
    },
    ownerEvidence,
    currentOwnerEvidence: {
      async getCurrentGuestPolicyOwnerEvidence() {
        return currentEvidence(current);
      },
    },
  });
  return {
    application,
    persist,
    ownerCalls: () =>
      Object.values(ownerSpies).reduce((sum, spy) => sum + spy.mock.calls.length, 0),
  };
}

export function compositionFixture(policyChoices: BookingGuestPolicyChoices = choices) {
  const evidence = pricingEvidence();
  const pricingSourceFingerprint = createBookingPricingSourceFingerprint(
    { organizationId, propertyId },
    evidence,
  );
  const composition = composeBookingGuestPolicy({
    request: { organizationId, propertyId },
    choices: policyChoices,
    catalogProfile: {
      outcome: "available",
      evidence: {
        source: {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: "profile:8",
        },
        timeZone: "Europe/Berlin",
      },
    },
    pricing: evidence,
    mandatoryChargeConfirmation: {
      outcome: "available",
      evidence: {
        organizationId,
        propertyId,
        pricingSourceFingerprint,
        confirmationRevision: 6,
        confirmedAt: now,
      },
    },
  });
  if (composition.outcome !== "ready") throw new Error("Expected ready test composition");
  return composition;
}

export function pricingEvidence(): BookingPricingOwnerEvidenceInput {
  return structuredClone({
    roomPublication: {
      contractVersion: "pms-room-publication.v1",
      propertyId,
      status: "ready",
      rooms: [
        {
          propertyId,
          roomTypeId,
          facts: {
            name: "Suite",
            description: "A complete room",
            category: null,
            occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 4 },
            beds: [],
            bedrooms: null,
            bathrooms: null,
            bathroomType: "private",
            size: null,
          },
          activeUnitCount: 1,
          media: [],
          amenities: [],
          sourceRevisions: {
            roomFactsRevision: 4,
            roomUnitsRevision: 1,
            roomMediaRevision: 1,
            roomAmenitiesRevision: 1,
          },
          sourceRevision: "room:4",
        },
      ],
      blockers: [],
      sourceRevision: "rooms:4",
    },
    pricing: {
      contractVersion: "pms-pricing.v1",
      propertyId,
      pricingCurrency: {
        contractVersion: "pms-pricing.v1",
        propertyId,
        currency: "EUR",
        pricingCurrencyRevision: 2,
        createdAt: now,
        updatedAt: now,
      },
      flexibleRatePlans: [
        {
          contractVersion: "pms-pricing.v1",
          propertyId,
          roomTypeId,
          flexibleRatePlanId: planId,
          flexibleRatePlanRevision: 3,
          sourceRoomFactsRevision: 4,
          baseAmount: { amountDecimal: "160.00", currency: "EUR" },
          cancellationTerms: {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: 7,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
      capturedAt: now,
    },
    recurringPricing: {
      contractVersion: "pms-recurring-pricing.v1",
      propertyId,
      pricingCurrencyRevision: 2,
      optionalPricingAggregateRevision: 0,
      currency: "EUR",
      sources: [],
      capturedAt: now,
    },
  }) as unknown as BookingPricingOwnerEvidenceInput;
}

export function revisionFixture(
  options: {
    bundle?: BookingGuestPolicyBundle;
    projectionReceipt?: BookingGuestPolicyProjectionReceipt | null;
  } = {},
): BookingGuestPolicyRevision {
  const bundle = options.bundle ?? compositionFixture().bundle;
  const revision = parseBookingGuestPolicyRevision({
    contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
    revisionId,
    organizationId,
    propertyId,
    revision: 1,
    catalogProfileSourceRevision: "profile:8",
    bundle,
    confirmation: {
      confirmationId,
      confirmationRevision: 1,
      basis: "explicit",
      basedOnConfirmationId: null,
      reviewedAt: now,
      recordedAt: now,
    },
    projectionReceipt: options.projectionReceipt ?? null,
    outboxEventId,
    acceptedAt: now,
  });
  if (!revision) throw new Error("Expected valid test revision");
  return revision;
}

export function appliedReceipt(): BookingGuestPolicyProjectionReceipt {
  const bundle = compositionFixture().bundle;
  return {
    outcome: "applied",
    receiptId,
    sourceOutboxEventId: outboxEventId,
    projectedGuestPolicyRevision: 1,
    projectedBundleHash: bundle.bundleHash,
    projectedSourceFingerprint: bundle.sourceFingerprint,
    catalogProfileSourceRevision: "profile:8",
    catalogPolicyProjectionRevision: 9,
    recordedAt: now,
  };
}

export function currentEvidence(
  current: BookingGuestPolicyRevision | null,
): BookingGuestPolicyCurrentOwnerEvidenceResult {
  return {
    outcome: "available",
    organizationId,
    propertyId,
    currentBaseRevisions: {
      "booking.guest_experience": current
        ? (`guest-policy:${current.revision}` as const)
        : "guest-policy:absent",
      "pms.pricing_settings": "pms.pricing_settings:2",
      "pms.rate_plans": "pms.rate_plans:3",
      "pms.room_types": "pms.room_types:4",
      "hotel_catalog.location": `hotel_catalog.location:${propertyId}:r5`,
      "hotel_catalog.policy": `hotel_catalog.policy:${propertyId}:r9`,
    },
  };
}

export function command(
  overrides: Partial<UpsertBookingGuestPolicyCommand> = {},
): UpsertBookingGuestPolicyCommand {
  const bundle = compositionFixture().bundle;
  return {
    organizationId,
    propertyId,
    idempotencyKey: "guest-policy-command",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-1",
      correlationId: null,
      requestedAt: now,
    },
    expectedRevision: 0,
    expectedSourceFingerprint: bundle.sourceFingerprint,
    choices,
    confirmPolicyBundle: true,
    ...overrides,
  };
}

export function projectionMessage() {
  return {
    organizationId,
    outboxEventId,
    event: {
      contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
      eventType: BOOKING_GUEST_POLICY_CHANGED_EVENT_TYPE,
      revisionId,
      propertyId,
      guestPolicyRevision: 1,
      confirmationRevision: 1,
      outcome: "created" as const,
    },
    processedAt: now,
  };
}
