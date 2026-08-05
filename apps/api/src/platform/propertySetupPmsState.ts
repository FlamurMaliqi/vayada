import { createHash } from "node:crypto";

import {
  parseBookingGuestPolicyCurrentOwnerEvidenceScope,
  type BookingGuestPolicyPmsCurrentOwnerEvidencePort,
} from "@vayada/domain-booking";
import {
  parseHotelCatalogLocationCurrentOwnerEvidenceResult,
  type HotelCatalogLocationCurrentOwnerEvidencePort,
} from "@vayada/domain-hotels";
import {
  createPmsMandatoryChargePricingSourceSnapshot,
  parsePmsMandatoryChargeConfirmationReadResult,
  parsePmsOperatingCalendarCurrentReadResult,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  type PmsMandatoryChargeConfirmationReadPort,
  type PmsOperatingCalendarCanonicalTimeZoneRegistry,
  type PmsOperatingCalendarReadPort,
  type PmsPricingReadPort,
  type PmsRecurringPricingReadPort,
} from "@vayada/domain-pms";

import type { PropertySetupPmsOwnerReadPort } from "../domains/propertySetupPmsOwnerRepository.js";
import type {
  PropertySetupOwnerStateProviderPort,
  PropertySetupOwnerStateRequest,
  PropertySetupOwnerStateResult,
} from "./propertySetupRouteState.js";

export type PropertySetupPmsStateOptions = Readonly<{
  owner: PropertySetupPmsOwnerReadPort;
  pricing: Pick<PmsPricingReadPort, "getPricingSourceSnapshot">;
  recurringPricing: Pick<PmsRecurringPricingReadPort, "getRecurringPricingBookingEvidence">;
  mandatoryCharges: PmsMandatoryChargeConfirmationReadPort;
  operatingCalendar: Pick<PmsOperatingCalendarReadPort, "getCurrentOperatingCalendarConfiguration">;
  calendarRegistry: PmsOperatingCalendarCanonicalTimeZoneRegistry;
  catalogLocation: HotelCatalogLocationCurrentOwnerEvidencePort;
}>;

type BookingGuestPolicyPmsEvidenceInput = Parameters<
  BookingGuestPolicyPmsCurrentOwnerEvidencePort["getCurrentGuestPolicyBaseRevisions"]
>[0];

export function createPropertySetupPmsStateProvider(
  options: PropertySetupPmsStateOptions,
): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      if (!validRequest(request)) return failure();
      try {
        const first = await readSnapshot(options, request);
        const confirmed = await readSnapshot(options, request);
        if (!first || !confirmed || first.identity !== confirmed.identity) return failure();
        return {
          outcome: "found",
          facts: Object.freeze([
            fact(request, "rooms", first.roomsState, first.roomsRevision, first.roomsManifest),
            fact(
              request,
              "pricing",
              first.pricingState,
              first.pricingRevision,
              first.pricingManifest,
            ),
            fact(
              request,
              "calendar",
              first.calendarState,
              first.calendarRevision,
              first.calendarManifest,
            ),
          ]),
        };
      } catch {
        return failure();
      }
    },
  };
}

export function createPropertySetupBookingGuestPolicyPmsCurrentOwnerEvidenceAdapter(
  options: Pick<PropertySetupPmsStateOptions, "owner" | "pricing">,
): BookingGuestPolicyPmsCurrentOwnerEvidencePort {
  return Object.freeze({
    bookingGuestPolicyCurrentOwnerEvidencePort: "pms" as const,
    async getCurrentGuestPolicyBaseRevisions(input: BookingGuestPolicyPmsEvidenceInput) {
      const scope = parseBookingGuestPolicyCurrentOwnerEvidenceScope(input);
      if (!scope) return Object.freeze({ outcome: "malformed" as const });
      try {
        const first = await readGuestPolicyPmsSnapshot(options, scope);
        const confirmed = await readGuestPolicyPmsSnapshot(options, scope);
        if (!first || !confirmed) return Object.freeze({ outcome: "malformed" as const });
        if (first.identity !== confirmed.identity)
          return Object.freeze({
            outcome: "unavailable" as const,
            errorSource: "provider" as const,
          });
        return Object.freeze({
          outcome: "available" as const,
          evidence: Object.freeze({
            organizationId: scope.organizationId,
            propertyId: scope.propertyId,
            revisions: first.revisions,
          }),
        });
      } catch {
        return Object.freeze({ outcome: "unavailable" as const, errorSource: "system" as const });
      }
    },
  });
}

async function readGuestPolicyPmsSnapshot(
  options: Pick<PropertySetupPmsStateOptions, "owner" | "pricing">,
  scope: Readonly<{ organizationId: string; propertyId: string }>,
) {
  const [rawRooms, rawPricing] = await Promise.all([
    options.owner.getRoomOwnerSnapshot(scope),
    options.pricing.getPricingSourceSnapshot(scope.propertyId),
  ]);
  const rooms =
    rawRooms.organizationId === scope.organizationId &&
    rawRooms.propertyId === scope.propertyId &&
    validRooms(rawRooms.rooms)
      ? rawRooms
      : null;
  const pricing = rawPricing === null ? null : parsePmsPricingSourceSnapshot(rawPricing);
  if (
    !rooms ||
    (rawPricing !== null && !pricing) ||
    (pricing !== null && pricing.propertyId !== scope.propertyId)
  )
    return null;
  const revisions = Object.freeze({
    "pms.pricing_settings": `pricing:${pricing?.pricingCurrency.pricingCurrencyRevision ?? 0}`,
    "pms.rate_plans": collectionRevision(
      "rate-plans",
      (pricing?.flexibleRatePlans ?? []).map((plan) => [
        plan.roomTypeId,
        plan.flexibleRatePlanId,
        plan.flexibleRatePlanRevision,
        plan.sourceRoomFactsRevision,
      ]),
    ),
    "pms.room_types": collectionRevision(
      "room-types",
      rooms.rooms.map((room) => [room.roomTypeId, room.roomFactsRevision]),
    ),
  });
  return Object.freeze({ revisions, identity: digest(JSON.stringify(revisions)) });
}

async function readSnapshot(
  options: PropertySetupPmsStateOptions,
  request: PropertySetupOwnerStateRequest,
) {
  const [
    rawRooms,
    rawPricing,
    rawRecurring,
    rawConfirmation,
    rawCalendar,
    rawInventory,
    rawCatalogLocation,
  ] = await Promise.all([
    options.owner.getRoomOwnerSnapshot({
      organizationId: request.organizationId,
      propertyId: request.propertyId,
    }),
    options.pricing.getPricingSourceSnapshot(request.propertyId),
    options.recurringPricing.getRecurringPricingBookingEvidence(request.propertyId),
    options.mandatoryCharges.getMandatoryChargeConfirmation({
      organizationId: request.organizationId,
      propertyId: request.propertyId,
    }),
    options.operatingCalendar.getCurrentOperatingCalendarConfiguration(request.propertyId),
    options.owner.getInventoryOwnerSnapshot({
      organizationId: request.organizationId,
      propertyId: request.propertyId,
    }),
    options.catalogLocation.getCurrentLocationOwnerEvidence({
      organizationId: request.organizationId,
      propertyId: request.propertyId,
    }),
  ]);
  const rooms =
    rawRooms.organizationId === request.organizationId &&
    rawRooms.propertyId === request.propertyId &&
    validRooms(rawRooms.rooms)
      ? rawRooms
      : null;
  const pricing = rawPricing === null ? null : parsePmsPricingSourceSnapshot(rawPricing);
  const recurring =
    rawRecurring === null ? null : parsePmsRecurringPricingBookingEvidence(rawRecurring);
  const confirmation = parsePmsMandatoryChargeConfirmationReadResult(rawConfirmation);
  const calendar =
    rawCalendar === null
      ? null
      : parsePmsOperatingCalendarCurrentReadResult(rawCalendar, options.calendarRegistry);
  const catalogLocation = parseHotelCatalogLocationCurrentOwnerEvidenceResult(rawCatalogLocation, {
    organizationId: request.organizationId,
    propertyId: request.propertyId,
  });
  if (
    !rooms ||
    (rawPricing !== null && !pricing) ||
    (rawRecurring !== null && !recurring) ||
    !confirmation ||
    (rawCalendar !== null && !calendar) ||
    !catalogLocation ||
    catalogLocation.outcome !== "available" ||
    (pricing !== null && pricing.propertyId !== request.propertyId) ||
    (recurring !== null && recurring.propertyId !== request.propertyId) ||
    (calendar !== null && calendar.configuration.propertyId !== request.propertyId) ||
    (rawInventory !== null &&
      (rawInventory.organizationId !== request.organizationId ||
        rawInventory.propertyId !== request.propertyId)) ||
    confirmation.organizationId !== request.organizationId ||
    confirmation.propertyId !== request.propertyId ||
    confirmation.outcome === "malformed" ||
    confirmation.outcome === "unavailable" ||
    (pricing === null) !== (recurring === null)
  ) {
    return null;
  }

  const roomsManifest = Object.freeze({
    "pms.room_types": collectionRevision(
      "room-types",
      rooms.rooms.map((room) => [room.roomTypeId, room.roomFactsRevision]),
    ),
    "pms.room_units": collectionRevision(
      "room-units",
      rooms.rooms.map((room) => [room.roomTypeId, room.roomUnitsRevision]),
    ),
    "pms.room_media": collectionRevision(
      "room-media",
      rooms.rooms.map((room) => [room.roomTypeId, room.roomMediaRevision]),
    ),
  });
  const pricingRevision = pricing?.pricingCurrency.pricingCurrencyRevision ?? 0;
  const ratePlans = pricing?.flexibleRatePlans ?? [];
  const currentPricingFingerprint =
    pricing && recurring
      ? digest(
          createPmsMandatoryChargePricingSourceSnapshot({
            rooms: rooms.rooms.map((room) => ({
              roomTypeId: room.roomTypeId,
              roomFactsRevision: room.roomFactsRevision,
              occupancy: room.facts.occupancy,
            })),
            pricing,
            recurringPricing: recurring,
          }).serializedPayload,
        )
      : null;
  const confirmationIdentity =
    confirmation.outcome === "available"
      ? [confirmation.evidence.confirmationRevision, confirmation.evidence.pricingSourceFingerprint]
      : [0, "missing"];
  const pricingManifest = Object.freeze({
    "pms.pricing_settings": `pricing:${pricingRevision}`,
    "pms.rate_plans": collectionRevision(
      "rate-plans",
      ratePlans.map((plan) => [
        plan.roomTypeId,
        plan.flexibleRatePlanId,
        plan.flexibleRatePlanRevision,
        plan.sourceRoomFactsRevision,
      ]),
    ),
    "pms.rate_rules": collectionRevision("rate-rules", [
      recurring?.optionalPricingAggregateRevision ?? 0,
      ...(recurring?.sources.map((source) => [
        source.sourceKind,
        source.sourceId,
        source.sourceRevision,
        source.validation.validationRevision,
      ]) ?? []),
      confirmationIdentity,
    ]),
  });
  const calendarRevision = calendar?.configuration.calendarRevision ?? 0;
  const calendarManifest = Object.freeze({
    "pms.operating_calendar": `calendar:${calendarRevision}`,
    "pms.inventory": `inventory:${rawInventory?.materializedRevision ?? 0}`,
    "pms.room_types": roomsManifest["pms.room_types"],
    "hotel_catalog.location": catalogLocation.evidence.baseRevision,
  });
  const activeRoomIds = rooms.rooms.map(({ roomTypeId }) => roomTypeId);
  const planRoomIds = new Set(ratePlans.map(({ roomTypeId }) => roomTypeId));
  const pricingComplete =
    pricing !== null &&
    activeRoomIds.length > 0 &&
    activeRoomIds.every((roomTypeId) => planRoomIds.has(roomTypeId)) &&
    confirmation.outcome === "available" &&
    confirmation.evidence.pricingSourceFingerprint === currentPricingFingerprint;
  const calendarComplete =
    calendar?.sourceStatus === "current" &&
    rawInventory?.calendarRevision === calendarRevision &&
    rawInventory.materializedRevision === calendarRevision;
  const roomsComplete =
    rooms.rooms.length > 0 &&
    rooms.rooms.every(
      (room) => room.activeUnitCount > 0 && room.mediaAssignmentCount > 0 && room.amenitiesReviewed,
    );
  const snapshot = {
    roomsState: roomsComplete
      ? ("complete" as const)
      : rooms.rooms.length
        ? ("saved" as const)
        : ("not_started" as const),
    roomsRevision: collectionRevision(
      "rooms-state",
      rooms.rooms.map((room) => [
        room.roomTypeId,
        room.roomFactsRevision,
        room.roomUnitsRevision,
        room.roomMediaRevision,
        room.roomAmenitiesRevision,
        room.activeUnitCount,
        room.mediaAssignmentCount,
        room.amenitiesReviewed,
      ]),
    ),
    roomsManifest,
    pricingState: pricingComplete
      ? ("complete" as const)
      : pricing
        ? ("saved" as const)
        : ("not_started" as const),
    pricingRevision: collectionRevision("pricing", Object.entries(pricingManifest)),
    pricingManifest,
    calendarState: calendarComplete
      ? ("complete" as const)
      : calendar
        ? ("saved" as const)
        : ("not_started" as const),
    calendarRevision: collectionRevision("calendar-state", Object.entries(calendarManifest)),
    calendarManifest,
  };
  return Object.freeze({ ...snapshot, identity: digest(JSON.stringify(snapshot)) });
}

function fact(
  request: PropertySetupOwnerStateRequest,
  stepId: "rooms" | "pricing" | "calendar",
  state: "not_started" | "saved" | "complete",
  sourceRevision: string,
  currentBaseRevisions: Readonly<Record<string, string>>,
) {
  return Object.freeze({
    organizationId: request.organizationId,
    propertyId: request.propertyId,
    stepId,
    product: "pms" as const,
    ownerDomain: "pms" as const,
    state,
    sourceRevision,
    currentBaseRevisions,
    blockers: [],
  });
}

function validRequest(request: PropertySetupOwnerStateRequest): boolean {
  return (
    request.stepIds.length === 3 &&
    request.stepIds[0] === "rooms" &&
    request.stepIds[1] === "pricing" &&
    request.stepIds[2] === "calendar"
  );
}

function validRooms(
  rooms: Awaited<ReturnType<PropertySetupPmsOwnerReadPort["getRoomOwnerSnapshot"]>>["rooms"],
): boolean {
  const roomIds = new Set(rooms.map(({ roomTypeId }) => roomTypeId));
  return (
    roomIds.size === rooms.length &&
    rooms.every(
      (room) =>
        room.roomTypeId.trim().length > 0 &&
        Number.isSafeInteger(room.activeUnitCount) &&
        room.activeUnitCount >= 0 &&
        Number.isSafeInteger(room.mediaAssignmentCount) &&
        room.mediaAssignmentCount >= 0 &&
        Number.isSafeInteger(room.roomFactsRevision) &&
        room.roomFactsRevision >= 1 &&
        Number.isSafeInteger(room.roomUnitsRevision) &&
        room.roomUnitsRevision >= 1 &&
        Number.isSafeInteger(room.roomMediaRevision) &&
        room.roomMediaRevision >= 1 &&
        Number.isSafeInteger(room.roomAmenitiesRevision) &&
        room.roomAmenitiesRevision >= 1,
    )
  );
}

function collectionRevision(namespace: string, value: unknown): string {
  return `${namespace}:${digest(JSON.stringify(value))}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function failure(): PropertySetupOwnerStateResult {
  return { outcome: "provider_failure" };
}
