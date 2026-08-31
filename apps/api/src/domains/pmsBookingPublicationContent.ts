import type { BookingPublicRate } from "@vayada/domain-distribution/booking-publication";
import type { BookingPublicationSnapshotContent } from "@vayada/domain-distribution/booking-publication-owner-snapshots";
import {
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  type PmsInventoryLaunchReadinessReadPort,
  type RoomPublicationRoomSnapshot,
} from "@vayada/domain-pms";

export function buildPmsBookingPublicationContent(input: {
  rooms: readonly RoomPublicationRoomSnapshot[];
  pricing: NonNullable<ReturnType<typeof parsePmsPricingSourceSnapshot>>;
  recurring: NonNullable<ReturnType<typeof parsePmsRecurringPricingBookingEvidence>>;
  inventory: NonNullable<
    Awaited<ReturnType<PmsInventoryLaunchReadinessReadPort["getInventoryLaunchReadiness"]>>
  >["snapshot"];
  currentLocalDate: string;
  observedAt: string;
}): BookingPublicationSnapshotContent["pms"] | null {
  const plans = new Map(input.pricing.flexibleRatePlans.map((plan) => [plan.roomTypeId, plan]));
  const nonRefundable = input.recurring.sources.find(
    (source) => source.sourceKind === "non_refundable" && source.lifecycle === "active",
  );
  const rooms = input.rooms.map((room) => {
    const plan = plans.get(room.roomTypeId);
    if (!plan) return null;
    const images = room.media.flatMap((assignment) => {
      const image = assignment.publicVariants.find(
        ({ variantName }) => variantName === "original_safe",
      );
      return image ? [{ url: image.publicUrl, alt: assignment.altText }] : [];
    });
    const rates: BookingPublicRate[] = [
      {
        ratePlanId: plan.flexibleRatePlanId,
        currency: plan.baseAmount.currency,
        baseNightlyAmount: plan.baseAmount.amountDecimal,
        refundable: true,
        cancellation:
          plan.cancellationTerms.flexibleCancellationType === "partial_refund"
            ? "Partial refund according to notice period"
            : `Free cancellation until ${plan.cancellationTerms.freeCancellationDeadlineDays} days before arrival`,
        paymentTiming: "pay_at_property",
      },
    ];
    if (nonRefundable?.sourceKind === "non_refundable") {
      rates.push({
        ratePlanId: nonRefundable.sourceId,
        currency: plan.baseAmount.currency,
        baseNightlyAmount: discount(plan.baseAmount.amountDecimal, nonRefundable.discountPercent),
        refundable: false,
        cancellation: "Non-refundable",
        paymentTiming: "prepay_full",
      });
    }
    return {
      roomTypeId: room.roomTypeId,
      name: room.facts.name,
      description: room.facts.description,
      category: room.facts.category,
      occupancy: { ...room.facts.occupancy },
      beds: room.facts.beds.map((bed) => ({ ...bed })),
      bedrooms: room.facts.bedrooms,
      bathrooms: room.facts.bathrooms,
      bathroomType: room.facts.bathroomType,
      size: room.facts.size && { ...room.facts.size },
      images,
      amenities: [...(room.amenities ?? [])],
      rates,
    };
  });
  if (rooms.some((room) => room === null)) return null;
  const calendarRevision = input.inventory.configuration.source.revision;
  const observedAt = new Date(input.observedAt).toISOString();
  return {
    availabilityReady: true,
    rooms: rooms as NonNullable<(typeof rooms)[number]>[],
    calendar: {
      sourceRevision: calendarRevision,
      materializedRevision: calendarRevision,
      currentLocalDate: input.currentLocalDate,
      coverageFrom: input.inventory.coverage.coverageFrom,
      coverageThrough: input.inventory.coverage.coverageThrough,
      materializedThrough: input.inventory.coverage.coverageThrough,
      expectedDayCount: input.inventory.coverage.expectedDayCount,
      materializedDayCount: input.inventory.coverage.materializedDayCount,
      gapCount: input.inventory.coverage.gaps.length,
      roomTypeIds: input.inventory.coverage.roomTypeIds,
      observedAt,
    },
    freshness: { status: "fresh", lastUpdatedAt: observedAt },
  };
}

const discount = (amount: string, percent: number) => {
  const cents = Math.round(Number(amount) * 100);
  return (Math.round((cents * (100 - percent)) / 100) / 100).toFixed(2);
};
