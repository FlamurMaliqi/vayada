import {
  createBookingPricingSourceFingerprint,
  type BookingLaunchOwnerBlocker,
  type BookingLaunchPmsEvidencePort,
  type BookingLaunchSourceRevision,
  type BookingMandatoryChargeConfirmationEvidencePort,
} from "@vayada/domain-booking";
import {
  BOOKING_OWNER_SNAPSHOT_VERSION,
  type BookingPublicationOwnerSnapshotPort,
  type BookingPublicationSnapshotContent,
} from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import type { SourceEntityRevision } from "@vayada/domain-hotels";
import {
  PMS_PRICING_SOURCE_ENTITY_TYPES,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  serializePmsPricingSourceEntityRevision,
  type PmsInventoryLaunchReadinessReadPort,
  type PmsOperatingCalendarReadPort,
  type PmsPricingReadPort,
  type PmsRecurringPricingReadPort,
  type RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";

import { buildPmsBookingPublicationContent } from "./pmsBookingPublicationContent.js";

type PmsSource = Omit<SourceEntityRevision, "ownerDomain"> & { ownerDomain: "pms" };
type LoadedPms = {
  sources: PmsSource[];
  rooms: readonly { source: PmsSource; blockers: BookingLaunchOwnerBlocker[] }[];
  pricingSource: PmsSource;
  pricingBlockers: BookingLaunchOwnerBlocker[];
  calendarSource: PmsSource;
  calendarBindings: BookingLaunchSourceRevision[];
  calendarBlockers: BookingLaunchOwnerBlocker[];
  content: BookingPublicationSnapshotContent["pms"] | null;
};

export function createPmsBookingPublicationSource(dependencies: {
  rooms: RoomPublicationSnapshotPort;
  pricing: Pick<PmsPricingReadPort, "getPricingSourceSnapshot">;
  recurringPricing: Pick<PmsRecurringPricingReadPort, "getRecurringPricingBookingEvidence">;
  operatingCalendar: PmsOperatingCalendarReadPort;
  inventory: PmsInventoryLaunchReadinessReadPort;
  mandatoryChargeConfirmation: BookingMandatoryChargeConfirmationEvidencePort;
  now?: () => Date;
}): BookingLaunchPmsEvidencePort & BookingPublicationOwnerSnapshotPort<"pms"> {
  const now = dependencies.now ?? (() => new Date());
  return {
    bookingLaunchEvidencePort: "pms",
    owner: "pms",
    async getBookingLaunchEvidence(request) {
      try {
        const loaded = await load(dependencies, request, now());
        if (!loaded) return unavailableEvidence();
        return deepFreeze({
          outcome: "evidence",
          port: "pms",
          ...request,
          sources: loaded.sources,
          entities: [
            ...(loaded.rooms.length
              ? loaded.rooms.map(({ source, blockers }) => ({
                  groupId: "booking.rooms" as const,
                  owningStepId: "rooms" as const,
                  source,
                  blockers,
                }))
              : [
                  {
                    groupId: "booking.rooms" as const,
                    owningStepId: "rooms" as const,
                    source: loaded.pricingSource,
                    blockers: [blocker("publishable_room_required")],
                  },
                ]),
            {
              groupId: "booking.pricing",
              owningStepId: "pricing",
              source: loaded.pricingSource,
              blockers: loaded.pricingBlockers,
            },
            {
              groupId: "booking.calendar",
              owningStepId: "calendar",
              source: loaded.calendarSource,
              blockers: loaded.calendarBlockers,
              bindings: loaded.calendarBindings.map((expectedSource) => ({
                expectedSource,
                mismatchBlocker: blocker("operating_calendar_source_stale"),
              })),
            },
          ],
        });
      } catch {
        return unavailableEvidence("system");
      }
    },
    async getSnapshot(request) {
      try {
        const loaded = await load(
          dependencies,
          {
            organizationId: request.organizationId,
            propertyId: request.propertyId,
          },
          now(),
        );
        const expected = request.sourceManifest.sources.filter(
          ({ ownerDomain }) => ownerDomain === "pms",
        );
        if (
          !loaded?.content ||
          allBlockers(loaded).length ||
          sourceKeys(loaded.sources) !== sourceKeys(expected)
        )
          return unavailableSnapshot();
        return deepFreeze({
          outcome: "snapshot",
          contractVersion: BOOKING_OWNER_SNAPSHOT_VERSION,
          owner: "pms",
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          sourceManifestHash: request.sourceManifestHash,
          resolvedSources: loaded.sources,
          content: loaded.content,
        });
      } catch {
        return unavailableSnapshot();
      }
    },
  };
}

async function load(
  dependencies: Parameters<typeof createPmsBookingPublicationSource>[0],
  scope: { organizationId: string; propertyId: string },
  observedAt: Date,
): Promise<LoadedPms | null> {
  const currentCalendar =
    await dependencies.operatingCalendar.getCurrentOperatingCalendarConfiguration(scope.propertyId);
  if (!currentCalendar) return null;
  const currentLocalDate = localDate(
    observedAt,
    currentCalendar.configuration.sourceInputs.propertyTimeZone,
  );
  if (!currentLocalDate) return null;
  const through = addDays(currentLocalDate, 365);
  const [roomPublication, rawPricing, rawRecurring, inventory, confirmation] = await Promise.all([
    dependencies.rooms.getRoomPublicationSnapshot(scope),
    dependencies.pricing.getPricingSourceSnapshot(scope.propertyId),
    dependencies.recurringPricing.getRecurringPricingBookingEvidence(scope.propertyId),
    dependencies.inventory.getInventoryLaunchReadiness({
      propertyId: scope.propertyId,
      requiredCoverage: { from: currentLocalDate, through },
    }),
    dependencies.mandatoryChargeConfirmation.getMandatoryChargeConfirmation(scope),
  ]);
  const pricing = parsePmsPricingSourceSnapshot(rawPricing);
  const recurring = parsePmsRecurringPricingBookingEvidence(rawRecurring);
  if (
    !pricing ||
    !recurring ||
    roomPublication.propertyId !== scope.propertyId ||
    pricing.propertyId !== scope.propertyId ||
    recurring.propertyId !== scope.propertyId
  )
    return null;

  const pricingCurrencySource = requiredPricingSource(
    PMS_PRICING_SOURCE_ENTITY_TYPES.propertyPricingCurrency,
    scope.propertyId,
    pricing.pricingCurrency.pricingCurrencyRevision,
  );
  const roomEntries = roomPublication.rooms.map((room) => ({
    source: pmsSource("pms_room_publication.v1", room.roomTypeId, room.sourceRevision),
    blockers: roomPublication.blockers
      .filter(
        ({ affectedEntity }) =>
          affectedEntity.entityType === "property" || affectedEntity.entityId === room.roomTypeId,
      )
      .map(({ code }) => blocker(code)),
  }));
  const sources: PmsSource[] = [
    pricingCurrencySource,
    requiredPricingSource(
      PMS_PRICING_SOURCE_ENTITY_TYPES.optionalPricingAggregate,
      scope.propertyId,
      recurring.optionalPricingAggregateRevision,
    ),
    ...roomEntries.map(({ source }) => source),
    ...roomPublication.rooms.map((room) =>
      pmsSource(
        "pms_room_facts.v1",
        room.roomTypeId,
        String(room.sourceRevisions.roomFactsRevision),
      ),
    ),
    ...pricing.flexibleRatePlans.map((plan) =>
      requiredPricingSource(
        PMS_PRICING_SOURCE_ENTITY_TYPES.flexibleRatePlan,
        plan.flexibleRatePlanId,
        plan.flexibleRatePlanRevision,
      ),
    ),
    ...recurring.sources.map((item) =>
      requiredPricingSource(
        PMS_PRICING_SOURCE_ENTITY_TYPES.recurringPricingRule,
        item.sourceId,
        item.sourceRevision,
      ),
    ),
    currentCalendar.configuration.source as PmsSource,
  ];
  const pricingBlockers: BookingLaunchOwnerBlocker[] = [];
  const roomIds = new Set(roomPublication.rooms.map(({ roomTypeId }) => roomTypeId));
  const plansByRoom = new Map(pricing.flexibleRatePlans.map((plan) => [plan.roomTypeId, plan]));
  for (const room of roomPublication.rooms) {
    const plan = plansByRoom.get(room.roomTypeId);
    if (!plan) pricingBlockers.push(blocker("flexible_rate_plan_missing"));
    else if (plan.sourceRoomFactsRevision !== room.sourceRevisions.roomFactsRevision)
      pricingBlockers.push(blocker("flexible_rate_plan_room_facts_stale"));
  }
  if (pricing.flexibleRatePlans.some(({ roomTypeId }) => !roomIds.has(roomTypeId)))
    pricingBlockers.push(blocker("flexible_rate_plan_room_mismatch"));
  if (recurring.sources.some(({ lifecycle }) => lifecycle === "invalid"))
    pricingBlockers.push(blocker("optional_source_invalid"));
  const fingerprint = createBookingPricingSourceFingerprint(scope, {
    roomPublication,
    pricing,
    recurringPricing: recurring,
  });
  if (confirmation.outcome !== "available") {
    pricingBlockers.push(blocker(`mandatory_charge_confirmation_${confirmation.outcome}`));
  } else if (confirmation.evidence.pricingSourceFingerprint !== fingerprint) {
    pricingBlockers.push(blocker("mandatory_charge_confirmation_stale"));
  } else {
    sources.push(
      pmsSource(
        "pms_mandatory_charge_confirmation.v1",
        scope.propertyId,
        String(confirmation.evidence.confirmationRevision),
      ),
    );
  }
  const calendarBlockers: BookingLaunchOwnerBlocker[] = [
    ...(inventory?.ready ? [] : [blocker("inventory_launch_readiness_incomplete")]),
    ...(currentCalendar.sourceStatus === "current"
      ? []
      : [blocker("operating_calendar_source_stale")]),
  ];
  const content =
    inventory?.ready && currentCalendar.sourceStatus === "current"
      ? buildPmsBookingPublicationContent({
          rooms: roomPublication.rooms,
          pricing,
          recurring,
          inventory: inventory.snapshot,
          currentLocalDate,
          observedAt: currentCalendar.configuration.updatedAt,
        })
      : null;
  if (inventory?.ready && currentCalendar.sourceStatus === "current" && !content)
    pricingBlockers.push(blocker("public_room_content_incomplete"));
  return {
    sources: uniqueSources(sources),
    rooms: roomEntries,
    pricingSource: pricingCurrencySource,
    pricingBlockers,
    calendarSource: currentCalendar.configuration.source as PmsSource,
    calendarBindings: [currentCalendar.configuration.sourceInputs.propertyProfile],
    calendarBlockers,
    content,
  };
}

const requiredPricingSource = (
  entityType: Parameters<typeof serializePmsPricingSourceEntityRevision>[0],
  entityId: string,
  revision: number,
) => {
  const value = serializePmsPricingSourceEntityRevision(entityType, entityId, revision);
  if (!value) throw new TypeError("PMS pricing source is invalid");
  return value;
};
const pmsSource = (entityType: string, entityId: string, revision: string): PmsSource => ({
  ownerDomain: "pms",
  entityType,
  entityId,
  revision,
});
const blocker = (code: string): BookingLaunchOwnerBlocker => ({
  code,
  scope: "launch_configuration",
  kind: "user_fixable",
});
const uniqueSources = (sources: readonly PmsSource[]) =>
  [...new Map(sources.map((source) => [sourceKey(source), source])).values()].sort((a, b) =>
    sourceKey(a).localeCompare(sourceKey(b)),
  );
const allBlockers = (loaded: LoadedPms) => [
  ...loaded.rooms.flatMap(({ blockers }) => blockers),
  ...loaded.pricingBlockers,
  ...loaded.calendarBlockers,
];
const sourceKeys = (sources: readonly SourceEntityRevision[]) =>
  sources.map(sourceKey).sort().join("\0");
const sourceKey = ({ ownerDomain, entityType, entityId, revision }: SourceEntityRevision) =>
  JSON.stringify([ownerDomain, entityType, entityId, revision]);
const unavailableEvidence = (errorSource: "provider" | "system" = "provider") => ({
  outcome: "unavailable" as const,
  port: "pms" as const,
  errorSource,
});
const unavailableSnapshot = () => ({ outcome: "unavailable" as const, owner: "pms" as const });
const localDate = (date: Date, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(date);
  } catch {
    return null;
  }
};
const addDays = (value: string, count: number) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
