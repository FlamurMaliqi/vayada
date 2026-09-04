import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PropertySetupRouteReadModel, PropertySetupStepDraft } from "@vayada/domain-hotels";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdaptiveSetupStepComponentProps } from "./AdaptiveSetupStepFormDispatcher";

const mocks = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  loadPresentation: vi.fn(),
  savePresentation: vi.fn(),
  uploadPresentation: vi.fn(),
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
  loadDesign: vi.fn(),
  loadDesignReadiness: vi.fn(),
  saveDesign: vi.fn(),
  resetDraft: vi.fn(),
  ResetError: class ResetError extends Error {
    constructor(
      message: string,
      readonly requiresRefresh: boolean,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/services/api/adaptiveSetupDraftClient", () => ({
  adaptiveSetupDraftClient: { save: mocks.saveDraft },
}));
vi.mock("@/services/api/hotelPresentationClient", () => ({
  hotelPresentationClient: {
    load: mocks.loadPresentation,
    save: mocks.savePresentation,
    upload: mocks.uploadPresentation,
  },
}));
vi.mock("@/services/api/marketplacePreferencesClient", () => ({
  marketplacePreferencesClient: { load: mocks.loadPreferences, save: mocks.savePreferences },
}));
vi.mock("@/services/api/bookingDesignClient", () => ({
  bookingDesignClient: {
    load: mocks.loadDesign,
    loadReadiness: mocks.loadDesignReadiness,
    save: mocks.saveDesign,
  },
}));
vi.mock("@/services/api/propertySetupDraftResetClient", () => ({
  PropertySetupDraftResetError: mocks.ResetError,
  propertySetupDraftResetApi: { reset: mocks.resetDraft },
}));

import { BookingDesignStep } from "./booking/BookingDesignStep";
import { MarketplacePreferencesStep } from "./marketplace/MarketplacePreferencesStep";
import { PresentHotelStep } from "./presentation/PresentHotelStep";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-04T12:00:00.000Z";

describe("adaptive presentation and design steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveDraft.mockResolvedValue(receipt("present_hotel"));
    mocks.loadPresentation.mockResolvedValue(presentationRead());
    mocks.loadPreferences.mockResolvedValue(preferencesRead());
    mocks.loadDesign.mockResolvedValue(null);
    mocks.loadDesignReadiness.mockResolvedValue(designBlocked());
    mocks.saveDesign.mockResolvedValue(designRead());
    mocks.resetDraft.mockResolvedValue({
      contractVersion: "property-setup-draft-reset.v1",
      operation: "reset_step_draft",
      sessionId,
      stepId: "present_hotel",
      trackRevision: 2,
      sessionRevision: 6,
      discardedDraftRevision: 2,
      resetAt: now,
      nextRead: {
        method: "GET",
        href: `/api/hotel-setup/properties/${propertyId}/route`,
      },
    });
  });

  it("resumes Step 1 from its historical draft and preserves edited input on a failed Back save", async () => {
    const draft = presentationDraft();
    const registration = captureRegistration();
    const props = stepProps("present_hotel", draft, registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();

    const textarea = renderer!.root.findByType("textarea");
    expect(textarea.props.value).toBe(
      "A locally resumed description that has not been saved canonically yet.",
    );
    await act(async () => {
      textarea.props.onChange({
        target: { value: "A network-safe local edit that must remain visible after save failure." },
      });
    });
    mocks.saveDraft.mockRejectedValueOnce(new Error("Network unavailable"));

    await expect(act(async () => registration.callback!())).rejects.toThrow("Network unavailable");
    expect(renderer!.root.findByType("textarea").props.value).toContain("network-safe local edit");
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({ dirtyFields: ["profile.short_description"] }),
    );
    expect(mocks.savePresentation).not.toHaveBeenCalled();
    expect(props.refreshRoute).not.toHaveBeenCalled();
    renderer?.unmount();
  });

  it("persists an edit made while the Back draft save is still in flight", async () => {
    let finishFirstSave: ((value: unknown) => void) | undefined;
    mocks.saveDraft
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockResolvedValue(receipt("present_hotel"));
    const registration = captureRegistration();
    const props = stepProps("present_hotel", presentationDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    const textarea = renderer!.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({ target: { value: "First edit captured by the pending save." } });
    });

    let leavePromise!: Promise<void>;
    act(() => {
      leavePromise = registration.callback!();
    });
    await flush();
    await act(async () => {
      textarea.props.onChange({
        target: { value: "Newer edit that must be saved before navigation completes." },
      });
    });
    finishFirstSave?.(receipt("present_hotel"));
    await act(async () => leavePromise);

    expect(mocks.saveDraft).toHaveBeenCalledTimes(2);
    expect(mocks.saveDraft).toHaveBeenLastCalledWith(
      propertyId,
      expect.objectContaining({
        payload: expect.objectContaining({
          "profile.short_description": "Newer edit that must be saved before navigation completes.",
        }),
      }),
    );
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("applies the latest edit canonically when it changes during the submit draft save", async () => {
    let finishFirstSave: ((value: unknown) => void) | undefined;
    mocks.saveDraft
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockResolvedValue(receipt("present_hotel"));
    const registration = captureRegistration();
    const props = stepProps("present_hotel", presentationDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    const textarea = renderer!.root.findByType("textarea");
    await act(async () => {
      textarea.props.onChange({
        target: { value: "A valid first value that starts the draft save before canonical apply." },
      });
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    await flush();
    await act(async () => {
      textarea.props.onChange({
        target: {
          value: "A newer valid value that must be the one applied to the Hotel Catalog owner.",
        },
      });
    });
    finishFirstSave?.(receipt("present_hotel"));
    await flush();
    await flush();
    await flush();

    expect(mocks.saveDraft).toHaveBeenCalledTimes(2);
    expect(mocks.savePresentation).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        shortDescription:
          "A newer valid value that must be the one applied to the Hotel Catalog owner.",
      }),
    );
    expect(props.saveAndContinue).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("resets only the stale Step 1 draft and retains mounted local input", async () => {
    const beforeLeave = captureRegistration();
    const staleRecovery = captureRegistration();
    const props = stepProps(
      "present_hotel",
      presentationDraft(),
      beforeLeave.register,
      staleRecovery.register,
    );
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();

    await act(async () => staleRecovery.callback!());
    await flush();

    expect(mocks.resetDraft).toHaveBeenCalledWith(propertyId, {
      sessionId,
      stepId: "present_hotel",
      expectedTrackRevision: 2,
      expectedSessionRevision: 5,
      expectedDraftRevision: 2,
      expectedBaseRevisions: presentationDraft().baseRevisions,
    });
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType("textarea").props.value).toBe(
      "A locally resumed description that has not been saved canonically yet.",
    );
    await act(async () => beforeLeave.callback!());
    expect(mocks.saveDraft).toHaveBeenCalled();
    renderer?.unmount();
  });

  it("merges fresh Step 1 owner fields with only the locally dirty values after reset", async () => {
    const fresh = presentationRead();
    mocks.loadPresentation.mockResolvedValueOnce(presentationRead()).mockResolvedValueOnce({
      ...fresh,
      profile: {
        ...fresh.profile,
        locale: "de",
        amenities: { reviewed: true, keys: ["wifi"] },
      },
    });
    const beforeLeave = captureRegistration();
    const staleRecovery = captureRegistration();
    const props = stepProps(
      "present_hotel",
      presentationDraft(),
      beforeLeave.register,
      staleRecovery.register,
    );
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    await act(async () => staleRecovery.callback!());
    await flush();

    expect(renderer!.root.findByType("textarea").props.value).toContain("locally resumed");
    expect(renderer!.root.findByType("select").props.value).toBe("de");
    await act(async () => renderer!.root.findByProps({ "aria-expanded": false }).props.onClick());
    expect(
      renderer!.root
        .findAllByType("input")
        .find((input) => input.props.type === "checkbox" && input.props.checked)?.props.checked,
    ).toBe(true);
    renderer?.unmount();
  });

  it("merges fresh Step 2 availability with only the locally dirty compensation after reset", async () => {
    const fresh = preferencesRead();
    mocks.saveDraft.mockResolvedValue(receipt("marketplace_preferences"));
    mocks.loadPreferences.mockResolvedValueOnce(preferencesRead()).mockResolvedValueOnce({
      ...fresh,
      revision: 1,
      sourceRevision: "preferences:1",
      preferences: {
        compensationTypes: ["paid"],
        contentPlatforms: ["instagram"],
        contentTypes: ["post"],
        availability: { mode: "selected_months", selectedMonths: [7] },
      },
    });
    const beforeLeave = captureRegistration();
    const staleRecovery = captureRegistration();
    const props = stepProps(
      "marketplace_preferences",
      preferencesDraft(),
      beforeLeave.register,
      staleRecovery.register,
    );
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(MarketplacePreferencesStep, props));
    });
    await flush();
    await act(async () => staleRecovery.callback!());
    await flush();

    const compensation = renderer!.root
      .findAllByType("input")
      .filter((input) => input.props.type === "checkbox")
      .slice(0, 4);
    expect(compensation[0]!.props.checked).toBe(true);
    expect(compensation[1]!.props.checked).toBe(false);
    expect(renderer!.root.findByProps({ value: "selected_months" }).props.checked).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "July" }).props.checked).toBe(true);
    renderer?.unmount();
  });

  it("merges fresh Step 3 font choice with only the locally dirty color after reset", async () => {
    const draft = baseDraft({
      stepId: "booking_design",
      payload: { "booking.primary_color": "#7B2D8E" },
      dirtyFields: ["booking.primary_color"],
      baseRevisions: {
        "booking.design": "design:1",
        "hotel_catalog.profile": "profile:7",
        "hotel_catalog.media": "profile:7",
      },
    });
    mocks.loadDesign.mockResolvedValueOnce(designRead()).mockResolvedValueOnce({
      ...designRead(),
      revision: 2,
      choices: { primaryColor: "#0077B6", fontPairing: "italiana-serif" },
    });
    const beforeLeave = captureRegistration();
    const staleRecovery = captureRegistration();
    const props = stepProps("booking_design", draft, beforeLeave.register, staleRecovery.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(BookingDesignStep, props));
    });
    await flush();
    await act(async () => staleRecovery.callback!());
    await flush();

    expect(renderer!.root.findByProps({ "aria-label": "Royal purple" }).props.checked).toBe(true);
    expect(renderer!.root.findByProps({ value: "italiana-serif" }).props.checked).toBe(true);
    renderer?.unmount();
  });

  it("refreshes a first-visit conflict without inventing a draft reset", async () => {
    const beforeLeave = captureRegistration();
    const staleRecovery = captureRegistration();
    const draftProps = stepProps(
      "present_hotel",
      presentationDraft(),
      beforeLeave.register,
      staleRecovery.register,
    );
    const route = {
      ...draftProps.route,
      sessionId: null,
      sessionRevision: null,
      steps: [{ ...draftProps.step, state: "not_started" as const, draft: null }],
    };
    const props = { ...draftProps, route, step: route.steps[0]! };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    await act(async () => {
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: "First-visit local text stays mounted through refresh." },
      });
      await staleRecovery.callback!();
    });
    await flush();

    expect(staleRecovery.mode).toBe("refresh");
    expect(mocks.resetDraft).not.toHaveBeenCalled();
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType("textarea").props.value).toBe(
      "First-visit local text stays mounted through refresh.",
    );
    renderer?.unmount();
  });

  it("refreshes reset CAS metadata before retrying with the new historical manifest", async () => {
    mocks.resetDraft.mockRejectedValueOnce(new mocks.ResetError("Draft changed again.", true));
    const beforeLeave = captureRegistration();
    const staleRecovery = captureRegistration();
    const props = stepProps(
      "present_hotel",
      presentationDraft(),
      beforeLeave.register,
      staleRecovery.register,
    );
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    await expect(act(async () => staleRecovery.callback!())).rejects.toThrow(
      "Draft changed again.",
    );
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    expect(props.reportRevisionConflict).toHaveBeenCalledWith("Draft changed again.");

    const nextDraft = {
      ...presentationDraft(),
      revision: 4,
      baseRevisions: {
        "hotel_catalog.profile": "profile:8",
        "hotel_catalog.media": "profile:8",
        "hotel_catalog.amenities": "profile:8",
      },
    } as PropertySetupStepDraft;
    const nextRoute = setupRoute("present_hotel", nextDraft);
    nextRoute.sessionRevision = 6;
    const nextProps = { ...props, route: nextRoute, step: nextRoute.steps[0]! };
    await act(async () => {
      renderer!.update(createElement(PresentHotelStep, nextProps));
    });
    await act(async () => staleRecovery.callback!());

    expect(mocks.resetDraft).toHaveBeenLastCalledWith(
      propertyId,
      expect.objectContaining({
        expectedSessionRevision: 6,
        expectedDraftRevision: 4,
        expectedBaseRevisions: nextDraft.baseRevisions,
      }),
    );
    renderer?.unmount();
  });

  it("keeps the first selected Step 1 photo as cover when parallel uploads finish out of order", async () => {
    const registration = captureRegistration();
    const props = stepProps("present_hotel", presentationDraft(), registration.register);
    const uploads = new Map<string, (value: unknown) => void>();
    mocks.uploadPresentation.mockImplementation(
      (_propertyId: string, files: File[]) =>
        new Promise((resolve) => uploads.set(files[0]!.name, resolve)),
    );
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    const input = renderer!.root
      .findAllByType("input")
      .find((candidate) => candidate.props.type === "file")!;
    const first = new File([new Uint8Array([1])], "first.jpg", { type: "image/jpeg" });
    const second = new File([new Uint8Array([2])], "second.jpg", { type: "image/jpeg" });
    await act(async () => {
      input.props.onChange({ target: { files: [first, second], value: "selected" } });
    });
    await flush();
    uploads.get("second.jpg")?.([{ mediaObjectId: "55555555-5555-4555-8555-555555555552" }]);
    await flush();
    uploads.get("first.jpg")?.([{ mediaObjectId: "55555555-5555-4555-8555-555555555551" }]);
    await flush();

    expect(mocks.saveDraft).toHaveBeenLastCalledWith(
      propertyId,
      expect.objectContaining({
        payload: expect.objectContaining({
          "profile.hero_image": "55555555-5555-4555-8555-555555555551",
          "profile.gallery_images": ["55555555-5555-4555-8555-555555555552"],
        }),
      }),
    );
    renderer?.unmount();
  });

  it("rejects photos beyond the Catalog cover-plus-gallery limit before upload", async () => {
    const registration = captureRegistration();
    const props = stepProps("present_hotel", presentationDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();

    const input = renderer!.root
      .findAllByType("input")
      .find((candidate) => candidate.props.type === "file")!;
    await act(async () => {
      input.props.onChange({
        target: {
          files: Array.from(
            { length: 27 },
            (_, index) =>
              new File([new Uint8Array([index])], `hotel-${index + 1}.jpg`, {
                type: "image/jpeg",
              }),
          ),
          value: "selected",
        },
      });
    });

    expect(mocks.uploadPresentation).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toMatch(
      /up to 26 photos/i,
    );
    renderer?.unmount();
  });

  it("blocks Back or Exit while a Step 1 photo upload is active", async () => {
    let finishUpload: ((value: unknown) => void) | undefined;
    mocks.uploadPresentation.mockReturnValue(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    const registration = captureRegistration();
    const props = stepProps("present_hotel", presentationDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    const input = renderer!.root
      .findAllByType("input")
      .find((candidate) => candidate.props.type === "file")!;
    await act(async () => {
      input.props.onChange({
        target: {
          files: [new File([new Uint8Array([1])], "pending.jpg", { type: "image/jpeg" })],
          value: "selected",
        },
      });
    });
    await flush();

    await expect(act(async () => registration.callback!())).rejects.toThrow(
      /wait for active photo uploads/i,
    );
    expect(props.refreshRoute).not.toHaveBeenCalled();

    finishUpload?.([{ mediaObjectId: "55555555-5555-4555-8555-555555555551" }]);
    await flush();
    await flush();
    await act(async () => registration.callback!());
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("blocks Back or Exit while a failed Step 1 photo retry is active", async () => {
    let finishRetry: ((value: unknown) => void) | undefined;
    mocks.uploadPresentation.mockRejectedValueOnce(new Error("Upload failed")).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRetry = resolve;
      }),
    );
    const registration = captureRegistration();
    const props = stepProps("present_hotel", presentationDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();
    const input = renderer!.root
      .findAllByType("input")
      .find((candidate) => candidate.props.type === "file")!;
    await act(async () => {
      input.props.onChange({
        target: {
          files: [new File([new Uint8Array([1])], "retry.jpg", { type: "image/jpeg" })],
          value: "selected",
        },
      });
    });
    await flush();
    await flush();

    const retry = renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Retry"))!;
    await act(async () => retry.props.onClick());
    await flush();

    await expect(act(async () => registration.callback!())).rejects.toThrow(
      /wait for active photo uploads/i,
    );
    expect(props.refreshRoute).not.toHaveBeenCalled();

    finishRetry?.([{ mediaObjectId: "55555555-5555-4555-8555-555555555551" }]);
    await flush();
    await flush();
    await act(async () => registration.callback!());
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("uses the Catalog code-point limit for Step 1 Unicode summaries", async () => {
    const registration = captureRegistration();
    const props = stepProps("present_hotel", presentationDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(PresentHotelStep, props));
    });
    await flush();

    const textarea = renderer!.root.findByType("textarea");
    expect(textarea.props.maxLength).toBeUndefined();
    await act(async () => {
      textarea.props.onChange({ target: { value: "🏨".repeat(501) } });
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    await flush();
    expect(mocks.savePresentation).not.toHaveBeenCalled();
    expect(
      renderer!.root.findByProps({ id: "presentation-summary-error" }).children.join(""),
    ).toMatch(/within 500 characters/i);

    await act(async () => {
      textarea.props.onChange({ target: { value: "🏨".repeat(500) } });
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    await flush();
    expect(mocks.savePresentation).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({ shortDescription: "🏨".repeat(500) }),
    );
    expect(props.saveAndContinue).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("saves an incomplete Step 2 selection only as a resumable draft on Exit", async () => {
    mocks.saveDraft.mockResolvedValue(receipt("marketplace_preferences"));
    const registration = captureRegistration();
    const props = stepProps("marketplace_preferences", preferencesDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(MarketplacePreferencesStep, props));
    });
    await flush();
    const instagram = renderer!.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "Instagram")!;
    const yearRound = renderer!.root
      .findAllByType("input")
      .find((input) => input.props.value === "year_round")!;
    await act(async () => instagram.props.onChange());
    await act(async () => yearRound.props.onChange());
    await act(async () => registration.callback!());

    expect(mocks.saveDraft).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        stepId: "marketplace_preferences",
        dirtyFields: [
          "marketplace.preferences.compensation_types",
          "marketplace.preferences.content_platforms",
          "marketplace.preferences.availability",
        ],
        payload: expect.objectContaining({
          "marketplace.preferences.content_platforms": ["instagram"],
          "marketplace.preferences.availability": { mode: "year_round", months: [] },
        }),
      }),
    );
    expect(mocks.savePreferences).not.toHaveBeenCalled();
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("treats valid Step 3 defaults as an explicit answer, persists them, and saves private design", async () => {
    mocks.saveDraft.mockResolvedValue(receipt("booking_design"));
    mocks.loadDesignReadiness
      .mockResolvedValueOnce(designBlocked())
      .mockResolvedValueOnce(designReadiness());
    const registration = captureRegistration();
    const props = stepProps("booking_design", bookingDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(BookingDesignStep, props));
    });
    await flush();
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
    });
    await flush();

    expect(mocks.saveDraft).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        stepId: "booking_design",
        payload: {
          "booking.primary_color": "#4F46E5",
          "booking.font_pairing": "high-end-serif",
        },
      }),
    );
    expect(mocks.saveDesign).toHaveBeenCalledWith(propertyId, {
      expectedRevision: 0,
      choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
    });
    expect(mocks.loadDesignReadiness).toHaveBeenLastCalledWith(
      { organizationId, propertyId },
      { cache: "no-store" },
    );
    expect(props.saveAndContinue).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("flags a stale Step 3 Catalog manifest while retaining the draft choices", async () => {
    mocks.loadDesign.mockResolvedValue(designRead());
    mocks.loadDesignReadiness.mockResolvedValue(designReadiness({ profileRevision: "profile:8" }));
    const registration = captureRegistration();
    const props = stepProps("booking_design", bookingDraft(), registration.register);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(BookingDesignStep, props));
    });
    await flush();

    expect(props.reportRevisionConflict).toHaveBeenCalledWith(
      expect.stringMatching(/older hotel content/i),
    );
    expect(renderer!.root.findByProps({ "aria-label": "vayada indigo" }).props.checked).toBe(true);
    expect(mocks.saveDesign).not.toHaveBeenCalled();
    renderer?.unmount();
  });
});

function captureRegistration() {
  const state: { callback?: () => Promise<void>; mode?: "refresh" | "reset" } = {};
  return {
    get callback() {
      return state.callback;
    },
    get mode() {
      return state.mode;
    },
    register: vi.fn((callback: () => Promise<void>, mode?: "refresh" | "reset") => {
      state.callback = callback;
      state.mode = mode;
      return () => {
        if (state.callback === callback) {
          state.callback = undefined;
          state.mode = undefined;
        }
      };
    }),
  };
}

function stepProps(
  stepId: "present_hotel" | "marketplace_preferences" | "booking_design",
  draft: PropertySetupStepDraft,
  registerBeforeLeave: AdaptiveSetupStepComponentProps["registerBeforeLeave"],
  registerStaleRecovery?: AdaptiveSetupStepComponentProps["registerStaleRecovery"],
): AdaptiveSetupStepComponentProps {
  const route = setupRoute(stepId, draft);
  return {
    propertyId,
    route,
    step: route.steps[0]!,
    interfaceLocale: "en",
    registerBeforeLeave,
    registerStaleRecovery,
    refreshRoute: vi.fn().mockResolvedValue(undefined),
    saveAndContinue: vi.fn().mockResolvedValue(undefined),
    reportRevisionConflict: vi.fn(),
  };
}

function setupRoute(
  stepId: PropertySetupStepDraft["stepId"],
  draft: PropertySetupStepDraft,
): PropertySetupRouteReadModel {
  return {
    contractVersion: "property-setup-route.v2",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    trackRevision: 2,
    sessionId,
    sessionRevision: 5,
    resumeStepId: stepId,
    progress: { complete: 0, total: 1 },
    steps: [
      {
        stepId,
        position: 1,
        state: "draft",
        sourceRevision:
          stepId === "present_hotel"
            ? "profile:7"
            : stepId === "marketplace_preferences"
              ? "preferences:0"
              : "design:0",
        currentBaseRevisions: draft.baseRevisions,
        draft,
        blockers: [],
      },
    ],
  };
}

function baseDraft<T extends PropertySetupStepDraft>(
  draft: Omit<T, "piiClassification" | "retentionExpiresAt" | "revision" | "updatedAt">,
): T {
  return {
    ...draft,
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: now,
    revision: 2,
    updatedAt: now,
  } as T;
}
function presentationDraft(): PropertySetupStepDraft {
  return baseDraft({
    stepId: "present_hotel",
    payload: {
      "profile.short_description":
        "A locally resumed description that has not been saved canonically yet.",
    },
    dirtyFields: ["profile.short_description"],
    baseRevisions: {
      "hotel_catalog.profile": "profile:7",
      "hotel_catalog.media": "profile:7",
      "hotel_catalog.amenities": "profile:7",
    },
  });
}
function preferencesDraft(): PropertySetupStepDraft {
  return baseDraft({
    stepId: "marketplace_preferences",
    payload: { "marketplace.preferences.compensation_types": ["free_stay"] },
    dirtyFields: ["marketplace.preferences.compensation_types"],
    baseRevisions: { "marketplace.collaboration_preferences": "preferences:0" },
  });
}
function bookingDraft(): PropertySetupStepDraft {
  return baseDraft({
    stepId: "booking_design",
    payload: {},
    dirtyFields: [],
    baseRevisions: {
      "booking.design": "design:0",
      "hotel_catalog.profile": "profile:7",
      "hotel_catalog.media": "profile:7",
    },
  });
}
function receipt(stepId: PropertySetupStepDraft["stepId"]) {
  return {
    contractVersion: "property-setup-draft.v1",
    sessionId,
    stepId,
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    trackRevision: 2,
    sessionRevision: 6,
    draftRevision: 3,
    retentionExpiresAt: now,
    updatedAt: now,
    replayed: false,
  };
}
function presentationRead() {
  return {
    contractVersion: "hotel-catalog-step1.v1",
    propertyId,
    displayName: "Canal House",
    profileRevision: 7,
    supportedLocales: ["de", "en"],
    profile: {
      locale: "en",
      shortDescription:
        "A canonical description that is long enough to be valid for the public profile.",
      publicSlug: "canal-house",
      amenities: { reviewed: true, keys: [] },
      media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
    },
    baseRevisions: {
      "hotel_catalog.profile": "profile:7",
      "hotel_catalog.media": "profile:7",
      "hotel_catalog.amenities": "profile:7",
    },
  };
}
function preferencesRead() {
  return {
    contractVersion: "marketplace-hotel-collaboration-preferences.v1",
    propertyId,
    revision: 0,
    sourceRevision: "preferences:0",
    preferences: null,
    readiness: {
      contractVersion: "marketplace-hotel-collaboration-preferences-evidence.v1",
      product: "marketplace",
      groupId: "marketplace.collaboration_preferences",
      owningStepId: "marketplace_preferences",
      source: {
        ownerDomain: "marketplace",
        entityType: "hotel_collaboration_preferences",
        entityId: propertyId,
        revision: "preferences:0",
      },
      status: "blocked",
      omissions: [],
    },
  };
}
function designRead() {
  return {
    contractVersion: "booking-design.v1",
    propertyId,
    revision: 1,
    choices: { primaryColor: "#4F46E5", fontPairing: "high-end-serif" },
    createdAt: now,
  };
}
function designBlocked() {
  return {
    outcome: "blocked",
    organizationId,
    propertyId,
    blocker: { code: "booking_design_missing", evidencePort: "design" },
  } as const;
}
function designReadiness({ profileRevision = "profile:7" } = {}) {
  const designSource = {
    ownerDomain: "booking",
    entityType: "design_revision",
    entityId: propertyId,
    revision: "design:1",
  } as const;
  return {
    outcome: "ready",
    organizationId,
    propertyId,
    designSource,
    snapshot: {
      contractVersion: "booking-design-renderer.v1",
      organizationId,
      propertyId,
      sourceBindings: [
        designSource,
        {
          ownerDomain: "hotel_catalog",
          entityType: "property_media_assignment",
          entityId: propertyId,
          revision: profileRevision,
        },
        {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: profileRevision,
        },
      ],
      appearance: {
        primaryColor: "#4F46E5",
        fontPairing: "high-end-serif",
        headingFontFamily: "'Playfair Display', serif",
        bodyFontFamily: "'Source Sans Pro', sans-serif",
        button: {
          backgroundColor: "#463FCA",
          hoverBackgroundColor: "#3932A5",
          foregroundColor: "#FFFFFF",
        },
      },
      profile: {
        displayName: "Canal House",
        contentLocale: "en",
        shortDescription:
          "A canonical description that is long enough for the private Booking preview.",
      },
      cover: { kind: "fallback", path: "/vayada-logo.png" },
    },
  } as const;
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
