import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type {
  PropertySetupRouteReadModel,
  PropertySetupStepDraft,
  SavePropertySetupDraftReceipt,
} from "@vayada/domain-hotels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PricingCanonicalWorkspace } from "./pricingState";

const mocks = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  saveDraft: vi.fn(),
  saveCanonical: vi.fn(),
}));

vi.mock("@/services/api/pricingSetupClient", async () => ({
  ...(await vi.importActual<typeof import("@/services/api/pricingSetupClient")>(
    "@/services/api/pricingSetupClient",
  )),
  pricingSetupApi: mocks,
}));

import { PricingOwnerError } from "@/services/api/pricingSetupClient";
import { PricingStep } from "./PricingStep";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomTypeId = "33333333-3333-4333-8333-333333333333";

describe("PricingStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadWorkspace.mockResolvedValue(workspace());
    mocks.saveDraft.mockResolvedValue(draftReceipt());
    mocks.saveCanonical.mockResolvedValue(workspace());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fails closed without the exact manifest", async () => {
    const route = pricingRoute(null);
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PricingStep, controller.props));
    });

    expect(JSON.stringify(renderer?.toJSON())).toContain("Setup data is still unavailable");
    expect(button(renderer!.root, "Save draft").props.disabled).toBe(true);
    expect(button(renderer!.root, "Save and continue").props.disabled).toBe(true);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it("keeps canonical pricing fail-closed without currency capabilities but saves incomplete draft input", async () => {
    mocks.loadWorkspace.mockResolvedValue(workspace(false));
    const route = pricingRoute(emptyPricingDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PricingStep, controller.props));
    });
    expect(JSON.stringify(renderer?.toJSON())).toContain("Currency setup is unavailable");
    expect(button(renderer!.root, "Save and continue").props.disabled).toBe(true);

    await act(async () => {
      input(renderer!.root, `base-${roomTypeId}`).props.onChange({ target: { value: "125.50" } });
    });
    await act(async () => {
      button(renderer!.root, "Save draft").props.onClick();
      await Promise.resolve();
    });

    expect(mocks.saveDraft).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        stepId: "pricing",
        expectedBaseRevisions: exactManifest,
        payload: expect.objectContaining({
          "rate.base_nightly_rate": { [roomTypeId]: "125.50" },
        }),
      }),
    );
    expect(mocks.saveCanonical).not.toHaveBeenCalled();
    expect(controller.beforeLeave).toBeTypeOf("function");
    await act(async () => renderer?.unmount());
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("serializes saves, retains mid-save edits, and advances receipt revisions", async () => {
    const firstSave = deferred<SavePropertySetupDraftReceipt>();
    mocks.saveDraft
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(draftReceipt({ sessionRevision: 9, draftRevision: 6 }));
    const route = pricingRoute(emptyPricingDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PricingStep, controller.props));
    });
    await act(async () => {
      input(renderer!.root, `base-${roomTypeId}`).props.onChange({ target: { value: "170.00" } });
      button(renderer!.root, "Save draft").props.onClick();
    });
    await act(async () => {
      input(renderer!.root, `base-${roomTypeId}`).props.onChange({ target: { value: "180.00" } });
    });
    let leave!: Promise<void>;
    await act(async () => {
      leave = controller.beforeLeave!();
      await Promise.resolve();
    });
    await act(async () => {
      firstSave.resolve(draftReceipt());
      await leave;
    });

    expect(mocks.saveDraft).toHaveBeenCalledTimes(2);
    expect(mocks.saveDraft.mock.calls[0]?.[1]).toMatchObject({
      expectedSessionRevision: 7,
      expectedDraftRevision: 4,
      payload: { "rate.base_nightly_rate": { [roomTypeId]: "170.00" } },
    });
    expect(mocks.saveDraft.mock.calls[1]?.[1]).toMatchObject({
      expectedSessionRevision: 8,
      expectedDraftRevision: 5,
      payload: { "rate.base_nightly_rate": { [roomTypeId]: "180.00" } },
    });
    expect(input(renderer!.root, `base-${roomTypeId}`).props.value).toBe("180.00");
    expect(button(renderer!.root, "Save draft").props.disabled).toBe(true);
    renderer?.unmount();
  });

  it("reports and rejects a stale before-leave save while retaining local input", async () => {
    const stale = new PricingOwnerError(
      "This pricing draft changed in another session.",
      "draft_revision_conflict",
      null,
      true,
    );
    mocks.saveDraft.mockRejectedValueOnce(stale);
    const route = pricingRoute(emptyPricingDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PricingStep, controller.props));
    });
    await act(async () => {
      input(renderer!.root, `base-${roomTypeId}`).props.onChange({ target: { value: "175.00" } });
    });

    await expect(act(async () => controller.beforeLeave?.())).rejects.toBe(stale);
    expect(controller.reportRevisionConflict).toHaveBeenCalledWith(stale.message);
    expect(input(renderer!.root, `base-${roomTypeId}`).props.value).toBe("175.00");
    expect(JSON.stringify(renderer!.toJSON())).toContain(stale.message);
    renderer?.unmount();
  });

  it("retains edits made during canonical save and does not navigate", async () => {
    const canonicalSave = deferred<PricingCanonicalWorkspace>();
    mocks.saveCanonical.mockReturnValueOnce(canonicalSave.promise);
    const route = pricingRoute(emptyPricingDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PricingStep, controller.props));
    });
    await act(async () => {
      input(renderer!.root, `base-${roomTypeId}`).props.onChange({ target: { value: "170.00" } });
      input(renderer!.root, "mandatory-charges-acknowledged").props.onChange({
        target: { checked: true },
      });
      button(renderer!.root, "Save and continue").props.onClick();
    });
    await vi.waitFor(() => expect(mocks.saveCanonical).toHaveBeenCalledOnce());

    await act(async () => {
      input(renderer!.root, `base-${roomTypeId}`).props.onChange({ target: { value: "180.00" } });
    });
    await act(async () => {
      canonicalSave.resolve(workspace());
      await canonicalSave.promise;
      await Promise.resolve();
    });

    expect(input(renderer!.root, `base-${roomTypeId}`).props.value).toBe("180.00");
    expect(button(renderer!.root, "Save draft").props.disabled).toBe(false);
    expect(controller.saveAndContinue).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("latest edits remain in the draft");
    renderer?.unmount();
  });

  it("focuses the first invalid field", async () => {
    const focused = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("document", {
      getElementById: vi.fn((id: string) =>
        id === "free-cancellation-days" ? { focus: focused } : null,
      ),
    });
    const route = pricingRoute(emptyPricingDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PricingStep, controller.props));
    });
    await act(async () => {
      input(renderer!.root, "free-cancellation-days").props.onChange({ target: { value: "" } });
      input(renderer!.root, "mandatory-charges-acknowledged").props.onChange({
        target: { checked: true },
      });
      button(renderer!.root, "Save and continue").props.onClick();
    });

    expect(document.getElementById).toHaveBeenCalledWith("free-cancellation-days");
    expect(focused).toHaveBeenCalledOnce();
    expect(mocks.saveCanonical).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it("retains locally saved input when a canonical conflict is reloaded", async () => {
    const conflict = new PricingOwnerError(
      "Pricing changed before confirmation.",
      "pricing_source_conflict",
      null,
      true,
    );
    mocks.saveCanonical.mockRejectedValueOnce(conflict);
    const secondRoomId = "66666666-6666-4666-8666-666666666666";
    const latestWorkspace = workspace();
    latestWorkspace.confirmationRevision = 7;
    latestWorkspace.rooms = [
      {
        ...latestWorkspace.rooms[0]!,
        roomFactsRevision: 4,
        facts: {
          ...latestWorkspace.rooms[0]!.facts,
          name: "Garden Suite updated",
          occupancy: { maxAdults: 1 },
        },
      },
      {
        ...latestWorkspace.rooms[0]!,
        roomTypeId: secondRoomId,
        roomFactsRevision: 1,
        facts: { ...latestWorkspace.rooms[0]!.facts, name: "Courtyard Room" },
      },
    ] as never;
    mocks.loadWorkspace.mockResolvedValueOnce(workspace()).mockResolvedValueOnce(latestWorkspace);
    const route = pricingRoute(emptyPricingDraft());
    const controller = controllerContext(route);
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(PricingStep, controller.props));
    });
    await act(async () => {
      input(renderer!.root, `base-${roomTypeId}`).props.onChange({ target: { value: "175.00" } });
      input(renderer!.root, "mandatory-charges-acknowledged").props.onChange({
        target: { checked: true },
      });
      button(renderer!.root, "Save and continue").props.onClick();
    });
    await vi.waitFor(() => expect(mocks.saveCanonical).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(JSON.stringify(renderer!.toJSON())).toContain("Pricing changed before confirmation."),
    );

    await act(async () => {
      button(renderer!.root, "Reload latest").props.onClick();
    });
    await vi.waitFor(() => expect(mocks.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(input(renderer!.root, `base-${roomTypeId}`).props.value).toBe("175.00");
    expect(input(renderer!.root, `base-${secondRoomId}`)).toBeDefined();
    expect(input(renderer!.root, "mandatory-charges-acknowledged").props.checked).toBe(false);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Garden Suite updated");
    renderer?.unmount();
  });
});

const exactManifest = {
  "pms.pricing_settings": "pricing:2",
  "pms.rate_plans": "plans:4",
  "pms.rate_rules": "rules:0",
};

function controllerContext(route: PropertySetupRouteReadModel) {
  const dispose = vi.fn<() => void>();
  const refreshRoute = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const reportRevisionConflict = vi.fn<(message?: string) => void>();
  const saveAndContinue = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const controller: {
    beforeLeave?: () => Promise<void>;
    dispose: typeof dispose;
    refreshRoute: typeof refreshRoute;
    reportRevisionConflict: typeof reportRevisionConflict;
    saveAndContinue: typeof saveAndContinue;
    props: Parameters<typeof PricingStep>[0];
  } = {
    dispose,
    refreshRoute,
    reportRevisionConflict,
    saveAndContinue,
    props: null as never,
  };
  controller.props = {
    propertyId,
    route,
    step: route.steps[0]!,
    interfaceLocale: "en",
    saveAndContinue,
    refreshRoute,
    reportRevisionConflict,
    registerBeforeLeave(callback) {
      controller.beforeLeave = callback;
      return dispose;
    },
  };
  return controller;
}

function pricingRoute(draft: PropertySetupStepDraft | null): PropertySetupRouteReadModel {
  return {
    contractVersion: "property-setup-route.v1",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionId: "44444444-4444-4444-8444-444444444444",
    sessionRevision: 7,
    resumeStepId: "pricing",
    progress: { complete: 0, total: 1 },
    steps: [
      {
        stepId: "pricing",
        position: 5,
        state: draft ? "draft" : "not_started",
        sourceRevision: null,
        draft,
        blockers: [],
      },
    ],
  };
}

function emptyPricingDraft(): Extract<PropertySetupStepDraft, { stepId: "pricing" }> {
  return {
    stepId: "pricing",
    payload: {},
    dirtyFields: [],
    baseRevisions: exactManifest,
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: "2026-11-02T12:00:00.000Z",
    revision: 4,
    updatedAt: "2026-08-04T12:00:00.000Z",
  };
}

function workspace(withCurrency = true): PricingCanonicalWorkspace {
  return {
    rooms: [
      {
        roomTypeId,
        roomFactsRevision: 3,
        lifecycle: "active",
        facts: { name: "Garden Suite", occupancy: { maxAdults: 2 } },
      },
    ] as never,
    pricing: withCurrency
      ? ({
          pricingCurrency: { currency: "EUR", pricingCurrencyRevision: 2 },
          flexibleRatePlans: [
            {
              roomTypeId,
              flexibleRatePlanId: "55555555-5555-4555-8555-555555555555",
              flexibleRatePlanRevision: 4,
              baseAmount: { amountDecimal: "160.00" },
              cancellationTerms: { freeCancellationDeadlineDays: 7 },
            },
          ],
        } as never)
      : null,
    recurringPricing: withCurrency ? ({ sources: [] } as never) : null,
    confirmation: null,
    confirmationRevision: 0,
  };
}

function draftReceipt(
  overrides: Partial<SavePropertySetupDraftReceipt> = {},
): SavePropertySetupDraftReceipt {
  return {
    contractVersion: "property-setup-draft.v1",
    sessionId: "44444444-4444-4444-8444-444444444444",
    stepId: "pricing",
    selectedTracks: ["hotel_operations"],
    trackRevision: 3,
    sessionRevision: 8,
    draftRevision: 5,
    retentionExpiresAt: "2026-11-02T12:00:00.000Z",
    updatedAt: "2026-08-04T12:05:00.000Z",
    replayed: false,
    ...overrides,
  };
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find(
    (node) => node.type === "button" && node.children.some((child) => child === label),
  );
}

function input(root: ReactTestInstance, id: string): ReactTestInstance {
  return root.find((node) => node.type === "input" && node.props.id === id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
