import type {
  AdaptiveHotelSetupStatus,
  ProductEntryDecision,
  SetupComponentProduct,
  SetupTask,
  SetupTaskId,
  SetupTrack,
  TrackStatus,
} from "@vayada/domain-hotels";

type AdaptiveHotelSetupStatusMockInput = {
  entryProduct: ProductEntryDecision["requestedProduct"];
  organizationId: string;
  organizationDisplayName: string;
  selectedTracks?: SetupTrack[];
  trackRevision?: number;
  propertyId?: string | null;
  publicId?: string;
  propertyDisplayName?: string | null;
  locationSummary?: string | null;
  entryDecision?: Partial<ProductEntryDecision> | null;
  componentAccess?: Partial<
    Record<SetupComponentProduct, TrackStatus["components"][number]["access"]>
  >;
  trackProvisioning?: Partial<Record<SetupTrack, TrackStatus["provisioning"]>>;
  taskOverrides?: Partial<Record<SetupTaskId, Partial<SetupTask>>>;
  recommendedTaskId?: SetupTaskId | null;
  updatedAt?: string;
};

const TASK_DEFINITIONS: Array<
  Pick<SetupTask, "taskId" | "track" | "requirementOwnerDomain" | "destinationRouteKey">
> = [
  {
    taskId: "shared_identity",
    track: "shared",
    requirementOwnerDomain: "hotel_catalog",
    destinationRouteKey: "hotel_catalog.shared_identity",
  },
  {
    taskId: "public_profile",
    track: "creator_marketplace",
    requirementOwnerDomain: "hotel_catalog",
    destinationRouteKey: "hotel_catalog.public_profile",
  },
  {
    taskId: "creator_offer",
    track: "creator_marketplace",
    requirementOwnerDomain: "marketplace",
    destinationRouteKey: "marketplace.creator_offer",
  },
  {
    taskId: "rooms_rates_availability",
    track: "hotel_operations",
    requirementOwnerDomain: "pms",
    destinationRouteKey: "pms.rooms_rates_availability",
  },
  {
    taskId: "guest_settings_policies",
    track: "hotel_operations",
    requirementOwnerDomain: "booking",
    destinationRouteKey: "booking.guest_settings_policies",
  },
  {
    taskId: "billing_plan",
    track: "hotel_operations",
    requirementOwnerDomain: "finance",
    destinationRouteKey: "finance.billing_plan",
  },
  {
    taskId: "payment",
    track: "hotel_operations",
    requirementOwnerDomain: "finance",
    destinationRouteKey: "finance.payment",
  },
  {
    taskId: "direct_booking_publication",
    track: "hotel_operations",
    requirementOwnerDomain: "distribution",
    destinationRouteKey: "distribution.direct_booking_publication",
  },
];

export function createAdaptiveHotelSetupStatusMock(
  input: AdaptiveHotelSetupStatusMockInput,
): AdaptiveHotelSetupStatus {
  const selectedTracks = canonicalTracks(input.selectedTracks ?? defaultTracks(input.entryProduct));
  const propertyId = input.propertyId === undefined ? "property-e2e" : input.propertyId;
  const selectedProperty =
    propertyId === null
      ? null
      : {
          propertyId,
          publicId: input.publicId ?? "public-property-e2e",
          displayName: input.propertyDisplayName ?? "Alpenrose Hotel",
          locationSummary: input.locationSummary ?? "Munich, DE",
        };
  const tasks =
    selectedProperty === null
      ? []
      : TASK_DEFINITIONS.filter(
          ({ track }) =>
            (track === "shared" && selectedTracks.length > 0) ||
            (track !== "shared" && selectedTracks.includes(track)),
        ).map((definition) =>
          adaptiveSetupTask(
            definition.taskId,
            selectedProperty.propertyId,
            input.taskOverrides?.[definition.taskId],
          ),
        );
  const recommendedTaskId =
    input.recommendedTaskId === undefined
      ? (tasks.find(
          ({ readiness, callerCapability }) =>
            readiness === "actionable" && callerCapability === "allowed",
        )?.taskId ?? null)
      : input.recommendedTaskId;
  const launchReadiness = {
    operationsUse: setupLaunchReadiness(selectedTracks, tasks, "hotel_operations", [
      "shared_identity",
      "rooms_rates_availability",
    ]),
    directBookingPublish: setupLaunchReadiness(selectedTracks, tasks, "hotel_operations", [
      "shared_identity",
      "rooms_rates_availability",
      "guest_settings_policies",
      "billing_plan",
      "payment",
      "direct_booking_publication",
    ]),
    marketplacePublish: setupLaunchReadiness(selectedTracks, tasks, "creator_marketplace", [
      "shared_identity",
      "public_profile",
      "creator_offer",
    ]),
  } as const;
  const defaultDecision: ProductEntryDecision =
    selectedProperty === null
      ? {
          requestedProduct: input.entryProduct,
          propertyId: null,
          decision: "setup_required",
          destinationRouteKey: "hotel_setup",
          reasonCode: "property_selection_required",
        }
      : {
          requestedProduct: input.entryProduct,
          propertyId: selectedProperty.propertyId,
          decision: "enter",
          destinationRouteKey: `${input.entryProduct}.workspace`,
          reasonCode: null,
        };

  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: input.organizationId,
      displayName: input.organizationDisplayName,
      websiteUrl: null,
      selectedTracks,
      trackRevision: input.trackRevision ?? 1,
      canManageTracks: true,
      tracks: [
        trackStatus(
          "hotel_operations",
          selectedTracks,
          input.componentAccess,
          input.trackProvisioning,
        ),
        trackStatus(
          "creator_marketplace",
          selectedTracks,
          input.componentAccess,
          input.trackProvisioning,
        ),
      ],
    },
    propertySelection:
      selectedProperty === null
        ? {
            state: "no_property",
            selectedPropertyId: null,
            availableProperties: [],
          }
        : {
            state: "single_property",
            selectedPropertyId: selectedProperty.propertyId,
            availableProperties: [selectedProperty],
          },
    entryDecision:
      input.entryDecision === null
        ? null
        : {
            ...defaultDecision,
            ...input.entryDecision,
          },
    setupPlan:
      selectedProperty === null
        ? null
        : {
            propertyId: selectedProperty.propertyId,
            planRevision: "e2e-plan-1",
            tasks,
            recommendedTaskId,
            ownerProgress: {
              complete: tasks.filter(({ ownerProgress }) => ownerProgress === "owner_complete")
                .length,
              total: tasks.length,
            },
            launchReadiness,
          },
    updatedAt: input.updatedAt ?? "2026-06-30T00:00:00.000Z",
  };
}

export function adaptiveSetupTask(
  taskId: SetupTaskId,
  propertyId: string,
  overrides: Partial<SetupTask> = {},
): SetupTask {
  const definition = TASK_DEFINITIONS.find((candidate) => candidate.taskId === taskId);
  if (!definition) throw new Error(`Unknown adaptive setup task: ${taskId}`);
  return {
    ...definition,
    propertyId,
    callerCapability: "allowed",
    ownerProgress: "owner_complete",
    readiness: "complete",
    actionableBy: null,
    reasonCodes: [],
    sourceRevision: `${taskId}-e2e-1`,
    freshness: "fresh",
    evaluatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function defaultTracks(entryProduct: ProductEntryDecision["requestedProduct"]): SetupTrack[] {
  return entryProduct === "marketplace" ? ["creator_marketplace"] : ["hotel_operations"];
}

function canonicalTracks(tracks: readonly SetupTrack[]): SetupTrack[] {
  return (["hotel_operations", "creator_marketplace"] as const).filter((track) =>
    tracks.includes(track),
  );
}

function setupLaunchReadiness(
  selectedTracks: readonly SetupTrack[],
  tasks: readonly SetupTask[],
  track: SetupTrack,
  taskIds: readonly SetupTaskId[],
): "not_applicable" | "pending" | "ready" | "blocked" {
  if (!selectedTracks.includes(track)) return "not_applicable";

  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const required = taskIds.map((taskId) => byId.get(taskId));
  if (required.some((task) => !task)) return "blocked";
  if (
    required.some(
      (task) =>
        task?.readiness === "rejected" ||
        task?.reasonCodes.includes("domain_readiness_blocked") ||
        task?.reasonCodes.includes("task_product_access_blocked"),
    )
  ) {
    return "blocked";
  }
  return required.every((task) => task?.readiness === "complete" && task.freshness === "fresh")
    ? "ready"
    : "pending";
}

function trackStatus(
  track: SetupTrack,
  selectedTracks: readonly SetupTrack[],
  componentAccess: AdaptiveHotelSetupStatusMockInput["componentAccess"],
  trackProvisioning: AdaptiveHotelSetupStatusMockInput["trackProvisioning"],
): TrackStatus {
  const selected = selectedTracks.includes(track);
  const componentNames =
    track === "hotel_operations" ? (["pms", "booking"] as const) : (["marketplace"] as const);
  const components = componentNames.map((product) => ({
    product,
    access: componentAccess?.[product] ?? (selected ? "active" : "absent"),
  }));
  return {
    track,
    provisioning:
      trackProvisioning?.[track] ??
      (selected
        ? components.every(({ access }) => access === "active")
          ? "active"
          : "blocked"
        : "not_selected"),
    components,
    allowedActions: selected ? ["manage_service"] : ["add"],
  };
}
