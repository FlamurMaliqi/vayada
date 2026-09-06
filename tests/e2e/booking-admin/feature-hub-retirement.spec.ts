import { featureHubRetirementChecks } from "../support/featureHubRetirementChecks";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

featureHubRetirementChecks(BOOKING_ADMIN_PROPERTY_ID, async (page) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});
