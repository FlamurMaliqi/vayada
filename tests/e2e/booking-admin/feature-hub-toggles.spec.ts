import { featureHubToggleChecks } from "../support/featureHubToggleChecks";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

featureHubToggleChecks(
  BOOKING_ADMIN_PROPERTY_ID,
  async (page) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
  },
  true,
  "Could not update module activation.",
);
