import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  type PropertySetupRouteStepState,
  type PropertySetupStepId,
} from "@vayada/domain-hotels";

export const ADAPTIVE_SETUP_STEP_IDS = PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId }) => stepId);
export type AdaptiveSetupStepId = PropertySetupStepId;
export type AdaptiveSetupStepState = PropertySetupRouteStepState;

export type AdaptiveSetupNavigationStep = {
  stepId: AdaptiveSetupStepId;
  state: AdaptiveSetupStepState;
};

export type AdaptiveSetupStepCopy = {
  title: string;
  subtitle: string;
};

export const ADAPTIVE_SETUP_STEP_COPY: Readonly<
  Record<AdaptiveSetupStepId, AdaptiveSetupStepCopy>
> = {
  present_hotel: {
    title: "Present your hotel",
    subtitle: "Give guests and creators a clear first impression.",
  },
  marketplace_preferences: {
    title: "Tell creators what you are open to",
    subtitle: "Choose broad preferences. Agree specific terms together in chat.",
  },
  booking_design: {
    title: "Style your booking page",
    subtitle: "Choose a color and typography. Change them anytime.",
  },
  rooms: {
    title: "Add your room types",
    subtitle: "Create one entry for each kind of room or unit guests can book.",
  },
  pricing: {
    title: "Set your room prices",
    subtitle: "Choose the prices and cancellation terms guests will see.",
  },
  calendar: {
    title: "Open your calendar",
    subtitle: "Choose which nights guests can stay and confirm your starting availability.",
  },
  guest_experience: {
    title: "Configure the guest experience",
    subtitle: "Set who can book, what guests enter, and the policies they see.",
  },
  payments: {
    title: "Choose how guests can pay",
    subtitle:
      "Choose one or more methods. You can continue while a payment provider reviews your account.",
  },
  review: {
    title: "Review and launch",
    subtitle: "Check what is ready, then launch each selected product.",
  },
};

export type SupportedInterfaceLocale = "en";
const SUPPORTED_INTERFACE_LOCALES: readonly SupportedInterfaceLocale[] = ["en"];

export type ResolveAdaptiveSetupActiveStepInput<
  TStep extends AdaptiveSetupNavigationStep = AdaptiveSetupNavigationStep,
> = {
  /** Active steps in the exact order returned by the server. */
  steps: readonly TStep[];
  requestedStepId?: string | null;
  resumeStepId?: string | null;
};

/**
 * Chooses a step without reconstructing product or readiness rules in the
 * browser. The server-provided order is authoritative.
 */
export function resolveAdaptiveSetupActiveStep<TStep extends AdaptiveSetupNavigationStep>({
  steps,
  requestedStepId,
  resumeStepId,
}: ResolveAdaptiveSetupActiveStepInput<TStep>): TStep | null {
  const requested = findActiveStep(steps, requestedStepId);
  if (requested) return requested;

  const resume = findActiveStep(steps, resumeStepId);
  if (resume) return resume;

  const firstIncomplete = steps.find(({ state }) => state !== "complete");
  if (firstIncomplete) return firstIncomplete;

  return steps.find(({ stepId }) => stepId === "review") ?? steps.at(-1) ?? null;
}

export function resolvePreviousAdaptiveSetupStep<TStep extends AdaptiveSetupNavigationStep>(
  steps: readonly TStep[],
  activeStepId: string | null | undefined,
): TStep | null {
  if (!activeStepId) return null;

  const activeIndex = steps.findIndex(({ stepId }) => stepId === activeStepId);
  return activeIndex > 0 ? (steps[activeIndex - 1] ?? null) : null;
}

export function resolveNextAdaptiveSetupStep<TStep extends AdaptiveSetupNavigationStep>(
  steps: readonly TStep[],
  activeStepId: string | null | undefined,
): TStep | null {
  if (!activeStepId) return null;

  const activeIndex = steps.findIndex(({ stepId }) => stepId === activeStepId);
  return activeIndex >= 0 ? (steps[activeIndex + 1] ?? null) : null;
}

export function resolveSupportedInterfaceLocale(
  requestedLocale?: string | null,
): SupportedInterfaceLocale {
  const requestedBase = requestedLocale?.trim().split(/[-_]/)[0]?.toLowerCase();
  return (
    SUPPORTED_INTERFACE_LOCALES.find((supportedLocale) => supportedLocale === requestedBase) ?? "en"
  );
}

function findActiveStep<TStep extends AdaptiveSetupNavigationStep>(
  steps: readonly TStep[],
  stepId: string | null | undefined,
): TStep | null {
  if (!stepId) return null;
  return steps.find((step) => step.stepId === stepId) ?? null;
}
