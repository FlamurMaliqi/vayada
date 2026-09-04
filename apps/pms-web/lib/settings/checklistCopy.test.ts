import { describe, expect, it } from "vitest";
import {
  defaultCheckinChecklistSteps,
  localizeBuiltInCheckinStep,
  localizeCheckoutInspectionStep,
} from "./checklistCopy";

const t = (key: string) => `de:${key}`;

describe("localized checklist defaults", () => {
  it("creates check-in defaults in the active language", () => {
    const steps = defaultCheckinChecklistSteps(t);

    expect(steps[0]).toMatchObject({
      id: "default-verify-guest-ids",
      label: "de:settings.checklist.defaults.verifyGuestIds.label",
      prompt: "de:settings.checklist.defaults.verifyGuestIds.prompt",
    });
  });

  it("localizes untouched built-in check-in steps by stable ID", () => {
    const step = localizeBuiltInCheckinStep(
      {
        id: "default-verify-guest-ids",
        label: "Verify guest IDs / passports",
        prompt: "",
        type: "checkbox",
        required: true,
        position: 0,
      },
      t,
    );

    expect(step.label).toBe("de:settings.checklist.defaults.verifyGuestIds.label");
    expect(step.prompt).toBe("de:settings.checklist.defaults.verifyGuestIds.prompt");
  });

  it("preserves user-authored check-in copy", () => {
    const step = localizeBuiltInCheckinStep(
      {
        id: "default-verify-guest-ids",
        label: "Check every travel document",
        prompt: "Use the scanner",
        type: "checkbox",
        required: true,
        position: 0,
      },
      t,
    );

    expect(step.label).toBe("Check every travel document");
    expect(step.prompt).toBe("Use the scanner");
  });

  it("localizes only the untouched checkout helper copy", () => {
    const step = localizeCheckoutInspectionStep(
      {
        id: "damage",
        label: "Inspect damage",
        okLabel: "Looks good",
        negativeLabel: "Issue",
        notePrompt: "Add details...",
        required: true,
        position: 0,
      },
      t,
    );

    expect(step.okLabel).toBe("Looks good");
    expect(step.negativeLabel).toBe("de:settings.inspection.defaults.negativeLabel");
    expect(step.notePrompt).toBe("de:settings.inspection.defaults.notePrompt");
  });
});
