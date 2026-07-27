import type { SetupTaskId } from "@vayada/product-onboarding";

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

export function resolveBookingSetupTaskDestination(input: {
  taskId: string | null;
  destinationRouteKey: string | null;
  planRevision?: string | null;
  returnUrl?: string | null;
}): string | null {
  const taskId = input.taskId?.trim();
  const destinationRouteKey = input.destinationRouteKey?.trim();
  if (!taskId || !destinationRouteKey) return null;

  const destination =
    BOOKING_SETUP_TASK_DESTINATIONS[taskId as keyof typeof BOOKING_SETUP_TASK_DESTINATIONS];
  if (!destination || destination.destinationRouteKey !== destinationRouteKey) return null;

  const query = new URLSearchParams({
    taskId,
    destinationRouteKey,
  });
  const planRevision = input.planRevision?.trim();
  if (planRevision) query.set("planRevision", planRevision);
  const returnUrl = input.returnUrl?.trim();
  if (returnUrl) query.set("returnUrl", returnUrl);
  return `${destination.pathname}?${query.toString()}`;
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
