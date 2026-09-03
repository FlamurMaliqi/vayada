import {
  createBookingLaunchReadinessProvider,
  type BookingPublicationAuditContext,
  type BookingPublicationCommandPort,
  type BookingPublicationOperation,
  type BookingDesignReadinessPort,
  type BookingGuestPolicyReadPort,
  type BookingMandatoryChargeConfirmationEvidencePort,
  type ReadyBookingPublicationEvidence,
} from "@vayada/domain-booking";
import { createBookingPublicationBuilder } from "@vayada/domain-distribution/booking-publication-builder";
import type { HotelMediaResolutionPort } from "@vayada/domain-hotels";
import type {
  PmsInventoryLaunchReadinessReadPort,
  PmsOperatingCalendarReadPort,
  PmsPricingReadPort,
  PmsRecurringPricingReadPort,
  RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";
import type { FinancePaymentReadinessReadPort } from "@vayada/domain-finance";

import { createBookingBookingPublicationSource } from "./bookingBookingPublicationSource.js";
import { createPgBookingPublicationAttemptStatusRepository } from "./bookingPublicationAttemptStatusRepository.js";
import { createPgBookingPublicationCommandRepository } from "./bookingPublicationCommandRepository.js";
import {
  createBookingPublicationProjector,
  type BookingPublicationProjector,
} from "./bookingPublicationProjector.js";
import { createPgDistributionBookingPublicationProjection } from "./distributionBookingPublicationProjection.js";
import { createFinanceBookingLaunchEvidenceAdapter } from "./financeBookingLaunchEvidence.js";
import { createFinanceBookingPublicationSnapshotPort } from "./financeBookingPublicationSnapshot.js";
import { createHotelCatalogBookingPublicationSource } from "./hotelCatalogBookingPublicationSource.js";
import { createPmsBookingPublicationSource } from "./pmsBookingPublicationSource.js";

export type BookingPublicationProductionRuntime = {
  routes: {
    repository: ReturnType<typeof createPgBookingPublicationCommandRepository>;
    readinessProvider: ReturnType<typeof createBookingLaunchReadinessProvider>;
  };
  projector: BookingPublicationProjector;
  refresh: BookingPublicationRefreshPort["refresh"];
  close(): Promise<void>;
};

export type BookingPublicationRefreshPort = {
  refresh(input: {
    organizationId: string;
    propertyId: string;
    actorUserId: string;
    idempotencyKey: string;
    audit: BookingPublicationAuditContext;
  }): Promise<BookingPublicationOperation>;
};

type BookingPublicationRefreshDependencies = {
  readinessProvider: Pick<
    ReturnType<typeof createBookingLaunchReadinessProvider>,
    "getBookingReadiness"
  >;
  projection: Pick<
    ReturnType<typeof createPgDistributionBookingPublicationProjection>,
    "getActive"
  >;
  repository: Pick<BookingPublicationCommandPort, "requestPublication" | "getPublicationStatus">;
  projector: Pick<BookingPublicationProjector, "projectPending">;
};

export function createBookingPublicationRefresh(
  dependencies: BookingPublicationRefreshDependencies,
): BookingPublicationRefreshPort["refresh"] {
  return async (input) => {
    const readiness = await dependencies.readinessProvider.getBookingReadiness({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
    });
    if (
      readiness.outcome !== "evaluated" ||
      readiness.product !== "booking" ||
      readiness.status !== "ready"
    ) {
      throw new Error("Booking publication readiness is incomplete.");
    }
    const active = await dependencies.projection.getActive(input.propertyId);
    const requested = await dependencies.repository.requestPublication({
      ...input,
      expectedActiveContentRevisionId: active?.revisionId ?? null,
      readiness: readiness as ReadyBookingPublicationEvidence,
    });
    if (!requested.ok) {
      throw new Error(`Booking publication refresh failed: ${requested.error.code}.`);
    }
    await dependencies.projector.projectPending({ propertyId: input.propertyId });
    const operation = await dependencies.repository.getPublicationStatus({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      operationId: requested.operation.operationId,
      actorUserId: input.actorUserId,
    });
    if (!operation || operation.status === "failed" || operation.status === "unknown") {
      throw new Error("Booking publication refresh did not complete.");
    }
    return operation;
  };
}

export type BookingPublicationWorker = { close(): Promise<void> };

export function startBookingPublicationWorker(config: {
  projector: BookingPublicationProjector;
  workerId: string;
  warn(error: unknown, message: string): void;
  intervalMs?: number;
}): BookingPublicationWorker {
  let active: Promise<void> | undefined;
  let closed = false;
  const run = () => {
    if (closed || active) return;
    active = config.projector
      .runRetryBatch({ workerId: config.workerId })
      .then(({ failed, exhausted }) => {
        if (failed > 0) {
          config.warn({ failed, exhausted }, "Booking publication worker completed with failures");
        }
      })
      .catch((error: unknown) => config.warn({ err: error }, "Booking publication worker failed"))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(run, config.intervalMs ?? 30_000);
  timer.unref();
  run();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}

export function createBookingPublicationProductionRuntime(config: {
  connectionString: string;
  bookingHostBase?: string;
  mediaResolver: HotelMediaResolutionPort;
  design: BookingDesignReadinessPort;
  guestPolicy: Pick<BookingGuestPolicyReadPort, "getCurrentGuestPolicy">;
  rooms: RoomPublicationSnapshotPort;
  pricing: Pick<PmsPricingReadPort, "getPricingSourceSnapshot">;
  recurringPricing: Pick<PmsRecurringPricingReadPort, "getRecurringPricingBookingEvidence">;
  operatingCalendar: PmsOperatingCalendarReadPort;
  inventory: PmsInventoryLaunchReadinessReadPort;
  mandatoryChargeConfirmation: BookingMandatoryChargeConfirmationEvidencePort;
  finance: FinancePaymentReadinessReadPort;
}): BookingPublicationProductionRuntime {
  const catalog = createHotelCatalogBookingPublicationSource({
    connectionString: config.connectionString,
    mediaResolver: config.mediaResolver,
  });
  const booking = createBookingBookingPublicationSource({
    connectionString: config.connectionString,
    design: config.design,
    guestPolicy: config.guestPolicy,
  });
  const pms = createPmsBookingPublicationSource({
    rooms: config.rooms,
    pricing: config.pricing,
    recurringPricing: config.recurringPricing,
    operatingCalendar: config.operatingCalendar,
    inventory: config.inventory,
    mandatoryChargeConfirmation: config.mandatoryChargeConfirmation,
  });
  const financeEvidence = createFinanceBookingLaunchEvidenceAdapter({
    financeReadPort: config.finance,
  });
  const financeSnapshot = createFinanceBookingPublicationSnapshotPort({
    financeReadPort: config.finance,
  });
  const readinessProvider = createBookingLaunchReadinessProvider({
    catalog,
    booking,
    pms,
    finance: financeEvidence,
  });
  const builder = createBookingPublicationBuilder({
    catalog,
    booking,
    pms,
    finance: financeSnapshot,
    bookingWeb: ({ slug, customDomainUrl, domainVerified }) => {
      const custom = domainVerified ? safeOrigin(customDomainUrl) : null;
      const bookingBaseUrl = custom ?? fallbackBookingBaseUrl(slug, config.bookingHostBase);
      return {
        canonicalUrl: bookingBaseUrl,
        bookingBaseUrl,
        customDomainUrl: custom,
        domainVerified: Boolean(custom),
        bookingDeepLinks: true,
      };
    },
  });
  const projection = createPgDistributionBookingPublicationProjection({
    connectionString: config.connectionString,
  });
  const attempts = createPgBookingPublicationAttemptStatusRepository({
    connectionString: config.connectionString,
  });
  const repository = createPgBookingPublicationCommandRepository({
    connectionString: config.connectionString,
    activeContent: projection,
  });
  const projector = createBookingPublicationProjector({
    connectionString: config.connectionString,
    projection,
    attempts,
    readiness: readinessProvider,
    builder,
  });
  const refresh = createBookingPublicationRefresh({
    readinessProvider,
    projection,
    repository,
    projector,
  });
  return {
    routes: { repository, readinessProvider },
    projector,
    refresh,
    async close() {
      await Promise.all([
        projector.close?.(),
        projection.close?.(),
        attempts.close?.(),
        catalog.close(),
        booking.close(),
      ]);
    },
  };
}

function fallbackBookingBaseUrl(slug: string, input = "booking.vayada.com"): string {
  const host = input
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  return `https://${slug}.${host || "booking.vayada.com"}`;
}

function safeOrigin(input: string | null): string | null {
  try {
    if (!input) return null;
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}
