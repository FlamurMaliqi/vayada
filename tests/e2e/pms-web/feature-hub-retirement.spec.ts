import { featureHubRetirementChecks } from "../support/featureHubRetirementChecks";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

featureHubRetirementChecks(PMS_WEB_PROPERTY_ID, async (page) => {
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
});
