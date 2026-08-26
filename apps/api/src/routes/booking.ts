import type { FastifyInstance } from "fastify";
import type {
  PmsInventoryPublicOfferProjectionPort,
  PublicBookabilityPublicationCommandPort,
} from "@vayada/domain-distribution";
import type { BookingAcceptanceSettingsPort } from "../domains/bookingAcceptanceSettings.js";

import {
  registerBookingAddonItemRoutes,
  type BookingAddonItemsRepository,
} from "./bookingAddonItems.js";
import {
  registerBookingPromoCodeRoutes,
  type BookingPromoCodesRepository,
} from "./bookingPromoCodes.js";
import {
  registerBookingDashboardRoutes,
  type BookingDashboardRoutesOptions,
} from "./bookingDashboard.js";
import {
  registerBookingCustomDomainRoutes,
  type BookingCustomDomainRepository,
} from "./bookingCustomDomain.js";
import {
  registerBookingChangeRequestRoutes,
  type BookingHotelChangeRequestRepository,
} from "./bookingChangeRequests.js";
import {
  registerBookingReservationRoutes,
  type BookingReservationsReadRepository,
} from "./bookingReservations.js";
import {
  registerBookingSettingsRoutes,
  type BookingSettingsReadRepository,
  type BookingSettingsWriteRepository,
} from "./bookingSettings.js";
import { enforceRoutePolicy } from "./policy.js";

type BookingHotelParams = {
  hotelId: string;
};

export type BookingRoutesOptions = {
  addonItemsRepository?: BookingAddonItemsRepository;
  promoCodesRepository?: BookingPromoCodesRepository;
  dashboardMetricsReadPort?: BookingDashboardRoutesOptions["metricsReadPort"];
  propertyAccessRepository?: BookingDashboardRoutesOptions["propertyAccessRepository"];
  reservationsRepository?: BookingReservationsReadRepository;
  settingsRepository?: BookingSettingsReadRepository;
  settingsWriteRepository?: BookingSettingsWriteRepository;
  bookingAcceptanceSettings?: BookingAcceptanceSettingsPort;
  publicBookabilityPublisher?: PublicBookabilityPublicationCommandPort;
  inventoryPublicOfferProjector?: PmsInventoryPublicOfferProjectionPort;
  customDomainRepository?: BookingCustomDomainRepository;
  changeRequestRepository?: BookingHotelChangeRequestRepository;
};

export async function registerBookingRoutes(
  app: FastifyInstance,
  options: BookingRoutesOptions = {},
): Promise<void> {
  if (options.addonItemsRepository) {
    await registerBookingAddonItemRoutes(app, options.addonItemsRepository);
  }

  if (options.promoCodesRepository) {
    await registerBookingPromoCodeRoutes(app, options.promoCodesRepository);
  }

  if (options.settingsRepository) {
    await registerBookingSettingsRoutes(
      app,
      options.settingsRepository,
      options.settingsWriteRepository,
      options.publicBookabilityPublisher,
      options.inventoryPublicOfferProjector,
      options.bookingAcceptanceSettings,
    );
  }

  if (options.reservationsRepository) {
    await registerBookingReservationRoutes(app, options.reservationsRepository);
  }

  if (options.dashboardMetricsReadPort) {
    if (!options.propertyAccessRepository) {
      throw new Error("Booking property access repository is required with dashboard metrics");
    }
    await registerBookingDashboardRoutes(app, {
      metricsReadPort: options.dashboardMetricsReadPort,
      propertyAccessRepository: options.propertyAccessRepository,
    });
  }

  if (options.customDomainRepository) {
    await registerBookingCustomDomainRoutes(app, options.customDomainRepository);
  }

  if (options.changeRequestRepository) {
    await registerBookingChangeRequestRoutes(app, options.changeRequestRepository);
  }

  app.get<{ Params: BookingHotelParams }>("/hotels/:hotelId/policy-check", async (request) => {
    const { hotelId } = request.params;

    const context = enforceRoutePolicy(request, {
      permission: "booking.settings.manage",
      entitlement: {
        product: "booking",
        key: "booking-engine",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: hotelId,
        },
      },
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: hotelId,
        allowedRelationships: ["owner", "operator"],
      },
    });

    return {
      group: "booking",
      authorized: true,
      hotelId,
      userId: context.actor.internalUserId,
    };
  });
}
