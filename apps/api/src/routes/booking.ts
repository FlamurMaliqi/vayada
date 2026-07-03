import type { FastifyInstance } from "fastify";

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
  reservationsRepository?: BookingReservationsReadRepository;
  settingsRepository?: BookingSettingsReadRepository;
  settingsWriteRepository?: BookingSettingsWriteRepository;
  customDomainRepository?: BookingCustomDomainRepository;
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
    );
  }

  if (options.reservationsRepository) {
    await registerBookingReservationRoutes(app, options.reservationsRepository);
  }

  if (options.dashboardMetricsReadPort) {
    await registerBookingDashboardRoutes(app, {
      metricsReadPort: options.dashboardMetricsReadPort,
    });
  }

  if (options.customDomainRepository) {
    await registerBookingCustomDomainRoutes(app, options.customDomainRepository);
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
