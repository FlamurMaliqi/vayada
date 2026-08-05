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
    expect(renderer!.root.findByProps({ "aria-label": "Vayada indigo" }).props.checked).toBe(true);
    expect(mocks.saveDesign).not.toHaveBeenCalled();
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
