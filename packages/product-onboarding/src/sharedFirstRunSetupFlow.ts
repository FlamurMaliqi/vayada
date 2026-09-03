import {
  isSetupTaskLaunchable,
  PRODUCT_ENTRY_PRODUCTS,
  type AdaptiveHotelSetupStatus,
  type ProductEntryDecision,
  type PropertySetupPlan,
  type SetupComponentProduct,
  type SetupTask,
  type SetupTrack,
} from "@vayada/domain-hotels";

import { isSafeRelativeReturnTo } from "./returnTo";

export type SharedHotelSetupEntryProduct = ProductEntryDecision["requestedProduct"];

export function parseSharedHotelSetupEntryProduct(
  value: string | null | undefined,
): SharedHotelSetupEntryProduct | null {
  return PRODUCT_ENTRY_PRODUCTS.includes(value as SetupComponentProduct)
    ? (value as SharedHotelSetupEntryProduct)
    : null;
}

export function isSafeSharedHotelSetupReturnTo(value: string | null | undefined): value is string {
  return isSafeRelativeReturnTo(value);
}

export function safeSharedHotelSetupReturnTo(
  value: string | null | undefined,
  fallback: string,
): string {
  return isSafeSharedHotelSetupReturnTo(value) ? value : fallback;
}

export type SharedSetupProperty =
  AdaptiveHotelSetupStatus["propertySelection"]["availableProperties"][number];

export type SharedFirstRunSetupScreen =
  | "loading"
  | "track_selection"
  | "property_profile"
  | "property_selection"
  | "setup_plan";

export type SharedFirstRunSetupViewModel = {
  screen: SharedFirstRunSetupScreen;
  profileMode: "create" | "update" | null;
  selectedPropertyId: string | null;
  selectedProperty: SharedSetupProperty | null;
  setupPlan: PropertySetupPlan | null;
  title: string;
};

export function resolveSharedFirstRunSetupView(
  status: AdaptiveHotelSetupStatus | null,
  options: {
    forceCreateProperty?: boolean;
    forceTrackSelection?: boolean;
    editPropertyProfile?: boolean;
  } = {},
): SharedFirstRunSetupViewModel {
  if (!status) return emptyView("loading", "Loading setup");

  if (status.organization.selectedTracks.length === 0 || options.forceTrackSelection) {
    return emptyView("track_selection", "Choose how you’ll use vayada");
  }

  if (options.forceCreateProperty || status.propertySelection.state === "no_property") {
    return {
      ...emptyView(
        "property_profile",
        status.propertySelection.availableProperties.length === 0
          ? "Let’s get to know your hotel"
          : "Let’s get to know this hotel",
      ),
      profileMode: "create",
    };
  }

  if (
    status.propertySelection.state === "multiple_properties" &&
    status.propertySelection.selectedPropertyId === null
  ) {
    return emptyView("property_selection", "Choose hotel");
  }

  const selectedPropertyId = status.propertySelection.selectedPropertyId;
  const selectedProperty = selectedPropertyId
    ? (status.propertySelection.availableProperties.find(
        (property) => property.propertyId === selectedPropertyId,
      ) ?? null)
    : null;
  const sharedIdentity = status.setupPlan?.tasks.find(({ taskId }) => taskId === "shared_identity");
  if (
    selectedPropertyId &&
    (options.editPropertyProfile ||
      (sharedIdentity?.ownerProgress !== "owner_complete" &&
        sharedIdentity?.readiness === "actionable" &&
        sharedIdentity.callerCapability === "allowed"))
  ) {
    return {
      screen: "property_profile",
      profileMode: "update",
      selectedPropertyId,
      selectedProperty,
      setupPlan: status.setupPlan,
      title: selectedProperty?.displayName ?? "Complete hotel basics",
    };
  }

  return {
    screen: "setup_plan",
    profileMode: null,
    selectedPropertyId,
    selectedProperty,
    setupPlan: status.setupPlan,
    title: "Set up your hotel",
  };
}

export function toggleSetupTrackSelection(
  selectedTracks: readonly SetupTrack[],
  lockedTracks: readonly SetupTrack[],
  track: SetupTrack,
): SetupTrack[] {
  if (lockedTracks.includes(track)) return [...selectedTracks];
  const next = selectedTracks.includes(track)
    ? selectedTracks.filter((candidate) => candidate !== track)
    : [...selectedTracks, track];
  return (["hotel_operations", "creator_marketplace"] as const).filter((candidate) =>
    next.includes(candidate),
  );
}

export function isSetupTaskActionable(
  task: Pick<SetupTask, "track" | "readiness" | "callerCapability">,
): boolean {
  return isSetupTaskLaunchable(task);
}

function emptyView(screen: SharedFirstRunSetupScreen, title: string): SharedFirstRunSetupViewModel {
  return {
    screen,
    profileMode: null,
    selectedPropertyId: null,
    selectedProperty: null,
    setupPlan: null,
    title,
  };
}
