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
  saveDesign: vi.fn(),
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
  bookingDesignClient: { load: mocks.loadDesign, save: mocks.saveDesign },
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
    mocks.saveDesign.mockResolvedValue(designRead());
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
    expect(mocks.savePresentation).not.toHaveBeenCalled();
    expect(props.refreshRoute).not.toHaveBeenCalled();
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
    await act(async () => instagram.props.onChange());
    await act(async () => registration.callback!());

    expect(mocks.saveDraft).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        stepId: "marketplace_preferences",
        payload: expect.objectContaining({
          "marketplace.preferences.content_platforms": ["instagram"],
        }),
      }),
    );
    expect(mocks.savePreferences).not.toHaveBeenCalled();
    expect(props.refreshRoute).toHaveBeenCalledOnce();
    renderer?.unmount();
  });

  it("treats valid Step 3 defaults as an explicit answer, persists them, and saves private design", async () => {
    mocks.saveDraft.mockResolvedValue(receipt("booking_design"));
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
    expect(props.saveAndContinue).toHaveBeenCalledOnce();
    renderer?.unmount();
  });
});

function captureRegistration() {
  const state: { callback?: () => Promise<void> } = {};
  return {
    get callback() {
      return state.callback;
    },
    register: vi.fn((callback: () => Promise<void>) => {
      state.callback = callback;
      return () => {
        if (state.callback === callback) state.callback = undefined;
      };
    }),
  };
}

function stepProps(
  stepId: "present_hotel" | "marketplace_preferences" | "booking_design",
  draft: PropertySetupStepDraft,
  registerBeforeLeave: AdaptiveSetupStepComponentProps["registerBeforeLeave"],
): AdaptiveSetupStepComponentProps {
  const route = setupRoute(stepId, draft);
  return {
    propertyId,
    route,
    step: route.steps[0]!,
    interfaceLocale: "en",
    registerBeforeLeave,
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
    contractVersion: "property-setup-route.v1",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    trackRevision: 2,
    sessionId,
    sessionRevision: 5,
    resumeStepId: stepId,
    progress: { complete: 0, total: 1 },
    steps: [{ stepId, position: 1, state: "draft", sourceRevision: null, draft, blockers: [] }],
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
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
