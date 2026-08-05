import type { Page } from "@playwright/test";
import type {
  PropertySetupRouteReadModel,
  PropertySetupRouteStepState,
  PropertySetupStepId,
  SetupTrack,
} from "@vayada/domain-hotels";
import { PROPERTY_SETUP_STEP_DEFINITIONS } from "@vayada/domain-hotels";
import { corsHeaders, fulfillCorsPreflight } from "../marketplace-web/utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

export type PropertySetupRouteMockInput = {
  propertyId: string;
  selectedTracks: SetupTrack[];
  resumeStepId?: PropertySetupStepId | null;
  stepStates?: Partial<Record<PropertySetupStepId, Exclude<PropertySetupRouteStepState, "draft">>>;
  trackRevision?: number;
  sessionRevision?: number;
};

export type PropertySetupRouteMockOptions = {
  failuresBeforeSuccess?: number;
  failureDetail?: string;
  failureStatus?: number;
  failureCode?: string;
};

export function createPropertySetupRouteMock(
  input: PropertySetupRouteMockInput,
): PropertySetupRouteReadModel {
  const stepIds = activeStepIds(input.selectedTracks);
  const steps = stepIds.map((stepId, index) => {
    const state = input.stepStates?.[stepId] ?? "not_started";
    return {
      stepId,
      position: index + 1,
      state,
      sourceRevision: `${stepId}:e2e:1`,
      currentBaseRevisions: Object.fromEntries(
        PROPERTY_SETUP_STEP_DEFINITIONS.find(
          (definition) => definition.stepId === stepId,
        )!.baseRevisionKeys.map((key) => [key, `${stepId}:e2e:1`]),
      ),
      draft: null,
      blockers:
        state === "blocked"
          ? [
              {
                code: `${stepId}_blocked`,
                product: ownerDomainFor(stepId),
                ownerDomain: ownerDomainFor(stepId),
                owningStepId: stepId,
                message: "Finish the required setup before continuing.",
                kind: "user_fixable" as const,
                sourceRevision: `${stepId}:blocker:e2e:1`,
                owningStepPosition: index + 1,
              },
            ]
          : [],
    };
  });
  return {
    contractVersion: "property-setup-route.v2" as const,
    scope: { organizationId, propertyId: input.propertyId },
    selectedTracks: input.selectedTracks,
    trackRevision: input.trackRevision ?? 3,
    sessionId,
    sessionRevision: input.sessionRevision ?? 7,
    resumeStepId: input.resumeStepId ?? null,
    progress: {
      complete: steps.filter(({ state }) => state === "complete").length,
      total: steps.length,
    },
    steps,
  } satisfies PropertySetupRouteReadModel;
}

export async function mockPropertySetupRoute(
  page: Page,
  routeModel: PropertySetupRouteReadModel,
  options: PropertySetupRouteMockOptions = {},
) {
  let requestCount = 0;
  const encodedPropertyId = encodeURIComponent(routeModel.scope.propertyId);
  const pattern = new RegExp(
    `/api/hotel-setup/properties/${escapeRegExp(encodedPropertyId)}/route(?:\\?|$)`,
  );

  await page.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }

    requestCount += 1;
    if (requestCount <= (options.failuresBeforeSuccess ?? 0)) {
      await route.fulfill({
        status: options.failureStatus ?? 503,
        headers: corsHeaders(route),
        json: {
          ...(options.failureCode ? { code: options.failureCode } : {}),
          detail: options.failureDetail ?? "Setup is temporarily unavailable.",
        },
      });
      return;
    }

    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: routeModel,
    });
  });

  return {
    get requestCount() {
      return requestCount;
    },
  };
}

function activeStepIds(selectedTracks: SetupTrack[]): PropertySetupStepId[] {
  const hotelOperations = selectedTracks.includes("hotel_operations");
  const creatorMarketplace = selectedTracks.includes("creator_marketplace");
  return [
    "present_hotel",
    ...(creatorMarketplace ? (["marketplace_preferences"] as const) : []),
    ...(hotelOperations
      ? ([
          "booking_design",
          "rooms",
          "pricing",
          "calendar",
          "guest_experience",
          "payments",
        ] as const)
      : []),
    "review",
  ];
}

function ownerDomainFor(
  stepId: PropertySetupStepId,
): "hotel_catalog" | "marketplace" | "booking" | "pms" | "finance" | "distribution" {
  switch (stepId) {
    case "present_hotel":
    case "review":
      return "hotel_catalog";
    case "marketplace_preferences":
      return "marketplace";
    case "booking_design":
    case "guest_experience":
      return "booking";
    case "rooms":
    case "pricing":
    case "calendar":
      return "pms";
    case "payments":
      return "finance";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
