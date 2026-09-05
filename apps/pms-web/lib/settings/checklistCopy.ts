import type { CheckinChecklistStep, CheckoutInspectionStep } from "@/services/settings";

type Translate = (key: string) => string;

const CHECKIN_DEFAULTS = [
  {
    id: "default-verify-guest-ids",
    label: "Verify guest IDs / passports",
    prompt: "Confirm passport or ID details are captured for every guest.",
    labelKey: "settings.checklist.defaults.verifyGuestIds.label",
    promptKey: "settings.checklist.defaults.verifyGuestIds.prompt",
  },
  {
    id: "default-confirm-payment-status",
    label: "Confirm payment / deposit status",
    prompt: "Confirm the deposit, balance, or pay-at-property status before handover.",
    labelKey: "settings.checklist.defaults.confirmPayment.label",
    promptKey: "settings.checklist.defaults.confirmPayment.prompt",
  },
  {
    id: "default-room-access",
    label: "Assign room & hand over keys/access",
    prompt: "Make sure the guest has their room assignment and access instructions.",
    labelKey: "settings.checklist.defaults.roomAccess.label",
    promptKey: "settings.checklist.defaults.roomAccess.prompt",
  },
] as const;

export function defaultCheckinChecklistSteps(): CheckinChecklistStep[] {
  return CHECKIN_DEFAULTS.map((step, position) => ({
    id: step.id,
    label: step.label,
    prompt: step.prompt,
    type: "checkbox",
    required: true,
    system: false,
    position,
  }));
}

export function localizeBuiltInCheckinStep(
  step: CheckinChecklistStep,
  t: Translate,
): CheckinChecklistStep {
  const defaultStep = CHECKIN_DEFAULTS.find((candidate) => candidate.id === step.id);
  // The persisted ID establishes built-in identity; canonical copy means the user has not edited it.
  if (!defaultStep || step.label !== defaultStep.label) return step;

  return {
    ...step,
    label: t(defaultStep.labelKey),
    prompt:
      !step.prompt || step.prompt === defaultStep.prompt ? t(defaultStep.promptKey) : step.prompt,
  };
}

export function localizeCheckoutInspectionStep(
  step: CheckoutInspectionStep,
  t: Translate,
): CheckoutInspectionStep {
  return {
    ...step,
    okLabel: step.okLabel === "OK" ? t("settings.inspection.defaults.okLabel") : step.okLabel,
    negativeLabel:
      step.negativeLabel === "Issue"
        ? t("settings.inspection.defaults.negativeLabel")
        : step.negativeLabel,
    notePrompt:
      step.notePrompt === "Add details..."
        ? t("settings.inspection.defaults.notePrompt")
        : step.notePrompt,
  };
}
