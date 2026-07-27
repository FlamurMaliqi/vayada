import type { SetupTaskId } from "@vayada/product-onboarding";
import { canonicalSetupReturnUrl } from "@vayada/product-onboarding/returnTo";

type BookingSetupTaskDestination = {
  destinationRouteKey: string;
  pathname: "/settings" | "/design-studio";
  settingsSection: "booking" | "payments" | null;
};

const BOOKING_SETUP_TASK_DESTINATIONS = {
  guest_settings_policies: {
    destinationRouteKey: "booking.guest_settings_policies",
    pathname: "/settings",
    settingsSection: "booking",
  },
  payment: {
    destinationRouteKey: "finance.payment",
    pathname: "/settings",
    settingsSection: "payments",
  },
  direct_booking_publication: {
    destinationRouteKey: "distribution.direct_booking_publication",
    pathname: "/design-studio",
    settingsSection: null,
  },
} as const satisfies Partial<Record<SetupTaskId, BookingSetupTaskDestination>>;

export type BookingSetupTaskContext = {
  taskId: keyof typeof BOOKING_SETUP_TASK_DESTINATIONS;
  returnUrl: string;
  settingsSection: BookingSetupTaskDestination["settingsSection"];
};

type SetupTaskSearchParams = Pick<URLSearchParams, "forEach" | "get" | "getAll">;
type PropertySelectionStorage = Pick<Storage, "getItem">;

const SETUP_CONTEXT_KEYS = ["taskId", "destinationRouteKey", "planRevision", "returnUrl"] as const;
const SELECTED_SHARED_PROPERTY_ID_KEY = "selectedSharedPropertyId";

export function resolveBookingSetupTaskDestination(input: {
  propertyId: string;
  taskId: string | null;
  destinationRouteKey: string | null;
  planRevision: string | null;
  returnUrl: string | null;
  marketplaceOrigin: string;
}): string | null {
  const propertyId = input.propertyId.trim();
  const taskId = input.taskId?.trim();
  const destinationRouteKey = input.destinationRouteKey?.trim();
  const planRevision = input.planRevision?.trim();
  if (!propertyId || !taskId || !destinationRouteKey || !planRevision || !input.returnUrl) {
    return null;
  }

  const destination =
    BOOKING_SETUP_TASK_DESTINATIONS[taskId as keyof typeof BOOKING_SETUP_TASK_DESTINATIONS];
  if (!destination || destination.destinationRouteKey !== destinationRouteKey) return null;

  const returnUrl = canonicalSetupReturnUrl(input.returnUrl, propertyId, input.marketplaceOrigin);
  if (!returnUrl) return null;

  const query = new URLSearchParams();
  if (destination.settingsSection) query.set("section", destination.settingsSection);
  query.set("taskId", taskId);
  query.set("destinationRouteKey", destinationRouteKey);
  query.set("planRevision", planRevision);
  query.set("returnUrl", returnUrl);
  return `${destination.pathname}?${query.toString()}`;
}

export function parseBookingSetupTaskContext(
  params: SetupTaskSearchParams,
  storage: PropertySelectionStorage | null,
  marketplaceOrigin: string,
  expectedPathname: BookingSetupTaskDestination["pathname"],
): BookingSetupTaskContext | null {
  const rawTaskId = params.get("taskId") ?? "";
  const rawDestinationRouteKey = params.get("destinationRouteKey") ?? "";
  const rawPlanRevision = params.get("planRevision") ?? "";
  const taskId = rawTaskId.trim();
  const destinationRouteKey = rawDestinationRouteKey.trim();
  const planRevision = rawPlanRevision.trim();
  const destination =
    BOOKING_SETUP_TASK_DESTINATIONS[taskId as keyof typeof BOOKING_SETUP_TASK_DESTINATIONS];
  if (
    !taskId ||
    !destinationRouteKey ||
    !planRevision ||
    taskId !== rawTaskId ||
    destinationRouteKey !== rawDestinationRouteKey ||
    planRevision !== rawPlanRevision ||
    !destination ||
    destination.destinationRouteKey !== destinationRouteKey ||
    destination.pathname !== expectedPathname
  ) {
    return null;
  }

  const allowedKeys = destination.settingsSection
    ? [...SETUP_CONTEXT_KEYS, "section"]
    : [...SETUP_CONTEXT_KEYS];
  const allowedKeySet = new Set<string>(allowedKeys);
  let invalidKey = false;
  params.forEach((_, key) => {
    if (!allowedKeySet.has(key) || params.getAll(key).length !== 1) invalidKey = true;
  });
  if (
    invalidKey ||
    allowedKeys.some((key) => params.getAll(key).length !== 1) ||
    (destination.settingsSection
      ? params.get("section") !== destination.settingsSection
      : params.getAll("section").length > 0)
  ) {
    return null;
  }

  const propertyId = storage?.getItem(SELECTED_SHARED_PROPERTY_ID_KEY)?.trim() ?? "";
  const returnUrlValue = params.get("returnUrl") ?? "";
  const returnUrl = propertyId
    ? canonicalSetupReturnUrl(returnUrlValue, propertyId, marketplaceOrigin)
    : null;
  if (!propertyId || !returnUrl) return null;

  return {
    taskId: taskId as keyof typeof BOOKING_SETUP_TASK_DESTINATIONS,
    returnUrl,
    settingsSection: destination.settingsSection,
  };
}

export function hasBookingSetupTaskContext(params: SetupTaskSearchParams): boolean {
  return SETUP_CONTEXT_KEYS.some((key) => params.getAll(key).length > 0);
}

export function bookingSettingsSectionForSetupTask(
  taskId: string | null,
  destinationRouteKey: string | null,
): "booking" | "payments" | null {
  const destination =
    BOOKING_SETUP_TASK_DESTINATIONS[taskId?.trim() as keyof typeof BOOKING_SETUP_TASK_DESTINATIONS];
  if (
    !destination ||
    destination.destinationRouteKey !== destinationRouteKey?.trim() ||
    !destination.settingsSection
  ) {
    return null;
  }
  return destination.settingsSection;
}
