import { featureHubToggleChecks } from "../support/featureHubToggleChecks";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

featureHubToggleChecks(
  PMS_WEB_PROPERTY_ID,
  async (page) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
  },
  false,
);
